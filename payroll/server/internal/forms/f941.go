package forms

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// Form 941 for 2026 (Rev. March 2026): line numbers and labels of the 2026
// revision (lines 11 and 13 are single lines since 2024; 15a-15e direct
// deposit of a refund are new for 2026).

var twelfthLabel = "Number of employees who received wages, tips, or other compensation for the pay period including: Mar. 12 (Quarter 1), June 12 (Quarter 2), Sept. 12 (Quarter 3), or Dec. 12 (Quarter 4)"

// form941 computes Form 941 for a quarter. data = nil uses the saved values.
func form941(ctx context.Context, q store.Q, year, quarter int, data *formData) (*model.TaxForm, error) {
	return compute941(ctx, q, year, quarter, data, true)
}

// priorLine12 returns line 12 of the Form 941 of the quarter before (with its
// saved values); ok = false when no wages were paid in that quarter (no return).
func priorLine12(ctx context.Context, q store.Q, year, quarter int) (int64, bool, error) {
	py, pq := year, quarter-1
	if pq == 0 {
		py, pq = year-1, 4
	}
	pf, pt := store.QuarterRange(py, pq)
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM paychecks WHERE voided = 0 AND gross <> 0 AND check_date >= ? AND check_date <= ?`,
		pf, pt).Scan(&n); err != nil {
		return 0, false, err
	}
	if n == 0 {
		return 0, false, nil
	}
	f, err := compute941(ctx, q, py, pq, nil, false)
	if err != nil {
		return 0, false, err
	}
	for _, l := range f.Lines {
		if l.Key == "12" && l.Col == "" {
			return store.Cents(l.Value), true, nil
		}
	}
	return 0, false, nil
}

// compute941 is form941; checkPrior looks at the prior quarter's line 12 for
// the line 16 de minimis box (false while computing that prior quarter).
func compute941(ctx context.Context, q store.Q, year, quarter int, data *formData, checkPrior bool) (*model.TaxForm, error) {
	from, to := store.QuarterRange(year, quarter)
	period := fmt.Sprintf("Q%d", quarter)
	f, err := loadFiling(ctx, q, "941", year, period, "")
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = emptyData()
		if f != nil {
			data = &f.data
		}
	}
	co, err := loadCompany(ctx, q)
	if err != nil {
		return nil, err
	}
	ty, tyWarn, err := taxes.ForCompany(ctx, q, year)
	if err != nil {
		return nil, err
	}
	fed := &ty.Federal
	ds, err := loadData(ctx, q, from, to)
	if err != nil {
		return nil, err
	}
	form := &model.TaxForm{Form: "941", Year: year, Period: period, Title: fmt.Sprintf("Form 941 for %d: Employer's Quarterly Federal Tax Return (Quarter %d)", year, quarter),
		Company: co.FormCompany, Warnings: []string{}, Extra: map[string]any{}}
	if tyWarn != "" {
		form.Warnings = append(form.Warnings, tyWarn)
	}
	if store.Digits(co.EIN) == "" {
		form.Warnings = append(form.Warnings, "The company has no employer identification number (EIN). Enter it in Company Payroll Information.")
	}

	// totals of the quarter
	var wages, fit, ssWages, ssTips, medWages, addlWages, fica, companyFIT int64
	var ssEE, ssER, medEE, medER, addl int64
	var months [3]int64
	daily := map[string]int64{}
	for _, c := range ds.checks {
		emp := c.employeeID != 0
		var liab int64
		for _, l := range c.lines {
			switch l.item.TaxCode {
			case model.TaxFIT:
				if !emp {
					companyFIT += l.amount // not withheld from anybody: not on line 3
					continue
				}
				wages += l.wageBase
				fit += l.amount
				liab += l.amount
			case model.TaxSSEE:
				ssEE += l.amount
			case model.TaxSSER:
				ssER += l.amount
			case model.TaxMedEE:
				medEE += l.amount
			case model.TaxMedER:
				medER += l.amount
			case model.TaxAddlMed:
				addl += l.amount
			default:
				continue
			}
			if l.item.TaxCode != model.TaxFIT {
				fica += l.amount
				liab += l.amount
			}
		}
		if emp {
			wages += c.imputedIncome()
			tips := c.ssTips()
			ssWages += c.base(model.TaxSSEE, model.TaxSSER) - tips
			ssTips += tips
			medWages += c.base(model.TaxMedEE, model.TaxMedER)
			_, wb, _, _ := c.taxSum(model.TaxAddlMed)
			addlWages += wb
		}
		if m := monthOf(c.date) - (quarter-1)*3 - 1; m >= 0 && m < 3 {
			months[m] += liab
		}
		daily[c.date] += liab
	}
	if companyFIT != 0 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Company tax balance adjustments of Federal Withholding (%s) are not on line 3 because no employee's withholding changed; adjust an employee instead.", money(companyFIT)))
	}

	// line 1: employees paid for the pay period including the 12th of the last month
	twelfth := fmt.Sprintf("%04d-%02d-12", year, quarter*3)
	var employees int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(DISTINCT employee_id) FROM paychecks
		WHERE voided = 0 AND gross <> 0 AND period_start <= ? AND period_end >= ?`, twelfth, twelfth).Scan(&employees); err != nil {
		return nil, err
	}
	deposits, err := paymentsByGroup(ctx, q, ds.items, from, to, model.GroupFederal941)
	if err != nil {
		return nil, err
	}

	ssRate := 2 * fed.SSRate         // 12.4
	medRate := 2 * fed.MedicareRate  // 2.9
	addlRate := fed.AddlMedicareRate // 0.9
	peek := func(key string) int64 {
		if v, ok := data.Overrides[key]; ok {
			return store.Cents(v)
		}
		return 0
	}

	b := newBuilder(data)
	b.section = "Header"
	b.check("agg", "3504", "Aggregate Return Filers Only: Section 3504 Agent", false, true)
	b.check("agg", "cpeo", "Aggregate Return Filers Only: Certified Professional Employer Organization (CPEO)", false, true)
	b.check("agg", "other", "Aggregate Return Filers Only: Other Third Party", false, true)

	b.section = "Part 1"
	b.count("1", "", twelfthLabel, employees, true)
	b.money("2", "", "Wages, tips, and other compensation", wages, true)
	l3 := b.money("3", "", "Federal income tax withheld from wages, tips, and other compensation", fit, true)
	eff := func(key string, computed int64) int64 {
		if v, ok := data.Overrides[key]; ok {
			return store.Cents(v)
		}
		return computed
	}
	noFica := eff("5a:1", ssWages) == 0 && eff("5b:1", ssTips) == 0 && eff("5c:1", medWages) == 0 && eff("5d:1", addlWages) == 0
	b.check("4", "", "If no wages, tips, and other compensation are subject to social security or Medicare tax, check and go to line 6.", noFica, true)
	a1 := b.money("5a", "1", "Taxable social security wages (Column 1)", ssWages, true)
	a2 := b.money("5a", "2", fmt.Sprintf("Taxable social security wages (Column 2 = Column 1 × %s)", rateText(ssRate)), pctOf(a1, ssRate), false)
	t1 := b.money("5b", "1", "Taxable social security tips (Column 1)", ssTips, true)
	t2 := b.money("5b", "2", fmt.Sprintf("Taxable social security tips (Column 2 = Column 1 × %s)", rateText(ssRate)), pctOf(t1, ssRate), false)
	c1 := b.money("5c", "1", "Taxable Medicare wages & tips (Column 1)", medWages, true)
	c2 := b.money("5c", "2", fmt.Sprintf("Taxable Medicare wages & tips (Column 2 = Column 1 × %s)", rateText(medRate)), pctOf(c1, medRate), false)
	d1 := b.money("5d", "1", "Taxable wages & tips subject to Additional Medicare Tax withholding (Column 1)", addlWages, true)
	d2 := b.money("5d", "2", fmt.Sprintf("Taxable wages & tips subject to Additional Medicare Tax withholding (Column 2 = Column 1 × %s)", rateText(addlRate)), pctOf(d1, addlRate), false)
	l5e := b.money("5e", "", "Total social security and Medicare taxes. Add Column 2 from lines 5a, 5b, 5c, and 5d", a2+t2+c2+d2, false)
	l5f := b.money("5f", "", "Section 3121(q) Notice and Demand—Tax due on unreported tips", 0, true)
	l6 := b.money("6", "", "Total taxes before adjustments. Add lines 3, 5e, and 5f", l3+l5e+l5f, false)
	// line 7: social security and Medicare actually withheld and owed by the
	// company (rounded per paycheck) minus the quarterly computation of 5e;
	// amounts the user reports on lines 8 and 9 are already in the actual taxes.
	l7 := b.money("7", "", "Current quarter's adjustment for fractions of cents", fica-l5e-peek("8")-peek("9"), true)
	l8 := b.money("8", "", "Current quarter's adjustment for sick pay", 0, true)
	l9 := b.money("9", "", "Current quarter's adjustments for tips and group-term life insurance", 0, true)
	l10 := b.money("10", "", "Total taxes after adjustments. Combine lines 6 through 9", l6+l7+l8+l9, false)
	l11 := b.money("11", "", "Qualified small business payroll tax credit for increasing research activities. Attach Form 8974", 0, true)
	l12c := l10 - l11
	if l12c < 0 {
		l12c = 0
	}
	l12 := b.money("12", "", "Total taxes after adjustments and nonrefundable credits. Subtract line 11 from line 10", l12c, false)
	l13 := b.money("13", "", "Total deposits for this quarter, including overpayment applied from a prior quarter and overpayments applied from Form 941-X, 941-X (PR), or 944-X filed in the current quarter", deposits, true)
	var due, over int64
	if l12 > l13 {
		due = l12 - l13
	} else {
		over = l13 - l12
	}
	b.money("14", "", "Balance due. If line 12 is more than line 13, enter the difference and see instructions", due, false)
	b.money("15a", "", "Overpayment. If line 13 is more than line 12, enter the difference", over, false)
	b.check("15b", "1", "Check one: Apply to next return.", false, true)
	b.check("15b", "2", "Check one: Send a refund.", false, true)
	b.text("15c", "", "Routing number (direct deposit of the refund)", "", true)
	b.text("15d", "", "Type: Checking or Savings", "", true)
	b.text("15e", "", "Account number", "", true)

	// Part 2: deposit schedule and tax liability
	b.section = "Part 2"
	schedule := strings.ToLower(co.depositSchedule)
	if schedule != model.PayFreqSemiweekly {
		schedule = model.PayFreqMonthly
	}
	// $100,000 next-day deposit rule: a monthly schedule depositor whose
	// liability accumulated in a month reaches $100,000 becomes a semiweekly
	// schedule depositor from the next day for the rest of that year and all
	// of the next one (IRS Publication 15, next-day deposit rule)
	nextDay := ""
	if schedule == model.PayFreqMonthly {
		if nextDay, err = nextDayTrigger(ctx, q, fmt.Sprintf("%04d-01-01", year-1), to, false); err != nil {
			return nil, err
		}
	}
	nextDayInQuarter := nextDay != "" && nextDay >= from
	if nextDay == "" && schedule == model.PayFreqSemiweekly {
		// a semiweekly depositor's next-day deposits only matter for box 1
		sw, err := nextDayTrigger(ctx, q, from, to, true)
		if err != nil {
			return nil, err
		}
		if sw != "" {
			nextDayInQuarter = true
			form.Extra["nextDayDeposit"] = sw
			form.Warnings = append(form.Warnings, fmt.Sprintf("On %s the federal tax liability of the semiweekly deposit period reached $100,000: it had to be deposited by the next business day.", mdy(sw)))
		}
	}
	if nextDay != "" {
		schedule = model.PayFreqSemiweekly
		form.Extra["nextDayDeposit"] = nextDay
		if nextDayInQuarter {
			form.Warnings = append(form.Warnings, fmt.Sprintf("On %s the federal tax liability accumulated in the month reached $100,000: it had to be deposited by the next business day and you became a semiweekly schedule depositor for the rest of %d and all of %d. Check line 16 box 3 and complete Schedule B; change the federal deposit schedule in Company Payroll Information.",
				mdy(nextDay), store.Year(nextDay), store.Year(nextDay)+1))
		} else {
			form.Warnings = append(form.Warnings, fmt.Sprintf("You became a semiweekly schedule depositor after the $100,000 next-day deposit of %s: check line 16 box 3 and complete Schedule B; change the federal deposit schedule in Company Payroll Information.",
				mdy(nextDay)))
		}
	}
	// de minimis: line 12 of this quarter or of the prior quarter's return
	// under $2,500, and no $100,000 next-day deposit obligation this quarter
	priorSmall := false
	if checkPrior && l12 >= 250000 && !nextDayInQuarter {
		p12, filed, err := priorLine12(ctx, q, year, quarter)
		if err != nil {
			return nil, err
		}
		priorSmall = filed && p12 < 250000
	}
	small := (l12 < 250000 || priorSmall) && !nextDayInQuarter
	box1 := b.check("16", "1", "Line 12 on this return is less than $2,500 or line 12 on the return for the prior quarter was less than $2,500, and you didn't incur a $100,000 next-day deposit obligation during the current quarter. Go to Part 3.", small, true)
	box2 := b.check("16", "2", "You were a monthly schedule depositor for the entire quarter. Enter your tax liability for each month and total liability for the quarter, then go to Part 3.", !small && schedule == model.PayFreqMonthly, true)
	box3 := b.check("16", "3", "You were a semiweekly schedule depositor for any part of this quarter. Complete Schedule B (Form 941), Report of Tax Liability for Semiweekly Schedule Depositors, and attach it to Form 941.", !small && schedule == model.PayFreqSemiweekly, true)
	if (box1 && box2) || (box1 && box3) || (box2 && box3) {
		form.Warnings = append(form.Warnings, "Line 16: check only one box.")
	}
	// liabilities by month of the check date; the adjustments that are not
	// in the paychecks (5f, overrides, line 11 credit) bring them to line 12
	liab := months
	spread(liab[:], l12-(liab[0]+liab[1]+liab[2]))
	// box 1 through the prior quarter with line 12 of $100,000 or more: the
	// liability record is still required (monthly schedule or Schedule B)
	record := box1 && l12 >= 10_000_000
	if record {
		form.Warnings = append(form.Warnings, "Line 16: line 12 is $100,000 or more although the prior quarter qualifies for box 1; enter the tax liability by month (monthly schedule depositor) or attach Schedule B (semiweekly schedule depositor).")
	}
	months16 := box2 || (record && schedule == model.PayFreqMonthly)
	var cm [3]int64
	if months16 {
		cm = liab
	}
	m1 := b.money("16", "m1", "Tax liability: Month 1", cm[0], months16)
	m2 := b.money("16", "m2", "Tax liability: Month 2", cm[1], months16)
	m3 := b.money("16", "m3", "Tax liability: Month 3", cm[2], months16)
	total := b.money("16", "total", "Total liability for quarter (must equal line 12)", m1+m2+m3, false)
	if months16 && total != l12 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Line 16: the total liability for the quarter (%s) must equal line 12 (%s).", money(total), money(l12)))
	}
	form.Extra["depositSchedule"] = schedule
	form.Extra["monthlyLiability"] = []float64{store.Dollars(liab[0]), store.Dollars(liab[1]), store.Dollars(liab[2])}
	form.Extra["actualTaxes"] = map[string]float64{
		"federalIncomeTax": store.Dollars(fit), "socialSecurityEmployee": store.Dollars(ssEE), "socialSecurityCompany": store.Dollars(ssER),
		"medicareEmployee": store.Dollars(medEE), "medicareCompany": store.Dollars(medER), "additionalMedicare": store.Dollars(addl),
	}
	if schedule == model.PayFreqSemiweekly || box3 {
		days := make([]string, 0, len(daily))
		for d := range daily {
			days = append(days, d)
		}
		sort.Strings(days)
		vals := make([]int64, len(days))
		var sum int64
		for i, d := range days {
			vals[i] = daily[d]
			sum += vals[i]
		}
		spread(vals, l12-sum)
		var sb []map[string]any
		var bm [3]int64
		for i, d := range days {
			m := monthOf(d) - (quarter-1)*3 - 1
			if m < 0 || m > 2 || vals[i] == 0 {
				continue
			}
			bm[m] += vals[i]
			sb = append(sb, map[string]any{"date": d, "month": m + 1, "day": dayOf(d), "amount": store.Dollars(vals[i])})
		}
		if sb == nil {
			sb = []map[string]any{}
		}
		form.Extra["scheduleB"] = sb
		form.Extra["scheduleBMonths"] = []float64{store.Dollars(bm[0]), store.Dollars(bm[1]), store.Dollars(bm[2])}
		form.Extra["scheduleBTotal"] = store.Dollars(bm[0] + bm[1] + bm[2])
		form.Extra["scheduleBRequired"] = box3 || (record && schedule == model.PayFreqSemiweekly)
	}
	if abs(l7) >= 100 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Line 7 (fractions of cents) is %s; it is normally a few cents. Check social security and Medicare amounts typed on paychecks.", money(l7)))
	}

	b.section = "Part 3"
	b.check("17", "", "If your business has closed or you stopped paying wages, check here, and enter the final date you paid wages; also attach a statement to your return.", false, true)
	b.text("17", "date", "Final date you paid wages", "", true)
	b.check("18", "", "If you're a seasonal employer and you don't have to file a return for every quarter of the year, check here.", false, true)

	b.section = "Part 4"
	designeeParts(b)
	b.section = "Part 5"
	signerParts(b, co)

	form.Lines = b.lines
	form.Status, form.FiledAt = formStatus(f)
	form.DueDate = liabilities.DueDate(model.GroupFederal940, model.PayFreqQuarterly, to)
	form.Warnings = append(form.Warnings, filedWarning(f, form.Lines, "Form 941-X")...)
	return form, nil
}

// nextDayTrigger returns the first date from..to on which the 941 taxes of
// the paychecks (federal income tax withheld, social security and Medicare)
// accumulated in the deposit period reached $100,000 ("" when never). The
// deposit period is the calendar month (monthly schedule) or the Wednesday-
// Friday / Saturday-Tuesday period of the payday (semiweekly schedule).
func nextDayTrigger(ctx context.Context, q store.Q, from, to string, semiweekly bool) (string, error) {
	ds, err := loadData(ctx, q, from, to)
	if err != nil {
		return "", err
	}
	daily := map[string]int64{}
	for _, c := range ds.checks {
		for _, l := range c.lines {
			switch l.item.TaxCode {
			case model.TaxFIT:
				if c.employeeID != 0 {
					daily[c.date] += l.amount
				}
			case model.TaxSSEE, model.TaxSSER, model.TaxMedEE, model.TaxMedER, model.TaxAddlMed:
				daily[c.date] += l.amount
			}
		}
	}
	days := make([]string, 0, len(daily))
	for d := range daily {
		days = append(days, d)
	}
	sort.Strings(days)
	var acc int64
	period := ""
	for _, d := range days {
		key := d[:7]
		if semiweekly {
			key = semiweeklyPeriod(d)
		}
		if key != period {
			period, acc = key, 0
		}
		acc += daily[d]
		if acc >= 10_000_000 {
			return d, nil
		}
	}
	return "", nil
}

// semiweeklyPeriod returns the first day of the semiweekly deposit period of
// a payday: the Wednesday of a Wednesday-Friday payday, else the Saturday.
func semiweeklyPeriod(date string) string {
	t, err := store.ParseDate(date)
	if err != nil {
		return date
	}
	back := map[time.Weekday]int{time.Wednesday: 0, time.Thursday: 1, time.Friday: 2, time.Saturday: 0, time.Sunday: 1,
		time.Monday: 2, time.Tuesday: 3}[t.Weekday()]
	return t.AddDate(0, 0, -back).Format("2006-01-02")
}

// mdy formats a date as MM/DD/YYYY.
func mdy(date string) string {
	if len(date) != 10 {
		return date
	}
	return date[5:7] + "/" + date[8:10] + "/" + date[:4]
}

// designeeParts adds the third-party designee fields (941 Part 4, 940 Part 6).
func designeeParts(b *builder) {
	b.check("designee", "", "Do you want to allow an employee, a paid tax preparer, or another person to discuss this return with the IRS? (Yes)", false, true)
	b.text("designee", "name", "Designee's name", "", true)
	b.text("designee", "phone", "Designee's phone number", "", true)
	b.text("designee", "pin", "5-digit personal identification number (PIN) to use when talking to the IRS", "", true)
}

// signerParts adds the signature and paid preparer fields (941 Part 5, 940 Part 7).
func signerParts(b *builder, co *companyRow) {
	b.text("sign", "name", "Print your name here", co.ContactName, true)
	b.text("sign", "title", "Print your title here", co.title, true)
	b.text("sign", "date", "Date", "", true)
	b.text("sign", "phone", "Best daytime phone", co.ContactPhone, true)
	b.check("preparer", "selfEmployed", "Paid Preparer Use Only: Check if you're self-employed", false, true)
	b.text("preparer", "name", "Preparer's name", "", true)
	b.text("preparer", "ptin", "PTIN", "", true)
	b.text("preparer", "date", "Date", "", true)
	b.text("preparer", "firm", "Firm's name (or yours if self-employed)", "", true)
	b.text("preparer", "ein", "EIN", "", true)
	b.text("preparer", "address", "Address", "", true)
	b.text("preparer", "city", "City", "", true)
	b.text("preparer", "state", "State", "", true)
	b.text("preparer", "zip", "ZIP code", "", true)
	b.text("preparer", "phone", "Phone", "", true)
}

func monthOf(date string) int {
	t, err := store.ParseDate(date)
	if err != nil {
		return 0
	}
	return int(t.Month())
}

func dayOf(date string) int {
	t, err := store.ParseDate(date)
	if err != nil {
		return 0
	}
	return t.Day()
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// rateText shows a percent as the decimal factor printed on the form (12.4 -> "0.124").
func rateText(pct float64) string {
	s := fmt.Sprintf("%.6f", pct/100)
	s = strings.TrimRight(s, "0")
	return strings.TrimSuffix(s, ".")
}
