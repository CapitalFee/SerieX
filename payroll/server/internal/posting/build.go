package posting

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/books"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// AppName tags every Books transaction created by payroll (extra.payroll.app).
const AppName = "SerieX Payroll"

// itemInfo is the part of a payroll item posting needs.
type itemInfo struct {
	ID        int64
	Name      string
	Type      string
	TaxCode   string
	NotPaid   bool
	Expense   *int64
	Liability *int64
	Agency    *int64
}

func loadItems(ctx context.Context, q store.Q) (map[int64]*itemInfo, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, type, tax_code, not_paid, expense_account_id, liability_account_id, agency_vendor_id FROM payroll_items`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*itemInfo{}
	for rows.Next() {
		var it itemInfo
		var exp, liab, ag sql.NullInt64
		if err := rows.Scan(&it.ID, &it.Name, &it.Type, &it.TaxCode, &it.NotPaid, &exp, &liab, &ag); err != nil {
			return nil, err
		}
		it.Expense, it.Liability, it.Agency = store.PtrID(exp), store.PtrID(liab), store.PtrID(ag)
		out[it.ID] = &it
	}
	return out, rows.Err()
}

// record is a payroll record and the Books transaction payroll would post for it now.
type record struct {
	Entity string
	Table  string
	ID     int64
	Date   string
	Label  string
	Voided bool
	TxnID  *int64 // Books transaction already posted
	Status string

	// NoPost explains why the record is never posted ("" = it is posted):
	// Year-to-date amounts, earlier tax payments, adjustments that do not affect accounts.
	NoPost string

	EmployeeID      int64  // paychecks and employee adjustments
	EmployeeBooksID *int64 // employees.books_name_id
	EmployeeName    string // employees.display_name

	Txn     books.Txn
	Total   int64  // check amount (net pay / payment amount) or journal debits, cents
	Problem string // why the transaction cannot be built (missing account, totals differ)
}

func tableOf(entity string) string {
	switch entity {
	case EntityPaycheck:
		return "paychecks"
	case EntityPayment:
		return "liability_payments"
	case EntityAdjustment:
		return "liability_adjustments"
	}
	return ""
}

// build loads a record and builds its Books transaction.
func build(ctx context.Context, q store.Q, entity string, id int64, prefs model.PayrollPrefs, items map[int64]*itemInfo) (*record, error) {
	switch entity {
	case EntityPaycheck:
		return buildPaycheck(ctx, q, id, prefs, items)
	case EntityPayment:
		return buildPayment(ctx, q, id, items)
	case EntityAdjustment:
		return buildAdjustment(ctx, q, id, prefs, items)
	}
	return nil, fmt.Errorf("unknown payroll record type %q", entity)
}

func extra(kind string, id int64) map[string]any {
	return map[string]any{"payroll": map[string]any{"app": AppName, "kind": kind, "id": id}}
}

// mdy formats YYYY-MM-DD as MM/DD/YYYY.
func mdy(date string) string {
	t, err := store.ParseDate(date)
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

func classTracking(prefs model.PayrollPrefs) bool {
	return prefs.ClassTracking != "" && prefs.ClassTracking != "none"
}

func withMemo(base, memo string) string {
	memo = strings.TrimSpace(memo)
	if memo == "" {
		return base
	}
	return base + " " + memo
}

// lineAdder appends Books lines and keeps their total in cents.
type lineAdder struct {
	lines []books.TxnLine
	sum   int64
	kind  string
}

func (a *lineAdder) add(acct *int64, cents int64, desc string, nameID, classID *int64) {
	a.lines = append(a.lines, books.TxnLine{
		Seq:         len(a.lines) + 1,
		Kind:        a.kind,
		AccountID:   acct,
		Description: desc,
		Amount:      store.Dollars(cents),
		NameID:      nameID,
		ClassID:     classID,
	})
	a.sum += cents
}

// ---------------------------------------------------------------------------
// Paycheck -> Books check

func buildPaycheck(ctx context.Context, q store.Q, id int64, prefs model.PayrollPrefs, items map[int64]*itemInfo) (*record, error) {
	r := &record{Entity: EntityPaycheck, Table: "paychecks", ID: id}
	var kind, periodStart, periodEnd, checkNumber, memo, empName, printAs string
	var bank, class, txn, empBooks sql.NullInt64
	var toBePrinted, dd bool
	var net int64
	var addr books.Address
	err := q.QueryRowContext(ctx, `SELECT p.kind, p.employee_id, p.period_start, p.period_end, p.check_date, p.bank_account_id,
		p.check_number, p.to_be_printed, p.direct_deposit, p.memo, p.class_id, p.net, p.voided, p.books_txn_id, p.sync_status,
		e.display_name, e.books_name_id, e.print_as, e.address1, e.address2, e.city, e.state, e.zip
		FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`, id).Scan(
		&kind, &r.EmployeeID, &periodStart, &periodEnd, &r.Date, &bank, &checkNumber, &toBePrinted, &dd, &memo, &class,
		&net, &r.Voided, &txn, &r.Status, &empName, &empBooks, &printAs, &addr.Line1, &addr.Line2, &addr.City, &addr.State, &addr.Zip)
	if err != nil {
		return nil, err
	}
	r.Label = "Paycheck - " + empName
	r.EmployeeName = empName
	r.TxnID, r.EmployeeBooksID, r.Total = store.PtrID(txn), store.PtrID(empBooks), net
	if kind == model.PaycheckYTD {
		r.NoPost = "Year-to-date history is never posted to SerieX Books."
		return r, nil
	}

	classOn := classTracking(prefs)
	var payClass *int64
	if classOn {
		payClass = store.PtrID(class)
	}
	t := books.Txn{
		Type:      books.TxCheck,
		Date:      r.Date,
		AccountID: store.PtrID(bank),
		NameID:    r.EmployeeBooksID,
		Memo:      withMemo(fmt.Sprintf("Pay Period: %s - %s", mdy(periodStart), mdy(periodEnd)), memo),
		ClassID:   payClass,
		Extra:     extra(EntityPaycheck, id),
	}
	// the check's address box: the employee's name as printed on checks and address
	payee := strings.TrimSpace(printAs)
	if payee == "" {
		payee = empName
	}
	t.BillAddress = books.AddressText(payee, addr)
	switch {
	case toBePrinted && !dd:
		// Payroll prints its paychecks with their pay stubs: the Books check has
		// no number and is NOT "to be printed" there (it would also be listed in
		// Books' Select Checks to Print and could be printed twice). Marking the
		// paycheck printed re-posts it with its check number.
	case checkNumber == "" && dd:
		t.RefNumber = "DD" + strconv.FormatInt(id, 10)
	default:
		t.RefNumber = checkNumber
	}

	rows, err := q.QueryContext(ctx, `SELECT item_id, category, amount, job_name_id, class_id FROM paycheck_lines
		WHERE paycheck_id = ? ORDER BY seq, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	add := &lineAdder{kind: books.LineExpense}
	var problems []string
	for rows.Next() {
		var itemID, amount int64
		var category string
		var job, lclass sql.NullInt64
		if err := rows.Scan(&itemID, &category, &amount, &job, &lclass); err != nil {
			return nil, err
		}
		it := items[itemID]
		if it == nil {
			problems = append(problems, fmt.Sprintf("Paycheck line refers to payroll item #%d, which no longer exists.", itemID))
			continue
		}
		if amount == 0 || it.NotPaid {
			continue
		}
		lineClass := payClass
		if classOn && lclass.Valid {
			lineClass = store.PtrID(lclass)
		}
		switch category {
		case model.CatEarning, model.CatAddition:
			if it.Expense == nil {
				problems = append(problems, fmt.Sprintf("Payroll item %s has no expense account.", it.Name))
				continue
			}
			add.add(it.Expense, amount, it.Name, store.PtrID(job), lineClass)
		case model.CatDeduction, model.CatEmployeeTax:
			if it.Liability == nil {
				problems = append(problems, fmt.Sprintf("Payroll item %s has no liability account.", it.Name))
				continue
			}
			add.add(it.Liability, -amount, it.Name, nil, payClass)
		case model.CatEmployerTax, model.CatContribution:
			if it.Expense == nil {
				problems = append(problems, fmt.Sprintf("Payroll item %s has no expense account.", it.Name))
				continue
			}
			if it.Liability == nil {
				problems = append(problems, fmt.Sprintf("Payroll item %s has no liability account.", it.Name))
				continue
			}
			add.add(it.Expense, amount, it.Name, nil, payClass)
			add.add(it.Liability, -amount, it.Name, nil, payClass)
		default:
			problems = append(problems, fmt.Sprintf("Paycheck line for %s has an unknown category %q.", it.Name, category))
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	t.Lines = add.lines
	r.Txn = t
	if t.AccountID == nil {
		problems = append([]string{"The paycheck has no bank account."}, problems...)
	}
	if len(problems) == 0 && add.sum != net {
		problems = append(problems, fmt.Sprintf("The paycheck lines (%s) do not add up to the net pay (%s).", fmtMoney(add.sum), fmtMoney(net)))
	}
	r.Problem = strings.Join(problems, " ")
	return r, nil
}

// ---------------------------------------------------------------------------
// Liability payment -> Books check

func buildPayment(ctx context.Context, q store.Q, id int64, items map[int64]*itemInfo) (*record, error) {
	r := &record{Entity: EntityPayment, Table: "liability_payments", ID: id}
	var kind, periodStart, periodEnd, agencyName, checkNumber, method, memo string
	var agency, bank, txn sql.NullInt64
	var toBePrinted bool
	var amount int64
	err := q.QueryRowContext(ctx, `SELECT kind, date, period_start, period_end, agency_vendor_id, agency_name, bank_account_id,
		check_number, to_be_printed, method, memo, amount, voided, books_txn_id, sync_status
		FROM liability_payments WHERE id = ?`, id).Scan(&kind, &r.Date, &periodStart, &periodEnd, &agency, &agencyName, &bank,
		&checkNumber, &toBePrinted, &method, &memo, &amount, &r.Voided, &txn, &r.Status)
	if err != nil {
		return nil, err
	}
	r.Label = "Tax Payment"
	if agencyName != "" {
		r.Label += " - " + agencyName
	}
	r.TxnID, r.Total = store.PtrID(txn), amount
	if kind == model.PaymentPrior {
		r.NoPost = "Earlier tax payments are history and are never posted to SerieX Books."
		return r, nil
	}
	epay := method == "e-pay"
	// A tax payment check to be printed is printed from payroll: like a paycheck it
	// goes to Books without a number and not "to be printed" (Books' Select Checks
	// to Print would offer it too); printing it re-posts it with its number.
	// The address box (the agency's Books address) is filled when posting.
	t := books.Txn{
		Type:      books.TxCheck,
		Date:      r.Date,
		AccountID: store.PtrID(bank),
		NameID:    store.PtrID(agency),
		Memo:      withMemo(fmt.Sprintf("Payroll Liabilities %s - %s", mdy(periodStart), mdy(periodEnd)), memo),
		Extra:     extra(EntityPayment, id),
	}
	if !epay && !toBePrinted {
		t.RefNumber = checkNumber
	}

	rows, err := q.QueryContext(ctx, `SELECT kind, item_id, account_id, amount, memo FROM liability_payment_lines
		WHERE payment_id = ? ORDER BY seq, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	add := &lineAdder{kind: books.LineExpense}
	var problems []string
	for rows.Next() {
		var lkind, lmemo string
		var itemID, acct sql.NullInt64
		var amt int64
		if err := rows.Scan(&lkind, &itemID, &acct, &amt, &lmemo); err != nil {
			return nil, err
		}
		if amt == 0 {
			continue
		}
		if lkind == "expense" {
			if !acct.Valid {
				problems = append(problems, "An expense line of the tax payment has no account.")
				continue
			}
			desc := lmemo
			if desc == "" {
				desc = "Payroll liability penalty/interest"
			}
			add.add(store.PtrID(acct), amt, desc, nil, nil)
			continue
		}
		it := items[itemID.Int64]
		if !itemID.Valid || it == nil {
			problems = append(problems, "A line of the tax payment refers to a payroll item that no longer exists.")
			continue
		}
		if it.Liability == nil {
			problems = append(problems, fmt.Sprintf("Payroll item %s has no liability account.", it.Name))
			continue
		}
		desc := it.Name
		if lmemo != "" {
			desc += ": " + lmemo
		}
		add.add(it.Liability, amt, desc, nil, nil)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	t.Lines = add.lines
	r.Txn = t
	if t.NameID == nil {
		problems = append([]string{"The tax payment has no payee (agency vendor)."}, problems...)
	}
	if t.AccountID == nil {
		problems = append([]string{"The tax payment has no bank account."}, problems...)
	}
	if len(problems) == 0 && add.sum != amount {
		problems = append(problems, fmt.Sprintf("The tax payment lines (%s) do not add up to the check amount (%s).", fmtMoney(add.sum), fmtMoney(amount)))
	}
	r.Problem = strings.Join(problems, " ")
	return r, nil
}

// ---------------------------------------------------------------------------
// Liability adjustment -> Books general journal entry

func buildAdjustment(ctx context.Context, q store.Q, id int64, prefs model.PayrollPrefs, items map[int64]*itemInfo) (*record, error) {
	r := &record{Entity: EntityAdjustment, Table: "liability_adjustments", ID: id}
	var memo, empName string
	var emp, class, txn, empBooks sql.NullInt64
	var affects bool
	err := q.QueryRowContext(ctx, `SELECT a.date, a.employee_id, a.memo, a.affects_accounts, a.class_id, a.books_txn_id, a.sync_status,
		IFNULL(e.display_name, ''), e.books_name_id
		FROM liability_adjustments a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`, id).Scan(
		&r.Date, &emp, &memo, &affects, &class, &txn, &r.Status, &empName, &empBooks)
	if err != nil {
		return nil, err
	}
	r.TxnID = store.PtrID(txn)
	if emp.Valid {
		r.EmployeeID = emp.Int64
		r.EmployeeBooksID = store.PtrID(empBooks)
		r.EmployeeName = empName
		r.Label = "Tax Balance Adjustment - " + empName
	} else {
		r.Label = "Tax Balance Adjustment - Company"
	}
	if !affects {
		r.NoPost = "The adjustment does not affect liability and expense accounts."
		return r, nil
	}
	var cls *int64
	if classTracking(prefs) {
		cls = store.PtrID(class)
	}
	t := books.Txn{
		Type:    books.TxJournal,
		Date:    r.Date,
		Memo:    withMemo("Payroll Liability Adjustment", memo),
		ClassID: cls,
		Extra:   extra(EntityAdjustment, id),
	}

	type adjLine struct {
		item   int64
		amount int64
		memo   string
	}
	var lines []adjLine
	rows, err := q.QueryContext(ctx, `SELECT item_id, amount, memo FROM liability_adjustment_lines WHERE adjustment_id = ? ORDER BY seq, id`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var l adjLine
		if err := rows.Scan(&l.item, &l.amount, &l.memo); err != nil {
			rows.Close()
			return nil, err
		}
		lines = append(lines, l)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	add := &lineAdder{kind: books.LineJournal}
	var problems []string
	var fallback *int64
	fallbackDone := false
	for _, l := range lines {
		if l.amount == 0 {
			continue
		}
		it := items[l.item]
		if it == nil {
			problems = append(problems, fmt.Sprintf("Adjustment line refers to payroll item #%d, which no longer exists.", l.item))
			continue
		}
		if it.Liability == nil {
			problems = append(problems, fmt.Sprintf("Payroll item %s has no liability account.", it.Name))
			continue
		}
		expense := it.Expense
		cat := model.ItemCategory(it.Type, it.TaxCode)
		if expense == nil && (cat == model.CatDeduction || cat == model.CatEmployeeTax) {
			if !fallbackDone {
				if fallback, err = fallbackExpense(ctx, q, r.EmployeeID); err != nil {
					return nil, err
				}
				fallbackDone = true
			}
			expense = fallback
		}
		if expense == nil {
			problems = append(problems, fmt.Sprintf("Payroll item %s has no expense account.", it.Name))
			continue
		}
		nameID := r.EmployeeBooksID
		if r.EmployeeID == 0 {
			nameID = it.Agency
		}
		desc := it.Name
		if l.memo != "" {
			desc += ": " + l.memo
		}
		// + increases the liability (credit) and the expense side (debit).
		add.add(expense, l.amount, desc, nameID, cls)
		add.add(it.Liability, -l.amount, desc, nameID, cls)
	}
	t.Lines = add.lines
	r.Txn = t
	for _, l := range add.lines {
		if l.Amount > 0 {
			r.Total += store.Cents(l.Amount)
		}
	}
	if len(problems) == 0 && len(add.lines) == 0 {
		r.NoPost = "The adjustment changes no amounts (wage bases only)."
	}
	r.Problem = strings.Join(problems, " ")
	return r, nil
}

// fallbackExpense is the expense account used for employee-paid items without
// one: the employee's first earnings item, else the first salary/hourly item.
func fallbackExpense(ctx context.Context, q store.Q, employeeID int64) (*int64, error) {
	var id sql.NullInt64
	if employeeID != 0 {
		err := q.QueryRowContext(ctx, `SELECT pi.expense_account_id FROM employee_items ei JOIN payroll_items pi ON pi.id = ei.item_id
			WHERE ei.employee_id = ? AND pi.type IN ('salary','hourly','overtime','bonus','commission','tips','reported_tips')
			AND pi.expense_account_id IS NOT NULL ORDER BY ei.seq, ei.id LIMIT 1`, employeeID).Scan(&id)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if id.Valid {
			return store.PtrID(id), nil
		}
	}
	err := q.QueryRowContext(ctx, `SELECT expense_account_id FROM payroll_items WHERE type IN ('salary','hourly')
		AND expense_account_id IS NOT NULL ORDER BY active DESC, CASE type WHEN 'salary' THEN 0 ELSE 1 END, id LIMIT 1`).Scan(&id)
	if err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	return store.PtrID(id), nil
}
