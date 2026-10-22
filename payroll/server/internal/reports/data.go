package reports

import (
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// ---------------------------------------------------------------------------
// Payroll records loaded for a report (money in cents)

type pcLine struct {
	ID       int64
	ItemID   int64
	Category string
	Rate     *float64
	Qty      *float64
	Amount   int64
	WageBase int64
	Subject  int64
	Computed int64
	Job      *int64
	Class    *int64
	Manual   bool
}

type paycheck struct {
	ID            int64
	RunID         *int64
	Kind          string
	EmployeeID    int64
	EmployeeName  string
	PeriodStart   string
	PeriodEnd     string
	CheckDate     string
	BankAccountID *int64
	CheckNumber   string
	ToBePrinted   bool
	DirectDeposit bool
	Memo          string
	ClassID       *int64
	Gross         int64
	NotPaid       int64
	Deductions    int64
	EmployeeTaxes int64
	Net           int64
	EmployerTaxes int64
	Contributions int64
	TotalHours    float64
	Voided        bool
	BooksTxnID    *int64
	SyncStatus    string
	Lines         []pcLine
}

type adjLine struct {
	ItemID   int64
	Amount   int64
	WageBase int64
	Memo     string
}

type adjustment struct {
	ID              int64
	Date            string
	EffectiveDate   string
	EmployeeID      int64 // 0 = company adjustment
	EmployeeName    string
	Memo            string
	AffectsAccounts bool
	ClassID         *int64
	BooksTxnID      *int64
	SyncStatus      string
	Lines           []adjLine
}

type payLine struct {
	Kind      string // item | expense
	ItemID    int64
	AccountID *int64
	Amount    int64
	Memo      string
}

type payment struct {
	ID             int64
	Kind           string // payment | prior
	Date           string
	PeriodStart    string
	PeriodEnd      string
	AgencyVendorID *int64
	AgencyName     string // cached Books vendor name
	BankAccountID  *int64
	CheckNumber    string
	ToBePrinted    bool
	Method         string
	Memo           string
	Amount         int64
	Voided         bool
	BooksTxnID     *int64
	SyncStatus     string
	Lines          []payLine
}

// pcFilter selects paychecks by check date.
type pcFilter struct {
	from, to      string
	employeeID    int64
	includeVoided bool
	kind          string // "" = regular and ytd
}

func (e *env) paychecks(f pcFilter) ([]*paycheck, error) {
	where := []string{"p.check_date <= ?"}
	args := []any{f.to}
	if f.from != "" {
		where = append(where, "p.check_date >= ?")
		args = append(args, f.from)
	}
	if f.employeeID > 0 {
		where = append(where, "p.employee_id = ?")
		args = append(args, f.employeeID)
	}
	if !f.includeVoided {
		where = append(where, "p.voided = 0")
	}
	if f.kind != "" {
		where = append(where, "p.kind = ?")
		args = append(args, f.kind)
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT p.id, p.run_id, p.kind, p.employee_id, e.display_name, p.period_start, p.period_end,
		p.check_date, p.bank_account_id, p.check_number, p.to_be_printed, p.direct_deposit, p.memo, p.class_id, p.gross, p.not_paid,
		p.deductions, p.employee_taxes, p.net, p.employer_taxes, p.contributions, p.total_hours, p.voided, p.books_txn_id, p.sync_status
		FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE `+strings.Join(where, " AND ")+`
		ORDER BY p.check_date, p.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*paycheck
	byID := map[int64]*paycheck{}
	for rows.Next() {
		p := &paycheck{}
		var run, bank, class, txn sql.NullInt64
		if err := rows.Scan(&p.ID, &run, &p.Kind, &p.EmployeeID, &p.EmployeeName, &p.PeriodStart, &p.PeriodEnd, &p.CheckDate,
			&bank, &p.CheckNumber, &p.ToBePrinted, &p.DirectDeposit, &p.Memo, &class, &p.Gross, &p.NotPaid, &p.Deductions,
			&p.EmployeeTaxes, &p.Net, &p.EmployerTaxes, &p.Contributions, &p.TotalHours, &p.Voided, &txn, &p.SyncStatus); err != nil {
			return nil, err
		}
		p.RunID, p.BankAccountID, p.ClassID, p.BooksTxnID = store.PtrID(run), store.PtrID(bank), store.PtrID(class), store.PtrID(txn)
		out = append(out, p)
		byID[p.ID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}
	// lines of the selected paychecks (same filter, joined)
	lrows, err := e.q.QueryContext(e.ctx, `SELECT l.paycheck_id, l.id, l.item_id, l.category, l.rate, l.qty, l.amount, l.wage_base,
		l.subject_wages, l.computed, l.job_name_id, l.class_id, l.manual
		FROM paycheck_lines l JOIN paychecks p ON p.id = l.paycheck_id WHERE `+strings.Join(where, " AND ")+`
		ORDER BY l.paycheck_id, l.seq, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var pid int64
		var l pcLine
		var rate, qty sql.NullFloat64
		var job, class sql.NullInt64
		if err := lrows.Scan(&pid, &l.ID, &l.ItemID, &l.Category, &rate, &qty, &l.Amount, &l.WageBase, &l.Subject, &l.Computed,
			&job, &class, &l.Manual); err != nil {
			return nil, err
		}
		if rate.Valid {
			v := rate.Float64
			l.Rate = &v
		}
		if qty.Valid {
			v := qty.Float64
			l.Qty = &v
		}
		l.Job, l.Class = store.PtrID(job), store.PtrID(class)
		if p := byID[pid]; p != nil {
			p.Lines = append(p.Lines, l)
		}
	}
	return out, lrows.Err()
}

// adjustments returns the liability adjustments whose date (byEffective:
// effective date) is in [from, to]. employeeID > 0 keeps that employee's only.
func (e *env) adjustments(from, to string, byEffective bool, employeeID int64) ([]*adjustment, error) {
	col := "a.date"
	if byEffective {
		col = "a.effective_date"
	}
	where := []string{col + " <= ?"}
	args := []any{to}
	if from != "" {
		where = append(where, col+" >= ?")
		args = append(args, from)
	}
	if employeeID > 0 {
		where = append(where, "a.employee_id = ?")
		args = append(args, employeeID)
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT a.id, a.date, a.effective_date, IFNULL(a.employee_id, 0), IFNULL(e.display_name, ''),
		a.memo, a.affects_accounts, a.class_id, a.books_txn_id, a.sync_status
		FROM liability_adjustments a LEFT JOIN employees e ON e.id = a.employee_id WHERE `+strings.Join(where, " AND ")+`
		ORDER BY `+col+`, a.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*adjustment
	byID := map[int64]*adjustment{}
	for rows.Next() {
		a := &adjustment{}
		var class, txn sql.NullInt64
		if err := rows.Scan(&a.ID, &a.Date, &a.EffectiveDate, &a.EmployeeID, &a.EmployeeName, &a.Memo, &a.AffectsAccounts,
			&class, &txn, &a.SyncStatus); err != nil {
			return nil, err
		}
		a.ClassID, a.BooksTxnID = store.PtrID(class), store.PtrID(txn)
		out = append(out, a)
		byID[a.ID] = a
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}
	lrows, err := e.q.QueryContext(e.ctx, `SELECT l.adjustment_id, l.item_id, l.amount, l.wage_base, l.memo
		FROM liability_adjustment_lines l JOIN liability_adjustments a ON a.id = l.adjustment_id
		WHERE `+strings.Join(where, " AND ")+` ORDER BY l.adjustment_id, l.seq, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var aid int64
		var l adjLine
		if err := lrows.Scan(&aid, &l.ItemID, &l.Amount, &l.WageBase, &l.Memo); err != nil {
			return nil, err
		}
		if a := byID[aid]; a != nil {
			a.Lines = append(a.Lines, l)
		}
	}
	return out, lrows.Err()
}

// payments returns the liability payments (kinds payment and prior) whose
// date (byPeriodEnd: period end) is in [from, to].
func (e *env) payments(from, to string, byPeriodEnd, includeVoided bool) ([]*payment, error) {
	col := "p.date"
	if byPeriodEnd {
		col = "p.period_end"
	}
	where := []string{col + " <= ?"}
	args := []any{to}
	if from != "" {
		where = append(where, col+" >= ?")
		args = append(args, from)
	}
	if !includeVoided {
		where = append(where, "p.voided = 0")
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT p.id, p.kind, p.date, p.period_start, p.period_end, p.agency_vendor_id, p.agency_name,
		p.bank_account_id, p.check_number, p.to_be_printed, p.method, p.memo, p.amount, p.voided, p.books_txn_id, p.sync_status
		FROM liability_payments p WHERE `+strings.Join(where, " AND ")+` ORDER BY `+col+`, p.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*payment
	byID := map[int64]*payment{}
	for rows.Next() {
		p := &payment{}
		var agency, bank, txn sql.NullInt64
		if err := rows.Scan(&p.ID, &p.Kind, &p.Date, &p.PeriodStart, &p.PeriodEnd, &agency, &p.AgencyName, &bank, &p.CheckNumber,
			&p.ToBePrinted, &p.Method, &p.Memo, &p.Amount, &p.Voided, &txn, &p.SyncStatus); err != nil {
			return nil, err
		}
		p.AgencyVendorID, p.BankAccountID, p.BooksTxnID = store.PtrID(agency), store.PtrID(bank), store.PtrID(txn)
		out = append(out, p)
		byID[p.ID] = p
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}
	lrows, err := e.q.QueryContext(e.ctx, `SELECT l.payment_id, l.kind, IFNULL(l.item_id, 0), l.account_id, l.amount, l.memo
		FROM liability_payment_lines l JOIN liability_payments p ON p.id = l.payment_id
		WHERE `+strings.Join(where, " AND ")+` ORDER BY l.payment_id, l.seq, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var pid int64
		var l payLine
		var acct sql.NullInt64
		if err := lrows.Scan(&pid, &l.Kind, &l.ItemID, &acct, &l.Amount, &l.Memo); err != nil {
			return nil, err
		}
		l.AccountID = store.PtrID(acct)
		if p := byID[pid]; p != nil {
			p.Lines = append(p.Lines, l)
		}
	}
	return out, lrows.Err()
}

// periodsFrom is the first day of the period columns of a report: the From
// date, or for "All" dates the first day of the month of the oldest payroll
// record (so the period columns add up to the TOTAL / BALANCE column).
func (e *env) periodsFrom() string {
	if e.p.From != "" {
		return e.p.From
	}
	var first string
	e.q.QueryRowContext(e.ctx, `SELECT MIN(d) FROM (
		SELECT MIN(check_date) AS d FROM paychecks
		UNION ALL SELECT MIN(effective_date) FROM liability_adjustments
		UNION ALL SELECT MIN(period_end) FROM liability_payments) WHERE d IS NOT NULL`).Scan(&first)
	if first == "" || first > e.p.To {
		return ""
	}
	return first[:8] + "01"
}

// ---------------------------------------------------------------------------
// Payroll items

// allItems loads every payroll item (items.All); unknown ids get a placeholder.
type itemSet map[int64]*model.PayrollItem

func (e *env) items() (itemSet, error) {
	m, err := items.All(e.ctx, e.q)
	if err != nil {
		return nil, err
	}
	return itemSet(m), nil
}

func (s itemSet) get(id int64) *model.PayrollItem {
	if it := s[id]; it != nil {
		return it
	}
	it := &model.PayrollItem{ID: id, Name: "Payroll item #" + strconv.FormatInt(id, 10), Taxability: map[string]bool{}}
	s[id] = it
	return it
}

var typeRank = func() map[string]int {
	m := map[string]int{}
	for i, t := range model.ItemTypeOrder {
		m[t] = i
	}
	return m
}()

var taxRank = map[string]int{
	model.TaxFIT: 0, model.TaxSSEE: 1, model.TaxSSER: 2, model.TaxMedEE: 3, model.TaxMedER: 4, model.TaxAddlMed: 5,
	model.TaxFUTA: 6, model.TaxSIT: 7, model.TaxSUIEE: 8, model.TaxSUIER: 9, model.TaxStateEE: 10, model.TaxStateER: 11,
	model.TaxLocalEE: 12, model.TaxLocalER: 13,
}

// lessItem orders items like the Payroll Items window (type, then tax code and
// state for tax items, then name).
func lessItem(a, b *model.PayrollItem) bool {
	ra, ok := typeRank[a.Type]
	if !ok {
		ra = 99
	}
	rb, ok := typeRank[b.Type]
	if !ok {
		rb = 99
	}
	if ra != rb {
		return ra < rb
	}
	if a.State != b.State {
		return a.State < b.State
	}
	if a.TaxCode != b.TaxCode {
		return taxRank[a.TaxCode] < taxRank[b.TaxCode]
	}
	na, nb := strings.ToLower(a.Name), strings.ToLower(b.Name)
	if na != nb {
		return na < nb
	}
	return a.ID < b.ID
}

func sortItems(list []*model.PayrollItem) {
	sort.SliceStable(list, func(i, j int) bool { return lessItem(list[i], list[j]) })
}

// isPreTax: a deduction that reduces at least one wage base.
func isPreTax(it *model.PayrollItem) bool {
	for _, v := range it.Taxability {
		if v {
			return true
		}
	}
	return false
}

// isHoursItem: wage items whose quantity is hours.
func isHoursItem(it *model.PayrollItem) bool {
	switch it.Type {
	case model.ItemHourly, model.ItemOvertime, model.ItemSalary:
		return true
	}
	return false
}

// isTipsItem: paid and reported tips (Form 941 line 5b, W-2 box 7).
func isTipsItem(it *model.PayrollItem) bool {
	return it.Type == model.ItemTips || it.Type == model.ItemReportedTips ||
		it.TaxTracking == model.TrackPaidTips || it.TaxTracking == model.TrackReportedTips
}

// ---------------------------------------------------------------------------
// Employees

type employee struct {
	ID             int64
	DisplayName    string
	FirstName      string
	LastName       string
	SSN            string
	Address        model.Address
	Phone          string
	Mobile         string
	Email          string
	HireDate       string
	ReleaseDate    string
	EmploymentType string
	WorkState      string
	PayFrequency   string
	Active         bool
	BooksNameID    *int64
}

func (e *env) employees() (map[int64]*employee, error) {
	rows, err := e.q.QueryContext(e.ctx, `SELECT id, display_name, first_name, last_name, ssn, address1, address2, city, state, zip,
		phone, mobile, email, hire_date, release_date, employment_type, work_state, pay_frequency, active, books_name_id FROM employees`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*employee{}
	for rows.Next() {
		m := &employee{}
		var bn sql.NullInt64
		if err := rows.Scan(&m.ID, &m.DisplayName, &m.FirstName, &m.LastName, &m.SSN, &m.Address.Line1, &m.Address.Line2,
			&m.Address.City, &m.Address.State, &m.Address.Zip, &m.Phone, &m.Mobile, &m.Email, &m.HireDate, &m.ReleaseDate,
			&m.EmploymentType, &m.WorkState, &m.PayFrequency, &m.Active, &bn); err != nil {
			return nil, err
		}
		m.BooksNameID = store.PtrID(bn)
		out[m.ID] = m
	}
	return out, rows.Err()
}

// sortedEmployees returns the employees with the given ids by display name.
func sortedEmployees(all map[int64]*employee, ids map[int64]bool) []*employee {
	var out []*employee
	for id := range ids {
		if m := all[id]; m != nil {
			out = append(out, m)
		} else {
			out = append(out, &employee{ID: id, DisplayName: "Employee #" + strconv.FormatInt(id, 10)})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].DisplayName), strings.ToLower(out[j].DisplayName)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// activeFilter applies the active=active|all|inactive list parameter.
func (e *env) activeFilter(active bool) bool {
	switch strings.ToLower(e.p.Str("active")) {
	case "all":
		return true
	case "inactive":
		return !active
	}
	return active
}

// ssn returns the social security number as shown on reports: masked
// (XXX-XX-1234) unless the company preference "show SSNs on reports" is on
// and the user is an administrator (then the full number, audited).
func (e *env) ssn(raw string) string {
	if raw == "" {
		return ""
	}
	if e.p.Prefs.ShowSSNOnReports && e.c != nil && e.c.IsAdmin && !e.c.Assistant {
		e.revealed = true
		return store.FormatSSN(raw)
	}
	return store.MaskSSN(raw)
}

// ---------------------------------------------------------------------------
// Small helpers

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func dollars(c int64) float64 { return store.Dollars(c) }

// mdy formats YYYY-MM-DD as MM/DD/YYYY.
func mdy(date string) string {
	t, err := time.Parse(iso, date)
	if err != nil {
		return date
	}
	return t.Format("01/02/2006")
}

// fmtMoney formats cents as 1,234.56 (with "-" for negatives).
func fmtMoney(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	s := strconv.FormatInt(c/100, 10)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := fmt.Sprintf("%s.%02d", b.String(), c%100)
	if neg {
		return "-" + out
	}
	return out
}

// round4 rounds hours/quantities for display.
func round4(f float64) float64 {
	if f < 0 {
		return -round4(-f)
	}
	return float64(int64(f*10000+0.5)) / 10000
}

func target(kind string, id int64) *model.ReportTarget {
	return &model.ReportTarget{Kind: kind, ID: id}
}

func drill(report string, kv ...string) *model.ReportDrill {
	d := &model.ReportDrill{Report: report, Params: map[string]string{}}
	for i := 0; i+1 < len(kv); i += 2 {
		d.Params[kv[i]] = kv[i+1]
	}
	return d
}

func col(key, label, typ string) model.ReportColumn {
	return model.ReportColumn{Key: key, Label: label, Type: typ}
}

func labelCol() model.ReportColumn { return col("label", "", "text") }

// add appends a row to a result.
func addRow(r *model.ReportResult, kind string, level int, group string, cells map[string]any) *model.ReportRow {
	if cells == nil {
		cells = map[string]any{}
	}
	r.Rows = append(r.Rows, model.ReportRow{Kind: kind, Level: level, Group: group, Cells: cells})
	return &r.Rows[len(r.Rows)-1]
}

// checkNum is the number shown for a paycheck (same as its SerieX Books check).
func checkNum(p *paycheck) string {
	switch {
	case p.Kind == model.PaycheckYTD:
		return ""
	case p.ToBePrinted && !p.DirectDeposit:
		return "To Print"
	case p.CheckNumber == "" && p.DirectDeposit:
		return "DD" + itoa(p.ID)
	}
	return p.CheckNumber
}

// pcType is the transaction type of a paycheck.
func pcType(p *paycheck) string {
	if p.Kind == model.PaycheckYTD {
		return "Year-to-Date Entry"
	}
	return "Paycheck"
}

// payType is the transaction type of a liability payment.
func payType(p *payment) string {
	if p.Kind == model.PaymentPrior {
		return "Earlier Tax Payment"
	}
	return "Tax Payment"
}

// payNum is the number shown for a liability payment.
func payNum(p *payment) string {
	if p.Method == "e-pay" {
		return "E-pay"
	}
	if p.ToBePrinted {
		return "To Print"
	}
	return p.CheckNumber
}

// sortStable sorts s with less, keeping the order of equal elements.
func sortStable[T any](s []T, less func(a, b T) bool) {
	sort.SliceStable(s, func(i, j int) bool { return less(s[i], s[j]) })
}
