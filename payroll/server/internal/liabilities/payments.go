package liabilities

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

const paymentCols = `id, kind, date, period_start, period_end, agency_vendor_id, agency_name, bank_account_id, check_number,
	to_be_printed, method, memo, amount, voided, books_txn_id, sync_status, sync_error, created_by, created_at`

func scanPayment(s interface{ Scan(...any) error }) (*model.LiabilityPayment, string, error) {
	p := &model.LiabilityPayment{Lines: []model.LiabilityPaymentLine{}}
	var agency, bank, txn sql.NullInt64
	var agencyName string
	var amount int64
	err := s.Scan(&p.ID, &p.Kind, &p.Date, &p.PeriodStart, &p.PeriodEnd, &agency, &agencyName, &bank, &p.CheckNumber,
		&p.ToBePrinted, &p.Method, &p.Memo, &amount, &p.Voided, &txn, &p.SyncStatus, &p.SyncError, &p.CreatedBy, &p.CreatedAt)
	if err != nil {
		return nil, "", err
	}
	p.AgencyVendorID, p.BankAccountID, p.BooksTxnID = store.PtrID(agency), store.PtrID(bank), store.PtrID(txn)
	p.Amount = store.Dollars(amount)
	p.AgencyName = agencyName
	return p, agencyName, nil
}

// loadPaymentLines fills the lines of the given payments.
func loadPaymentLines(ctx context.Context, q store.Q, list []*model.LiabilityPayment) error {
	if len(list) == 0 {
		return nil
	}
	byID := map[int64]*model.LiabilityPayment{}
	ids := make([]string, 0, len(list))
	for _, p := range list {
		byID[p.ID] = p
		ids = append(ids, strconv.FormatInt(p.ID, 10))
	}
	rows, err := q.QueryContext(ctx, `SELECT l.payment_id, l.kind, l.item_id, l.account_id, l.amount, l.memo, IFNULL(i.name, '')
		FROM liability_payment_lines l LEFT JOIN payroll_items i ON i.id = l.item_id
		WHERE l.payment_id IN (`+strings.Join(ids, ",")+`) ORDER BY l.payment_id, l.seq, l.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var pid, amt int64
		var l model.LiabilityPaymentLine
		var item, acct sql.NullInt64
		if err := rows.Scan(&pid, &l.Kind, &item, &acct, &amt, &l.Memo, &l.ItemName); err != nil {
			return err
		}
		l.ItemID, l.AccountID, l.Amount = store.PtrID(item), store.PtrID(acct), store.Dollars(amt)
		if p := byID[pid]; p != nil {
			p.Lines = append(p.Lines, l)
		}
	}
	return rows.Err()
}

func loadPayment(ctx context.Context, q store.Q, id int64) (*model.LiabilityPayment, error) {
	p, _, err := scanPayment(q.QueryRowContext(ctx, `SELECT `+paymentCols+` FROM liability_payments WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Tax payment not found.")
	}
	if err != nil {
		return nil, err
	}
	if err := loadPaymentLines(ctx, q, []*model.LiabilityPayment{p}); err != nil {
		return nil, err
	}
	return p, nil
}

// fillPaymentNames sets the (ro) SerieX Books names (the stored agency name
// is kept when Books cannot be read).
func fillPaymentNames(p *model.LiabilityPayment, n *namer) {
	if s := n.vendor(p.AgencyVendorID); s != "" {
		p.AgencyName = s
	}
	p.BankAccountName = n.account(p.BankAccountID)
	for i := range p.Lines {
		p.Lines[i].AccountName = n.account(p.Lines[i].AccountID)
	}
}

// GET /liability-payments?from&to&kind&agencyVendorId (by payment date, newest first)
func listPaymentsRoute(c *httpx.Ctx) error {
	from, to, err := rangeParams(c)
	if err != nil {
		return err
	}
	where := []string{"1 = 1"}
	var args []any
	dateFilter("date", from, to, &where, &args)
	switch k := c.Q("kind"); k {
	case "":
	case model.PaymentRegular, model.PaymentPrior:
		where = append(where, "kind = ?")
		args = append(args, k)
	default:
		return apperr.Validation("kind", "kind must be payment or prior")
	}
	if v := c.QInt("agencyVendorId"); v > 0 {
		where = append(where, "agency_vendor_id = ?")
		args = append(args, v)
	}
	if !c.QBool("includeVoided") && c.Q("includeVoided") != "" {
		where = append(where, "voided = 0")
	}
	ctx := c.Context()
	rows, err := c.DB.QueryContext(ctx, `SELECT `+paymentCols+` FROM liability_payments WHERE `+strings.Join(where, " AND ")+
		` ORDER BY date DESC, id DESC`, args...)
	if err != nil {
		return err
	}
	list := []*model.LiabilityPayment{}
	for rows.Next() {
		p, _, err := scanPayment(rows)
		if err != nil {
			rows.Close()
			return err
		}
		list = append(list, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := loadPaymentLines(ctx, c.DB, list); err != nil {
		return err
	}
	n := newNamer(c)
	for _, p := range list {
		fillPaymentNames(p, n)
	}
	return c.JSON(list)
}

func getPaymentRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	p, err := loadPayment(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	fillPaymentNames(p, newNamer(c))
	return c.JSON(p)
}

// ---------------------------------------------------------------------------
// Create / update

// payLine is a validated payment line in cents.
type payLine struct {
	Kind    string
	ItemID  *int64
	Account *int64
	Amount  int64
	Memo    string
}

type paymentRecord struct {
	Kind        string
	Date        string
	PeriodStart string
	PeriodEnd   string
	Vendor      *int64
	VendorName  string
	Bank        *int64
	CheckNumber string
	ToBePrinted bool
	Method      string
	Memo        string
	Lines       []payLine
	Total       int64

	byItem    map[int64]int64  // Σ item lines per item (overpayment question)
	itemNames map[int64]string // names of those items
}

// validatePayment checks a payment from the client and returns it in cents.
func validatePayment(c *httpx.Ctx, in *model.LiabilityPayment) (*paymentRecord, error) {
	ctx := c.Context()
	r := &paymentRecord{
		Kind: strings.TrimSpace(in.Kind), Date: strings.TrimSpace(in.Date), PeriodStart: strings.TrimSpace(in.PeriodStart),
		PeriodEnd: strings.TrimSpace(in.PeriodEnd), Vendor: in.AgencyVendorID, Bank: in.BankAccountID,
		CheckNumber: strings.TrimSpace(in.CheckNumber), ToBePrinted: in.ToBePrinted, Method: strings.TrimSpace(in.Method),
		Memo: strings.TrimSpace(in.Memo),
	}
	if r.Kind == "" {
		r.Kind = model.PaymentRegular
	}
	if r.Kind != model.PaymentRegular && r.Kind != model.PaymentPrior {
		return nil, apperr.Validation("kind", "The payment kind must be payment or prior.")
	}
	if r.Vendor != nil && *r.Vendor <= 0 {
		r.Vendor = nil
	}
	if r.Bank != nil && *r.Bank <= 0 {
		r.Bank = nil
	}
	if !store.ValidDate(r.Date) {
		return nil, apperr.Validation("date", "Please enter a valid payment date.")
	}
	if r.PeriodEnd == "" {
		r.PeriodEnd = r.Date
	}
	if !store.ValidDate(r.PeriodEnd) {
		return nil, apperr.Validation("periodEnd", "Please enter a valid period end date.")
	}
	if r.PeriodStart == "" {
		r.PeriodStart = r.PeriodEnd[:8] + "01"
	}
	if !store.ValidDate(r.PeriodStart) {
		return nil, apperr.Validation("periodStart", "Please enter a valid period start date.")
	}
	if r.PeriodStart > r.PeriodEnd {
		return nil, apperr.Validation("periodStart", "The period start must be on or before the period end.")
	}
	if r.Method == "" {
		r.Method = "check"
	}
	if r.Method != "check" && r.Method != "e-pay" {
		return nil, apperr.Validation("method", "The payment method must be check or e-pay.")
	}
	if r.Kind == model.PaymentRegular {
		if r.Vendor == nil {
			return nil, apperr.Validation("agencyVendorId", "Choose the agency (payee) of the tax payment.")
		}
		if r.Bank == nil {
			return nil, apperr.Validation("bankAccountId", "Choose the bank account the tax payment is paid from.")
		}
	}
	if r.Method == "e-pay" || r.Kind == model.PaymentPrior {
		r.ToBePrinted = false
	}
	if r.Method == "e-pay" || r.ToBePrinted || r.Kind == model.PaymentPrior {
		r.CheckNumber = ""
	}
	if len([]rune(r.CheckNumber)) > 20 {
		return nil, apperr.Validation("checkNumber", "The check number is too long (20 characters at most).")
	}

	its, err := liabilityItems(ctx, c.DB)
	if err != nil {
		return nil, err
	}
	byItem := map[int64]int64{}
	for i, l := range in.Lines {
		amt := store.Cents(l.Amount)
		kind := strings.TrimSpace(l.Kind)
		if kind == "" {
			kind = "item"
			if l.ItemID == nil && l.AccountID != nil {
				kind = "expense"
			}
		}
		field := fmt.Sprintf("lines[%d]", i)
		switch kind {
		case "item":
			if l.ItemID == nil || *l.ItemID <= 0 {
				if amt == 0 {
					continue
				}
				return nil, apperr.Validation(field, "Choose the payroll item of every liability line.")
			}
			it := its[*l.ItemID]
			if it == nil {
				return nil, apperr.Validation(field, "Payroll item #%d is not a tax, deduction or company contribution item.", *l.ItemID)
			}
			if amt == 0 {
				continue
			}
			// a negative line takes a credit of the item (overpayment, decreasing
			// adjustment) with the payment; the check itself must be positive
			id := it.ID
			r.Lines = append(r.Lines, payLine{Kind: "item", ItemID: &id, Amount: amt, Memo: strings.TrimSpace(l.Memo)})
			byItem[id] += amt
		case "expense":
			if r.Kind == model.PaymentPrior {
				return nil, apperr.Validation(field, "Earlier tax payments list payroll items only (no expense lines).")
			}
			if amt == 0 {
				continue
			}
			if l.AccountID == nil || *l.AccountID <= 0 {
				return nil, apperr.Validation(field, "Choose the account of every expense line.")
			}
			if amt < 0 {
				return nil, apperr.Validation(field, "Expense amounts must be greater than zero.")
			}
			a := *l.AccountID
			r.Lines = append(r.Lines, payLine{Kind: "expense", Account: &a, Amount: amt, Memo: strings.TrimSpace(l.Memo)})
		default:
			return nil, apperr.Validation(field, "Unknown liability line kind %q.", l.Kind)
		}
	}
	for _, l := range r.Lines {
		r.Total += l.Amount
	}
	if r.Total <= 0 {
		if len(r.Lines) > 0 {
			return nil, apperr.Validation("lines", "The total of the tax payment must be greater than zero.")
		}
		return nil, apperr.Validation("lines", "Enter the amounts to pay.")
	}

	// SerieX Books references (checked when Books can be read)
	lk := booksLookup(c, func(lk *posting.Lookups) bool {
		if !hasVendors(lk, r.Vendor) || !hasAccount(lk, r.Bank) {
			return false
		}
		for _, l := range r.Lines {
			if !hasAccount(lk, l.Account) {
				return false
			}
		}
		return true
	})
	if lk.OK {
		if r.Vendor != nil {
			if _, ok := lk.Vendors[*r.Vendor]; !ok {
				return nil, apperr.Validation("agencyVendorId", "The agency is not a vendor in SerieX Books.")
			}
		}
		if r.Bank != nil {
			if a, ok := lk.Accounts[*r.Bank]; !ok || a.Type != books.AcctBank {
				return nil, apperr.Validation("bankAccountId", "Choose a SerieX Books bank account.")
			}
		}
		for _, l := range r.Lines {
			if l.Account != nil {
				if _, ok := lk.Accounts[*l.Account]; !ok {
					return nil, apperr.Validation("lines", "An expense account does not exist in SerieX Books.")
				}
			}
		}
	}
	n := &namer{lk: lk}
	r.VendorName = n.vendor(r.Vendor)
	r.byItem, r.itemNames = byItem, map[int64]string{}
	for id := range byItem {
		r.itemNames[id] = its[id].Name
	}
	return r, nil
}

// checkOverpay asks for a Yes (confirm) when the payment pays more than the
// balance of one of its items. It runs inside the write transaction so two
// payments saved at the same time cannot both skip the question.
func checkOverpay(c *httpx.Ctx, q store.Q, r *paymentRecord, excludeID int64) error {
	if c.Force() || len(r.byItem) == 0 {
		return nil
	}
	bal, err := itemBalances(c.Context(), q, excludeID)
	if err != nil {
		return err
	}
	ids := make([]int64, 0, len(r.byItem))
	for id := range r.byItem {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if amt, b := r.byItem[id], bal[id]; amt > b {
			return apperr.Confirm("The amount paid for %s (%s) is more than its liability balance (%s). Record the payment anyway?",
				r.itemNames[id], fmtMoney(amt), fmtMoney(b))
		}
	}
	return nil
}

// itemBalances returns the balance (accrued + adjusted - paid, all dates) of
// every liability item, leaving out one payment (the one being edited).
func itemBalances(ctx context.Context, q store.Q, excludePayment int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	queries := []struct {
		sign int64
		sql  string
	}{
		{1, `SELECT pl.item_id, SUM(pl.amount) FROM paycheck_lines pl JOIN paychecks p ON p.id = pl.paycheck_id
			WHERE p.voided = 0 AND pl.category IN ('employee_tax','employer_tax','deduction','contribution') GROUP BY 1`},
		{1, `SELECT item_id, SUM(amount) FROM liability_adjustment_lines GROUP BY 1`},
		{-1, `SELECT l.item_id, SUM(l.amount) FROM liability_payment_lines l JOIN liability_payments p ON p.id = l.payment_id
			WHERE p.voided = 0 AND l.kind = 'item' AND l.item_id IS NOT NULL AND p.id <> ? GROUP BY 1`},
	}
	for _, qq := range queries {
		var args []any
		if qq.sign < 0 {
			args = append(args, excludePayment)
		}
		rows, err := q.QueryContext(ctx, qq.sql, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, amt int64
			if err := rows.Scan(&id, &amt); err != nil {
				rows.Close()
				return nil, err
			}
			out[id] += qq.sign * amt
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

// insertPayment stores a new payment with its lines (inside a write transaction).
func insertPayment(c *httpx.Ctx, tx *sql.Tx, r *paymentRecord) (int64, error) {
	ctx := c.Context()
	now := store.Now()
	status := "pending"
	if r.Kind == model.PaymentPrior {
		status = "none"
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO liability_payments(kind, date, period_start, period_end, agency_vendor_id, agency_name,
		bank_account_id, check_number, to_be_printed, method, memo, amount, voided, sync_status, created_by, created_at, updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`, r.Kind, r.Date, r.PeriodStart, r.PeriodEnd, store.NullID(r.Vendor), r.VendorName,
		store.NullID(r.Bank), r.CheckNumber, store.B(r.ToBePrinted), r.Method, r.Memo, r.Total, status, c.User, now, now)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, insertPaymentLines(ctx, tx, id, r.Lines)
}

func insertPaymentLines(ctx context.Context, tx *sql.Tx, id int64, lines []payLine) error {
	for i, l := range lines {
		if _, err := tx.ExecContext(ctx, `INSERT INTO liability_payment_lines(payment_id, seq, kind, item_id, account_id, amount, memo)
			VALUES(?,?,?,?,?,?,?)`, id, i+1, l.Kind, store.NullID(l.ItemID), store.NullID(l.Account), l.Amount, l.Memo); err != nil {
			return err
		}
	}
	return nil
}

func paymentSummary(kind, vendorName string, total int64, date string) string {
	what := "Tax payment"
	if kind == model.PaymentPrior {
		what = "Earlier tax payment"
	}
	if vendorName != "" {
		what += " to " + vendorName
	}
	return fmt.Sprintf("%s %s on %s", what, fmtMoney(total), mdy(date))
}

// POST /liability-payments, PUT /liability-payments/{id}
func savePaymentRoute(c *httpx.Ctx, id int64) error {
	var in model.LiabilityPayment
	if err := c.Decode(&in); err != nil {
		return err
	}
	ctx := c.Context()
	var before *model.LiabilityPayment
	if id != 0 {
		var err error
		if before, err = loadPayment(ctx, c.DB, id); err != nil {
			return err
		}
		if before.Voided {
			return apperr.Conflict("This tax payment is void and cannot be changed.")
		}
	}
	r, err := validatePayment(c, &in)
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		if err := checkOverpay(c, tx, r, id); err != nil {
			return err
		}
		if r.Kind == model.PaymentRegular && (before == nil || before.CheckNumber != r.CheckNumber || !idEq(before.BankAccountID, r.Bank)) {
			if err := confirmCheckNumber(c, tx, r.Bank, r.CheckNumber, id); err != nil {
				return err
			}
		}
		if id == 0 {
			if id, err = insertPayment(c, tx, r); err != nil {
				return err
			}
			return store.Audit(ctx, tx, c.User, "add", posting.EntityPayment, id, paymentSummary(r.Kind, r.VendorName, r.Total, r.Date), r)
		}
		var voided bool
		if err := tx.QueryRowContext(ctx, `SELECT voided FROM liability_payments WHERE id = ?`, id).Scan(&voided); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return apperr.NotFound("Tax payment not found.")
			}
			return err
		}
		if voided {
			return apperr.Conflict("This tax payment is void and cannot be changed.")
		}
		name := r.VendorName
		if name == "" && idEq(r.Vendor, before.AgencyVendorID) {
			name = before.AgencyName
		}
		if _, err := tx.ExecContext(ctx, `UPDATE liability_payments SET kind = ?, date = ?, period_start = ?, period_end = ?,
			agency_vendor_id = ?, agency_name = ?, bank_account_id = ?, check_number = ?, to_be_printed = ?, method = ?, memo = ?,
			amount = ?, updated_at = ? WHERE id = ?`, r.Kind, r.Date, r.PeriodStart, r.PeriodEnd, store.NullID(r.Vendor), name,
			store.NullID(r.Bank), r.CheckNumber, store.B(r.ToBePrinted), r.Method, r.Memo, r.Total, store.Now(), id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM liability_payment_lines WHERE payment_id = ?`, id); err != nil {
			return err
		}
		if err := insertPaymentLines(ctx, tx, id, r.Lines); err != nil {
			return err
		}
		return store.Audit(ctx, tx, c.User, "modify", posting.EntityPayment, id, paymentSummary(r.Kind, name, r.Total, r.Date),
			map[string]any{"before": before, "after": r})
	})
	if err != nil {
		return err
	}
	// a new earlier tax payment is never posted; an edited record is re-posted (or
	// removed from Books when it became an earlier tax payment)
	if r.Kind == model.PaymentRegular || before != nil {
		if _, err := posting.PostLiabilityPayment(c, id, books.Opts(c)); err != nil {
			return err
		}
	}
	p, err := loadPayment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	fillPaymentNames(p, newNamer(c))
	return c.JSON(p)
}

func idEq(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// DELETE /liability-payments/{id}: the Books check is deleted first.
func deletePaymentRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	p, err := loadPayment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	// Books delete + payroll delete under the payment's posting lock (a Books
	// Sync retry cannot post it again in between)
	err = posting.WithRecordLock(c, posting.EntityPayment, id, func(c *httpx.Ctx) error {
		if err := posting.Unpost(c, posting.EntityPayment, id, "delete", books.Opts(c)); err != nil {
			return err
		}
		return c.Write(func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, `DELETE FROM liability_payments WHERE id = ?`, id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return apperr.NotFound("Tax payment not found.")
			}
			return store.Audit(ctx, tx, c.User, "delete", posting.EntityPayment, id,
				paymentSummary(p.Kind, p.AgencyName, store.Cents(p.Amount), p.Date), p)
		})
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}

// POST /liability-payments/{id}/void: the Books check is voided first, then
// the payment keeps its row with every amount set to 0.
func voidPaymentRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	p, err := loadPayment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	if p.Voided {
		return apperr.Conflict("This tax payment is already void.")
	}
	// Books void + payroll void under the payment's posting lock
	err = posting.WithRecordLock(c, posting.EntityPayment, id, func(c *httpx.Ctx) error {
		if err := posting.Unpost(c, posting.EntityPayment, id, "void", books.Opts(c)); err != nil {
			return err
		}
		return c.Write(func(tx *sql.Tx) error {
			// another request may have voided or deleted it meanwhile
			var voided bool
			if err := tx.QueryRowContext(ctx, `SELECT voided FROM liability_payments WHERE id = ?`, id).Scan(&voided); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return apperr.NotFound("Tax payment not found.")
				}
				return err
			}
			if voided {
				return apperr.Conflict("This tax payment is already void.")
			}
			memo := p.Memo
			if !strings.HasPrefix(memo, "VOID:") {
				memo = strings.TrimSpace("VOID: " + memo)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE liability_payment_lines SET amount = 0 WHERE payment_id = ?`, id); err != nil {
				return err
			}
			// never posted (earlier tax payment, posting off or failed): nothing in Books
			if _, err := tx.ExecContext(ctx, `UPDATE liability_payments SET voided = 1, amount = 0, memo = ?, updated_at = ?,
			sync_status = CASE WHEN books_txn_id IS NULL THEN 'none' ELSE sync_status END,
			sync_error = CASE WHEN books_txn_id IS NULL THEN '' ELSE sync_error END WHERE id = ?`, memo, store.Now(), id); err != nil {
				return err
			}
			return store.Audit(ctx, tx, c.User, "void", posting.EntityPayment, id,
				paymentSummary(p.Kind, p.AgencyName, store.Cents(p.Amount), p.Date), p)
		})
	})
	if err != nil {
		return err
	}
	out, err := loadPayment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	fillPaymentNames(out, newNamer(c))
	return c.JSON(out)
}
