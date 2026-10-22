package employees

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

var errBadPTOKind = errors.New("paid time off kind must be sick or vacation")

// parsePTO reads a stored PTOSettings JSON (defaults filled in).
func parsePTO(raw string) model.PTOSettings {
	var s model.PTOSettings
	if raw != "" {
		json.Unmarshal([]byte(raw), &s)
	}
	normalizePTO(&s)
	return s
}

func normalizePTO(s *model.PTOSettings) {
	s.Accrual = strings.TrimSpace(s.Accrual)
	if s.Accrual == "" {
		s.Accrual = model.AccrueNone
	}
	if s.YearBeginsMonth < 1 || s.YearBeginsMonth > 12 {
		s.YearBeginsMonth = 1
	}
	if s.MaxHours != nil && *s.MaxHours <= 0 {
		s.MaxHours = nil
	}
	s.BeginAccruingDate = strings.TrimSpace(s.BeginAccruingDate)
}

// ptoJSON is the stored form of the settings (computed fields left out).
func ptoJSON(s model.PTOSettings) string {
	s.Available, s.AccruedYTD, s.UsedYTD = 0, 0, 0
	return store.JSONText(struct {
		Accrual           string   `json:"accrual"`
		Hours             float64  `json:"hours"`
		PerHoursWorked    float64  `json:"perHoursWorked"`
		MaxHours          *float64 `json:"maxHours"`
		ResetEachYear     bool     `json:"resetEachYear"`
		YearBeginsMonth   int      `json:"yearBeginsMonth"`
		BeginAccruingDate string   `json:"beginAccruingDate"`
	}{s.Accrual, s.Hours, s.PerHoursWorked, s.MaxHours, s.ResetEachYear, s.YearBeginsMonth, s.BeginAccruingDate})
}

func validatePTO(field string, s *model.PTOSettings) error {
	normalizePTO(s)
	switch s.Accrual {
	case model.AccrueNone, model.AccruePerPaycheck, model.AccruePerHour, model.AccrueBeginningOfYear:
	default:
		return apperr.Validation(field+".accrual", "The accrual period must be none, every paycheck, every hour on paycheck or beginning of year.")
	}
	if s.Hours < 0 || s.Hours > 10000 {
		return apperr.Validation(field+".hours", "The hours accrued must be between 0 and 10,000.")
	}
	if s.Accrual == model.AccruePerHour {
		if s.PerHoursWorked <= 0 {
			return apperr.Validation(field+".perHoursWorked", "Enter the hours worked for each accrual (for example 1 hour for every 30 hours worked).")
		}
	} else {
		s.PerHoursWorked = 0
	}
	if s.Accrual != model.AccrueNone && s.Hours == 0 {
		return apperr.Validation(field+".hours", "Enter the hours accrued.")
	}
	if s.BeginAccruingDate != "" && !store.ValidDate(s.BeginAccruingDate) {
		return apperr.Validation(field+".beginAccruingDate", "The begin accruing date is not a valid date.")
	}
	s.Available, s.AccruedYTD, s.UsedYTD = 0, 0, 0
	return nil
}

// ---------------------------------------------------------------------------
// Balance computation

type ptoEvent struct {
	date    string
	order   int // 0 adjustment, 1 paycheck (same day: adjustments first)
	id      int64
	accrued float64
	used    float64
	adjust  float64
}

type ptoAdj struct {
	id    int64
	kind  string
	date  string
	hours float64
}

type ptoCheck struct {
	id                        int64
	date                      string
	sickAcc, sickUsed, vacAcc float64
	vacUsed                   float64
}

type ptoData struct {
	adjs   []ptoAdj
	checks []ptoCheck
}

func (d ptoData) events(kind string) []ptoEvent {
	var out []ptoEvent
	for _, a := range d.adjs {
		if a.kind == kind {
			out = append(out, ptoEvent{date: a.date, order: 0, id: a.id, adjust: a.hours})
		}
	}
	for _, c := range d.checks {
		ev := ptoEvent{date: c.date, order: 1, id: c.id, accrued: c.sickAcc, used: c.sickUsed}
		if kind == "vacation" {
			ev.accrued, ev.used = c.vacAcc, c.vacUsed
		}
		if ev.accrued != 0 || ev.used != 0 {
			out = append(out, ev)
		}
	}
	return out
}

// loadPTOData reads the PTO adjustments and the paycheck accrued/used hours
// dated on or before asOf of one employee (all employees when employeeID is 0).
func loadPTOData(ctx context.Context, q store.Q, employeeID int64, asOf string, excludePaycheckID int64) (map[int64]*ptoData, error) {
	out := map[int64]*ptoData{}
	get := func(id int64) *ptoData {
		d := out[id]
		if d == nil {
			d = &ptoData{}
			out[id] = d
		}
		return d
	}
	query := `SELECT id, employee_id, kind, date, hours FROM pto_adjustments WHERE date <= ?`
	args := []any{asOf}
	if employeeID != 0 {
		query += ` AND employee_id = ?`
		args = append(args, employeeID)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY date, id`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a ptoAdj
		var emp int64
		if err := rows.Scan(&a.id, &emp, &a.kind, &a.date, &a.hours); err != nil {
			rows.Close()
			return nil, err
		}
		get(emp).adjs = append(get(emp).adjs, a)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	query = `SELECT id, employee_id, check_date, sick_accrued, sick_used, vac_accrued, vac_used FROM paychecks
		WHERE voided = 0 AND check_date <= ? AND id <> ?`
	args = []any{asOf, excludePaycheckID}
	if employeeID != 0 {
		query += ` AND employee_id = ?`
		args = append(args, employeeID)
	}
	rows2, err := q.QueryContext(ctx, query+` ORDER BY check_date, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows2.Close()
	for rows2.Next() {
		var c ptoCheck
		var emp int64
		if err := rows2.Scan(&c.id, &emp, &c.date, &c.sickAcc, &c.sickUsed, &c.vacAcc, &c.vacUsed); err != nil {
			return nil, err
		}
		get(emp).checks = append(get(emp).checks, c)
	}
	return out, rows2.Err()
}

// ptoYearStart returns the first day of the PTO year (starting in month ym)
// that contains date.
func ptoYearStart(date string, ym int) string {
	y, m := store.Year(date), monthOf(date)
	if m < ym {
		y--
	}
	return fmt.Sprintf("%04d-%02d-01", y, ym)
}

// ptoFloor returns January 1 of the company's first payroll year ("" when unknown).
func ptoFloor(ctx context.Context, q store.Q) string {
	var y int
	if err := q.QueryRowContext(ctx, `SELECT first_payroll_year FROM company WHERE id = 1`).Scan(&y); err != nil || y <= 0 {
		return ""
	}
	return fmt.Sprintf("%04d-01-01", y)
}

func monthOf(date string) int {
	t, err := store.ParseDate(date)
	if err != nil {
		return 1
	}
	return int(t.Month())
}

func round4(f float64) float64 { return math.Round(f*10000) / 10000 }

// computePTO runs the balance from the first event up to asOf:
//   - at each PTO year start (month YearBeginsMonth, day 1): the balance drops
//     to 0 when ResetEachYear, then beginning_of_year accruals add Hours (only
//     from the begin accruing date / hire date on);
//   - adjustments add or remove hours on their date (before same-day paychecks);
//   - paychecks add their accrued hours and remove their used hours;
//   - MaxHours caps the balance after every step.
//
// accruedYTD and usedYTD cover the calendar year of asOf (accruals after the cap).
// floor is January 1 of the company's first payroll year: years before payroll
// was used get no beginning-of-year accrual (hours accrue on paychecks; the
// balance carried in is entered as "hours available as of").
func computePTO(set model.PTOSettings, hireDate string, events []ptoEvent, asOf, floor string) (available, accruedYTD, usedYTD float64) {
	normalizePTO(&set)
	sort.SliceStable(events, func(i, j int) bool {
		a, b := events[i], events[j]
		if a.date != b.date {
			return a.date < b.date
		}
		if a.order != b.order {
			return a.order < b.order
		}
		return a.id < b.id
	})
	ym := set.YearBeginsMonth
	begin := set.BeginAccruingDate
	if begin == "" {
		begin = hireDate
	}
	if begin != "" && !store.ValidDate(begin) {
		begin = ""
	}
	first := asOf
	if len(events) > 0 && events[0].date < first {
		first = events[0].date
	}
	if begin != "" && begin < first {
		first = begin
	}
	if begin == "" {
		// no hire date: accrue from the PTO year of the first event (or of asOf)
		begin = ptoYearStart(first, ym)
	}
	calStart := fmt.Sprintf("%04d-01-01", store.Year(asOf))

	bal := 0.0
	clip := func() {
		if set.MaxHours != nil && bal > *set.MaxHours {
			bal = *set.MaxHours
		}
	}
	accrue := func(date string, hours, used float64) {
		before := bal
		bal += hours - used
		clip()
		eff := bal - before + used
		if eff < 0 {
			eff = 0
		}
		if date >= calStart {
			accruedYTD += eff
			usedYTD += used
		}
	}
	apply := func(ev ptoEvent) {
		if ev.order == 0 {
			bal += ev.adjust
			clip()
			return
		}
		accrue(ev.date, ev.accrued, ev.used)
	}

	i := 0
	for ys := ptoYearStart(first, ym); ys <= asOf; ys = store.AddMonths(ys, 12) {
		for i < len(events) && events[i].date < ys {
			apply(events[i])
			i++
		}
		if set.ResetEachYear {
			bal = 0
		}
		if set.Accrual == model.AccrueBeginningOfYear && ys >= begin && ys >= floor {
			accrue(ys, set.Hours, 0)
		}
	}
	for ; i < len(events) && events[i].date <= asOf; i++ {
		apply(events[i])
	}
	return round4(bal), round4(accruedYTD), round4(usedYTD)
}

// ---------------------------------------------------------------------------
// Routes: /employees/{id}/pto-adjustments

// PTOAdjustment is one paid time off hour adjustment (opening balance or correction).
type PTOAdjustment = model.PTOAdjustment

func registerPTORoutes(rt *httpx.Router) {
	rt.C("GET", "/employees/{id}/pto-adjustments", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := mustExist(c.Context(), c.DB, id); err != nil {
			return err
		}
		kind := c.Q("kind")
		if kind != "" && kind != "sick" && kind != "vacation" {
			return apperr.Validation("kind", "kind must be sick or vacation")
		}
		list, err := ptoAdjustments(c.Context(), c.DB, id, kind)
		if err != nil {
			return err
		}
		return c.JSON(list)
	})
	// Body {kind, date, hours, memo}. Instead of hours the client may send
	// "available": the hours available on date; the adjustment is then the
	// difference with the computed balance (the "Hours available as of" field).
	rt.C("POST", "/employees/{id}/pto-adjustments", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var body struct {
			Kind      string   `json:"kind"`
			Date      string   `json:"date"`
			Hours     float64  `json:"hours"`
			Available *float64 `json:"available"`
			Memo      string   `json:"memo"`
		}
		if err := c.Decode(&body); err != nil {
			return err
		}
		if body.Kind != "sick" && body.Kind != "vacation" {
			return apperr.Validation("kind", "Choose sick or vacation.")
		}
		if body.Date == "" {
			body.Date = store.Today()
		}
		if !store.ValidDate(body.Date) {
			return apperr.Validation("date", "The date is not valid.")
		}
		if math.Abs(body.Hours) > 100000 {
			return apperr.Validation("hours", "The number of hours is too large.")
		}
		var adj PTOAdjustment
		err = c.Write(func(tx *sql.Tx) error {
			var name string
			if err := tx.QueryRowContext(c.Context(), `SELECT display_name FROM employees WHERE id = ?`, id).Scan(&name); errors.Is(err, sql.ErrNoRows) {
				return apperr.NotFound("Employee not found.")
			} else if err != nil {
				return err
			}
			hours := round4(body.Hours)
			if body.Available != nil {
				cur, _, _, err := PTOBalance(c.Context(), tx, id, body.Kind, body.Date, 0)
				if err != nil {
					return err
				}
				hours = round4(*body.Available - cur)
				if body.Memo == "" {
					body.Memo = fmt.Sprintf("Hours available set to %.2f", *body.Available)
				}
			}
			if hours == 0 {
				if body.Available != nil {
					return nil // already the available balance
				}
				return apperr.Validation("hours", "Enter the hours to add (positive) or remove (negative).")
			}
			now := store.Now()
			res, err := tx.ExecContext(c.Context(), `INSERT INTO pto_adjustments(employee_id, kind, date, hours, memo, created_at) VALUES(?,?,?,?,?,?)`,
				id, body.Kind, body.Date, hours, strings.TrimSpace(body.Memo), now)
			if err != nil {
				return err
			}
			adj = PTOAdjustment{EmployeeID: id, Kind: body.Kind, Date: body.Date, Hours: hours, Memo: strings.TrimSpace(body.Memo), CreatedAt: now}
			adj.ID, _ = res.LastInsertId()
			return store.Audit(c.Context(), tx, c.User, "add", "pto_adjustment", adj.ID,
				fmt.Sprintf("%s hours adjustment for %s: %.2f", kindLabel(body.Kind), name, hours), adj)
		})
		if err != nil {
			return err
		}
		if adj.ID == 0 {
			return c.JSON(map[string]any{"id": 0, "employeeId": id, "kind": body.Kind, "date": body.Date, "hours": 0, "memo": "", "createdAt": ""})
		}
		return c.JSON(adj)
	})
	rt.C("DELETE", "/employees/{id}/pto-adjustments/{adjId}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		adjID, err := c.ID("adjId")
		if err != nil {
			return err
		}
		err = c.Write(func(tx *sql.Tx) error {
			res, err := tx.ExecContext(c.Context(), `DELETE FROM pto_adjustments WHERE id = ? AND employee_id = ?`, adjID, id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return apperr.NotFound("Paid time off adjustment not found.")
			}
			return store.Audit(c.Context(), tx, c.User, "delete", "pto_adjustment", adjID, "Paid time off adjustment", map[string]any{"employeeId": id})
		})
		if err != nil {
			return err
		}
		return c.NoContent()
	})
}

func ptoAdjustments(ctx context.Context, q store.Q, employeeID int64, kind string) ([]PTOAdjustment, error) {
	query := `SELECT id, employee_id, kind, date, hours, memo, created_at FROM pto_adjustments WHERE employee_id = ?`
	args := []any{employeeID}
	if kind != "" {
		query += ` AND kind = ?`
		args = append(args, kind)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY date, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PTOAdjustment{}
	for rows.Next() {
		var a PTOAdjustment
		if err := rows.Scan(&a.ID, &a.EmployeeID, &a.Kind, &a.Date, &a.Hours, &a.Memo, &a.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func mustExist(ctx context.Context, q store.Q, id int64) error {
	var n int
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM employees WHERE id = ?)`, id).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return apperr.NotFound("Employee not found.")
	}
	return nil
}

func kindLabel(kind string) string {
	if kind == "vacation" {
		return "Vacation"
	}
	return "Sick"
}
