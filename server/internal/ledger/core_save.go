package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

const receiptMemo = "Received items (bill to follow)"

// saveTxn implements Save.
func saveTxn(ctx context.Context, tx *sql.Tx, t *model.Txn, opt SaveOptions) (int64, error) {
	if t == nil {
		return 0, apperr.BadRequest("missing transaction")
	}
	if err := checkNumbers(t); err != nil {
		return 0, err
	}
	e, err := newEnv(ctx, tx, opt)
	if err != nil {
		return 0, err
	}
	s := fromModel(t)
	if s.ID < 0 {
		s.ID = 0
	}
	var old *stxn
	var before *model.Txn
	if s.ID != 0 {
		if old, err = loadStored(ctx, tx, s.ID); err != nil {
			return 0, err
		}
		if t.UpdatedAt != "" && t.UpdatedAt != old.UpdatedAt {
			return 0, staleTxn()
		}
		if before, err = getTxn(ctx, tx, s.ID); err != nil {
			return 0, err
		}
		if s.Type == "" {
			s.Type = old.Type
		}
		if s.Type != old.Type && !(old.Type == model.TxItemReceipt && s.Type == model.TxBill) {
			return 0, apperr.Validation("type", "The type of an existing transaction cannot be changed.")
		}
		s.Voided = old.Voided
		s.CreatedBy, s.CreatedAt = old.CreatedBy, old.CreatedAt
		if t.Extra == nil {
			// a body without "extra" keeps the stored one (other apps keep their data there)
			s.Extra = old.Extra
		}
	}
	if !knownTypes[s.Type] {
		return 0, apperr.Validation("type", "Unknown transaction type %q.", s.Type)
	}

	if err := e.normalize(s, old); err != nil {
		return 0, err
	}
	if err := e.validate(s, old); err != nil {
		return 0, err
	}
	var oldPost *oldPosting
	if old != nil {
		if oldPost, err = e.loadOldPosting(s.ID); err != nil {
			return 0, err
		}
	} else {
		oldPost = &oldPosting{moveVals: map[int64]int64{}, moveItems: map[int64]bool{}, moveQty: map[int64]float64{}}
	}
	if old != nil {
		// lines kept from the stored version keep the accounts and tax split they were posted with
		oldPost.editLines = map[int64]int64{}
		for _, l := range old.Lines {
			oldPost.editLines[l.ID] = l.ItemID
		}
		oldPost.oldTaxItem = old.TaxItemID
	}
	if err := e.compute(s, oldPost, old); err != nil {
		return 0, err
	}
	if err := checkTotals(s); err != nil {
		return 0, err
	}
	if err := e.validateComputed(s, old); err != nil {
		return 0, err
	}
	post, err := e.buildPosting(s, oldPost)
	if err != nil {
		return 0, err
	}

	// closing date (new date, and the old one when editing)
	if err := store.CheckClosingDate(ctx, tx, s.Date, opt.ClosingPassword, opt.Accepts(apperr.WarnClosing)); err != nil {
		return 0, err
	}
	if old != nil && old.Date != s.Date {
		if err := store.CheckClosingDate(ctx, tx, old.Date, opt.ClosingPassword, opt.Accepts(apperr.WarnClosing)); err != nil {
			return 0, err
		}
	}

	// deposited payments (whole payments / sales receipts, and payment-item
	// lines of invoices and sales receipts that went to Undeposited Funds)
	var depLines []depLine
	if old != nil && typeIn(old.Type, model.TxPayment, model.TxSalesReceipt, model.TxInvoice) {
		all, err := e.depositLinesOf(s.ID)
		if err != nil {
			return 0, err
		}
		for _, dl := range all {
			changed := false
			if dl.srcLine == 0 {
				changed = s.Amount != old.Amount || s.AccountID != old.AccountID || s.IsPending
			} else {
				dl.newAmount = ufLineAmount(s, post, dl.srcLine, dl.ufID)
				changed = dl.newAmount != dl.amount
			}
			if changed {
				depLines = append(depLines, dl)
			}
		}
	}
	// other transactions this save re-posts must pass their own closing date
	// check: deposits containing the payment, payments applied to a document
	// whose customer:job changes
	affected := map[int64]bool{}
	for _, dl := range depLines {
		affected[dl.depID] = true
	}
	if old != nil && old.NameID != s.NameID {
		deps, err := e.dependents(s.ID)
		if err != nil {
			return 0, err
		}
		for _, l := range deps {
			if l.Owner != s.ID {
				affected[l.Owner] = true
			}
		}
	}
	if err := e.checkAffected(affected); err != nil {
		return 0, err
	}
	if err := e.warnings(s, old, post, oldPost); err != nil {
		return 0, err
	}
	if len(depLines) > 0 {
		depRec, err := e.reconciledDeposits(depLines)
		if err != nil {
			return 0, err
		}
		if depRec != nil && !opt.Accepts(apperr.WarnReconciled) {
			return 0, apperr.ConfirmKind(apperr.WarnReconciled, "This payment is on %s, which has been reconciled. Changing the payment's amount or deposit account will change that deposit and the reconciled balance of the account. Do you want to save it anyway?", docLabel(depRec))
		}
		if !opt.Accepts(apperr.WarnDeposited) {
			return 0, apperr.ConfirmKind(apperr.WarnDeposited, "This payment has been deposited. Changing its amount or deposit account will also change the deposit. Do you want to continue?")
		}
	}

	// collect what depends on the old version before it is overwritten
	d := newDerived()
	if old != nil {
		if err := e.collectDerived(d, old); err != nil {
			return 0, err
		}
	}

	if err := e.writeHeader(s, old == nil); err != nil {
		return 0, err
	}
	delete(e.briefs, s.ID) // name, amount... may have changed
	if err := e.writeLines(s, old, post.cogsInit); err != nil {
		return 0, err
	}
	if err := e.writeLinks(s); err != nil {
		return 0, err
	}
	post.bindLines(s)
	items, err := e.writePosting(s, post, oldPost)
	if err != nil {
		return 0, err
	}
	from := s.Date
	if old != nil && old.Date < from {
		from = old.Date
	}
	if err := e.recost(items, from); err != nil {
		return 0, err
	}
	// keep deposits that contain this payment in step
	for _, dl := range depLines {
		if dl.srcLine != 0 {
			if dl.newAmount > 0 {
				_, err = tx.ExecContext(ctx, `UPDATE txn_lines SET amount = ? WHERE id = ?`, dl.newAmount, dl.lineID)
			} else {
				_, err = tx.ExecContext(ctx, `DELETE FROM txn_lines WHERE id = ?`, dl.lineID)
			}
		} else if s.AccountID == dl.ufID && !s.IsPending && !s.Voided {
			_, err = tx.ExecContext(ctx, `UPDATE txn_lines SET amount = ? WHERE id = ?`, s.Amount, dl.lineID)
		} else {
			_, err = tx.ExecContext(ctx, `DELETE FROM txn_lines WHERE id = ?`, dl.lineID)
		}
		if err != nil {
			return 0, err
		}
		if err := e.repost(dl.depID); err != nil {
			return 0, err
		}
	}

	// payments, credits and refunds applied to it post A/R or A/P under the
	// name of the document they pay: re-post them when that name changed
	if old != nil && old.NameID != s.NameID {
		deps, err := e.dependents(s.ID)
		if err != nil {
			return 0, err
		}
		done := map[int64]bool{}
		for _, l := range deps {
			if l.Owner != s.ID && !done[l.Owner] {
				done[l.Owner] = true
				if err := e.repost(l.Owner); err != nil {
					return 0, err
				}
			}
		}
	}

	if err := e.collectDerived(d, s); err != nil {
		return 0, err
	}
	if s.Type == model.TxEstimate {
		if err := e.estimateOnSave(s.ID); err != nil {
			return 0, err
		}
	}
	if err := e.refreshDerived(d); err != nil {
		return 0, err
	}

	after, err := getTxn(ctx, tx, s.ID)
	if err != nil {
		return 0, err
	}
	action := "add"
	if old != nil {
		action = "modify"
	}
	if err := audit(ctx, tx, opt.User, action, after, before, after); err != nil {
		return 0, err
	}
	*t = *after
	return s.ID, nil
}

// staleTxn: the client saved a copy older than the stored transaction.
func staleTxn() error {
	return apperr.Conflict("Someone else changed this transaction after you opened it. Close it and open it again to see their changes.")
}

// CheckTxnStale refuses an operation on transaction id when the client's copy
// (its updatedAt, "" = not sent) is older than the stored one.
func CheckTxnStale(ctx context.Context, q store.Q, id int64, updatedAt string) error {
	updatedAt = strings.Trim(strings.TrimSpace(updatedAt), `"`)
	if updatedAt == "" {
		return nil
	}
	var cur string
	if err := q.QueryRowContext(ctx, `SELECT updated_at FROM txns WHERE id = ?`, id).Scan(&cur); err != nil {
		return nil
	}
	if cur != updatedAt {
		return staleTxn()
	}
	return nil
}

func audit(ctx context.Context, q store.Q, user, action string, t, before, after *model.Txn) error {
	return store.Audit(ctx, q, store.AuditEntry{
		User: user, Action: action, TxnID: t.ID, TxnType: t.Type, RefNumber: t.RefNumber, TxnDate: t.Date,
		Name: t.NameFull, Amount: store.Cents(t.Amount),
		Details: map[string]any{"before": before, "after": after},
	})
}

// ---------------------------------------------------------------------------
// Normalize: defaults, line kinds, group expansion, due date, numbers.

func (e *env) normalize(s *stxn, old *stxn) error {
	t := s.Type
	// fields that do not apply to the type
	if t != model.TxTransfer {
		s.ToAcctID = 0
	}
	if t != model.TxDeposit {
		s.CashBackAcctID, s.CashBackAmount, s.CashBackMemo = 0, 0, ""
	}
	if !typeIn(t, model.TxPayment, model.TxBillPayment, model.TxRefund) {
		s.ArApID = 0
	}
	if !isTaxForm(t) {
		s.TaxItemID = 0
	}
	if !typeIn(t, model.TxInvoice, model.TxSalesReceipt) {
		s.IsPending = false
	}
	if typeIn(t, model.TxEstimate, model.TxPurchaseOrder, model.TxJournal) {
		s.AccountID = 0
	}
	if typeIn(t, model.TxPayment, model.TxBillPayment, model.TxRefund, model.TxTransfer) {
		s.Lines = nil
	}

	// lines: kinds, empties, group expansion
	var lines []sline
	for _, l := range s.Lines {
		l.Description = strings.TrimRight(l.Description, " \t")
		switch {
		case t == model.TxJournal:
			l.Kind = model.LineJournal
		case t == model.TxDeposit:
			l.Kind = model.LineDeposit
		case isPurchaseForm(t):
			if l.ItemID != 0 {
				l.Kind = model.LineItem
			} else {
				l.Kind = model.LineExpense
			}
		default:
			l.Kind = model.LineItem
		}
		if l.Kind == model.LineExpense || l.Kind == model.LineJournal || l.Kind == model.LineDeposit {
			l.ItemID = 0
		}
		if l.Kind != model.LineDeposit {
			l.PayMethodID, l.RefNumber = 0, ""
			if !isSalesForm(t) && !isCostSource(t) {
				l.LinkedTxnID, l.LinkedLineID = 0, 0
			}
		}
		if t != model.TxPurchaseOrder {
			l.Closed = false
		}
		if !isCostSource(t) {
			l.Billable = false
		}
		if l.Billable && l.NameID == 0 {
			l.Billable = false
		}
		if lineEmpty(t, &l) {
			continue
		}
		it, err := e.item(l.ItemID)
		if err != nil {
			return err
		}
		if it != nil && it.Type == model.ItemGroup {
			exp, err := e.expandGroup(t, l, it)
			if err != nil {
				return err
			}
			lines = append(lines, exp...)
			continue
		}
		if it != nil && l.Kind == model.LineItem && l.ItemID != 0 && !isPurchaseForm(t) && t != model.TxPurchaseOrder {
			// sales item lines post through the item, never a free account
			l.AccountID = 0
		}
		if it != nil && isPurchaseForm(t) {
			l.AccountID = 0
		}
		if !(it != nil && (it.Type == model.ItemDiscount || it.Type == model.ItemOtherCharge)) {
			l.RateIsPercent = false
		}
		lines = append(lines, l)
	}
	for i := range lines {
		lines[i].Seq = i + 1
	}
	s.Lines = lines

	// header accounts
	var err error
	def := func(p *int64, code string) {
		if *p == 0 && err == nil {
			*p, err = e.specialAcct(code)
		}
	}
	switch t {
	case model.TxInvoice, model.TxCreditMemo, model.TxStatementCharge:
		def(&s.AccountID, store.SpecialAR)
	case model.TxPayment:
		def(&s.ArApID, store.SpecialAR)
		if s.AccountID == 0 {
			s.AccountID, err = e.defaultDepositAccount()
		}
	case model.TxSalesReceipt:
		if s.AccountID == 0 {
			s.AccountID, err = e.defaultDepositAccount()
		}
	case model.TxRefund:
		def(&s.ArApID, store.SpecialAR)
	case model.TxBill, model.TxVendorCredit, model.TxItemReceipt:
		def(&s.AccountID, store.SpecialAP)
	case model.TxBillPayment:
		def(&s.ArApID, store.SpecialAP)
		if s.AccountID == 0 {
			s.AccountID = or64(idOf(e.prefs.DefaultBillPayAccountID), idOf(e.prefs.DefaultCheckAccountID))
		}
	case model.TxCheck, model.TxSalesTaxPayment:
		if s.AccountID == 0 {
			s.AccountID = idOf(e.prefs.DefaultCheckAccountID)
		}
	}
	if err != nil {
		return err
	}
	if t == model.TxDeposit {
		uf, err := e.specialAcct(store.SpecialUndepositedFunds)
		if err != nil {
			return err
		}
		for i := range s.Lines {
			l := &s.Lines[i]
			if l.LinkedTxnID == 0 {
				continue
			}
			if l.AccountID == 0 {
				l.AccountID = uf
			}
			b, err := e.brief(l.LinkedTxnID)
			if err != nil {
				return err
			}
			if b != nil {
				if l.NameID == 0 {
					l.NameID = b.NameID
				}
				if l.PayMethodID == 0 || l.RefNumber == "" {
					var pm sql.NullInt64
					var ref string
					e.q.QueryRowContext(e.ctx, `SELECT payment_method_id, ref_number FROM txns WHERE id = ?`, b.ID).Scan(&pm, &ref)
					if l.PayMethodID == 0 {
						l.PayMethodID = ni(pm)
					}
					if l.RefNumber == "" {
						l.RefNumber = ref
					}
				}
			}
		}
	}

	// dates
	if s.Date != "" && !store.ValidDate(s.Date) {
		if d, ok := parseLooseDate(s.Date); ok {
			s.Date = d
		}
	}
	if typeIn(t, model.TxInvoice, model.TxStatementCharge, model.TxBill) && s.DueDate == "" && store.ValidDate(s.Date) {
		s.DueDate, err = e.dueDate(t, s.Date, s.TermsID)
		if err != nil {
			return err
		}
	}

	// numbers (opening balance documents stay unnumbered)
	if s.ID == 0 && s.Ref == "" && !s.openingBalance() {
		if s.Ref, err = autoRef(e.ctx, e.q, t, e.prefs); err != nil {
			return err
		}
	}
	if s.ID == 0 && t == model.TxItemReceipt && s.Memo == "" {
		s.Memo = receiptMemo
	}
	if t == model.TxBill && old != nil && old.Type == model.TxItemReceipt && s.Memo == receiptMemo {
		s.Memo = ""
	}
	if t == model.TxInvoice && s.Template == "" {
		s.Template = e.prefs.DefaultInvoiceTemplate
	}

	// statuses kept by the form
	switch t {
	case model.TxEstimate:
		switch s.Status {
		case "Pending", "Accepted", "Closed", "Rejected":
		default:
			s.Status = "Pending"
		}
	case model.TxPurchaseOrder:
		wasClosed := old != nil && old.Status == "Closed"
		if s.Status == "Closed" && !wasClosed {
			for i := range s.Lines {
				s.Lines[i].Closed = true
			}
		} else if s.Status == "Open" && wasClosed {
			for i := range s.Lines {
				s.Lines[i].Closed = false
			}
		}
	case model.TxInvoice, model.TxBill, model.TxStatementCharge:
		s.Status = "" // computed
	}
	return nil
}

// lineEmpty: a grid row the user left blank.
func lineEmpty(t string, l *sline) bool {
	noQty := l.Qty == nil || *l.Qty == 0
	switch l.Kind {
	case model.LineJournal, model.LineExpense:
		return l.AccountID == 0 && l.Amount == 0
	case model.LineDeposit:
		return l.AccountID == 0 && l.Amount == 0 && l.LinkedTxnID == 0
	}
	if l.ItemID != 0 || l.AccountID != 0 || l.Amount != 0 || l.LinkedLineID != 0 {
		return false
	}
	if isSalesForm(t) || t == model.TxPurchaseOrder {
		return l.Description == "" && noQty // description-only lines are kept on sales forms and POs
	}
	return true
}

// expandGroup replaces a Group item line by its member item lines.
func (e *env) expandGroup(t string, l sline, g *itemInfo) ([]sline, error) {
	ms, err := e.members(g)
	if err != nil {
		return nil, err
	}
	mult := 1.0
	if l.Qty != nil {
		mult = *l.Qty
	}
	purchase := isPurchaseForm(t) || t == model.TxPurchaseOrder
	var out []sline
	for _, m := range ms {
		mi, err := e.item(m.ItemID)
		if err != nil {
			return nil, err
		}
		if mi == nil || mi.Type == model.ItemGroup {
			continue
		}
		q := m.Qty * mult
		rate := mi.SalesPrice
		desc := mi.Description
		if purchase {
			rate, desc = mi.Cost, orStr(mi.PurchaseDescription, mi.Description)
		}
		n := l
		n.ID, n.ItemID, n.Description = 0, mi.ID, desc
		n.Qty, n.Rate = &q, &rate
		n.RateIsPercent = false
		n.Amount = rnd(q * rate * 100)
		n.Taxable = mi.Taxable && l.Taxable
		if !isSalesForm(t) {
			n.Taxable = false
		}
		out = append(out, n)
	}
	return out, nil
}

func (e *env) defaultDepositAccount() (int64, error) {
	if !e.prefs.UseUndepositedFunds && idOf(e.prefs.DefaultDepositAccountID) != 0 {
		return idOf(e.prefs.DefaultDepositAccountID), nil
	}
	return e.specialAcct(store.SpecialUndepositedFunds)
}

// dueDate computes the due date from the terms (or the bill default).
func (e *env) dueDate(t, date string, termsID int64) (string, error) {
	if termsID != 0 {
		var raw string
		err := e.q.QueryRowContext(e.ctx, `SELECT data FROM list_entries WHERE id = ? AND list = 'terms'`, termsID).Scan(&raw)
		if err == nil {
			var data map[string]any
			_ = json.Unmarshal([]byte(raw), &data)
			return termsDueDate(date, data), nil
		}
		if err != sql.ErrNoRows {
			return "", err
		}
	}
	if t == model.TxBill {
		return store.AddDays(date, e.prefs.BillsDueDays), nil
	}
	return date, nil
}

func numOf(m map[string]any, k string) float64 {
	switch v := m[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

// termsDueDate: standard terms → date + netDays; date driven → dueDay of the
// month, or of the next month when the date is past the due day or within
// dueNextMonthDays of it.
func termsDueDate(date string, data map[string]any) string {
	d, err := store.ParseDate(date)
	if err != nil {
		return date
	}
	if dd, _ := data["dateDriven"].(bool); !dd {
		return d.AddDate(0, 0, int(numOf(data, "netDays"))).Format("2006-01-02")
	}
	return dateDrivenDue(d, int(numOf(data, "dueDay")), int(numOf(data, "dueNextMonthDays"))).Format("2006-01-02")
}

// dateDrivenDue is the due date of date-driven terms (shared by the due date
// and the discount date): dueDay (default 1) of the transaction's month, or of
// the next month when the transaction is dated after the due day or within
// dueNextMonthDays days of it.
func dateDrivenDue(d time.Time, dueDay, within int) time.Time {
	if dueDay < 1 {
		dueDay = 1
	}
	due := dayOfMonth(d.Year(), d.Month(), dueDay)
	until := int(due.Sub(d).Hours() / 24)
	if until < 0 || (within > 0 && until <= within) {
		due = dayOfMonth(d.Year(), d.Month()+1, dueDay)
	}
	return due
}

func dayOfMonth(y int, m time.Month, day int) time.Time {
	first := time.Date(y, m, 1, 0, 0, 0, 0, time.UTC)
	last := first.AddDate(0, 1, -1).Day()
	if day > last {
		day = last
	}
	return time.Date(first.Year(), first.Month(), day, 0, 0, 0, 0, time.UTC)
}

// parseLooseDate accepts MM/DD/YYYY as a courtesy.
func parseLooseDate(s string) (string, bool) {
	for _, f := range []string{"01/02/2006", "1/2/2006"} {
		if t, err := time.Parse(f, s); err == nil {
			return t.Format("2006-01-02"), true
		}
	}
	return "", false
}

// autoRef returns the next number for types numbered automatically ("" otherwise).
func autoRef(ctx context.Context, q store.Q, typ string, p store.Prefs) (string, error) {
	switch typ {
	case model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxEstimate, model.TxPurchaseOrder:
	case model.TxJournal:
		if !p.AutoAssignJournalNumbers {
			return "", nil
		}
	default:
		return "", nil
	}
	var max sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT MAX(CAST(ref_number AS INTEGER)) FROM txns WHERE type = ? AND ref_number <> ''
		AND ref_number NOT GLOB '*[^0-9]*' AND LENGTH(ref_number) <= 18`, typ).Scan(&max)
	if err != nil {
		return "", err
	}
	if !max.Valid {
		return "1", nil
	}
	return strconv.FormatInt(max.Int64+1, 10), nil
}

// AutoRefNumber returns the number the ledger gives a new transaction of
// txnType saved with a blank refNumber: INV, SALESRCPT, CREDMEM, EST and
// PURCHORD (and GENJRNL when prefs.autoAssignJournalNumbers) use their own
// sequence = largest numeric ref of that type + 1 ("1" when none). Other
// types return "".
func AutoRefNumber(ctx context.Context, q store.Q, txnType string) (string, error) {
	p, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return "", err
	}
	return autoRef(ctx, q, txnType, p)
}

// ---------------------------------------------------------------------------
// Compute: subtotal / percent lines, sales tax, totals.

func (e *env) compute(s *stxn, oldPost *oldPosting, old *stxn) error {
	if isSalesForm(s.Type) || isPurchaseForm(s.Type) || s.Type == model.TxPurchaseOrder {
		var sinceSub, prev int64
		for i := range s.Lines {
			l := &s.Lines[i]
			it, err := e.item(l.ItemID)
			if err != nil {
				return err
			}
			if it != nil && it.Type == model.ItemSubtotal {
				l.Amount, l.Qty, l.Rate, l.Taxable = sinceSub, nil, nil, false
				sinceSub, prev = 0, l.Amount
				continue
			}
			if it != nil && l.RateIsPercent {
				rate := it.SalesPrice
				if l.Rate != nil {
					rate = *l.Rate
				}
				a := rnd(float64(prev) * rate / 100)
				if it.Type == model.ItemDiscount {
					a = -abs64(a)
				}
				l.Amount = a
			}
			sinceSub += l.Amount
			prev = l.Amount
		}
	}
	if isTaxForm(s.Type) {
		s.TaxRate, s.TaxAmount = 0, 0
		split := ""
		if e.prefs.SalesTaxEnabled && s.TaxItemID != 0 {
			if old != nil && old.TaxItemID == s.TaxItemID && (old.TaxSplit != "" || old.TaxRate != 0) {
				// an existing transaction keeps the tax rate it was entered with
				// (changing a tax item's rate does not change old sales)
				s.TaxRate, split = old.TaxRate, old.TaxSplit
			} else {
				it, err := e.item(s.TaxItemID)
				if err != nil {
					return err
				}
				if s.TaxRate, err = e.taxRateOf(it); err != nil {
					return err
				}
				if split, err = e.currentTaxSplit(it); err != nil {
					return err
				}
			}
			base, err := e.taxableBase(s)
			if err != nil {
				return err
			}
			s.TaxAmount = rnd(float64(base) * s.TaxRate / 100)
		}
		s.TaxSplit = split
	}
	if s.Type == model.TxInventoryAdjust && !s.valueAdjust() {
		// quantity-only adjustment: the value is computed by re-costing
		for i := range s.Lines {
			s.Lines[i].Amount = oldPost.moveVals[s.Lines[i].ID]
		}
	}
	return e.sumTotals(s)
}

// taxableBase: sum of taxable lines (Subtotal, Payment and sales tax lines excluded).
func (e *env) taxableBase(s *stxn) (int64, error) {
	var base int64
	for _, l := range s.Lines {
		if !l.Taxable {
			continue
		}
		switch e.itemType(l.ItemID) {
		case model.ItemSubtotal, model.ItemPayment, model.ItemSalesTax, model.ItemSalesTaxGroup:
			continue
		}
		base += l.Amount
	}
	return base, nil
}

// sumTotals sets Subtotal and Amount from the stored line amounts (used by
// Save after compute and by Rebuild, so posting always matches the header).
func (e *env) sumTotals(s *stxn) error {
	switch {
	case isSalesForm(s.Type):
		var sub, pay int64
		for _, l := range s.Lines {
			it, err := e.item(l.ItemID)
			if err != nil {
				return err
			}
			switch {
			case it != nil && it.Type == model.ItemSubtotal:
			case it != nil && it.Type == model.ItemPayment:
				pay += l.Amount
			default:
				sub += l.Amount
			}
		}
		s.Subtotal = sub
		s.Amount = sub + s.TaxAmount + pay
	case isPurchaseForm(s.Type) || s.Type == model.TxPurchaseOrder:
		var total int64
		for _, l := range s.Lines {
			if e.itemType(l.ItemID) != model.ItemSubtotal {
				total += l.Amount
			}
		}
		s.Subtotal, s.Amount = 0, total
	case s.Type == model.TxDeposit:
		var total int64
		for _, l := range s.Lines {
			total += l.Amount
		}
		s.Amount = total - s.CashBackAmount
	case s.Type == model.TxJournal:
		var debits int64
		for _, l := range s.Lines {
			if l.Amount > 0 {
				debits += l.Amount
			}
		}
		s.Amount = debits
	case s.Type == model.TxInventoryAdjust:
		var total int64
		for _, l := range s.Lines {
			total += l.Amount
		}
		s.Amount = total
	case s.Type == model.TxSalesTaxPayment:
		if len(s.Lines) > 0 {
			var total int64
			for _, l := range s.Lines {
				total += l.Amount
			}
			s.Amount = total
		}
	}
	if s.Voided {
		s.Amount, s.Subtotal, s.TaxAmount, s.CashBackAmount, s.OpenBalance = 0, 0, 0, 0, 0
		for i := range s.Lines {
			s.Lines[i].Amount = 0
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Writes

func (e *env) writeHeader(s *stxn, isNew bool) error {
	extra := "{}"
	if len(s.Extra) > 0 {
		if b, err := json.Marshal(s.Extra); err == nil {
			extra = string(b)
		}
	}
	now := store.Stamp()
	args := []any{s.Type, s.Ref, s.Date, nz(s.NameID), nz(s.AccountID), nz(s.ArApID), nz(s.ToAcctID), s.Amount,
		s.DueDate, s.ShipDate, nz(s.TermsID), nz(s.ClassID), nz(s.RepID), nz(s.ShipViaID), nz(s.CustMsgID),
		nz(s.PayMethodID), s.FOB, s.PONumber, s.Memo, s.BillAddress, s.ShipAddress, nz(s.TaxItemID), s.TaxRate,
		s.TaxAmount, s.Subtotal, store.B(s.ToBePrinted), store.B(s.ToBeEmailed), store.B(s.IsPending), s.Status,
		store.B(s.Voided), nz(s.CashBackAcctID), s.CashBackAmount, s.CashBackMemo, s.Template, extra, s.TaxSplit}
	if isNew {
		// never reuse the id of a deleted transaction (the audit trail refers to it)
		var maxTxn, maxAudit sql.NullInt64
		if err := e.q.QueryRowContext(e.ctx, `SELECT MAX(id) FROM txns`).Scan(&maxTxn); err != nil {
			return err
		}
		if err := e.q.QueryRowContext(e.ctx, `SELECT MAX(txn_id) FROM audit_log`).Scan(&maxAudit); err != nil {
			return err
		}
		id := maxTxn.Int64
		if maxAudit.Int64 > id {
			id = maxAudit.Int64
		}
		s.ID = id + 1
		s.CreatedBy, s.CreatedAt, s.UpdatedAt = store.ActingUser(e.ctx, e.opt.User), now, now
		_, err := e.q.ExecContext(e.ctx, `INSERT INTO txns(id, type, ref_number, date, name_id, account_id, ar_ap_account_id,
			to_account_id, amount, due_date, ship_date, terms_id, class_id, rep_id, ship_via_id, customer_message_id,
			payment_method_id, fob, po_number, memo, bill_address, ship_address, tax_item_id, tax_rate, tax_amount,
			subtotal, to_be_printed, to_be_emailed, is_pending, status, voided, cash_back_account_id, cash_back_amount,
			cash_back_memo, template, extra, tax_split, created_by, created_at, updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			append(append([]any{s.ID}, args...), s.CreatedBy, now, now)...)
		return err
	}
	s.UpdatedAt = now
	_, err := e.q.ExecContext(e.ctx, `UPDATE txns SET type=?, ref_number=?, date=?, name_id=?, account_id=?, ar_ap_account_id=?,
		to_account_id=?, amount=?, due_date=?, ship_date=?, terms_id=?, class_id=?, rep_id=?, ship_via_id=?,
		customer_message_id=?, payment_method_id=?, fob=?, po_number=?, memo=?, bill_address=?, ship_address=?,
		tax_item_id=?, tax_rate=?, tax_amount=?, subtotal=?, to_be_printed=?, to_be_emailed=?, is_pending=?, status=?,
		voided=?, cash_back_account_id=?, cash_back_amount=?, cash_back_memo=?, template=?, extra=?, tax_split=?, updated_at=?
		WHERE id = ?`, append(args, now, s.ID)...)
	return err
}

// writeLines updates lines the client sent back with their id (so links from
// other transactions to them survive), inserts new ones and deletes removed ones.
func (e *env) writeLines(s *stxn, old *stxn, cogsInit map[int]int64) error {
	oldIDs := map[int64]bool{}
	if old != nil {
		for _, l := range old.Lines {
			oldIDs[l.ID] = true
		}
	}
	kept := map[int64]bool{}
	for i := range s.Lines {
		l := &s.Lines[i]
		l.Seq = i + 1
		l.Cogs = cogsInit[i]
		args := []any{l.Seq, l.Kind, nz(l.ItemID), nz(l.AccountID), l.Description, nf(l.Qty), nf(l.Rate),
			store.B(l.RateIsPercent), l.Amount, nz(l.ClassID), nz(l.NameID), store.B(l.Billable), store.B(l.Taxable),
			l.ServiceDate, nz(l.PayMethodID), l.RefNumber, nz(l.LinkedTxnID), nz(l.LinkedLineID), store.B(l.Closed), l.Cogs}
		if l.ID != 0 && oldIDs[l.ID] && !kept[l.ID] {
			kept[l.ID] = true
			if _, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET seq=?, kind=?, item_id=?, account_id=?, description=?,
				qty=?, rate=?, rate_is_percent=?, amount=?, class_id=?, name_id=?, billable=?, taxable=?, service_date=?,
				payment_method_id=?, ref_number=?, linked_txn_id=?, linked_line_id=?, closed=?, cogs=?
				WHERE id = ? AND txn_id = ?`, append(args, l.ID, s.ID)...); err != nil {
				return err
			}
			continue
		}
		res, err := e.q.ExecContext(e.ctx, `INSERT INTO txn_lines(seq, kind, item_id, account_id, description, qty, rate,
			rate_is_percent, amount, class_id, name_id, billable, taxable, service_date, payment_method_id, ref_number,
			linked_txn_id, linked_line_id, closed, cogs, txn_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			append(args, s.ID)...)
		if err != nil {
			return err
		}
		if l.ID, err = res.LastInsertId(); err != nil {
			return err
		}
	}
	for id := range oldIDs {
		if !kept[id] {
			if _, err := e.q.ExecContext(e.ctx, `DELETE FROM txn_lines WHERE id = ? AND txn_id = ?`, id, s.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeLinks replaces the links owned by s.
func (e *env) writeLinks(s *stxn) error {
	if _, err := e.q.ExecContext(e.ctx, `DELETE FROM txn_links WHERE owner_txn_id = ?`, s.ID); err != nil {
		return err
	}
	if s.Voided || s.IsPending {
		s.Links = nil
	}
	for i := range s.Links {
		l := &s.Links[i]
		from := l.From
		if from == 0 {
			from = s.ID
		}
		var da any
		if l.Discount != 0 {
			da = nz(l.DiscAcctID)
		}
		res, err := e.q.ExecContext(e.ctx, `INSERT INTO txn_links(from_txn_id, to_txn_id, owner_txn_id, amount, discount,
			discount_account_id, date) VALUES(?,?,?,?,?,?,?)`, from, l.To, s.ID, l.Amount, l.Discount, da, s.Date)
		if err != nil {
			return err
		}
		l.ID, _ = res.LastInsertId()
		l.Owner, l.Date = s.ID, s.Date
	}
	return nil
}

type depLine struct {
	lineID, depID, ufID int64
	srcLine             int64 // payment-item line deposited (0: the whole payment / sales receipt)
	amount, newAmount   int64 // deposited amount; amount waiting after the change (srcLine only)
}

// depositLinesOf returns the lines of (non-voided) deposits that contain txnID
// or one of its payment-item lines.
func (e *env) depositLinesOf(txnID int64) ([]depLine, error) {
	uf, err := e.specialAcct(store.SpecialUndepositedFunds)
	if err != nil {
		return nil, err
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT l.id, l.txn_id, IFNULL(l.linked_line_id, 0), l.amount FROM txn_lines l JOIN txns d ON d.id = l.txn_id
		WHERE l.linked_txn_id = ? AND d.type = 'DEP' AND d.voided = 0`, txnID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []depLine
	for rows.Next() {
		var dl depLine
		if err := rows.Scan(&dl.lineID, &dl.depID, &dl.srcLine, &dl.amount); err != nil {
			return nil, err
		}
		dl.ufID = uf
		out = append(out, dl)
	}
	return out, rows.Err()
}

// ufLineAmount is what a line of s posts to Undeposited Funds (the amount a
// deposit of that payment-item line takes); 0 when the line is gone.
func ufLineAmount(s *stxn, post *posting, lineID, uf int64) int64 {
	if s.Voided || s.IsPending {
		return 0
	}
	var amt int64
	for _, en := range post.entries {
		if en.lineIdx >= 0 && en.lineIdx < len(s.Lines) && s.Lines[en.lineIdx].ID == lineID && en.AccountID == uf {
			amt += en.Amount
		}
	}
	return amt
}

// repost re-posts a stored transaction after one of its lines or links was
// changed by another transaction (deposits, payments losing a link).
func (e *env) repost(id int64) error {
	s, err := loadStored(e.ctx, e.q, id)
	if err != nil {
		return err
	}
	amount, sub := s.Amount, s.Subtotal
	if err := e.sumTotals(s); err != nil {
		return err
	}
	if amount != s.Amount || sub != s.Subtotal {
		if _, err := e.q.ExecContext(e.ctx, `UPDATE txns SET amount = ?, subtotal = ?, updated_at = ? WHERE id = ?`,
			s.Amount, s.Subtotal, store.Stamp(), id); err != nil {
			return err
		}
	}
	oldPost, err := e.loadOldPosting(id)
	if err != nil {
		return err
	}
	post, err := e.buildPosting(s, oldPost)
	if err != nil {
		return err
	}
	post.bindLines(s)
	items, err := e.writePosting(s, post, oldPost)
	if err != nil {
		return err
	}
	if err := e.recost(items, s.Date); err != nil {
		return err
	}
	return e.refreshOpen([]int64{id})
}
