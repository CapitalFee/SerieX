// Package forms computes and stores payroll tax forms: Form 941, Form 940,
// W-2/W-3 (with the SSA EFW2 electronic file), state quarterly wage reports.
//
//	data.go     paychecks, adjustments, payments and company data the forms read
//	builder.go  form lines with user overrides; saved filings (form_filings)
//	f941.go     Form 941 (+ Part 2 monthly liabilities / Schedule B)
//	f940.go     Form 940 (+ Schedule A credit reduction, Part 5 quarters)
//	w2.go       W-2 per employee and W-3
//	efw2.go     SSA EFW2 W-2 file
//	stateui.go  state quarterly wage report and its CSV
//	filings.go  forms to file with due dates and statuses
package forms

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the tax form routes.
func Register(rt *httpx.Router) {
	rt.C("GET", "/forms/filings", filingsRoute)
	rt.C("GET", "/forms/941", get941)
	rt.C("PUT", "/forms/941", put941)
	rt.C("GET", "/forms/940", get940)
	rt.C("PUT", "/forms/940", put940)
	rt.C("GET", "/forms/w2", getW2)
	rt.C("PUT", "/forms/w2", putW2)
	rt.C("GET", "/forms/w2/efw2", efw2Route)
	rt.C("GET", "/forms/state-ui", getStateUI)
	rt.C("PUT", "/forms/state-ui", putStateUI)
	rt.C("GET", "/forms/state-ui/csv", stateUICSV)
}

// Form941 returns Form 941 of a quarter with the saved user values (also used
// by the Form 941 worksheet report).
func Form941(ctx context.Context, q store.Q, year, quarter int) (*model.TaxForm, error) {
	return form941(ctx, q, year, quarter, nil)
}

// Form940 returns Form 940 of a year with the saved user values.
func Form940(ctx context.Context, q store.Q, year int) (*model.TaxForm, error) {
	return form940(ctx, q, year, nil)
}

// W2s returns the W-2s (SSNs masked) and the W-3 of a year.
func W2s(ctx context.Context, q store.Q, year int) (*model.W2Result, error) {
	res, _, err := computeW2(ctx, q, year, false)
	return res, err
}

// StateWageReport returns the state quarterly wage report (SSNs masked).
func StateWageReport(ctx context.Context, q store.Q, year, quarter int, state string) (*model.TaxForm, error) {
	return formStateUI(ctx, q, year, quarter, state, false, nil)
}

// ---------------------------------------------------------------------------
// 941 / 940

func get941(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	quarter, err := parseQuarter(c)
	if err != nil {
		return err
	}
	if c.QBool("snapshot") {
		return snapshotRoute(c, "941", year, fmt.Sprintf("Q%d", quarter), "")
	}
	form, err := form941(c.Context(), c.DB, year, quarter, nil)
	if err != nil {
		return err
	}
	return c.JSON(form)
}

func put941(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	quarter, err := parseQuarter(c)
	if err != nil {
		return err
	}
	var req model.SaveFormRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	return saveTaxForm(c, "941", year, fmt.Sprintf("Q%d", quarter), "", &req, func(d *formData) (*model.TaxForm, error) {
		return form941(c.Context(), c.DB, year, quarter, d)
	})
}

func get940(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	if c.QBool("snapshot") {
		return snapshotRoute(c, "940", year, "Y", "")
	}
	form, err := form940(c.Context(), c.DB, year, nil)
	if err != nil {
		return err
	}
	return c.JSON(form)
}

func put940(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	var req model.SaveFormRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	return saveTaxForm(c, "940", year, "Y", "", &req, func(d *formData) (*model.TaxForm, error) {
		return form940(c.Context(), c.DB, year, d)
	})
}

// snapshotRoute returns the form as it was when it was marked as filed.
func snapshotRoute(c *httpx.Ctx, form string, year int, period, state string) error {
	f, err := loadFiling(c.Context(), c.DB, form, year, period, state)
	if err != nil {
		return err
	}
	if f == nil || f.status != "filed" || len(f.data.Snapshot) == 0 {
		return apperr.NotFound("This form has not been filed.")
	}
	c.W.Header().Set("Content-Type", "application/json; charset=utf-8")
	c.W.Header().Set("Cache-Control", "no-store")
	_, err = c.W.Write(f.data.Snapshot)
	return err
}

// saveTaxForm validates and stores the user's values of a 941, 940 or state
// report and its status; "filed" also stores the snapshot of the form.
func saveTaxForm(c *httpx.Ctx, formName string, year int, period, state string, req *model.SaveFormRequest,
	compute func(*formData) (*model.TaxForm, error)) error {
	prev, err := loadFiling(c.Context(), c.DB, formName, year, period, state)
	if err != nil {
		return err
	}
	// no status: the form keeps its status; a filed form saved again without
	// "filed" keeps the snapshot and the date of the return that was filed
	keepFiled := false
	if req.Status == "" {
		req.Status = "draft"
		if prev != nil {
			req.Status = prev.status
			keepFiled = prev.status == "filed"
		}
	}
	raw := emptyData()
	for k, v := range req.Overrides {
		raw.Overrides[k] = v
	}
	for k, v := range req.Texts {
		raw.Texts[k] = v
	}
	for k, v := range req.Checks {
		raw.Checks[k] = v
	}
	// the editable lines depend on the values (e.g. 941 line 16 months only
	// for monthly depositors): check the keys against the form built with them
	trial, err := compute(raw)
	if err != nil {
		return err
	}
	data, err := validateSave(trial, req)
	if err != nil {
		return err
	}
	final, err := compute(data)
	if err != nil {
		return err
	}
	filedAt := ""
	switch {
	case keepFiled:
		data.Snapshot, filedAt = prev.data.Snapshot, prev.filedAt
	case req.Status == "filed":
		final.Status = "filed"
		final.FiledAt = store.Now()
		final.Warnings = []string{}
		snap, err := json.Marshal(final)
		if err != nil {
			return err
		}
		data.Snapshot, filedAt = snap, final.FiledAt
	}
	err = c.Write(func(tx *sql.Tx) error {
		id, err := saveFiling(c.Context(), tx, c.User, formName, year, period, state, req.Status, filedAt, data)
		if err != nil {
			return err
		}
		action := "modify"
		if prev == nil {
			action = "add"
		}
		if req.Status == "filed" && !keepFiled {
			action = "file_form"
		}
		return store.Audit(c.Context(), tx, c.User, action, "form", id, fmt.Sprintf("%s saved as %s", final.Title, req.Status),
			map[string]any{"form": formName, "year": year, "period": period, "state": state, "status": req.Status,
				"overrides": data.Overrides, "texts": data.Texts, "checks": data.Checks})
	})
	if err != nil {
		return err
	}
	out, err := compute(nil)
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// W-2 / W-3

func getW2(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	reveal, err := revealAllowed(c, fmt.Sprintf("W-2/W-3 %d", year))
	if err != nil {
		return err
	}
	res, _, err := computeW2(c.Context(), c.DB, year, reveal)
	if err != nil {
		return err
	}
	return c.JSON(res)
}

// validTTOC: "000" (non-qualifying occupation) or a code of the Treasury
// Tipped Occupation Code list (Treasury list of tipped occupations:
// 101-110, 201-211, 301-304, 401-409, 501-510, 601-611, 701-706, 801-810).
func validTTOC(cd string) bool {
	if len(cd) != 3 || store.Digits(cd) != cd {
		return false
	}
	if cd == "000" {
		return true
	}
	last := map[byte]int{'1': 10, '2': 11, '3': 4, '4': 9, '5': 10, '6': 11, '7': 6, '8': 10}[cd[0]]
	n, _ := strconv.Atoi(cd[1:])
	return n >= 1 && n <= last
}

// w2SaveRequest: PUT /forms/w2 body. OccupationCodes (optional, nil keeps the
// saved codes) are the box 14b Treasury Tipped Occupation Codes per employee
// id (up to two 3-digit codes; "000" for a non-qualifying occupation).
type w2SaveRequest struct {
	Reviewed        []int64             `json:"reviewed"`
	Status          string              `json:"status"`
	OccupationCodes map[string][]string `json:"occupationCodes"`
}

func putW2(c *httpx.Ctx) error {
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	var req w2SaveRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	ctx := c.Context()
	res, prev, err := computeW2(ctx, c.DB, year, false)
	if err != nil {
		return err
	}
	// no status: the W-2s keep their status (and the snapshot of the filed ones)
	keepFiled := false
	if req.Status == "" {
		req.Status = "draft"
		if prev != nil {
			req.Status = prev.status
			keepFiled = prev.status == "filed"
		}
	}
	if req.Status != "draft" && req.Status != "filed" {
		return apperr.Validation("status", "The status must be draft or filed.")
	}
	onForm := map[int64]bool{}
	for _, w := range res.Employees {
		onForm[w.EmployeeID] = true
	}
	data := emptyData()
	seen := map[int64]bool{}
	for _, id := range req.Reviewed {
		if !onForm[id] {
			return apperr.Validation("reviewed", "Employee %d has no W-2 for %d.", id, year)
		}
		if !seen[id] {
			data.Reviewed = append(data.Reviewed, id)
			seen[id] = true
		}
	}
	if req.OccupationCodes == nil {
		if prev != nil {
			data.OccupationCodes = prev.data.OccupationCodes
		}
	} else {
		data.OccupationCodes = map[string][]string{}
		for k, codes := range req.OccupationCodes {
			id, err := strconv.ParseInt(k, 10, 64)
			if err != nil || !onForm[id] {
				return apperr.Validation("occupationCodes", "Employee %s has no W-2 for %d.", k, year)
			}
			if len(codes) > 2 {
				return apperr.Validation("occupationCodes", "Box 14b holds at most two occupation codes.")
			}
			var clean []string
			for _, cd := range codes {
				cd = strings.TrimSpace(cd)
				if cd == "" {
					continue
				}
				if !validTTOC(cd) {
					return apperr.Validation("occupationCodes", "%s is not a Treasury Tipped Occupation Code (101 to 810 from the Treasury list, for example 102 Wait staff; 000 for a non-qualifying occupation).", cd)
				}
				if len(clean) == 1 && clean[0] == cd {
					return apperr.Validation("occupationCodes", "Enter two different occupation codes in box 14b.")
				}
				clean = append(clean, cd)
			}
			if len(clean) > 0 {
				data.OccupationCodes[k] = clean
			}
		}
	}
	filedAt := ""
	switch {
	case keepFiled:
		data.Snapshot, filedAt = prev.data.Snapshot, prev.filedAt
	case req.Status == "filed":
		// snapshot with the saved review marks and codes (SSNs masked)
		tmp := *res
		tmp.Status, tmp.FiledAt = "filed", store.Now()
		filedAt = tmp.FiledAt
		reviewed := map[int64]bool{}
		for _, id := range data.Reviewed {
			reviewed[id] = true
		}
		tmp.Employees = append([]model.W2(nil), res.Employees...)
		for i := range tmp.Employees {
			w := &tmp.Employees[i]
			w.Reviewed = reviewed[w.EmployeeID]
			w.Box14b = append([]string{}, data.OccupationCodes[strconv.FormatInt(w.EmployeeID, 10)]...)
		}
		snap, err := json.Marshal(struct {
			*model.W2Result
			OccupationCodes map[string][]string `json:"occupationCodes"`
		}{&tmp, data.OccupationCodes})
		if err != nil {
			return err
		}
		data.Snapshot = snap
	}
	err = c.Write(func(tx *sql.Tx) error {
		id, err := saveFiling(ctx, tx, c.User, "W-2", year, "Y", "", req.Status, filedAt, data)
		if err != nil {
			return err
		}
		action := "modify"
		if prev == nil {
			action = "add"
		}
		if req.Status == "filed" && !keepFiled {
			action = "file_form"
		}
		return store.Audit(ctx, tx, c.User, action, "form", id, fmt.Sprintf("Forms W-2/W-3 %d saved as %s (%d employees, %d reviewed)", year, req.Status, len(res.Employees), len(data.Reviewed)),
			map[string]any{"form": "W-2", "year": year, "status": req.Status, "reviewed": data.Reviewed, "occupationCodes": data.OccupationCodes})
	})
	if err != nil {
		return err
	}
	out, _, err := computeW2(ctx, c.DB, year, false)
	if err != nil {
		return err
	}
	return c.JSON(out)
}
