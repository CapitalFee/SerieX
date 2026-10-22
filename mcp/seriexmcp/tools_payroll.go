package seriexmcp

import (
	"context"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

// Payroll reports that print social security numbers. SerieX Payroll masks
// them for AI assistants (X-Books-Session); as a second safeguard these
// reports are run only while Payroll masks the numbers on reports, every
// column of social security or tax ID numbers is left out, and anything
// written like a full social security number is masked.
var ssnReports = map[string]bool{"employee_contact_list": true, "employee_withholding": true, "employee_state_taxes_detail": true}

// findEmployee finds an employee by display name or employee number.
func findEmployee(bk *call, input string) (*employee, error) {
	var all []employee
	if err := bk.payroll("/employees", url.Values{"active": {"all"}}, &all); err != nil {
		return nil, err
	}
	n := norm(input)
	e, err := pick("employee", input, all, func(e employee) string { return e.DisplayName },
		func(e employee) bool { return norm(e.DisplayName) == n },
		func(e employee) bool { return e.EmployeeNumber != "" && norm(e.EmployeeNumber) == n },
		func(e employee) bool { return idOf(input) != 0 && e.ID == idOf(input) })
	if err != nil {
		return nil, err
	}
	return &e, nil
}

func (s *service) payrollTools() []toolDef {
	var defs []toolDef

	type employeesIn struct {
		companyArg
		Search string `json:"search,omitempty" jsonschema:"Only employees whose name, number, email, phone or city contains this text."`
		Status string `json:"status,omitempty" jsonschema:"active (default), inactive or all."`
	}
	defs = append(defs, def(s, groupPayroll, readTool, "list_employees", "List employees",
		"List the employees in SerieX Payroll with pay schedule, work state, pay rate, gross pay this year and last paycheck date. Social security numbers, birth dates and bank details are never shown.",
		func(sc *jsonschema.Schema) { enum(sc, "status", "active", "inactive", "all") },
		func(ctx context.Context, in employeesIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			q := url.Values{"active": {statusParam(in.Status)}}
			if v := strings.TrimSpace(in.Search); v != "" {
				q.Set("q", v)
			}
			var list []employee
			if err := bk.payroll("/employees", q, &list); err != nil {
				return "", err
			}
			if len(list) == 0 {
				return "No employees match.", nil
			}
			t := newTable("Employee", "Number", "Hired", "Pay schedule", "Work state", ">Pay rate", ">Gross this year", "Last paycheck", "Status", ">Id")
			for i, e := range list {
				if i == 300 {
					t.add(fmt.Sprintf("… %d more not shown (use search)", len(list)-300))
					break
				}
				rate := ""
				switch {
				case e.AnnualSalary > 0:
					rate = money(e.AnnualSalary) + "/year"
				case e.HourlyRate > 0:
					rate = money(e.HourlyRate) + "/hour"
				}
				st := "active"
				if !e.Active {
					st = "inactive"
				}
				if e.ReleaseDate != "" {
					st += ", released " + e.ReleaseDate
				}
				t.add(e.DisplayName, e.EmployeeNumber, e.HireDate, orStr(e.PayScheduleName, e.PayFrequency), e.WorkState, rate, money(e.YTDGross), e.LastCheckDate, st, fmt.Sprint(e.ID))
			}
			return fmt.Sprintf("Employees of %s: %d.\n\n%s", bk.co.Name, len(list), t), nil
		}))

	type paychecksIn struct {
		companyArg
		From          string `json:"from,omitempty" jsonschema:"First check date (YYYY-MM-DD or today). Default: January 1 of this year."`
		To            string `json:"to,omitempty" jsonschema:"Last check date (YYYY-MM-DD or today). Default: today."`
		Employee      string `json:"employee,omitempty" jsonschema:"Only this employee (name or number as listed by list_employees)."`
		IncludeVoided bool   `json:"include_voided,omitempty" jsonschema:"Also list voided paychecks."`
		MaxRows       int    `json:"max_rows,omitempty" jsonschema:"Most paychecks to list, newest first (default 50, at most 500); the totals cover all of them."`
	}
	defs = append(defs, def(s, groupPayroll, readTool, "list_paychecks", "List paychecks",
		"List the paychecks of a period (newest first) with hours, gross pay, employee taxes, deductions, net pay and employer taxes, with totals.",
		nil, func(ctx context.Context, in paychecksIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			from, err := parseDate("from", in.From)
			if err != nil {
				return "", err
			}
			to, err := parseDate("to", in.To)
			if err != nil {
				return "", err
			}
			if from == "" {
				from = today()[:4] + "-01-01"
			}
			if to == "" {
				to = today()
			}
			q := url.Values{"from": {from}, "to": {to}}
			if in.IncludeVoided {
				q.Set("includeVoided", "1")
			}
			if in.Employee != "" {
				e, err := findEmployee(bk, in.Employee)
				if err != nil {
					return "", err
				}
				q.Set("employeeId", fmt.Sprint(e.ID))
			}
			var list []paycheckSummary
			if err := bk.payroll("/paychecks", q, &list); err != nil {
				return "", err
			}
			if len(list) == 0 {
				return fmt.Sprintf("No paychecks dated %s to %s.", from, to), nil
			}
			sort.SliceStable(list, func(i, j int) bool { // newest first
				if list[i].CheckDate != list[j].CheckDate {
					return list[i].CheckDate > list[j].CheckDate
				}
				return list[i].ID > list[j].ID
			})
			maxRows := clamp(in.MaxRows, 50, 1, 500)
			t := newTable("Check date", "Employee", "Check #", "Period", ">Hours", ">Gross", ">Employee taxes", ">Deductions", ">Net", ">Employer taxes", "Notes")
			var hrs, gross, etax, ded, net, ertax float64
			for i, p := range list {
				if !p.Voided {
					hrs += p.TotalHours
					gross += p.Gross
					etax += p.EmployeeTaxes
					ded += p.Deductions
					net += p.Net
					ertax += p.EmployerTaxes
				}
				if i >= maxRows {
					continue
				}
				var notes []string
				if p.Voided {
					notes = append(notes, "voided")
				}
				if p.Kind == "ytd" {
					notes = append(notes, "year-to-date amounts entered at setup")
				}
				if p.DirectDeposit {
					notes = append(notes, "direct deposit")
				}
				switch p.SyncStatus {
				case "pending":
					notes = append(notes, "not in SerieX Books yet")
				case "error":
					notes = append(notes, "could not be recorded in SerieX Books")
				}
				t.add(p.CheckDate, p.EmployeeName, p.CheckNumber, p.PeriodStart+" to "+p.PeriodEnd, qty(p.TotalHours), money(p.Gross), money(p.EmployeeTaxes), money(p.Deductions), money(p.Net), money(p.EmployerTaxes), strings.Join(notes, ", "))
			}
			if len(list) > maxRows {
				t.add(fmt.Sprintf("… %d more not shown", len(list)-maxRows))
			}
			t.add("**Total**", "", "", "", qty(hrs), money(gross), money(etax), money(ded), money(net), money(ertax), "voided not counted")
			return fmt.Sprintf("Paychecks of %s dated %s to %s: %d.\n\n%s", bk.co.Name, from, to, len(list), t), nil
		}))

	type taxesDueIn struct {
		companyArg
		From     string `json:"from,omitempty" jsonschema:"Only liabilities for periods ending on or after this date (YYYY-MM-DD or today)."`
		To       string `json:"to,omitempty" jsonschema:"Only liabilities for periods starting on or before this date (YYYY-MM-DD or today)."`
		ShowPaid bool   `json:"show_paid,omitempty" jsonschema:"Also list periods already paid."`
	}
	defs = append(defs, def(s, groupPayroll, readTool, "payroll_taxes_due", "Payroll taxes due",
		"List the payroll taxes and other payroll liabilities to pay, with due dates, status (overdue, due, upcoming) and amounts.",
		nil, func(ctx context.Context, in taxesDueIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			q := url.Values{}
			for _, d := range []struct{ field, val string }{{"from", in.From}, {"to", in.To}} {
				v, err := parseDate(d.field, d.val)
				if err != nil {
					return "", err
				}
				if v != "" {
					q.Set(d.field, v)
				}
			}
			if in.ShowPaid {
				q.Set("showPaid", "1")
			}
			var list []liabilityDue
			if err := bk.payroll("/liabilities/due", q, &list); err != nil {
				return "", err
			}
			if len(list) == 0 {
				return "No payroll liabilities are due.", nil
			}
			var total float64
			t := newTable("Due date", "Status", "Liability", "Pay to", "Period", "How", ">Amount due")
			for i, l := range list {
				if l.Status != "Paid" {
					total += l.AmountDue
				}
				if i == 200 {
					t.add(fmt.Sprintf("… %d more not shown (narrow the dates)", len(list)-200))
					continue
				}
				if i > 200 {
					continue
				}
				t.add(l.DueDate, l.Status, l.Label, l.AgencyName, l.PeriodStart+" to "+l.PeriodEnd, l.Method, money(l.AmountDue))
			}
			return fmt.Sprintf("Payroll liabilities of %s: %d, %s still to pay.\n\n%s", bk.co.Name, len(list), money(total), t), nil
		}))

	type payrollReportIn struct {
		companyArg
		Key           string `json:"key,omitempty" jsonschema:"Report key, for example payroll_summary, payroll_register, payroll_liability_balances, employee_earnings_summary. Leave empty to list the payroll reports."`
		Dates         string `json:"dates,omitempty" jsonschema:"Date preset. Ignored when from or to is given. Default: the report's own default."`
		From          string `json:"from,omitempty" jsonschema:"First date (YYYY-MM-DD or today)."`
		To            string `json:"to,omitempty" jsonschema:"Last date (YYYY-MM-DD or today)."`
		AsOf          string `json:"as_of,omitempty" jsonschema:"For reports as of one date (YYYY-MM-DD or today)."`
		Employee      string `json:"employee,omitempty" jsonschema:"Only this employee."`
		Year          int    `json:"year,omitempty" jsonschema:"Tax form worksheets: the year."`
		Quarter       int    `json:"quarter,omitempty" jsonschema:"Form 941 worksheet: the quarter (1 to 4)."`
		State         string `json:"state,omitempty" jsonschema:"State reports: two-letter state code."`
		IncludeVoided bool   `json:"include_voided,omitempty" jsonschema:"Detail reports: also show voided paychecks."`
		Status        string `json:"status,omitempty" jsonschema:"Employee lists: active (default), inactive or all."`
		Columns       string `json:"columns,omitempty" jsonschema:"Reports with columns: total (default), month, quarter, year or employee."`
		MaxRows       int    `json:"max_rows,omitempty" jsonschema:"Most rows to show (default 200, at most 500); subtotals and totals are always shown."`
	}
	defs = append(defs, def(s, groupPayroll, readTool, "payroll_report", "Payroll report",
		"Run a SerieX Payroll report (payroll summary, payroll register, liability balances, earnings, paid time off, tax form worksheets...) as a table with its totals. Leave key empty to list the reports.",
		func(sc *jsonschema.Schema) {
			enum(sc, "dates", datePresets...)
			enum(sc, "status", "active", "inactive", "all")
			enum(sc, "columns", "total", "month", "quarter", "year", "employee")
		},
		func(ctx context.Context, in payrollReportIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			var cat []reportInfo
			if err := bk.payroll("/reports", nil, &cat); err != nil {
				return "", err
			}
			key := strings.TrimSpace(in.Key)
			if key == "" {
				var b strings.Builder
				cur := ""
				for _, r := range cat {
					if r.Category != cur {
						cur = r.Category
						fmt.Fprintf(&b, "\n**%s**\n", cur)
					}
					fmt.Fprintf(&b, "- `%s` — %s: %s\n", r.Key, r.Title, short(r.Description, 140))
				}
				return fmt.Sprintf("Payroll reports of %s:\n%s\nRun one with payroll_report and its key.\n", bk.co.Name, b.String()), nil
			}
			var info *reportInfo
			for i := range cat {
				if strings.EqualFold(cat[i].Key, key) || strings.EqualFold(cat[i].Title, key) {
					info = &cat[i]
					break
				}
			}
			if info == nil {
				return "", userErr("There is no payroll report %q. Leave key empty to list the payroll reports.", key)
			}
			if ssnReports[info.Key] {
				var p struct {
					ShowSSN bool `json:"showSsnOnReports"`
				}
				if err := bk.payroll("/prefs", nil, &p); err != nil {
					return "", err
				}
				if p.ShowSSN {
					return "", userErr("The %s report shows full social security numbers in this company file, so it is not available to AI assistants. The user can open it in SerieX Payroll.", info.Title)
				}
			}
			q := url.Values{}
			from, err := parseDate("from", in.From)
			if err != nil {
				return "", err
			}
			to, err := parseDate("to", in.To)
			if err != nil {
				return "", err
			}
			asOf, err := parseDate("as_of", in.AsOf)
			if err != nil {
				return "", err
			}
			if from != "" || to != "" {
				q.Set("from", from)
				if to != "" {
					q.Set("to", to)
				}
			} else if in.Dates != "" {
				q.Set("dates", in.Dates)
			}
			if asOf != "" {
				q.Set("asOf", asOf)
			}
			if in.Employee != "" {
				e, err := findEmployee(bk, in.Employee)
				if err != nil {
					return "", err
				}
				q.Set("employeeId", fmt.Sprint(e.ID))
			}
			if in.Year > 0 {
				q.Set("year", fmt.Sprint(in.Year))
			}
			if in.Quarter > 0 {
				q.Set("quarter", fmt.Sprint(in.Quarter))
			}
			if st := strings.TrimSpace(in.State); st != "" {
				q.Set("state", strings.ToUpper(st))
			}
			if in.IncludeVoided {
				q.Set("includeVoided", "1")
			}
			if in.Status != "" {
				q.Set("active", in.Status)
			}
			if in.Columns != "" {
				q.Set("columns", in.Columns)
			}
			var res reportResult
			if err := bk.payroll("/reports/"+url.PathEscape(info.Key), q, &res); err != nil {
				return "", err
			}
			dropColumn(&res, "ssn")
			dropSensitiveColumns(&res)
			return renderReport(&res, clamp(in.MaxRows, 200, 1, maxReportRows)), nil
		}))
	return defs
}

// dropColumn removes a column (and its cells) from a report.
func dropColumn(r *reportResult, key string) {
	cols := r.Columns[:0]
	for _, c := range r.Columns {
		if c.Key != key {
			cols = append(cols, c)
		}
	}
	r.Columns = cols
	for i := range r.Rows {
		delete(r.Rows[i].Cells, key)
	}
}
