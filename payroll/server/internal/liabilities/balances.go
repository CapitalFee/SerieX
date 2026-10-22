package liabilities

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// balances: accrued = non-voided paycheck lines (regular and ytd paychecks) by
// check date; adjusted = adjustment lines by effective date; paid = item lines
// of non-voided payments and earlier tax payments by the payment's period end.
func balances(ctx context.Context, q store.Q, from, to string) ([]model.LiabilityBalance, error) {
	its, err := liabilityItems(ctx, q)
	if err != nil {
		return nil, err
	}
	type sums struct{ accrued, adjusted, paid int64 }
	by := map[int64]*sums{}
	get := func(id int64) *sums {
		s := by[id]
		if s == nil {
			s = &sums{}
			by[id] = s
		}
		return s
	}
	run := func(query, col string, base []string, apply func(id, amt int64)) error {
		where := append([]string{}, base...)
		var args []any
		dateFilter(col, from, to, &where, &args)
		rows, err := q.QueryContext(ctx, query+" WHERE "+strings.Join(where, " AND ")+" GROUP BY 1", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, amt int64
			if err := rows.Scan(&id, &amt); err != nil {
				return err
			}
			apply(id, amt)
		}
		return rows.Err()
	}
	if err := run(`SELECT pl.item_id, SUM(pl.amount) FROM paycheck_lines pl JOIN paychecks p ON p.id = pl.paycheck_id`,
		"p.check_date", []string{"p.voided = 0", "pl.category IN ('employee_tax','employer_tax','deduction','contribution')"},
		func(id, amt int64) { get(id).accrued += amt }); err != nil {
		return nil, err
	}
	if err := run(`SELECT l.item_id, SUM(l.amount) FROM liability_adjustment_lines l JOIN liability_adjustments a ON a.id = l.adjustment_id`,
		"a.effective_date", []string{"1 = 1"},
		func(id, amt int64) { get(id).adjusted += amt }); err != nil {
		return nil, err
	}
	if err := run(`SELECT l.item_id, SUM(l.amount) FROM liability_payment_lines l JOIN liability_payments p ON p.id = l.payment_id`,
		"p.period_end", []string{"p.voided = 0", "l.kind = 'item'", "l.item_id IS NOT NULL"},
		func(id, amt int64) { get(id).paid += amt }); err != nil {
		return nil, err
	}
	cached, err := cachedAgencyNames(ctx, q)
	if err != nil {
		return nil, err
	}
	var list []*model.PayrollItem
	for id, s := range by {
		if s.accrued == 0 && s.adjusted == 0 && s.paid == 0 {
			continue
		}
		it := its[id]
		if it == nil {
			// the item no longer carries a liability (type changed): still show what it owes
			it = &model.PayrollItem{ID: id, Name: "Payroll item #" + strconv.FormatInt(id, 10)}
			var typ, code, group string
			if err := q.QueryRowContext(ctx, `SELECT name, type, tax_code, payment_group FROM payroll_items WHERE id = ?`, id).
				Scan(&it.Name, &typ, &code, &group); err == nil {
				it.Type, it.TaxCode, it.EffectiveGroup = typ, code, group
			}
		}
		list = append(list, it)
	}
	sort.Slice(list, func(i, j int) bool { return lessItem(list[i], list[j]) })
	out := make([]model.LiabilityBalance, 0, len(list))
	for _, it := range list {
		s := by[it.ID]
		b := model.LiabilityBalance{
			ItemID: it.ID, ItemName: it.Name, ItemType: it.Type, PaymentGroup: it.EffectiveGroup,
			Accrued: store.Dollars(s.accrued), Adjusted: store.Dollars(s.adjusted), Paid: store.Dollars(s.paid),
			Balance: store.Dollars(s.accrued + s.adjusted - s.paid),
		}
		if it.AgencyVendorID != nil {
			b.AgencyName = cached[*it.AgencyVendorID]
		}
		out = append(out, b)
	}
	return out, nil
}

// GET /liabilities/balances?from&to
func balancesRoute(c *httpx.Ctx) error {
	from, to, err := rangeParams(c)
	if err != nil {
		return err
	}
	list, err := balances(c.Context(), c.DB, from, to)
	if err != nil {
		return err
	}
	its, err := liabilityItems(c.Context(), c.DB)
	if err != nil {
		return err
	}
	n := newNamer(c)
	for i := range list {
		if it := its[list[i].ItemID]; it != nil && it.AgencyVendorID != nil {
			if s := n.vendor(it.AgencyVendorID); s != "" {
				list[i].AgencyName = s
			}
		}
	}
	return c.JSON(list)
}
