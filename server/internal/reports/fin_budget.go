package reports

// Budget reports: Budget Overview, Budget vs. Actual and Budget Progress.
// Budget lines hold 12 fiscal-month amounts (cents,
// natural sign); partial months are prorated by days.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

type finBudget struct {
	ID       int64
	Name     string
	FY       int
	Kind     string
	Criteria string
	Lines    []finBudgetLine
	fyStart  time.Time
}

type finBudgetLine struct {
	Acct, Class, Name int64
	Amts              [12]int64
}

// loadBudget loads the budget of the "budgetId" parameter, or the most recent
// one (of kind when given).
func (c *finCtx) loadBudget(kind string) (*finBudget, error) {
	id := c.p.ID("budgetId")
	b := &finBudget{}
	var err error
	if id > 0 {
		err = c.q.QueryRowContext(c.ctx, `SELECT id, name, fiscal_year, kind, criteria FROM budgets WHERE id = ?`, id).
			Scan(&b.ID, &b.Name, &b.FY, &b.Kind, &b.Criteria)
	} else {
		err = c.q.QueryRowContext(c.ctx, `SELECT id, name, fiscal_year, kind, criteria FROM budgets
			WHERE ? = '' OR kind = ? ORDER BY fiscal_year DESC, id DESC LIMIT 1`, kind, kind).
			Scan(&b.ID, &b.Name, &b.FY, &b.Kind, &b.Criteria)
	}
	if errors.Is(err, sql.ErrNoRows) {
		if id > 0 {
			return nil, apperr.NotFound("Budget %d not found", id)
		}
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.fyStart = time.Date(b.FY, time.Month(c.p.FiscalYearStartMonth), 1, 0, 0, 0, 0, time.UTC)
	rows, err := c.q.QueryContext(c.ctx, `SELECT account_id, IFNULL(class_id,0), IFNULL(name_id,0), amounts FROM budget_lines WHERE budget_id = ? ORDER BY id`, b.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ln finBudgetLine
		var raw string
		if err := rows.Scan(&ln.Acct, &ln.Class, &ln.Name, &raw); err != nil {
			return nil, err
		}
		var amts []float64
		json.Unmarshal([]byte(raw), &amts)
		for i := 0; i < 12 && i < len(amts); i++ {
			ln.Amts[i] = int64(math.Round(amts[i]))
		}
		b.Lines = append(b.Lines, ln)
	}
	return b, rows.Err()
}

// fyRange is the budget's fiscal year.
func (b *finBudget) fyRange() (string, string) {
	return b.fyStart.Format(iso), b.fyStart.AddDate(1, 0, -1).Format(iso)
}

// amount is the budget of a line for [from, to] (from "" = from the start).
func (b *finBudget) amount(ln *finBudgetLine, from, to string) int64 {
	var sum float64
	for i := 0; i < 12; i++ {
		if ln.Amts[i] == 0 {
			continue
		}
		ms := b.fyStart.AddDate(0, i, 0)
		me := finMonthEnd(ms)
		s, e := ms, me
		if f, ok := finParse(from); ok && f.After(s) {
			s = f
		}
		if t, ok := finParse(to); ok && t.Before(e) {
			e = t
		}
		if e.Before(s) {
			continue
		}
		days := e.Sub(s).Hours()/24 + 1
		mdays := float64(me.Day())
		sum += float64(ln.Amts[i]) * days / mdays
	}
	return int64(math.Round(sum))
}

// lineOK applies the class / customer:job filters to a budget line.
func (c *finCtx) budgetLineOK(ln *finBudgetLine) bool {
	f := c.filter()
	if f.classes != nil && !f.classes[ln.Class] {
		return false
	}
	if f.names != nil && !f.names[ln.Name] {
		return false
	}
	return true
}

// budgetTable adds budget amounts (as raw cents) to raw for the columns.
func (c *finCtx) budgetTable(b *finBudget, raw map[int64]finVals, cols []finCol, spanOf func(col *finCol) *finSpan) {
	for i := range b.Lines {
		ln := &b.Lines[i]
		a := c.accts[ln.Acct]
		if a == nil || !c.budgetLineOK(ln) {
			continue
		}
		for j := range cols {
			sp := spanOf(&cols[j])
			if sp == nil {
				continue
			}
			v := raw[a.ID]
			if v == nil {
				v = finVals{}
				raw[a.ID] = v
			}
			v[cols[j].Key] += b.amount(ln, sp.from, sp.to) * finSign(a.Type)
		}
	}
}

// budgetDates uses the budget's fiscal year when no dates were requested.
func (c *finCtx) budgetDates(b *finBudget) {
	v := c.p.Values
	if _, ok := v["from"]; ok {
		return
	}
	if _, ok := v["to"]; ok {
		return
	}
	if v.Get("dates") != "" {
		return
	}
	c.p.From, c.p.To = b.fyRange()
	c.p.AsOf = c.p.To
}

func (c *finCtx) budgetKindCols() string {
	if c.p.Columns == "" {
		c.p.Columns = "month"
	}
	return finPeriodKind(c.p.Columns)
}

func finNoBudget(ctx context.Context, q store.Q, p *Params, title string) *model.ReportResult {
	res := NewResult(ctx, q, p, title, false, false)
	res.Columns = []model.ReportColumn{finLabelCol()}
	res.Rows = append(res.Rows, model.ReportRow{Kind: "data", Cells: map[string]any{"label": "No budgets yet. Create one with Budgets in the Company menu."}})
	return res
}

func finBudgetOverview(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	b, err := c.loadBudget("")
	if err != nil {
		return nil, err
	}
	if b == nil {
		return finNoBudget(ctx, q, p, "Budget Overview"), nil
	}
	c.budgetDates(b)
	cols := c.plCols(nil, p.From, p.To, c.budgetKindCols())
	raw := map[int64]finVals{}
	c.budgetTable(b, raw, cols, func(col *finCol) *finSpan { return col.Span })
	l := c.layout(cols, raw)
	l.noDrill = true
	if b.Kind == "bs" {
		l.balanceSheet(finEquityExtra{})
	} else {
		l.profitLoss()
	}
	res := NewResult(ctx, q, p, "Budget Overview", false, false)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	if res.Params == nil {
		res.Params = p.Echo()
	}
	res.Params["budgetId"] = finItoa(b.ID)
	res.Params["budgetName"] = b.Name
	return res, nil
}

func finItoa(n int64) string { return finJoinIDs([]int64{n}) }

func finBudgetVsActual(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	b, err := c.loadBudget("pl")
	if err != nil {
		return nil, err
	}
	if b == nil {
		return finNoBudget(ctx, q, p, "Budget vs. Actual"), nil
	}
	if b.Kind != "pl" {
		return nil, apperr.Validation("budgetId", "Budget vs. Actual reports are available for Profit and Loss budgets only.")
	}
	c.budgetDates(b)
	periods := c.plCols(nil, p.From, p.To, c.budgetKindCols())
	var cols []finCol
	for _, pc := range periods {
		a, bk := "a_"+pc.Key, "b_"+pc.Key
		cols = append(cols,
			finCol{Key: a, Label: pc.Label, Type: "money", Span: pc.Span},
			finCol{Key: bk, Label: "Budget", Type: "money"},
			finCol{Key: "o_" + pc.Key, Label: "$ Over Budget", Type: "money", Derive: func(v finVals) any { return store.Dollars(v[a] - v[bk]) }},
			finCol{Key: "pct_" + pc.Key, Label: "% of Budget", Type: "percent", Derive: func(v finVals) any { return finRatioPct(v[a], v[bk]) }},
		)
	}
	es, err := c.plEntries(p.From, p.To)
	if err != nil {
		return nil, err
	}
	raw := c.table(es, cols)
	spans := map[string]*finSpan{}
	for _, pc := range periods {
		spans["b_"+pc.Key] = pc.Span
	}
	c.budgetTable(b, raw, cols, func(col *finCol) *finSpan { return spans[col.Key] })
	l := c.layout(cols, raw)
	l.profitLoss()
	res := NewResult(ctx, q, p, "Budget vs. Actual", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	res.Params = p.Echo()
	res.Params["budgetId"] = finItoa(b.ID)
	res.Params["budgetName"] = b.Name
	return res, nil
}

func finBudgetPerformance(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	b, err := c.loadBudget("pl")
	if err != nil {
		return nil, err
	}
	if b == nil {
		return finNoBudget(ctx, q, p, "Budget Progress (Profit and Loss)"), nil
	}
	if b.Kind != "pl" {
		return nil, apperr.Validation("budgetId", "Budget reports by account are available for Profit and Loss budgets only.")
	}
	fys := FiscalYearStart(p.To, p.FiscalYearStartMonth)
	fyEnd := finAddDays(finMustParse(fys).AddDate(1, 0, 0).Format(iso), -1)
	cur := &finSpan{from: p.From, to: p.To}
	ytd := &finSpan{from: fys, to: p.To}
	cols := []finCol{
		{Key: "cur", Label: finRangeLabel(p.From, p.To), Type: "money", Span: cur},
		{Key: "bcur", Label: "Budget", Type: "money"},
		{Key: "ytd", Label: finRangeLabel(fys, p.To), Type: "money", Span: ytd},
		{Key: "bytd", Label: "YTD Budget", Type: "money"},
		{Key: "annual", Label: "Annual Budget", Type: "money"},
	}
	lo := fys
	if p.From == "" || p.From < fys {
		lo = p.From
	}
	es, err := c.plEntries(lo, p.To)
	if err != nil {
		return nil, err
	}
	raw := c.table(es, cols)
	spans := map[string]*finSpan{"bcur": cur, "bytd": ytd, "annual": {from: fys, to: fyEnd}}
	c.budgetTable(b, raw, cols, func(col *finCol) *finSpan { return spans[col.Key] })
	l := c.layout(cols, raw)
	l.profitLoss()
	res := NewResult(ctx, q, p, "Budget Progress (Profit and Loss)", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	res.Params = p.Echo()
	res.Params["budgetId"] = finItoa(b.ID)
	res.Params["budgetName"] = b.Name
	return res, nil
}

func finMustParse(d string) time.Time {
	t, _ := time.Parse(iso, d)
	return t
}
