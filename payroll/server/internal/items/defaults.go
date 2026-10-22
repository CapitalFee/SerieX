package items

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/taxes"
)

// ---------------------------------------------------------------------------
// Tax tracking types: default taxability and W-2 box 12 codes.

// DefaultBox12 returns the W-2 box 12 code of a tax tracking type ("" = none).
func DefaultBox12(tracking string) string {
	switch tracking {
	case model.Track401k:
		return "D"
	case model.Track403b:
		return "E"
	case model.Track457b:
		return "G"
	case model.TrackSimpleIRA:
		return "S"
	case model.TrackRoth401k:
		return "AA"
	case model.TrackRoth403b:
		return "BB"
	case model.TrackHSA:
		return "W"
	case model.TrackHealthCoverage:
		return "DD"
	case model.TrackGroupTermLife:
		return "C"
	case model.TrackOvertime:
		return "TT"
	}
	return ""
}

// DefaultTaxability returns the wage bases a new item of itemType with the
// tax tracking type counts for. For deductions true means "pre-tax for that
// base" (the deduction reduces it).
func DefaultTaxability(tracking, itemType string) map[string]bool {
	none := map[string]bool{}
	only := func(keys ...string) map[string]bool {
		m := map[string]bool{}
		for _, k := range keys {
			m[k] = true
		}
		return m
	}
	switch itemType {
	case model.ItemFederalTax, model.ItemStateTax, model.ItemOtherTax:
		return none
	case model.ItemDeduction:
		switch tracking {
		case model.Track401k, model.Track403b, model.Track457b, model.TrackSimpleIRA:
			// elective deferrals: income taxes only; FICA, FUTA, SUI and state disability wages keep them
			return only(model.BaseFIT, model.BaseSIT, model.BaseLOCAL)
		case model.Track125, model.TrackHSA, model.TrackDependentCare:
			return model.AllTaxable()
		}
		return none // Roth deferrals, other post-tax deductions
	case model.ItemContribution:
		switch tracking {
		case model.TrackCompensation, model.TrackFringe:
			return model.AllTaxable()
		case model.TrackGroupTermLife:
			return only(model.BaseSS, model.BaseMED)
		}
		return none // employer HSA, health coverage, retirement contributions
	case model.ItemAddition:
		if tracking == model.TrackNone {
			return none // accountable-plan reimbursements
		}
		return model.AllTaxable()
	}
	if tracking == model.TrackNone {
		return none
	}
	return model.AllTaxable() // wages, tips, qualified overtime
}

// applyStateExceptions adjusts the default taxability of an item created for
// a company whose (primary) state does not follow the federal treatment.
// Taxability is per item, not per state, so the exception applies to every
// employee paid with the item; companies with employees in several states
// can create a second item for the other states.
//
//   - PA: elective deferrals (401(k), 403(b), 457(b), SIMPLE) are taxable
//     compensation for PA personal income tax and for the local earned income
//     tax (PA-taxable compensation differs from federal wages for pre-tax
//     deductions).
//   - CA, NJ: health savings accounts are not recognized; employee HSA
//     contributions are taxable wages for state income tax
//     (Franchise Tax Board / NJ Division of Taxation guidance).
//
// Other known differences are not applied by default (verify with the state
// before changing an item): NJ taxes 403(b)/457(b) deferrals for gross income
// tax, PA taxes dependent care (section 125) contributions for personal income
// and local earned income tax, some states include section 125 premiums in
// SUI wages, and state disability programs follow their own wage definitions.
func applyStateExceptions(state, tracking, itemType string, m map[string]bool) {
	if itemType != model.ItemDeduction {
		return
	}
	switch strings.ToUpper(state) {
	case "PA":
		switch tracking {
		case model.Track401k, model.Track403b, model.Track457b, model.TrackSimpleIRA:
			delete(m, model.BaseSIT)
			delete(m, model.BaseLOCAL)
		}
	case "CA", "NJ":
		if tracking == model.TrackHSA {
			delete(m, model.BaseSIT)
		}
	}
}

// mileageRate is the IRS business standard mileage rate (dollars per mile)
// used as the default rate of the Mileage Reimbursement item. Employers may
// reimburse any rate; the user can change it in the item.
func mileageRate(year int) float64 {
	switch {
	case year <= 2025:
		return 0.70 // Notice 2025-5
	case year == 2026:
		// Notice 2026-10: 72.5 cents from January 1, 2026; raised to 76 cents
		// for miles driven from July 1, 2026.
		if time.Now().Format("2006-01-02") >= "2026-07-01" {
			return 0.76
		}
		return 0.725
	}
	return 0.76
}

// ---------------------------------------------------------------------------
// Default items

type defItem struct {
	model.PayrollItem
	matchName string // contribution: name of the deduction it matches
}

func ptrF(f float64) *float64 {
	if f <= 0 {
		return nil
	}
	return &f
}

// stateProgramLabel shortens a tax table program name for an item name:
// "SDI (State Disability Insurance, includes Paid Family Leave)" -> "State
// Disability Insurance", "Paid Family Leave (PFL)" -> "Paid Family Leave".
func stateProgramLabel(p model.StateProgram) string {
	name := strings.TrimSpace(p.Name)
	if i := strings.Index(name, "("); i >= 0 {
		base := strings.TrimSpace(name[:i])
		inner := name[i+1:]
		if j := strings.Index(inner, ")"); j >= 0 {
			inner = inner[:j]
		}
		if k := strings.IndexAny(inner, ",;"); k >= 0 {
			inner = inner[:k]
		}
		inner = strings.TrimSpace(inner)
		if (base == "" || isAcronym(base)) && inner != "" && !isAcronym(strings.ReplaceAll(strings.ReplaceAll(inner, "/", ""), " ", "")) {
			name = inner
		} else if base != "" {
			name = base
		} else {
			name = inner
		}
	}
	for _, suffix := range []string{" employee contribution", " employer contribution", " employee share", " employer share", " employee", " employer"} {
		if strings.HasSuffix(strings.ToLower(name), suffix) {
			name = strings.TrimSpace(name[:len(name)-len(suffix)])
		}
	}
	if name == "" {
		name = p.Key
	}
	return name
}

func isAcronym(s string) bool {
	if s == "" || len(s) > 6 {
		return false
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// defaultItems builds the default item list for a state and year.
func defaultItems(state string, year int, fed *model.FederalTax, st *model.StateTax, refs DefaultRefs) []defItem {
	var out []defItem
	add := func(it model.PayrollItem, match string) {
		it.Active = true
		if it.LimitKind == "" {
			it.LimitKind = "annual"
		}
		if it.Calc == "" {
			it.Calc = model.CalcFixed
		}
		if it.TaxTracking == "" {
			it.TaxTracking = model.TrackCompensation
		}
		if it.Taxability == nil {
			it.Taxability = DefaultTaxability(it.TaxTracking, it.Type)
			applyStateExceptions(state, it.TaxTracking, it.Type, it.Taxability)
		}
		out = append(out, defItem{PayrollItem: it, matchName: match})
	}
	wage := func(name, typ, pto string, rate float64, tracking string) {
		add(model.PayrollItem{Name: name, Type: typ, Pto: pto, Rate: rate, TaxTracking: tracking, W2Box12: DefaultBox12(tracking),
			ExpenseAccountID: refs.WagesExpense}, "")
	}
	limit := func(key string) *float64 {
		if fed == nil || fed.Limits == nil {
			return nil
		}
		return ptrF(fed.Limits[key])
	}

	// Wages
	wage("Salary", model.ItemSalary, "", 0, model.TrackCompensation)
	wage("Sick Salary", model.ItemSalary, "sick", 0, model.TrackCompensation)
	wage("Vacation Salary", model.ItemSalary, "vacation", 0, model.TrackCompensation)
	wage("Hourly Wage", model.ItemHourly, "", 0, model.TrackCompensation)
	wage("Overtime Rate", model.ItemOvertime, "", 1.5, model.TrackOvertime)
	// double time required by state law is not FLSA overtime: not qualified overtime
	wage("Double-time Rate", model.ItemOvertime, "", 2, model.TrackCompensation)
	wage("Sick Hourly", model.ItemHourly, "sick", 0, model.TrackCompensation)
	wage("Vacation Hourly", model.ItemHourly, "vacation", 0, model.TrackCompensation)
	wage("Holiday Hourly", model.ItemHourly, "", 0, model.TrackCompensation)
	add(model.PayrollItem{Name: "Bonus", Type: model.ItemBonus, Supplemental: true, ExpenseAccountID: refs.WagesExpense}, "")
	add(model.PayrollItem{Name: "Commission", Type: model.ItemCommission, Calc: model.CalcQuantity, ExpenseAccountID: refs.WagesExpense}, "")
	add(model.PayrollItem{Name: "Paid Tips", Type: model.ItemTips, TaxTracking: model.TrackPaidTips, ExpenseAccountID: refs.WagesExpense}, "")
	add(model.PayrollItem{Name: "Reported Tips", Type: model.ItemReportedTips, TaxTracking: model.TrackReportedTips, NotPaid: true,
		ExpenseAccountID: refs.WagesExpense}, "")

	// Additions
	add(model.PayrollItem{Name: "Mileage Reimbursement", Type: model.ItemAddition, Calc: model.CalcQuantity, Rate: mileageRate(year),
		TaxTracking: model.TrackNone, ExpenseAccountID: refs.ReimbExpense}, "")

	// Deductions
	add(model.PayrollItem{Name: "401(k) Employee", Type: model.ItemDeduction, Calc: model.CalcPercent, Rate: 5,
		AnnualLimit: limit("elective401k"), TaxTracking: model.Track401k, W2Box12: "D", LiabilityAccountID: refs.RetirementLiab}, "")
	add(model.PayrollItem{Name: "Roth 401(k)", Type: model.ItemDeduction, Calc: model.CalcPercent,
		AnnualLimit: limit("elective401k"), TaxTracking: model.TrackRoth401k, W2Box12: "AA", LiabilityAccountID: refs.RetirementLiab}, "")
	// W-2 box 12 DD reports the total cost of employer-sponsored health
	// coverage: the employee's pre-tax premiums plus the company's share.
	add(model.PayrollItem{Name: "Health Insurance", Type: model.ItemDeduction, TaxTracking: model.Track125, W2Box12: "DD",
		LiabilityAccountID: refs.HealthLiab}, "")
	add(model.PayrollItem{Name: "HSA Employee", Type: model.ItemDeduction, TaxTracking: model.TrackHSA, W2Box12: "W",
		LiabilityAccountID: refs.HealthLiab}, "")
	add(model.PayrollItem{Name: "Dependent Care FSA", Type: model.ItemDeduction, AnnualLimit: limit("dependentCare"),
		TaxTracking: model.TrackDependentCare, LiabilityAccountID: refs.HealthLiab}, "")

	// Company contributions. The match is a retirement contribution (W-2 box
	// 13 retirement plan) but not an elective deferral (no box 12 code).
	add(model.PayrollItem{Name: "401(k) Company Match", Type: model.ItemContribution, Calc: model.CalcMatch, Rate: 100, MatchCapPct: 4,
		TaxTracking: model.Track401k, ExpenseAccountID: refs.BenefitsExpense, LiabilityAccountID: refs.RetirementLiab}, "401(k) Employee")
	add(model.PayrollItem{Name: "Health Insurance Company", Type: model.ItemContribution, TaxTracking: model.TrackHealthCoverage, W2Box12: "DD",
		ExpenseAccountID: refs.BenefitsExpense, LiabilityAccountID: refs.HealthLiab}, "")

	// Federal taxes
	fedTax := func(code string) {
		it := model.PayrollItem{Name: model.TaxCodeLabels[code], Type: model.ItemFederalTax, TaxCode: code, Calc: model.CalcTax,
			TaxTracking: model.TrackCompensation, Taxability: map[string]bool{}, AgencyVendorID: refs.IRSVendor}
		it.LiabilityAccountID = refs.FederalLiab
		if code == model.TaxFUTA {
			it.LiabilityAccountID = refs.FUTALiab
		}
		if model.IsEmployerTax(code) {
			it.ExpenseAccountID = refs.TaxesExpense
		}
		add(it, "")
	}
	for _, code := range []string{model.TaxFIT, model.TaxSSEE, model.TaxSSER, model.TaxMedEE, model.TaxMedER, model.TaxAddlMed, model.TaxFUTA} {
		fedTax(code)
	}

	// State taxes
	if st == nil {
		return out
	}
	stTax := func(name, code, key string, liab, agency *int64) {
		it := model.PayrollItem{Name: name, Type: model.ItemStateTax, TaxCode: code, State: st.State, TaxKey: key, Calc: model.CalcTax,
			TaxTracking: model.TrackCompensation, Taxability: map[string]bool{}, LiabilityAccountID: liab, AgencyVendorID: agency}
		if model.IsEmployerTax(code) {
			it.ExpenseAccountID = refs.TaxesExpense
		}
		add(it, "")
	}
	if st.Income.Has {
		stTax(st.State+" - Withholding", model.TaxSIT, "", refs.StateWHLiab, refs.StateWHVendor)
	}
	stTax(st.State+" - Unemployment (company)", model.TaxSUIER, "", refs.StateUILiab, refs.StateUIVendor)
	if st.SUI.EmployeeRate > 0 {
		stTax(st.State+" - Unemployment (employee)", model.TaxSUIEE, "", refs.StateUILiab, refs.StateUIVendor)
	}
	// Other state programs (disability, paid leave, training taxes...). They
	// are paid with the state unemployment group by default; programs funded
	// through a private insurer (e.g. NY DBL/PFL) can be given another agency
	// in the item.
	employeeLabels := map[string]bool{}
	for _, p := range st.Programs {
		if p.EmployeeRate > 0 {
			employeeLabels[strings.ToLower(stateProgramLabel(p))] = true
		}
	}
	for _, p := range st.Programs {
		label := stateProgramLabel(p)
		if p.EmployeeRate > 0 {
			stTax(st.State+" - "+label+" (employee)", model.TaxStateEE, p.Key, refs.StateUILiab, refs.StateUIVendor)
		}
		if p.EmployerRate > 0 {
			// "(company)" tells the employer side apart from an employee item of
			// the same program ("NJ - Temporary Disability Insurance (company)");
			// employer-only programs keep their name ("CA - Employment Training Tax").
			name := st.State + " - " + label
			lowLabel := strings.ToLower(label)
			if p.EmployeeRate > 0 || employeeLabels[lowLabel] ||
				(strings.Contains(strings.ToLower(p.Name), "employer") && !strings.Contains(lowLabel, "employer")) {
				name += " (company)"
			}
			stTax(name, model.TaxStateER, p.Key, refs.StateUILiab, refs.StateUIVendor)
		}
	}
	return out
}

// createDefaults inserts the default items that do not exist yet and returns
// how many were created.
func createDefaults(ctx context.Context, tx *sql.Tx, state string, year int, refs DefaultRefs) (int, error) {
	state = strings.ToUpper(strings.TrimSpace(state))
	if year == 0 {
		year = time.Now().Year()
	}
	tables, _, err := taxes.Tables(year)
	if err != nil {
		return 0, fmt.Errorf("tax tables for %d: %w", year, err)
	}
	var st *model.StateTax
	if state != "" {
		s, ok := tables.States[state]
		if !ok {
			return 0, fmt.Errorf("there are no tax tables for state %q", state)
		}
		if s.State == "" {
			s.State = state
		}
		st = &s
	}

	// what exists already: names, and tax items by code/state/program
	names := map[string]int64{}
	types := map[int64]string{}
	taxKeys := map[string]bool{}
	rows, err := tx.QueryContext(ctx, `SELECT id, name, type, tax_code, state, tax_key FROM payroll_items`)
	if err != nil {
		return 0, err
	}
	for rows.Next() {
		var id int64
		var name, typ, code, st, key string
		if err := rows.Scan(&id, &name, &typ, &code, &st, &key); err != nil {
			rows.Close()
			return 0, err
		}
		names[lower(name)] = id
		types[id] = typ
		if typ == model.ItemFederalTax || typ == model.ItemStateTax {
			taxKeys[taxIdentity(code, st, key)] = true
		}
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	created := 0
	for _, d := range defaultItems(state, year, &tables.Federal, st, refs) {
		it := d.PayrollItem
		isTax := it.Type == model.ItemFederalTax || it.Type == model.ItemStateTax
		if isTax {
			if taxKeys[taxIdentity(it.TaxCode, it.State, it.TaxKey)] {
				continue
			}
			if _, taken := names[lower(it.Name)]; taken {
				// another kind of item uses the name: keep the tax item, renamed
				it.Name = it.Name + " (" + it.TaxCode + ")"
				if _, taken := names[lower(it.Name)]; taken {
					continue
				}
			}
		} else if _, taken := names[lower(it.Name)]; taken {
			continue
		}
		if d.matchName != "" {
			id, ok := names[lower(d.matchName)]
			if !ok || types[id] != model.ItemDeduction {
				continue // the matched deduction does not exist (another kind of item may use its name)
			}
			it.MatchItemID = &id
		}
		id, err := insertItem(ctx, tx, &it)
		if err != nil {
			return created, fmt.Errorf("create payroll item %q: %w", it.Name, err)
		}
		names[lower(it.Name)] = id
		types[id] = it.Type
		if isTax {
			taxKeys[taxIdentity(it.TaxCode, it.State, it.TaxKey)] = true
		}
		created++
	}
	return created, nil
}

// taxIdentity is the key of "one active item per tax code + state + program".
func taxIdentity(code, state, key string) string {
	if isFederalCode(code) {
		return code
	}
	if code == model.TaxStateEE || code == model.TaxStateER {
		return code + "|" + strings.ToUpper(state) + "|" + strings.ToUpper(key)
	}
	return code + "|" + strings.ToUpper(state)
}
