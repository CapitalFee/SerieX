package reports

// Inventory reports, computed from inventory_moves.

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
	const inv = "Inventory"
	register(model.ReportInfo{Key: "inventory_valuation_summary", Title: "Inventory Valuation Summary", Category: inv,
		Description: "What is my inventory worth?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "today"}, opsInvValSummary)
	register(model.ReportInfo{Key: "inventory_valuation_detail", Title: "Inventory Valuation Detail", Category: inv,
		Description: "Which transactions affected the value of my inventory?",
		Params:      []string{"dates", "itemId", "filters"}, DefaultDates: "thisMonthToDate"}, opsInvValDetail)
	register(model.ReportInfo{Key: "inventory_stock_status_by_item", Title: "Inventory Stock Status by Item", Category: inv,
		Description: "How many of each item do I have, and do I need to reorder?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisMonthToDate"}, opsStockStatus(false))
	register(model.ReportInfo{Key: "inventory_stock_status_by_vendor", Title: "Inventory Stock Status by Vendor", Category: inv,
		Description: "Which items do I need to reorder from each vendor?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisMonthToDate"}, opsStockStatus(true))
	register(model.ReportInfo{Key: "physical_inventory_worksheet", Title: "Physical Inventory Worksheet", Category: inv,
		Description: "A worksheet for counting the inventory on hand.",
		Params:      []string{}, DefaultDates: "today"}, opsPhysicalWorksheet)
}

// opsInvBalances returns Σqty and Σvalue (cents) of the inventory moves of
// every item dated on or before asOf (before: strictly before).
func opsInvBalances(ctx context.Context, q store.Q, date string, before bool) (map[int64][2]float64, error) {
	op := "<="
	if before {
		op = "<"
	}
	rows, err := q.QueryContext(ctx, `SELECT item_id, SUM(qty), SUM(value) FROM inventory_moves WHERE date `+op+` ? GROUP BY item_id`, date)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][2]float64{}
	for rows.Next() {
		var id int64
		var qty float64
		var val int64
		if err := rows.Scan(&id, &qty, &val); err != nil {
			return nil, err
		}
		out[id] = [2]float64{qty, float64(val)}
	}
	return out, rows.Err()
}

// opsInvItems returns the inventory part ids that pass the item filter.
func opsInvItems(p *Params, items map[int64]*opsItem) map[int64]bool {
	f := opsItemFilter(p, items)
	out := map[int64]bool{}
	for id, it := range items {
		if it.Type != model.ItemInventoryPart {
			continue
		}
		if f != nil && !f[id] {
			continue
		}
		out[id] = true
	}
	return out
}

func opsInvValSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	bal, err := opsInvBalances(ctx, q, p.AsOf, false)
	if err != nil {
		return nil, err
	}
	vals := map[int64]opsVals{}
	var totVal, totRetail float64
	hasKids := map[int64]bool{}
	for _, it := range items {
		hasKids[it.ParentID] = true
	}
	for id := range opsInvItems(p, items) {
		it := items[id]
		bq := bal[id]
		if bq[0] == 0 && bq[1] == 0 && (!it.Active || hasKids[id]) {
			continue
		}
		retail := float64(store.Cents(bq[0] * it.SalesPrice))
		vals[id] = opsVals{"onhand": bq[0], "value": bq[1], "price": it.SalesPrice, "retail": retail, "n": 1, "item": float64(id)}
		totVal += bq[1]
		totRetail += retail
	}
	b := opsNew(ctx, q, p, "Inventory Valuation Summary", true, false,
		opsC("label", "", "text"), opsC("desc", "Item Description", "text"), opsC("onhand", "On Hand", "number"),
		opsC("avg", "Avg Cost", "money"), opsC("value", "Asset Value", "money"), opsC("pctasset", "% of Tot Asset", "percent"),
		opsC("price", "Sales Price", "money"), opsC("retail", "Retail Value", "money"), opsC("pctretail", "% of Tot Retail", "percent"))
	cells := func(v opsVals) map[string]any {
		c := map[string]any{"onhand": opsQty(v["onhand"]), "value": opsMF(v["value"]), "pctasset": opsPct(v["value"], totVal),
			"retail": opsMF(v["retail"]), "pctretail": opsPct(v["retail"], totRetail)}
		if v["n"] == 1 {
			if v["onhand"] != 0 {
				c["avg"] = math.Round(v["value"]/v["onhand"]) / 100
			} else {
				c["avg"] = 0.0
			}
			c["price"] = v["price"]
			if it, ok := items[int64(v["item"])]; ok {
				c["desc"] = it.Description
			}
		}
		return c
	}
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := []string{"from", "", "to", p.AsOf, "itemIds", opsID(id)}
		if own {
			kv = append(kv, "includeSubitems", "0")
		}
		return opsDrill("inventory_valuation_detail", kv...)
	}
	totalCells := func(v opsVals) map[string]any {
		t := v.clone()
		t["n"] = 0
		return cells(t)
	}
	grand := opsVals{}
	if len(vals) > 0 {
		g := b.group()
		b.row("section", 0, g, map[string]any{"label": "Inventory"})
		grand = b.sumTree(&opsSumSpec{tree: opsItemTree(items), vals: vals, cells: cells, totalCells: totalCells, drill: drill}, 1, g)
		grand["n"] = 0
		c := cells(grand)
		c["label"] = "Total Inventory"
		b.row("subtotal", 0, g, c)
	}
	grand["n"] = 0
	c := cells(grand)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsInvValDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	start, err := opsInvBalances(ctx, q, from, true)
	if err != nil {
		return nil, err
	}
	allowed := opsInvItems(p, items)
	rows, err := q.QueryContext(ctx, `SELECT m.item_id, m.date, m.qty, m.value, m.cost_known, t.id, t.type, t.ref_number, IFNULL(t.name_id, 0)
		FROM inventory_moves m JOIN txns t ON t.id = m.txn_id
		WHERE m.date >= ? AND m.date <= ? ORDER BY m.item_id, m.date, m.txn_id, m.id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type mv struct {
		date, typ, ref string
		qty            float64
		value          int64
		known          bool
		txn, name      int64
	}
	byItem := map[int64][]mv{}
	for rows.Next() {
		var item int64
		var m mv
		if err := rows.Scan(&item, &m.date, &m.qty, &m.value, &m.known, &m.txn, &m.typ, &m.ref, &m.name); err != nil {
			return nil, err
		}
		if !allowed[item] {
			continue
		}
		byItem[item] = append(byItem[item], m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Inventory Valuation Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("name", "Name", "text"),
		opsC("num", "Num", "text"), opsC("qty", "Qty", "number"), opsC("cost", "Cost", "money"), opsC("onhand", "On Hand", "number"),
		opsC("avg", "Avg Cost", "money"), opsC("value", "Asset Value", "money"))
	avg := func(qty, val float64) any {
		if qty <= 0 {
			return 0.0
		}
		return math.Round(val/qty) / 100
	}
	totalCells := func(v opsVals) map[string]any {
		return map[string]any{"qty": opsQty(v["qty"]), "onhand": opsQty(v["onhand"]), "value": opsMF(v["value"])}
	}
	spec := &opsDetSpec{
		tree: opsItemTree(items),
		has:  func(id int64) bool { return len(byItem[id]) > 0 },
		emit: func(id int64, level int, g string) opsVals {
			q0, v0 := start[id][0], start[id][1]
			var sumQty float64
			for _, m := range byItem[id] {
				q0 += m.qty
				v0 += float64(m.value)
				sumQty += m.qty
				cells := map[string]any{"type": opsTypeLabel(m.typ, ""), "date": m.date, "name": opsNameFull(names, m.name),
					"num": m.ref, "qty": opsQty(m.qty), "onhand": opsQty(q0), "avg": avg(q0, v0), "value": opsMF(v0)}
				if m.known {
					cells["cost"] = opsM(m.value)
				}
				b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(m.txn), Cells: cells})
			}
			return opsVals{"qty": sumQty, "onhand": q0, "value": v0}
		},
		total: totalCells,
	}
	grand := opsVals{}
	if len(byItem) > 0 {
		g := b.group()
		b.row("section", 0, g, map[string]any{"label": "Inventory"})
		grand = b.detTree(spec, 1)
		c := totalCells(grand)
		c["label"] = "Total Inventory"
		b.row("subtotal", 0, g, c)
	}
	c := totalCells(grand)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

// opsOnPO returns the quantity still on open purchase orders and the earliest
// expected delivery date of each item.
func opsOnPO(ctx context.Context, q store.Q) (map[int64]float64, map[int64]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT l.item_id, l.qty, l.received_qty, l.closed, t.due_date, t.ship_date, t.date
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type = 'PURCHORD' AND t.status <> 'Closed' AND t.voided = 0 AND l.item_id IS NOT NULL`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	onPO, next := map[int64]float64{}, map[int64]string{}
	for rows.Next() {
		var id int64
		var qty sql.NullFloat64
		var rcvd float64
		var closed bool
		var due, ship, date string
		if err := rows.Scan(&id, &qty, &rcvd, &closed, &due, &ship, &date); err != nil {
			return nil, nil, err
		}
		if closed || !qty.Valid {
			continue
		}
		rem := qty.Float64 - rcvd
		if rem <= 0 {
			continue
		}
		onPO[id] += rem
		d := due
		if d == "" {
			d = ship
		}
		if d == "" {
			d = date
		}
		if cur, ok := next[id]; !ok || d < cur {
			next[id] = d
		}
	}
	return onPO, next, rows.Err()
}

// opsWalkItems visits the inventory items in hierarchy order (depth-first, by name).
func opsWalkItems(t *opsTree, keep map[int64]bool, fn func(id int64, level int)) {
	var walk func(id int64, level int)
	memo := map[int64]bool{}
	has := func(id int64) bool { return keep[id] }
	walk = func(id int64, level int) {
		if !t.hasAny(id, has, memo) {
			return
		}
		fn(id, level)
		for _, c := range t.children[id] {
			walk(c, level+1)
		}
	}
	for _, r := range t.children[0] {
		walk(r, 0)
	}
}

func opsStockStatus(byVendor bool) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		items, err := opsLoadItems(ctx, q)
		if err != nil {
			return nil, err
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		bal, err := opsInvBalances(ctx, q, p.To, false)
		if err != nil {
			return nil, err
		}
		onPO, next, err := opsOnPO(ctx, q)
		if err != nil {
			return nil, err
		}
		from, to := opsFromTo(p)
		if p.From == "" {
			q.QueryRowContext(ctx, `SELECT IFNULL(MIN(date), ?) FROM inventory_moves`, to).Scan(&from)
		}
		sold := map[int64]float64{}
		srows, err := q.QueryContext(ctx, `SELECT m.item_id, SUM(-m.qty) FROM inventory_moves m JOIN txns t ON t.id = m.txn_id
			WHERE t.type IN ('INV','SALESRCPT','CREDMEM') AND m.date >= ? AND m.date <= ? GROUP BY m.item_id`, from, to)
		if err != nil {
			return nil, err
		}
		for srows.Next() {
			var id int64
			var qty float64
			if err := srows.Scan(&id, &qty); err != nil {
				srows.Close()
				return nil, err
			}
			sold[id] = qty
		}
		if err := srows.Err(); err != nil {
			srows.Close()
			return nil, err
		}
		srows.Close()
		weeks := float64(opsDays(from, to)+1) / 7
		if weeks <= 0 {
			weeks = 1
		}
		keep := map[int64]bool{}
		for id := range opsInvItems(p, items) {
			if items[id].Active || bal[id][0] != 0 {
				keep[id] = true
			}
		}
		title := "Inventory Stock Status by Item"
		cols := []model.ReportColumn{opsC("label", "", "text"), opsC("desc", "Item Description", "text")}
		if byVendor {
			title = "Inventory Stock Status by Vendor"
		} else {
			cols = append(cols, opsC("vendor", "Pref Vendor", "text"))
		}
		cols = append(cols, opsC("reorder", "Reorder Pt", "number"), opsC("onhand", "On Hand", "number"),
			opsC("order", "Order", "text"), opsC("onpo", "On PO", "number"), opsC("nextdeliv", "Next Deliv", "date"),
			opsC("salesweek", "Sales/Week", "number"))
		b := opsNew(ctx, q, p, title, false, false, cols...)
		itemCells := func(id int64) map[string]any {
			it := items[id]
			onhand := bal[id][0]
			c := map[string]any{"desc": it.Description, "onhand": opsQty(onhand), "onpo": opsQty(onPO[id]),
				"salesweek": math.Round(sold[id]/weeks*10) / 10}
			if !byVendor {
				c["vendor"] = opsNameFull(names, it.PrefVendor)
			}
			if it.ReorderPoint.Valid {
				c["reorder"] = opsQty(it.ReorderPoint.Float64)
				if onhand <= it.ReorderPoint.Float64 {
					c["order"] = "✓"
				}
			}
			if d, ok := next[id]; ok {
				c["nextdeliv"] = d
			}
			return c
		}
		tree := opsItemTree(items)
		if !byVendor {
			g := b.group()
			b.row("section", 0, g, map[string]any{"label": "Inventory"})
			opsWalkItems(tree, keep, func(id int64, level int) {
				if !keep[id] {
					b.row("section", level+1, g, map[string]any{"label": tree.label[id]})
					return
				}
				c := itemCells(id)
				c["label"] = tree.label[id]
				b.rowFull(model.ReportRow{Kind: "data", Level: level + 1, Group: g, Cells: c,
					Drill: opsDrill("item_quickreport", "itemId", opsID(id), "from", p.From, "to", p.To)})
			})
			b.row("subtotal", 0, g, map[string]any{"label": "Total Inventory"})
			return b.r, nil
		}
		byV := map[int64][]int64{}
		for id := range keep {
			v := items[id].PrefVendor
			if _, ok := names[v]; !ok {
				v = 0
			}
			byV[v] = append(byV[v], id)
		}
		var vendors []int64
		for v := range byV {
			vendors = append(vendors, v)
		}
		sort.Slice(vendors, func(i, j int) bool {
			if (vendors[i] == 0) != (vendors[j] == 0) {
				return vendors[j] == 0
			}
			return strings.ToLower(opsNameFull(names, vendors[i])) < strings.ToLower(opsNameFull(names, vendors[j]))
		})
		for _, v := range vendors {
			ids := byV[v]
			sort.Slice(ids, func(i, j int) bool { return strings.ToLower(items[ids[i]].Full) < strings.ToLower(items[ids[j]].Full) })
			label := opsNameFull(names, v)
			if v == 0 {
				label = "No Preferred Vendor"
			}
			g := b.group()
			b.row("section", 0, g, map[string]any{"label": label})
			for _, id := range ids {
				c := itemCells(id)
				c["label"] = items[id].Full
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, Cells: c,
					Drill: opsDrill("item_quickreport", "itemId", opsID(id), "from", p.From, "to", p.To)})
			}
			b.row("subtotal", 0, g, map[string]any{"label": "Total " + label})
		}
		return b.r, nil
	}
}

func opsPhysicalWorksheet(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	bal, err := opsInvBalances(ctx, q, "9999-12-31", false)
	if err != nil {
		return nil, err
	}
	keep := map[int64]bool{}
	for id := range opsInvItems(p, items) {
		if items[id].Active {
			keep[id] = true
		}
	}
	r := NewResult(ctx, q, p, "Physical Inventory Worksheet", false, false)
	r.DateRangeLabel = "All Transactions"
	b := &opsBuilder{r: r}
	b.r.Columns = []model.ReportColumn{opsC("label", "Item", "text"), opsC("desc", "Description", "text"),
		opsC("vendor", "Preferred Vendor", "text"), opsC("onhand", "Quantity On Hand", "number"),
		opsC("count", "Physical Count", "text")}
	tree := opsItemTree(items)
	opsWalkItems(tree, keep, func(id int64, level int) {
		it := items[id]
		if !keep[id] {
			b.row("section", level, "", map[string]any{"label": tree.label[id]})
			return
		}
		b.rowFull(model.ReportRow{Kind: "data", Level: level, Cells: map[string]any{"label": tree.label[id], "desc": it.Description,
			"vendor": opsNameFull(names, it.PrefVendor), "onhand": opsQty(bal[id][0]), "count": ""},
			Drill: opsDrill("item_quickreport", "itemId", opsID(id), "dates", "all")})
	})
	return b.r, nil
}
