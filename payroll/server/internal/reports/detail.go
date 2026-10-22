package reports

import (
	"sort"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/taxes"
)

// ---------------------------------------------------------------------------
// Payroll Item Detail: every transaction line of each payroll item.
//
// Paycheck lines (by check date) show the item amount; liability adjustment
// lines (by effective date) the signed adjustment; tax payment lines (by
// payment date; with paidFor=1 by the period end of the period they pay, like
// Payroll Liability Balances) minus the amount paid, so the total of a
// liability item is what was accrued, adjusted and paid in the period.

type itemDetailRow struct {
	typ, date, num, name string
	wageBase             *int64
	amount               int64
	target               *model.ReportTarget
	order                int
	id                   int64
}

func payrollItemDetail(e *env) (*model.ReportResult, error) {
	p := e.p
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	incV := p.Bool("includeVoided")
	pcs, err := e.paychecks(pcFilter{from: p.From, to: p.To, employeeID: p.EmployeeID, includeVoided: incV})
	if err != nil {
		return nil, err
	}
	adjs, err := e.adjustments(p.From, p.To, true, p.EmployeeID)
	if err != nil {
		return nil, err
	}
	// paidFor=1 (drill-down from Payroll Liability Balances): tax payments
	// paying the period (period end in the range) instead of those dated in it
	var pays []*payment
	if p.EmployeeID == 0 {
		if pays, err = e.payments(p.From, p.To, p.Bool("paidFor"), incV); err != nil {
			return nil, err
		}
	}
	by := map[int64][]itemDetailRow{}
	want := func(id int64) bool { return p.ItemID == 0 || p.ItemID == id }
	for _, pc := range pcs {
		for _, l := range pc.Lines {
			if !want(l.ItemID) {
				continue
			}
			if l.Amount == 0 && l.WageBase == 0 && !pc.Voided {
				continue // e.g. Additional Medicare below the threshold, a capped tax
			}
			r := itemDetailRow{typ: pcType(pc), date: pc.CheckDate, num: checkNum(pc), name: pc.EmployeeName, amount: l.Amount,
				target: target("paycheck", pc.ID), order: 0, id: pc.ID}
			if l.Category != model.CatEarning && l.Category != model.CatAddition {
				wb := l.WageBase
				r.wageBase = &wb
			}
			by[l.ItemID] = append(by[l.ItemID], r)
		}
	}
	for _, a := range adjs {
		name := a.EmployeeName
		if a.EmployeeID == 0 {
			name = "Company"
		}
		for _, l := range a.Lines {
			if !want(l.ItemID) {
				continue
			}
			wb := l.WageBase
			by[l.ItemID] = append(by[l.ItemID], itemDetailRow{typ: "Tax Adjustment", date: a.EffectiveDate, name: name,
				wageBase: &wb, amount: l.Amount, target: target("adjustment", a.ID), order: 1, id: a.ID})
		}
	}
	for _, py := range pays {
		name := e.vendorName(py.AgencyVendorID)
		if name == "" {
			name = py.AgencyName
		}
		for _, l := range py.Lines {
			if l.Kind != "item" || l.ItemID == 0 || !want(l.ItemID) {
				continue
			}
			by[l.ItemID] = append(by[l.ItemID], itemDetailRow{typ: payType(py), date: py.Date, num: payNum(py), name: name,
				amount: -l.Amount, target: target("liability_payment", py.ID), order: 2, id: py.ID})
		}
	}
	var list []*model.PayrollItem
	for id := range by {
		list = append(list, its.get(id))
	}
	sortItems(list)
	res := e.newResult("Payroll Item Detail", false, labelCol(), col("type", "Type", "text"), col("date", "Date", "date"),
		col("num", "Num", "text"), col("name", "Source Name", "text"), col("wageBase", "Wage Base", "money"),
		col("amount", "Amount", "money"))
	var grand int64
	for _, it := range list {
		rows := by[it.ID]
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].date != rows[j].date {
				return rows[i].date < rows[j].date
			}
			if rows[i].order != rows[j].order {
				return rows[i].order < rows[j].order
			}
			return rows[i].id < rows[j].id
		})
		g := e.group()
		// section rows carry no drill-down target: double-clicking them collapses the section
		addRow(res, "section", 0, g, map[string]any{"label": it.Name})
		var sum, wbSum int64
		hasWB := false
		for _, r := range rows {
			c := map[string]any{"label": "", "type": r.typ, "date": r.date, "num": r.num, "name": r.name, "amount": dollars(r.amount)}
			if r.wageBase != nil {
				c["wageBase"] = dollars(*r.wageBase)
				wbSum += *r.wageBase
				hasWB = true
			}
			row := addRow(res, "data", 1, g, c)
			row.Target = r.target
			sum += r.amount
		}
		tc := map[string]any{"label": "Total " + it.Name, "amount": dollars(sum)}
		if hasWB {
			tc["wageBase"] = dollars(wbSum)
		}
		addRow(res, "subtotal", 0, g, tc)
		grand += sum
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": dollars(grand)})
	return res, nil
}

// ---------------------------------------------------------------------------
// Payroll Detail Review: calculated vs actual amount of every paycheck line
// that the program calculates (additions, deductions, taxes, contributions).

func payrollDetailReview(e *env) (*model.ReportResult, error) {
	p := e.p
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	pcs, err := e.paychecks(pcFilter{from: p.From, to: p.To, employeeID: p.EmployeeID, kind: model.PaycheckRegular})
	if err != nil {
		return nil, err
	}
	onlyDiff := p.Bool("differences")
	res := e.newResult("Payroll Detail Review", false, labelCol(), col("date", "Date", "date"), col("num", "Num", "text"),
		col("name", "Employee", "text"), col("item", "Payroll Item", "text"), col("subject", "Income Subject To Tax", "money"),
		col("wageBase", "Wage Base", "money"), col("rate", "Tax Rate %", "number"), col("edit", "User Edit?", "text"),
		col("calculated", "Calculated Amount", "money"), col("actual", "Actual Amount", "money"),
		col("difference", "Difference", "money"))
	var gCalc, gAct int64
	for _, pc := range pcs {
		var rows []pcLine
		for _, l := range pc.Lines {
			if l.Category == model.CatEarning {
				continue
			}
			if p.ItemID != 0 && l.ItemID != p.ItemID {
				continue
			}
			if onlyDiff && !l.Manual && l.Amount == l.Computed {
				continue
			}
			rows = append(rows, l)
		}
		if len(rows) == 0 {
			continue
		}
		g := e.group()
		var calc, act int64
		for i, l := range rows {
			it := its.get(l.ItemID)
			c := map[string]any{"label": "", "date": pc.CheckDate, "num": checkNum(pc), "name": pc.EmployeeName, "item": it.Name,
				"edit": "No", "calculated": dollars(l.Computed), "actual": dollars(l.Amount), "difference": dollars(l.Amount - l.Computed)}
			if l.Manual {
				c["edit"] = "Yes"
			}
			if i > 0 {
				c["date"], c["num"], c["name"] = nil, "", ""
			}
			isTax := l.Category == model.CatEmployeeTax || l.Category == model.CatEmployerTax
			if isTax {
				c["subject"] = dollars(l.Subject)
				c["wageBase"] = dollars(l.WageBase)
				if l.WageBase != 0 && it.TaxCode != model.TaxFIT && it.TaxCode != model.TaxSIT {
					c["rate"] = round4(float64(l.Computed) / float64(l.WageBase) * 100)
				}
			} else if l.WageBase != 0 {
				c["wageBase"] = dollars(l.WageBase)
				if it.Calc == model.CalcPercent && l.Rate != nil {
					c["rate"] = round4(*l.Rate)
				}
			}
			r := addRow(res, "data", 0, g, c)
			r.Target = target("paycheck", pc.ID)
			calc += l.Computed
			act += l.Amount
		}
		addRow(res, "subtotal", 0, g, map[string]any{"label": "", "calculated": dollars(calc), "actual": dollars(act),
			"difference": dollars(act - calc)})
		gCalc += calc
		gAct += act
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "calculated": dollars(gCalc), "actual": dollars(gAct),
		"difference": dollars(gAct - gCalc)})
	return res, nil
}

// ---------------------------------------------------------------------------
// Payroll Register: one row per paycheck (regular and year-to-date entries).

func payrollRegister(e *env) (*model.ReportResult, error) {
	p := e.p
	pcs, err := e.paychecks(pcFilter{from: p.From, to: p.To, employeeID: p.EmployeeID, includeVoided: p.Bool("includeVoided")})
	if err != nil {
		return nil, err
	}
	res := e.newResult("Payroll Register", false, labelCol(), col("date", "Date", "date"), col("num", "Num", "text"),
		col("name", "Employee", "text"), col("period", "Pay Period", "text"), col("hours", "Hours", "number"),
		col("gross", "Gross Pay", "money"), col("taxes", "Taxes", "money"), col("deductions", "Deductions", "money"),
		col("net", "Net Pay", "money"), col("employerTaxes", "Employer Taxes", "money"),
		col("contributions", "Contributions", "money"))
	var hours float64
	var gross, tx, ded, net, er, contrib int64
	for _, pc := range pcs {
		num := checkNum(pc)
		if pc.Kind == model.PaycheckYTD {
			num = "YTD"
		}
		name := pc.EmployeeName
		if pc.Voided {
			name += " (VOID)"
		}
		r := addRow(res, "data", 0, "", map[string]any{"label": "", "date": pc.CheckDate, "num": num, "name": name,
			"period": mdy(pc.PeriodStart) + " - " + mdy(pc.PeriodEnd), "hours": round4(pc.TotalHours),
			"gross": dollars(pc.Gross), "taxes": dollars(pc.EmployeeTaxes), "deductions": dollars(pc.Deductions),
			"net": dollars(pc.Net), "employerTaxes": dollars(pc.EmployerTaxes), "contributions": dollars(pc.Contributions)})
		r.Target = target("paycheck", pc.ID)
		hours += pc.TotalHours
		gross += pc.Gross
		tx += pc.EmployeeTaxes
		ded += pc.Deductions
		net += pc.Net
		er += pc.EmployerTaxes
		contrib += pc.Contributions
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "hours": round4(hours), "gross": dollars(gross),
		"taxes": dollars(tx), "deductions": dollars(ded), "net": dollars(net), "employerTaxes": dollars(er),
		"contributions": dollars(contrib)})
	return res, nil
}

// ---------------------------------------------------------------------------
// Payroll Transactions by Payee: paychecks, tax payments and liability
// adjustments grouped by employee / agency with the amount paid.

func payrollTransactionsByPayee(e *env) (*model.ReportResult, error) {
	p := e.p
	txns, err := e.postings(p.From, p.To, p.EmployeeID, p.Bool("includeVoided"))
	if err != nil {
		return nil, err
	}
	lk := e.lookups()
	type payee struct {
		key, name string
		emp       int64
		txns      []*postTxn
	}
	byKey := map[string]*payee{}
	var payees []*payee
	for _, t := range txns {
		pe := byKey[t.NameKey]
		if pe == nil {
			pe = &payee{key: t.NameKey, name: t.Name, emp: t.EmpID}
			byKey[t.NameKey] = pe
			payees = append(payees, pe)
		}
		pe.txns = append(pe.txns, t)
	}
	sort.SliceStable(payees, func(i, j int) bool {
		a, b := strings.ToLower(payees[i].name), strings.ToLower(payees[j].name)
		if a != b {
			return a < b
		}
		return payees[i].key < payees[j].key
	})
	res := e.newResult("Payroll Transactions by Payee", false, labelCol(), col("type", "Type", "text"), col("date", "Date", "date"),
		col("num", "Num", "text"), col("memo", "Memo", "text"), col("account", "Account", "text"),
		col("amount", "Paid Amount", "money"))
	var grand int64
	for _, pe := range payees {
		g := e.group()
		addRow(res, "section", 0, g, map[string]any{"label": pe.name})
		var sum int64
		for _, t := range pe.txns {
			acct := ""
			var amt int64
			if t.Entity == "adjustment" {
				acct = splitAccount(t, lk.AccountName)
			} else {
				acct = lk.AccountName(t.Bank)
				amt = t.Total
			}
			r := addRow(res, "data", 1, g, map[string]any{"label": "", "type": t.Type, "date": t.Date, "num": t.Num,
				"memo": t.Memo, "account": acct, "amount": dollars(amt)})
			r.Target = t.Target
			sum += amt
		}
		addRow(res, "subtotal", 0, g, map[string]any{"label": "Total " + pe.name, "amount": dollars(sum)})
		grand += sum
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": dollars(grand)})
	return res, nil
}

// splitAccount is the account of a transaction's liability side, "-SPLIT-" when several.
func splitAccount(t *postTxn, name func(*int64) string) string {
	seen := map[int64]bool{}
	var first *int64
	for _, l := range t.Lines {
		if l.Side != sideLiability {
			continue
		}
		if l.AccountID == nil {
			continue
		}
		if !seen[*l.AccountID] {
			seen[*l.AccountID] = true
			if first == nil {
				first = l.AccountID
			}
		}
	}
	switch len(seen) {
	case 0:
		return ""
	case 1:
		return name(first)
	}
	return "-SPLIT-"
}

// ---------------------------------------------------------------------------
// Payroll Transaction Detail: every payroll transaction with its lines as
// posted (or as they would be posted) to SerieX Books: payroll item, wage
// base, account and amount (debits positive). A transaction's lines add up to
// the check amount (paychecks, tax payments) or to zero (adjustments).

func payrollTransactionDetail(e *env) (*model.ReportResult, error) {
	p := e.p
	txns, err := e.postings(p.From, p.To, p.EmployeeID, p.Bool("includeVoided"))
	if err != nil {
		return nil, err
	}
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	lk := e.lookups()
	// paychecks: tax lines with zero amounts and not-paid items are not posted
	// but belong in the detail (their wage bases); load them from the paychecks
	pcs, err := e.paychecks(pcFilter{from: p.From, to: p.To, employeeID: p.EmployeeID, includeVoided: p.Bool("includeVoided")})
	if err != nil {
		return nil, err
	}
	pcByID := map[int64]*paycheck{}
	for _, pc := range pcs {
		pcByID[pc.ID] = pc
	}
	res := e.newResult("Payroll Transaction Detail", false, labelCol(), col("date", "Date", "date"), col("num", "Num", "text"),
		col("type", "Type", "text"), col("name", "Source Name", "text"), col("item", "Payroll Item", "text"),
		col("wageBase", "Wage Base", "money"), col("account", "Account", "text"), col("amount", "Amount", "money"))
	var grand int64
	for _, t := range txns {
		if p.ItemID != 0 && !txnHasItem(t, pcByID, p.ItemID) {
			continue
		}
		g := e.group()
		first := true
		var sum int64
		row := func(item string, wb *int64, acct string, amt *int64) {
			c := map[string]any{"label": "", "date": t.Date, "num": t.Num, "type": t.Type, "name": t.Name, "item": item,
				"account": acct}
			if !first {
				c["date"], c["num"], c["type"], c["name"] = nil, "", "", ""
			}
			if wb != nil {
				c["wageBase"] = dollars(*wb)
			}
			if amt != nil {
				c["amount"] = dollars(*amt)
				sum += *amt
			}
			r := addRow(res, "data", 0, g, c)
			r.Target = t.Target
			first = false
		}
		if pc := pcByID[t.ID]; t.Entity == "paycheck" && pc != nil {
			for _, l := range pc.Lines {
				it := its.get(l.ItemID)
				if p.ItemID != 0 && it.ID != p.ItemID {
					continue
				}
				var wb *int64
				if l.Category != model.CatEarning && l.Category != model.CatAddition {
					v := l.WageBase
					wb = &v
				}
				switch {
				case it.NotPaid:
					v := l.Amount
					row(it.Name+" (not paid)", &v, "", nil)
				case l.Category == model.CatEarning || l.Category == model.CatAddition:
					v := l.Amount
					row(it.Name, wb, lk.AccountName(it.ExpenseAccountID), &v)
				case l.Category == model.CatDeduction || l.Category == model.CatEmployeeTax:
					v := -l.Amount
					row(it.Name, wb, lk.AccountName(it.LiabilityAccountID), &v)
				default:
					v1, v2 := l.Amount, -l.Amount
					row(it.Name, wb, lk.AccountName(it.ExpenseAccountID), &v1)
					if l.Amount != 0 { // a zero employer amount is shown once (its wage base)
						row(it.Name, nil, lk.AccountName(it.LiabilityAccountID), &v2)
					}
				}
			}
		} else {
			for _, l := range t.Lines {
				if l.Side == sideBank {
					continue
				}
				if p.ItemID != 0 && l.ItemID != p.ItemID {
					continue
				}
				item := ""
				var wb *int64
				if l.ItemID != 0 {
					item = its.get(l.ItemID).Name
					if t.Entity == "adjustment" && l.Side == sideLiability && l.WageBase != 0 {
						v := l.WageBase
						wb = &v
					}
				} else {
					item = l.Desc
				}
				v := l.Amount
				row(item, wb, lk.AccountName(l.AccountID), &v)
			}
			if first { // no lines (voided or wage-base-only adjustment)
				zero := int64(0)
				row("", nil, lk.AccountName(t.Bank), &zero)
			}
		}
		addRow(res, "subtotal", 0, g, map[string]any{"label": "", "amount": dollars(sum)})
		grand += sum
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": dollars(grand)})
	return res, nil
}

func txnHasItem(t *postTxn, pcs map[int64]*paycheck, itemID int64) bool {
	if pc := pcs[t.ID]; t.Entity == "paycheck" && pc != nil {
		for _, l := range pc.Lines {
			if l.ItemID == itemID {
				return true
			}
		}
		return false
	}
	for _, l := range t.Lines {
		if l.ItemID == itemID {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Employee State Taxes Detail: state tax lines grouped by state and employee.

func employeeStateTaxesDetail(e *env) (*model.ReportResult, error) {
	p := e.p
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	pcs, err := e.paychecks(pcFilter{from: p.From, to: p.To, employeeID: p.EmployeeID})
	if err != nil {
		return nil, err
	}
	adjs, err := e.adjustments(p.From, p.To, true, p.EmployeeID)
	if err != nil {
		return nil, err
	}
	emps, err := e.employees()
	if err != nil {
		return nil, err
	}
	type line struct {
		date, num, typ, item string
		subject, wageBase    *int64
		amount               int64
		target               *model.ReportTarget
	}
	// state -> employee -> lines
	data := map[string]map[int64][]line{}
	put := func(state string, emp int64, l line) {
		if data[state] == nil {
			data[state] = map[int64][]line{}
		}
		data[state][emp] = append(data[state][emp], l)
	}
	isState := func(it *model.PayrollItem) bool {
		return it.Type == model.ItemStateTax && (p.State == "" || it.State == p.State) && (p.ItemID == 0 || it.ID == p.ItemID)
	}
	for _, pc := range pcs {
		for _, l := range pc.Lines {
			it := its.get(l.ItemID)
			if !isState(it) {
				continue
			}
			s, w := l.Subject, l.WageBase
			put(it.State, pc.EmployeeID, line{date: pc.CheckDate, num: checkNum(pc), typ: pcType(pc), item: it.Name,
				subject: &s, wageBase: &w, amount: l.Amount, target: target("paycheck", pc.ID)})
		}
	}
	for _, a := range adjs {
		if a.EmployeeID == 0 {
			continue
		}
		for _, l := range a.Lines {
			it := its.get(l.ItemID)
			if !isState(it) {
				continue
			}
			w := l.WageBase
			put(it.State, a.EmployeeID, line{date: a.EffectiveDate, typ: "Tax Adjustment", item: it.Name, wageBase: &w,
				amount: l.Amount, target: target("adjustment", a.ID)})
		}
	}
	var states []string
	for s := range data {
		states = append(states, s)
	}
	sort.Strings(states)
	ty, _, _ := taxes.ForCompany(e.ctx, e.q, taxYearOf(p))
	stateName := func(code string) string {
		if ty != nil {
			if st, ok := ty.States[code]; ok && st.Name != "" {
				return code + " - " + st.Name
			}
		}
		return code
	}
	res := e.newResult("Employee State Taxes Detail", false, labelCol(), col("ssn", "SSN/Tax ID", "text"),
		col("date", "Date", "date"), col("num", "Num", "text"), col("type", "Type", "text"), col("item", "Payroll Item", "text"),
		col("subject", "Income Subject To Tax", "money"), col("wageBase", "Wage Base", "money"), col("amount", "Amount", "money"))
	var grand int64
	for _, st := range states {
		gs := e.group()
		label := stateName(st)
		addRow(res, "section", 0, gs, map[string]any{"label": label})
		ids := map[int64]bool{}
		for id := range data[st] {
			ids[id] = true
		}
		var stSum int64
		for _, m := range sortedEmployees(emps, ids) {
			ge := e.group()
			addRow(res, "section", 1, ge, map[string]any{"label": m.DisplayName, "ssn": e.ssn(m.SSN)})
			rows := data[st][m.ID]
			sort.SliceStable(rows, func(i, j int) bool { return rows[i].date < rows[j].date })
			var sum int64
			for _, l := range rows {
				c := map[string]any{"label": "", "date": l.date, "num": l.num, "type": l.typ, "item": l.item, "amount": dollars(l.amount)}
				if l.subject != nil {
					c["subject"] = dollars(*l.subject)
				}
				if l.wageBase != nil {
					c["wageBase"] = dollars(*l.wageBase)
				}
				r := addRow(res, "data", 2, ge, c)
				r.Target = l.target
				sum += l.amount
			}
			addRow(res, "subtotal", 1, ge, map[string]any{"label": "Total " + m.DisplayName, "amount": dollars(sum)})
			stSum += sum
		}
		addRow(res, "subtotal", 0, gs, map[string]any{"label": "Total " + label, "amount": dollars(stSum)})
		grand += stSum
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": dollars(grand)})
	return res, nil
}

// taxYearOf is the tax table year of a report (the year of its To date).
func taxYearOf(p *Params) int {
	if p.Year > 0 {
		return p.Year
	}
	return 2026
}
