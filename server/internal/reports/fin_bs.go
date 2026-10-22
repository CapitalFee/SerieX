package reports

// Balance Sheet family (standard, summary, previous year comparison),
// Trial Balance and Statement of Cash Flows.

import (
	"context"
	"time"

	"seriex/internal/model"
	"seriex/internal/store"
)

// bsValues computes balance sheet amounts for columns whose Span.to is the
// "as of" date: raw balances of balance sheet accounts, Retained Earnings
// including the net income of every fiscal year before the column's fiscal
// year, and that fiscal year's Net Income to date (natural sign).
func (c *finCtx) bsValues(es []finEntry, cols []finCol) (raw map[int64]finVals, reSynth, ni finVals) {
	raw = map[int64]finVals{}
	reAdj := finVals{}
	ni = finVals{}
	type colDate struct{ key, to, fys string }
	var cds []colDate
	for _, col := range cols {
		if col.Span != nil && col.Derive == nil {
			cds = append(cds, colDate{col.Key, col.Span.to, FiscalYearStart(col.Span.to, c.p.FiscalYearStartMonth)})
		}
	}
	for i := range es {
		e := &es[i]
		a := c.accts[e.AccountID]
		if a == nil {
			continue
		}
		pl := model.IsProfitLoss(a.Type)
		for _, cd := range cds {
			if e.Date > cd.to {
				continue
			}
			switch {
			case pl && e.Date < cd.fys:
				reAdj[cd.key] += e.Amount
			case pl:
				ni[cd.key] -= e.Amount
			default:
				v := raw[a.ID]
				if v == nil {
					v = finVals{}
					raw[a.ID] = v
				}
				v[cd.key] += e.Amount
			}
		}
	}
	reSynth = finVals{}
	if c.reID != 0 {
		if finNonzero(reAdj) {
			v := raw[c.reID]
			if v == nil {
				v = finVals{}
				raw[c.reID] = v
			}
			v.add(reAdj, 1)
		}
	} else {
		reSynth.add(reAdj, -1)
	}
	return raw, reSynth, ni
}

// niDrill drills down from a balance sheet Net Income amount to the fiscal year to
// date Profit and Loss.
func (c *finCtx) niDrill() finDrillFn {
	return func(col *finCol) *model.ReportDrill {
		return c.drill("profit_loss", FiscalYearStart(col.Span.to, c.p.FiscalYearStartMonth), col.Span.to, nil, nil)
	}
}

func finBSCols(c *finCtx, p *Params) []finCol {
	switch p.Columns {
	case "week", "month", "quarter", "year":
		var cols []finCol
		for _, pr := range Periods(c.periodFrom(p.From, p.AsOf), p.AsOf, p.Columns, p.FiscalYearStartMonth) {
			cols = append(cols, finCol{Key: pr.Key, Label: finAsOfLabel(pr.To), Type: "money", Span: &finSpan{to: pr.To}})
		}
		return cols
	}
	return []finCol{{Key: "total", Label: finAsOfLabel(p.AsOf), Type: "money", Span: &finSpan{to: p.AsOf}}}
}

func finBSReport(ctx context.Context, q store.Q, p *Params, title string, cols []finCol, summary bool) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	// "As of" reports: an explicit asOf wins over the date range.
	if _, ok := p.Values["asOf"]; ok {
		if _, ok := p.Values["from"]; !ok {
			p.From = FiscalYearStart(p.AsOf, p.FiscalYearStartMonth)
		}
	}
	p.To = p.AsOf
	if p.From > p.To {
		p.From = FiscalYearStart(p.To, p.FiscalYearStartMonth)
	}
	if cols == nil {
		cols = finBSCols(c, p)
	}
	maxTo := ""
	for _, col := range cols {
		if col.Span != nil && col.Span.to > maxTo {
			maxTo = col.Span.to
		}
	}
	es, err := c.entries("", maxTo, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.bsFilter(), es)
	raw, reSynth, ni := c.bsValues(es, cols)
	l := c.layout(cols, raw)
	l.summary = summary
	l.balanceSheet(finEquityExtra{re: reSynth, ni: ni, niDrill: c.niDrill()})
	asOf := cols[0].Key == "total" || cols[0].Key == "cur"
	res := NewResult(ctx, q, p, title, asOf, true)
	if !asOf {
		res.DateRangeLabel = DateRangeLabel(c.periodFrom(p.From, p.AsOf), p.AsOf)
	}
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

func finBalanceSheet(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finBSReport(ctx, q, p, "Balance Sheet", nil, false)
}

func finBalanceSheetSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finBSReport(ctx, q, p, "Balance Sheet Summary", nil, true)
}

// bsFilter: the report filters of balance sheet style reports (every kind;
// "P&L accounts only" does not apply to them).
func (c *finCtx) bsFilter() *finFilter {
	f := c.filter()
	f.plOnly = false
	return f
}

// finBalanceSheetPrevPeriod compares the balances as of the report date with
// the balances at the end of the previous period: the day before the report
// period's From date (this month to date -> end of last month; also when no
// date is given, the default period being this month to date), or one month
// earlier when only an "as of" date is given.
func finBalanceSheetPrevPeriod(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	prev := ""
	_, hasAsOf := p.Values["asOf"]
	_, hasFrom := p.Values["from"]
	if p.From != "" && (hasFrom || !hasAsOf) {
		prev = finAddDays(p.From, -1)
	} else if t, ok := finParse(p.AsOf); ok {
		prev = t.AddDate(0, -1, 0).Format("2006-01-02")
		if t.AddDate(0, 0, 1).Day() == 1 { // a month end: the previous month end
			prev = time.Date(t.Year(), t.Month(), 0, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
		}
	}
	cols := finCompareCols(
		finCol{Key: "cur", Label: finAsOfLabel(p.AsOf), Type: "money", Span: &finSpan{to: p.AsOf}},
		finCol{Key: "prev", Label: finAsOfLabel(prev), Type: "money", Span: &finSpan{to: prev}},
	)
	return finBSReport(ctx, q, p, "Balance Sheet: This Period vs. Last Period", cols, false)
}

func finBalanceSheetPrevYear(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	prev := finPrevYear(p.AsOf)
	cols := finCompareCols(
		finCol{Key: "cur", Label: finAsOfLabel(p.AsOf), Type: "money", Span: &finSpan{to: p.AsOf}},
		finCol{Key: "prev", Label: finAsOfLabel(prev), Type: "money", Span: &finSpan{to: prev}},
	)
	return finBSReport(ctx, q, p, "Balance Sheet: This Year vs. Last Year", cols, false)
}

// ---------------------------------------------------------------------------
// Trial Balance

func finTrialBalance(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	asOf := p.AsOf
	fys := FiscalYearStart(asOf, p.FiscalYearStartMonth)
	es, err := c.entries("", asOf, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.bsFilter(), es)
	bal := map[int64]int64{}
	var reAdj int64
	for i := range es {
		e := &es[i]
		a := c.accts[e.AccountID]
		if a == nil {
			continue
		}
		if model.IsProfitLoss(a.Type) && e.Date < fys {
			reAdj += e.Amount
			continue
		}
		bal[a.ID] += e.Amount
	}
	if c.reID != 0 {
		bal[c.reID] += reAdj
		reAdj = 0
	}
	cols := []finCol{
		{Key: "debit", Label: "Debit", Type: "money", Span: &finSpan{to: asOf}},
		{Key: "credit", Label: "Credit", Type: "money", Span: &finSpan{to: asOf}},
	}
	l := c.layout(cols, nil)
	var dr, cr int64
	reDrill := func(col *finCol) *model.ReportDrill {
		ids := c.plIDs()
		if c.reID != 0 {
			ids = append(ids, c.reID)
		}
		return c.drill("transaction_detail_by_account", "", asOf, ids,
			map[string]string{"plTo": finAddDays(fys, -1), "netTotal": "credit"})
	}
	addRow := func(label string, amt int64, ids []int64, from string) {
		v := finVals{}
		if amt >= 0 {
			v["debit"] = amt
			dr += amt
		} else {
			v["credit"] = -amt
			cr += -amt
		}
		var mk finDrillFn
		switch {
		case len(ids) == 0 || (len(ids) == 1 && ids[0] == c.reID && c.reID != 0):
			mk = reDrill // Retained Earnings includes the net income of earlier years
		default:
			mk = func(col *finCol) *model.ReportDrill {
				return c.drill("transaction_detail_by_account", from, asOf, ids, nil)
			}
		}
		r := l.add("data", 0, label, v, mk, "")
		if amt >= 0 {
			r.Cells["credit"] = nil
		} else {
			r.Cells["debit"] = nil
		}
	}
	synthDone := reAdj == 0
	for _, a := range c.order {
		if !synthDone && model.AccountTypeRank(a.Type) > model.AccountTypeRank(model.AcctEquity) {
			addRow("Retained Earnings", reAdj, nil, "")
			synthDone = true
		}
		amt := bal[a.ID]
		if amt == 0 {
			continue
		}
		from := ""
		if model.IsProfitLoss(a.Type) {
			from = fys
		}
		addRow(a.Full, amt, []int64{a.ID}, from)
	}
	if !synthDone {
		addRow("Retained Earnings", reAdj, nil, "")
	}
	l.add("grandtotal", 0, "TOTAL", finVals{"debit": dr, "credit": cr}, nil, "")
	res := NewResult(ctx, q, p, "Trial Balance", true, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}

// ---------------------------------------------------------------------------
// Statement of Cash Flows (indirect method; cash = Bank accounts)

func finCashFlows(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	p.Basis = "accrual" // the statement of cash flows is always built from accrual postings
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	cols := c.plCols(nil, p.From, p.To, finPeriodKind(p.Columns))
	es, err := c.entries("", p.To, false)
	if err != nil {
		return nil, err
	}
	ni := finVals{}
	adj := map[int64]finVals{}
	begin, end := finVals{}, finVals{}
	for i := range es {
		e := &es[i]
		a := c.accts[e.AccountID]
		if a == nil {
			continue
		}
		for j := range cols {
			col := &cols[j]
			sp := col.Span
			if a.Type == model.AcctBank {
				if sp.from != "" && e.Date < sp.from {
					begin[col.Key] += e.Amount
				}
				if e.Date <= sp.to {
					end[col.Key] += e.Amount
				}
				continue
			}
			if !c.inSpan(sp, e) {
				continue
			}
			if model.IsProfitLoss(a.Type) {
				ni[col.Key] -= e.Amount
				continue
			}
			v := adj[a.ID]
			if v == nil {
				v = finVals{}
				adj[a.ID] = v
			}
			v[col.Key] -= e.Amount
		}
	}
	l := c.layout(cols, nil)
	acctMk := func(id int64) finDrillFn {
		return func(col *finCol) *model.ReportDrill {
			return c.drill("transaction_detail_by_account", col.Span.from, col.Span.to, []int64{id}, nil)
		}
	}
	section := func(title, total string, types []string, level int, always finVals, alwaysLabel string) finVals {
		sum := finVals{}
		g := c.group()
		start := len(l.rows)
		l.add("section", 0, title, nil, nil, g)
		if always != nil {
			l.add("data", 1, alwaysLabel, always, func(col *finCol) *model.ReportDrill {
				return c.drill("profit_loss", col.Span.from, col.Span.to, nil, nil)
			}, g)
			sum.add(always, 1)
			start = -1
		}
		hdr := -1
		for _, a := range c.order {
			ok := false
			for _, t := range types {
				ok = ok || a.Type == t
			}
			if !ok || !finNonzero(adj[a.ID]) {
				continue
			}
			if level == 2 && hdr < 0 {
				hdr = len(l.rows)
				l.add("section", 1, "Adjustments to reconcile Net Income to net cash provided by operations:", nil, nil, g)
			}
			l.add("data", level, a.Full, adj[a.ID], acctMk(a.ID), g)
			sum.add(adj[a.ID], 1)
		}
		if start >= 0 && len(l.rows) == start+1 {
			l.rows = l.rows[:start]
			return sum
		}
		l.add("subtotal", 0, total, sum, nil, g)
		return sum
	}
	op := section("OPERATING ACTIVITIES", "Net cash provided by Operating Activities",
		[]string{model.AcctAR, model.AcctOCA, model.AcctAP, model.AcctCreditCard, model.AcctOCL}, 2, ni, "Net Income")
	inv := section("INVESTING ACTIVITIES", "Net cash provided by Investing Activities",
		[]string{model.AcctFixedAsset, model.AcctOtherAsset}, 1, nil, "")
	fin := section("FINANCING ACTIVITIES", "Net cash provided by Financing Activities",
		[]string{model.AcctLTL, model.AcctEquity}, 1, nil, "")
	net := finPlus(finPlus(op, inv, 1), fin, 1)
	l.add("total", 0, "Net cash increase for period", net, nil, "")
	l.add("data", 0, "Cash at beginning of period", begin, nil, "")
	l.add("grandtotal", 0, "Cash at end of period", end, nil, "")
	res := NewResult(ctx, q, p, "Statement of Cash Flows", false, false)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}
