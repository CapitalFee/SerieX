package reports

// 1099 reports (Vendors and Bills): what was paid to vendors marked
// "eligible for 1099" in a period, by vendor (with the tax ID) and account.

import (
	"context"
	"sort"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const vp = "Vendors and Bills"
	register(model.ReportInfo{Key: "1099_summary", Title: "1099 Summary", Category: vp,
		Description: "How much did I pay each vendor that is eligible for a 1099 (checks and bill payments from bank accounts)?",
		Params:      []string{"dates", "filters"}, DefaultDates: "lastFiscalYear"}, ops1099Summary)
	register(model.ReportInfo{Key: "1099_detail", Title: "1099 Detail", Category: vp,
		Description: "Which payments make up what I paid each 1099 vendor, by account?",
		Params:      []string{"dates", "filters"}, DefaultDates: "lastFiscalYear"}, ops1099Detail)
}

// ops1099Pay is a payment to a 1099 vendor charged to one income/expense account.
type ops1099Pay struct {
	TxnID, VendorID, AcctID      int64
	Type, Date, Ref, HdrAcctType string
	Amount                       float64 // cents
}

// ops1099Payments: payments in [from, to] to vendors eligible for 1099 made
// from bank accounts (credit card payments are reported by the card company
// and left out): checks written to the vendor, and bill
// payments in proportion to the income and expense lines of the bills paid.
// Only income and expense accounts count (not loans, assets or A/P).
func ops1099Payments(ctx context.Context, q store.Q, from, to string) ([]ops1099Pay, map[int64]string, error) {
	taxIDs := map[int64]string{}
	vrows, err := q.QueryContext(ctx, `SELECT id, tax_ident FROM names WHERE kind = 'vendor' AND is_1099 = 1`)
	if err != nil {
		return nil, nil, err
	}
	for vrows.Next() {
		var id int64
		var tid string
		if err := vrows.Scan(&id, &tid); err != nil {
			vrows.Close()
			return nil, nil, err
		}
		taxIDs[id] = tid
	}
	vrows.Close()
	if len(taxIDs) == 0 {
		return nil, taxIDs, nil
	}
	plTypes := `('Income','Other Income','Cost of Goods Sold','Expense','Other Expense')`
	var out []ops1099Pay
	// checks
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, t.name_id, g.account_id, SUM(g.amount)
		FROM txns t JOIN gl_entries g ON g.txn_id = t.id JOIN accounts a ON a.id = g.account_id JOIN accounts h ON h.id = t.account_id
		WHERE t.type = 'CHK' AND t.voided = 0 AND t.date >= ? AND t.date <= ? AND h.type = 'Bank'
		  AND g.role <> 'header' AND a.type IN `+plTypes+`
		GROUP BY t.id, g.account_id ORDER BY t.date, t.id`, from, to)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var p ops1099Pay
		var name *int64
		if err := rows.Scan(&p.TxnID, &p.Type, &p.Date, &p.Ref, &name, &p.AcctID, &p.Amount); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if name == nil {
			continue
		}
		if _, ok := taxIDs[*name]; !ok {
			continue
		}
		p.VendorID = *name
		out = append(out, p)
	}
	rows.Close()
	// bill payments: each bill paid, in proportion to its income/expense entries
	rows, err = q.QueryContext(ctx, `SELECT p.id, p.date, p.ref_number, p.name_id, l.to_txn_id, l.amount, b.amount
		FROM txn_links l JOIN txns p ON p.id = l.owner_txn_id JOIN txns b ON b.id = l.to_txn_id JOIN accounts h ON h.id = p.account_id
		WHERE p.type = 'BILLPMT' AND p.voided = 0 AND l.from_txn_id = p.id AND p.date >= ? AND p.date <= ? AND h.type = 'Bank'
		ORDER BY p.date, p.id, l.id`, from, to)
	if err != nil {
		return nil, nil, err
	}
	type paid struct {
		pay                ops1099Pay
		bill, amt, billAmt int64
	}
	var paids []paid
	for rows.Next() {
		var x paid
		var name *int64
		if err := rows.Scan(&x.pay.TxnID, &x.pay.Date, &x.pay.Ref, &name, &x.bill, &x.amt, &x.billAmt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if name == nil || x.billAmt == 0 {
			continue
		}
		if _, ok := taxIDs[*name]; !ok {
			continue
		}
		x.pay.VendorID, x.pay.Type = *name, model.TxBillPayment
		paids = append(paids, x)
	}
	rows.Close()
	for _, x := range paids {
		erows, err := q.QueryContext(ctx, `SELECT g.account_id, SUM(g.amount) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
			WHERE g.txn_id = ? AND g.role <> 'header' AND a.type IN `+plTypes+` GROUP BY g.account_id ORDER BY g.account_id`, x.bill)
		if err != nil {
			return nil, nil, err
		}
		for erows.Next() {
			p := x.pay
			var amt int64
			if err := erows.Scan(&p.AcctID, &amt); err != nil {
				erows.Close()
				return nil, nil, err
			}
			p.Amount = float64(amt) * float64(x.amt) / float64(x.billAmt)
			out = append(out, p)
		}
		erows.Close()
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].TxnID < out[j].TxnID
	})
	return out, taxIDs, nil
}

func ops1099Load(ctx context.Context, q store.Q, p *Params) ([]ops1099Pay, map[int64]string, map[int64]*opsName, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, nil, nil, err
	}
	from, to := opsFromTo(p)
	pays, taxIDs, err := ops1099Payments(ctx, q, from, to)
	if err != nil {
		return nil, nil, nil, err
	}
	nf := opsNameSet(p, names)
	accts := map[int64]bool{}
	for _, id := range p.Filters.AccountIDs {
		accts[id] = true
	}
	kept := pays[:0]
	for _, x := range pays {
		if (nf != nil && !nf[x.VendorID]) || (len(accts) > 0 && !accts[x.AcctID]) {
			continue
		}
		kept = append(kept, x)
	}
	return kept, taxIDs, names, nil
}

func ops1099Summary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	pays, taxIDs, names, err := ops1099Load(ctx, q, p)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "1099 Summary", false, false,
		opsC("label", "", "text"), opsC("taxId", "Tax ID", "text"), opsC("total", "TOTAL", "money"))
	sums := map[int64]float64{}
	for _, x := range pays {
		sums[x.VendorID] += x.Amount
	}
	var ids []int64
	for id := range sums {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return strings.ToLower(opsNameFull(names, ids[i])) < strings.ToLower(opsNameFull(names, ids[j]))
	})
	var grand float64
	for _, id := range ids {
		b.rowFull(model.ReportRow{Kind: "data", Cells: map[string]any{"label": opsNameFull(names, id), "taxId": taxIDs[id], "total": opsMF(sums[id])},
			Drill: opsDrill("1099_detail", "from", p.From, "to", p.To, "nameIds", opsID(id))})
		grand += sums[id]
	}
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "total": opsMF(grand)})
	return b.r, nil
}

func ops1099Detail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	pays, taxIDs, names, err := ops1099Load(ctx, q, p)
	if err != nil {
		return nil, err
	}
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "1099 Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("account", "Account", "text"), opsC("amount", "Amount", "money"))
	byVendor := map[int64][]ops1099Pay{}
	for _, x := range pays {
		byVendor[x.VendorID] = append(byVendor[x.VendorID], x)
	}
	var ids []int64
	for id := range byVendor {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return strings.ToLower(opsNameFull(names, ids[i])) < strings.ToLower(opsNameFull(names, ids[j]))
	})
	var grand float64
	for _, id := range ids {
		g := b.group()
		label := opsNameFull(names, id)
		if t := taxIDs[id]; t != "" {
			label += " (Tax ID " + t + ")"
		}
		b.row("section", 0, g, map[string]any{"label": label})
		var sum float64
		for _, x := range byVendor[id] {
			acct := ""
			if a := accts[x.AcctID]; a != nil {
				acct = a.Full
			}
			b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(x.TxnID), Cells: map[string]any{
				"type": opsTypeLabel(x.Type, "Bank"), "date": x.Date, "num": x.Ref, "account": acct, "amount": opsMF(x.Amount)}})
			sum += x.Amount
		}
		b.row("subtotal", 0, g, map[string]any{"label": "Total " + opsNameFull(names, id), "amount": opsMF(sum)})
		grand += sum
	}
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsMF(grand)})
	return b.r, nil
}
