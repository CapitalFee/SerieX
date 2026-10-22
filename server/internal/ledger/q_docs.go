package ledger

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// qryOpenDocsParams are the parameters of GET /open-docs.
type qryOpenDocsParams struct {
	NameID       int64  // 0 = every customer / vendor
	IncludeJobs  bool   // customer: include its jobs
	Kind         string // "receivable" | "payable"
	Date         string // payment date (terms discount); default today
	ExcludeTxnID int64  // a payment being edited: computed as if it did not exist
}

// qryAddBack returns, for the transaction being edited, how much each
// document's open balance grows when that transaction is ignored: amounts and
// discounts it applied to charges, credits it consumed (credit memos, unapplied
// payments, vendor credits used through it) and refunds it made.
func qryAddBack(ctx context.Context, q store.Q, excludeID int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if excludeID <= 0 {
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT l.from_txn_id, l.to_txn_id, l.amount, l.discount, tf.type, tt.type
		FROM txn_links l JOIN txns tf ON tf.id = l.from_txn_id JOIN txns tt ON tt.id = l.to_txn_id
		WHERE l.owner_txn_id = ?`, excludeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var from, to, amount, discount int64
		var fromType, toType string
		if err := rows.Scan(&from, &to, &amount, &discount, &fromType, &toType); err != nil {
			return nil, err
		}
		switch toType {
		case model.TxInvoice, model.TxStatementCharge, model.TxBill, model.TxItemReceipt, model.TxJournal:
			out[to] += amount + discount
		case model.TxCreditMemo, model.TxPayment, model.TxVendorCredit:
			// a refund (or another consumer) used this credit
			out[to] += amount
		}
		if from != excludeID {
			switch fromType {
			case model.TxCreditMemo, model.TxPayment, model.TxVendorCredit, model.TxBillPayment, model.TxJournal:
				out[from] += amount
			}
		}
	}
	return out, rows.Err()
}

// qryOpenDocs runs GET /open-docs.
func qryOpenDocs(ctx context.Context, q store.Q, p qryOpenDocsParams) (*model.OpenDocsResult, error) {
	if p.Date == "" {
		p.Date = store.Today()
	}
	if !store.ValidDate(p.Date) {
		return nil, apperr.Validation("date", "Invalid date %q.", p.Date)
	}
	var chargeTypes, creditTypes []string
	var special string
	switch p.Kind {
	case "receivable", "":
		chargeTypes = []string{model.TxInvoice, model.TxStatementCharge}
		creditTypes = []string{model.TxCreditMemo, model.TxPayment}
		special = store.SpecialAR
	case "payable":
		chargeTypes = []string{model.TxBill}
		// unapplied bill payments (their bill was deleted or voided) are credits too
		creditTypes = []string{model.TxVendorCredit, model.TxBillPayment}
		special = store.SpecialAP
	default:
		return nil, apperr.BadRequest("kind must be receivable or payable")
	}
	var nameIDs []int64
	if p.NameID > 0 {
		var err error
		if nameIDs, err = qryNameSet(ctx, q, p.NameID, p.IncludeJobs); err != nil {
			return nil, err
		}
	}
	addBack, err := qryAddBack(ctx, q, p.ExcludeTxnID)
	if err != nil {
		return nil, err
	}
	terms, err := qryLoadTerms(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	var defaultArAp int64
	if ids, err := qrySpecialIDs(ctx, q, special); err != nil {
		return nil, err
	} else if len(ids) > 0 {
		defaultArAp = ids[0]
	}

	load := func(types []string, charges bool) ([]model.OpenDoc, error) {
		typeIn, typeArgs := qryInStr(types)
		cond := `t.type IN ` + typeIn + ` AND t.voided = 0 AND t.is_pending = 0 AND t.id <> ?`
		args := append(typeArgs, p.ExcludeTxnID)
		if nameIDs != nil {
			in, a := qryIn(nameIDs)
			cond += ` AND t.name_id IN ` + in
			args = append(args, a...)
		}
		backIDs := make([]int64, 0, len(addBack))
		for id := range addBack {
			backIDs = append(backIDs, id)
		}
		backIn, backArgs := qryIn(backIDs)
		cond += ` AND (t.open_balance <> 0 OR t.id IN ` + backIn + `)`
		args = append(args, backArgs...)
		rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.due_date, t.ref_number, t.name_id,
			t.amount, t.open_balance, t.terms_id, t.memo, t.po_number, t.account_id, t.ar_ap_account_id, IFNULL(a.type, '')
			FROM txns t LEFT JOIN accounts a ON a.id = t.account_id WHERE `+cond, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []model.OpenDoc{}
		for rows.Next() {
			var d model.OpenDoc
			var nameID, termsID, acct, arAp sql.NullInt64
			var amount, open int64
			var acctType string
			if err := rows.Scan(&d.TxnID, &d.Type, &d.Date, &d.DueDate, &d.RefNumber, &nameID, &amount, &open,
				&termsID, &d.Memo, &d.PONumber, &acct, &arAp, &acctType); err != nil {
				return nil, err
			}
			open += addBack[d.TxnID]
			if open <= 0 {
				continue
			}
			d.TypeLabel = qryTypeLabel(d.Type, acctType)
			if nameID.Valid {
				d.NameID = nameID.Int64
				d.NameFull = names[nameID.Int64]
			}
			d.Amount = store.Dollars(amount)
			d.OpenBalance = store.Dollars(open)
			d.TermsID = store.PtrID(termsID)
			// A/R or A/P account: header account of charges/credit memos, arAp account of payments
			pmt := d.Type == model.TxPayment || d.Type == model.TxBillPayment
			switch {
			case pmt && arAp.Valid:
				d.ArApAccountID = arAp.Int64
			case !pmt && acct.Valid:
				d.ArApAccountID = acct.Int64
			default:
				d.ArApAccountID = defaultArAp
			}
			if charges && termsID.Valid {
				if t, ok := terms[termsID.Int64]; ok {
					d.DiscountDate = qryDiscountDate(d.Date, t)
					if d.DiscountDate != "" && p.Date <= d.DiscountDate {
						d.SuggestedDiscount = store.Dollars(qryPctOf(open, t.DiscountPct))
					}
				}
			}
			out = append(out, d)
		}
		return out, rows.Err()
	}
	charges, err := load(chargeTypes, true)
	if err != nil {
		return nil, err
	}
	credits, err := load(creditTypes, false)
	if err != nil {
		return nil, err
	}
	// journal entries with an A/R (A/P) line: a debit (credit) is a charge, the other side a credit
	acctType := model.AcctAR
	if p.Kind == "payable" {
		acctType = model.AcctAP
	}
	jeCond, jeArgs := ``, []any{acctType, p.ExcludeTxnID}
	if nameIDs != nil {
		in, a := qryIn(nameIDs)
		jeCond = ` AND g.name_id IN ` + in
		jeArgs = append(jeArgs, a...)
	}
	jrows, err := q.QueryContext(ctx, `SELECT t.id, t.date, t.ref_number, IFNULL(MIN(g.name_id), 0), SUM(g.amount), t.open_balance,
		t.memo, MIN(g.account_id), COUNT(*)
		FROM txns t JOIN gl_entries g ON g.txn_id = t.id JOIN accounts a ON a.id = g.account_id
		WHERE t.type = 'GENJRNL' AND t.voided = 0 AND a.type = ? AND t.id <> ?`+jeCond+`
		GROUP BY t.id ORDER BY t.date, t.id`, jeArgs...)
	if err != nil {
		return nil, err
	}
	for jrows.Next() {
		var d model.OpenDoc
		var amt, open int64
		var n int
		if err := jrows.Scan(&d.TxnID, &d.Date, &d.RefNumber, &d.NameID, &amt, &open, &d.Memo, &d.ArApAccountID, &n); err != nil {
			jrows.Close()
			return nil, err
		}
		open += addBack[d.TxnID]
		if n != 1 || open <= 0 || amt == 0 {
			continue
		}
		d.Type, d.TypeLabel = model.TxJournal, qryTypeLabel(model.TxJournal, "")
		d.NameFull = names[d.NameID]
		d.Amount, d.OpenBalance = store.Dollars(qryAbs(amt)), store.Dollars(open)
		if (amt > 0) == (acctType == model.AcctAR) {
			charges = append(charges, d)
		} else {
			credits = append(credits, d)
		}
	}
	if err := jrows.Err(); err != nil {
		jrows.Close()
		return nil, err
	}
	jrows.Close()
	payable := p.Kind == "payable"
	sort.SliceStable(charges, func(i, j int) bool {
		a, b := charges[i], charges[j]
		if payable {
			da, db := a.DueDate, b.DueDate
			if da == "" {
				da = a.Date
			}
			if db == "" {
				db = b.Date
			}
			if da != db {
				return da < db
			}
		}
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		return a.TxnID < b.TxnID
	})
	sort.SliceStable(credits, func(i, j int) bool {
		if credits[i].Date != credits[j].Date {
			return credits[i].Date < credits[j].Date
		}
		return credits[i].TxnID < credits[j].TxnID
	})
	return &model.OpenDocsResult{Charges: charges, Credits: credits}, nil
}

// qryUndeposited runs GET /undeposited: payments and sales receipts waiting in
// Undeposited Funds (not voided or pending, not on a deposit other than excludeDepositID).
func qryUndeposited(ctx context.Context, q store.Q, excludeDepositID int64) ([]model.UndepositedItem, error) {
	uf, err := qrySpecialIDs(ctx, q, store.SpecialUndepositedFunds)
	if err != nil {
		return nil, err
	}
	out := []model.UndepositedItem{}
	if len(uf) == 0 {
		return out, nil
	}
	in, args := qryIn(uf)
	args = append(args, excludeDepositID)
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, t.name_id, t.payment_method_id,
		IFNULL(pm.name, ''), t.amount, t.memo, t.class_id, IFNULL(a.type, '')
		FROM txns t LEFT JOIN list_entries pm ON pm.id = t.payment_method_id LEFT JOIN accounts a ON a.id = t.account_id
		WHERE t.type IN ('PMT', 'SALESRCPT') AND t.account_id IN `+in+` AND t.voided = 0 AND t.is_pending = 0 AND t.amount <> 0
		  AND NOT EXISTS (SELECT 1 FROM txn_lines l JOIN txns d ON d.id = l.txn_id
		                  WHERE l.linked_txn_id = t.id AND l.linked_line_id IS NULL AND d.type = 'DEP' AND d.voided = 0 AND d.id <> ?)
		ORDER BY t.date, t.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var u model.UndepositedItem
		var nameID, pm, class sql.NullInt64
		var amount int64
		var acctType string
		if err := rows.Scan(&u.TxnID, &u.Type, &u.Date, &u.RefNumber, &nameID, &pm, &u.PaymentMethodName,
			&amount, &u.Memo, &class, &acctType); err != nil {
			return nil, err
		}
		u.TypeLabel = qryTypeLabel(u.Type, acctType)
		u.NameID = store.PtrID(nameID)
		if nameID.Valid {
			u.NameFull = names[nameID.Int64]
		}
		u.PaymentMethodID = store.PtrID(pm)
		u.ClassID = store.PtrID(class)
		u.Amount = store.Dollars(amount)
		out = append(out, u)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := qryUndepositedChecks(ctx, q, out); err != nil {
		return nil, err
	}
	lines, err := qryUndepositedLines(ctx, q, uf, excludeDepositID, names)
	if err != nil {
		return nil, err
	}
	out = append(out, lines...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].TxnID < out[j].TxnID
	})
	return out, nil
}

// qryUndepositedChecks fills the check numbers: a payment's number (ref) and
// a sales receipt's extra.checkNumber.
func qryUndepositedChecks(ctx context.Context, q store.Q, items []model.UndepositedItem) error {
	for i := range items {
		u := &items[i]
		switch u.Type {
		case model.TxPayment:
			u.CheckNumber = u.RefNumber
		case model.TxSalesReceipt:
			var extra string
			if err := q.QueryRowContext(ctx, `SELECT extra FROM txns WHERE id = ?`, u.TxnID).Scan(&extra); err != nil {
				return err
			}
			var x map[string]any
			if json.Unmarshal([]byte(extra), &x) == nil {
				switch v := x["checkNumber"].(type) {
				case string:
					u.CheckNumber = v
				case float64:
					u.CheckNumber = strconv.FormatFloat(v, 'f', -1, 64)
				}
			}
		}
	}
	return nil
}

// qryUndepositedLines: payment-item lines of invoices and sales receipts that
// posted to Undeposited Funds and are not on a deposit yet.
func qryUndepositedLines(ctx context.Context, q store.Q, uf []int64, excludeDepositID int64, names map[int64]string) ([]model.UndepositedItem, error) {
	in, args := qryIn(uf)
	args = append(args, excludeDepositID)
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, IFNULL(l.name_id, t.name_id), it.payment_method_id,
			IFNULL(pm.name, ''), (SELECT SUM(g.amount) FROM gl_entries g WHERE g.line_id = l.id AND g.account_id IN `+in+`),
			l.id, l.description, IFNULL(l.class_id, t.class_id), IFNULL(a.type, '')
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id JOIN items it ON it.id = l.item_id
		LEFT JOIN list_entries pm ON pm.id = it.payment_method_id LEFT JOIN accounts a ON a.id = t.account_id
		WHERE t.type IN ('INV', 'SALESRCPT') AND it.type = 'Payment' AND t.voided = 0 AND t.is_pending = 0
		  AND NOT EXISTS (SELECT 1 FROM txn_lines dl JOIN txns d ON d.id = dl.txn_id
		                  WHERE dl.linked_line_id = l.id AND d.type = 'DEP' AND d.voided = 0 AND d.id <> ?)
		ORDER BY t.date, t.id, l.seq`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.UndepositedItem{}
	for rows.Next() {
		var u model.UndepositedItem
		var nameID, pm, class sql.NullInt64
		var amount sql.NullInt64
		var lineID int64
		var acctType string
		if err := rows.Scan(&u.TxnID, &u.Type, &u.Date, &u.RefNumber, &nameID, &pm, &u.PaymentMethodName,
			&amount, &lineID, &u.Memo, &class, &acctType); err != nil {
			return nil, err
		}
		if !amount.Valid || amount.Int64 <= 0 {
			continue // the line posted to a bank account, or nothing is waiting
		}
		u.TypeLabel = qryTypeLabel(u.Type, acctType)
		u.NameID = store.PtrID(nameID)
		if nameID.Valid {
			u.NameFull = names[nameID.Int64]
		}
		u.PaymentMethodID = store.PtrID(pm)
		u.ClassID = store.PtrID(class)
		u.Amount = store.Dollars(amount.Int64)
		u.LineID = &lineID
		u.CheckNumber = qryCheckIn(u.Memo)
		out = append(out, u)
	}
	return out, rows.Err()
}

// qryCheckIn finds a check number in a payment line description ("Check 5512").
func qryCheckIn(desc string) string {
	f := strings.Fields(desc)
	for i, w := range f {
		lw := strings.ToLower(strings.Trim(w, ".:#"))
		if (lw == "check" || lw == "chk" || lw == "ck" || lw == "no") && i+1 < len(f) {
			n := strings.Trim(f[i+1], "#.:,")
			if n != "" && strings.Trim(n, "0123456789") == "" {
				return n
			}
		}
	}
	return ""
}

// qryBillables runs GET /billables: uninvoiced billable purchase lines of a
// customer and its jobs (customerID 0 = every customer).
func qryBillables(ctx context.Context, q store.Q, customerID int64) ([]model.BillableCost, error) {
	cond := ""
	var args []any
	if customerID > 0 {
		ids, err := qryNameSet(ctx, q, customerID, true)
		if err != nil {
			return nil, err
		}
		in, a := qryIn(ids)
		cond = ` AND l.name_id IN ` + in
		args = a
	}
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT l.id, t.id, t.type, t.date, t.ref_number, t.name_id, l.item_id, l.account_id,
		l.description, l.qty, l.rate, l.amount, l.class_id, l.name_id
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type IN ('CHK', 'BILL', 'CCCHARGE', 'ITEMRCPT') AND t.voided = 0
		  AND l.billable = 1 AND l.billed_txn_id IS NULL AND l.name_id IS NOT NULL`+cond+`
		ORDER BY t.date, t.id, l.seq, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.BillableCost{}
	for rows.Next() {
		var b model.BillableCost
		var vendor, item, acct, class, cust sql.NullInt64
		var qty, rate sql.NullFloat64
		var amount int64
		if err := rows.Scan(&b.LineID, &b.TxnID, &b.TxnType, &b.Date, &b.RefNumber, &vendor, &item, &acct,
			&b.Description, &qty, &rate, &amount, &class, &cust); err != nil {
			return nil, err
		}
		b.NameID = store.PtrID(cust)
		if cust.Valid {
			b.NameFull = names[cust.Int64]
		}
		if vendor.Valid {
			b.VendorName = names[vendor.Int64]
		}
		b.ItemID = store.PtrID(item)
		b.AccountID = store.PtrID(acct)
		if qty.Valid {
			v := qty.Float64
			b.Qty = &v
		}
		if rate.Valid {
			v := rate.Float64
			b.Rate = &v
		}
		b.Amount = store.Dollars(amount)
		b.ClassID = store.PtrID(class)
		out = append(out, b)
	}
	return out, rows.Err()
}

// qryNameCond returns " AND t.name_id IN (...)" for a name filter (empty when id is 0).
func qryNameCond(ctx context.Context, q store.Q, id int64, withJobs bool) (string, []any, error) {
	if id <= 0 {
		return "", nil, nil
	}
	ids, err := qryNameSet(ctx, q, id, withJobs)
	if err != nil {
		return "", nil, err
	}
	in, args := qryIn(ids)
	return " AND t.name_id IN " + in, args, nil
}

// qryOpenPOs runs GET /open-pos: open purchase orders, openBalance = value not received yet.
func qryOpenPOs(ctx context.Context, q store.Q, vendorID int64) ([]model.TxnSummary, error) {
	cond, args, err := qryNameCond(ctx, q, vendorID, false)
	if err != nil {
		return nil, err
	}
	list, err := qrySummaryQuery(ctx, q, `WHERE t.type = 'PURCHORD' AND t.voided = 0 AND t.status IN ('', 'Open')`+cond+
		` ORDER BY t.date, t.id`, args...)
	if err != nil || len(list) == 0 {
		return list, err
	}
	ids := make([]int64, len(list))
	for i, s := range list {
		ids[i] = s.ID
	}
	remaining := map[int64]int64{}
	in, inArgs := qryIn(ids)
	rows, err := q.QueryContext(ctx, `SELECT txn_id, qty, rate, amount, received_qty, closed FROM txn_lines WHERE txn_id IN `+in, inArgs...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var txnID, amount int64
		var qty, rate sql.NullFloat64
		var received float64
		var closed int
		if err := rows.Scan(&txnID, &qty, &rate, &amount, &received, &closed); err != nil {
			return nil, err
		}
		if closed != 0 {
			continue
		}
		if !qty.Valid || qty.Float64 == 0 {
			if received == 0 {
				remaining[txnID] += amount
			}
			continue
		}
		left := qty.Float64 - received
		if left <= 0 {
			continue
		}
		if rate.Valid {
			remaining[txnID] += store.Cents(left * rate.Float64)
		} else {
			remaining[txnID] += int64(math.Round(float64(amount) * left / qty.Float64))
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range list {
		list[i].OpenBalance = store.Dollars(remaining[list[i].ID])
	}
	return list, nil
}

// qryOpenEstimates runs GET /open-estimates: estimates that are Pending or Accepted.
func qryOpenEstimates(ctx context.Context, q store.Q, customerID int64, withJobs bool) ([]model.TxnSummary, error) {
	cond, args, err := qryNameCond(ctx, q, customerID, withJobs)
	if err != nil {
		return nil, err
	}
	list, err := qrySummaryQuery(ctx, q, `WHERE t.type = 'EST' AND t.voided = 0 AND t.status IN ('', 'Pending', 'Accepted')`+cond+
		` ORDER BY t.date, t.id`, args...)
	if err != nil {
		return nil, err
	}
	for i := range list {
		list[i].OpenBalance = list[i].Amount
	}
	return list, nil
}

// qryItemReceipts runs GET /item-receipts: item receipts not converted to bills yet.
func qryItemReceipts(ctx context.Context, q store.Q, vendorID int64) ([]model.TxnSummary, error) {
	cond, args, err := qryNameCond(ctx, q, vendorID, false)
	if err != nil {
		return nil, err
	}
	return qrySummaryQuery(ctx, q, `WHERE t.type = 'ITEMRCPT' AND t.voided = 0`+cond+` ORDER BY t.date, t.id`, args...)
}

func qryAbs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
