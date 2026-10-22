package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/reports"
	"seriex/internal/store"
)

// SalesTaxDue returns the sales tax owed per tax item as of asOf (GET
// /sales-tax/due), following prefs.salesTaxBasis.
func SalesTaxDue(ctx context.Context, q store.Q, asOf string) ([]model.SalesTaxDue, error) {
	return qrySalesTaxDue(ctx, q, asOf, "")
}

// qrySalesTaxDue runs GET /sales-tax/due: per tax item, the sales tax owed
// as of asOf (natural sign: positive = owed): the tax collected up to asOf
// less the part of every sales tax payment (whatever its date, or dated up
// to paidThrough when given) that paid it, at least 0. Sales Tax Payable
// entries without a tax item (adjustments such as a journal entry with the
// agency in the Name column) give one row per agency with taxItemId 0; they
// may be negative.
//
// A payment pays the tax through its "paid through" date (Pay Sales Tax's
// "show sales tax due through", else the payment date): the entries dated up
// to that date that were entered before it, oldest first. Entries entered
// later (such as a backdated invoice or journal entry) stay due even when
// they are dated in a period already paid, and a payment never counts
// against amounts dated after asOf except as a credit: what it paid beyond
// the entries it covers counts from its own "paid through" date on.
func qrySalesTaxDue(ctx context.Context, q store.Q, asOf, paidThrough string) ([]model.SalesTaxDue, error) {
	if asOf == "" {
		asOf = store.Today()
	}
	if !store.ValidDate(asOf) {
		return nil, apperr.Validation("asOf", "Invalid date %q.", asOf)
	}
	if paidThrough != "" && !store.ValidDate(paidThrough) {
		return nil, apperr.Validation("paidThrough", "Invalid date %q.", paidThrough)
	}
	out := []model.SalesTaxDue{}
	stp, err := qrySpecialIDs(ctx, q, store.SpecialSalesTaxPayable)
	if err != nil || len(stp) == 0 {
		return out, err
	}
	items, err := store.FullNames(ctx, q, "items")
	if err != nil {
		return nil, err
	}
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	type key struct{ item, name int64 } // item rows: name 0; adjustment rows: item 0
	liab := map[key][]*taxOwed{}        // entries other than sales tax payments
	pays := map[key][]*taxPaid{}        // sales tax payments, one per payment transaction
	var order []key
	keyOf := func(item, name int64) key {
		k := key{item: item}
		if item == 0 {
			k.name = name
		}
		if _, ok := liab[k]; !ok {
			if _, ok := pays[k]; !ok {
				order = append(order, k)
			}
		}
		return k
	}
	// payments count even when dated after asOf, unless
	// paidThrough limits them
	payTo := "9999-12-31"
	if paidThrough != "" {
		payTo = paidThrough
	}
	in, args := qryIn(stp)
	if prefs.SalesTaxBasis == "cash" {
		// cash basis: invoice tax is due as the invoice is paid
		es, err := reports.SalesTaxPayableEntries(ctx, q, "9999-12-31", true)
		if err != nil {
			return nil, err
		}
		for _, e := range es {
			if e.TxnType != model.TxSalesTaxPayment {
				k := keyOf(e.ItemID, e.NameID)
				// entered when both the invoice and the payment that
				// recognized its tax existed
				seq := max(e.TxnID, e.SrcTxnID)
				liab[k] = append(liab[k], &taxOwed{date: e.Date, seq: seq, left: -e.Amount})
			}
		}
	} else {
		rows, err := q.QueryContext(ctx, `SELECT IFNULL(g.item_id, 0), IFNULL(g.name_id, 0), g.date, g.amount, g.txn_id FROM gl_entries g
			JOIN txns t ON t.id = g.txn_id
			WHERE g.account_id IN `+in+` AND t.type <> 'TAXPMT'
			ORDER BY g.id`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var itemID, nameID, amt, txnID int64
			var date string
			if err := rows.Scan(&itemID, &nameID, &date, &amt, &txnID); err != nil {
				rows.Close()
				return nil, err
			}
			k := keyOf(itemID, nameID)
			liab[k] = append(liab[k], &taxOwed{date: date, seq: txnID, left: -amt})
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	rows, err := q.QueryContext(ctx, `SELECT IFNULL(g.item_id, 0), IFNULL(g.name_id, 0), g.date, g.amount, g.txn_id, t.extra FROM gl_entries g
		JOIN txns t ON t.id = g.txn_id
		WHERE g.account_id IN `+in+` AND g.date <= ? AND t.type = 'TAXPMT'
		ORDER BY g.id`, append(append([]any{}, args...), payTo)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var itemID, nameID, amt, txnID int64
		var date, extra string
		if err := rows.Scan(&itemID, &nameID, &date, &amt, &txnID, &extra); err != nil {
			rows.Close()
			return nil, err
		}
		k := keyOf(itemID, nameID)
		var p *taxPaid
		for _, x := range pays[k] {
			if x.seq == txnID {
				p = x
			}
		}
		if p == nil {
			p = &taxPaid{seq: txnID, through: TaxPaidThrough(extra, date)}
			pays[k] = append(pays[k], p)
		}
		p.amt += amt
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	dueOf := func(k key) int64 {
		due := taxDueAsOf(liab[k], pays[k], asOf)
		if k.item != 0 && due < 0 {
			due = 0 // paid ahead (payments of later periods)
		}
		return due
	}
	for _, k := range order {
		due := dueOf(k)
		if due == 0 {
			continue
		}
		var d model.SalesTaxDue
		if k.item != 0 {
			var agency sql.NullInt64
			if err := q.QueryRowContext(ctx, `SELECT tax_agency_id FROM items WHERE id = ?`, k.item).Scan(&agency); err != nil && err != sql.ErrNoRows {
				return nil, err
			}
			d = model.SalesTaxDue{TaxItemID: k.item, TaxItemName: items[k.item], AgencyID: store.PtrID(agency), AmountDue: store.Dollars(due)}
			if agency.Valid {
				d.AgencyName = names[agency.Int64]
			}
		} else {
			d = model.SalesTaxDue{TaxItemName: "", AmountDue: store.Dollars(due)}
			if k.name != 0 {
				id := k.name
				d.AgencyID, d.AgencyName = &id, names[k.name]
			}
		}
		out = append(out, d)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].AgencyName), strings.ToLower(out[j].AgencyName)
		if a != b {
			return a < b
		}
		if (out[i].TaxItemID == 0) != (out[j].TaxItemID == 0) {
			return out[i].TaxItemID != 0 // adjustments after the agency's tax items
		}
		return strings.ToLower(out[i].TaxItemName) < strings.ToLower(out[j].TaxItemName)
	})
	return out, nil
}

// taxOwed is one amount posted to Sales Tax Payable (other than a sales tax
// payment) for one tax item or one agency's adjustments.
type taxOwed struct {
	date string
	seq  int64 // creation order: the transaction id
	left int64 // natural sign (positive = owed): the part no payment paid yet
}

// taxPaid is one sales tax payment's amount for one tax item or one agency's
// adjustments.
type taxPaid struct {
	seq     int64  // creation order: the transaction id
	through string // the date the tax was paid through
	amt     int64  // natural sign: positive pays an amount owed
}

// taxDueAsOf returns what is owed as of asOf for one tax item (or one
// agency's adjustments): the entries dated up to asOf less what the payments
// paid of them, less the credits (what payments paid beyond the entries they
// cover) of payments through asOf or earlier.
//
// The payments are replayed in the order they were entered. A payment
// through date T covers the entries dated up to T that were entered before
// it: first the credits of earlier payments through T or earlier pay them
// (oldest first), as Pay Sales Tax subtracted those credits from the amount
// it showed, then the payment pays what is left (oldest first). What it paid
// beyond those entries becomes a credit from T on. At the end the credits
// pay the entries dated in their own period that were entered after them.
func taxDueAsOf(owed []*taxOwed, paid []*taxPaid, asOf string) int64 {
	es := make([]*taxOwed, len(owed))
	for i, e := range owed {
		c := *e
		es[i] = &c
	}
	sort.SliceStable(es, func(i, j int) bool {
		if es[i].date != es[j].date {
			return es[i].date < es[j].date
		}
		return es[i].seq < es[j].seq
	})
	ps := append([]*taxPaid(nil), paid...)
	sort.SliceStable(ps, func(i, j int) bool { return ps[i].seq < ps[j].seq })
	// pick: the unpaid entries dated up to through (entered before seq when seq > 0)
	pick := func(through string, seq int64) []*taxOwed {
		var out []*taxOwed
		for _, e := range es {
			if e.date <= through && e.left != 0 && (seq == 0 || e.seq < seq) {
				out = append(out, e)
			}
		}
		return out
	}
	type credit struct {
		through string
		amt     int64
	}
	var credits []*credit
	for _, p := range ps {
		for _, c := range credits {
			if c.amt != 0 && c.through <= p.through {
				c.amt = taxAllocate(pick(p.through, p.seq), c.amt)
			}
		}
		if extra := taxAllocate(pick(p.through, p.seq), p.amt); extra != 0 {
			credits = append(credits, &credit{through: p.through, amt: extra})
		}
	}
	for _, c := range credits {
		if c.amt != 0 {
			c.amt = taxAllocate(pick(c.through, 0), c.amt)
		}
	}
	var due int64
	for _, e := range es {
		if e.date <= asOf {
			due += e.left
		}
	}
	for _, c := range credits {
		if c.through <= asOf {
			due -= c.amt
		}
	}
	return due
}

// taxAllocate pays the entries es (oldest first) with amount and returns
// what is left of amount. An amount that pays every entry in full, or more,
// pays all of them. A smaller one pays the oldest entries first, and part of
// the first one it cannot pay in full. Signs are natural: an amount pays
// entries of its own sign and takes in those of the other sign (a credit)
// only when it still covers what follows.
func taxAllocate(es []*taxOwed, amount int64) int64 {
	if amount == 0 || len(es) == 0 {
		return amount
	}
	sign := int64(1)
	if amount < 0 {
		sign = -1
	}
	rem := amount * sign
	var total int64
	for _, e := range es {
		total += e.left * sign
	}
	if total >= 0 && total <= rem {
		for _, e := range es {
			e.left = 0
		}
		return (rem - total) * sign
	}
	if total > rem {
		// pays part: the entries in order until the amount runs out
		var cum int64
		for _, e := range es {
			l := e.left * sign
			if cum+l <= rem {
				cum += l
				e.left = 0
				continue
			}
			e.left = (l - (rem - cum)) * sign
			return 0
		}
		return (rem - cum) * sign
	}
	// the entries are a credit overall: pay the longest run of them that
	// the amount covers without going below zero
	best, bestCum := -1, int64(0)
	var cum int64
	for i, e := range es {
		cum += e.left * sign
		if cum >= 0 && cum <= rem {
			best, bestCum = i, cum
		}
	}
	for i := 0; i <= best; i++ {
		es[i].left = 0
	}
	return (rem - bestCum) * sign
}

// qryToPrint runs GET /to-print: checks (CHK/BILLPMT/REFUND/TAXPMT, optionally
// of one account) or invoices marked "to be printed".
func qryToPrint(ctx context.Context, q store.Q, kind string, accountID int64) ([]model.TxnSummary, error) {
	switch kind {
	case "checks", "":
		in, args := qryInStr(qryCheckTypes)
		cond := `WHERE t.type IN ` + in + ` AND t.to_be_printed = 1 AND t.voided = 0`
		if accountID > 0 {
			cond += ` AND t.account_id = ?`
			args = append(args, accountID)
		}
		return qrySummaryQuery(ctx, q, cond+` ORDER BY t.date, t.id`, args...)
	case "invoices":
		return qrySummaryQuery(ctx, q, `WHERE t.type = 'INV' AND t.to_be_printed = 1 AND t.voided = 0 ORDER BY t.date, t.id`)
	}
	return nil, apperr.BadRequest("kind must be checks or invoices")
}

// qryMarkPrintedRequest is the body of POST /mark-printed.
type qryMarkPrintedRequest struct {
	TxnIDs      []int64 `json:"txnIds"`
	FirstNumber string  `json:"firstNumber"`
}

// qryMarkPrinted assigns check numbers (in the given order, starting at
// firstNumber) to checks, bill payments, refunds and sales tax payments, and
// clears "to be printed" on every listed transaction. Returns the updated summaries.
func qryMarkPrinted(ctx context.Context, tx *sql.Tx, req qryMarkPrintedRequest, user string, acceptDup bool) ([]model.TxnSummary, error) {
	if len(req.TxnIDs) == 0 {
		return nil, apperr.Validation("txnIds", "Select the transactions that were printed.")
	}
	prefs, err := store.LoadPrefs(ctx, tx)
	if err != nil {
		return nil, err
	}
	var clashes []string // check numbers already used in the same bank account
	clashAcct := ""
	next := strings.TrimSpace(req.FirstNumber)
	var ids []int64
	seen := map[int64]bool{}
	for _, id := range req.TxnIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		var typ, ref, date string
		var acct sql.NullInt64
		var name sql.NullInt64
		var amount int64
		err := tx.QueryRowContext(ctx, `SELECT type, ref_number, date, account_id, name_id, amount FROM txns WHERE id = ?`, id).
			Scan(&typ, &ref, &date, &acct, &name, &amount)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, apperr.Validation("txnIds", "Transaction %d was not found.", id)
		}
		if err != nil {
			return nil, err
		}
		isCheck := false
		for _, t := range qryCheckTypes {
			if t == typ {
				isCheck = true
			}
		}
		newRef := ref
		if isCheck {
			if next == "" {
				if next, err = qryNextRef(ctx, tx, typ, acct.Int64); err != nil {
					return nil, err
				}
				if next == "" {
					next = "1"
				}
			}
			newRef = next
			next = qryIncRef(next)
			if prefs.WarnDuplicateCheckNumbers && !acceptDup && newRef != ref && acct.Valid {
				var n int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM txns WHERE type IN ('CHK','BILLPMT','REFUND','TAXPMT')
					AND account_id = ? AND ref_number = ? AND id <> ?`, acct.Int64, newRef, id).Scan(&n); err != nil {
					return nil, err
				}
				if n > 0 {
					clashes = append(clashes, newRef)
					clashAcct = store.FullName(ctx, tx, "accounts", acct.Int64)
				}
			}
		}
		before, err := Get(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE txns SET ref_number = ?, to_be_printed = 0, updated_at = ? WHERE id = ?`,
			newRef, store.Stamp(), id); err != nil {
			return nil, err
		}
		after, err := Get(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		nameFull := ""
		if name.Valid {
			nameFull = store.FullName(ctx, tx, "names", name.Int64)
		}
		if err := store.Audit(ctx, tx, store.AuditEntry{User: user, Action: "modify", TxnID: id, TxnType: typ,
			RefNumber: newRef, TxnDate: date, Name: nameFull, Amount: amount,
			Details: map[string]any{"before": before, "after": after}}); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if len(clashes) > 0 {
		what := "Check number " + clashes[0] + " has"
		if len(clashes) > 1 {
			what = "Check numbers " + strings.Join(clashes[:len(clashes)-1], ", ") + " and " + clashes[len(clashes)-1] + " have"
		}
		return nil, apperr.ConfirmKind(apperr.WarnDuplicateNumber, "%s already been used in %s. Do you want to keep %s anyway?",
			what, clashAcct, map[bool]string{true: "these numbers", false: "this number"}[len(clashes) > 1])
	}
	return qrySummariesByID(ctx, tx, ids)
}

// qryLastPayment is the date and amount of the latest payment of a name.
type qryLastPayment struct {
	Date   string  `json:"date"`
	Amount float64 `json:"amount"`
}

// qryNameSummary is the result of GET /names/{id}/summary.
type qryNameSummary struct {
	OpenBalance   float64         `json:"openBalance"`
	Overdue       float64         `json:"overdue"`
	UnbilledCosts float64         `json:"unbilledCosts"`
	LastPayment   *qryLastPayment `json:"lastPayment"`
	OpenEstimates int             `json:"openEstimates"`
	OpenPOs       int             `json:"openPOs"`
	CreditLimit   *float64        `json:"creditLimit"`
}

// qrySummaryOfName computes the history panel figures of a customer (incl.
// jobs), vendor or other name.
func qrySummaryOfName(ctx context.Context, q store.Q, id int64) (*qryNameSummary, error) {
	var kind string
	var limit sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT kind, credit_limit FROM names WHERE id = ?`, id).Scan(&kind, &limit)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Name not found.")
	}
	if err != nil {
		return nil, err
	}
	s := &qryNameSummary{}
	if limit.Valid {
		v := store.Dollars(limit.Int64)
		s.CreditLimit = &v
	}
	ids, err := qryNameSet(ctx, q, id, true)
	if err != nil {
		return nil, err
	}
	in, args := qryIn(ids)
	today := store.Today()
	var acctType, chargeTypes, payType string
	switch kind {
	case model.NameCustomer:
		acctType, chargeTypes, payType = model.AcctAR, `('INV','STMTCHG')`, model.TxPayment
	case model.NameVendor:
		acctType, chargeTypes, payType = model.AcctAP, `('BILL')`, model.TxBillPayment
	default:
		return s, nil
	}
	var bal int64
	if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(g.amount), 0) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE a.type = ? AND g.name_id IN `+in, append([]any{acctType}, args...)...).Scan(&bal); err != nil {
		return nil, err
	}
	s.OpenBalance = store.Dollars(qryNatural(acctType, bal))
	var overdue int64
	if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(open_balance), 0) FROM txns
		WHERE type IN `+chargeTypes+` AND voided = 0 AND is_pending = 0 AND open_balance > 0
		  AND (CASE WHEN due_date = '' THEN date ELSE due_date END) < ? AND name_id IN `+in,
		append([]any{today}, args...)...).Scan(&overdue); err != nil {
		return nil, err
	}
	s.Overdue = store.Dollars(overdue)
	var pd string
	var pa int64
	err = q.QueryRowContext(ctx, `SELECT date, amount FROM txns WHERE type = ? AND voided = 0 AND name_id IN `+in+`
		ORDER BY date DESC, id DESC LIMIT 1`, append([]any{payType}, args...)...).Scan(&pd, &pa)
	if err == nil {
		s.LastPayment = &qryLastPayment{Date: pd, Amount: store.Dollars(pa)}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if kind == model.NameCustomer {
		var unbilled int64
		if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(l.amount), 0) FROM txn_lines l JOIN txns t ON t.id = l.txn_id
			WHERE t.type IN ('CHK','BILL','CCCHARGE','ITEMRCPT') AND t.voided = 0 AND l.billable = 1
			  AND l.billed_txn_id IS NULL AND l.name_id IN `+in, args...).Scan(&unbilled); err != nil {
			return nil, err
		}
		s.UnbilledCosts = store.Dollars(unbilled)
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM txns WHERE type = 'EST' AND voided = 0
			AND status IN ('', 'Pending', 'Accepted') AND name_id IN `+in, args...).Scan(&s.OpenEstimates); err != nil {
			return nil, err
		}
	} else {
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM txns WHERE type = 'PURCHORD' AND voided = 0
			AND status IN ('', 'Open') AND name_id IN `+in, args...).Scan(&s.OpenPOs); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// TaxPaidThrough returns the date a sales tax payment paid the tax through:
// extra.salesTaxThrough (set by Pay Sales Tax) when it is a valid date, else
// the payment date.
func TaxPaidThrough(extra, date string) string {
	if !strings.Contains(extra, "salesTaxThrough") {
		return date
	}
	var x struct {
		Through string `json:"salesTaxThrough"`
	}
	if json.Unmarshal([]byte(extra), &x) == nil && store.ValidDate(x.Through) {
		return x.Through
	}
	return date
}
