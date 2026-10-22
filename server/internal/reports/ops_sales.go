package reports

// Sales and Jobs reports.

import (
	"context"
	"database/sql"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const sales, jobs = "Sales", "Jobs"
	register(model.ReportInfo{Key: "sales_by_customer_summary", Title: "Sales by Customer Summary", Category: sales,
		Description: "What are my total sales for each customer and job?",
		Params:      []string{"dates", "basis", "columns", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByCustomerSummary)
	register(model.ReportInfo{Key: "sales_by_customer_detail", Title: "Sales by Customer Detail", Category: sales,
		Description: "What did each customer buy, and when?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByCustomerDetail)
	register(model.ReportInfo{Key: "sales_by_item_summary", Title: "Sales by Item Summary", Category: sales,
		Description: "How much of each item did I sell, and what was my gross margin?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByItemSummary)
	register(model.ReportInfo{Key: "sales_by_item_detail", Title: "Sales by Item Detail", Category: sales,
		Description: "Which transactions make up the sales of each item?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByItemDetail)
	register(model.ReportInfo{Key: "sales_by_rep_summary", Title: "Sales by Rep Summary", Category: sales,
		Description: "What are the total sales of each sales rep?",
		Params:      []string{"dates", "basis", "columns", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByRepSummary)
	register(model.ReportInfo{Key: "sales_by_rep_detail", Title: "Sales by Rep Detail", Category: sales,
		Description: "Which sales did each sales rep make?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "thisMonthToDate"}, opsSalesByRepDetail)
	register(model.ReportInfo{Key: "pending_sales", Title: "Pending Sales", Category: sales,
		Description: "Which sales are marked pending?",
		Params:      []string{"dates", "filters"}, DefaultDates: "all"}, opsPendingSales)
	register(model.ReportInfo{Key: "job_profitability_summary", Title: "Job Profitability Summary", Category: jobs,
		Description: "How much money have I made or lost on each job?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "all"}, opsJobProfitability)
	register(model.ReportInfo{Key: "job_estimates_vs_actuals_summary", Title: "Job Estimates vs. Actuals Summary", Category: jobs,
		Description: "How well have I estimated costs and revenues for each job?",
		Params:      []string{"dates", "basis", "filters"}, DefaultDates: "all"}, opsJobEstVsActuals)
}

// opsSalesFiltered loads the sales lines of the report period with the name / item filters applied.
func opsSalesFiltered(ctx context.Context, q store.Q, p *Params, names map[int64]*opsName, items map[int64]*opsItem) ([]*opsSale, error) {
	from, to := opsFromTo(p)
	sales, err := opsLoadSales(ctx, q, from, to, p.IsCash())
	if err != nil {
		return nil, err
	}
	nf, itf, types := opsNameSet(p, names), opsItemFilter(p, items), opsTypeSet(p)
	out := sales[:0]
	for _, s := range sales {
		if (nf != nil && !nf[s.NameID]) || (itf != nil && !itf[s.ItemID]) || (types != nil && !types[s.Type]) {
			continue
		}
		if !opsTextOK(p, s.Desc+" "+s.Memo, s.Ref) {
			continue
		}
		out = append(out, s)
	}
	return out, nil
}

// opsItemFilter is opsItemSet without sub-items when includeSubitems=0.
func opsItemFilter(p *Params, items map[int64]*opsItem) map[int64]bool {
	if p.Str("includeSubitems") == "0" {
		ids := append([]int64{}, p.Filters.ItemIDs...)
		if id := p.ID("itemId"); id > 0 {
			ids = append(ids, id)
		}
		if len(ids) == 0 {
			return nil
		}
		m := map[int64]bool{}
		for _, id := range ids {
			m[id] = true
		}
		return m
	}
	return opsItemSet(p, items)
}

// opsPeriodCols returns the money columns of a summary report by period.
func opsPeriodCols(ps []Period) []model.ReportColumn {
	cols := []model.ReportColumn{opsC("label", "", "text")}
	for _, pr := range ps {
		cols = append(cols, opsC(pr.Key, pr.Label, "money"))
	}
	if len(ps) > 1 {
		cols = append(cols, opsC("total", "TOTAL", "money"))
	}
	return cols
}

func opsPeriodCells(ps []Period) func(v opsVals) map[string]any {
	return func(v opsVals) map[string]any {
		c := map[string]any{}
		for _, pr := range ps {
			c[pr.Key] = opsMF(v[pr.Key])
		}
		if len(ps) > 1 {
			c["total"] = opsMF(v["total"])
		}
		return c
	}
}

func opsAddPeriod(v opsVals, ps []Period, date string, amt float64) {
	k := opsPeriodKey(ps, date)
	if k == "" {
		return
	}
	v[k] += amt
	if len(ps) > 1 {
		v["total"] += amt
	}
}

func opsBasisKV(p *Params) []string {
	return []string{"from", p.From, "to", p.To, "basis", p.Basis}
}

func opsSalesByCustomerSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	ps := opsPeriods(p)
	vals := map[int64]opsVals{}
	for _, s := range sales {
		id := opsNodeOf(names, s.NameID)
		if vals[id] == nil {
			vals[id] = opsVals{}
		}
		opsAddPeriod(vals[id], ps, s.Date, s.Amount)
	}
	b := opsNew(ctx, q, p, "Sales by Customer Summary", false, true, opsPeriodCols(ps)...)
	cells := opsPeriodCells(ps)
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := opsBasisKV(p)
		if id > 0 {
			jobs := "1"
			if own {
				jobs = "0"
			}
			kv = append(kv, "nameIds", opsID(id), "includeJobs", jobs)
		}
		return opsDrill("sales_by_customer_detail", kv...)
	}
	total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill}, 0, "")
	c := cells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

var opsSaleDetailCols = []model.ReportColumn{
	opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
	opsC("memo", "Memo", "text"), opsC("name", "Name", "text"), opsC("item", "Item", "text"), opsC("qty", "Qty", "number"),
	opsC("price", "Sales Price", "money"), opsC("amount", "Amount", "money"), opsC("balance", "Balance", "money"),
}

// opsSaleRows writes sales lines with a running balance and returns {amount, qty}.
func (b *opsBuilder) opsSaleRows(list []*opsSale, level int, g string, names map[int64]*opsName, items map[int64]*opsItem, withItem bool) opsVals {
	var run, qty float64
	for _, s := range list {
		run += s.Amount
		qty += s.Qty
		memo := s.Desc
		if memo == "" {
			memo = s.Memo
		}
		cells := map[string]any{
			"type": opsTypeLabel(s.Type, ""), "date": s.Date, "num": s.Ref, "memo": memo,
			"name": opsNameFull(names, s.NameID), "amount": opsMF(s.Amount), "balance": opsMF(run),
		}
		if withItem {
			if it, ok := items[s.ItemID]; ok {
				cells["item"] = it.Full
			}
		}
		if s.Qty != 0 {
			cells["qty"] = opsQty(s.Qty)
		}
		if s.HasRate {
			cells["price"] = s.Rate
		}
		b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(s.TxnID), Cells: cells})
	}
	return opsVals{"amount": run, "qty": qty}
}

func opsSaleTotalCells(v opsVals) map[string]any {
	c := map[string]any{"amount": opsMF(v["amount"]), "balance": opsMF(v["amount"])}
	if v["qty"] != 0 {
		c["qty"] = opsQty(v["qty"])
	}
	return c
}

func opsSalesByCustomerDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	byName := map[int64][]*opsSale{}
	for _, s := range sales {
		id := opsNodeOf(names, s.NameID)
		byName[id] = append(byName[id], s)
	}
	b := opsNew(ctx, q, p, "Sales by Customer Detail", false, true, opsSaleDetailCols...)
	spec := &opsDetSpec{
		tree: opsNameTree(names, "No name"),
		has:  func(id int64) bool { return len(byName[id]) > 0 },
		emit: func(id int64, level int, g string) opsVals {
			return b.opsSaleRows(byName[id], level, g, names, items, true)
		},
		total: opsSaleTotalCells,
	}
	total := b.detTree(spec, 0)
	c := opsSaleTotalCells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsItemNode(items map[int64]*opsItem, id int64) int64 {
	if _, ok := items[id]; ok {
		return id
	}
	return opsNoName
}

func opsSalesByItemSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	vals := map[int64]opsVals{}
	var grandAmt float64
	for _, s := range sales {
		id := opsItemNode(items, s.ItemID)
		v := vals[id]
		if v == nil {
			v = opsVals{}
			vals[id] = v
		}
		v["qty"] += s.Qty
		v["amount"] += s.Amount
		v["cogs"] += s.Cogs
		if it, ok := items[id]; ok && it.Type == model.ItemInventoryPart {
			v["inv"] = 1
		}
		grandAmt += s.Amount
	}
	b := opsNew(ctx, q, p, "Sales by Item Summary", false, true,
		opsC("label", "", "text"), opsC("qty", "Qty", "number"), opsC("amount", "Amount", "money"),
		opsC("pct", "% of Sales", "percent"), opsC("avg", "Avg Price", "money"), opsC("cogs", "COGS", "money"),
		opsC("avgcogs", "Avg COGS", "money"), opsC("margin", "Gross Margin", "money"), opsC("marginpct", "Gross Margin %", "percent"))
	cells := func(v opsVals) map[string]any {
		c := map[string]any{"qty": opsQty(v["qty"]), "amount": opsMF(v["amount"]), "pct": opsPct(v["amount"], grandAmt)}
		if v["qty"] != 0 {
			c["avg"] = store.Round2(v["amount"] / v["qty"] / 100)
		}
		if v["inv"] > 0 || v["cogs"] != 0 {
			c["cogs"] = opsMF(v["cogs"])
			if v["qty"] != 0 {
				c["avgcogs"] = store.Round2(v["cogs"] / v["qty"] / 100)
			}
			c["margin"] = opsMF(v["amount"] - v["cogs"])
			c["marginpct"] = opsPct(v["amount"]-v["cogs"], v["amount"])
		}
		return c
	}
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := opsBasisKV(p)
		if id > 0 {
			kv = append(kv, "itemIds", opsID(id))
			if own {
				kv = append(kv, "includeSubitems", "0")
			}
		}
		return opsDrill("sales_by_item_detail", kv...)
	}
	tree := opsItemTree(items)
	grand := opsVals{}
	for _, grp := range opsItemTypeGroups(tree, items) {
		label, roots := grp[0].(string), grp[1].([]int64)
		has := false
		memo := map[int64]bool{}
		for _, r := range roots {
			if tree.hasAny(r, func(id int64) bool { _, ok := vals[id]; return ok }, memo) {
				has = true
			}
		}
		if !has {
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
	delete(c, "avg")
	delete(c, "avgcogs")
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsSalesByItemDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	byItem := map[int64][]*opsSale{}
	for _, s := range sales {
		id := opsItemNode(items, s.ItemID)
		byItem[id] = append(byItem[id], s)
	}
	b := opsNew(ctx, q, p, "Sales by Item Detail", false, true,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("memo", "Memo", "text"), opsC("name", "Name", "text"), opsC("qty", "Qty", "number"),
		opsC("price", "Sales Price", "money"), opsC("amount", "Amount", "money"), opsC("balance", "Balance", "money"))
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
				return b.opsSaleRows(byItem[id], level, g, names, items, false)
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

// opsRepTree builds the sales rep "hierarchy" (flat, plus "No Sales Rep").
func opsRepTree(reps map[int64]*opsEntry) *opsTree {
	t := opsNewTree()
	for id, r := range reps {
		label := r.Name
		if ini, _ := r.Data["initials"].(string); strings.TrimSpace(ini) != "" {
			label = strings.TrimSpace(ini) // the report shows the rep's initials
		}
		t.add(id, 0, label)
	}
	t.add(opsNoName, 0, "No Sales Rep")
	t.sort()
	return t
}

func opsSalesByRepSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	reps, err := opsLoadList(ctx, q, model.ListSalesRep)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	ps := opsPeriods(p)
	vals := map[int64]opsVals{}
	for _, s := range sales {
		id := s.RepID
		if _, ok := reps[id]; !ok {
			id = opsNoName
		}
		if vals[id] == nil {
			vals[id] = opsVals{}
		}
		opsAddPeriod(vals[id], ps, s.Date, s.Amount)
	}
	b := opsNew(ctx, q, p, "Sales by Rep Summary", false, true, opsPeriodCols(ps)...)
	cells := opsPeriodCells(ps)
	drill := func(id int64, own bool) *model.ReportDrill {
		kv := opsBasisKV(p)
		if id > 0 {
			kv = append(kv, "repId", opsID(id))
		} else {
			kv = append(kv, "repId", "none")
		}
		return opsDrill("sales_by_rep_detail", kv...)
	}
	total := b.sumTree(&opsSumSpec{tree: opsRepTree(reps), vals: vals, cells: cells, drill: drill}, 0, "")
	c := cells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsSalesByRepDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	reps, err := opsLoadList(ctx, q, model.ListSalesRep)
	if err != nil {
		return nil, err
	}
	sales, err := opsSalesFiltered(ctx, q, p, names, items)
	if err != nil {
		return nil, err
	}
	onlyRep := p.Str("repId")
	byRep := map[int64][]*opsSale{}
	for _, s := range sales {
		id := s.RepID
		if _, ok := reps[id]; !ok {
			id = opsNoName
		}
		if onlyRep != "" && !((onlyRep == "none" && id == opsNoName) || onlyRep == opsID(id)) {
			continue
		}
		byRep[id] = append(byRep[id], s)
	}
	b := opsNew(ctx, q, p, "Sales by Rep Detail", false, true, opsSaleDetailCols...)
	spec := &opsDetSpec{
		tree: opsRepTree(reps),
		has:  func(id int64) bool { return len(byRep[id]) > 0 },
		emit: func(id int64, level int, g string) opsVals {
			return b.opsSaleRows(byRep[id], level, g, names, items, true)
		},
		total: opsSaleTotalCells,
	}
	total := b.detTree(spec, 0)
	c := opsSaleTotalCells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsPendingSales(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	nf := opsNameSet(p, names)
	from, to := opsFromTo(p)
	rows, err := q.QueryContext(ctx, `SELECT id, type, date, ref_number, IFNULL(name_id, 0), memo, ship_date, amount
		FROM txns WHERE is_pending = 1 AND voided = 0 AND type IN ('INV','SALESRCPT') AND date >= ? AND date <= ?
		ORDER BY date, ref_number, id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	b := opsNew(ctx, q, p, "Pending Sales", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("name", "Name", "text"), opsC("memo", "Memo", "text"), opsC("ship", "Ship Date", "date"), opsC("amount", "Amount", "money"))
	var total int64
	for rows.Next() {
		var id, nameID, amt int64
		var typ, date, ref, memo, ship string
		if err := rows.Scan(&id, &typ, &date, &ref, &nameID, &memo, &ship, &amt); err != nil {
			return nil, err
		}
		if nf != nil && !nf[nameID] {
			continue
		}
		if !opsTextOK(p, memo, ref) {
			continue
		}
		cells := map[string]any{"type": opsTypeLabel(typ, ""), "date": date, "num": ref, "name": opsNameFull(names, nameID),
			"memo": memo, "amount": opsM(amt)}
		if ship != "" {
			cells["ship"] = ship
		}
		b.rowFull(model.ReportRow{Kind: "data", Level: 0, TxnID: opsTxnRef(id), Cells: cells})
		total += amt
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsM(total)})
	return b.r, nil
}

// opsJobActuals returns, per customer:job, the actual revenue (income and
// other income) and actual cost (cost of goods sold, expense, other expense)
// posted with that name in the period.
// opsJobActuals sums income (actrev) and costs (actcost) per customer:job in
// [from, to]; on the cash basis (p.IsCash) as recognized by the payments.
func opsJobActuals(ctx context.Context, q store.Q, p *Params, from, to string) (map[int64]opsVals, error) {
	if p.IsCash() {
		c, err := finNew(ctx, q, p)
		if err != nil {
			return nil, err
		}
		es, err := c.entries(from, to, true)
		if err != nil {
			return nil, err
		}
		out := map[int64]opsVals{}
		for i := range es {
			e := &es[i]
			a := c.accts[e.AccountID]
			if a == nil || !model.IsProfitLoss(a.Type) || !c.isKind(e.NameID, model.NameCustomer) {
				continue
			}
			v := out[e.NameID]
			if v == nil {
				v = opsVals{}
				out[e.NameID] = v
			}
			switch a.Type {
			case model.AcctIncome, model.AcctOtherIncome:
				v["actrev"] -= float64(e.Amount)
			default:
				v["actcost"] += float64(e.Amount)
			}
		}
		return out, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT g.name_id, a.type, SUM(g.amount) FROM gl_entries g
		JOIN accounts a ON a.id = g.account_id JOIN names n ON n.id = g.name_id
		WHERE n.kind = 'customer' AND g.date >= ? AND g.date <= ?
		AND a.type IN ('Income','Other Income','Cost of Goods Sold','Expense','Other Expense')
		GROUP BY g.name_id, a.type`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]opsVals{}
	for rows.Next() {
		var id, amt int64
		var typ string
		if err := rows.Scan(&id, &typ, &amt); err != nil {
			return nil, err
		}
		v := out[id]
		if v == nil {
			v = opsVals{}
			out[id] = v
		}
		switch typ {
		case model.AcctIncome, model.AcctOtherIncome:
			v["actrev"] -= float64(amt)
		default:
			v["actcost"] += float64(amt)
		}
	}
	return out, rows.Err()
}

func opsJobProfitability(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	act, err := opsJobActuals(ctx, q, p, from, to)
	if err != nil {
		return nil, err
	}
	nf := opsNameSet(p, names)
	vals := map[int64]opsVals{}
	for id, v := range act {
		if nf != nil && !nf[id] {
			continue
		}
		vals[id] = v
	}
	b := opsNew(ctx, q, p, "Job Profitability Summary", false, true,
		opsC("label", "", "text"), opsC("actcost", "Act. Cost", "money"), opsC("actrev", "Act. Revenue", "money"),
		opsC("diff", "($) Diff.", "money"))
	cells := func(v opsVals) map[string]any {
		return map[string]any{"actcost": opsMF(v["actcost"]), "actrev": opsMF(v["actrev"]), "diff": opsMF(v["actrev"] - v["actcost"])}
	}
	drill := func(id int64, own bool) *model.ReportDrill {
		jobs := "1"
		if own {
			jobs = "0"
		}
		return opsDrill("profit_loss_detail", "from", p.From, "to", p.To, "basis", p.Basis, "nameIds", opsID(id), "includeJobs", jobs)
	}
	total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill}, 0, "")
	c := cells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}

func opsJobEstVsActuals(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	from, to := opsFromTo(p)
	act, err := opsJobActuals(ctx, q, p, from, to)
	if err != nil {
		return nil, err
	}
	nf := opsNameSet(p, names)
	vals := map[int64]opsVals{}
	get := func(id int64) opsVals {
		v := vals[id]
		if v == nil {
			v = opsVals{}
			vals[id] = v
		}
		return v
	}
	for id, v := range act {
		if nf != nil && !nf[id] {
			continue
		}
		get(id).add(v)
	}
	rows, err := q.QueryContext(ctx, `SELECT t.name_id, IFNULL(l.item_id, 0), l.qty, l.amount FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE t.type = 'EST' AND t.status <> 'Rejected' AND t.name_id IS NOT NULL AND t.date >= ? AND t.date <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var nameID, itemID, amt int64
		var qty sql.NullFloat64
		if err := rows.Scan(&nameID, &itemID, &qty, &amt); err != nil {
			return nil, err
		}
		if nf != nil && !nf[nameID] {
			continue
		}
		it := items[itemID]
		if it != nil {
			switch it.Type {
			case model.ItemSubtotal, model.ItemPayment, model.ItemSalesTax, model.ItemSalesTaxGroup, model.ItemGroup:
				continue
			}
		}
		v := get(nameID)
		v["estrev"] += float64(amt)
		if it != nil && it.Cost != 0 && !it.RateIsPercent {
			n := 1.0
			if qty.Valid {
				n = qty.Float64
			}
			v["estcost"] += float64(store.Cents(n * it.Cost))
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Job Estimates vs. Actuals Summary", false, true,
		opsC("label", "", "text"), opsC("estcost", "Est. Cost", "money"), opsC("actcost", "Act. Cost", "money"),
		opsC("costdiff", "($) Diff.", "money"), opsC("costpct", "(%) Diff.", "percent"),
		opsC("estrev", "Est. Revenue", "money"), opsC("actrev", "Act. Revenue", "money"),
		opsC("revdiff", "($) Diff.", "money"), opsC("revpct", "(%) Diff.", "percent"))
	cells := func(v opsVals) map[string]any {
		return map[string]any{
			"estcost": opsMF(v["estcost"]), "actcost": opsMF(v["actcost"]), "costdiff": opsMF(v["actcost"] - v["estcost"]),
			"costpct": opsPct(v["actcost"], v["estcost"]),
			"estrev":  opsMF(v["estrev"]), "actrev": opsMF(v["actrev"]), "revdiff": opsMF(v["actrev"] - v["estrev"]),
			"revpct": opsPct(v["actrev"], v["estrev"]),
		}
	}
	drill := func(id int64, own bool) *model.ReportDrill {
		jobs := "1"
		if own {
			jobs = "0"
		}
		return opsDrill("profit_loss_detail", "from", p.From, "to", p.To, "basis", p.Basis, "nameIds", opsID(id), "includeJobs", jobs)
	}
	total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill}, 0, "")
	c := cells(total)
	c["label"] = "TOTAL"
	b.row("grandtotal", 0, "", c)
	return b.r, nil
}
