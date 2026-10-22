package reports

// Custom Summary Report: rows by account (Profit and Loss layout) or by
// customer:job, vendor, item or class (net income per row).

import (
	"context"
	"strconv"

	"seriex/internal/model"
	"seriex/internal/store"
)

func finCustomSummary(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	rowsBy := p.Str("rows")
	if rowsBy == "" || rowsBy == "account" {
		return finPLReport(ctx, q, p, "Custom Summary Report", p.Columns)
	}
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.plEntries(p.From, p.To)
	if err != nil {
		return nil, err
	}
	cols := c.plCols(nil, p.From, p.To, finPeriodKind(p.Columns))
	var roots []*finNode
	var keyOf func(e *finEntry) int64
	var param, noneLabel string
	noneExtra := map[string]string(nil)
	switch rowsBy {
	case "customer", "vendor":
		kind := model.NameCustomer
		keyOf = c.customerOf
		param = "customerIds"
		if rowsBy == "vendor" {
			kind, keyOf, param = model.NameVendor, c.vendorOf, "vendorIds"
		}
		for _, n := range c.nameRoots {
			if n.Kind == kind {
				roots = append(roots, n)
			}
		}
		noneLabel = "Not Specified"
		if rowsBy == "customer" {
			noneExtra = map[string]string{"noCustomer": "1"}
		}
	case "item":
		roots, param, noneLabel = c.itemRoots, "itemIds", "No item"
		keyOf = func(e *finEntry) int64 { return e.ItemID }
	case "class":
		roots, param, noneLabel = c.classRoots, "classIds", "No Class"
		keyOf = func(e *finEntry) int64 { return e.ClassID }
		noneExtra = map[string]string{"noClass": "1"}
	default:
		return finPLReport(ctx, q, p, "Custom Summary Report", p.Columns)
	}
	vals := map[int64]finVals{}
	for i := range es {
		e := &es[i]
		id := keyOf(e)
		for j := range cols {
			if c.inSpan(cols[j].Span, e) {
				v := vals[id]
				if v == nil {
					v = finVals{}
					vals[id] = v
				}
				v[cols[j].Key] -= e.Amount
			}
		}
	}
	l := c.layout(cols, nil)
	detail := func(extra map[string]string) finDrillFn {
		return func(col *finCol) *model.ReportDrill {
			ex := map[string]string{"plOnly": "1"}
			for k, v := range extra {
				ex[k] = v
			}
			return c.drill("custom_transaction_detail", col.Span.from, col.Span.to, nil, ex)
		}
	}
	total := l.nodes(roots, 0, "", vals, func(n *finNode, sub bool) finDrillFn {
		switch param {
		case "customerIds", "vendorIds":
			jobs := "0"
			if sub {
				jobs = "1"
			}
			return detail(map[string]string{param: strconv.FormatInt(n.ID, 10), "includeJobs": jobs})
		}
		ids := []int64{n.ID}
		if sub {
			ids = nil
			for _, d := range n.subtree() {
				ids = append(ids, d.ID)
			}
		}
		return detail(map[string]string{param: finJoinIDs(ids)})
	})
	if v := vals[0]; finNonzero(v) {
		var mk finDrillFn
		if noneExtra != nil {
			mk = detail(noneExtra)
		}
		l.add("data", 0, noneLabel, v, mk, "")
		total.add(v, 1)
	}
	l.add("grandtotal", 0, "TOTAL", total, detail(nil), "")
	res := NewResult(ctx, q, p, "Custom Summary Report", false, true)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	return res, nil
}
