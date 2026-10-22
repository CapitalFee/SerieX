package liabilities

import (
	"context"
	"sort"
	"time"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// futaDepositThreshold: undeposited FUTA tax of $500 or less at a quarter end
// carries into the next quarter (Form 940 instructions).
const futaDepositThreshold = 50000

// dueRow is one payment group and period of the scheduled liabilities (cents).
type dueRow struct {
	Group     string
	Label     string
	Vendor    *int64
	Start     string
	End       string
	Due       string
	Freq      string
	Method    string
	Amount    map[int64]int64 // accrued + adjusted per item in the period
	Remaining map[int64]int64 // still owed per item after payments (FIFO)
	Total     int64           // Σ Remaining
	Paid      []datedAmount   // payment amounts applied to the period, with the payment date
}

// datedAmount is the part of a payment applied to one period.
type datedAmount struct {
	Date   string
	Amount int64
}

// amountTotal is the liability of the period before payments (accrued + adjusted).
func (r *dueRow) amountTotal() int64 {
	var t int64
	for _, v := range r.Amount {
		t += v
	}
	return t
}

// paidBy is what payments dated on or before date paid of the period.
func (r *dueRow) paidBy(date string) int64 {
	var t int64
	for _, p := range r.Paid {
		if p.Date <= date {
			t += p.Amount
		}
	}
	return t
}

// dueData is the state of every payment group: its items, schedule and periods.
type dueData struct {
	items  map[int64]*model.PayrollItem
	sched  *schedules
	groups map[string][]*model.PayrollItem // items per payment group, ordered
	rows   []*dueRow                       // every period of every group (all dates)
}

type payApply struct {
	ID     int64
	Date   string
	Start  string
	End    string
	ItemID int64
	Amount int64
}

// computeDue builds the scheduled liabilities of every group over all dates.
// vendorName may be nil.
func computeDue(ctx context.Context, q store.Q, vendorName func(*int64) string) (*dueData, error) {
	its, err := liabilityItems(ctx, q)
	if err != nil {
		return nil, err
	}
	sc, err := loadSchedules(ctx, q)
	if err != nil {
		return nil, err
	}
	d := &dueData{items: its, sched: sc, groups: map[string][]*model.PayrollItem{}}
	for _, it := range its {
		d.groups[it.EffectiveGroup] = append(d.groups[it.EffectiveGroup], it)
	}
	for g := range d.groups {
		list := d.groups[g]
		sort.Slice(list, func(i, j int) bool { return lessItem(list[i], list[j]) })
	}

	// accruals (by check date) and adjustments (by effective date) per item and date
	type key struct {
		item int64
		date string
	}
	amounts := map[key]int64{}
	load := func(query string) error {
		rows, err := q.QueryContext(ctx, query)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k key
			var amt int64
			if err := rows.Scan(&k.item, &k.date, &amt); err != nil {
				return err
			}
			amounts[k] += amt
		}
		return rows.Err()
	}
	if err := load(`SELECT pl.item_id, p.check_date, SUM(pl.amount) FROM paycheck_lines pl JOIN paychecks p ON p.id = pl.paycheck_id
		WHERE p.voided = 0 AND pl.category IN ('employee_tax','employer_tax','deduction','contribution') GROUP BY 1, 2`); err != nil {
		return nil, err
	}
	if err := load(`SELECT l.item_id, a.effective_date, SUM(l.amount) FROM liability_adjustment_lines l
		JOIN liability_adjustments a ON a.id = l.adjustment_id WHERE l.amount <> 0 GROUP BY 1, 2`); err != nil {
		return nil, err
	}

	// payments (and earlier tax payments), oldest first
	var pays []payApply
	rows, err := q.QueryContext(ctx, `SELECT p.id, p.date, p.period_start, p.period_end, l.item_id, SUM(l.amount)
		FROM liability_payment_lines l JOIN liability_payments p ON p.id = l.payment_id
		WHERE p.voided = 0 AND l.kind = 'item' AND l.item_id IS NOT NULL
		GROUP BY p.id, l.item_id ORDER BY p.date, p.id, l.item_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p payApply
		if err := rows.Scan(&p.ID, &p.Date, &p.Start, &p.End, &p.ItemID, &p.Amount); err != nil {
			rows.Close()
			return nil, err
		}
		pays = append(pays, p)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// periods per group
	byGroup := map[string]map[string]*dueRow{}
	for k, amt := range amounts {
		it := its[k.item]
		if it == nil || !store.ValidDate(k.date) {
			continue
		}
		g := it.EffectiveGroup
		s := sc.get(g, d.groups[g])
		start, end := periodOf(s.Freq, k.date)
		m := byGroup[g]
		if m == nil {
			m = map[string]*dueRow{}
			byGroup[g] = m
		}
		r := m[start]
		if r == nil {
			r = &dueRow{Group: g, Vendor: s.Vendor, Start: start, End: end, Freq: s.Freq, Method: s.Method,
				Amount: map[int64]int64{}, Remaining: map[int64]int64{}}
			m[start] = r
		}
		r.Amount[k.item] += amt
	}

	for g, m := range byGroup {
		periods := make([]*dueRow, 0, len(m))
		for _, r := range m {
			periods = append(periods, r)
		}
		sort.Slice(periods, func(i, j int) bool { return periods[i].Start < periods[j].Start })
		applyPayments(periods, pays)
		vname := ""
		if vendorName != nil {
			vname = vendorName(periods[0].Vendor)
		}
		label := groupLabel(g, d.groups[g], vname)
		for _, r := range periods {
			r.Label = label
		}
		setDueDates(g, periods)
		d.rows = append(d.rows, periods...)
	}
	sort.SliceStable(d.rows, func(i, j int) bool {
		a, b := d.rows[i], d.rows[j]
		if a.Due != b.Due {
			return a.Due < b.Due
		}
		if ra, rb := groupRank(a.Group), groupRank(b.Group); ra != rb {
			return ra < rb
		}
		if a.Group != b.Group {
			return a.Group < b.Group
		}
		return a.Start < b.Start
	})
	return d, nil
}

// applyPayments computes the remaining amount of every item in every period of
// one group and sets the period totals. Per item, each payment counts first
// against the periods it was made for (overlapping its period start..end),
// then against the oldest periods still owing (FIFO). A period whose net
// amount is negative (a decreasing adjustment) and overpayments are credits:
// they pay the item's oldest periods still owing, and what is left of them
// reduces the oldest periods of the group still owing as a negative item
// amount (paying it with the group, like a tax payment with a credit
// line). A negative payment line uses up such a credit first.
func applyPayments(periods []*dueRow, pays []payApply) {
	itemIDs := map[int64]bool{}
	for _, r := range periods {
		for id, amt := range r.Amount {
			itemIDs[id] = true
			r.Remaining[id] = amt
		}
	}
	// apply pays x of item id on the matching periods, oldest first; date is
	// the payment date ("" for credits that are not a payment of their own).
	apply := func(id, x int64, date string, match func(r *dueRow) bool) int64 {
		for _, r := range periods {
			if x <= 0 {
				break
			}
			if rem := r.Remaining[id]; rem > 0 && match(r) {
				use := min(rem, x)
				r.Remaining[id] = rem - use
				x -= use
				if date != "" {
					r.Paid = append(r.Paid, datedAmount{Date: date, Amount: use})
				}
			}
		}
		return x
	}
	all := func(*dueRow) bool { return true }
	ids := make([]int64, 0, len(itemIDs))
	for id := range itemIDs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	credits := map[int64]int64{}
	for _, id := range ids {
		var credit int64
		for _, r := range periods {
			if r.Remaining[id] < 0 {
				credit += -r.Remaining[id]
				r.Remaining[id] = 0
			}
		}
		for _, p := range pays {
			if p.ItemID != id || p.Amount == 0 {
				continue
			}
			forPeriod := func(r *dueRow) bool { return r.Start <= p.End && r.End >= p.Start }
			if p.Amount < 0 {
				// a negative line takes back a credit; beyond it the item owes again
				back := -p.Amount
				use := min(credit, back)
				credit -= use
				if back -= use; back > 0 {
					target := periods[len(periods)-1]
					for _, r := range periods {
						if forPeriod(r) {
							target = r
							break
						}
					}
					target.Remaining[id] += back
				}
				continue
			}
			x := apply(id, p.Amount, p.Date, forPeriod)
			credit += apply(id, x, p.Date, all) // paid beyond every period: a credit
		}
		credits[id] = apply(id, credit, "", all)
	}
	for _, r := range periods {
		for _, v := range r.Remaining {
			r.Total += v
		}
	}
	// credits left offset the oldest periods of the group still owing
	for _, id := range ids {
		left := credits[id]
		for _, r := range periods {
			if left <= 0 {
				break
			}
			if r.Total > 0 {
				use := min(left, r.Total)
				r.Remaining[id] -= use
				r.Total -= use
				left -= use
			}
		}
	}
	for _, r := range periods {
		for id, v := range r.Remaining {
			if v == 0 {
				delete(r.Remaining, id)
			}
		}
	}
}

// setDueDates fills the due date of every period of one group (sorted by
// start). Federal 940 liabilities paid quarterly follow the $500 rule.
func setDueDates(group string, periods []*dueRow) {
	if group == model.GroupFederal940 && len(periods) > 0 && periods[0].Freq == model.PayFreqQuarterly {
		setFUTADueDates(group, periods)
		return
	}
	for _, r := range periods {
		end, _ := store.ParseDate(r.End)
		r.Due = dueDate(group, r.Freq, end).Format("2006-01-02")
	}
}

// setFUTADueDates applies the Form 940 deposit rule (Pub 15, Form 940
// instructions): at the end of each quarter, the FUTA tax not yet deposited
// that was carried forward from earlier quarters of the year plus the
// quarter's own liability is due by the end of the following month when it is
// more than $500; otherwise it carries into the next quarter. What is left at
// the end of the year is due January 31. Amounts that already had to be
// deposited are never carried again (paying them late does not move later
// quarters), and only payments dated by a quarter end reduce what is carried
// at that quarter end.
func setFUTADueDates(group string, periods []*dueRow) {
	var pending []*dueRow // carried quarters of the current year
	year := 0
	flush := func(deadline time.Time) {
		due := dueDate(group, model.PayFreqQuarterly, deadline).Format("2006-01-02")
		for _, p := range pending {
			p.Due = due
		}
		pending = nil
	}
	yearEnd := func(y int) time.Time { return time.Date(y, time.December, 31, 0, 0, 0, 0, time.UTC) }
	for _, r := range periods {
		end, _ := store.ParseDate(r.End)
		if end.Year() != year {
			if len(pending) > 0 {
				flush(yearEnd(year))
			}
			year = end.Year()
		}
		pending = append(pending, r)
		var carried int64
		for _, p := range pending {
			carried += max(p.amountTotal()-p.paidBy(r.End), 0)
		}
		if carried > futaDepositThreshold {
			flush(end)
		}
	}
	if len(pending) > 0 {
		flush(yearEnd(year))
	}
}

// status of a due row: Paid, Overdue, Due (within prefs.dueSoonDays) or Upcoming.
func rowStatus(r *dueRow, today, soon string) string {
	switch {
	case r.Total <= 0:
		return "Paid"
	case r.Due < today:
		return "Overdue"
	case r.Due <= soon:
		return "Due"
	}
	return "Upcoming"
}

func (d *dueData) toModel(r *dueRow, today, soon string, vendorName func(*int64) string) model.LiabilityDue {
	out := model.LiabilityDue{
		PaymentGroup: r.Group, Label: r.Label, AgencyVendorID: r.Vendor, PeriodStart: r.Start, PeriodEnd: r.End,
		DueDate: r.Due, Status: rowStatus(r, today, soon), Frequency: r.Freq, Method: r.Method,
		AmountDue: store.Dollars(r.Total), Items: []model.LiabilityItemAmount{},
	}
	if vendorName != nil {
		out.AgencyName = vendorName(r.Vendor)
	}
	for _, it := range d.groups[r.Group] {
		if v := r.Remaining[it.ID]; v != 0 {
			out.Items = append(out.Items, model.LiabilityItemAmount{ItemID: it.ID, ItemName: it.Name, Amount: store.Dollars(v)})
		}
	}
	return out
}

// find returns the row of a group and period (nil when there is none).
func (d *dueData) find(group, start, end string) *dueRow {
	for _, r := range d.rows {
		if r.Group == group && r.Start == start && r.End == end {
			return r
		}
	}
	return nil
}

// GET /liabilities/due?from&to&showPaid=0|1 : periods overlapping from..to.
func dueRoute(c *httpx.Ctx) error {
	from, to, err := rangeParams(c)
	if err != nil {
		return err
	}
	showPaid := c.QBool("showPaid")
	ctx := c.Context()
	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return err
	}
	n := newNamer(c)
	d, err := computeDue(ctx, c.DB, n.vendor)
	if err != nil {
		return err
	}
	today := store.Today()
	soon := store.AddDays(today, max(prefs.DueSoonDays, 0))
	out := []model.LiabilityDue{}
	for _, r := range d.rows {
		if (from != "" && r.End < from) || (to != "" && r.Start > to) {
			continue
		}
		if !showPaid && r.Total <= 0 {
			continue
		}
		out = append(out, d.toModel(r, today, soon, n.vendor))
	}
	return c.JSON(out)
}
