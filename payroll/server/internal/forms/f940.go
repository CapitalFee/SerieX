package forms

import (
	"context"
	"fmt"
	"sort"

	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// Form 940 for 2026 (line structure of the final 2025 form, which the 2026
// draft keeps) with Schedule A (credit reduction) in Extra.

// exemptBox returns the line 4 check box (4a-4e) of a payment exempt from FUTA.
func exemptBox(it *model.PayrollItem) string {
	switch it.TaxTracking {
	case model.Track125, model.TrackHSA, model.TrackHealthCoverage, model.TrackFringe:
		return "4a" // fringe benefits
	case model.TrackGroupTermLife:
		return "4b"
	case model.Track401k, model.Track403b, model.Track457b, model.TrackSimpleIRA, model.TrackRoth401k, model.TrackRoth403b:
		return "4c" // retirement/pension
	case model.TrackDependentCare:
		return "4d"
	}
	return "4e"
}

type futaEmp struct {
	payments int64 // line 3
	subject  int64 // wages subject to FUTA before the $7,000 limit
	taxable  int64 // FUTA wage bases of the paychecks
	exempt   map[string]int64
	hasFUTA  bool
}

// form940 computes Form 940 for a year. data = nil uses the saved values.
func form940(ctx context.Context, q store.Q, year int, data *formData) (*model.TaxForm, error) {
	from, to := store.YearRange(year)
	f, err := loadFiling(ctx, q, "940", year, "Y", "")
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
	form := &model.TaxForm{Form: "940", Year: year, Period: "Y", Title: fmt.Sprintf("Form 940 for %d: Employer's Annual Federal Unemployment (FUTA) Tax Return", year),
		Company: co.FormCompany, Warnings: []string{}, Extra: map[string]any{}}
	if tyWarn != "" {
		form.Warnings = append(form.Warnings, tyWarn)
	}
	if store.Digits(co.EIN) == "" {
		form.Warnings = append(form.Warnings, "The company has no employer identification number (EIN). Enter it in Company Payroll Information.")
	}

	emps := map[int64]*futaEmp{}
	get := func(id int64) *futaEmp {
		e := emps[id]
		if e == nil {
			e = &futaEmp{exempt: map[string]int64{}}
			emps[id] = e
		}
		return e
	}
	var qWages [4]int64 // FUTA taxable wages by quarter of the check date
	suiStates := map[string]bool{}
	stateFUTA := map[string]int64{}
	var noSUIFuta, companyFUTA int64
	var futaItemID int64
	for _, c := range ds.checks {
		qi := (monthOf(c.date) - 1) / 3
		if c.employeeID == 0 {
			// company adjustments change the FUTA liability only (e.g. the credit reduction)
			for _, l := range c.lines {
				if l.item.TaxCode == model.TaxFUTA {
					companyFUTA += l.amount
				}
			}
			continue
		}
		e := get(c.employeeID)
		for _, l := range c.lines {
			it := l.item
			switch l.cat {
			case model.CatEarning, model.CatAddition, model.CatContribution:
				if l.cat == model.CatAddition && it.TaxTracking == model.TrackNone {
					continue // accountable-plan reimbursements are not payments for services
				}
				e.payments += l.amount
				if !it.Taxability[model.BaseFUTA] {
					e.exempt[exemptBox(it)] += l.amount
				}
			case model.CatDeduction:
				if it.Taxability[model.BaseFUTA] {
					e.exempt[exemptBox(it)] += l.amount // pre-tax for FUTA (section 125, HSA, dependent care)
				}
			}
			if it.TaxCode == model.TaxFUTA {
				e.hasFUTA = true
				e.subject += l.subject
				e.taxable += l.wageBase
				qWages[qi] += l.wageBase
				futaItemID = it.ID
			}
		}
		if st := c.suiState(); st != "" {
			suiStates[st] = true
			_, wb, _, _ := c.taxSum(model.TaxFUTA)
			stateFUTA[st] += wb
		} else {
			_, wb, _, _ := c.taxSum(model.TaxFUTA)
			noSUIFuta += wb
		}
	}

	limit := store.Cents(fed.FUTAWageBase)
	var l3, l4, l5, futaWages int64
	boxes := map[string]int64{}
	for _, e := range emps {
		l3 += e.payments
		exempt := e.payments - e.subject
		if !e.hasFUTA {
			exempt = e.payments
			if e.payments != 0 {
				boxes["4e"] += e.payments // employees not subject to FUTA
			}
		} else {
			for k, v := range e.exempt {
				boxes[k] += v
			}
		}
		if exempt < 0 {
			exempt = 0
		}
		l4 += exempt
		if e.hasFUTA && e.subject > limit {
			l5 += e.subject - limit
		}
		futaWages += e.taxable
	}
	deposits, err := paymentsByGroup(ctx, q, ds.items, from, to, model.GroupFederal940)
	if err != nil {
		return nil, err
	}

	b := newBuilder(data)
	b.section = "Header"
	b.check("type", "a", "Type of Return: a. Amended", false, true)
	b.check("type", "b", "Type of Return: b. Successor employer", false, true)
	b.check("type", "c", fmt.Sprintf("Type of Return: c. No payments to employees in %d", year), l3 == 0, true)
	b.check("type", "d", "Type of Return: d. Final: Business closed or stopped paying wages", false, true)
	b.check("agg", "3504", "Aggregate Return Filers Only: Section 3504 Agent", false, true)
	b.check("agg", "cpeo", "Aggregate Return Filers Only: Certified Professional Employer Organization (CPEO)", false, true)
	b.check("agg", "other", "Aggregate Return Filers Only: Other Third Party", false, true)

	// Part 1
	b.section = "Part 1"
	states := make([]string, 0, len(suiStates))
	for s := range suiStates {
		states = append(states, s)
	}
	sort.Strings(states)
	oneState := co.primaryState
	if len(states) == 1 {
		oneState = states[0]
	} else if len(states) > 1 {
		oneState = ""
	}
	b.text("1a", "", "If you had to pay state unemployment tax in one state only, enter the state abbreviation", oneState, true)
	b.check("1b", "", "If you had to pay state unemployment tax in more than one state, you are a multi-state employer (complete Schedule A (Form 940))", len(states) > 1, true)
	crStates := []string{}
	for _, s := range states {
		if fed.CreditReduction[s] > 0 && stateFUTA[s] > 0 {
			crStates = append(crStates, s)
		}
	}
	b.check("2", "", "If you paid wages in a state that is subject to CREDIT REDUCTION (complete Schedule A (Form 940))", len(crStates) > 0, true)

	// Part 2
	b.section = "Part 2"
	e3 := b.money("3", "", "Total payments to all employees", l3, true)
	e4 := b.money("4", "", "Payments exempt from FUTA tax", l4, true)
	b.check("4a", "", "4a Fringe benefits", boxes["4a"] > 0, true)
	b.check("4b", "", "4b Group-term life insurance", boxes["4b"] > 0, true)
	b.check("4c", "", "4c Retirement/Pension", boxes["4c"] > 0, true)
	b.check("4d", "", "4d Dependent care", boxes["4d"] > 0, true)
	b.check("4e", "", "4e Other", boxes["4e"] > 0, true)
	e5 := b.money("5", "", fmt.Sprintf("Total of payments made to each employee in excess of %s", money(limit)), l5, true)
	e6 := b.money("6", "", "Subtotal (line 4 + line 5 = line 6)", e4+e5, false)
	e7 := b.money("7", "", "Total taxable FUTA wages (line 3 – line 6 = line 7)", e3-e6, false)
	e8 := b.money("8", "", fmt.Sprintf("FUTA tax before adjustments (line 7 × %s = line 8)", rateText(fed.FUTARate)), pctOf(e7, fed.FUTARate), false)
	if e7 != futaWages && e3 == l3 && e4 == l4 && e5 == l5 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Line 7 (%s) differs from the federal unemployment wages on the paychecks (%s). Check the year-to-date amounts entered for Federal Unemployment.", money(e7), money(futaWages)))
	}

	// Part 3 and Schedule A
	b.section = "Part 3"
	creditRate := fed.FUTAGrossRate - fed.FUTARate // 5.4
	if creditRate <= 0 {
		creditRate = 5.4
	}
	l9v := b.money("9", "", fmt.Sprintf("If ALL of the taxable FUTA wages you paid were excluded from state unemployment tax, multiply line 7 by %s", rateText(creditRate)), 0, true)
	e10 := b.money("10", "", "If SOME of the taxable FUTA wages you paid were excluded from state unemployment tax, OR you paid ANY state unemployment tax late (after the due date for filing Form 940), complete the worksheet in the instructions. Enter the amount from line 7 of the worksheet", 0, true)
	var schedA []map[string]any
	var credit int64
	for _, s := range states {
		rate := fed.CreditReduction[s]
		row := map[string]any{"state": s, "futaWages": store.Dollars(stateFUTA[s]), "reductionRate": rate, "creditReduction": 0.0}
		if rate > 0 {
			amt := pctOf(stateFUTA[s], rate)
			credit += amt
			row["creditReduction"] = store.Dollars(amt)
		}
		schedA = append(schedA, row)
	}
	if schedA == nil {
		schedA = []map[string]any{}
	}
	form.Extra["scheduleA"] = schedA
	form.Extra["scheduleAStates"] = states
	if noSUIFuta > 0 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("FUTA wages of %s were paid to employees not subject to state unemployment tax; complete the line 10 worksheet if they were excluded from state unemployment tax.", money(noSUIFuta)))
	}
	e11 := b.money("11", "", "If credit reduction applies, enter the total from Schedule A (Form 940)", credit, true)

	if l9v != 0 && (e10 != 0 || e11 != 0) {
		form.Warnings = append(form.Warnings, "Line 9 is filled in: lines 10 and 11 must be empty (Form 940 instructions).")
	}

	// Part 4
	b.section = "Part 4"
	e12 := b.money("12", "", "Total FUTA tax after adjustments (lines 8 + 9 + 10 + 11 = line 12)", e8+l9v+e10+e11, false)
	e13 := b.money("13", "", "FUTA tax deposited for the year, including any overpayment applied from a prior year", deposits, true)
	var due, over int64
	if e12 > e13 {
		due = e12 - e13
	} else {
		over = e13 - e12
	}
	b.money("14", "", "Balance due. If line 12 is more than line 13, enter the excess on line 14", due, false)
	b.money("15a", "", "Overpayment. If line 13 is more than line 12, enter the excess on line 15a", over, false)
	b.check("15b", "1", "Check one: Apply to next return.", false, true)
	b.check("15b", "2", "Check one: Send a refund.", false, true)
	b.text("15c", "", "Routing number (direct deposit of the refund)", "", true)
	b.text("15d", "", "Type: Checking or Savings", "", true)
	b.text("15e", "", "Account number", "", true)
	if due > 50000 {
		form.Warnings = append(form.Warnings, "Line 14 is more than $500: the balance must be deposited (it cannot be paid with the return).")
	}

	// Part 5: FUTA tax liability by quarter. The liability of a quarter is
	// 0.6% of the FUTA wages paid in it (check date), rounded on the running
	// total so the quarters never exceed line 8. The fourth quarter is what is
	// left of line 12 (Form 940 instructions: "subtract lines 16a through 16c
	// from line 17"): it holds the rounding, lines 9 and 10 and the credit
	// reduction, which is a fourth quarter liability.
	b.section = "Part 5"
	var liab [4]int64
	var cum, prev int64
	for i := 0; i < 3; i++ {
		cum += qWages[i]
		liab[i] = pctOf(cum, fed.FUTARate) - prev
		prev += liab[i]
	}
	q1 := b.money("16a", "", "1st quarter (January 1 – March 31)", liab[0], true)
	q2 := b.money("16b", "", "2nd quarter (April 1 – June 30)", liab[1], true)
	q3 := b.money("16c", "", "3rd quarter (July 1 – September 30)", liab[2], true)
	q4 := b.money("16d", "", "4th quarter (October 1 – December 31)", e12-(q1+q2+q3), true)
	total := b.money("17", "", "Total tax liability for the year (lines 16a + 16b + 16c + 16d = line 17)", q1+q2+q3+q4, false)
	form.Extra["part5Required"] = e12 > 50000
	if e12 > 50000 && total != e12 {
		form.Warnings = append(form.Warnings, fmt.Sprintf("Line 17 (%s) must equal line 12 (%s).", money(total), money(e12)))
	}

	// credit reduction not yet recorded as a liability
	if e11 > 0 {
		need := e11 - companyFUTA
		form.Extra["creditReductionAdjustment"] = map[string]any{
			"amount": store.Dollars(e11), "adjusted": store.Dollars(companyFUTA), "needed": store.Dollars(max(need, 0)),
			"itemId": futaItemID, "effectiveDate": to,
		}
		if need > 0 {
			form.Warnings = append(form.Warnings, fmt.Sprintf("Credit reduction of %s (line 11) is not in what you owe for FUTA yet (%s adjusted). Add a company tax balance adjustment of Federal Unemployment for %s effective %s.",
				money(e11), money(companyFUTA), money(need), to))
		}
	}

	b.section = "Part 6"
	designeeParts(b)
	b.section = "Part 7"
	signerParts(b, co)

	form.Lines = b.lines
	form.Status, form.FiledAt = formStatus(f)
	form.DueDate = liabilities.DueDate(model.GroupFederal940, model.PayFreqAnnually, to)
	form.Warnings = append(form.Warnings, filedWarning(f, form.Lines, "an amended Form 940")...)
	if len(states) > 1 || len(crStates) > 0 {
		form.Extra["scheduleARequired"] = true
	}
	return form, nil
}
