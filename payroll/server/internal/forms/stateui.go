package forms

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// State quarterly wage report (California DE 9 / DE 9C style): totals of the
// state's unemployment insurance, other state payroll taxes and state income
// tax withholding for the quarter, plus the wage list per employee.

type suiEmp struct {
	row      model.StateWageRow
	gross    int64
	taxable  int64
	sitWages int64
	sit      int64
	weeks    map[string]bool
}

// uiReports are the quarterly unemployment insurance contribution and wage
// reports by state (from each state's agency instructions). The tax tables
// describe the withholding return and the unemployment report in one text
// ("PA-W3 ...; UI: UC-2 ..."), so the report name is not taken from there.
var uiReports = map[string]string{
	"AK": "TQ01C", "AL": "UC-CR4 / UC-CR4A", "AR": "DWS-ARK-209B", "AZ": "UC-018", "CA": "DE 9 / DE 9C",
	"CO": "UI Premium and Wage Report", "CT": "UC-2 / UC-5A", "DC": "UC-30", "DE": "UC-8 / UC-8A", "FL": "RT-6",
	"GA": "DOL-4N", "HI": "UC-B6", "IA": "Employer's Contribution and Payroll Report", "ID": "TAX020", "IL": "UI-3/40",
	"IN": "UC-1 / UC-5A", "KS": "K-CNS 100", "KY": "UI-3", "LA": "LWC-77", "MA": "Employment and Wage Detail Report",
	"MD": "Employer's Quarterly Contribution and Employment Report", "ME": "ME UC-1", "MI": "UIA 1028",
	"MN": "Quarterly UI Wage Detail Report", "MO": "MODES-4-7", "MS": "UI-2 / UI-3", "MT": "UI-5", "NC": "NCUI 101",
	"ND": "Quarterly Contribution and Wage Report", "NE": "UI-11T / UI-11W", "NH": "Employer Quarterly Tax and Wage Report",
	"NJ": "NJ-927 / WR-30", "NM": "ES-903A", "NV": "NUCS-4072", "NY": "NYS-45", "OH": "Quarterly Contribution and Wage Detail Report",
	"OK": "OES-3", "OR": "Form OQ", "PA": "UC-2 / UC-2A", "RI": "TX-17", "SC": "UCE-120",
	"SD": "Quarterly Contribution and Wage Report", "TN": "LB-0456 / LB-0851", "TX": "C-3", "UT": "Form 3 / 3H",
	"VA": "FC-20 / FC-21", "VT": "C-101", "WA": "Quarterly Tax and Wage Report", "WI": "UCT-101-E / UC-7823-E",
	"WV": "WVUC-A-154 / WVUC-A-154-A", "WY": "Quarterly Summary Report",
}

// stateReportDue returns the due date of a state's quarterly wage report:
// the last day of the month after the quarter (next business day when it
// falls on a weekend or holiday), except New Jersey, whose NJ-927 / WR-30 are
// due on the 30th day of the month after the quarter with no weekend or
// holiday extension (New Jersey quarterly report instructions).
func stateReportDue(state, quarterEnd string) string {
	// the same rule as the quarterly state unemployment payment (liabilities),
	// including states with their own due day (taxes.StateQuarterlyDue)
	return liabilities.DueDate("state_ui:"+strings.ToUpper(state), model.PayFreqQuarterly, quarterEnd)
}

// reportName returns the short name of a state's quarterly unemployment
// insurance wage report ("DE 9 / DE 9C", "UC-2 / UC-2A", "NYS-45").
func reportName(state string) string {
	if n := uiReports[strings.ToUpper(state)]; n != "" {
		return n
	}
	return "Quarterly Wage and Unemployment Insurance Report"
}

// isoWeeks adds the ISO weeks of every day from start to end to set (at most 400 days).
func isoWeeks(set map[string]bool, start, end string) {
	s, err1 := store.ParseDate(start)
	e, err2 := store.ParseDate(end)
	if err1 != nil || err2 != nil || e.Before(s) {
		return
	}
	for d, n := s, 0; !d.After(e) && n < 400; d, n = d.AddDate(0, 0, 1), n+1 {
		y, w := d.ISOWeek()
		set[fmt.Sprintf("%d-%02d", y, w)] = true
	}
}

// isoWeeksIn returns the number of ISO weeks that have a day in the quarter.
func isoWeeksIn(from, to string) int {
	m := map[string]bool{}
	isoWeeks(m, from, to)
	return len(m)
}

func stateTables(ctx context.Context, q store.Q, year int, state string) (*model.StateTax, string, error) {
	ty, warn, err := taxes.ForCompany(ctx, q, year)
	if err != nil {
		return nil, "", err
	}
	st, ok := ty.States[state]
	if !ok {
		return nil, "", apperr.Validation("state", "SerieX Payroll has no tax tables for the state %q.", state)
	}
	return &st, warn, nil
}

// formStateUI computes the state wage report of a quarter. data = nil uses the saved values.
func formStateUI(ctx context.Context, q store.Q, year, quarter int, state string, reveal bool, data *formData) (*model.TaxForm, error) {
	state = strings.ToUpper(strings.TrimSpace(state))
	st, tyWarn, err := stateTables(ctx, q, year, state)
	if err != nil {
		return nil, err
	}
	from, to := store.QuarterRange(year, quarter)
	period := fmt.Sprintf("Q%d", quarter)
	f, err := loadFiling(ctx, q, "STATE-UI", year, period, state)
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = emptyData()
		if f != nil {
			data = &f.data
		}
	}
	co, err := loadCompany(ctx, q)
	if err != nil {
		return nil, err
	}
	_, uiIDs, err := stateIDs(ctx, q)
	if err != nil {
		return nil, err
	}
	co.StateID = uiIDs[state]
	emps, err := loadEmployees(ctx, q)
	if err != nil {
		return nil, err
	}
	ds, err := loadData(ctx, q, from, to)
	if err != nil {
		return nil, err
	}
	form := &model.TaxForm{Form: "STATE-UI", Year: year, Period: period, State: state,
		Title: fmt.Sprintf("%s %s for Quarter %d, %d", state, reportName(state), quarter, year), Company: co.FormCompany,
		Warnings: []string{}, Extra: map[string]any{"quarterlyReport": st.QuarterlyReport}}
	if tyWarn != "" {
		form.Warnings = append(form.Warnings, tyWarn)
	}
	if co.StateID == "" {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Enter the %s unemployment insurance account number in Company Payroll Information (state settings).", state))
	}

	type prog struct {
		eeWages, ee, erWages, er int64
		hasEE, hasER             bool
		erItemRate               float64
		elsewhere                bool // paid to another agency (e.g. NY DBL/PFL insurer), not with this return
	}
	stateGroup := func(it *model.PayrollItem) bool {
		return it.EffectiveGroup == "state_ui:"+state || it.EffectiveGroup == "state_wh:"+state
	}
	progs := map[string]*prog{}
	var suiEE, suiER, sitTotal int64
	var suiItemRate float64
	rows := map[int64]*suiEmp{}
	for _, c := range ds.checks {
		if c.employeeID == 0 {
			continue
		}
		var mine bool
		for _, l := range c.lines {
			if strings.EqualFold(l.item.State, state) && l.item.TaxCode != "" {
				mine = true
			}
		}
		if !mine {
			continue
		}
		r := rows[c.employeeID]
		if r == nil {
			e := emps[c.employeeID]
			if e == nil {
				continue
			}
			r = &suiEmp{weeks: map[string]bool{}}
			r.row = model.StateWageRow{EmployeeID: e.id, Name: e.name, SSN: ssnOut(e.ssn, reveal)}
			rows[c.employeeID] = r
		}
		var erSubj, erBase, eeSubj, eeBase int64
		var hasER bool
		for _, l := range c.lines {
			it := l.item
			if !strings.EqualFold(it.State, state) {
				continue
			}
			switch it.TaxCode {
			case model.TaxSUIER:
				erSubj += l.subject
				erBase += l.wageBase
				hasER = true
				suiER += l.amount
				if it.Rate > 0 {
					suiItemRate = it.Rate
				}
			case model.TaxSUIEE:
				eeSubj += l.subject
				eeBase += l.wageBase
				suiEE += l.amount
			case model.TaxSIT:
				r.sitWages += l.wageBase
				r.sit += l.amount
				sitTotal += l.amount
			case model.TaxStateEE, model.TaxStateER:
				k := strings.ToUpper(it.TaxKey)
				p := progs[k]
				if p == nil {
					p = &prog{}
					progs[k] = p
				}
				if !stateGroup(it) {
					p.elsewhere = true
				}
				if it.TaxCode == model.TaxStateEE {
					p.eeWages += l.wageBase
					p.ee += l.amount
					p.hasEE = true
				} else {
					p.erWages += l.wageBase
					p.er += l.amount
					p.hasER = true
					if it.Rate > 0 {
						p.erItemRate = it.Rate
					}
				}
			}
		}
		if hasER {
			r.gross += erSubj
			r.taxable += erBase
		} else {
			r.gross += eeSubj
			r.taxable += eeBase
		}
		if !c.adjustment {
			isoWeeks(r.weeks, c.periodStart, c.periodEnd)
		}
	}

	// employees paid for the pay period including the 12th of each month
	var monthCounts [3]int
	for m := 0; m < 3; m++ {
		twelfth := fmt.Sprintf("%04d-%02d-12", year, (quarter-1)*3+m+1)
		ids, err := paidOn(ctx, q, twelfth, state)
		if err != nil {
			return nil, err
		}
		monthCounts[m] = len(ids)
		for id := range ids {
			if r := rows[id]; r != nil {
				r.row.MonthsEmployed[m] = true
			}
		}
	}

	maxWeeks := isoWeeksIn(from, to)
	list := make([]*suiEmp, 0, len(rows))
	var gross, taxable int64
	for _, r := range rows {
		r.row.Gross = store.Dollars(r.gross)
		r.row.SUIWages = store.Dollars(r.taxable)
		r.row.ExcessWages = store.Dollars(r.gross - r.taxable)
		r.row.SITWages = store.Dollars(r.sitWages)
		r.row.SITWithheld = store.Dollars(r.sit)
		r.row.WeeksWorked = len(r.weeks)
		if r.row.WeeksWorked > maxWeeks {
			r.row.WeeksWorked = maxWeeks
		}
		gross += r.gross
		taxable += r.taxable
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := emps[list[i].row.EmployeeID], emps[list[j].row.EmployeeID]
		if !strings.EqualFold(a.last, b.last) {
			return strings.ToLower(a.last) < strings.ToLower(b.last)
		}
		if !strings.EqualFold(a.first, b.first) {
			return strings.ToLower(a.first) < strings.ToLower(b.first)
		}
		return a.id < b.id
	})
	out := make([]model.StateWageRow, len(list))
	for i, r := range list {
		out[i] = r.row
	}
	form.Extra["employees"] = out

	rate := suiItemRate
	if rate == 0 {
		rate = taxes.SUIRate(ctx, q, st, year)
	}
	payments, err := paymentsByGroup(ctx, q, ds.items, from, to, "state_ui:"+state, "state_wh:"+state)
	if err != nil {
		return nil, err
	}

	b := newBuilder(data)
	b.section = "Report"
	b.check("A", "", "No wages paid this quarter", len(rows) == 0, true)
	b.check("B", "", "Out of business / no employees", false, true)
	b.text("B", "date", "Date out of business", "", true)
	for m := 0; m < 3; m++ {
		b.count("1", fmt.Sprintf("m%d", m+1), fmt.Sprintf("Number of employees who worked during or received pay for the pay period including the 12th of month %d", m+1), monthCounts[m], true)
	}
	b.section = "Unemployment Insurance"
	b.money("C", "", "Total subject wages paid this quarter", gross, true)
	eD := b.money("D", "", fmt.Sprintf("Unemployment insurance taxable wages (up to %s per employee per calendar year)", money(store.Cents(st.SUI.WageBase))), taxable, true)
	eRate := b.number("D", "rate", "Unemployment insurance rate (%) — a rate changed here applies to this form only", rate, true)
	uiTax := b.money("D", "tax", "Unemployment insurance contributions (taxable wages × rate)", pctOf(eD, eRate), false)
	subtotal := uiTax
	if st.SUI.EmployeeRate > 0 || suiEE != 0 {
		subtotal += b.money("D", "employee", "Employee unemployment insurance withheld", suiEE, true)
	}
	b.section = "Other State Taxes"
	var progRows []map[string]any
	for _, p := range st.Programs {
		k := strings.ToUpper(p.Key)
		v := progs[k]
		if v == nil {
			continue
		}
		label := p.Name
		if !strings.Contains(label, p.Key) {
			label += " (" + p.Key + ")"
		}
		row := map[string]any{"key": p.Key, "name": p.Name}
		if v.elsewhere {
			// collected for another agency (an insurer): not reported or paid with this return
			row["paidElsewhere"] = true
			if v.hasER {
				row["employerWages"], row["employer"] = store.Dollars(v.erWages), store.Dollars(v.er)
			}
			if v.hasEE {
				row["employeeWages"], row["employee"] = store.Dollars(v.eeWages), store.Dollars(v.ee)
			}
			progRows = append(progRows, row)
			continue
		}
		if v.hasER {
			erRate := v.erItemRate
			if erRate == 0 {
				erRate = taxes.ProgramRate(ctx, q, st, year, p.Key, true)
			}
			w := b.money(k, "wages", label+": taxable wages", v.erWages, true)
			r := b.number(k, "rate", label+": rate (%)", erRate, true)
			t := b.money(k, "tax", label+": contributions (wages × rate)", pctOf(w, r), false)
			subtotal += t
			row["employerWages"], row["employerRate"], row["employer"] = store.Dollars(w), r, store.Dollars(t)
			if t != v.er {
				form.Warnings = append(form.Warnings, fmt.Sprintf("%s: the report computes %s; the paychecks accrued %s.", label, money(t), money(v.er)))
			}
		}
		if v.hasEE {
			b.money(k, "eewages", label+": employee wages", v.eeWages, true)
			t := b.money(k, "employee", label+": withheld from employees", v.ee, true)
			subtotal += t
			row["employeeWages"], row["employee"] = store.Dollars(v.eeWages), store.Dollars(t)
		}
		progRows = append(progRows, row)
	}
	if progRows == nil {
		progRows = []map[string]any{}
	}
	form.Extra["programs"] = progRows
	b.section = "Totals"
	if st.Income.Has || sitTotal != 0 {
		subtotal += b.money("G", "", "State income tax withheld", sitTotal, true)
	}
	h := b.money("H", "", "Subtotal (unemployment insurance, other state taxes and income tax withheld)", subtotal, false)
	i := b.money("I", "", "Less: contributions and withholdings paid for the quarter", payments, true)
	b.money("J", "", "Total taxes due or overpaid (H – I)", h-i, false)
	b.text("sign", "name", "Signature: name", co.ContactName, true)
	b.text("sign", "title", "Title", co.title, true)
	b.text("sign", "phone", "Phone", co.ContactPhone, true)
	b.text("sign", "date", "Date", "", true)

	if uiTax != suiER && eRate == rate && eD == taxable {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Unemployment insurance: the report computes %s (taxable wages × rate); the paychecks accrued %s (rounded per paycheck).", money(uiTax), money(suiER)))
	}
	form.Extra["suiRate"] = rate
	form.Extra["suiWageBase"] = st.SUI.WageBase
	form.Extra["accruedUI"] = store.Dollars(suiER)
	form.Lines = b.lines
	form.Status, form.FiledAt = formStatus(f)
	form.DueDate = stateReportDue(state, to)
	form.Warnings = append(form.Warnings, filedWarning(f, form.Lines, "an amended state report")...)
	return form, nil
}

// paidOn returns the employees with a non-voided paycheck taxed by the state
// (unemployment or withholding) whose pay period includes date.
func paidOn(ctx context.Context, q store.Q, date, state string) (map[int64]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT p.employee_id FROM paychecks p
		WHERE p.voided = 0 AND p.gross <> 0 AND p.period_start <= ? AND p.period_end >= ?
		AND EXISTS (SELECT 1 FROM paycheck_lines l JOIN payroll_items i ON i.id = l.item_id
			WHERE l.paycheck_id = p.id AND i.state = ? COLLATE NOCASE AND i.tax_code IN ('SUI_ER', 'SUI_EE', 'SIT'))`, date, date, state)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// routes

func stateUIParams(c *httpx.Ctx) (year, quarter int, state string, err error) {
	if year, err = parseYear(c); err != nil {
		return
	}
	if quarter, err = parseQuarter(c); err != nil {
		return
	}
	state = strings.ToUpper(strings.TrimSpace(c.Q("state")))
	if len(state) != 2 {
		err = apperr.Validation("state", "Choose the state of the report.")
	}
	return
}

// revealAllowed checks the reveal=1 parameter: administrators only, audited.
func revealAllowed(c *httpx.Ctx, what string) (bool, error) {
	if !c.QBool("reveal") {
		return false, nil
	}
	if c.Assistant {
		return false, apperr.Forbidden("AI assistants cannot see full social security numbers.")
	}
	if !c.IsAdmin {
		return false, apperr.Forbidden("Only a SerieX Books administrator can see full social security numbers.")
	}
	err := c.Write(func(tx *sql.Tx) error {
		return store.Audit(c.Context(), tx, c.User, "view_ssn", "form", 0, what+" with full social security numbers", nil)
	})
	return true, err
}

func getStateUI(c *httpx.Ctx) error {
	year, quarter, state, err := stateUIParams(c)
	if err != nil {
		return err
	}
	if c.QBool("snapshot") {
		return snapshotRoute(c, "STATE-UI", year, fmt.Sprintf("Q%d", quarter), state)
	}
	reveal, err := revealAllowed(c, fmt.Sprintf("%s state wage report Q%d %d", state, quarter, year))
	if err != nil {
		return err
	}
	form, err := formStateUI(c.Context(), c.DB, year, quarter, state, reveal, nil)
	if err != nil {
		return err
	}
	return c.JSON(form)
}

func putStateUI(c *httpx.Ctx) error {
	year, quarter, state, err := stateUIParams(c)
	if err != nil {
		return err
	}
	var req model.SaveFormRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	compute := func(d *formData) (*model.TaxForm, error) {
		return formStateUI(c.Context(), c.DB, year, quarter, state, false, d)
	}
	return saveTaxForm(c, "STATE-UI", year, fmt.Sprintf("Q%d", quarter), state, &req, compute)
}

func stateUICSV(c *httpx.Ctx) error {
	year, quarter, state, err := stateUIParams(c)
	if err != nil {
		return err
	}
	reveal, err := revealAllowed(c, fmt.Sprintf("%s state wage report CSV Q%d %d", state, quarter, year))
	if err != nil {
		return err
	}
	form, err := formStateUI(c.Context(), c.DB, year, quarter, state, reveal, nil)
	if err != nil {
		return err
	}
	emps, err := loadEmployees(c.Context(), c.DB)
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	cw := csv.NewWriter(&buf)
	// write neutralizes the data cells so a spreadsheet does not run them as formulas
	write := func(cells []string) {
		for i := range cells {
			cells[i] = csvSafe(cells[i])
		}
		cw.Write(cells)
	}
	cw.Write([]string{"Employee", "SSN", "First Name", "Middle Initial", "Last Name", "Total Subject Wages", "UI Taxable Wages",
		"Excess Wages", "State Income Tax Wages", "State Income Tax Withheld", "Weeks Worked", "Month 1", "Month 2", "Month 3"})
	yn := func(b bool) string {
		if b {
			return "Y"
		}
		return "N"
	}
	amt := func(v float64) string { return fmt.Sprintf("%.2f", v) }
	var tg, tt, te, tsw, ts float64
	for _, r := range form.Extra["employees"].([]model.StateWageRow) {
		first, mi, last := "", "", r.Name
		if e := emps[r.EmployeeID]; e != nil {
			first, mi, last = e.first, middleInitial(e.middle), e.last
		}
		write([]string{r.Name, r.SSN, first, mi, last, amt(r.Gross), amt(r.SUIWages), amt(r.ExcessWages), amt(r.SITWages),
			amt(r.SITWithheld), fmt.Sprint(r.WeeksWorked), yn(r.MonthsEmployed[0]), yn(r.MonthsEmployed[1]), yn(r.MonthsEmployed[2])})
		tg += r.Gross
		tt += r.SUIWages
		te += r.ExcessWages
		tsw += r.SITWages
		ts += r.SITWithheld
	}
	write([]string{"TOTAL", "", "", "", "", amt(store.Round2(tg)), amt(store.Round2(tt)), amt(store.Round2(te)), amt(store.Round2(tsw)), amt(store.Round2(ts)), "", "", "", ""})
	cw.Flush()
	if err := cw.Error(); err != nil {
		return err
	}
	c.W.Header().Set("Content-Type", "text/csv; charset=utf-8")
	c.W.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s-wage-report-%d-Q%d.csv"`, state, year, quarter))
	c.W.Header().Set("Cache-Control", "no-store")
	_, err = c.W.Write(buf.Bytes())
	return err
}

// csvSafe keeps a text cell from being run as a formula by spreadsheet
// programs: text starting with = + - @ or a tab / carriage return gets a
// leading apostrophe. Numbers ("-45.00", "+1") are left as they are.
// (Same rule as the SerieX Books list export.)
func csvSafe(v string) string {
	if v == "" {
		return v
	}
	switch v[0] {
	case '=', '+', '-', '@', '\t', '\r':
		if _, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", ""), 64); err == nil && v[0] != '=' && v[0] != '@' {
			return v
		}
		return "'" + v
	}
	return v
}
