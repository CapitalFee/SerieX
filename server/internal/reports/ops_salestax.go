package reports

// Sales tax reports (Vendors and Bills category).

import (
	"context"
	"sort"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const vp = "Vendors and Bills"
	register(model.ReportInfo{Key: "sales_tax_liability", Title: "Sales Tax Liability", Category: vp,
		Description: "How much sales tax have I collected, and how much do I owe each tax agency?",
		Params:      []string{"dates"}, DefaultDates: "lastMonth"}, opsSalesTaxLiability)
	register(model.ReportInfo{Key: "sales_tax_revenue_summary", Title: "Sales Tax Revenue Summary", Category: vp,
		Description: "What are my taxable and non-taxable sales for each sales tax item?",
		Params:      []string{"dates"}, DefaultDates: "lastMonth"}, opsSalesTaxRevenue)
	register(model.ReportInfo{Key: "sales_tax_sales_detail", Title: "Sales Tax Sales Detail", Category: vp,
		Description: "Which sales make up the total and taxable sales of each sales tax item?",
		Params:      []string{"dates"}, DefaultDates: "lastMonth"}, opsSalesTaxSalesDetail)
}

const opsNoTaxItem int64 = -2

// opsTaxSaleTxn is the sales of one invoice, sales receipt or credit memo
// for the sales tax reports (credit memos negative; on the cash basis the
// recognized share), and the sales tax items they count for.
type opsTaxSaleTxn struct {
	id, nameID     int64
	typ, date, ref string
	members        []int64 // tax items (members of its group), or opsNoTaxItem
	sales, taxable float64
}

// opsTaxSaleTxns lists the sales of every invoice, sales receipt and credit
// memo dated in [from, to] by sales tax item of its tax item / group: "sales"
// (all sales lines) and "taxable" (lines marked taxable), in cents. Sales
// without a tax item count for opsNoTaxItem. On the cash basis (cash = true)
// an invoice or credit memo counts in the proportion of the payments and
// credits applied to it in the period.
func opsTaxSaleTxns(ctx context.Context, q store.Q, items map[int64]*opsItem, from, to string, cash bool) ([]*opsTaxSaleTxn, error) {
	members := map[int64][]int64{}
	for id, it := range items {
		if it.Type == model.ItemSalesTax {
			members[id] = []int64{id}
		}
	}
	grows, err := q.QueryContext(ctx, `SELECT g.group_id, g.item_id FROM item_group_lines g JOIN items i ON i.id = g.group_id
		WHERE i.type = ? ORDER BY g.group_id, g.seq, g.id`, model.ItemSalesTaxGroup)
	if err != nil {
		return nil, err
	}
	for grows.Next() {
		var gid, iid int64
		if err := grows.Scan(&gid, &iid); err != nil {
			grows.Close()
			return nil, err
		}
		members[gid] = append(members[gid], iid)
	}
	if err := grows.Err(); err != nil {
		grows.Close()
		return nil, err
	}
	grows.Close()
	var factors map[int64]float64
	lo, hi := from, to
	if cash {
		if factors, err = integCashSalesFactors(ctx, q, from, to); err != nil {
			return nil, err
		}
		lo, hi = "0000-01-01", "9999-12-31"
	}
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, IFNULL(t.name_id, 0), IFNULL(t.tax_item_id, 0),
			IFNULL(l.item_id, 0), l.amount, l.taxable
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type IN ('INV','SALESRCPT','CREDMEM') AND t.voided = 0 AND t.is_pending = 0 AND t.date >= ? AND t.date <= ?
		ORDER BY t.date, t.id, l.seq`, lo, hi)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byTxn := map[int64]*opsTaxSaleTxn{}
	var out []*opsTaxSaleTxn
	for rows.Next() {
		var tid, nameID, taxItem, itemID, amt int64
		var typ, date, ref string
		var taxable bool
		if err := rows.Scan(&tid, &typ, &date, &ref, &nameID, &taxItem, &itemID, &amt, &taxable); err != nil {
			return nil, err
		}
		f := 1.0
		if cash {
			if typ == model.TxSalesReceipt {
				if date < from || date > to {
					continue
				}
			} else if f = factors[tid]; f == 0 {
				continue
			}
		}
		if it := items[itemID]; it != nil {
			switch it.Type {
			case model.ItemSubtotal, model.ItemPayment, model.ItemSalesTax, model.ItemSalesTaxGroup, model.ItemGroup:
				continue
			}
		}
		if typ == model.TxCreditMemo {
			amt = -amt
		}
		a := byTxn[tid]
		if a == nil {
			ms := members[taxItem]
			if len(ms) == 0 {
				ms = []int64{opsNoTaxItem}
			}
			a = &opsTaxSaleTxn{id: tid, nameID: nameID, typ: typ, date: date, ref: ref, members: ms}
			byTxn[tid] = a
			out = append(out, a)
		}
		a.sales += float64(amt) * f
		if taxable {
			a.taxable += float64(amt) * f
		}
	}
	return out, rows.Err()
}

// opsTaxSales sums opsTaxSaleTxns per sales tax item.
func opsTaxSales(ctx context.Context, q store.Q, items map[int64]*opsItem, from, to string, cash bool) (map[int64]opsVals, error) {
	txns, err := opsTaxSaleTxns(ctx, q, items, from, to, cash)
	if err != nil {
		return nil, err
	}
	out := map[int64]opsVals{}
	for _, a := range txns {
		for _, m := range a.members {
			v := out[m]
			if v == nil {
				v = opsVals{}
				out[m] = v
			}
			v["sales"] += a.sales
			v["taxable"] += a.taxable
		}
	}
	return out, nil
}

// opsTaxSalesDrills are the drill-downs of a sales tax report row: its sales
// columns open the Sales Tax Sales Detail of the row's tax items (ids; nil =
// every item), the tax columns the item's Item Activity report (item rows only).
func opsTaxSalesDrills(p *Params, ids []int64, v opsVals, itemID int64) map[string]*model.ReportDrill {
	out := map[string]*model.ReportDrill{}
	list := ""
	for i, id := range ids {
		if i > 0 {
			list += ","
		}
		list += opsID(id)
	}
	basis := integTaxBasis(p)
	for _, k := range []string{"sales", "nontax", "taxable"} {
		amt := v["sales"]
		if k == "taxable" {
			amt = v["taxable"]
		} else if k == "nontax" {
			amt = v["sales"] - v["taxable"]
		}
		if int64(amt+0.5*sign(amt)) == 0 {
			continue
		}
		kv := []string{"from", p.From, "to", p.To, "basis", basis}
		if ids != nil {
			kv = append(kv, "taxItemIds", list)
		}
		if k != "sales" {
			kv = append(kv, "show", k)
		}
		out[k] = opsDrill("sales_tax_sales_detail", kv...)
	}
	if itemID > 0 {
		for _, k := range []string{"collected", "payable"} {
			if v[k] != 0 {
				out[k] = opsDrill("item_quickreport", "itemId", opsID(itemID), "from", p.From, "to", p.To)
			}
		}
	}
	return out
}

// opsTaxLiabilityDrills sets the drill-downs of the Tax Collected and Sales
// Tax Payable cells of a Sales Tax Liability row: the Transaction Detail by
// Account of the Sales Tax Payable account (stp, comma separated ids) limited
// to the row's tax items (ids; nil = every entry, [opsNoTaxItem] = entries
// without a tax item) on the report's basis. Tax Collected lists the
// invoices, sales receipts and credit memos of the period, Sales Tax Payable
// every entry up to the end date, so each report totals to its cell.
func opsTaxLiabilityDrills(p *Params, out map[string]*model.ReportDrill, stp string, ids []int64, v opsVals) {
	if stp == "" {
		return
	}
	kv := []string{"accountIds", stp, "basis", integTaxBasis(p)}
	switch {
	case ids == nil:
	case len(ids) == 1 && ids[0] == opsNoTaxItem:
		kv = append(kv, "noItem", "1")
	default:
		list := ""
		for i, id := range ids {
			if i > 0 {
				list += ","
			}
			list += opsID(id)
		}
		kv = append(kv, "itemIds", list)
	}
	if int64(v["collected"]+0.5*sign(v["collected"])) != 0 {
		out["collected"] = opsDrill("transaction_detail_by_account",
			append([]string{"from", p.From, "to", p.To, "types", opsTaxCollectedTypes}, kv...)...)
	} else {
		delete(out, "collected")
	}
	if int64(v["payable"]+0.5*sign(v["payable"])) != 0 {
		out["payable"] = opsDrill("transaction_detail_by_account", append([]string{"from", "", "to", p.To}, kv...)...)
	} else {
		delete(out, "payable")
	}
}

// opsTaxCollectedTypes are the transactions whose sales tax counts as
// collected on the Sales Tax Liability report.
const opsTaxCollectedTypes = model.TxInvoice + "," + model.TxSalesReceipt + "," + model.TxCreditMemo

// opsSpecialIDs returns the ids of the accounts flagged special (comma
// separated, "" when none).
func opsSpecialIDs(ctx context.Context, q store.Q, special string) (string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM accounts WHERE special = ? ORDER BY id`, special)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	out := ""
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		if out != "" {
			out += ","
		}
		out += opsID(id)
	}
	return out, rows.Err()
}

func sign(x float64) float64 {
	if x < 0 {
		return -1
	}
	return 1
}

// opsSalesTaxSalesDetail: the invoices, sales receipts and credit memos that
// make up the Total / Non-Taxable / Taxable Sales of sales tax items
// (taxItemIds, -2 = no sales tax item; show = sales | nontax | taxable).
func opsSalesTaxSalesDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	basis := integTaxBasis(p)
	txns, err := opsTaxSaleTxns(ctx, q, items, from, to, basis == "cash")
	if err != nil {
		return nil, err
	}
	want := map[int64]bool{}
	for _, id := range p.IDs("taxItemIds") {
		want[id] = true
	}
	for _, part := range strings.Split(p.Str("taxItemIds"), ",") {
		if strings.TrimSpace(part) == opsID(opsNoTaxItem) {
			want[opsNoTaxItem] = true
		}
	}
	show := p.Str("show")
	b := opsNew(ctx, q, p, "Sales Tax Sales Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("name", "Name", "text"), opsC("sales", "Total Sales", "money"), opsC("nontax", "Non-Taxable Sales", "money"),
		opsC("taxable", "Taxable Sales", "money"))
	b.r.Basis = BasisLabel(basis)
	b.r.Params = p.Echo()
	b.r.Params["basis"] = basis
	byItem := map[int64][]*opsTaxSaleTxn{}
	for _, a := range txns {
		for _, m := range a.members {
			if len(want) == 0 || want[m] {
				byItem[m] = append(byItem[m], a)
			}
		}
	}
	var ids []int64
	for id := range byItem {
		ids = append(ids, id)
	}
	label := func(id int64) string {
		if it := items[id]; it != nil {
			return it.Full
		}
		return "No Sales Tax Item"
	}
	sort.Slice(ids, func(i, j int) bool {
		if (ids[i] < 0) != (ids[j] < 0) {
			return ids[j] < 0
		}
		return strings.ToLower(label(ids[i])) < strings.ToLower(label(ids[j]))
	})
	cells := func(sales, taxable float64) map[string]any {
		return map[string]any{"sales": opsMF(sales), "nontax": opsMF(sales - taxable), "taxable": opsMF(taxable)}
	}
	var gs, gt float64
	for _, id := range ids {
		g := b.group()
		b.row("section", 0, g, map[string]any{"label": label(id)})
		var ss, st float64
		for _, a := range byItem[id] {
			switch show {
			case "taxable":
				if int64(a.taxable) == 0 {
					continue
				}
			case "nontax":
				if int64(a.sales-a.taxable) == 0 {
					continue
				}
			}
			c := cells(a.sales, a.taxable)
			c["type"] = opsTypeLabel(a.typ, "")
			c["date"] = a.date
			c["num"] = a.ref
			c["name"] = opsNameFull(names, a.nameID)
			b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, Cells: c, TxnID: opsTxnRef(a.id)})
			ss += a.sales
			st += a.taxable
		}
		c := cells(ss, st)
		c["label"] = "Total " + label(id)
		b.row("subtotal", 0, g, c)
		gs += ss
		gt += st
	}
	c := cells(gs, gt)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsSalesTaxLiability(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	basis := integTaxBasis(p)
	vals, err := opsTaxSales(ctx, q, items, from, to, basis == "cash")
	if err != nil {
		return nil, err
	}
	get := func(id int64) opsVals {
		v := vals[id]
		if v == nil {
			v = opsVals{}
			vals[id] = v
		}
		return v
	}
	// Tax collected in the period (sales forms) and the liability as of the end date
	// (on the cash basis: as recognized by the payments received).
	taxEntries, err := SalesTaxPayableEntries(ctx, q, to, basis == "cash")
	if err != nil {
		return nil, err
	}
	for _, te := range taxEntries {
		itemID, typ, date, amt := te.ItemID, te.TxnType, te.Date, te.Amount
		id := itemID
		if _, ok := items[id]; !ok || id == 0 {
			id = opsNoTaxItem
		}
		v := get(id)
		v["payable"] -= float64(amt)
		if date >= from && (typ == model.TxInvoice || typ == model.TxSalesReceipt || typ == model.TxCreditMemo) {
			v["collected"] -= float64(amt)
		}
	}
	stp, err := opsSpecialIDs(ctx, q, store.SpecialSalesTaxPayable)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Sales Tax Liability", false, false,
		opsC("label", "", "text"), opsC("sales", "Total Sales", "money"), opsC("nontax", "Non-Taxable Sales", "money"),
		opsC("taxable", "Taxable Sales", "money"), opsC("rate", "Tax Rate", "percent"), opsC("collected", "Tax Collected", "money"),
		opsC("payable", "Sales Tax Payable As of "+opsShortDate(p.To), "money"))
	b.r.Basis = BasisLabel(basis)
	b.r.Params = p.Echo()
	b.r.Params["basis"] = basis
	cells := func(v opsVals) map[string]any {
		return map[string]any{
			"sales": opsMF(v["sales"]), "nontax": opsMF(v["sales"] - v["taxable"]), "taxable": opsMF(v["taxable"]),
			"collected": opsMF(v["collected"]), "payable": opsMF(v["payable"]),
		}
	}
	nonzero := func(v opsVals) bool {
		for _, x := range v {
			if x != 0 {
				return true
			}
		}
		return false
	}
	// Group the tax items by agency.
	byAgency := map[int64][]int64{}
	for id, v := range vals {
		if id < 0 || !nonzero(v) || items[id] == nil {
			continue
		}
		ag := items[id].TaxAgency
		if _, ok := names[ag]; !ok {
			ag = 0
		}
		byAgency[ag] = append(byAgency[ag], id)
	}
	var agencies []int64
	for ag := range byAgency {
		agencies = append(agencies, ag)
	}
	sort.Slice(agencies, func(i, j int) bool {
		if (agencies[i] == 0) != (agencies[j] == 0) {
			return agencies[j] == 0
		}
		return strings.ToLower(opsNameFull(names, agencies[i])) < strings.ToLower(opsNameFull(names, agencies[j]))
	})
	itemRow := func(id int64, level int, g string) opsVals {
		it := items[id]
		v := vals[id]
		c := cells(v)
		c["label"] = it.Full
		c["rate"] = it.TaxRate
		cd := opsTaxSalesDrills(p, []int64{id}, v, id)
		opsTaxLiabilityDrills(p, cd, stp, []int64{id}, v)
		b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, Cells: c,
			Drill:      opsDrill("item_quickreport", "itemId", opsID(id), "from", p.From, "to", p.To),
			CellDrills: cd})
		return v
	}
	grand := opsVals{}
	for _, ag := range agencies {
		ids := byAgency[ag]
		sort.Slice(ids, func(i, j int) bool { return strings.ToLower(items[ids[i]].Full) < strings.ToLower(items[ids[j]].Full) })
		if ag == 0 {
			for _, id := range ids {
				grand.add(itemRow(id, 0, ""))
			}
			continue
		}
		g := b.group()
		label := opsNameFull(names, ag)
		b.row("section", 0, g, map[string]any{"label": label})
		sum := opsVals{}
		for _, id := range ids {
			sum.add(itemRow(id, 1, g))
		}
		c := cells(sum)
		c["label"] = "Total " + label
		cd := opsTaxSalesDrills(p, ids, sum, 0)
		opsTaxLiabilityDrills(p, cd, stp, ids, sum)
		b.rowFull(model.ReportRow{Kind: "subtotal", Group: g, Cells: c, CellDrills: cd})
		grand.add(sum)
	}
	if v := vals[opsNoTaxItem]; v != nil && nonzero(v) {
		c := cells(v)
		c["label"] = "No Sales Tax Item"
		cd := opsTaxSalesDrills(p, []int64{opsNoTaxItem}, v, 0)
		opsTaxLiabilityDrills(p, cd, stp, []int64{opsNoTaxItem}, v)
		b.rowFull(model.ReportRow{Kind: "data", Cells: c, CellDrills: cd})
		grand.add(v)
	}
	c := cells(grand)
	c["label"] = "TOTAL"
	cd := opsTaxSalesDrills(p, nil, grand, 0)
	opsTaxLiabilityDrills(p, cd, stp, nil, grand)
	b.rowFull(model.ReportRow{Kind: "grandtotal", Cells: c, CellDrills: cd})
	return b.r, nil
}

func opsSalesTaxRevenue(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	basis := integTaxBasis(p)
	vals, err := opsTaxSales(ctx, q, items, from, to, basis == "cash")
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Sales Tax Revenue Summary", false, false,
		opsC("label", "", "text"), opsC("sales", "Total Sales", "money"), opsC("nontax", "Non-Taxable Sales", "money"),
		opsC("taxable", "Taxable Sales", "money"))
	b.r.Basis = BasisLabel(basis)
	b.r.Params = p.Echo()
	b.r.Params["basis"] = basis
	cells := func(v opsVals) map[string]any {
		return map[string]any{"sales": opsMF(v["sales"]), "nontax": opsMF(v["sales"] - v["taxable"]), "taxable": opsMF(v["taxable"])}
	}
	var ids []int64
	for id := range vals {
		if id > 0 && items[id] != nil {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return strings.ToLower(items[ids[i]].Full) < strings.ToLower(items[ids[j]].Full) })
	grand := opsVals{}
	for _, id := range ids {
		c := cells(vals[id])
		c["label"] = items[id].Full
		b.rowFull(model.ReportRow{Kind: "data", Cells: c, Drill: opsDrill("item_quickreport", "itemId", opsID(id), "from", p.From, "to", p.To),
			CellDrills: opsTaxSalesDrills(p, []int64{id}, vals[id], 0)})
		grand.add(vals[id])
	}
	if v := vals[opsNoTaxItem]; v != nil {
		c := cells(v)
		c["label"] = "No Sales Tax Item"
		b.row("data", 0, "", c)
		grand.add(v)
	}
	c := cells(grand)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}
