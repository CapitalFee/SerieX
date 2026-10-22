package reports

// Purchases reports: purchases by vendor / item and open purchase orders.

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const pu = "Purchases"
	register(model.ReportInfo{Key: "purchases_by_vendor_summary", Title: "Purchases by Vendor Summary", Category: pu,
		Description: "How much have I purchased from each vendor?",
		Params:      []string{"dates", "basis", "columns", "filters"}, DefaultDates: "thisMonthToDate"}, opsPurchByVendorSummary)
	register(model.ReportInfo{Key: "purchases_by_vendor_detail", Title: "Purchases by Vendor Detail", Category: pu,
		Description: "Which items did I purchase from each vendor?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsPurchByVendorDetail)
	register(model.ReportInfo{Key: "purchases_by_item_summary", Title: "Purchases by Item Summary", Category: pu,
		Description: "How many of each item did I purchase, and for how much?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsPurchByItemSummary)
	register(model.ReportInfo{Key: "purchases_by_item_detail", Title: "Purchases by Item Detail", Category: pu,
		Description: "Which purchases make up the totals of each item?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsPurchByItemDetail)
	register(model.ReportInfo{Key: "open_purchase_orders", Title: "Open Purchase Orders", Category: pu,
		Description: "Which purchase orders are still open?",
		Params:      []string{"dates", "filters"}, DefaultDates: "all"}, opsOpenPOs)
	register(model.ReportInfo{Key: "open_purchase_orders_detail", Title: "Open Purchase Orders Detail", Category: pu,
		Description: "Which items are still on order, by vendor?",
		Params:      []string{"dates", "filters"}, DefaultDates: "all"}, opsOpenPOsDetail)
}

type opsPurch struct {
	TxnID, NameID, HdrAcct, ItemID, LineName int64
	Type, Date, Ref, Memo, Desc              string
	Qty, Rate                                float64
	HasRate                                  bool
	Amount                                   int64 // positive = purchase, negative = vendor credit
}

// opsLoadPurchases returns the item lines of checks, bills, item receipts and
// credit card charges (positive) and vendor / credit card credits (negative).
// On the cash basis bills, item receipts and vendor credits count when (and
// in the proportion) they are paid or used, dated at the paying transaction.
func opsLoadPurchases(ctx context.Context, q store.Q, p *Params, names map[int64]*opsName, items map[int64]*opsItem) ([]*opsPurch, error) {
	from, to := opsFromTo(p)
	if !p.IsCash() {
		return opsScanPurchases(ctx, q, p, names, items, `t.type IN ('CHK','BILL','ITEMRCPT','CCCHARGE','BILLCRED','CCCREDIT') AND t.date >= ? AND t.date <= ?`, from, to)
	}
	out, err := opsScanPurchases(ctx, q, p, names, items, `t.type IN ('CHK','CCCHARGE','CCCREDIT') AND t.date >= ? AND t.date <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	type part struct {
		txn  int64
		frac float64
		date string
	}
	rows, err := q.QueryContext(ctx, `SELECT l.from_txn_id, f.type, f.amount, l.to_txn_id, t.type, t.amount, l.amount + l.discount, l.date
		FROM txn_links l JOIN txns f ON f.id = l.from_txn_id JOIN txns t ON t.id = l.to_txn_id
		WHERE l.date >= ? AND l.date <= ? AND t.type IN ('BILL','ITEMRCPT')`, from, to)
	if err != nil {
		return nil, err
	}
	var parts []part
	need := map[int64]bool{}
	for rows.Next() {
		var fid, famt, tid, tamt, x int64
		var ftype, ttype, date string
		if err := rows.Scan(&fid, &ftype, &famt, &tid, &ttype, &tamt, &x, &date); err != nil {
			rows.Close()
			return nil, err
		}
		if tamt != 0 {
			parts = append(parts, part{tid, float64(x) / float64(tamt), date})
			need[tid] = true
		}
		if ftype == model.TxVendorCredit && famt != 0 {
			parts = append(parts, part{fid, float64(x) / float64(famt), date})
			need[fid] = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(parts) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(need))
	for id := range need {
		ids = append(ids, opsID(id))
	}
	base, err := opsScanPurchases(ctx, q, p, names, items, `t.id IN (`+strings.Join(ids, ",")+`)`)
	if err != nil {
		return nil, err
	}
	byTxn := map[int64][]*opsPurch{}
	for _, x := range base {
		byTxn[x.TxnID] = append(byTxn[x.TxnID], x)
	}
	for _, pt := range parts {
		for _, x := range byTxn[pt.txn] {
			c := *x
			c.Date = pt.date
			c.Amount = int64(math.Round(float64(x.Amount) * pt.frac))
			c.Qty = x.Qty * pt.frac
			out = append(out, &c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].TxnID < out[j].TxnID
	})
	return out, nil
}

// opsScanPurchases reads purchase item lines matching where (with args) and
// the report filters.
func opsScanPurchases(ctx context.Context, q store.Q, p *Params, names map[int64]*opsName, items map[int64]*opsItem, where string, args ...any) ([]*opsPurch, error) {
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, t.memo, IFNULL(t.name_id, 0), IFNULL(t.account_id, 0),
		l.item_id, l.description, l.qty, l.rate, l.amount, IFNULL(l.name_id, 0)
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.voided = 0 AND l.item_id IS NOT NULL AND `+where+`
		ORDER BY t.date, t.ref_number, t.id, l.seq`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nf, itf, types := opsNameSet(p, names), opsItemFilter(p, items), opsTypeSet(p)
	var out []*opsPurch
	for rows.Next() {
		x := &opsPurch{}
		var qty, rate sql.NullFloat64
		if err := rows.Scan(&x.TxnID, &x.Type, &x.Date, &x.Ref, &x.Memo, &x.NameID, &x.HdrAcct, &x.ItemID, &x.Desc, &qty, &rate,
			&x.Amount, &x.LineName); err != nil {
			return nil, err
		}
		if qty.Valid {
			x.Qty = qty.Float64
		}
		if rate.Valid {
			x.Rate, x.HasRate = rate.Float64, true
		}
		if x.Type == model.TxVendorCredit || x.Type == model.TxCCCredit {
			x.Amount, x.Qty = -x.Amount, -x.Qty
		}
		if (nf != nil && !nf[x.NameID]) || (itf != nil && !itf[x.ItemID]) || (types != nil && !types[x.Type]) {
			continue
		}
		if !opsTextOK(p, x.Desc+" "+x.Memo, x.Ref) {
			continue
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func opsPurchByVendorSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	list, err := opsLoadPurchases(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	ps := opsPeriods(p)
	vals := map[int64]opsVals{}
	for _, x := range list {
		id := opsNodeOf(names, x.NameID)
		if vals[id] == nil {
			vals[id] = opsVals{}
		}
		opsAddPeriod(vals[id], ps, x.Date, float64(x.Amount))
	}
	b := opsNew(ctx, q, p, "Purchases by Vendor Summary", false, true, opsPeriodCols(ps)...)
	cells := opsPeriodCells(ps)
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := []string{"from", p.From, "to", p.To}
		if id > 0 {
			jobs := "1"
			if own {
				jobs = "0"
			}
			kv = append(kv, "nameIds", opsID(id), "includeJobs", jobs)
		}
		return opsDrill("purchases_by_vendor_detail", kv...)
	}
	total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill}, 0, "")
	c := cells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func (b *opsBuilder) opsPurchRows(list []*opsPurch, level int, g string, names map[int64]*opsName, items map[int64]*opsItem, byVendor bool) opsVals {
	var run int64
	var qty float64
	for _, x := range list {
		run += x.Amount
		qty += x.Qty
		memo := x.Desc
		if memo == "" {
			memo = x.Memo
		}
		cells := map[string]any{"type": opsTypeLabel(x.Type, ""), "date": x.Date, "num": x.Ref, "memo": memo,
			"amount": opsM(x.Amount), "balance": opsM(run)}
		if byVendor {
			if it, ok := items[x.ItemID]; ok {
				cells["item"] = it.Full
			}
		} else {
			cells["source"] = opsNameFull(names, x.NameID)
		}
		if x.Qty != 0 {
			cells["qty"] = opsQty(x.Qty)
		}
		if x.HasRate {
			cells["cost"] = x.Rate
		}
		b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(x.TxnID), Cells: cells})
	}
	return opsVals{"amount": float64(run), "qty": qty}
}

func opsPurchByVendorDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	list, err := opsLoadPurchases(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	byName := map[int64][]*opsPurch{}
	for _, x := range list {
		id := opsNodeOf(names, x.NameID)
		byName[id] = append(byName[id], x)
	}
	b := opsNew(ctx, q, p, "Purchases by Vendor Detail", false, true,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("memo", "Memo", "text"), opsC("item", "Item", "text"), opsC("qty", "Qty", "number"),
		opsC("cost", "Cost Price", "money"), opsC("amount", "Amount", "money"), opsC("balance", "Balance", "money"))
	spec := &opsDetSpec{
		tree: opsNameTree(names, "No name"),
		has:  func(id int64) bool { return len(byName[id]) > 0 },
		emit: func(id int64, level int, g string) opsVals {
			return b.opsPurchRows(byName[id], level, g, names, items, true)
		},
		total: opsSaleTotalCells,
	}
	total := b.detTree(spec, 0)
	c := opsSaleTotalCells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsPurchByItemSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	list, err := opsLoadPurchases(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	vals := map[int64]opsVals{}
	for _, x := range list {
		id := opsItemNode(items, x.ItemID)
		v := vals[id]
		if v == nil {
			v = opsVals{}
			vals[id] = v
		}
		v["qty"] += x.Qty
		v["amount"] += float64(x.Amount)
	}
	b := opsNew(ctx, q, p, "Purchases by Item Summary", false, true,
		opsC("label", "", "text"), opsC("qty", "Qty", "number"), opsC("amount", "Amount", "money"))
	cells := func(v opsVals) map[string]any {
		return map[string]any{"qty": opsQty(v["qty"]), "amount": opsMF(v["amount"])}
	}
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := []string{"from", p.From, "to", p.To}
		if id > 0 {
			kv = append(kv, "itemIds", opsID(id))
			if own {
				kv = append(kv, "includeSubitems", "0")
			}
		}
		return opsDrill("purchases_by_item_detail", kv...)
	}
	tree := opsItemTree(items)
	has := func(id int64) bool { _, ok := vals[id]; return ok }
	grand := opsVals{}
	for _, grp := range opsItemTypeGroups(tree, items) {
		label, roots := grp[0].(string), grp[1].([]int64)
		memo := map[int64]bool{}
		found := false
		for _, r := range roots {
			if tree.hasAny(r, has, memo) {
				found = true
			}
		}
		if !found {
			continue
		}
		g := b.group()
		b.row("section", 0, g, map[string]any{"label": label})
		sum := b.sumTree(&opsSumSpec{tree: tree, vals: vals, roots: roots, cells: cells, drill: drill}, 1, g)
		c := cells(sum)
		c["label"] = "Total " + label
		b.row("subtotal", 0, g, c)
		grand.add(sum)
	}
	c := cells(grand)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsPurchByItemDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	list, err := opsLoadPurchases(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	byItem := map[int64][]*opsPurch{}
	for _, x := range list {
		id := opsItemNode(items, x.ItemID)
		byItem[id] = append(byItem[id], x)
	}
	b := opsNew(ctx, q, p, "Purchases by Item Detail", false, true,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("memo", "Memo", "text"), opsC("source", "Source Name", "text"), opsC("qty", "Qty", "number"),
		opsC("cost", "Cost Price", "money"), opsC("amount", "Amount", "money"), opsC("balance", "Balance", "money"))
	tree := opsItemTree(items)
	has := func(id int64) bool { return len(byItem[id]) > 0 }
	grand := opsVals{}
	for _, grp := range opsItemTypeGroups(tree, items) {
		label, roots := grp[0].(string), grp[1].([]int64)
		memo := map[int64]bool{}
		found := false
		for _, r := range roots {
			if tree.hasAny(r, has, memo) {
				found = true
			}
		}
		if !found {
			continue
		}
		g := b.group()
		b.row("section", 0, g, map[string]any{"label": label})
		spec := &opsDetSpec{
			tree: tree, has: has, roots: roots,
			emit: func(id int64, level int, g string) opsVals {
				return b.opsPurchRows(byItem[id], level, g, names, items, false)
			},
			total: opsSaleTotalCells,
		}
		sum := b.detTree(spec, 1)
		c := opsSaleTotalCells(sum)
		c["label"] = "Total " + label
		b.row("subtotal", 0, g, c)
		grand.add(sum)
	}
	c := opsSaleTotalCells(grand)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

type opsPOLine struct {
	TxnID, LineID, ItemID int64
	Desc                  string
	Qty, Rate, Received   float64
	HasQty, HasRate       bool
	Amount, Open          int64
	Closed                bool
}

type opsPO struct {
	ID, NameID             int64
	Date, Ref, Deliv, Memo string
	Amount, Open           int64
	Lines                  []*opsPOLine
}

// opsOpenPOList returns the open purchase orders with the unreceived value of each line.
func opsOpenPOList(ctx context.Context, q store.Q, p *Params, names map[int64]*opsName, items map[int64]*opsItem) ([]*opsPO, error) {
	from, to := opsFromTo(p)
	rows, err := q.QueryContext(ctx, `SELECT id, IFNULL(name_id, 0), date, ref_number, due_date, ship_date, memo, amount
		FROM txns WHERE type = 'PURCHORD' AND status <> 'Closed' AND voided = 0 AND date >= ? AND date <= ?
		ORDER BY date, ref_number, id`, from, to)
	if err != nil {
		return nil, err
	}
	nf, itf := opsNameSet(p, names), opsItemFilter(p, items)
	var pos []*opsPO
	byID := map[int64]*opsPO{}
	for rows.Next() {
		po := &opsPO{}
		var due, ship string
		if err := rows.Scan(&po.ID, &po.NameID, &po.Date, &po.Ref, &due, &ship, &po.Memo, &po.Amount); err != nil {
			rows.Close()
			return nil, err
		}
		po.Deliv = due
		if po.Deliv == "" {
			po.Deliv = ship
		}
		if nf != nil && !nf[po.NameID] {
			continue
		}
		if !opsTextOK(p, po.Memo, po.Ref) {
			continue
		}
		pos = append(pos, po)
		byID[po.ID] = po
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	lrows, err := q.QueryContext(ctx, `SELECT l.txn_id, l.id, IFNULL(l.item_id, 0), l.description, l.qty, l.rate, l.amount, l.received_qty, l.closed
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type = 'PURCHORD' AND t.status <> 'Closed' AND t.date >= ? AND t.date <= ? ORDER BY l.txn_id, l.seq`, from, to)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		l := &opsPOLine{}
		var qty, rate sql.NullFloat64
		if err := lrows.Scan(&l.TxnID, &l.LineID, &l.ItemID, &l.Desc, &qty, &rate, &l.Amount, &l.Received, &l.Closed); err != nil {
			return nil, err
		}
		po := byID[l.TxnID]
		if po == nil {
			continue
		}
		l.Qty, l.HasQty = qty.Float64, qty.Valid
		l.Rate, l.HasRate = rate.Float64, rate.Valid
		switch {
		case l.Closed:
		case l.HasQty && l.Qty != 0:
			rem := math.Max(0, l.Qty-l.Received)
			if l.HasRate {
				l.Open = store.Cents(rem * l.Rate)
			} else {
				l.Open = int64(math.Round(float64(l.Amount) * rem / l.Qty))
			}
		case l.Received == 0:
			l.Open = l.Amount
		}
		if itf != nil && !itf[l.ItemID] {
			continue
		}
		po.Lines = append(po.Lines, l)
		po.Open += l.Open
	}
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	out := pos[:0]
	for _, po := range pos {
		if po.Open > 0 {
			out = append(out, po)
		}
	}
	return out, nil
}

func opsOpenPOs(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	pos, err := opsOpenPOList(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Open Purchase Orders", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("name", "Name", "text"),
		opsC("num", "Num", "text"), opsC("deliv", "Deliv Date", "date"), opsC("amount", "Amount", "money"),
		opsC("open", "Open Balance", "money"))
	var amt, open int64
	for _, po := range pos {
		cells := map[string]any{"type": "Purchase Order", "date": po.Date, "name": opsNameFull(names, po.NameID), "num": po.Ref,
			"amount": opsM(po.Amount), "open": opsM(po.Open)}
		if po.Deliv != "" {
			cells["deliv"] = po.Deliv
		}
		b.rowFull(model.ReportRow{Kind: "data", TxnID: opsTxnRef(po.ID), Cells: cells})
		amt += po.Amount
		open += po.Open
	}
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsM(amt), "open": opsM(open)})
	return b.r, nil
}

func opsOpenPOsDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	pos, err := opsOpenPOList(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	byName := map[int64][]*opsPO{}
	for _, po := range pos {
		id := opsNodeOf(names, po.NameID)
		byName[id] = append(byName[id], po)
	}
	b := opsNew(ctx, q, p, "Open Purchase Orders Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("item", "Item", "text"), opsC("memo", "Memo", "text"), opsC("deliv", "Deliv Date", "date"),
		opsC("qty", "Qty", "number"), opsC("rcvd", "Rcv'd", "number"), opsC("backordered", "Backordered", "number"),
		opsC("amount", "Amount", "money"), opsC("open", "Open Balance", "money"))
	spec := &opsDetSpec{
		tree: opsNameTree(names, "No name"),
		has:  func(id int64) bool { return len(byName[id]) > 0 },
		emit: func(id int64, level int, g string) opsVals {
			v := opsVals{}
			for _, po := range byName[id] {
				for _, l := range po.Lines {
					if l.Open == 0 {
						continue
					}
					cells := map[string]any{"type": "Purchase Order", "date": po.Date, "num": po.Ref, "memo": l.Desc,
						"amount": opsM(l.Amount), "open": opsM(l.Open)}
					if it, ok := items[l.ItemID]; ok {
						cells["item"] = it.Full
					}
					if po.Deliv != "" {
						cells["deliv"] = po.Deliv
					}
					if l.HasQty {
						cells["qty"] = opsQty(l.Qty)
						cells["rcvd"] = opsQty(l.Received)
						cells["backordered"] = opsQty(math.Max(0, l.Qty-l.Received))
					}
					b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(po.ID), Cells: cells})
					v["amount"] += float64(l.Amount)
					v["open"] += float64(l.Open)
				}
			}
			return v
		},
		total: func(v opsVals) map[string]any {
			return map[string]any{"amount": opsMF(v["amount"]), "open": opsMF(v["open"])}
		},
	}
	total := b.detTree(spec, 0)
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsMF(total["amount"]), "open": opsMF(total["open"])})
	return b.r, nil
}
