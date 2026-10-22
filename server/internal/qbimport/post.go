package qbimport

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// built is a transaction ready to be saved.
type built struct {
	t         *model.Txn
	lines     []int      // file line of the split behind each line of t
	temp      []tempAcct // item accounts set while saving (see save)
	clear     []int64    // accounts whose entries are marked cleared
	journal   bool       // entered as a general journal entry instead of its own form
	reason    string     // why it is a journal entry
	dropped   int64      // cost of goods sold lines left out (SerieX computes them)
	assetNote string
}

// tempAcct: while the transaction is saved, the item posts to acct. The
// ledger keeps the account a line was posted to (as QuickBooks keeps the
// accounts of recorded transactions when an item's account changes), so a
// line whose QuickBooks account differs from the item's account today keeps
// the QuickBooks account, also when the company file is rebuilt.
type tempAcct struct {
	item int64
	col  string
	acct int64
}

// fallback: the transaction cannot be entered on its own form; it is entered
// as a general journal entry with the same accounts and amounts.
type fallback struct{ reason string }

func (f fallback) Error() string { return f.reason }

// fail: the transaction cannot be imported at all.
type fail struct {
	line int
	msg  string
}

func (f fail) Error() string { return f.msg }

func dollars(c int64) float64 { return store.Dollars(c) }

func absC(c int64) int64 {
	if c < 0 {
		return -c
	}
	return c
}

func sgn(c int64) float64 {
	if c < 0 {
		return -1
	}
	return 1
}

// label describes a transaction of the file for messages: "INVOICE #1001 of 03/02/2026".
func (t *srcTxn) label() string {
	s := orStr(t.RawType, "Transaction")
	if t.Head.DocNum != "" {
		s += " #" + t.Head.DocNum
	}
	return s + " of " + fmtDate(t.Date)
}

func (im *importer) needAcct(s srcSplit) (int64, *acctData, error) {
	id, why := im.accountID(s.Accnt)
	if id == 0 {
		return 0, nil, fail{s.Line, why}
	}
	return id, im.acct(id), nil
}

// header fills the fields every form shares.
func (im *importer) header(t *srcTxn, typ string) (*model.Txn, error) {
	ref := t.Head.DocNum
	if len([]rune(ref)) > 20 {
		im.problem("iif", t.Line, levelNote, "%s: the number is longer than 20 characters and was shortened.", t.label())
		ref = string([]rune(ref)[:20])
	}
	m := &model.Txn{Type: typ, Date: t.Date, RefNumber: ref, Memo: t.Head.Memo}
	m.ClassID = im.listRef(model.ListClass, t.Head.Class, t.Line)
	return m, nil
}

// lineQtyRate sets the quantity and rate of an item line from the split.
func lineQtyRate(l *model.TxnLine, s srcSplit) {
	if s.Qty == nil || *s.Qty == 0 {
		return
	}
	q := math.Abs(*s.Qty)
	if l.Amount < 0 {
		q = -q
	}
	l.Qty = &q
	var rate float64
	if s.Price != nil {
		rate = math.Abs(*s.Price)
		if l.Amount < 0 && q > 0 {
			rate = -rate
		}
	}
	// the ledger checks amount = quantity x rate
	if s.Price == nil || math.Abs(q*rate*100-l.Amount*100) > 0.5+math.Abs(q)*0.0005 {
		rate = math.Round(l.Amount/q*100000) / 100000
		if math.Abs(q*rate*100-l.Amount*100) > 0.5+math.Abs(q)*0.0005 {
			l.Qty = nil
			return
		}
	}
	l.Rate = &rate
}

// salesAccountOf is the account an item posts to on sales forms today.
func (im *importer) salesAccountOf(it *itemData) (int64, string) {
	switch it.typ {
	case model.ItemPayment:
		if it.deposit != 0 {
			return it.deposit, "deposit_account_id"
		}
		id, _ := im.special(store.SpecialUndepositedFunds)
		return id, "deposit_account_id"
	}
	if it.income != 0 {
		return it.income, "income_account_id"
	}
	return it.expense, "expense_account_id"
}

// purchaseAccountOf is the account an item posts to on purchase forms today.
func purchaseAccountOf(it *itemData) (int64, string) {
	if it.typ == model.ItemInventoryPart {
		return it.asset, "asset_account_id"
	}
	if it.expense != 0 {
		return it.expense, "expense_account_id"
	}
	return it.income, "income_account_id"
}

// ---------------------------------------------------------------------------
// Sales forms: invoices, credit memos, sales receipts, statement charges

func (im *importer) buildSales(t *srcTxn, kind string) (*built, error) {
	headID, head, err := im.needAcct(t.Head)
	if err != nil {
		return nil, err
	}
	amt := t.Head.Amount // + debit
	switch kind {
	case model.TxInvoice, model.TxStatementCharge:
		if amt < 0 {
			kind = model.TxCreditMemo
		}
	case model.TxCreditMemo:
		if amt > 0 {
			kind = model.TxInvoice
		}
	case model.TxSalesReceipt:
		if amt < 0 {
			return nil, fallback{"a sales receipt cannot have a negative total"}
		}
	}
	if kind == model.TxSalesReceipt {
		if head.typ != model.AcctBank && head.typ != model.AcctOCA {
			return nil, fallback{fmt.Sprintf("a sales receipt is deposited to a bank or other current asset account, not to %s", head.name)}
		}
	} else if head.typ != model.AcctAR {
		return nil, fallback{fmt.Sprintf("%s is not an Accounts Receivable account", head.name)}
	}
	m, _ := im.header(t, kind)
	m.AccountID = ptr(headID)
	if t.Head.Name != "" {
		id, why := im.nameID(t.Head.Name)
		if id == 0 {
			return nil, fail{t.Line, why}
		}
		if im.kindOf(id) != model.NameCustomer {
			return nil, fallback{fmt.Sprintf("%s is not a customer", t.Head.Name)}
		}
		m.NameID = ptr(id)
	} else if kind != model.TxSalesReceipt {
		return nil, fail{t.Line, "no customer is given"}
	}
	sign := int64(1)
	if kind == model.TxCreditMemo {
		sign = -1
	}
	b := &built{t: m}
	stp, _ := im.special(store.SpecialSalesTaxPayable)
	var dropped int64
	for _, s := range t.Splits {
		var acctID int64
		var at *acctData
		if s.Accnt != "" {
			if acctID, at, err = im.needAcct(s); err != nil {
				return nil, err
			}
			switch at.typ {
			case model.AcctAR, model.AcctAP:
				return nil, fallback{fmt.Sprintf("a line posts to %s", at.name)}
			case model.AcctNonPosting:
				return nil, fallback{fmt.Sprintf("a line posts to the non-posting account %s", at.name)}
			}
		}
		itemID, _, why := im.itemID(s.Item)
		if why != "" {
			return nil, fail{s.Line, why}
		}
		it := im.item(itemID)
		// cost of goods sold of inventory sales: SerieX computes it from the average cost
		if it != nil && it.typ == model.ItemInventoryPart && acctID != 0 && (acctID == it.expense || acctID == it.asset || at.typ == model.AcctCOGS ||
			at.special == store.SpecialInventoryAsset) {
			dropped += s.Amount
			b.dropped += absC(s.Amount)
			continue
		}
		l := model.TxnLine{Amount: dollars(-sign * s.Amount), Description: s.Memo, Taxable: s.Taxable, ServiceDate: s.ServiceDate}
		l.ClassID = im.listRef(model.ListClass, s.Class, s.Line)
		accountLine := func() error {
			if acctID == 0 {
				return fail{s.Line, "the line has no account"}
			}
			l.ItemID = nil
			l.AccountID = ptr(acctID)
			if s.Item != "" && !strings.Contains(strings.ToLower(l.Description), strings.ToLower(lastPart(s.Item))) {
				l.Description = strings.TrimSpace(lastPart(s.Item) + " " + l.Description)
			}
			return nil
		}
		switch {
		case it == nil:
			if err := accountLine(); err != nil {
				return nil, err
			}
		case it.typ == model.ItemSubtotal:
			if s.Amount == 0 {
				continue
			}
			if err := accountLine(); err != nil {
				return nil, err
			}
		case it.typ == model.ItemGroup || it.typ == model.ItemSalesTaxGroup:
			if err := accountLine(); err != nil {
				return nil, err
			}
		case it.typ == model.ItemSalesTax:
			if acctID != 0 && acctID != stp {
				if err := accountLine(); err != nil {
					return nil, err
				}
				break
			}
			l.ItemID = ptr(itemID)
			l.Taxable = false
		default:
			l.ItemID = ptr(itemID)
			cur, col := im.salesAccountOf(it)
			if acctID != 0 && acctID != cur {
				b.temp = append(b.temp, tempAcct{itemID, col, acctID})
			}
			lineQtyRate(&l, s)
		}
		m.Lines = append(m.Lines, l)
		b.lines = append(b.lines, s.Line)
	}
	if dropped != 0 {
		return nil, fallback{"its cost of goods sold lines do not balance"}
	}
	if len(m.Lines) == 0 {
		return nil, fallback{"it has no lines SerieX Books can enter on the form"}
	}
	if err := conflictingTemps(b); err != nil {
		return nil, err
	}
	m.DueDate, m.ShipDate, m.FOB, m.PONumber = t.DueDate, t.ShipDate, t.FOB, t.PONum
	m.TermsID = im.listRef(model.ListTerms, t.Terms, t.Line)
	m.RepID = im.listRef(model.ListSalesRep, t.Rep, t.Line)
	m.ShipViaID = im.listRef(model.ListShipVia, t.ShipVia, t.Line)
	if kind != model.TxStatementCharge {
		m.CustomerMessageID = im.listRef(model.ListCustomerMessage, t.CustMsg, t.Line)
	}
	m.BillAddress, m.ShipAddress, m.ToBePrinted = t.BillAddr, t.ShipAddr, t.ToPrint
	if kind == model.TxSalesReceipt {
		m.PaymentMethodID = im.listRef(model.ListPaymentMethod, t.Head.PayMeth, t.Line)
	}
	if kind == model.TxCreditMemo || kind == model.TxStatementCharge {
		m.ShipDate, m.ShipViaID, m.FOB = "", nil, ""
		if kind == model.TxCreditMemo {
			m.DueDate, m.TermsID = "", nil
		}
	}
	b.clear = im.clearedAccounts(t)
	return b, nil
}

func lastPart(full string) string {
	ps := splitFull(full)
	if len(ps) == 0 {
		return full
	}
	return ps[len(ps)-1]
}

// conflictingTemps: two lines of the same item that need different accounts
// cannot be entered with that item; the transaction becomes a journal entry.
func conflictingTemps(b *built) error {
	seen := map[[2]any]int64{}
	for _, x := range b.temp {
		k := [2]any{x.item, x.col}
		if a, ok := seen[k]; ok && a != x.acct {
			return fallback{"one item is posted to two different accounts"}
		}
		seen[k] = x.acct
	}
	return nil
}

// clearedAccounts are the bank and credit card accounts of splits marked cleared.
func (im *importer) clearedAccounts(t *srcTxn) []int64 {
	var out []int64
	for _, s := range append([]srcSplit{t.Head}, t.Splits...) {
		if !s.Clear {
			continue
		}
		id, _ := im.accountID(s.Accnt)
		if a := im.acct(id); a != nil && model.IsBalanceSheet(a.typ) && a.typ != model.AcctAR && a.typ != model.AcctAP {
			out = append(out, id)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Purchase forms: checks, bills, vendor credits, credit card charges and credits, item receipts

func (im *importer) buildPurchase(t *srcTxn, kind string) (*built, error) {
	headID, head, err := im.needAcct(t.Head)
	if err != nil {
		return nil, err
	}
	amt := t.Head.Amount // checks, bills and charges credit the header account
	switch kind {
	case model.TxCheck:
		if head.typ == model.AcctCreditCard {
			kind = model.TxCCCharge
			if amt > 0 {
				kind = model.TxCCCredit
			}
		} else if amt > 0 {
			return nil, fallback{"a check cannot have a negative amount"}
		}
	case model.TxBill, model.TxVendorCredit:
		kind = model.TxBill
		if amt > 0 {
			kind = model.TxVendorCredit
		}
	case model.TxCCCharge, model.TxCCCredit:
		kind = model.TxCCCharge
		if amt > 0 {
			kind = model.TxCCCredit
		}
	case model.TxItemReceipt:
		if amt > 0 {
			return nil, fallback{"an item receipt cannot have a negative total"}
		}
	}
	want := map[string]string{model.TxCheck: model.AcctBank, model.TxBill: model.AcctAP, model.TxVendorCredit: model.AcctAP,
		model.TxItemReceipt: model.AcctAP, model.TxCCCharge: model.AcctCreditCard, model.TxCCCredit: model.AcctCreditCard}[kind]
	if head.typ != want {
		return nil, fallback{fmt.Sprintf("%s is not a %s account", head.name, want)}
	}
	m, _ := im.header(t, kind)
	m.AccountID = ptr(headID)
	vendorForm := kind == model.TxBill || kind == model.TxVendorCredit || kind == model.TxItemReceipt
	var headName int64
	if t.Head.Name != "" {
		id, why := im.nameID(t.Head.Name)
		if id == 0 {
			return nil, fail{t.Line, why}
		}
		if vendorForm && im.kindOf(id) != model.NameVendor {
			return nil, fallback{fmt.Sprintf("%s is not a vendor", t.Head.Name)}
		}
		m.NameID = ptr(id)
		headName = id
	} else if vendorForm {
		return nil, fail{t.Line, "no vendor is given"}
	}
	sign := int64(1)
	if kind == model.TxVendorCredit || kind == model.TxCCCredit {
		sign = -1
	}
	b := &built{t: m}
	stp, _ := im.special(store.SpecialSalesTaxPayable)
	for _, s := range t.Splits {
		acctID, at, err := im.needAcct(s)
		if err != nil && s.Item == "" {
			return nil, err
		}
		if at != nil {
			switch at.typ {
			case model.AcctAR, model.AcctAP:
				return nil, fallback{fmt.Sprintf("a line posts to %s", at.name)}
			case model.AcctNonPosting:
				return nil, fallback{fmt.Sprintf("a line posts to the non-posting account %s", at.name)}
			}
		}
		itemID, _, why := im.itemID(s.Item)
		if why != "" {
			return nil, fail{s.Line, why}
		}
		it := im.item(itemID)
		l := model.TxnLine{Amount: dollars(sign * s.Amount), Description: s.Memo, ServiceDate: s.ServiceDate}
		l.ClassID = im.listRef(model.ListClass, s.Class, s.Line)
		if s.Name != "" && !strings.EqualFold(s.Name, t.Head.Name) {
			if id, _ := im.nameID(s.Name); id != 0 && id != headName && im.kindOf(id) == model.NameCustomer {
				l.NameID = ptr(id)
				l.Billable = s.Billable
			}
		}
		expenseLine := func() error {
			if acctID == 0 {
				return fail{s.Line, "the line has no account"}
			}
			l.Kind = model.LineExpense
			l.ItemID, l.AccountID = nil, ptr(acctID)
			if s.Item != "" && !strings.Contains(strings.ToLower(l.Description), strings.ToLower(lastPart(s.Item))) {
				l.Description = strings.TrimSpace(lastPart(s.Item) + " " + l.Description)
			}
			return nil
		}
		switch {
		case it == nil, it.typ == model.ItemPayment, it.typ == model.ItemGroup, it.typ == model.ItemSalesTaxGroup, it.typ == model.ItemDiscount:
			if err := expenseLine(); err != nil {
				return nil, err
			}
		case it.typ == model.ItemSubtotal:
			if s.Amount == 0 {
				continue
			}
			if err := expenseLine(); err != nil {
				return nil, err
			}
		case it.typ == model.ItemSalesTax:
			if acctID != 0 && acctID != stp {
				if err := expenseLine(); err != nil {
					return nil, err
				}
				break
			}
			l.Kind, l.ItemID = model.LineItem, ptr(itemID)
		case it.typ == model.ItemInventoryPart:
			l.Kind, l.ItemID = model.LineItem, ptr(itemID)
			if acctID != 0 && acctID != it.asset {
				b.assetNote = fmt.Sprintf("the inventory item %s posts to its inventory asset account %s instead of %s", it.name, im.acct(it.asset).name, at.name)
			}
			lineQtyRate(&l, s)
		default:
			l.Kind, l.ItemID = model.LineItem, ptr(itemID)
			cur, col := purchaseAccountOf(it)
			if acctID != 0 && acctID != cur {
				b.temp = append(b.temp, tempAcct{itemID, col, acctID})
			}
			lineQtyRate(&l, s)
		}
		m.Lines = append(m.Lines, l)
		b.lines = append(b.lines, s.Line)
	}
	if len(m.Lines) == 0 {
		return nil, fallback{"it has no lines SerieX Books can enter on the form"}
	}
	if err := conflictingTemps(b); err != nil {
		return nil, err
	}
	if kind == model.TxBill {
		m.DueDate = t.DueDate
		m.TermsID = im.listRef(model.ListTerms, t.Terms, t.Line)
	}
	if kind == model.TxCheck {
		m.ToBePrinted = t.ToPrint
		m.BillAddress = t.BillAddr
	}
	b.clear = im.clearedAccounts(t)
	return b, nil
}

// ---------------------------------------------------------------------------
// Deposits

func (im *importer) buildDeposit(t *srcTxn) (*built, error) {
	headID, head, err := im.needAcct(t.Head)
	if err != nil {
		return nil, err
	}
	if t.Head.Amount < 0 {
		return nil, fallback{"the deposit total is negative"}
	}
	if (head.typ != model.AcctBank && head.typ != model.AcctOCA) || head.special == store.SpecialUndepositedFunds {
		return nil, fallback{fmt.Sprintf("money cannot be deposited to %s", head.name)}
	}
	m, _ := im.header(t, model.TxDeposit)
	m.AccountID = ptr(headID)
	if t.Head.Name != "" {
		if id, _ := im.nameID(t.Head.Name); id != 0 {
			m.NameID = ptr(id)
		}
	}
	uf, _ := im.special(store.SpecialUndepositedFunds)
	b := &built{t: m}
	used := map[int64]bool{}
	for _, s := range t.Splits {
		acctID, at, err := im.needAcct(s)
		if err != nil {
			return nil, err
		}
		switch at.typ {
		case model.AcctAR, model.AcctAP, model.AcctNonPosting:
			return nil, fallback{fmt.Sprintf("a line posts to %s", at.name)}
		}
		if s.Amount > 0 {
			if m.CashBackAccountID != nil {
				return nil, fallback{"it has more than one cash back line"}
			}
			m.CashBackAccountID, m.CashBackAmount, m.CashBackMemo = ptr(acctID), dollars(s.Amount), s.Memo
			continue
		}
		l := model.TxnLine{Kind: model.LineDeposit, AccountID: ptr(acctID), Amount: dollars(-s.Amount), Description: s.Memo, RefNumber: s.DocNum}
		l.ClassID = im.listRef(model.ListClass, s.Class, s.Line)
		l.PaymentMethodID = im.listRef(model.ListPaymentMethod, s.PayMeth, s.Line)
		var nameID int64
		if s.Name != "" {
			nameID, _ = im.nameID(s.Name)
			l.NameID = ptr(nameID)
		}
		if acctID == uf && s.Amount < 0 {
			if pid, err := im.waitingPayment(uf, -s.Amount, nameID, t.Date, used); err != nil {
				return nil, err
			} else if pid != 0 {
				used[pid] = true
				l.LinkedTxnID = ptr(pid)
				l.RefNumber = ""
				l.PaymentMethodID = nil
				im.linked++
			}
		}
		if len([]rune(l.RefNumber)) > 20 {
			l.RefNumber = string([]rune(l.RefNumber)[:20])
		}
		m.Lines = append(m.Lines, l)
		b.lines = append(b.lines, s.Line)
	}
	if len(m.Lines) == 0 {
		return nil, fallback{"it has no deposit lines"}
	}
	b.clear = im.clearedAccounts(t)
	return b, nil
}

// waitingPayment finds a payment or sales receipt of this amount waiting in
// Undeposited Funds (the name's own first, then the oldest). The import
// keeps the list of those it entered (ufWaiting).
func (im *importer) waitingPayment(uf, amount, nameID int64, date string, used map[int64]bool) (int64, error) {
	var any0, same int64
	for _, w := range im.ufWaiting[amount] {
		if used[w.id] || w.date > date {
			continue
		}
		if any0 == 0 {
			any0 = w.id
		}
		if nameID != 0 && w.nameID == nameID && same == 0 {
			same = w.id
		}
	}
	if same != 0 {
		return same, nil
	}
	if nameID != 0 {
		// a different name received the payment: only the name's own count
		return 0, nil
	}
	return any0, nil
}

// waiting is a payment or sales receipt the import put in Undeposited Funds.
type waiting struct {
	id, nameID int64
	date       string
}

// noteWaiting records a saved payment or sales receipt received into
// Undeposited Funds, and forgets the ones a saved deposit took out.
func (im *importer) noteWaiting(b *built, id int64) {
	t := b.t
	uf, _ := im.special(store.SpecialUndepositedFunds)
	switch t.Type {
	case model.TxPayment, model.TxSalesReceipt:
		if t.AccountID != nil && *t.AccountID == uf {
			amt := store.Cents(t.Amount)
			var name int64
			if t.NameID != nil {
				name = *t.NameID
			}
			im.ufWaiting[amt] = append(im.ufWaiting[amt], waiting{id, name, t.Date})
		}
	case model.TxDeposit:
		for _, l := range t.Lines {
			if l.LinkedTxnID == nil {
				continue
			}
			amt := store.Cents(l.Amount)
			ws := im.ufWaiting[amt]
			for i, w := range ws {
				if w.id == *l.LinkedTxnID {
					im.ufWaiting[amt] = append(ws[:i:i], ws[i+1:]...)
					break
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Payments and bill payments

type openCharge struct {
	id, open int64
	nameID   int64
	date     string
}

// openCharges lists the open invoices / statement charges (customer) or bills
// (vendor) of a name in an A/R or A/P account, oldest due first. Journal
// entries that are open charges count too. For customers, the jobs of the
// same customer are included after the name's own documents.
func (im *importer) openCharges(customer bool, acctID, nameID int64) ([]openCharge, error) {
	names := []int64{nameID}
	if customer {
		var root int64 = nameID
		for i := 0; i < 64; i++ {
			var p sql.NullInt64
			if err := im.tx.QueryRowContext(im.ctx, `SELECT parent_id FROM names WHERE id = ?`, root).Scan(&p); err != nil || !p.Valid {
				break
			}
			root = p.Int64
		}
		ids, err := store.Descendants(im.ctx, im.tx, "names", root)
		if err != nil {
			return nil, err
		}
		names = append(names, ids...)
	}
	types := `'INV', 'STMTCHG'`
	jeSign := "> 0"
	if !customer {
		types, jeSign = `'BILL'`, "< 0"
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(names)), ",")
	args := []any{acctID}
	for _, n := range names {
		args = append(args, n)
	}
	args = append(args, acctID)
	for _, n := range names {
		args = append(args, n)
	}
	// (the unary + keeps SQLite on the name indexes: a name has few documents, an account many)
	rows, err := im.tx.QueryContext(im.ctx, `SELECT id, open_balance, IFNULL(name_id, 0), CASE WHEN due_date <> '' THEN due_date ELSE date END, date FROM txns
		WHERE +type IN (`+types+`) AND +voided = 0 AND +is_pending = 0 AND +open_balance > 0 AND +account_id = ? AND name_id IN (`+ph+`)
		UNION ALL
		SELECT t.id, t.open_balance, g.name_id, t.date, t.date FROM gl_entries g JOIN txns t ON t.id = g.txn_id
		WHERE t.type = 'GENJRNL' AND t.voided = 0 AND t.open_balance > 0 AND +g.account_id = ? AND g.amount `+jeSign+` AND g.name_id IN (`+ph+`)
		  AND (SELECT COUNT(*) FROM gl_entries g2 JOIN accounts a2 ON a2.id = g2.account_id WHERE g2.txn_id = t.id
			AND a2.type IN ('Accounts Receivable', 'Accounts Payable')) = 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type row struct {
		openCharge
		due string
	}
	var all []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.open, &r.nameID, &r.due, &r.date); err != nil {
			return nil, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if (a.nameID == nameID) != (b.nameID == nameID) {
			return a.nameID == nameID
		}
		if a.due != b.due {
			return a.due < b.due
		}
		return a.id < b.id
	})
	out := make([]openCharge, len(all))
	for i, r := range all {
		out[i] = r.openCharge
	}
	return out, nil
}

// applyTo spreads amount (plus a discount) over the open charges: a charge
// whose open balance is exactly the amount first, then the oldest. It
// returns the links and what could not be applied.
func applyTo(charges []openCharge, amount, discount int64, discAcct int64, exactOnly bool) ([]model.TxnLink, int64, int64) {
	var links []model.TxnLink
	total := amount + discount
	for i, c := range charges {
		if c.open == total {
			links = append(links, link(c.id, amount, discount, discAcct))
			_ = i
			return links, 0, 0
		}
	}
	if exactOnly {
		return nil, amount, discount
	}
	remaining, disc := amount, discount
	for _, c := range charges {
		if remaining == 0 && disc == 0 {
			break
		}
		take := remaining
		if take > c.open {
			take = c.open
		}
		var d int64
		if disc > 0 && c.open-take >= disc {
			d = disc
		}
		if take == 0 && d == 0 {
			continue
		}
		links = append(links, link(c.id, take, d, discAcct))
		remaining -= take
		disc -= d
	}
	return links, remaining, disc
}

func link(to, amount, discount, discAcct int64) model.TxnLink {
	l := model.TxnLink{ToTxnID: to, Amount: dollars(amount), Discount: dollars(discount)}
	if discount != 0 {
		l.DiscountAccountID = ptr(discAcct)
	}
	return l
}

// buildPayment enters a customer payment (customer true) or a bill payment.
func (im *importer) buildPayment(t *srcTxn, customer bool) (*built, error) {
	headID, head, err := im.needAcct(t.Head)
	if err != nil {
		return nil, err
	}
	kind := model.TxPayment
	amount := t.Head.Amount
	arap := model.AcctAR
	if !customer {
		kind, amount, arap = model.TxBillPayment, -t.Head.Amount, model.AcctAP
		if head.typ != model.AcctBank && head.typ != model.AcctCreditCard {
			return nil, fallback{fmt.Sprintf("bills are paid from a bank or credit card account, not from %s", head.name)}
		}
	} else if head.typ != model.AcctBank && head.typ != model.AcctOCA {
		return nil, fallback{fmt.Sprintf("a payment is deposited to a bank or other current asset account, not to %s", head.name)}
	}
	if amount < 0 {
		return nil, fallback{"the payment amount is negative"}
	}
	var arapID, discAcct, discount, applied int64
	nameFull := t.Head.Name
	for _, s := range t.Splits {
		id, a, err := im.needAcct(s)
		if err != nil {
			return nil, err
		}
		if a.typ == arap {
			if arapID != 0 && arapID != id {
				return nil, fallback{"it uses two " + arap + " accounts"}
			}
			arapID = id
			applied += s.Amount
			if nameFull == "" {
				nameFull = s.Name
			}
			continue
		}
		// a discount taken: debit (payment) or credit (bill payment) to another account
		switch a.typ {
		case model.AcctAR, model.AcctAP, model.AcctNonPosting, model.AcctBank, model.AcctCreditCard:
			return nil, fallback{fmt.Sprintf("a line posts to %s", a.name)}
		}
		if discAcct != 0 {
			return nil, fallback{fmt.Sprintf("a line posts to %s", a.name)}
		}
		discAcct = id
		discount = s.Amount
		if !customer {
			discount = -s.Amount
		}
	}
	if arapID == 0 {
		return nil, fallback{"no line posts to " + arap}
	}
	if discount < 0 {
		return nil, fallback{"the discount line has the wrong sign"}
	}
	if nameFull == "" {
		return nil, fail{t.Line, map[bool]string{true: "no customer is given", false: "no vendor is given"}[customer]}
	}
	nameID, why := im.nameID(nameFull)
	if nameID == 0 {
		return nil, fail{t.Line, why}
	}
	wantKind := model.NameCustomer
	if !customer {
		wantKind = model.NameVendor
	}
	if im.kindOf(nameID) != wantKind {
		return nil, fallback{fmt.Sprintf("%s is not a %s", nameFull, kindLabels[wantKind])}
	}
	m, _ := im.header(t, kind)
	m.AccountID, m.ArApAccountID, m.NameID, m.Amount = ptr(headID), ptr(arapID), ptr(nameID), dollars(amount)
	m.PaymentMethodID = im.listRef(model.ListPaymentMethod, t.Head.PayMeth, t.Line)
	charges, err := im.openCharges(customer, arapID, nameID)
	if err != nil {
		return nil, err
	}
	links, left, discLeft := applyTo(charges, amount, discount, discAcct, false)
	if discLeft != 0 {
		return nil, fallback{"the discount could not be applied to an open " + map[bool]string{true: "invoice", false: "bill"}[customer]}
	}
	if !customer && left != 0 {
		return nil, fallback{fmt.Sprintf("the open bills of %s add up to less than the payment (%s not applied)", nameFull, fmtCents(left))}
	}
	m.Links = links
	if len(links) > 0 {
		im.applied++
	}
	b := &built{t: m, clear: im.clearedAccounts(t)}
	return b, nil
}

// ---------------------------------------------------------------------------
// Transfers

func (im *importer) buildTransfer(t *srcTxn) (*built, error) {
	if len(t.Splits) != 1 {
		return nil, fallback{"a transfer moves money between two accounts only"}
	}
	a, b := t.Head, t.Splits[0]
	if a.Amount > 0 {
		a, b = b, a
	}
	from, fa, err := im.needAcct(a)
	if err != nil {
		return nil, err
	}
	to, ta, err := im.needAcct(b)
	if err != nil {
		return nil, err
	}
	for _, x := range []*acctData{fa, ta} {
		if !model.IsBalanceSheet(x.typ) || x.typ == model.AcctAR || x.typ == model.AcctAP {
			return nil, fallback{fmt.Sprintf("funds cannot be transferred to or from %s", x.name)}
		}
	}
	if from == to {
		return nil, fallback{"the accounts to transfer from and to are the same"}
	}
	m, _ := im.header(t, model.TxTransfer)
	m.AccountID, m.ToAccountID, m.Amount = ptr(from), ptr(to), dollars(b.Amount)
	return &built{t: m, clear: im.clearedAccounts(t)}, nil
}

// ---------------------------------------------------------------------------
// General journal entries (and transactions without a form of their own)

// buildJournal enters every split as a journal line. apply: a single line
// crediting a customer (or debiting a vendor) is applied to the name's open
// invoices (bills), like the payment it stands for.
func (im *importer) buildJournal(t *srcTxn, apply bool) (*built, error) {
	m, _ := im.header(t, model.TxJournal)
	b := &built{t: m, journal: true}
	var arapLines []int
	for _, s := range append([]srcSplit{t.Head}, t.Splits...) {
		id, a, err := im.needAcct(s)
		if err != nil {
			return nil, err
		}
		if a.typ == model.AcctNonPosting {
			return nil, fail{s.Line, fmt.Sprintf("%s is a non-posting account; it cannot be used in a journal entry", a.name)}
		}
		l := model.TxnLine{Kind: model.LineJournal, AccountID: ptr(id), Amount: dollars(s.Amount), Description: s.Memo}
		l.ClassID = im.listRef(model.ListClass, s.Class, s.Line)
		name := s.Name
		if name == "" && (a.typ == model.AcctAR || a.typ == model.AcctAP) {
			name = t.Head.Name
		}
		if name != "" {
			nid, why := im.nameID(name)
			if nid == 0 {
				return nil, fail{s.Line, why}
			}
			l.NameID = ptr(nid)
			if a.typ == model.AcctAR && im.kindOf(nid) != model.NameCustomer {
				return nil, fail{s.Line, fmt.Sprintf("the line posts to %s, so its name must be a customer (%s is a %s)", a.name, name, kindLabels[im.kindOf(nid)])}
			}
			if a.typ == model.AcctAP && im.kindOf(nid) != model.NameVendor {
				return nil, fail{s.Line, fmt.Sprintf("the line posts to %s, so its name must be a vendor (%s is a %s)", a.name, name, kindLabels[im.kindOf(nid)])}
			}
		} else if a.typ == model.AcctAR || a.typ == model.AcctAP {
			return nil, fail{s.Line, fmt.Sprintf("the line posts to %s but has no %s", a.name, map[bool]string{true: "customer", false: "vendor"}[a.typ == model.AcctAR])}
		}
		if a.typ == model.AcctAR || a.typ == model.AcctAP {
			arapLines = append(arapLines, len(m.Lines))
		}
		m.Lines = append(m.Lines, l)
		b.lines = append(b.lines, s.Line)
	}
	if len(m.Lines) < 2 {
		m.Lines = append(m.Lines, model.TxnLine{Kind: model.LineJournal, AccountID: m.Lines[0].AccountID, Amount: 0})
		b.lines = append(b.lines, 0)
	}
	if apply && len(arapLines) == 1 {
		l := m.Lines[arapLines[0]]
		a := im.acct(*l.AccountID)
		amt := store.Cents(l.Amount)
		customer := a.typ == model.AcctAR
		if (customer && amt < 0) || (!customer && amt > 0) {
			charges, err := im.openCharges(customer, a.id, *l.NameID)
			if err != nil {
				return nil, err
			}
			// a journal entry applies to the name's own documents only
			var own []openCharge
			for _, c := range charges {
				if c.nameID == *l.NameID {
					own = append(own, c)
				}
			}
			links, _, _ := applyTo(own, absC(amt), 0, 0, false)
			m.Links = links
			if len(links) > 0 {
				im.applied++
			}
		}
	}
	b.clear = im.clearedAccounts(t)
	return b, nil
}

// ---------------------------------------------------------------------------

// build turns a transaction of the file into a SerieX transaction.
func (im *importer) build(t *srcTxn) (*built, error) {
	switch t.Kind {
	case model.TxInvoice, model.TxCreditMemo, model.TxSalesReceipt, model.TxStatementCharge:
		return im.buildSales(t, t.Kind)
	case model.TxCheck:
		// a check paying bills: every split posts to Accounts Payable
		allAP := true
		for _, s := range t.Splits {
			id, _ := im.accountID(s.Accnt)
			if a := im.acct(id); a == nil || a.typ != model.AcctAP {
				allAP = false
			}
		}
		if allAP {
			return im.buildPayment(t, false)
		}
		return im.buildPurchase(t, t.Kind)
	case model.TxBill, model.TxVendorCredit, model.TxItemReceipt, model.TxCCCharge, model.TxCCCredit:
		return im.buildPurchase(t, t.Kind)
	case model.TxDeposit:
		return im.buildDeposit(t)
	case model.TxPayment:
		return im.buildPayment(t, true)
	case model.TxBillPayment:
		return im.buildPayment(t, false)
	case model.TxTransfer:
		return im.buildTransfer(t)
	}
	return im.buildJournal(t, false)
}

// save stores a built transaction inside a savepoint.
func (im *importer) save(b *built) (int64, error, error) {
	var id int64
	uerr, ferr := im.try(func() error {
		type old struct {
			item int64
			col  string
			val  sql.NullInt64
		}
		var olds []old
		for _, x := range b.temp {
			var v sql.NullInt64
			if err := im.tx.QueryRowContext(im.ctx, `SELECT `+x.col+` FROM items WHERE id = ?`, x.item).Scan(&v); err != nil {
				return err
			}
			olds = append(olds, old{x.item, x.col, v})
			if _, err := im.tx.ExecContext(im.ctx, `UPDATE items SET `+x.col+` = ? WHERE id = ?`, x.acct, x.item); err != nil {
				return err
			}
		}
		var err error
		id, err = ledger.Save(im.ctx, im.tx, b.t, im.opt)
		for i := len(olds) - 1; i >= 0; i-- {
			o := olds[i]
			var v any
			if o.val.Valid {
				v = o.val.Int64
			}
			if _, rerr := im.tx.ExecContext(im.ctx, `UPDATE items SET `+o.col+` = ? WHERE id = ?`, v, o.item); rerr != nil && err == nil {
				err = rerr
			}
		}
		if err != nil {
			return err
		}
		for _, a := range b.clear {
			res, err := im.tx.ExecContext(im.ctx, `UPDATE gl_entries SET cleared = 'R' WHERE txn_id = ? AND account_id = ? AND cleared = ''`, id, a)
			if err != nil {
				return err
			}
			n, _ := res.RowsAffected()
			im.cleared += int(n)
		}
		return nil
	})
	return id, uerr, ferr
}

// importTxns enters the transactions of the file in date order.
func (im *importer) importTxns() error {
	for _, t := range im.ps.txns {
		tc := im.txCount(t)
		appliedBefore, linkedBefore := im.applied, im.linked
		b, err := im.build(t)
		var fb fallback
		var fl fail
		switch {
		case errors.As(err, &fb):
			im.applied, im.linked = appliedBefore, linkedBefore
			jb, jerr := im.buildJournal(t, true)
			if jerr != nil {
				im.failTxn(t, tc, jerr)
				continue
			}
			jb.reason = fb.reason
			b = jb
		case errors.As(err, &fl):
			im.failTxn(t, tc, err)
			continue
		case err != nil:
			return err
		}
		id, uerr, ferr := im.save(b)
		if ferr != nil {
			return ferr
		}
		if uerr != nil && !b.journal {
			// the form was refused: keep the books exact with a journal entry
			im.applied, im.linked = appliedBefore, linkedBefore
			jb, jerr := im.buildJournal(t, true)
			if jerr == nil {
				jb.reason = errText(uerr)
				var uerr2 error
				id, uerr2, ferr = im.save(jb)
				if ferr != nil {
					return ferr
				}
				if uerr2 == nil {
					b, uerr = jb, nil
				}
			}
		}
		if uerr != nil {
			im.problem("iif", lineOf(uerr, b.lines, t.Line), levelError, "%s was not imported: %s", t.label(), errText(uerr))
			tc.Skipped++
			continue
		}
		im.noteWaiting(b, id)
		tc.Imported++
		if b.journal && t.Kind != model.TxJournal {
			tc.AsJournal++
			im.problem("iif", t.Line, levelNote, "%s was entered as a general journal entry (same accounts and amounts) because %s.", t.label(), b.reason)
		}
		if b.assetNote != "" {
			im.problem("iif", t.Line, levelNote, "%s: %s.", t.label(), b.assetNote)
		}
	}
	return nil
}

func (im *importer) failTxn(t *srcTxn, tc *TxnCount, err error) {
	line := t.Line
	var fl fail
	if errors.As(err, &fl) && fl.line != 0 {
		line = fl.line
	}
	im.problem("iif", line, levelError, "%s was not imported: %s.", t.label(), errText(err))
	tc.Skipped++
}

func (im *importer) txCount(t *srcTxn) *TxnCount {
	key := strings.ToUpper(strings.TrimSpace(t.RawType))
	c := im.txCounts[key]
	if c == nil {
		c = &TxnCount{Source: orStr(t.RawType, "(no type)"), Label: ledger.TypeLabel(t.Kind, "")}
		im.txCounts[key] = c
	}
	return c
}
