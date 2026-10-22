package reports

// Profit and Loss family: standard, YTD / prior year comparisons, by job, by
// class, unclassified; Income by Customer and Expenses by Vendor summaries.

import (
	"context"
	"strconv"

	"seriex/internal/model"
	"seriex/internal/store"
)

func finLabelCol() model.ReportColumn {
	return model.ReportColumn{Key: "label", Label: "", Type: "text"}
}

// plEntries loads the profit & loss entries of [from, to] with the report filters applied.
func (c *finCtx) plEntries(from, to string) ([]finEntry, error) {
	es, err := c.entries(from, to, c.p.IsCash())
	if err != nil {
		return nil, err
	}
	f := c.filter()
	out := es[:0:0]
	for i := range es {
		a := c.accts[es[i].AccountID]
		if a == nil || !model.IsProfitLoss(a.Type) {
			continue
		}
		if c.match(f, &es[i]) {
			out = append(out, es[i])
		}
	}
	return out, nil
}

// table sums raw amounts per account for every base column with a span.
func (c *finCtx) table(es []finEntry, cols []finCol) map[int64]finVals {
	raw := map[int64]finVals{}
	for i := range es {
		e := &es[i]
		for j := range cols {
			col := &cols[j]
			if col.Span == nil || col.Derive != nil {
				continue
			}
			if c.inSpan(col.Span, e) {
				v := raw[e.AccountID]
				if v == nil {
					v = finVals{}
					raw[e.AccountID] = v
				}
				v[col.Key] += e.Amount
			}
		}
	}
	return raw
}

// periodFrom is the first date of period columns when the report has no From date.
func (c *finCtx) periodFrom(from, to string) string {
	if from != "" {
		return from
	}
	if d := c.firstDate(); d != "" && d <= to {
		return d
	}
	return FiscalYearStart(to, c.p.FiscalYearStartMonth)
}

// plCols builds the amount columns of a P&L style report:
// total | week | month | quarter | year | class | customer.
func (c *finCtx) plCols(es []finEntry, from, to, kind string) []finCol {
	total := finCol{Key: "total", Label: "TOTAL", Type: "money", Span: &finSpan{from: from, to: to}}
	var cols []finCol
	switch kind {
	case "week", "month", "quarter", "year":
		for _, pr := range Periods(c.periodFrom(from, to), to, kind, c.p.FiscalYearStartMonth) {
			cols = append(cols, finCol{Key: pr.Key, Label: pr.Label, Type: "money", Span: &finSpan{from: pr.From, to: pr.To}})
		}
	case "class":
		active := map[int64]bool{}
		unclassified := false
		for i := range es {
			if es[i].Date < from && from != "" || es[i].Date > to {
				continue
			}
			if es[i].ClassID == 0 {
				unclassified = true
			} else {
				active[es[i].ClassID] = true
			}
		}
		cols = c.treeCols("c", c.classRoots, active, from, to, func(ids []int64, _ bool, _ *finNode) (*finSpan, map[string]string) {
			return &finSpan{from: from, to: to, classes: finSet(ids)}, map[string]string{"classIds": finJoinIDs(ids), "noClass": ""}
		})
		if unclassified || len(cols) == 0 {
			cols = append(cols, finCol{Key: "c0", Label: "No Class", Type: "money", Span: &finSpan{from: from, to: to, noClass: true},
				Extra: map[string]string{"noClass": "1", "classIds": ""}})
		}
	case "customer":
		active := map[int64]bool{}
		none := false
		for i := range es {
			if es[i].Date < from && from != "" || es[i].Date > to {
				continue
			}
			if c.isKind(es[i].NameID, model.NameCustomer) {
				active[es[i].NameID] = true
			} else {
				none = true
			}
		}
		var roots []*finNode
		for _, n := range c.nameRoots {
			if n.Kind == model.NameCustomer {
				roots = append(roots, n)
			}
		}
		cols = c.treeCols("n", roots, active, from, to, func(ids []int64, sub bool, root *finNode) (*finSpan, map[string]string) {
			ex := map[string]string{"nameIds": finJoinIDs(ids), "includeJobs": "0", "noCustomer": ""}
			if sub {
				ex["nameIds"] = strconv.FormatInt(root.ID, 10)
				ex["includeJobs"] = "1"
			}
			return &finSpan{from: from, to: to, names: finSet(ids)}, ex
		})
		if none || len(cols) == 0 {
			cols = append(cols, finCol{Key: "n0", Label: "Not Specified", Type: "money", Span: &finSpan{from: from, to: to, noCust: true},
				Extra: map[string]string{"noCustomer": "1", "nameIds": ""}})
		}
	default:
		total.Label = finRangeLabel(from, to)
		return []finCol{total}
	}
	if len(cols) > 1 {
		cols = append(cols, total)
	} else if len(cols) == 1 && kind != "week" && kind != "month" && kind != "quarter" && kind != "year" {
		cols = append(cols, total)
	}
	return cols
}

// treeCols builds one column per active class / customer:job. A top-level
// node with active children gets columns for each child, "<Node> - Other"
// for its own amounts and "Total <Node>".
func (c *finCtx) treeCols(prefix string, roots []*finNode, active map[int64]bool, from, to string,
	mk func(ids []int64, subtree bool, root *finNode) (*finSpan, map[string]string)) []finCol {
	var cols []finCol
	col := func(key, label string, ids []int64, sub bool, root *finNode) {
		sp, ex := mk(ids, sub, root)
		cols = append(cols, finCol{Key: key, Label: label, Type: "money", Span: sp, Extra: ex})
	}
	for _, r := range roots {
		nodes := r.subtree()
		var act []*finNode
		var all []int64
		for _, n := range nodes {
			all = append(all, n.ID)
			if active[n.ID] {
				act = append(act, n)
			}
		}
		if len(act) == 0 {
			continue
		}
		if len(act) == 1 && act[0] == r {
			col(prefix+strconv.FormatInt(r.ID, 10), r.Full, []int64{r.ID}, false, r)
			continue
		}
		for _, n := range act {
			if n != r {
				col(prefix+strconv.FormatInt(n.ID, 10), n.Full, []int64{n.ID}, false, r)
			}
		}
		if active[r.ID] {
			col(prefix+strconv.FormatInt(r.ID, 10), r.Full+" - Other", []int64{r.ID}, false, r)
		}
		col(prefix+"t"+strconv.FormatInt(r.ID, 10), "Total "+r.Full, all, true, r)
	}
	return cols
}

// plReport runs a P&L with the given column kind; extra filters are applied
// through the parameters (e.g. noClass=1 for the unclassified report).
func finPLReport(ctx context.Context, q store.Q, p *Params, title, kind string) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.plEntries(p.From, p.To)
	if err != nil {
		return nil, err
	}
	cols := c.plCols(es, p.From, p.To, kind)
	l := c.layout(cols, c.table(es, cols))
	l.profitLoss()
	res := NewResult(ctx, q, p, title, false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

func finProfitLoss(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	title := "Profit and Loss"
	switch p.Columns {
	case "class":
		title = "Profit and Loss by Class"
	case "customer":
		title = "Profit and Loss by Job"
	}
	return finPLReport(ctx, q, p, title, p.Columns)
}

func finProfitLossByJob(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	p.Columns = "customer"
	return finPLReport(ctx, q, p, "Profit and Loss by Job", "customer")
}

func finProfitLossByClass(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	p.Columns = "class"
	return finPLReport(ctx, q, p, "Profit and Loss by Class", "class")
}

func finProfitLossUnclassified(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	p.Values = finWith(p.Values, "noClass", "1")
	return finPLReport(ctx, q, p, "Profit and Loss: No Class", p.Columns)
}

// finWith returns a copy of v with key set.
func finWith(v map[string][]string, key, val string) map[string][]string {
	out := map[string][]string{}
	for k, x := range v {
		out[k] = x
	}
	out[key] = []string{val}
	return out
}

// finPrevPeriod returns the period just before [from, to]: a run of whole
// months (a month, quarter or year) gives the same number of whole months
// before it; any other period the same number of days ending the day before
// from (Oct 1-19 -> Sep 12-30).
func finPrevPeriod(from, to string) (string, string) {
	tt, ok := finParse(to)
	if !ok {
		return "", to
	}
	ft, ok := finParse(from)
	if !ok || from == "" {
		return "", tt.AddDate(0, -1, 0).Format("2006-01-02")
	}
	if ft.Day() == 1 && tt.AddDate(0, 0, 1).Day() == 1 {
		months := (tt.Year()-ft.Year())*12 + int(tt.Month()-ft.Month()) + 1
		pTo := ft.AddDate(0, 0, -1)
		pFrom := ft.AddDate(0, -months, 0)
		return pFrom.Format("2006-01-02"), pTo.Format("2006-01-02")
	}
	days := int(tt.Sub(ft).Hours()/24 + 0.5)
	pTo := ft.AddDate(0, 0, -1)
	return pTo.AddDate(0, 0, -days).Format("2006-01-02"), pTo.Format("2006-01-02")
}

func finProfitLossPrevPeriod(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	pFrom, pTo := finPrevPeriod(p.From, p.To)
	lo := pFrom
	if p.From == "" {
		lo = ""
	}
	es, err := c.plEntries(lo, p.To)
	if err != nil {
		return nil, err
	}
	curLabel, prevLabel := finRangeLabel(p.From, p.To), finRangeLabel(pFrom, pTo)
	if p.From == "" {
		curLabel, prevLabel = "Through "+finAsOfLabel(p.To), "Through "+finAsOfLabel(pTo)
	}
	cols := finCompareCols(
		finCol{Key: "cur", Label: curLabel, Type: "money", Span: &finSpan{from: p.From, to: p.To}},
		finCol{Key: "prev", Label: prevLabel, Type: "money", Span: &finSpan{from: pFrom, to: pTo}},
	)
	l := c.layout(cols, c.table(es, cols))
	l.profitLoss()
	res := NewResult(ctx, q, p, "Profit and Loss: This Period vs. Last Period", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

func finProfitLossYTD(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	fys := FiscalYearStart(p.To, p.FiscalYearStartMonth)
	lo := fys
	if p.From == "" || p.From < fys {
		lo = p.From
	}
	es, err := c.plEntries(lo, p.To)
	if err != nil {
		return nil, err
	}
	cols := []finCol{
		{Key: "cur", Label: finRangeLabel(p.From, p.To), Type: "money", Span: &finSpan{from: p.From, to: p.To}},
		{Key: "ytd", Label: finRangeLabel(fys, p.To), Type: "money", Span: &finSpan{from: fys, to: p.To}},
	}
	l := c.layout(cols, c.table(es, cols))
	l.profitLoss()
	res := NewResult(ctx, q, p, "Profit and Loss: Year-to-Date Comparison", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

// finCompareCols: current, prior, $ Change, % Change.
func finCompareCols(cur, prev finCol) []finCol {
	return []finCol{cur, prev,
		{Key: "chg", Label: "$ Change", Type: "money", Derive: func(v finVals) any { return store.Dollars(v[cur.Key] - v[prev.Key]) }},
		{Key: "pct", Label: "% Change", Type: "percent", Derive: func(v finVals) any { return finChangePct(v[cur.Key], v[prev.Key]) }},
	}
}

func finProfitLossPrevYear(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	pFrom, pTo := "", finPrevYear(p.To)
	if p.From != "" {
		pFrom = finPrevYear(p.From)
	}
	es, err := c.plEntries(pFrom, p.To)
	if err != nil {
		return nil, err
	}
	curLabel, prevLabel := finRangeLabel(p.From, p.To), finRangeLabel(pFrom, pTo)
	if p.From == "" {
		curLabel, prevLabel = "Through "+finAsOfLabel(p.To), "Through "+finAsOfLabel(pTo)
	}
	cols := finCompareCols(
		finCol{Key: "cur", Label: curLabel, Type: "money", Span: &finSpan{from: p.From, to: p.To}},
		finCol{Key: "prev", Label: prevLabel, Type: "money", Span: &finSpan{from: pFrom, to: pTo}},
	)
	l := c.layout(cols, c.table(es, cols))
	l.profitLoss()
	res := NewResult(ctx, q, p, "Profit and Loss: This Year vs. Last Year", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

// periodOnly keeps only date based column kinds (name/class summaries).
func finPeriodKind(kind string) string {
	switch kind {
	case "week", "month", "quarter", "year":
		return kind
	}
	return "total"
}

// finEntitySummary builds a summary with one row per customer:job or vendor.
// value returns the entity and the signed amount of an entry (0 entity = skip).
func finEntitySummary(ctx context.Context, q store.Q, p *Params, title, kind, detailReport string,
	keep func(a *finAcct) bool, value func(c *finCtx, e *finEntry) (int64, int64)) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.entries(p.From, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.filter(), es)
	cols := c.plCols(nil, p.From, p.To, finPeriodKind(p.Columns))
	vals := map[int64]finVals{}
	for i := range es {
		e := &es[i]
		a := c.accts[e.AccountID]
		if a == nil || !keep(a) {
			continue
		}
		id, amt := value(c, e)
		if id == 0 {
			continue
		}
		for j := range cols {
			if c.inSpan(cols[j].Span, e) {
				v := vals[id]
				if v == nil {
					v = finVals{}
					vals[id] = v
				}
				v[cols[j].Key] += amt
			}
		}
	}
	var roots []*finNode
	for _, n := range c.nameRoots {
		if n.Kind == kind {
			roots = append(roots, n)
		}
	}
	param := "customerIds"
	if kind == model.NameVendor {
		param = "vendorIds"
	}
	l := c.layout(cols, nil)
	total := l.nodes(roots, 0, "", vals, func(n *finNode, sub bool) finDrillFn {
		return func(col *finCol) *model.ReportDrill {
			jobs := "0"
			if sub {
				jobs = "1"
			}
			return c.drill(detailReport, col.Span.from, col.Span.to, nil, map[string]string{param: strconv.FormatInt(n.ID, 10), "includeJobs": jobs})
		}
	})
	l.add("grandtotal", 0, "TOTAL", total, func(col *finCol) *model.ReportDrill {
		return c.drill(detailReport, col.Span.from, col.Span.to, nil, nil)
	}, "")
	res := NewResult(ctx, q, p, title, false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

func finIsExpense(a *finAcct) bool {
	return a.Type == model.AcctCOGS || a.Type == model.AcctExpense || a.Type == model.AcctOtherExpense
}

func finIncomeByCustomerSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finEntitySummary(ctx, q, p, "Income by Customer Summary", model.NameCustomer, "income_by_customer_detail",
		func(a *finAcct) bool { return model.IsProfitLoss(a.Type) },
		func(c *finCtx, e *finEntry) (int64, int64) { return c.customerOf(e), -e.Amount })
}

func finExpensesByVendorSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finEntitySummary(ctx, q, p, "Expenses by Vendor Summary", model.NameVendor, "expenses_by_vendor_detail",
		finIsExpense,
		func(c *finCtx, e *finEntry) (int64, int64) { return c.vendorOf(e), e.Amount })
}
