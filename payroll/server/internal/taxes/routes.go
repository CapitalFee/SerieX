package taxes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the tax table routes (/tax-tables...).
//
//	GET    /tax-tables?year=                    TaxTableInfo (merged federal + state summaries)
//	GET    /tax-tables/{year}/federal           FederalTax (merged)
//	PUT    /tax-tables/{year}/federal           body FederalTax -> stores the changes (admin)
//	DELETE /tax-tables/{year}/federal           restores the built-in table (admin)
//	GET    /tax-tables/{year}/states/{state}    StateTax (merged)
//	PUT    /tax-tables/{year}/states/{state}    body StateTax (admin)
//	DELETE /tax-tables/{year}/states/{state}    (admin)
func Register(rt *httpx.Router) {
	rt.C("GET", "/tax-tables", getInfo)
	rt.C("GET", "/tax-tables/{year}/federal", getFederal)
	rt.C("PUT", "/tax-tables/{year}/federal", putFederal)
	rt.C("DELETE", "/tax-tables/{year}/federal", deleteFederal)
	rt.C("GET", "/tax-tables/{year}/states/{state}", getState)
	rt.C("PUT", "/tax-tables/{year}/states/{state}", putState)
	rt.C("DELETE", "/tax-tables/{year}/states/{state}", deleteState)
}

func pathYear(c *httpx.Ctx) (int, error) {
	s := c.R.PathValue("year")
	y, err := strconv.Atoi(s)
	if err != nil || y < 2000 || y > 2100 {
		return 0, apperr.BadRequest("invalid year %q", s)
	}
	return y, nil
}

func pathState(c *httpx.Ctx, ty *model.TaxYear) (string, error) {
	code := strings.ToUpper(strings.TrimSpace(c.R.PathValue("state")))
	if _, ok := ty.States[code]; !ok {
		return "", apperr.NotFound("There are no tax tables for state %q.", code)
	}
	return code, nil
}

func requireAdmin(c *httpx.Ctx) error {
	if !c.IsAdmin {
		return apperr.Forbidden("Only a SerieX Books administrator can change the payroll tax tables.")
	}
	return nil
}

// companyTables: the override rows of a requested year, plus those of the
// built-in year used in its place (a 2026 correction keeps applying when the
// 2026 tables are used for 2027), with the values already announced for the
// requested year (data/announced) applied between the two.
func companyTables(ctx context.Context, q store.Q, year int) (*model.TaxYear, string, error) {
	ty, warn, err := Tables(year)
	if err != nil {
		return nil, warn, err
	}
	ys := []int{year}
	if ty.Year != year {
		ys = []int{ty.Year, year}
	}
	for _, y := range ys {
		ovs, err := loadOverrides(ctx, q, y)
		if err != nil {
			return nil, warn, err
		}
		for _, o := range ovs {
			if err := applyOverride(ty, o); err != nil {
				return nil, warn, err
			}
		}
		if y != year {
			// values announced for the requested year (and its empty credit
			// reduction list) win over the older year's corrections
			if err := applyAnnounced(ty, year); err != nil {
				return nil, warn, err
			}
		}
	}
	return ty, warn, nil
}

func overriddenScopes(ctx context.Context, q store.Q, year int) (map[string]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT scope, state FROM tax_overrides WHERE year = ?`, year)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var scope, state string
		if err := rows.Scan(&scope, &state); err != nil {
			return nil, err
		}
		if scope == "federal" {
			out["federal"] = true
		} else {
			out[state] = true
		}
	}
	return out, rows.Err()
}

func getInfo(c *httpx.Ctx) error {
	year := int(c.QInt("year"))
	if year == 0 {
		year = time.Now().Year()
	}
	if year < 2000 || year > 2100 {
		return apperr.BadRequest("invalid year %d", year)
	}
	ty, warn, err := ForCompany(c.Context(), c.DB, year)
	if err != nil {
		return err
	}
	ov, err := overriddenScopes(c.Context(), c.DB, year)
	if err != nil {
		return err
	}
	info := model.TaxTableInfo{Year: year, Version: ty.Version, Federal: ty.Federal, States: []model.StateTaxSummary{}, Overrides: []string{}}
	if warn != "" {
		info.Version = fmt.Sprintf("%s (%d tables)", ty.Version, ty.Year)
	}
	for code, st := range ty.States {
		info.States = append(info.States, model.StateTaxSummary{
			State: code, Name: st.Name, Method: st.Income.Method, FlatRate: st.Income.FlatRate,
			SUIWageBase: st.SUI.WageBase, SUINewRate: st.SUI.NewEmployerRate, Programs: len(st.Programs),
			Confidence: st.Confidence, Overridden: ov[code],
		})
	}
	sort.Slice(info.States, func(i, j int) bool { return info.States[i].State < info.States[j].State })
	for k := range ov {
		info.Overrides = append(info.Overrides, k)
	}
	sort.Slice(info.Overrides, func(i, j int) bool {
		if (info.Overrides[i] == "federal") != (info.Overrides[j] == "federal") {
			return info.Overrides[i] == "federal"
		}
		return info.Overrides[i] < info.Overrides[j]
	})
	return c.JSON(info)
}

func getFederal(c *httpx.Ctx) error {
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	ty, _, err := ForCompany(c.Context(), c.DB, year)
	if err != nil {
		return err
	}
	return c.JSON(ty.Federal)
}

func getState(c *httpx.Ctx) error {
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	ty, _, err := ForCompany(c.Context(), c.DB, year)
	if err != nil {
		return err
	}
	code, err := pathState(c, ty)
	if err != nil {
		return err
	}
	return c.JSON(ty.States[code])
}

func putFederal(c *httpx.Ctx) error {
	if err := requireAdmin(c); err != nil {
		return err
	}
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	var body model.FederalTax
	if err := c.Decode(&body); err != nil {
		return err
	}
	builtinTy, _, err := Tables(year)
	if err != nil {
		return err
	}
	body.Year = builtinTy.Federal.Year
	if err := checkFederal(&body); err != nil {
		return apperr.BadRequest("%v", err)
	}
	if err := validateRates(body.SSRate, body.MedicareRate, body.AddlMedicareRate, body.FUTARate, body.FUTAGrossRate, body.SupplementalRate, body.SupplementalOver1MRate); err != nil {
		return err
	}
	diff, err := diffAgainst(builtinTy.Federal, body)
	if err != nil {
		return err
	}
	if err := saveOverride(c, year, "federal", "", diff); err != nil {
		return err
	}
	return getFederal(c)
}

func putState(c *httpx.Ctx) error {
	if err := requireAdmin(c); err != nil {
		return err
	}
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	builtinTy, _, err := Tables(year)
	if err != nil {
		return err
	}
	code, err := pathState(c, builtinTy)
	if err != nil {
		return err
	}
	var body model.StateTax
	if err := c.Decode(&body); err != nil {
		return err
	}
	base := builtinTy.States[code]
	body.State, body.Year = code, base.Year
	if body.Name == "" {
		body.Name = base.Name
	}
	// edited marginal schedules get their bases recomputed when the built-in
	// bases were computed (published bases are kept as sent)
	for k, s := range body.Income.Statuses {
		if bs, ok := base.Income.Statuses[k]; ok && computedBases(bs.Brackets) && !sameRows(bs.Brackets, s.Brackets) && sameBases(bs.Brackets, s.Brackets) {
			for i := range s.Brackets {
				s.Brackets[i].Base = 0
			}
			body.Income.Statuses[k] = s
		}
	}
	if err := prepareState(&body); err != nil {
		return apperr.BadRequest("%s: %v", code, err)
	}
	if err := validateState(&body); err != nil {
		return err
	}
	diff, err := diffAgainst(base, body)
	if err != nil {
		return err
	}
	if err := saveOverride(c, year, "state", code, diff); err != nil {
		return err
	}
	return getState(c)
}

func deleteFederal(c *httpx.Ctx) error {
	if err := requireAdmin(c); err != nil {
		return err
	}
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	if err := saveOverride(c, year, "federal", "", nil); err != nil {
		return err
	}
	return getFederal(c)
}

func deleteState(c *httpx.Ctx) error {
	if err := requireAdmin(c); err != nil {
		return err
	}
	year, err := pathYear(c)
	if err != nil {
		return err
	}
	ty, _, err := Tables(year)
	if err != nil {
		return err
	}
	code, err := pathState(c, ty)
	if err != nil {
		return err
	}
	if err := saveOverride(c, year, "state", code, nil); err != nil {
		return err
	}
	return getState(c)
}

// diffAgainst returns the JSON keys of next that differ from the built-in value.
func diffAgainst(builtinV, next any) (map[string]any, error) {
	bm, err := toMap(builtinV)
	if err != nil {
		return nil, err
	}
	nm, err := toMap(next)
	if err != nil {
		return nil, err
	}
	return diffObject(bm, nm), nil
}

// saveOverride stores (or removes, when data is nil) the override of a scope
// and writes the audit trail row.
func saveOverride(c *httpx.Ctx, year int, scope, state string, data map[string]any) error {
	label := fmt.Sprintf("%d %s", year, scope)
	if state != "" {
		label = fmt.Sprintf("%d %s", year, state)
	}
	return c.Write(func(tx *sql.Tx) error {
		ctx := c.Context()
		var old string
		err := tx.QueryRowContext(ctx, `SELECT data FROM tax_overrides WHERE year = ? AND scope = ? AND state = ?`, year, scope, state).Scan(&old)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		had := err == nil
		var before any
		if had {
			_ = json.Unmarshal([]byte(old), &before)
		}
		if data == nil {
			if !had {
				return nil
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM tax_overrides WHERE year = ? AND scope = ? AND state = ?`, year, scope, state); err != nil {
				return err
			}
			return store.Audit(ctx, tx, c.User, "delete", "tax_table", 0, "Restored the built-in tax table "+label,
				map[string]any{"year": year, "scope": scope, "state": state, "before": before})
		}
		b, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO tax_overrides(year, scope, state, data, updated_by, updated_at) VALUES(?,?,?,?,?,?)
			ON CONFLICT(year, scope, state) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
			year, scope, state, string(b), c.User, store.Now()); err != nil {
			return err
		}
		action := "add"
		if had {
			action = "modify"
		}
		return store.Audit(ctx, tx, c.User, action, "tax_table", 0, "Changed the tax table "+label,
			map[string]any{"year": year, "scope": scope, "state": state, "before": before, "after": data})
	})
}

func validateRates(rates ...float64) error {
	for _, r := range rates {
		if r < 0 || r > 100 {
			return apperr.BadRequest("Rates must be between 0 and 100 percent.")
		}
	}
	return nil
}

func validateState(st *model.StateTax) error {
	if err := validateRates(st.SUI.NewEmployerRate, st.SUI.MinRate, st.SUI.MaxRate, st.SUI.EmployeeRate, st.Income.FlatRate); err != nil {
		return err
	}
	if st.SUI.WageBase < 0 {
		return apperr.BadRequest("The SUI wage base cannot be negative.")
	}
	if st.Income.SupplementalRate != nil {
		if err := validateRates(*st.Income.SupplementalRate); err != nil {
			return err
		}
	}
	keys := map[string]bool{}
	for _, p := range st.Programs {
		if strings.TrimSpace(p.Key) == "" {
			return apperr.BadRequest("Every state program needs a key.")
		}
		if keys[strings.ToUpper(p.Key)] {
			return apperr.BadRequest("The program key %q is used twice.", p.Key)
		}
		keys[strings.ToUpper(p.Key)] = true
		if err := validateRates(p.EmployeeRate, p.EmployerRate); err != nil {
			return err
		}
	}
	for k, s := range st.Income.Statuses {
		for _, b := range s.Brackets {
			if b.Rate < 0 || b.Rate > 100 || b.Over < 0 {
				return apperr.BadRequest("Status %s: bracket rates must be 0-100%% and thresholds not negative.", k)
			}
		}
	}
	return nil
}

func computedBases(rows []model.Bracket) bool {
	cp := make([]model.Bracket, len(rows))
	for i, r := range rows {
		cp[i] = model.Bracket{Over: r.Over, Rate: r.Rate}
	}
	_ = fillBases(cp)
	return sameBases(cp, rows)
}

func sameBases(a, b []model.Bracket) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Base != b[i].Base {
			return false
		}
	}
	return true
}

func sameRows(a, b []model.Bracket) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Over != b[i].Over || a[i].Rate != b[i].Rate {
			return false
		}
	}
	return true
}
