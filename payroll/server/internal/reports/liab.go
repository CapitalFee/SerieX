package reports

import (
	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/model"
)

// Payroll Liability Balances: what each liability item still owes for the
// paychecks (by check date), adjustments (by effective date) and liability
// payments (by period end) of each period: accrued + adjusted - paid. The
// BALANCE column is liabilities.Balances over the whole range, so it ties to
// GET /liabilities/balances and to Pay Payroll Taxes.

var liabGroups = []struct{ typ, title string }{
	{model.ItemFederalTax, "Federal Taxes"},
	{model.ItemStateTax, "State Taxes"},
	{model.ItemOtherTax, "Other Taxes"},
	{model.ItemDeduction, "Deductions"},
	{model.ItemContribution, "Company Contributions"},
}

func payrollLiabilityBalances(e *env) (*model.ReportResult, error) {
	p := e.p
	mode := p.Columns
	switch mode {
	case "", "month", "months":
		mode = "month"
	case "quarter", "year", "total":
	default:
		mode = "month"
	}
	var periods []Period
	if mode != "total" {
		periods = Periods(e.periodsFrom(), p.To, mode)
		if len(periods) <= 1 {
			periods = nil
		}
	}
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	// balances per period and for the whole range
	type vals map[string]int64 // col key -> cents
	by := map[int64]vals{}
	names := map[int64]*model.PayrollItem{}
	collect := func(key, from, to string) error {
		list, err := liabilities.Balances(e.ctx, e.q, from, to)
		if err != nil {
			return err
		}
		for _, b := range list {
			v := by[b.ItemID]
			if v == nil {
				v = vals{}
				by[b.ItemID] = v
			}
			v[key] += centsOf(b.Balance)
			if names[b.ItemID] == nil {
				it := its.get(b.ItemID)
				if it.Type == "" {
					it.Type, it.Name = b.ItemType, b.ItemName
				}
				names[b.ItemID] = it
			}
		}
		return nil
	}
	for _, pr := range periods {
		if err := collect(pr.Key, pr.From, pr.To); err != nil {
			return nil, err
		}
	}
	if err := collect("balance", p.From, p.To); err != nil {
		return nil, err
	}
	cols := []model.ReportColumn{labelCol()}
	for _, pr := range periods {
		cols = append(cols, col(pr.Key, pr.Label, "money"))
	}
	cols = append(cols, col("balance", "BALANCE", "money"))
	res := e.newResult("Payroll Liability Balances", false, cols...)
	keys := []string{"balance"}
	for _, pr := range periods {
		keys = append(keys, pr.Key)
	}
	cells := func(label string, v vals) map[string]any {
		c := map[string]any{"label": label}
		for _, k := range keys {
			c[k] = dollars(v[k])
		}
		return c
	}
	add := func(dst, src vals) {
		for k, x := range src {
			dst[k] += x
		}
	}
	nonzero := func(v vals) bool {
		for _, x := range v {
			if x != 0 {
				return true
			}
		}
		return false
	}
	g0 := e.group()
	addRow(res, "section", 0, g0, map[string]any{"label": "Payroll Liabilities"})
	total := vals{}
	for _, lg := range liabGroups {
		var list []*model.PayrollItem
		for id, it := range names {
			if it.Type == lg.typ && nonzero(by[id]) {
				list = append(list, it)
			}
		}
		if len(list) == 0 {
			continue
		}
		sortItems(list)
		g := e.group()
		addRow(res, "section", 1, g, map[string]any{"label": lg.title})
		sub := vals{}
		for _, it := range list {
			// drill-down: the transactions behind the balance (tax payments by
			// the period they pay, like this report)
			r := addRow(res, "data", 2, g, cells(it.Name, by[it.ID]))
			r.Drill = drill("payroll_item_detail", "itemId", itoa(it.ID), "from", p.From, "to", p.To, "paidFor", "1")
			add(sub, by[it.ID])
		}
		addRow(res, "subtotal", 1, g, cells("Total "+lg.title, sub))
		add(total, sub)
	}
	// items whose type no longer carries a liability (shown so the total ties)
	var other []*model.PayrollItem
	for id, it := range names {
		known := false
		for _, lg := range liabGroups {
			known = known || it.Type == lg.typ
		}
		if !known && nonzero(by[id]) {
			other = append(other, it)
		}
	}
	if len(other) > 0 {
		sortItems(other)
		g := e.group()
		addRow(res, "section", 1, g, map[string]any{"label": "Other"})
		sub := vals{}
		for _, it := range other {
			r := addRow(res, "data", 2, g, cells(it.Name, by[it.ID]))
			r.Drill = drill("payroll_item_detail", "itemId", itoa(it.ID), "from", p.From, "to", p.To, "paidFor", "1")
			add(sub, by[it.ID])
		}
		addRow(res, "subtotal", 1, g, cells("Total Other", sub))
		add(total, sub)
	}
	addRow(res, "grandtotal", 0, g0, cells("Total Payroll Liabilities", total))
	return res, nil
}

// centsOf converts a dollar amount from a model value to cents.
func centsOf(f float64) int64 {
	v := f * 100
	if v >= 0 {
		return int64(v + 0.5)
	}
	return int64(v - 0.5)
}
