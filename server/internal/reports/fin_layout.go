package reports

// Row layout shared by the financial reports: account hierarchy rows with
// "Total <Parent>" / "<Parent> - Other", the Profit and Loss structure (Gross
// Profit, Net Operating Income, Net Other Income, Net Income) and the Balance
// Sheet structure (ASSETS / LIABILITIES & EQUITY with Retained Earnings and
// Net Income).

import (
	"math"
	"sort"

	"seriex/internal/model"
	"seriex/internal/store"
)

// finVals holds amounts in cents keyed by column key.
type finVals map[string]int64

func (v finVals) add(o finVals, sign int64) {
	for k, x := range o {
		v[k] += x * sign
	}
}

func finPlus(a, b finVals, sign int64) finVals {
	out := finVals{}
	out.add(a, 1)
	out.add(b, sign)
	return out
}

func finNonzero(v finVals) bool {
	for _, x := range v {
		if x != 0 {
			return true
		}
	}
	return false
}

// finSpan selects the entries counted in a column.
type finSpan struct {
	from, to string
	classes  map[int64]bool // nil = any class
	noClass  bool
	names    map[int64]bool // nil = any name (entry name)
	noCust   bool
}

func (c *finCtx) inSpan(s *finSpan, e *finEntry) bool {
	if e.Date > s.to || (s.from != "" && e.Date < s.from) {
		return false
	}
	if s.noClass && e.ClassID != 0 {
		return false
	}
	if s.classes != nil && !s.classes[e.ClassID] {
		return false
	}
	if s.noCust && c.isKind(e.NameID, model.NameCustomer) {
		return false
	}
	if s.names != nil && !s.names[e.NameID] {
		return false
	}
	return true
}

// finCol is a report column. Money columns without Derive are "base"
// columns whose values come from the layout's table; Derive computes a
// column from the row's base values (e.g. $ Change, % of Budget).
type finCol struct {
	Key    string
	Label  string
	Type   string // "text" | "money" | "percent" | "date"
	Span   *finSpan
	Derive func(v finVals) any
	Extra  map[string]string // drill-down parameters specific to this column
}

func finReportCols(cols []finCol) []model.ReportColumn {
	out := make([]model.ReportColumn, 0, len(cols)+1)
	for _, c := range cols {
		out = append(out, model.ReportColumn{Key: c.Key, Label: c.Label, Type: c.Type})
	}
	return out
}

// finRatioPct is num / den as a percentage rounded to one decimal, signs kept
// (% of Budget: -17.21 actual of a -10.00 budget is 172.1%).
func finRatioPct(num, den int64) any {
	if den == 0 {
		return nil
	}
	return math.Round(float64(num)/float64(den)*1000) / 10
}

// finPct is a percentage rounded to one decimal (12.5 = 12.5%) of the size of
// den: the sign follows num (used for % Change).
func finPct(num, den int64) any {
	if den == 0 {
		return nil
	}
	return math.Round(float64(num)/math.Abs(float64(den))*1000) / 10
}

// finChangePct is the "% Change" of the comparison reports: 100% when the
// prior amount is zero.
func finChangePct(cur, prev int64) any {
	if prev == 0 {
		switch {
		case cur > 0:
			return 100.0
		case cur < 0:
			return -100.0
		}
		return 0.0
	}
	return finPct(cur-prev, prev)
}

type finLayout struct {
	c         *finCtx
	cols      []finCol
	raw       map[int64]finVals // account -> column -> raw cents (debit +)
	rows      []model.ReportRow
	memo      map[int64]finVals
	summary   bool // balance sheet summary: one row per account group
	noDrill   bool // amounts do not drill down (budget amounts)
	bs        bool // balance sheet: Retained Earnings and equity totals drill to what makes them up
	acctsHook func(l *finLayout, roots []*finAcct, level int, group string) (finVals, []int64)
}

func (c *finCtx) layout(cols []finCol, raw map[int64]finVals) *finLayout {
	if raw == nil {
		raw = map[int64]finVals{}
	}
	return &finLayout{c: c, cols: cols, raw: raw, memo: map[int64]finVals{}}
}

// own is the account's natural-sign amounts (positive = normal balance).
func (l *finLayout) own(a *finAcct) finVals {
	out := finVals{}
	out.add(l.raw[a.ID], finSign(a.Type))
	return out
}

// sub is own + all subaccounts.
func (l *finLayout) sub(a *finAcct) finVals {
	if v, ok := l.memo[a.ID]; ok {
		return v
	}
	v := l.own(a)
	for _, ch := range a.Children {
		v.add(l.sub(ch), 1)
	}
	l.memo[a.ID] = v
	return v
}

type finDrillFn func(col *finCol) *model.ReportDrill

// add appends a row. v holds natural-sign base values (nil for headers).
func (l *finLayout) add(kind string, level int, label string, v finVals, mk finDrillFn, group string) *model.ReportRow {
	r := model.ReportRow{Kind: kind, Level: level, Group: group, Cells: map[string]any{"label": label}}
	if v != nil {
		var first *model.ReportDrill
		for i := range l.cols {
			col := &l.cols[i]
			if col.Derive != nil {
				r.Cells[col.Key] = col.Derive(v)
				continue
			}
			if col.Type != "money" {
				continue
			}
			r.Cells[col.Key] = store.Dollars(v[col.Key])
			if mk != nil && col.Span != nil {
				if d := mk(col); d != nil {
					if r.CellDrills == nil {
						r.CellDrills = map[string]*model.ReportDrill{}
					}
					r.CellDrills[col.Key] = d
					if first == nil {
						first = d
					}
				}
			}
		}
		if d, ok := r.CellDrills["total"]; ok {
			r.Drill = d
		} else {
			r.Drill = first
		}
	}
	l.rows = append(l.rows, r)
	return &l.rows[len(l.rows)-1]
}

// acctDrill drills down from an amount to Transaction Detail by Account for the
// accounts and the column's dates / class / customer.
func (l *finLayout) acctDrill(ids []int64) finDrillFn {
	if len(ids) == 0 || l.noDrill {
		return nil
	}
	if l.bs && len(ids) == 1 && ids[0] == l.c.reID && l.c.reID != 0 {
		return l.reDrill()
	}
	return func(col *finCol) *model.ReportDrill {
		return l.c.drill("transaction_detail_by_account", col.Span.from, col.Span.to, ids, col.Extra)
	}
}

// plIDs are every income and expense account.
func (c *finCtx) plIDs() []int64 {
	var out []int64
	for _, a := range c.accts {
		if model.IsProfitLoss(a.Type) {
			out = append(out, a.ID)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// reDrill: Retained Earnings on a balance sheet is the Retained Earnings
// account plus the net income of every year before the column's fiscal year:
// Transaction Detail by Account of those, with income and expenses up to the
// day before the fiscal year start and a net (credit) total equal to the amount.
func (l *finLayout) reDrill() finDrillFn {
	if l.noDrill {
		return nil
	}
	return func(col *finCol) *model.ReportDrill {
		fys := FiscalYearStart(col.Span.to, l.c.p.FiscalYearStartMonth)
		ids := l.c.plIDs()
		if l.c.reID != 0 {
			ids = append(ids, l.c.reID)
		}
		return l.c.drill("transaction_detail_by_account", "", col.Span.to, ids,
			map[string]string{"plTo": finAddDays(fys, -1), "netTotal": "credit"})
	}
}

// equityDrill: an equity total includes every year's net income, so it drills
// to the equity (and liability) accounts plus all income and expenses up to
// the column's date, with a net (credit) total equal to the amount.
func (l *finLayout) equityDrill(ids []int64) finDrillFn {
	if l.noDrill {
		return nil
	}
	return func(col *finCol) *model.ReportDrill {
		all := append(append([]int64{}, ids...), l.c.plIDs()...)
		return l.c.drill("transaction_detail_by_account", "", col.Span.to, all, map[string]string{"netTotal": "credit"})
	}
}

// plTotalDrill: Gross Profit, Net Operating Income, Net Other Income and Net
// Income drill down to the Profit and Loss Detail of the accounts that make them
// up (its bottom line is the clicked amount).
func (l *finLayout) plTotalDrill(ids []int64) finDrillFn {
	if len(ids) == 0 || l.noDrill {
		return nil
	}
	return func(col *finCol) *model.ReportDrill {
		return l.c.drill("profit_loss_detail", col.Span.from, col.Span.to, ids, col.Extra)
	}
}

// accounts emits the rows of the given top-level accounts and returns their
// natural total and every account id below them.
func (l *finLayout) accounts(roots []*finAcct, level int, group string) (finVals, []int64) {
	if l.acctsHook != nil {
		return l.acctsHook(l, roots, level, group)
	}
	total := finVals{}
	var ids []int64
	for _, a := range roots {
		subIDs := a.subtreeIDs()
		ids = append(ids, subIDs...)
		v := l.sub(a)
		if !finNonzero(v) {
			continue
		}
		total.add(v, 1)
		label := a.rootLabel()
		active := false
		for _, ch := range a.Children {
			if finNonzero(l.sub(ch)) {
				active = true
				break
			}
		}
		if !active {
			l.add("data", level, label, v, l.acctDrill(subIDs), group)
			continue
		}
		g := l.c.group()
		l.add("section", level, label, nil, nil, g)
		l.accounts(a.Children, level+1, g)
		if own := l.own(a); finNonzero(own) {
			l.add("data", level+1, label+" - Other", own, l.acctDrill([]int64{a.ID}), g)
		}
		l.add("subtotal", level, "Total "+label, v, l.acctDrill(subIDs), g)
	}
	return total, ids
}

// typeSection emits "<title>", the accounts and "<totalLabel>"; nothing when
// no account has an amount.
func (l *finLayout) typeSection(roots []*finAcct, title, totalLabel string, level int) (finVals, []int64, bool) {
	start := len(l.rows)
	g := l.c.group()
	l.add("section", level, title, nil, nil, g)
	v, ids := l.accounts(roots, level+1, g)
	if len(l.rows) == start+1 {
		l.rows = l.rows[:start]
		return finVals{}, ids, false
	}
	if l.summary {
		l.rows = l.rows[:start]
		l.add("data", level, title, v, l.acctDrill(ids), "")
		return v, ids, true
	}
	l.add("subtotal", level, totalLabel, v, l.acctDrill(ids), g)
	return v, ids, true
}

func finCat(lists ...[]int64) []int64 {
	var out []int64
	for _, l := range lists {
		out = append(out, l...)
	}
	return out
}

// profitLoss emits the Profit and Loss structure and returns Net Income.
func (l *finLayout) profitLoss() finVals {
	c := l.c
	gOrd := c.group()
	start := len(l.rows)
	l.add("section", 0, "Operating Income and Expense", nil, nil, gOrd)
	inc, incIDs, okI := l.typeSection(c.typeRoots(model.AcctIncome), "Income", "Total Income", 1)
	cogs, cogsIDs, okC := l.typeSection(c.typeRoots(model.AcctCOGS), "Cost of Goods Sold", "Total COGS", 1)
	gp := finPlus(inc, cogs, -1)
	gpIDs := finCat(incIDs, cogsIDs)
	if okI || okC {
		l.add("total", 1, "Gross Profit", gp, l.plTotalDrill(gpIDs), gOrd)
	}
	exp, expIDs, okE := l.typeSection(c.typeRoots(model.AcctExpense), "Expense", "Total Expense", 1)
	noi := finPlus(gp, exp, -1)
	noiIDs := finCat(gpIDs, expIDs)
	if okI || okC || okE {
		l.add("total", 0, "Net Operating Income", noi, l.plTotalDrill(noiIDs), gOrd)
	} else {
		l.rows = l.rows[:start]
	}
	gOth := c.group()
	start = len(l.rows)
	l.add("section", 0, "Other Income/Expense", nil, nil, gOth)
	oi, oiIDs, okOI := l.typeSection(c.typeRoots(model.AcctOtherIncome), "Other Income", "Total Other Income", 1)
	oe, oeIDs, okOE := l.typeSection(c.typeRoots(model.AcctOtherExpense), "Other Expense", "Total Other Expense", 1)
	noth := finPlus(oi, oe, -1)
	if okOI || okOE {
		l.add("total", 0, "Net Other Income", noth, l.plTotalDrill(finCat(oiIDs, oeIDs)), gOth)
	} else {
		l.rows = l.rows[:start]
	}
	ni := finPlus(noi, noth, 1)
	l.add("grandtotal", 0, "Net Income", ni, l.plTotalDrill(finCat(noiIDs, oiIDs, oeIDs)), "")
	return ni
}

// finEquityExtra are the computed equity rows of a balance sheet.
type finEquityExtra struct {
	re      finVals // synthetic Retained Earnings row (no RE account), natural
	ni      finVals // Net Income row, natural
	niDrill finDrillFn
	niRow   func(l *finLayout, level int, group string) // custom Net Income row (detail reports)
}

// balanceSheet emits the Balance Sheet structure.
func (l *finLayout) balanceSheet(eq finEquityExtra) {
	c := l.c
	l.bs = true
	type grp struct{ typ, title string }
	gA := c.group()
	l.add("section", 0, "ASSETS", nil, nil, gA)
	assets := finVals{}
	var assetIDs []int64
	gCA := c.group()
	s := len(l.rows)
	l.add("section", 1, "Current Assets", nil, nil, gCA)
	ca := finVals{}
	var caIDs []int64
	anyCA := false
	for _, g := range []grp{{model.AcctBank, "Checking/Savings"}, {model.AcctAR, "Accounts Receivable"}, {model.AcctOCA, "Other Current Assets"}} {
		v, ids, ok := l.typeSection(c.typeRoots(g.typ), g.title, "Total "+g.title, 2)
		ca.add(v, 1)
		caIDs = append(caIDs, ids...)
		anyCA = anyCA || ok
	}
	if anyCA {
		l.add("subtotal", 1, "Total Current Assets", ca, l.acctDrill(caIDs), gCA)
	} else {
		l.rows = l.rows[:s]
	}
	assets.add(ca, 1)
	assetIDs = append(assetIDs, caIDs...)
	for _, g := range []grp{{model.AcctFixedAsset, "Fixed Assets"}, {model.AcctOtherAsset, "Other Assets"}} {
		v, ids, _ := l.typeSection(c.typeRoots(g.typ), g.title, "Total "+g.title, 1)
		assets.add(v, 1)
		assetIDs = append(assetIDs, ids...)
	}
	l.add("grandtotal", 0, "TOTAL ASSETS", assets, l.acctDrill(assetIDs), gA)

	gLE := c.group()
	l.add("section", 0, "LIABILITIES & EQUITY", nil, nil, gLE)
	gL := c.group()
	sL := len(l.rows)
	l.add("section", 1, "Liabilities", nil, nil, gL)
	gCL := c.group()
	sCL := len(l.rows)
	l.add("section", 2, "Current Liabilities", nil, nil, gCL)
	liab, cl := finVals{}, finVals{}
	var liabIDs, clIDs []int64
	anyCL := false
	for _, g := range []grp{{model.AcctAP, "Accounts Payable"}, {model.AcctCreditCard, "Credit Cards"}, {model.AcctOCL, "Other Current Liabilities"}} {
		v, ids, ok := l.typeSection(c.typeRoots(g.typ), g.title, "Total "+g.title, 3)
		cl.add(v, 1)
		clIDs = append(clIDs, ids...)
		anyCL = anyCL || ok
	}
	if anyCL {
		l.add("subtotal", 2, "Total Current Liabilities", cl, l.acctDrill(clIDs), gCL)
	} else {
		l.rows = l.rows[:sCL]
	}
	liab.add(cl, 1)
	liabIDs = append(liabIDs, clIDs...)
	ltl, ltlIDs, okLTL := l.typeSection(c.typeRoots(model.AcctLTL), "Long Term Liabilities", "Total Long Term Liabilities", 2)
	liab.add(ltl, 1)
	liabIDs = append(liabIDs, ltlIDs...)
	if anyCL || okLTL {
		l.add("subtotal", 1, "Total Liabilities", liab, l.acctDrill(liabIDs), gL)
	} else {
		l.rows = l.rows[:sL]
	}

	gE := c.group()
	sE := len(l.rows)
	l.add("section", 1, "Equity", nil, nil, gE)
	eqv, eqIDs := l.accounts(c.typeRoots(model.AcctEquity), 2, gE)
	if finNonzero(eq.re) {
		l.add("data", 2, "Retained Earnings", eq.re, l.reDrill(), gE)
		eqv.add(eq.re, 1)
	}
	if eq.niRow != nil {
		eq.niRow(l, 2, gE)
		eqv.add(eq.ni, 1)
	} else if finNonzero(eq.ni) {
		l.add("data", 2, "Net Income", eq.ni, eq.niDrill, gE)
		eqv.add(eq.ni, 1)
	}
	switch {
	case len(l.rows) == sE+1:
		l.rows = l.rows[:sE]
	case l.summary:
		l.rows = l.rows[:sE]
		l.add("data", 1, "Equity", eqv, l.equityDrill(eqIDs), "")
	default:
		l.add("subtotal", 1, "Total Equity", eqv, l.equityDrill(eqIDs), gE)
	}
	total := finPlus(liab, eqv, 1)
	l.add("grandtotal", 0, "TOTAL LIABILITIES & EQUITY", total, l.equityDrill(finCat(liabIDs, eqIDs)), gLE)
}

// nodes emits rows for a names/classes/items tree: a node with active
// children becomes a section with its children, "<Node> - Other" and
// "Total <Node>". vals are natural amounts per node (own only).
func (l *finLayout) nodes(roots []*finNode, level int, group string, vals map[int64]finVals,
	mk func(n *finNode, subtree bool) finDrillFn) finVals {
	total := finVals{}
	var subOf func(n *finNode) finVals
	subOf = func(n *finNode) finVals {
		v := finVals{}
		v.add(vals[n.ID], 1)
		for _, ch := range n.Children {
			v.add(subOf(ch), 1)
		}
		return v
	}
	for _, n := range roots {
		v := subOf(n)
		hasChild := false
		for _, ch := range n.Children {
			if finNonzero(subOf(ch)) {
				hasChild = true
				break
			}
		}
		if !finNonzero(v) && !hasChild {
			continue
		}
		total.add(v, 1)
		if !hasChild {
			l.add("data", level, n.Name, v, mk(n, true), group)
			continue
		}
		g := l.c.group()
		l.add("section", level, n.Name, nil, nil, g)
		l.nodes(n.Children, level+1, g, vals, mk)
		if own := vals[n.ID]; finNonzero(own) {
			l.add("data", level+1, n.Name+" - Other", own, mk(n, false), g)
		}
		l.add("subtotal", level, "Total "+n.Name, v, mk(n, true), g)
	}
	return total
}
