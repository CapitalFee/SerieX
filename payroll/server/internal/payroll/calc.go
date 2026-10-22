package payroll

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// cline is one paycheck line during the calculation (money in cents).
type cline struct {
	item     *model.PayrollItem
	category string
	rate     *float64
	qty      *float64
	amount   int64
	wageBase int64
	subject  int64
	computed int64
	job      *int64
	class    *int64
	manual   bool
}

// calcEnv caches what several paychecks of one payroll share.
type calcEnv struct {
	items  map[int64]*model.PayrollItem
	tables map[int]*model.TaxYear
	warn   map[int]string
}

func newEnv(ctx context.Context, q store.Q) (*calcEnv, error) {
	all, err := items.All(ctx, q)
	if err != nil {
		return nil, err
	}
	return &calcEnv{items: all, tables: map[int]*model.TaxYear{}, warn: map[int]string{}}, nil
}

func (env *calcEnv) taxYear(ctx context.Context, q store.Q, year int) (*model.TaxYear, string, error) {
	if ty, ok := env.tables[year]; ok {
		return ty, env.warn[year], nil
	}
	ty, warn, err := taxes.ForCompany(ctx, q, year)
	if err != nil {
		return nil, "", err
	}
	env.tables[year], env.warn[year] = ty, warn
	return ty, warn, nil
}

type calcOpts struct {
	// keepAll: Recalculate = false when editing a saved paycheck. Every line
	// sent keeps its amount; only missing tax lines are computed.
	keepAll bool
}

// calcResult is a calculated paycheck plus what saving it needs.
type calcResult struct {
	pc       *model.Paycheck
	emp      *model.Employee
	lines    []*cline
	ytd      *ytdData
	gross    int64
	notPaid  int64
	ded      int64
	eeTax    int64
	erTax    int64
	contrib  int64
	net      int64
	hours    float64
	sickAcc  float64
	sickUsed float64
	vacAcc   float64
	vacUsed  float64
	inputs   map[string]any
	warnings []string
}

func (r *calcResult) warn(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	for _, w := range r.warnings {
		if w == msg {
			return
		}
	}
	r.warnings = append(r.warnings, msg)
}

func fptr(f float64) *float64 { return &f }

func round4(f float64) float64 { return math.Round(f*10000) / 10000 }

// centsOf rounds rate x qty (dollars) to cents, half away from zero.
func centsOf(f float64) int64 { return store.Cents(f) }

// hourBased: wage items whose quantity is hours.
func hourBased(t string) bool {
	return t == model.ItemHourly || t == model.ItemOvertime || t == model.ItemSalary
}

func validKind(k string) bool { return k == model.PaycheckRegular || k == model.PaycheckYTD }

// normalizeDates fills the period and check dates of an input. YTD entries
// cover the calendar quarter of their date (check date = quarter end unless a
// date is given).
func normalizeDates(in *model.PaycheckInput, e *model.Employee, semiFirst int) error {
	if in.Kind == model.PaycheckYTD {
		d := in.CheckDate
		if d == "" {
			d = in.PeriodEnd
		}
		if d == "" {
			d = in.PeriodStart
		}
		if !store.ValidDate(d) {
			return apperr.Validation("checkDate", "Enter the date (or quarter end) of the year-to-date amounts.")
		}
		qs, qe := store.QuarterRange(store.Year(d), store.Quarter(d))
		in.PeriodStart, in.PeriodEnd = qs, qe
		if !store.ValidDate(in.CheckDate) {
			in.CheckDate = qe
		}
		return nil
	}
	if !store.ValidDate(in.CheckDate) {
		return apperr.Validation("checkDate", "Please enter a valid check date.")
	}
	if in.PeriodEnd == "" {
		in.PeriodEnd = in.CheckDate
	}
	if !store.ValidDate(in.PeriodEnd) {
		return apperr.Validation("periodEnd", "Please enter a valid pay period end date.")
	}
	if in.PeriodStart == "" {
		in.PeriodStart = employees.PeriodStart(e.PayFrequency, in.PeriodEnd, semiFirst)
	}
	if !store.ValidDate(in.PeriodStart) {
		return apperr.Validation("periodStart", "Please enter a valid pay period start date.")
	}
	if in.PeriodStart > in.PeriodEnd {
		return apperr.Validation("periodStart", "The pay period start date must be on or before the pay period end date.")
	}
	return nil
}

// semiFirstDay returns the semimonthly first period end day of the employee's schedule (15 when none).
func semiFirstDay(ctx context.Context, q store.Q, e *model.Employee) int {
	if e.PayScheduleID == nil {
		return 15
	}
	var d int
	if err := q.QueryRowContext(ctx, `SELECT semi_first_day FROM pay_schedules WHERE id = ?`, *e.PayScheduleID).Scan(&d); err != nil || d <= 0 {
		return 15
	}
	return d
}

// calculate runs the paycheck calculation for one paycheck input.
func calculate(ctx context.Context, q store.Q, env *calcEnv, in *model.PaycheckInput, opt calcOpts) (*calcResult, error) {
	if in == nil {
		return nil, apperr.BadRequest("missing paycheck")
	}
	if in.EmployeeID <= 0 {
		return nil, apperr.Validation("employeeId", "Choose an employee.")
	}
	if in.Kind == "" {
		in.Kind = model.PaycheckRegular
	}
	if !validKind(in.Kind) {
		return nil, apperr.Validation("kind", "Unknown paycheck kind %q.", in.Kind)
	}
	e, err := employees.Load(ctx, q, in.EmployeeID, false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Employee not found.")
	}
	if err != nil {
		return nil, err
	}
	if err := normalizeDates(in, e, semiFirstDay(ctx, q, e)); err != nil {
		return nil, err
	}
	// a new paycheck takes the employee's class (Payroll Info tab) unless one is given
	if in.ID == 0 && in.Kind == model.PaycheckRegular && in.ClassID == nil && e.ClassID != nil {
		in.ClassID = e.ClassID
	}
	if env == nil {
		if env, err = newEnv(ctx, q); err != nil {
			return nil, err
		}
	}
	year := store.Year(in.CheckDate)
	ty, tyWarn, err := env.taxYear(ctx, q, year)
	if err != nil {
		return nil, err
	}
	y, err := loadYTD(ctx, q, env.items, e.ID, in.CheckDate, in.ID)
	if err != nil {
		return nil, err
	}
	r := &calcResult{emp: e, ytd: y}
	if tyWarn != "" {
		r.warn("%s", tyWarn)
	}
	// An exemption from federal withholding is good for one calendar year: when
	// no new Form W-4 was given by February 15 of the next year, withhold as
	// single with no adjustments (Pub 15 section 9) until the employee gives one.
	if e.W4.Exempt && e.W4.ExemptYear > 0 && in.Kind == model.PaycheckRegular &&
		in.CheckDate > fmt.Sprintf("%04d-02-15", e.W4.ExemptYear+1) {
		r.warn("Federal Withholding: the exemption claimed for %d expired on 02/15/%d; withheld as single with no adjustments. Enter the employee's new Form W-4.",
			e.W4.ExemptYear, e.W4.ExemptYear+1)
		e.W4 = model.W4{Version: "2020", FilingStatus: "single", NonresidentAlien: e.W4.NonresidentAlien, ExemptYear: e.W4.ExemptYear}
	}
	for _, l := range in.Lines {
		if l.ItemID <= 0 || env.items[l.ItemID] == nil {
			return nil, apperr.Validation("lines", "A paycheck line refers to a payroll item that does not exist (#%d).", l.ItemID)
		}
	}
	periods := model.PayPeriods[e.PayFrequency]
	if periods <= 0 {
		periods = 26
		r.warn("%s has no valid pay frequency; biweekly was used.", e.DisplayName)
	}

	// 1. earnings
	earn := computeEarnings(e, env.items, in.Lines, periods, opt.keepAll, in.Kind == model.PaycheckYTD, r)
	var grossWages, wagesPaid int64 // all earnings; earnings without reported tips
	var workedHours float64
	for _, l := range earn {
		grossWages += l.amount
		if !l.item.NotPaid {
			wagesPaid += l.amount
		}
		if hourBased(l.item.Type) && l.qty != nil {
			r.hours += *l.qty
			if l.item.Pto == "" {
				workedHours += *l.qty
			}
		}
	}
	r.hours = round4(r.hours)

	// 2-5. additions, deductions, contributions, local taxes
	var adds, deds, contribs, locals []*otherSpec
	for _, o := range collectOthers(e, env.items, in.Lines, opt.keepAll) {
		switch o.line.category {
		case model.CatAddition:
			adds = append(adds, o)
		case model.CatDeduction:
			deds = append(deds, o)
		case model.CatContribution:
			contribs = append(contribs, o)
		default:
			locals = append(locals, o)
		}
	}
	for _, o := range adds {
		computeOther(o, grossWages, workedHours, y, r)
	}
	for _, o := range deds {
		computeOther(o, wagesPaid, workedHours, y, r)
	}
	for _, o := range contribs {
		if o.line.item.Calc == model.CalcMatch {
			computeMatch(o, deds, wagesPaid, y, r)
		} else {
			computeOther(o, wagesPaid, workedHours, y, r)
		}
	}

	// 6. wage bases
	wb := map[string]int64{}
	var fitSupp, sitSupp int64
	add := func(l *cline, sign int64) {
		for _, k := range model.WageBases {
			if l.item.Taxability[k] {
				wb[k] += sign * l.amount
			}
		}
		if sign > 0 && l.item.Supplemental {
			if l.item.Taxability[model.BaseFIT] {
				fitSupp += l.amount
			}
			if l.item.Taxability[model.BaseSIT] {
				sitSupp += l.amount
			}
		}
	}
	for _, l := range earn {
		add(l, 1)
	}
	for _, group := range [][]*otherSpec{adds, contribs} {
		for _, o := range group {
			add(o.line, 1)
		}
	}
	for _, o := range deds {
		add(o.line, -1)
	}
	for _, k := range model.WageBases {
		if wb[k] < 0 {
			wb[k] = 0
		}
	}
	split := func(total, supp int64) (int64, int64) {
		if supp < 0 {
			supp = 0
		}
		if supp > total {
			supp = total
		}
		return total - supp, supp
	}
	// pre-tax deductions reduce the regular part first
	fitReg, fitSupp := split(wb[model.BaseFIT], fitSupp)
	sitReg, sitSupp := split(wb[model.BaseSIT], sitSupp)

	// 7. taxes
	tx := &taxCalc{ctx: ctx, q: q, env: env, in: in, e: e, ty: ty, y: y, r: r, year: year, periods: periods,
		wb: wb, fitReg: fitReg, fitSupp: fitSupp, sitReg: sitReg, sitSupp: sitSupp, workedHours: workedHours}
	tx.manual = map[int64]*model.PaycheckLine{}
	for i := range in.Lines {
		l := &in.Lines[i]
		it := env.items[l.ItemID]
		if it.Type != model.ItemFederalTax && it.Type != model.ItemStateTax {
			continue
		}
		if l.Manual || opt.keepAll {
			if _, ok := tx.manual[l.ItemID]; !ok {
				tx.manual[l.ItemID] = l
			}
		}
	}
	eeTaxes, erTaxes, err := tx.run(locals)
	if err != nil {
		return nil, err
	}

	// assemble in display order
	lineOf := func(list []*otherSpec) []*cline {
		out := make([]*cline, len(list))
		for i, o := range list {
			out[i] = o.line
		}
		return out
	}
	r.lines = append(r.lines, earn...)
	r.lines = append(r.lines, lineOf(adds)...)
	r.lines = append(r.lines, lineOf(deds)...)
	r.lines = append(r.lines, eeTaxes...)
	r.lines = append(r.lines, lineOf(contribs)...)
	r.lines = append(r.lines, erTaxes...)

	// 8. totals
	for _, l := range r.lines {
		switch l.category {
		case model.CatEarning, model.CatAddition:
			r.gross += l.amount
			if l.item.NotPaid {
				r.notPaid += l.amount
			}
		case model.CatDeduction:
			r.ded += l.amount
		case model.CatEmployeeTax:
			r.eeTax += l.amount
		case model.CatEmployerTax:
			r.erTax += l.amount
		case model.CatContribution:
			r.contrib += l.amount
		}
	}
	r.net = r.gross - r.notPaid - r.eeTax - r.ded
	if r.net < 0 {
		r.warn("Net pay is less than zero (%s).", money(r.net))
	}

	// 9. paid time off
	pto, err := computePTO(ctx, q, in, e, earn, workedHours, r)
	if err != nil {
		return nil, err
	}

	r.inputs = map[string]any{
		"payFrequency": e.PayFrequency,
		"payPeriods":   periods,
		"workState":    e.WorkState,
		"employment":   e.EmploymentType,
		"w4":           e.W4,
		"stateW4":      e.StateW4,
		"subject": map[string]bool{"ss": e.SubjectSS, "medicare": e.SubjectMedicare, "futa": e.SubjectFUTA,
			"sui": e.SubjectSUI, "sdi": e.SubjectSDI},
		"taxYear":       ty.Year,
		"tablesVersion": ty.Version,
		"wageBases":     centsMap(wb),
		"warnings":      r.warnings,
	}

	// 10. the paycheck with summaries
	pc := &model.Paycheck{PaycheckInput: *in}
	pc.Lines = nil
	pc.EmployeeName = e.DisplayName
	pc.Gross, pc.NotPaid = store.Dollars(r.gross), store.Dollars(r.notPaid)
	pc.Deductions, pc.EmployeeTaxes = store.Dollars(r.ded), store.Dollars(r.eeTax)
	pc.Net, pc.EmployerTaxes, pc.Contributions = store.Dollars(r.net), store.Dollars(r.erTax), store.Dollars(r.contrib)
	pc.TotalHours = r.hours
	pc.Sick, pc.Vacation = pto[0], pto[1]
	pc.Warnings = append([]string{}, r.warnings...)
	lines := make([]lineRow, len(r.lines))
	for i, l := range r.lines {
		lines[i] = lineRow{cline: *l}
	}
	fillOutput(pc, lines, y)
	r.pc = pc
	return r, nil
}

func centsMap(m map[string]int64) map[string]float64 {
	out := map[string]float64{}
	for k, v := range m {
		out[k] = store.Dollars(v)
	}
	return out
}

func isTaxItem(t string) bool {
	return t == model.ItemFederalTax || t == model.ItemStateTax || t == model.ItemOtherTax
}

// ---------------------------------------------------------------------------
// Step 1: earnings

func employeeItem(list []model.EmployeeItem, itemID int64) *model.EmployeeItem {
	for i := range list {
		if list[i].ItemID == itemID {
			return &list[i]
		}
	}
	return nil
}

func computeEarnings(e *model.Employee, all map[int64]*model.PayrollItem, input []model.PaycheckLine, periods int, keepAll, ytdKind bool, r *calcResult) []*cline {
	var out []*cline
	var salary []*cline // salary lines: the per-period salary S is split over them by hours
	for i := range input {
		in := input[i]
		it := all[in.ItemID]
		if !model.IsWageType(it.Type) {
			continue
		}
		l := &cline{item: it, category: model.CatEarning, job: in.JobNameID, class: in.ClassID, manual: in.Manual}
		if in.Qty != nil {
			l.qty = fptr(*in.Qty)
		}
		ei := employeeItem(e.Earnings, it.ID)
		given := in.Rate != nil && *in.Rate > 0
		hours := 0.0
		if l.qty != nil {
			hours = *l.qty
		}
		// year-to-date entries and lines kept as sent: the amount entered
		keep := l.manual || keepAll || (ytdKind && in.Amount != 0)
		switch it.Type {
		case model.ItemHourly:
			rate := 0.0
			switch {
			case given:
				rate = *in.Rate
			case ei != nil && ei.Rate > 0:
				rate = ei.Rate
			case e.HourlyRate > 0:
				rate = e.HourlyRate // e.g. Sick Hourly not in the employee's list: the regular rate
			default:
				rate = it.Rate
			}
			l.rate = fptr(rate)
			l.computed = centsOf(rate * hours)
		case model.ItemOvertime:
			rate := 0.0
			if given {
				rate = *in.Rate
			} else {
				mult := it.Rate
				if mult <= 0 {
					mult = 1.5
				}
				if e.HourlyRate <= 0 {
					r.warn("%s: %s has no regular hourly rate to compute the overtime rate.", it.Name, e.DisplayName)
				}
				rate = round4(mult * e.HourlyRate)
			}
			l.rate = fptr(rate)
			l.computed = centsOf(rate * hours)
		case model.ItemSalary:
			if ytdKind {
				v := in.Amount
				if v == 0 && in.Rate != nil {
					v = *in.Rate
				}
				l.rate = fptr(v)
				l.computed = store.Cents(v)
			} else {
				salary = append(salary, l)
			}
		case model.ItemCommission:
			if it.Calc == model.CalcQuantity {
				rate := 0.0
				switch {
				case given:
					rate = *in.Rate
				case ei != nil && ei.Rate > 0:
					rate = ei.Rate
				default:
					rate = it.Rate
				}
				l.rate = fptr(rate)
				l.computed = centsOf(rate * hours / 100)
				break
			}
			fallthrough
		default: // bonus, fixed commission, paid tips, reported tips: an amount
			// The amount follows the rate sent (rate = amount); a line sent with
			// rate 0 and no manual flag pays 0, never an amount left over from before.
			v := 0.0
			switch {
			case in.Rate != nil:
				v = *in.Rate
			case in.Amount != 0:
				v = in.Amount
			case ei != nil && ei.Rate != 0:
				v = ei.Rate
			default:
				v = it.Rate
			}
			l.rate = fptr(v)
			l.computed = store.Cents(v)
		}
		if keep {
			l.amount = store.Cents(in.Amount)
			if in.Rate != nil {
				l.rate = fptr(*in.Rate)
			}
			l.manual = in.Manual
		}
		out = append(out, l)
		if !keep && !(it.Type == model.ItemSalary && !ytdKind) {
			l.amount = l.computed
		}
	}

	// salary: S = annual salary / pay periods, split over the salary lines in
	// proportion to their hours (the last line with hours takes the rounding
	// remainder); one line gets S. Manual lines keep their amount.
	if len(salary) > 0 {
		var s int64
		if e.AnnualSalary > 0 {
			s = store.Cents(e.AnnualSalary / float64(periods))
		} else {
			// no salary in the employee setup: the per-period amounts sent
			for i := range input {
				it := all[input[i].ItemID]
				if it.Type == model.ItemSalary && input[i].Rate != nil {
					s += store.Cents(*input[i].Rate)
				}
			}
			if s == 0 {
				r.warn("%s has no annual salary.", e.DisplayName)
			}
		}
		var totalH float64
		lastWithHours := -1
		for i, l := range salary {
			if l.qty != nil && *l.qty > 0 {
				totalH += *l.qty
				lastWithHours = i
			}
		}
		if len(salary) == 1 || totalH <= 0 {
			salary[0].computed = s
		} else {
			var used int64
			for i, l := range salary {
				if i == lastWithHours {
					l.computed = s - used
					continue
				}
				if l.qty != nil && *l.qty > 0 {
					l.computed = int64(math.Round(float64(s) * *l.qty / totalH))
				}
				used += l.computed
			}
		}
		for _, l := range salary {
			if l.manual || keepAll {
				continue // amount (and rate) as sent
			}
			l.amount = l.computed
			l.rate = fptr(store.Dollars(l.amount))
		}
	}

	// drop lines without amount and hours
	kept := out[:0]
	for _, l := range out {
		if l.amount == 0 && (l.qty == nil || *l.qty == 0) {
			continue
		}
		kept = append(kept, l)
	}
	return kept
}

// ---------------------------------------------------------------------------
// Steps 2-5: additions, deductions, contributions (and local tax items)

type otherSpec struct {
	line *cline
	in   *model.PaycheckLine // line sent by the client (nil = from the employee setup)
	emp  *model.EmployeeItem // employee default item (nil = extra line)
	keep bool                // keep the amount sent (manual, or Recalculate off)
}

// rate: the rate sent on the line, else the employee's rate, else the item default.
func (o *otherSpec) rate(it *model.PayrollItem) float64 {
	if o.in != nil && o.in.Rate != nil {
		return *o.in.Rate
	}
	if o.emp != nil && o.emp.Rate != 0 {
		return o.emp.Rate
	}
	return it.Rate
}

func (o *otherSpec) quantity() float64 {
	if o.in != nil && o.in.Qty != nil {
		return *o.in.Qty
	}
	if o.emp != nil && o.emp.Qty != nil {
		return *o.emp.Qty
	}
	return 0
}

// collectOthers merges the employee's default items with the non-wage lines
// sent by the client (same item: the sent line wins; other items: extra lines).
// Tax items other than local (other_tax) items are handled by the tax step.
func collectOthers(e *model.Employee, all map[int64]*model.PayrollItem, input []model.PaycheckLine, keepAll bool) []*otherSpec {
	var out []*otherSpec
	used := map[int]bool{}
	take := func(itemID int64) *model.PaycheckLine {
		for i := range input {
			if !used[i] && input[i].ItemID == itemID {
				used[i] = true
				return &input[i]
			}
		}
		return nil
	}
	mk := func(it *model.PayrollItem, in *model.PaycheckLine, emp *model.EmployeeItem) *otherSpec {
		l := &cline{item: it, category: model.ItemCategory(it.Type, it.TaxCode)}
		o := &otherSpec{line: l, in: in, emp: emp}
		if in != nil {
			l.job, l.class, l.manual = in.JobNameID, in.ClassID, in.Manual
			o.keep = in.Manual || keepAll
		}
		return o
	}
	if !keepAll {
		for i := range e.Items {
			ei := &e.Items[i]
			it := all[ei.ItemID]
			if it == nil || model.IsWageType(it.Type) {
				continue
			}
			if isTaxItem(it.Type) && it.Type != model.ItemOtherTax {
				continue
			}
			out = append(out, mk(it, take(it.ID), ei))
		}
	}
	for i := range input {
		if used[i] {
			continue
		}
		it := all[input[i].ItemID]
		if model.IsWageType(it.Type) || (isTaxItem(it.Type) && it.Type != model.ItemOtherTax) {
			continue
		}
		used[i] = true
		out = append(out, mk(it, &input[i], employeeItem(e.Items, it.ID)))
	}
	return out
}

// computeOther calculates an addition, deduction or company contribution.
func computeOther(o *otherSpec, base int64, hours float64, y *ytdData, r *calcResult) {
	l := o.line
	it := l.item
	rate := o.rate(it)
	l.rate = fptr(rate)
	var amt int64
	switch it.Calc {
	case model.CalcPercent:
		l.wageBase = base
		amt = centsOf(store.Dollars(base) * rate / 100)
	case model.CalcPerHour:
		h := round4(hours)
		l.qty = fptr(h)
		amt = centsOf(rate * h)
	case model.CalcQuantity:
		qty := o.quantity()
		l.qty = fptr(qty)
		amt = centsOf(rate * qty)
	default: // fixed (and anything else): the rate is the amount
		amt = store.Cents(rate)
	}
	if amt < 0 {
		amt = 0
	}
	l.computed = limitAmount(o, amt, y, r)
	if o.keep {
		l.amount = store.Cents(o.in.Amount)
	} else {
		l.amount = l.computed
	}
}

// computeMatch: Rate % of the employee's amount of the matched deduction on
// this check, up to MatchCapPct % of gross wages (no cap when 0).
func computeMatch(o *otherSpec, deds []*otherSpec, wagesPaid int64, y *ytdData, r *calcResult) {
	l := o.line
	it := l.item
	var emp int64
	if it.MatchItemID != nil {
		for _, d := range deds {
			if d.line.item.ID == *it.MatchItemID {
				emp += d.line.amount
			}
		}
	}
	rate := o.rate(it)
	capped := emp
	if it.MatchCapPct > 0 {
		if c := centsOf(store.Dollars(wagesPaid) * it.MatchCapPct / 100); c < capped {
			capped = c
		}
	}
	l.rate = fptr(rate)
	l.wageBase = capped
	l.computed = limitAmount(o, centsOf(store.Dollars(capped)*rate/100), y, r)
	if o.keep {
		l.amount = store.Cents(o.in.Amount)
	} else {
		l.amount = l.computed
	}
}

// limitAmount applies the annual (or one-time) limit of the employee item or
// the payroll item, minus what was deducted before.
func limitAmount(o *otherSpec, amt int64, y *ytdData, r *calcResult) int64 {
	it := o.line.item
	limit := it.AnnualLimit
	if o.emp != nil && o.emp.AnnualLimit != nil {
		limit = o.emp.AnnualLimit
	}
	if limit == nil || amt <= 0 {
		return amt
	}
	prior := y.item[it.ID]
	label := "annual"
	if it.LimitKind == "one_time" {
		prior = y.itemAll[it.ID]
		label = "one-time"
	}
	left := store.Cents(*limit) - prior
	if left < 0 {
		left = 0
	}
	if amt > left {
		if left == 0 {
			r.warn("%s: the %s limit of %s has been reached.", it.Name, label, money(store.Cents(*limit)))
		} else {
			r.warn("%s: limited to %s by the %s limit of %s.", it.Name, money(left), label, money(store.Cents(*limit)))
		}
		return left
	}
	return amt
}

// ---------------------------------------------------------------------------
// Step 7: taxes

type taxCalc struct {
	ctx         context.Context
	q           store.Q
	env         *calcEnv
	in          *model.PaycheckInput
	e           *model.Employee
	ty          *model.TaxYear
	y           *ytdData
	r           *calcResult
	year        int
	periods     int
	wb          map[string]int64
	fitReg      int64
	fitSupp     int64
	sitReg      int64
	sitSupp     int64
	workedHours float64
	manual      map[int64]*model.PaycheckLine
	seen        map[int64]bool
}

// result of one tax: amount, taxable wages after the cap, wages before the cap.
type taxAmt struct {
	amount, wageBase, subject int64
	rate                      *float64
}

// put adds the line of a tax (item found with items.FindTax). A missing item
// gives a warning and no line.
func (t *taxCalc) put(out *[]*cline, code, state, key, label string, v taxAmt) error {
	it, err := items.FindTax(t.ctx, t.q, code, state, key)
	if err != nil {
		return err
	}
	if it == nil {
		t.r.warn("No payroll item for %s; not calculated.", label)
		return nil
	}
	if cached := t.env.items[it.ID]; cached != nil {
		it = cached
	}
	t.seen[it.ID] = true
	l := &cline{item: it, category: model.ItemCategory(it.Type, it.TaxCode), rate: v.rate,
		amount: v.amount, computed: v.amount, wageBase: v.wageBase, subject: v.subject}
	if m := t.manual[it.ID]; m != nil {
		l.amount = store.Cents(m.Amount)
		l.manual = m.Manual
		l.job, l.class = m.JobNameID, m.ClassID
		if t.in.Kind == model.PaycheckYTD && m.Manual && m.WageBase != 0 {
			l.wageBase = store.Cents(m.WageBase)
			l.subject = l.wageBase
			if m.SubjectWages != 0 {
				l.subject = store.Cents(m.SubjectWages)
			}
		}
	}
	*out = append(*out, l)
	return nil
}

// amountOf returns the final amount of a tax line already computed (0 when absent).
func amountOf(lines []*cline, code string) int64 {
	var s int64
	for _, l := range lines {
		if l.item.TaxCode == code {
			s += l.amount
		}
	}
	return s
}

func (t *taxCalc) run(locals []*otherSpec) (ee, er []*cline, err error) {
	t.seen = map[int64]bool{}
	fed := &t.ty.Federal
	e := t.e
	ytdKind := t.in.Kind == model.PaycheckYTD
	var all []*cline

	// federal income tax. Supplemental wages are withheld at the flat rate only
	// when income tax was withheld from the employee's regular wages this year
	// (this check included) or last year; otherwise the aggregate method applies.
	regularFIT := taxes.FederalWithholding(fed, taxes.FITInput{W4: e.W4, PayPeriods: t.periods, Wages: t.fitReg})
	aggregate := false
	if t.fitSupp > 0 && regularFIT <= 0 && !ytdKind && e.EmploymentType != "statutory" {
		withheld, err := fitWithheldOnRegular(t.ctx, t.q, t.env.items, e.ID, t.in.CheckDate, t.in.ID, fed.SupplementalRate)
		if err != nil {
			return nil, nil, err
		}
		aggregate = !withheld
	}
	fit := taxes.FederalWithholding(fed, taxes.FITInput{W4: e.W4, PayPeriods: t.periods, Wages: t.fitReg,
		Supplemental: t.fitSupp, YTDSupplemental: t.y.suppFIT, NoRegularWithholding: aggregate})
	if aggregate && !e.W4.Exempt {
		t.r.warn("Federal Withholding: no federal income tax was withheld from regular wages this year or last year, so the supplemental wages were withheld with the aggregate method instead of the flat rate.")
	}
	switch {
	case e.EmploymentType == "statutory":
		fit, regularFIT = 0, 0
		t.r.warn("Federal Withholding: statutory employee, no federal income tax is withheld.")
	case e.W4.Exempt:
		t.r.warn("Federal Withholding: employee is exempt.")
	}
	if ytdKind {
		fit, regularFIT = 0, 0
	}
	fitWages := t.fitReg + t.fitSupp
	if err := t.put(&all, model.TaxFIT, "", "", model.TaxCodeLabels[model.TaxFIT], taxAmt{amount: fit, wageBase: fitWages, subject: fitWages}); err != nil {
		return nil, nil, err
	}

	// social security and Medicare
	if e.SubjectSS {
		w := t.wb[model.BaseSS]
		for _, code := range []string{model.TaxSSEE, model.TaxSSER} {
			taxable, tax := taxes.SocialSecurity(fed, w, t.y.base[ytdKey(code, "", "")])
			if err := t.put(&all, code, "", "", model.TaxCodeLabels[code], taxAmt{tax, taxable, w, fptr(fed.SSRate)}); err != nil {
				return nil, nil, err
			}
		}
	}
	if e.SubjectMedicare {
		w := t.wb[model.BaseMED]
		for _, code := range []string{model.TaxMedEE, model.TaxMedER} {
			taxable, tax := taxes.Medicare(fed, w)
			if err := t.put(&all, code, "", "", model.TaxCodeLabels[code], taxAmt{tax, taxable, w, fptr(fed.MedicareRate)}); err != nil {
				return nil, nil, err
			}
		}
		ytdMed := t.y.subj[ytdKey(model.TaxAddlMed, "", "")]
		if v := t.y.base[ytdKey(model.TaxMedEE, "", "")]; v > ytdMed {
			ytdMed = v
		}
		taxable, tax := taxes.AdditionalMedicare(fed, w, ytdMed)
		if err := t.put(&all, model.TaxAddlMed, "", "", model.TaxCodeLabels[model.TaxAddlMed], taxAmt{tax, taxable, w, fptr(fed.AddlMedicareRate)}); err != nil {
			return nil, nil, err
		}
	}
	if e.SubjectFUTA {
		w := t.wb[model.BaseFUTA]
		taxable, tax := taxes.FUTA(fed, w, t.y.base[ytdKey(model.TaxFUTA, "", "")])
		if err := t.put(&all, model.TaxFUTA, "", "", model.TaxCodeLabels[model.TaxFUTA], taxAmt{tax, taxable, w, fptr(fed.FUTARate)}); err != nil {
			return nil, nil, err
		}
	}

	// state taxes of the work state
	state := strings.ToUpper(strings.TrimSpace(e.WorkState))
	st, ok := t.ty.States[state]
	switch {
	case state == "":
		t.r.warn("%s has no work state; state taxes were not calculated.", e.DisplayName)
	case !ok:
		t.r.warn("SerieX Payroll has no %s tax tables; state taxes were not calculated.", state)
	default:
		if err := t.stateTaxes(&all, &st, state, regularFIT, ytdKind); err != nil {
			return nil, nil, err
		}
	}

	// local and other taxes (the employee's other_tax items and extra lines)
	for _, o := range locals {
		l := o.line
		it := l.item
		t.seen[it.ID] = true
		rate := o.rate(it)
		l.rate = fptr(rate)
		w := t.wb[model.BaseLOCAL]
		var amt int64
		switch it.Calc {
		case model.CalcFixed:
			amt = store.Cents(rate)
		case model.CalcPerHour:
			h := round4(t.workedHours)
			l.qty = fptr(h)
			amt = centsOf(rate * h)
		case model.CalcQuantity:
			qty := o.quantity()
			l.qty = fptr(qty)
			amt = centsOf(rate * qty)
		default: // percent of LOCAL wages
			taxable, tax := taxes.CappedTax(rate, nil, w, 0)
			l.wageBase, l.subject = taxable, w
			amt = tax
		}
		if amt < 0 {
			amt = 0
		}
		l.computed = limitAmount(o, amt, t.y, t.r)
		if o.keep {
			l.amount = store.Cents(o.in.Amount)
		} else {
			l.amount = l.computed
		}
		all = append(all, l)
	}

	// manual tax lines for taxes that do not apply (e.g. year-to-date amounts of another state)
	var extra []int64
	for id := range t.manual {
		if !t.seen[id] {
			extra = append(extra, id)
		}
	}
	sort.Slice(extra, func(i, j int) bool { return extra[i] < extra[j] })
	for _, id := range extra {
		m := t.manual[id]
		it := t.env.items[id]
		l := &cline{item: it, category: model.ItemCategory(it.Type, it.TaxCode), amount: store.Cents(m.Amount), manual: m.Manual,
			wageBase: store.Cents(m.WageBase), subject: store.Cents(m.SubjectWages), rate: m.Rate, job: m.JobNameID, class: m.ClassID}
		if l.subject == 0 {
			l.subject = l.wageBase
		}
		all = append(all, l)
	}

	for _, l := range all {
		if l.category == model.CatEmployerTax {
			er = append(er, l)
		} else {
			ee = append(ee, l)
		}
	}
	return ee, er, nil
}

func (t *taxCalc) stateTaxes(all *[]*cline, st *model.StateTax, state string, regularFIT int64, ytdKind bool) error {
	e := t.e
	// state income tax withholding
	if st.Income.Has {
		fica := amountOf(*all, model.TaxSSEE) + amountOf(*all, model.TaxMedEE) + amountOf(*all, model.TaxAddlMed)
		ytdFica := t.y.amt[ytdKey(model.TaxSSEE, "", "")] + t.y.amt[ytdKey(model.TaxMedEE, "", "")] + t.y.amt[ytdKey(model.TaxAddlMed, "", "")]
		sit, warns := taxes.StateWithholding(st, taxes.SITInput{PayPeriods: t.periods, Wages: t.sitReg, Supplemental: t.sitSupp,
			YTDWages: t.y.base[ytdKey(model.TaxSIT, state, "")], W4: e.StateW4, FedW4: e.W4, FedWithholding: regularFIT,
			FICA: fica, YTDFICA: ytdFica})
		for _, w := range warns {
			t.r.warn("%s", w)
		}
		if e.StateW4.Exempt {
			t.r.warn("%s Withholding: employee is exempt.", state)
		}
		if ytdKind {
			sit = 0
		}
		w := t.sitReg + t.sitSupp
		if err := t.put(all, model.TaxSIT, state, "", state+" - Withholding", taxAmt{amount: sit, wageBase: w, subject: w}); err != nil {
			return err
		}
	}
	// state unemployment
	w := t.wb[model.BaseSUI]
	if e.SubjectSUI {
		rate := 0.0
		if it, _ := items.FindTax(t.ctx, t.q, model.TaxSUIER, state, ""); it != nil && it.Rate > 0 {
			rate = it.Rate
		} else {
			rate = taxes.SUIRate(t.ctx, t.q, st, t.year)
		}
		base := st.SUI.WageBase
		var cap *float64
		if base > 0 {
			cap = &base
		}
		taxable, tax := taxes.CappedTax(rate, cap, w, t.y.base[ytdKey(model.TaxSUIER, state, "")])
		if err := t.put(all, model.TaxSUIER, state, "", state+" - Unemployment (company)", taxAmt{tax, taxable, w, fptr(rate)}); err != nil {
			return err
		}
		if st.SUI.EmployeeRate > 0 {
			eb := st.SUI.EmployeeWageBase
			if eb == nil && base > 0 {
				eb = &base
			}
			taxable, tax := taxes.CappedTax(st.SUI.EmployeeRate, eb, w, t.y.base[ytdKey(model.TaxSUIEE, state, "")])
			if err := t.put(all, model.TaxSUIEE, state, "", state+" - Unemployment (employee)", taxAmt{tax, taxable, w, fptr(st.SUI.EmployeeRate)}); err != nil {
				return err
			}
		}
	}
	// other state programs (disability, family leave, training taxes...): the
	// employee programs follow "subject to SDI" on SDI wages, the company
	// programs (CA ETT, NJ workforce / disability, HI E&T...) follow "subject to
	// SUI" on SUI wages, like the state unemployment tax they are collected with
	ws := t.wb[model.BaseSDI]
	for _, p := range st.Programs {
		label := fmt.Sprintf("%s - %s", state, p.Name)
		eeRate := taxes.ProgramRate(t.ctx, t.q, st, t.year, p.Key, false)
		if e.SubjectSDI && (p.EmployeeRate > 0 || eeRate > 0) {
			if it, _ := items.FindTax(t.ctx, t.q, model.TaxStateEE, state, p.Key); it != nil && it.Rate > 0 {
				eeRate = it.Rate
			}
			key := ytdKey(model.TaxStateEE, state, p.Key)
			taxable, tax := taxes.CappedTax(eeRate, p.WageBase, ws, t.y.base[key])
			if p.MaxEmployeePerWeek != nil && tax > 0 {
				// weekly cap (NY DBL, HI TDI) times the weeks of the pay period
				if limit := store.Cents(*p.MaxEmployeePerWeek * weeksPerPeriod(e.PayFrequency, t.periods)); tax > limit {
					tax = limit
				}
			}
			if p.MaxEmployee != nil {
				left := store.Cents(*p.MaxEmployee) - t.y.amt[key]
				if left < 0 {
					left = 0
				}
				if tax > left {
					tax = left
				}
			}
			if err := t.put(all, model.TaxStateEE, state, p.Key, label+" (employee)", taxAmt{tax, taxable, ws, fptr(eeRate)}); err != nil {
				return err
			}
		}
		erRate := taxes.ProgramRate(t.ctx, t.q, st, t.year, p.Key, true)
		if e.SubjectSUI && (p.EmployerRate > 0 || erRate > 0) {
			if it, _ := items.FindTax(t.ctx, t.q, model.TaxStateER, state, p.Key); it != nil && it.Rate > 0 {
				erRate = it.Rate
			}
			taxable, tax := taxes.CappedTax(erRate, p.WageBase, w, t.y.base[ytdKey(model.TaxStateER, state, p.Key)])
			if err := t.put(all, model.TaxStateER, state, p.Key, label+" (company)", taxAmt{tax, taxable, w, fptr(erRate)}); err != nil {
				return err
			}
		}
	}
	return nil
}

// weeksPerPeriod is the number of weeks a pay period covers (weekly 1,
// biweekly 2, semimonthly 52/24, monthly 52/12, quarterly 13, daily 1/5).
func weeksPerPeriod(freq string, periods int) float64 {
	switch freq {
	case model.FreqWeekly:
		return 1
	case model.FreqBiweekly:
		return 2
	case model.FreqDaily:
		return 0.2
	}
	if periods <= 0 {
		return 2
	}
	return 52 / float64(periods)
}

// fitWithheldOnRegular reports whether federal income tax was withheld from
// the employee's regular (not supplemental) wages on a paycheck dated in the
// previous or the current calendar year before this check: its FIT amount is
// more than the flat-rate tax on its supplemental wages and it paid regular
// FIT wages.
func fitWithheldOnRegular(ctx context.Context, q store.Q, all map[int64]*model.PayrollItem, employeeID int64, checkDate string, paycheckID int64, suppRate float64) (bool, error) {
	from := fmt.Sprintf("%04d-01-01", store.Year(checkDate)-1)
	rows, err := q.QueryContext(ctx, `SELECT l.paycheck_id, l.item_id, l.category, l.amount, l.wage_base
		FROM paycheck_lines l JOIN paychecks p ON p.id = l.paycheck_id
		WHERE p.employee_id = ? AND p.voided = 0 AND p.id <> ? AND p.check_date >= ?
		AND (p.check_date < ? OR (p.check_date = ? AND (? = 0 OR p.id < ?)))`,
		employeeID, paycheckID, from, checkDate, checkDate, paycheckID, paycheckID)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	type agg struct{ fit, fitWages, supp int64 }
	per := map[int64]*agg{}
	for rows.Next() {
		var pid, itemID, amount, wb int64
		var cat string
		if err := rows.Scan(&pid, &itemID, &cat, &amount, &wb); err != nil {
			return false, err
		}
		it := all[itemID]
		if it == nil {
			continue
		}
		a := per[pid]
		if a == nil {
			a = &agg{}
			per[pid] = a
		}
		switch {
		case it.TaxCode == model.TaxFIT:
			a.fit += amount
			a.fitWages += wb
		case it.Supplemental && it.Taxability[model.BaseFIT] && (cat == model.CatEarning || cat == model.CatAddition || cat == model.CatContribution):
			a.supp += amount
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	for _, a := range per {
		flat := centsOf(store.Dollars(a.supp) * suppRate / 100)
		if a.fitWages-a.supp > 0 && a.fit > flat {
			return true, nil
		}
	}
	return false, nil
}

// ---------------------------------------------------------------------------
// Step 9: paid time off

func computePTO(ctx context.Context, q store.Q, in *model.PaycheckInput, e *model.Employee, earn []*cline, worked float64, r *calcResult) ([2]model.PTOSnapshot, error) {
	var out [2]model.PTOSnapshot
	for i, kind := range []string{"sick", "vacation"} {
		set := e.Sick
		if kind == "vacation" {
			set = e.Vacation
		}
		before, _, _, err := employees.PTOBalance(ctx, q, e.ID, kind, in.CheckDate, in.ID)
		if err != nil {
			return out, err
		}
		var used, acc float64
		if in.Kind != model.PaycheckYTD {
			for _, l := range earn {
				if l.item.Pto == kind && l.qty != nil {
					used += *l.qty
				}
			}
			begin := set.BeginAccruingDate
			if begin == "" {
				begin = e.HireDate
			}
			if !in.NoAccrual && (begin == "" || in.CheckDate >= begin) {
				switch set.Accrual {
				case model.AccruePerPaycheck:
					acc = set.Hours
				case model.AccruePerHour:
					if set.PerHoursWorked > 0 {
						acc = set.Hours * worked / set.PerHoursWorked
					}
				}
			}
		}
		used, acc = round4(used), round4(acc)
		after := before + acc - used
		if set.MaxHours != nil && after > *set.MaxHours {
			after = *set.MaxHours
			acc = math.Max(0, round4(after-before+used))
		}
		if used > 0 && used > round4(before+acc)+1e-9 {
			r.warn("%s hours used (%.2f) are more than the hours available (%.2f).", strings.ToUpper(kind[:1])+kind[1:], used, before+acc)
		}
		out[i] = model.PTOSnapshot{AvailableBefore: round4(before), Accrued: acc, Used: used, AvailableAfter: round4(after)}
		if kind == "sick" {
			r.sickAcc, r.sickUsed = acc, used
		} else {
			r.vacAcc, r.vacUsed = acc, used
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Output: lines, line YTD and the employee / company summaries

// lineRow is a paycheck line as stored or calculated.
type lineRow struct {
	cline
	id int64
}

var summaryOrder = map[string]int{
	model.CatEarning: 0, model.CatAddition: 1, model.CatDeduction: 2, model.CatEmployeeTax: 3,
	model.CatEmployerTax: 4, model.CatContribution: 5,
}

func typeRank(t string) int {
	for i, x := range model.ItemTypeOrder {
		if x == t {
			return i
		}
	}
	return len(model.ItemTypeOrder)
}

// fillOutput sets pc.Lines, the line YTD values and the summaries.
func fillOutput(pc *model.Paycheck, rows []lineRow, y *ytdData) {
	this := map[int64]int64{}
	for _, l := range rows {
		this[l.item.ID] += l.amount
	}
	pc.Lines = make([]model.PaycheckLine, 0, len(rows))
	for _, l := range rows {
		pl := model.PaycheckLine{
			ID: l.id, ItemID: l.item.ID, Rate: l.rate, Qty: l.qty, Amount: store.Dollars(l.amount),
			WageBase: store.Dollars(l.wageBase), SubjectWages: store.Dollars(l.subject), Computed: store.Dollars(l.computed),
			JobNameID: l.job, ClassID: l.class, Manual: l.manual,
			ItemName: l.item.Name, ItemType: l.item.Type, Category: l.category, TaxCode: l.item.TaxCode, Pto: l.item.Pto,
			YTD: store.Dollars(y.item[l.item.ID] + this[l.item.ID]),
		}
		pc.Lines = append(pc.Lines, pl)
	}

	type row struct {
		id    int64
		name  string
		typ   string
		cat   string
		amt   int64
		order int
	}
	var list []*row
	seen := map[int64]*row{}
	for i, l := range rows {
		if r := seen[l.item.ID]; r != nil {
			r.amt += l.amount
			continue
		}
		r := &row{id: l.item.ID, name: l.item.Name, typ: l.item.Type, cat: l.category, amt: l.amount, order: i}
		seen[l.item.ID] = r
		list = append(list, r)
	}
	n := len(rows)
	var extra []*row
	for id, v := range y.item {
		if seen[id] != nil || v == 0 {
			continue
		}
		info := y.info[id]
		if info == nil {
			continue
		}
		extra = append(extra, &row{id: id, name: info.Name, typ: info.Type, cat: y.cat[id]})
	}
	sort.Slice(extra, func(i, j int) bool {
		a, b := extra[i], extra[j]
		if ra, rb := typeRank(a.typ), typeRank(b.typ); ra != rb {
			return ra < rb
		}
		return strings.ToLower(a.name) < strings.ToLower(b.name)
	})
	for i, r := range extra {
		r.order = n + i
		list = append(list, r)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if summaryOrder[a.cat] != summaryOrder[b.cat] {
			return summaryOrder[a.cat] < summaryOrder[b.cat]
		}
		return a.order < b.order
	})
	pc.EmployeeSummary, pc.CompanySummary = []model.SummaryRow{}, []model.SummaryRow{}
	for _, r := range list {
		sr := model.SummaryRow{ItemID: r.id, ItemName: r.name, Category: r.cat, Amount: store.Dollars(r.amt), YTD: store.Dollars(y.item[r.id] + r.amt)}
		switch r.cat {
		case model.CatEmployerTax, model.CatContribution:
			pc.CompanySummary = append(pc.CompanySummary, sr)
		case model.CatEarning, model.CatAddition, model.CatDeduction, model.CatEmployeeTax:
			pc.EmployeeSummary = append(pc.EmployeeSummary, sr)
		}
	}
}

// money formats cents as 1,234.56 for messages.
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
