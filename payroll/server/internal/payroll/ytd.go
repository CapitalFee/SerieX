package payroll

import (
	"context"
	"fmt"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// ytdData holds what an employee was paid earlier in the calendar year of a
// check: non-voided paychecks (regular and ytd kinds)
// dated before the check (same date: lower id; new paychecks: every paycheck
// of that date) plus the employee's liability adjustments effective on or
// before the check date.
type ytdData struct {
	item    map[int64]int64  // amount per payroll item, calendar year
	itemAll map[int64]int64  // amount per payroll item, all years (one-time limits)
	base    map[string]int64 // taxable wages (after the cap) per tax key
	subj    map[string]int64 // wages subject to the tax (before the cap) per tax key
	amt     map[string]int64 // tax amount per tax key
	suppFIT int64            // supplemental wages taxable for federal withholding
	gross   int64
	net     int64
	cat     map[int64]string             // category of the items in item
	info    map[int64]*model.PayrollItem // the items in item
}

// ytdKey identifies the wages of one tax: federal taxes by code, state taxes
// by code and state, state programs by code, state and program key.
func ytdKey(code, state, key string) string {
	switch code {
	case model.TaxSIT, model.TaxSUIER, model.TaxSUIEE:
		return code + "|" + strings.ToUpper(state)
	case model.TaxStateEE, model.TaxStateER:
		return code + "|" + strings.ToUpper(state) + "|" + strings.ToUpper(key)
	}
	return code
}

func itemKey(it *model.PayrollItem) string {
	if it.TaxCode == "" {
		return ""
	}
	return ytdKey(it.TaxCode, it.State, it.TaxKey)
}

// loadYTD reads the year-to-date amounts of an employee before a check dated
// checkDate (paycheckID = the check itself, 0 for a new one).
func loadYTD(ctx context.Context, q store.Q, all map[int64]*model.PayrollItem, employeeID int64, checkDate string, paycheckID int64) (*ytdData, error) {
	y := &ytdData{item: map[int64]int64{}, itemAll: map[int64]int64{}, base: map[string]int64{}, subj: map[string]int64{},
		amt: map[string]int64{}, cat: map[int64]string{}, info: map[int64]*model.PayrollItem{}}
	yearStart := fmt.Sprintf("%04d-01-01", store.Year(checkDate))
	const before = `p.employee_id = ? AND p.voided = 0 AND p.id <> ?
		AND (p.check_date < ? OR (p.check_date = ? AND (? = 0 OR p.id < ?)))`
	args := []any{employeeID, paycheckID, checkDate, checkDate, paycheckID, paycheckID}

	rows, err := q.QueryContext(ctx, `SELECT p.check_date, l.item_id, l.category, l.amount, l.wage_base, l.subject_wages
		FROM paycheck_lines l JOIN paychecks p ON p.id = l.paycheck_id WHERE `+before, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var date, cat string
		var itemID, amount, wb, subj int64
		if err := rows.Scan(&date, &itemID, &cat, &amount, &wb, &subj); err != nil {
			return nil, err
		}
		y.itemAll[itemID] += amount
		if date < yearStart {
			continue
		}
		y.item[itemID] += amount
		y.cat[itemID] = cat
		it := all[itemID]
		if it == nil {
			continue
		}
		y.info[itemID] = it
		if k := itemKey(it); k != "" {
			y.base[k] += wb
			y.subj[k] += subj
			y.amt[k] += amount
		}
		if it.Supplemental && it.Taxability[model.BaseFIT] && (cat == model.CatEarning || cat == model.CatAddition || cat == model.CatContribution) {
			y.suppFIT += amount
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(p.gross), 0), COALESCE(SUM(p.net), 0) FROM paychecks p
		WHERE p.check_date >= ? AND `+before, append([]any{yearStart}, args...)...).Scan(&y.gross, &y.net); err != nil {
		return nil, err
	}

	// liability adjustments of the employee
	arows, err := q.QueryContext(ctx, `SELECT a.effective_date, al.item_id, al.amount, al.wage_base
		FROM liability_adjustment_lines al JOIN liability_adjustments a ON a.id = al.adjustment_id
		WHERE a.employee_id = ? AND a.effective_date <= ?`, employeeID, checkDate)
	if err != nil {
		return nil, err
	}
	defer arows.Close()
	for arows.Next() {
		var date string
		var itemID, amount, wb int64
		if err := arows.Scan(&date, &itemID, &amount, &wb); err != nil {
			return nil, err
		}
		y.itemAll[itemID] += amount
		if date < yearStart {
			continue
		}
		it := all[itemID]
		if it == nil {
			continue
		}
		y.item[itemID] += amount
		if _, ok := y.cat[itemID]; !ok {
			y.cat[itemID] = model.ItemCategory(it.Type, it.TaxCode)
		}
		y.info[itemID] = it
		if k := itemKey(it); k != "" {
			y.base[k] += wb
			y.subj[k] += wb
			y.amt[k] += amount
		}
	}
	return y, arows.Err()
}
