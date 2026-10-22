package reports

import (
	"math"

	"seriexpayroll/internal/model"
)

// Payroll Summary and Employee Earnings Summary share one aggregation of the
// non-voided paychecks (regular and year-to-date entries) by check date plus
// the employees' liability adjustments by effective date.
//
// Signs: wages, additions and employer amounts are
// positive; deductions and taxes withheld are negative, so every column foots:
//
//	Total Gross Pay - Deductions from Gross Pay = Adjusted Gross Pay
//	Adjusted Gross Pay - Taxes Withheld - Deductions from Net Pay + Adjustments to Net Pay = Net Pay (= the checks' net pay)
//
// Gross Pay holds the wage items and the taxable additions; Adjustments to Net
// Pay holds the non-taxable additions (tax tracking "none", e.g. mileage
// reimbursements), the reported tips that were not paid in the check (minus)
// and, for employee liability adjustments of withheld taxes or deductions
// (which change the item totals but not the checks), the offsetting
// "Tax Balance Adjustments" row.

// summary sections
const (
	secGross    = "gross"
	secPreTax   = "pretax"
	secTaxes    = "taxes"
	secPostTax  = "posttax"
	secNetAdj   = "netadj"
	secEmployer = "employer"
)

// special row keys of the Adjustments to Net Pay section
const (
	rowAdjOffset = "adjoffset"
)

// sumCol is one column group: an employee, a period or the total.
type sumCol struct {
	Key   string
	Label string
	Emp   int64 // employee column (0 = any)
	Per   int   // period column index (-1 = any)
}

type sumData struct {
	its     itemSet
	cols    []sumCol
	amt     map[string]map[string]int64   // col key -> row key -> cents (natural positive amounts)
	hours   map[string]map[string]float64 // col key -> row key -> hours
	rates   map[string]map[string]float64 // col key -> item row key -> rate (math.NaN() = several rates)
	used    map[int64]bool                // items with any line or adjustment
	notPaid map[int64]bool                // reported tips items used
	emps    map[int64]bool
}

func (d *sumData) add(colKey, row string, cents int64) {
	m := d.amt[colKey]
	if m == nil {
		m = map[string]int64{}
		d.amt[colKey] = m
	}
	m[row] += cents
}

func (d *sumData) addHours(colKey, row string, h float64) {
	m := d.hours[colKey]
	if m == nil {
		m = map[string]float64{}
		d.hours[colKey] = m
	}
	m[row] += h
}

func (d *sumData) addRate(colKey, row string, r float64) {
	m := d.rates[colKey]
	if m == nil {
		m = map[string]float64{}
		d.rates[colKey] = m
	}
	if old, ok := m[row]; ok && (math.IsNaN(old) || math.Abs(old-r) > 1e-9) {
		m[row] = math.NaN()
		return
	}
	m[row] = r
}

func itemRow(id int64) string { return "i" + itoa(id) }

// section returns the Payroll Summary section of an item.
func section(it *model.PayrollItem, category string) string {
	switch category {
	case model.CatEarning:
		return secGross
	case model.CatAddition:
		if it.TaxTracking == model.TrackNone {
			return secNetAdj
		}
		return secGross
	case model.CatDeduction:
		if isPreTax(it) {
			return secPreTax
		}
		return secPostTax
	case model.CatEmployeeTax:
		return secTaxes
	case model.CatEmployerTax, model.CatContribution:
		return secEmployer
	}
	return ""
}

// sign of an item amount in the report.
func sectionSign(sec string) int64 {
	switch sec {
	case secPreTax, secTaxes, secPostTax:
		return -1
	}
	return 1
}

// loadSummary aggregates the data of the summary reports. mode: "employee",
// "total" or a period kind ("month", "quarter", "year").
func (e *env) loadSummary(mode string) (*sumData, error) {
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
	d := &sumData{its: its, amt: map[string]map[string]int64{}, hours: map[string]map[string]float64{},
		rates: map[string]map[string]float64{}, used: map[int64]bool{}, notPaid: map[int64]bool{}, emps: map[int64]bool{}}
	for _, pc := range pcs {
		d.emps[pc.EmployeeID] = true
	}
	for _, a := range adjs {
		if a.EmployeeID != 0 {
			d.emps[a.EmployeeID] = true
		}
	}
	var periods []Period
	switch mode {
	case "employee":
		all, err := e.employees()
		if err != nil {
			return nil, err
		}
		for _, m := range sortedEmployees(all, d.emps) {
			d.cols = append(d.cols, sumCol{Key: "e" + itoa(m.ID), Label: m.DisplayName, Emp: m.ID, Per: -1})
		}
	case "month", "quarter", "year":
		periods = Periods(e.periodsFrom(), p.To, mode)
		for i, pr := range periods {
			d.cols = append(d.cols, sumCol{Key: pr.Key, Label: pr.Label, Per: i})
		}
	}
	d.cols = append(d.cols, sumCol{Key: "total", Label: "TOTAL", Per: -1})

	colsOf := func(emp int64, date string) []string {
		out := []string{}
		pi := -1
		if periods != nil {
			pi = periodOf(periods, date)
		}
		for _, c := range d.cols {
			if c.Emp != 0 && c.Emp != emp {
				continue
			}
			if c.Per >= 0 && c.Per != pi {
				continue
			}
			out = append(out, c.Key)
		}
		return out
	}
	for _, pc := range pcs {
		keys := colsOf(pc.EmployeeID, pc.CheckDate)
		for _, l := range pc.Lines {
			it := its.get(l.ItemID)
			if section(it, l.Category) == "" {
				continue
			}
			d.used[it.ID] = true
			row := itemRow(it.ID)
			for _, k := range keys {
				d.add(k, row, l.Amount)
				if l.Category == model.CatEarning && it.NotPaid {
					d.add(k, "np"+itoa(it.ID), l.Amount)
				}
				if l.Category == model.CatEarning && isHoursItem(it) && l.Qty != nil {
					d.addHours(k, row, *l.Qty)
				}
				if l.Rate != nil && (it.Type == model.ItemHourly || it.Type == model.ItemOvertime) && l.Amount != 0 {
					d.addRate(k, row, *l.Rate)
				}
			}
			if l.Category == model.CatEarning && it.NotPaid {
				d.notPaid[it.ID] = true
			}
		}
	}
	for _, a := range adjs {
		if a.EmployeeID == 0 {
			continue // company adjustments have no employee: Payroll Liability Balances shows them
		}
		keys := colsOf(a.EmployeeID, a.EffectiveDate)
		for _, l := range a.Lines {
			if l.Amount == 0 {
				continue
			}
			it := its.get(l.ItemID)
			cat := model.ItemCategory(it.Type, it.TaxCode)
			sec := section(it, cat)
			if sec == "" {
				continue
			}
			d.used[it.ID] = true
			for _, k := range keys {
				d.add(k, itemRow(it.ID), l.Amount)
				if sec == secTaxes || sec == secPreTax || sec == secPostTax {
					d.add(k, rowAdjOffset, l.Amount)
				}
			}
		}
	}
	return d, nil
}

// sectionItems returns the used items of a section in the order of the Payroll Items window.
func (d *sumData) sectionItems(sec string) []*model.PayrollItem {
	var list []*model.PayrollItem
	for id := range d.used {
		it := d.its.get(id)
		if section(it, model.ItemCategory(it.Type, it.TaxCode)) == sec && d.active(id) {
			list = append(list, it)
		}
	}
	sortItems(list)
	return list
}

// active reports whether an item has an amount or hours in any column
// (items whose lines are all zero, e.g. a capped tax, are not listed).
func (d *sumData) active(id int64) bool {
	row := itemRow(id)
	for _, c := range d.cols {
		if d.amt[c.Key][row] != 0 || d.hours[c.Key][row] != 0 {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Payroll Summary

func payrollSummary(e *env) (*model.ReportResult, error) {
	p := e.p
	mode := p.Columns
	switch mode {
	case "", "employee", "employees":
		mode = "employee"
	case "total", "month", "quarter", "year":
	default:
		mode = "employee"
	}
	d, err := e.loadSummary(mode)
	if err != nil {
		return nil, err
	}
	var cols []model.ReportColumn
	cols = append(cols, labelCol())
	for _, c := range d.cols {
		lbl := c.Label
		cols = append(cols, col(c.Key+"_hours", lbl+" Hours", "number"))
		if c.Emp != 0 {
			cols = append(cols, col(c.Key+"_rate", lbl+" Rate", "money"))
		}
		cols = append(cols, col(c.Key+"_amount", lbl+" Amount", "money"))
	}
	res := e.newResult("Payroll Summary", false, cols...)

	type tot map[string]int64 // col key -> cents (signed as shown)
	type hrs map[string]float64
	sumOf := func(rows ...tot) tot {
		out := tot{}
		for _, r := range rows {
			for k, v := range r {
				out[k] += v
			}
		}
		return out
	}
	cells := func(label string, v tot, h hrs) map[string]any {
		c := map[string]any{"label": label}
		for _, cl := range d.cols {
			c[cl.Key+"_amount"] = dollars(v[cl.Key])
			if h != nil {
				c[cl.Key+"_hours"] = round4(h[cl.Key])
			}
		}
		return c
	}
	itemDrill := func(it *model.PayrollItem) *model.ReportDrill {
		kv := []string{"itemId", itoa(it.ID), "from", p.From, "to", p.To}
		if p.EmployeeID > 0 {
			kv = append(kv, "employeeId", itoa(p.EmployeeID))
		}
		return drill("payroll_item_detail", kv...)
	}
	// item rows of a section; returns the section total and hours
	itemRows := func(sec string, level int, g string) (tot, hrs, bool) {
		list := d.sectionItems(sec)
		sign := sectionSign(sec)
		total, hours := tot{}, hrs{}
		any := false
		for _, it := range list {
			row := itemRow(it.ID)
			v := tot{}
			var h hrs
			nonzero := false
			for _, cl := range d.cols {
				v[cl.Key] = sign * d.amt[cl.Key][row]
				if v[cl.Key] != 0 {
					nonzero = true
				}
			}
			if sec == secGross && isHoursItem(it) {
				h = hrs{}
				for _, cl := range d.cols {
					h[cl.Key] = d.hours[cl.Key][row]
					hours[cl.Key] += h[cl.Key]
					if h[cl.Key] != 0 {
						nonzero = true
					}
				}
			}
			if !nonzero {
				continue
			}
			any = true
			c := cells(it.Name, v, h)
			if h == nil {
				for _, cl := range d.cols {
					delete(c, cl.Key+"_hours")
				}
			}
			for _, cl := range d.cols {
				if cl.Emp == 0 {
					continue
				}
				if r, ok := d.rates[cl.Key][row]; ok && !math.IsNaN(r) {
					c[cl.Key+"_rate"] = r
				}
			}
			// amounts zoom to the item's transactions (a target would open the item instead)
			r := addRow(res, "data", level, g, c)
			r.Drill = itemDrill(it)
			total = sumOf(total, v)
		}
		return total, hours, any
	}
	// a titled section with its items and "Total <title>"; nothing when empty
	block := func(sec, title string, level int) (tot, hrs, bool) {
		g := e.group()
		start := len(res.Rows)
		addRow(res, "section", level, g, map[string]any{"label": title})
		v, h, ok := itemRows(sec, level+1, g)
		if !ok {
			res.Rows = res.Rows[:start]
			return tot{}, hrs{}, false
		}
		var hh hrs
		if sec == secGross {
			hh = h
		}
		addRow(res, "subtotal", level, g, cells("Total "+title, v, hh))
		return v, h, true
	}

	gEW := e.group()
	addRow(res, "section", 0, gEW, map[string]any{"label": "Employee Wages, Taxes and Adjustments"})
	gross, _, _ := block(secGross, "Gross Pay", 1)
	pre, _, _ := block(secPreTax, "Deductions from Gross Pay", 1)
	agp := sumOf(gross, pre)
	addRow(res, "total", 1, gEW, cells("Adjusted Gross Pay", agp, nil))
	taxes, _, _ := block(secTaxes, "Taxes Withheld", 1)
	post, _, _ := block(secPostTax, "Deductions from Net Pay", 1)

	// Adjustments to Net Pay: non-taxable additions, reported tips not paid, liability adjustments
	gNA := e.group()
	startNA := len(res.Rows)
	addRow(res, "section", 1, gNA, map[string]any{"label": "Adjustments to Net Pay"})
	netAdj, _, okNA := itemRows(secNetAdj, 2, gNA)
	var npList []*model.PayrollItem
	for id := range d.notPaid {
		npList = append(npList, d.its.get(id))
	}
	sortItems(npList)
	for _, it := range npList {
		v := tot{}
		nz := false
		for _, cl := range d.cols {
			v[cl.Key] = -d.amt[cl.Key]["np"+itoa(it.ID)]
			nz = nz || v[cl.Key] != 0
		}
		if !nz {
			continue
		}
		okNA = true
		r := addRow(res, "data", 2, gNA, cells(it.Name+" (not paid in the paycheck)", v, nil))
		r.Drill = itemDrill(it)
		netAdj = sumOf(netAdj, v)
	}
	{
		v := tot{}
		nz := false
		for _, cl := range d.cols {
			v[cl.Key] = d.amt[cl.Key][rowAdjOffset]
			nz = nz || v[cl.Key] != 0
		}
		if nz {
			okNA = true
			r := addRow(res, "data", 2, gNA, cells("Tax Balance Adjustments (not in paychecks)", v, nil))
			r.Drill = drill("payroll_transactions_by_payee", "from", p.From, "to", p.To)
			netAdj = sumOf(netAdj, v)
		}
	}
	if okNA {
		addRow(res, "subtotal", 1, gNA, cells("Total Adjustments to Net Pay", netAdj, nil))
	} else {
		res.Rows = res.Rows[:startNA]
	}
	net := sumOf(agp, taxes, post, netAdj)
	r := addRow(res, "total", 1, gEW, cells("Net Pay", net, nil))
	r.Drill = drill("payroll_register", "from", p.From, "to", p.To)

	gER := e.group()
	startER := len(res.Rows)
	addRow(res, "section", 0, gER, map[string]any{"label": "Employer Taxes and Contributions"})
	er, _, okER := itemRows(secEmployer, 1, gER)
	if okER {
		addRow(res, "subtotal", 0, gER, cells("Total Employer Taxes and Contributions", er, nil))
	} else {
		res.Rows = res.Rows[:startER]
	}
	return res, nil
}

// ---------------------------------------------------------------------------
// Employee Earnings Summary

func employeeEarningsSummary(e *env) (*model.ReportResult, error) {
	d, err := e.loadSummary("employee")
	if err != nil {
		return nil, err
	}
	var order []*model.PayrollItem
	secOf := map[int64]string{}
	for _, sec := range []string{secGross, secPreTax, secTaxes, secPostTax, secNetAdj, secEmployer} {
		for _, it := range d.sectionItems(sec) {
			order = append(order, it)
			secOf[it.ID] = sec
		}
	}
	cols := []model.ReportColumn{col("label", "Employee", "text")}
	for _, it := range order {
		cols = append(cols, col(itemRow(it.ID), it.Name, "money"))
	}
	res := e.newResult("Employee Earnings Summary", false, cols...)
	totals := map[string]int64{}
	for _, c := range d.cols {
		if c.Emp == 0 {
			continue
		}
		cells := map[string]any{"label": c.Label}
		for _, it := range order {
			row := itemRow(it.ID)
			v := sectionSign(secOf[it.ID]) * d.amt[c.Key][row]
			cells[row] = dollars(v)
			totals[row] += v
		}
		// amounts zoom to the employee's Payroll Summary (a target would open the employee instead)
		r := addRow(res, "data", 0, "", cells)
		r.Drill = drill("payroll_summary", "employeeId", itoa(c.Emp), "from", e.p.From, "to", e.p.To)
	}
	cells := map[string]any{"label": "TOTAL"}
	for _, it := range order {
		cells[itemRow(it.ID)] = dollars(totals[itemRow(it.ID)])
	}
	addRow(res, "grandtotal", 0, "", cells)
	return res, nil
}
