package forms

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// W-2 box 12 codes that are elective deferrals: only the employee's amounts
// (deductions) are reported. W-3 box 12a totals these codes (and G).
var deferralCodes = map[string]bool{"D": true, "E": true, "F": true, "H": true, "S": true, "Y": true, "AA": true, "BB": true, "EE": true}
var w3DeferredCodes = map[string]bool{"D": true, "E": true, "F": true, "G": true, "H": true, "S": true, "Y": true, "AA": true, "BB": true, "EE": true}

// retirement plan participation (W-2 box 13): 401(a)/401(k), 403(b), SEP,
// SIMPLE and 501(c)(18) plans; a 457(b) plan alone does not count (W-2
// instructions, box 13 "Retirement plan").
var retirementTracking = map[string]bool{model.Track401k: true, model.Track403b: true, model.TrackSimpleIRA: true,
	model.TrackRoth401k: true, model.TrackRoth403b: true}
var retirementCodes = map[string]bool{"D": true, "E": true, "F": true, "H": true, "S": true, "AA": true, "BB": true}

type w2acc struct {
	emp            *employeeRow
	box1, box2     int64
	ssBase, ssTips int64
	box4           int64
	box5, box6     int64
	box10          int64
	box12          map[string]int64
	overtime       map[int64]int64 // qualified overtime items: amount per item
	tips           int64
	box14          map[string]int64
	states         map[string]*[2]int64
	locals         map[string]*[2]int64
	retirement     bool
	paid           bool
}

func codeLess(a, b string) bool {
	if len(a) != len(b) {
		return len(a) < len(b)
	}
	return a < b
}

// overtimePremium is the qualified overtime compensation of an overtime item
// (box 12 code TT): only the premium above the regular rate, i.e. amount x
// (multiplier - 1) / multiplier ("the half of time-and-a-half").
func overtimePremium(amount int64, multiplier float64) int64 {
	if multiplier <= 1 {
		return 0
	}
	v := float64(amount) * (multiplier - 1) / multiplier
	if v >= 0 {
		return int64(math.Round(v + 1e-6))
	}
	return int64(math.Round(v - 1e-6))
}

func middleInitial(m string) string {
	m = strings.TrimSpace(m)
	if m == "" {
		return ""
	}
	return strings.ToUpper(m[:1])
}

// computeW2 builds the W-2 of every employee paid in the year and the W-3.
func computeW2(ctx context.Context, q store.Q, year int, reveal bool) (*model.W2Result, *filing, error) {
	from, to := store.YearRange(year)
	f, err := loadFiling(ctx, q, "W-2", year, "Y", "")
	if err != nil {
		return nil, nil, err
	}
	co, err := loadCompany(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	ty, _, err := taxes.ForCompany(ctx, q, year)
	if err != nil {
		return nil, nil, err
	}
	fed := &ty.Federal
	emps, err := loadEmployees(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	whIDs, _, err := stateIDs(ctx, q)
	if err != nil {
		return nil, nil, err
	}
	ds, err := loadData(ctx, q, from, to)
	if err != nil {
		return nil, nil, err
	}
	accs := map[int64]*w2acc{}
	for _, c := range ds.checks {
		if c.employeeID == 0 {
			continue
		}
		a := accs[c.employeeID]
		if a == nil {
			e := emps[c.employeeID]
			if e == nil {
				continue
			}
			a = &w2acc{emp: e, box12: map[string]int64{}, overtime: map[int64]int64{}, box14: map[string]int64{},
				states: map[string]*[2]int64{}, locals: map[string]*[2]int64{}}
			accs[c.employeeID] = a
		}
		if c.gross != 0 {
			a.paid = true
		}
		for _, l := range c.lines {
			it := l.item
			if l.amount != 0 || l.wageBase != 0 {
				a.paid = true
			}
			switch it.TaxCode {
			case model.TaxFIT:
				a.box1 += l.wageBase
				a.box2 += l.amount
			case model.TaxSSEE:
				a.box4 += l.amount
			case model.TaxMedEE, model.TaxAddlMed:
				a.box6 += l.amount
			case model.TaxSIT:
				st := strings.ToUpper(it.State)
				if a.states[st] == nil {
					a.states[st] = &[2]int64{}
				}
				a.states[st][0] += l.wageBase
				a.states[st][1] += l.amount
			case model.TaxLocalEE:
				if a.locals[it.Name] == nil {
					a.locals[it.Name] = &[2]int64{}
				}
				a.locals[it.Name][0] += l.wageBase
				a.locals[it.Name][1] += l.amount
			}
			// box 14: items with a box 14 label; state disability / family
			// leave / employee unemployment taxes by state and program
			label := strings.TrimSpace(it.W2Box14)
			if label == "" {
				switch it.TaxCode {
				case model.TaxStateEE:
					label = strings.ToUpper(it.State) + " " + strings.ToUpper(it.TaxKey)
				case model.TaxSUIEE:
					label = strings.ToUpper(it.State) + " UI"
				}
			}
			if label != "" && l.cat != model.CatEmployerTax {
				a.box14[label] += l.amount
			}
			if it.TaxTracking == model.TrackDependentCare && (l.cat == model.CatDeduction || l.cat == model.CatContribution) {
				a.box10 += l.amount
			}
			if (l.cat == model.CatDeduction || l.cat == model.CatContribution) && l.amount > 0 {
				if retirementTracking[it.TaxTracking] || retirementCodes[strings.ToUpper(it.W2Box12)] {
					a.retirement = true
				}
			}
			// box 12
			switch {
			case l.cat == model.CatEarning && it.TaxTracking == model.TrackOvertime:
				a.overtime[it.ID] += l.amount
				continue
			case l.cat == model.CatEarning && isTips(it):
				a.tips += l.amount
				continue
			}
			code := strings.ToUpper(strings.TrimSpace(it.W2Box12))
			if code == "" || code == "TT" || code == "TP" || it.TaxCode != "" {
				continue
			}
			if deferralCodes[code] && l.cat != model.CatDeduction {
				continue // deferrals: the employee's contributions only
			}
			switch l.cat {
			case model.CatEarning, model.CatAddition, model.CatDeduction, model.CatContribution:
				a.box12[code] += l.amount
			}
		}
		a.box1 += c.imputedIncome()
		a.ssBase += c.base(model.TaxSSEE, model.TaxSSER)
		a.ssTips += c.ssTips()
		a.box5 += c.base(model.TaxMedEE, model.TaxMedER)
	}

	res := &model.W2Result{Year: year, Company: co.FormCompany, Employees: []model.W2{}}
	res.Status, res.FiledAt = formStatus(f)
	reviewed := map[int64]bool{}
	var occupations map[string][]string
	if f != nil {
		for _, id := range f.data.Reviewed {
			reviewed[id] = true
		}
		occupations = f.data.OccupationCodes
	}
	w3 := model.W3{Year: year, States: []model.W2State{}, Locals: []model.W2Local{}, KindOfPayer: "941", KindOfEmployer: "none"}
	var t1, t2, t3, t4, t5, t6, t7, t10, t12a int64
	stTot := map[string]*[2]int64{}
	locTot := map[string]*[2]int64{}
	ssCap := store.Cents(fed.SSWageBase)
	for _, a := range accs {
		if !a.paid {
			continue
		}
		e := a.emp
		w := model.W2{EmployeeID: e.id, Year: year, SSN: ssnOut(e.ssn, reveal), EmployeeName: e.name,
			FirstName: e.first, MiddleInitial: middleInitial(e.middle), LastName: e.last, Suffix: e.suffix,
			Address: e.addr, ControlNumber: e.number, Box12: []model.Box12{}, Box14: []model.Box14{}, States: []model.W2State{},
			Locals: []model.W2Local{}, Warnings: []string{}, Box14b: []string{}}
		box3 := a.ssBase - a.ssTips
		w.Box1, w.Box2, w.Box3, w.Box4 = store.Dollars(a.box1), store.Dollars(a.box2), store.Dollars(box3), store.Dollars(a.box4)
		w.Box5, w.Box6, w.Box7, w.Box10 = store.Dollars(a.box5), store.Dollars(a.box6), store.Dollars(a.ssTips), store.Dollars(a.box10)
		var tt int64
		for id, amt := range a.overtime {
			tt += overtimePremium(amt, ds.items[id].Rate)
		}
		if tt != 0 {
			a.box12["TT"] += tt
		}
		if a.tips != 0 {
			a.box12["TP"] += a.tips
		}
		codes := make([]string, 0, len(a.box12))
		for k, v := range a.box12 {
			if v != 0 {
				codes = append(codes, k)
			}
		}
		sort.Slice(codes, func(i, j int) bool { return codeLess(codes[i], codes[j]) })
		var d12a int64
		for _, k := range codes {
			w.Box12 = append(w.Box12, model.Box12{Code: k, Amount: store.Dollars(a.box12[k])})
			if w3DeferredCodes[k] {
				d12a += a.box12[k]
			}
		}
		labels := make([]string, 0, len(a.box14))
		for k, v := range a.box14 {
			if v != 0 {
				labels = append(labels, k)
			}
		}
		sort.Strings(labels)
		for _, k := range labels {
			w.Box14 = append(w.Box14, model.Box14{Label: k, Amount: store.Dollars(a.box14[k])})
		}
		w.Statutory = strings.EqualFold(e.employmentType, "statutory")
		w.RetirementPlan = a.retirement
		sts := make([]string, 0, len(a.states))
		for s := range a.states {
			sts = append(sts, s)
		}
		sort.Strings(sts)
		for _, s := range sts {
			v := a.states[s]
			if v[0] == 0 && v[1] == 0 {
				continue
			}
			w.States = append(w.States, model.W2State{State: s, StateID: whIDs[s], Wages: store.Dollars(v[0]), Tax: store.Dollars(v[1])})
			if stTot[s] == nil {
				stTot[s] = &[2]int64{}
			}
			stTot[s][0] += v[0]
			stTot[s][1] += v[1]
		}
		locs := make([]string, 0, len(a.locals))
		for s := range a.locals {
			locs = append(locs, s)
		}
		sort.Strings(locs)
		for _, s := range locs {
			v := a.locals[s]
			if v[0] == 0 && v[1] == 0 {
				continue
			}
			w.Locals = append(w.Locals, model.W2Local{Name: s, Wages: store.Dollars(v[0]), Tax: store.Dollars(v[1])})
			if locTot[s] == nil {
				locTot[s] = &[2]int64{}
			}
			locTot[s][0] += v[0]
			locTot[s][1] += v[1]
		}
		if codes := occupations[strconv.FormatInt(e.id, 10)]; len(codes) > 0 {
			w.Box14b = append(w.Box14b, codes...)
		}
		w.Reviewed = reviewed[e.id]

		// checks the Social Security Administration applies to every W-2
		if len(e.ssn) != 9 {
			w.Warnings = append(w.Warnings, "Box a: the employee's social security number is missing.")
		}
		if strings.TrimSpace(e.addr.Line1) == "" || strings.TrimSpace(e.addr.City) == "" || strings.TrimSpace(e.addr.Zip) == "" {
			w.Warnings = append(w.Warnings, "Box f: the employee's address is incomplete.")
		}
		if a.ssBase > ssCap {
			w.Warnings = append(w.Warnings, fmt.Sprintf("Boxes 3 and 7 together (%s) are more than the social security wage base (%s).", money(a.ssBase), money(ssCap)))
		}
		if a.box5 < a.ssBase {
			w.Warnings = append(w.Warnings, "Box 5 (Medicare wages and tips) is less than boxes 3 and 7 together.")
		}
		if a.box4 != 0 && a.ssBase == 0 {
			w.Warnings = append(w.Warnings, "Box 4 has social security tax but boxes 3 and 7 have no wages.")
		}
		if a.box6 != 0 && a.box5 == 0 {
			w.Warnings = append(w.Warnings, "Box 6 has Medicare tax but box 5 has no wages.")
		}
		if len(w.Box12) > 4 {
			w.Warnings = append(w.Warnings, "More than four box 12 codes: the extra codes print on a second Form W-2.")
		}
		if a.box12["TP"] != 0 && len(w.Box14b) == 0 {
			w.Warnings = append(w.Warnings, "Box 14b: enter the Treasury Tipped Occupation Code (box 12 code TP is reported).")
		}
		res.Employees = append(res.Employees, w)

		t1 += a.box1
		t2 += a.box2
		t3 += box3
		t4 += a.box4
		t5 += a.box5
		t6 += a.box6
		t7 += a.ssTips
		t10 += a.box10
		t12a += d12a
	}
	sort.Slice(res.Employees, func(i, j int) bool {
		a, b := res.Employees[i], res.Employees[j]
		if !strings.EqualFold(a.LastName, b.LastName) {
			return strings.ToLower(a.LastName) < strings.ToLower(b.LastName)
		}
		if !strings.EqualFold(a.FirstName, b.FirstName) {
			return strings.ToLower(a.FirstName) < strings.ToLower(b.FirstName)
		}
		return a.EmployeeID < b.EmployeeID
	})
	w3.Count = len(res.Employees)
	w3.Box1, w3.Box2, w3.Box3, w3.Box4 = store.Dollars(t1), store.Dollars(t2), store.Dollars(t3), store.Dollars(t4)
	w3.Box5, w3.Box6, w3.Box7, w3.Box10 = store.Dollars(t5), store.Dollars(t6), store.Dollars(t7), store.Dollars(t10)
	w3.Box12a = store.Dollars(t12a)
	sts := make([]string, 0, len(stTot))
	for s := range stTot {
		sts = append(sts, s)
	}
	sort.Strings(sts)
	for _, s := range sts {
		w3.States = append(w3.States, model.W2State{State: s, StateID: whIDs[s], Wages: store.Dollars(stTot[s][0]), Tax: store.Dollars(stTot[s][1])})
	}
	locs := make([]string, 0, len(locTot))
	for s := range locTot {
		locs = append(locs, s)
	}
	sort.Strings(locs)
	for _, s := range locs {
		w3.Locals = append(w3.Locals, model.W2Local{Name: s, Wages: store.Dollars(locTot[s][0]), Tax: store.Dollars(locTot[s][1])})
	}
	res.W3 = w3
	return res, f, nil
}
