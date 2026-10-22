package reports

import (
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// listResult starts a list report (no date range in the header).
func (e *env) listResult(title string, cols ...model.ReportColumn) *model.ReportResult {
	r := e.newResult(title, false, cols...)
	r.DateRangeLabel = ""
	return r
}

// listEmployees returns the employees of a list report (active filter,
// employeeId filter) by display name.
func (e *env) listEmployees() ([]*employee, error) {
	all, err := e.employees()
	if err != nil {
		return nil, err
	}
	ids := map[int64]bool{}
	for id, m := range all {
		if e.p.EmployeeID > 0 && id != e.p.EmployeeID {
			continue
		}
		if e.p.EmployeeID == 0 && !e.activeFilter(m.Active) {
			continue
		}
		ids[id] = true
	}
	return sortedEmployees(all, ids), nil
}

func yesNo(b bool) string {
	if b {
		return "Yes"
	}
	return "No"
}

var fedStatusLabels = map[string]string{
	"single":         "Single or Married filing separately",
	"mfj":            "Married filing jointly",
	"hoh":            "Head of household",
	"married":        "Married",
	"married_single": "Married, but withhold at higher Single rate",
}

// ---------------------------------------------------------------------------
// Employee Withholding

func employeeWithholding(e *env) (*model.ReportResult, error) {
	list, err := e.listEmployees()
	if err != nil {
		return nil, err
	}
	ty, _, _ := taxes.ForCompany(e.ctx, e.q, store.Year(e.p.Today))
	res := e.listResult("Employee Withholding", col("label", "Employee", "text"), col("ssn", "SS No.", "text"),
		col("fedStatus", "Federal Filing Status", "text"), col("w4", "W-4 Form", "text"),
		col("fedAllowances", "Federal Allowances", "number"), col("dependents", "Dependents Amount", "money"),
		col("otherIncome", "Other Income", "money"), col("deductions", "Deductions", "money"),
		col("fedExtra", "Federal Extra Withholding", "money"), col("fedExempt", "Federal Exempt", "text"),
		col("nra", "Nonresident Alien", "text"), col("state", "State Worked", "text"),
		col("stateStatus", "State Filing Status", "text"), col("stateAllowances", "State Allowances", "number"),
		col("stateExtra", "State Extra Withholding", "money"), col("stateExempt", "State Exempt", "text"),
		col("subjectSs", "Subject to Social Security", "text"), col("subjectMedicare", "Subject to Medicare", "text"),
		col("subjectFuta", "Subject to Federal Unemployment", "text"), col("subjectSui", "Subject to State Unemployment", "text"),
		col("subjectSdi", "Subject to State Disability", "text"))
	for _, m := range list {
		emp, err := employees.Load(e.ctx, e.q, m.ID, false)
		if err != nil {
			return nil, err
		}
		w := emp.W4
		c := map[string]any{"label": m.DisplayName, "ssn": e.ssn(m.SSN), "fedExempt": yesNo(w.Exempt),
			"nra": yesNo(w.NonresidentAlien), "state": emp.WorkState, "stateAllowances": emp.StateW4.Allowances,
			"stateExtra": emp.StateW4.ExtraWithholding, "stateExempt": yesNo(emp.StateW4.Exempt),
			"subjectSs": yesNo(emp.SubjectSS), "subjectMedicare": yesNo(emp.SubjectMedicare), "subjectFuta": yesNo(emp.SubjectFUTA),
			"subjectSui": yesNo(emp.SubjectSUI), "subjectSdi": yesNo(emp.SubjectSDI), "fedExtra": w.ExtraWithholding}
		st := fedStatusLabels[w.FilingStatus]
		if st == "" {
			st = w.FilingStatus
		}
		if w.Version == "pre2020" && w.FilingStatus == "single" {
			st = "Single"
		}
		c["fedStatus"] = st
		if w.Version == "pre2020" {
			c["w4"] = "2019 or earlier"
			c["fedAllowances"] = w.Allowances
		} else {
			c["w4"] = "2020 or later"
			c["dependents"] = w.Dependents
			c["otherIncome"] = w.OtherIncome
			c["deductions"] = w.Deductions
		}
		ss := emp.StateW4.FilingStatus
		if ty != nil {
			if stt, ok := ty.States[emp.WorkState]; ok {
				if ss == "" {
					ss = stt.Income.DefaultStatus
				}
				if s, ok := stt.Income.Statuses[ss]; ok && s.Label != "" {
					ss = s.Label
				}
				if !stt.Income.Has {
					ss = "(no state income tax)"
				}
			}
		}
		c["stateStatus"] = ss
		r := addRow(res, "data", 0, "", c)
		r.Target = target("employee", m.ID)
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// Paid Time Off List (as of the report date)

func paidTimeOffList(e *env) (*model.ReportResult, error) {
	list, err := e.listEmployees()
	if err != nil {
		return nil, err
	}
	asOf := e.p.AsOf
	res := e.newResult("Paid Time Off List", true, col("label", "Employee", "text"),
		col("sickAvailable", "Sick Available", "number"), col("sickAccrued", "Sick Accrued YTD", "number"),
		col("sickUsed", "Sick Used YTD", "number"), col("vacAvailable", "Vacation Available", "number"),
		col("vacAccrued", "Vacation Accrued YTD", "number"), col("vacUsed", "Vacation Used YTD", "number"))
	for _, m := range list {
		sa, sacc, su, err := employees.PTOBalance(e.ctx, e.q, m.ID, "sick", asOf, 0)
		if err != nil {
			return nil, err
		}
		va, vacc, vu, err := employees.PTOBalance(e.ctx, e.q, m.ID, "vacation", asOf, 0)
		if err != nil {
			return nil, err
		}
		r := addRow(res, "data", 0, "", map[string]any{"label": m.DisplayName,
			"sickAvailable": round2h(sa), "sickAccrued": round2h(sacc), "sickUsed": round2h(su),
			"vacAvailable": round2h(va), "vacAccrued": round2h(vacc), "vacUsed": round2h(vu)})
		r.Target = target("employee", m.ID)
	}
	return res, nil
}

// round2h rounds hours to 2 decimals.
func round2h(h float64) float64 {
	f, _ := strconv.ParseFloat(strconv.FormatFloat(h, 'f', 2, 64), 64)
	return f
}

// ---------------------------------------------------------------------------
// Employee Contact List

func employeeContactList(e *env) (*model.ReportResult, error) {
	list, err := e.listEmployees()
	if err != nil {
		return nil, err
	}
	res := e.listResult("Employee Contact List", col("label", "Employee", "text"), col("ssn", "SS No.", "text"),
		col("address", "Address", "text"), col("phone", "Main Phone", "text"), col("mobile", "Mobile", "text"),
		col("email", "Email", "text"), col("hireDate", "Hire Date", "date"), col("releaseDate", "Release Date", "date"))
	for _, m := range list {
		c := map[string]any{"label": m.DisplayName, "ssn": e.ssn(m.SSN), "address": oneLineAddress(m.Address),
			"phone": m.Phone, "mobile": m.Mobile, "email": m.Email, "hireDate": nilDate(m.HireDate), "releaseDate": nilDate(m.ReleaseDate)}
		r := addRow(res, "data", 0, "", c)
		r.Target = target("employee", m.ID)
	}
	return res, nil
}

func nilDate(d string) any {
	if d == "" {
		return nil
	}
	return d
}

func oneLineAddress(a model.Address) string {
	var parts []string
	for _, s := range []string{a.Line1, a.Line2} {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	csz := strings.TrimSpace(a.City)
	if a.State != "" {
		if csz != "" {
			csz += ", "
		}
		csz += a.State
	}
	if a.Zip != "" {
		if csz != "" {
			csz += " "
		}
		csz += a.Zip
	}
	if csz != "" {
		parts = append(parts, csz)
	}
	return strings.Join(parts, ", ")
}

// ---------------------------------------------------------------------------
// Payroll Item Settings

var trackingLabels = map[string]string{
	model.TrackCompensation:   "Wages",
	model.TrackNone:           "Not wages",
	model.TrackReportedTips:   "Reported tips",
	model.TrackPaidTips:       "Paid tips",
	model.TrackOvertime:       "Qualified overtime",
	model.Track401k:           "401(k)",
	model.Track403b:           "403(b)",
	model.Track457b:           "457(b)",
	model.TrackRoth401k:       "Roth 401(k)",
	model.TrackRoth403b:       "Roth 403(b)",
	model.TrackSimpleIRA:      "SIMPLE IRA",
	model.Track125:            "Section 125 (pre-tax)",
	model.TrackHSA:            "HSA",
	model.TrackDependentCare:  "Dependent care FSA",
	model.TrackGroupTermLife:  "Group-term life",
	model.TrackHealthCoverage: "Health coverage cost",
	model.TrackFringe:         "Taxable fringe benefit",
	model.TrackOther:          "Other (after tax)",
}

func pct(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64) + "%"
}

func payrollItemListing(e *env) (*model.ReportResult, error) {
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	year := store.Year(e.p.Today)
	ty, _, _ := taxes.ForCompany(e.ctx, e.q, year)
	lk := e.lookups()
	var list []*model.PayrollItem
	for _, it := range its {
		if e.p.ItemID > 0 && it.ID != e.p.ItemID {
			continue
		}
		if e.p.ItemID == 0 && !e.activeFilter(it.Active) {
			continue
		}
		list = append(list, it)
	}
	sortItems(list)
	res := e.listResult("Payroll Item Settings", col("label", "Payroll Item", "text"), col("type", "Type", "text"),
		col("amount", "Amount / Rate", "text"), col("limit", "Yearly Limit", "money"), col("expense", "Expense Account", "text"),
		col("liability", "Liability Account", "text"), col("tracking", "Tax Treatment", "text"), col("payableTo", "Paid To", "text"))
	for _, it := range list {
		amount, limit := itemRate(e, it, ty, year)
		tracking := trackingLabels[it.TaxTracking]
		if it.Type == model.ItemFederalTax || it.Type == model.ItemStateTax || it.Type == model.ItemOtherTax {
			tracking = "Not wages"
			if it.TaxCode != "" {
				tracking = model.TaxCodeLabels[it.TaxCode]
				if it.TaxKey != "" {
					tracking += " (" + it.TaxKey + ")"
				}
			}
		}
		name := it.Name
		if !it.Active {
			name += " (inactive)"
		}
		c := map[string]any{"label": name, "type": model.ItemTypeLabels[it.Type], "amount": amount,
			"expense": lk.AccountName(it.ExpenseAccountID), "liability": lk.AccountName(it.LiabilityAccountID),
			"tracking": tracking, "payableTo": e.vendorName(it.AgencyVendorID)}
		if limit != nil {
			c["limit"] = *limit
		}
		r := addRow(res, "data", 0, "", c)
		r.Target = target("item", it.ID)
	}
	return res, nil
}

// itemRate is the Amount / Rate and limit shown for an item: its own rate, or
// for tax items the rate and wage base of the tax tables (company SUI rate).
func itemRate(e *env, it *model.PayrollItem, ty *model.TaxYear, year int) (string, *float64) {
	limit := it.AnnualLimit
	money := func(v float64) string { return fmtMoney(store.Cents(v)) }
	switch it.Type {
	case model.ItemSalary, model.ItemHourly:
		if it.Rate != 0 {
			return money(it.Rate), limit
		}
		return "", limit
	case model.ItemOvertime:
		return strconv.FormatFloat(it.Rate, 'f', -1, 64) + "x", limit
	case model.ItemFederalTax, model.ItemStateTax:
		if ty == nil {
			return "", limit
		}
		fed := ty.Federal
		// no wage limit: the tax tables write an unlimited wage base as a huge number (e.g. PA employee UC)
		wb := func(v float64) *float64 {
			if v <= 0 || v >= 1e8 {
				return nil
			}
			return &v
		}
		st, hasSt := ty.States[it.State]
		rate := 0.0
		var base *float64
		switch it.TaxCode {
		case model.TaxSSEE, model.TaxSSER:
			rate, base = fed.SSRate, wb(fed.SSWageBase)
		case model.TaxMedEE, model.TaxMedER:
			rate = fed.MedicareRate
		case model.TaxAddlMed:
			rate = fed.AddlMedicareRate
		case model.TaxFUTA:
			rate, base = fed.FUTARate, wb(fed.FUTAWageBase)
		case model.TaxSUIER:
			if hasSt {
				rate, base = taxes.SUIRate(e.ctx, e.q, &st, year), wb(st.SUI.WageBase)
			}
		case model.TaxSUIEE:
			if hasSt {
				rate, base = st.SUI.EmployeeRate, wb(st.SUI.WageBase)
				if st.SUI.EmployeeWageBase != nil {
					base = wb(*st.SUI.EmployeeWageBase)
				}
			}
		case model.TaxStateEE, model.TaxStateER:
			if hasSt {
				rate = taxes.ProgramRate(e.ctx, e.q, &st, year, it.TaxKey, it.TaxCode == model.TaxStateER)
				for _, pr := range st.Programs {
					if strings.EqualFold(pr.Key, it.TaxKey) && pr.WageBase != nil {
						base = wb(*pr.WageBase)
					}
				}
			}
		default:
			return "", limit
		}
		if it.Rate > 0 {
			rate = it.Rate
		}
		if limit == nil {
			limit = base
		}
		if rate == 0 {
			return "", limit
		}
		return pct(rate), limit
	}
	if it.Rate == 0 && it.Calc != model.CalcMatch {
		return "", limit // set per employee
	}
	switch it.Calc {
	case model.CalcPercent:
		return pct(it.Rate), limit
	case model.CalcMatch:
		return fmt.Sprintf("%s up to %s of gross", pct(it.Rate), pct(it.MatchCapPct)), limit
	case model.CalcQuantity:
		if it.Type == model.ItemCommission {
			return pct(it.Rate), limit
		}
		return money(it.Rate) + " per unit", limit
	case model.CalcPerHour:
		return money(it.Rate) + " per hour", limit
	case model.CalcTax:
		if it.Rate > 0 {
			return pct(it.Rate), limit
		}
		return "", limit
	}
	if it.Rate != 0 {
		return money(it.Rate), limit
	}
	return "", limit
}
