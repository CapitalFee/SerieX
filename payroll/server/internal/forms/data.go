package forms

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strings"

	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Every form is computed from the same raw data: non-voided paychecks (kinds
// regular and ytd) dated by check date, liability adjustments dated by
// effective date (employee adjustments change the employee's wages and taxes;
// company adjustments only change the company's liability) and liability
// payments dated by their period end. Voided paychecks keep zero lines and are
// skipped anyway.

// fline is one paycheck (or adjustment) line.
type fline struct {
	item     *model.PayrollItem
	cat      string
	amount   int64
	wageBase int64
	subject  int64
}

// fcheck is one paycheck or one liability adjustment.
type fcheck struct {
	id          int64  // paycheck id or adjustment id
	adjustment  bool   // liability adjustment (by effective date)
	employeeID  int64  // 0: company adjustment
	kind        string // regular | ytd | adjustment
	periodStart string
	periodEnd   string
	date        string // check date / effective date
	gross       int64
	lines       []fline
}

type dataset struct {
	items  map[int64]*model.PayrollItem
	checks []*fcheck
}

// loadData reads every non-voided paycheck dated from..to and every liability
// adjustment effective from..to, with their lines, in date order.
func loadData(ctx context.Context, q store.Q, from, to string) (*dataset, error) {
	all, err := items.All(ctx, q)
	if err != nil {
		return nil, err
	}
	ds := &dataset{items: all}
	byID := map[int64]*fcheck{}

	rows, err := q.QueryContext(ctx, `SELECT id, employee_id, kind, period_start, period_end, check_date, gross
		FROM paychecks WHERE voided = 0 AND check_date >= ? AND check_date <= ? ORDER BY check_date, id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		c := &fcheck{}
		if err := rows.Scan(&c.id, &c.employeeID, &c.kind, &c.periodStart, &c.periodEnd, &c.date, &c.gross); err != nil {
			return nil, err
		}
		ds.checks = append(ds.checks, c)
		byID[c.id] = c
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	lrows, err := q.QueryContext(ctx, `SELECT l.paycheck_id, l.item_id, l.category, l.amount, l.wage_base, l.subject_wages
		FROM paycheck_lines l JOIN paychecks p ON p.id = l.paycheck_id
		WHERE p.voided = 0 AND p.check_date >= ? AND p.check_date <= ? ORDER BY l.paycheck_id, l.seq, l.id`, from, to)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var pid, itemID int64
		var l fline
		if err := lrows.Scan(&pid, &itemID, &l.cat, &l.amount, &l.wageBase, &l.subject); err != nil {
			return nil, err
		}
		c := byID[pid]
		it := all[itemID]
		if c == nil || it == nil {
			continue
		}
		l.item = it
		c.lines = append(c.lines, l)
	}
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	lrows.Close()

	arows, err := q.QueryContext(ctx, `SELECT a.id, a.employee_id, a.effective_date, al.item_id, al.amount, al.wage_base
		FROM liability_adjustment_lines al JOIN liability_adjustments a ON a.id = al.adjustment_id
		WHERE a.effective_date >= ? AND a.effective_date <= ? ORDER BY a.effective_date, a.id, al.seq, al.id`, from, to)
	if err != nil {
		return nil, err
	}
	defer arows.Close()
	adj := map[int64]*fcheck{}
	for arows.Next() {
		var id, itemID, amount, wb int64
		var emp sql.NullInt64
		var date string
		if err := arows.Scan(&id, &emp, &date, &itemID, &amount, &wb); err != nil {
			return nil, err
		}
		it := all[itemID]
		if it == nil {
			continue
		}
		c := adj[id]
		if c == nil {
			c = &fcheck{id: id, adjustment: true, employeeID: emp.Int64, kind: "adjustment", periodStart: date, periodEnd: date, date: date}
			adj[id] = c
			ds.checks = append(ds.checks, c)
		}
		// adjustments change the wages subject to the tax and the taxable wages alike (as payroll YTD does)
		c.lines = append(c.lines, fline{item: it, cat: model.ItemCategory(it.Type, it.TaxCode), amount: amount, wageBase: wb, subject: wb})
	}
	if err := arows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(ds.checks, func(i, j int) bool { return ds.checks[i].date < ds.checks[j].date })
	return ds, nil
}

// ---------------------------------------------------------------------------
// Per check helpers

// taxSum returns Σ amount, Σ wage base and Σ subject wages of the lines with a tax code.
func (c *fcheck) taxSum(code string) (amount, wageBase, subject int64, found bool) {
	for _, l := range c.lines {
		if l.item.TaxCode == code {
			amount += l.amount
			wageBase += l.wageBase
			subject += l.subject
			found = true
		}
	}
	return
}

// base returns the taxable wages of a tax for the check, taken from the
// employee-side line (SS_EE, MED_EE) and from the company-side line when the
// employee line is missing.
func (c *fcheck) base(eeCode, erCode string) int64 {
	_, wb, _, ok := c.taxSum(eeCode)
	if ok {
		return wb
	}
	if erCode != "" {
		_, wb, _, _ = c.taxSum(erCode)
	}
	return wb
}

// isTips: tips items (reported and paid tips) are social security tips (W-2 box 7).
func isTips(it *model.PayrollItem) bool {
	switch it.TaxTracking {
	case model.TrackReportedTips, model.TrackPaidTips:
		return true
	}
	return it.Type == model.ItemTips || it.Type == model.ItemReportedTips
}

// ssTips returns the social security tips of a check that fall within the
// social security wage base: the tips subject to social security, limited to
// the check's taxable social security wages (W-2 box 3 + box 7 never exceed
// the wage base).
func (c *fcheck) ssTips() int64 {
	if c.adjustment {
		return 0
	}
	var tips int64
	for _, l := range c.lines {
		if l.cat == model.CatEarning && isTips(l.item) && l.item.Taxability[model.BaseSS] {
			tips += l.amount
		}
	}
	ssBase := c.base(model.TaxSSEE, model.TaxSSER)
	if tips > ssBase {
		tips = ssBase
	}
	if tips < 0 {
		tips = 0
	}
	return tips
}

// imputedIncome returns the taxable value of group-term life insurance over
// $50,000 on a check when its item is not taxable for federal withholding:
// it is still wages for W-2 box 1 and Form 941 line 2 (withholding on it is
// optional; Pub. 15-B).
func (c *fcheck) imputedIncome() int64 {
	var v int64
	for _, l := range c.lines {
		if (l.cat == model.CatContribution || l.cat == model.CatAddition || l.cat == model.CatEarning) &&
			l.item.TaxTracking == model.TrackGroupTermLife && !l.item.Taxability[model.BaseFIT] {
			v += l.amount
		}
	}
	return v
}

// suiState returns the state whose unemployment insurance covered the check
// ("" when the check has no state unemployment line with wages).
func (c *fcheck) suiState() string {
	for _, l := range c.lines {
		if (l.item.TaxCode == model.TaxSUIER || l.item.TaxCode == model.TaxSUIEE) && (l.subject != 0 || l.wageBase != 0) {
			return strings.ToUpper(l.item.State)
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// Company, employees, payments, saved filings

type companyRow struct {
	model.FormCompany
	title           string
	email           string
	phone           string
	primaryState    string
	depositSchedule string
}

func loadCompany(ctx context.Context, q store.Q) (*companyRow, error) {
	c := &companyRow{}
	var name, legal, trade, ein string
	err := q.QueryRowContext(ctx, `SELECT name, legal_name, trade_name, address1, address2, city, state, zip, phone, email, ein,
		contact_name, contact_title, contact_phone, primary_state, federal_deposit_schedule FROM company WHERE id = 1`).Scan(
		&name, &legal, &trade, &c.Address.Line1, &c.Address.Line2, &c.Address.City, &c.Address.State, &c.Address.Zip,
		&c.phone, &c.email, &ein, &c.ContactName, &c.title, &c.ContactPhone, &c.primaryState, &c.depositSchedule)
	if err != nil {
		return nil, err
	}
	// "Name (not your trade name)" is the legal name; the trade name is the
	// name the business uses when it differs.
	c.Name = strings.TrimSpace(legal)
	c.TradeName = strings.TrimSpace(trade)
	if c.Name == "" {
		c.Name = name
	} else if c.TradeName == "" && !strings.EqualFold(name, c.Name) {
		c.TradeName = name
	}
	c.EIN = store.FormatEIN(ein)
	c.Email = strings.TrimSpace(c.email)
	if c.ContactPhone == "" {
		c.ContactPhone = c.phone
	}
	c.primaryState = strings.ToUpper(c.primaryState)
	return c, nil
}

type employeeRow struct {
	id                                int64
	first, middle, last, suffix, name string
	ssn                               string // digits
	addr                              model.Address
	number                            string
	employmentType                    string
	workState                         string
	hireDate, releaseDate             string
}

func loadEmployees(ctx context.Context, q store.Q) (map[int64]*employeeRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, first_name, middle_name, last_name, suffix, display_name, ssn, address1, address2,
		city, state, zip, employee_number, employment_type, work_state, hire_date, release_date FROM employees`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*employeeRow{}
	for rows.Next() {
		e := &employeeRow{}
		if err := rows.Scan(&e.id, &e.first, &e.middle, &e.last, &e.suffix, &e.name, &e.ssn, &e.addr.Line1, &e.addr.Line2,
			&e.addr.City, &e.addr.State, &e.addr.Zip, &e.number, &e.employmentType, &e.workState, &e.hireDate, &e.releaseDate); err != nil {
			return nil, err
		}
		e.ssn = store.Digits(e.ssn)
		out[e.id] = e
	}
	return out, rows.Err()
}

// ssnOut is the SSN shown on a form: full (123-45-6789) when revealed, masked otherwise.
func ssnOut(digits string, reveal bool) string {
	if reveal {
		return store.FormatSSN(digits)
	}
	return store.MaskSSN(digits)
}

// paymentsByGroup returns Σ item lines of non-voided liability payments
// (payments and earlier tax payments) whose period ends from..to, for the items of
// the given payment groups (exact group names, e.g. "state_ui:NJ").
func paymentsByGroup(ctx context.Context, q store.Q, all map[int64]*model.PayrollItem, from, to string, groups ...string) (int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT pl.item_id, pl.amount FROM liability_payment_lines pl
		JOIN liability_payments lp ON lp.id = pl.payment_id
		WHERE lp.voided = 0 AND pl.kind = 'item' AND pl.item_id IS NOT NULL AND lp.period_end >= ? AND lp.period_end <= ?`, from, to)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var sum int64
	for rows.Next() {
		var itemID, amount int64
		if err := rows.Scan(&itemID, &amount); err != nil {
			return 0, err
		}
		it := all[itemID]
		if it == nil {
			continue
		}
		for _, g := range groups {
			if it.EffectiveGroup == g {
				sum += amount
				break
			}
		}
	}
	return sum, rows.Err()
}

// stateIDs returns the employer state account numbers (withholding and UI) by state.
func stateIDs(ctx context.Context, q store.Q) (wh, ui map[string]string, err error) {
	wh, ui = map[string]string{}, map[string]string{}
	rows, err := q.QueryContext(ctx, `SELECT state, withholding_id, ui_id FROM state_settings`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var st, w, u string
		if err := rows.Scan(&st, &w, &u); err != nil {
			return nil, nil, err
		}
		wh[strings.ToUpper(st)] = w
		ui[strings.ToUpper(st)] = u
	}
	return wh, ui, rows.Err()
}

// ---------------------------------------------------------------------------
// Money helpers

// pctOf returns round(cents x rate%) half away from zero, exactly (the rate is
// turned into millionths of a percent so no binary fraction flips a half cent).
func pctOf(cents int64, rate float64) int64 {
	r := int64(math.Round(rate * 1e6))
	num := cents * r
	const den = 100 * 1_000_000
	if num >= 0 {
		return (num + den/2) / den
	}
	return -((-num + den/2) / den)
}

func money(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	s := fmt.Sprintf("%d", c/100)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := fmt.Sprintf("%s.%02d", b.String(), c%100)
	if neg {
		return "-" + out
	}
	return out
}

// spread adds diff to a list of period liabilities so that they sum to a
// target: a positive difference goes to the last period with a liability (the
// last period when none has one); a negative one reduces the periods from the
// first one on, never below zero, carrying the unused part forward (Form 941
// instructions: "enter -0- and carry the unused part to the next month").
// Whatever cannot be absorbed stays on the last period.
func spread(vals []int64, diff int64) {
	if len(vals) == 0 || diff == 0 {
		return
	}
	if diff > 0 {
		idx := len(vals) - 1
		for i := len(vals) - 1; i >= 0; i-- {
			if vals[i] != 0 {
				idx = i
				break
			}
		}
		vals[idx] += diff
		return
	}
	left := -diff
	for i := range vals {
		if left == 0 {
			break
		}
		if vals[i] <= 0 {
			continue
		}
		take := vals[i]
		if take > left {
			take = left
		}
		vals[i] -= take
		left -= take
	}
	if left > 0 {
		vals[len(vals)-1] -= left
	}
}
