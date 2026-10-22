package reports

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"seriexpayroll/internal/forms"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Form 941 and Form 940 worksheets: the lines of the forms exactly as package
// forms computes them for the Form 941 / Form 940 windows (2026 revisions),
// including the values the user entered and
// saved on the form (lines 5f, 8, 9, 11, deposits, check boxes...), so the
// worksheet always agrees with the form that is filed. Rows: line number,
// description, entry (counts, check boxes, states, texts; "Edited" when the
// user typed the amount), column 1 (inner column) and the amount.

// wsBuilder writes worksheet rows.
type wsBuilder struct {
	e   *env
	res *model.ReportResult
	g   string
}

func (w *wsBuilder) part(title string) {
	w.g = w.e.group()
	addRow(w.res, "section", 0, w.g, map[string]any{"label": title})
}

func (w *wsBuilder) line(line, label string, entry string, col1 *int64, amount *int64) *model.ReportRow {
	c := map[string]any{"label": label, "line": line}
	if entry != "" {
		c["entry"] = entry
	}
	if col1 != nil {
		c["col1"] = dollars(*col1)
	}
	if amount != nil {
		c["amount"] = dollars(*amount)
	}
	return addRow(w.res, "data", 1, w.g, c)
}

func cp(v int64) *int64 { return &v }

func wsColumns() []model.ReportColumn {
	return []model.ReportColumn{col("line", "Line", "text"), labelCol(), col("entry", "Entry", "text"),
		col("col1", "Column 1", "money"), col("amount", "Amount", "money")}
}

var monthNames = []string{"", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

// wsLayout says how the lines of one form are shown.
type wsLayout struct {
	parts  map[string]string // form section -> worksheet part title
	inner  map[string]bool   // money lines printed in the inner column (940 lines 4 and 5)
	hidden func(l model.FormLine) bool
	drills map[string]*model.ReportDrill // line key -> drill-down report
	notes  map[string]string             // form section -> note row shown at the end of the part
}

// Line keys of field groups (check boxes and texts), not numbered lines of the form.
var wsFieldGroups = map[string]bool{"agg": true, "type": true, "designee": true, "sign": true, "preparer": true}

// formLines writes the lines of a computed form, part by part. A part whose
// lines are all hidden is left out unless it has a note.
func (w *wsBuilder) formLines(f *model.TaxForm, lay wsLayout) {
	// lines with a Column 1 and a Column 2 (941 lines 5a-5d) are one row
	col2 := map[string]model.FormLine{}
	for _, l := range f.Lines {
		if l.Col == "2" && l.Kind == "money" {
			col2[l.Key] = l
		}
	}
	var order []string
	bySection := map[string][]model.FormLine{}
	for _, l := range f.Lines {
		if _, ok := bySection[l.Section]; !ok {
			order = append(order, l.Section)
			bySection[l.Section] = nil
		}
		if l.Col == "2" && l.Kind == "money" {
			continue // printed with its Column 1
		}
		if lay.hidden != nil && lay.hidden(l) {
			continue
		}
		if l.Kind == "text" && strings.TrimSpace(l.Text) == "" {
			continue
		}
		if l.Kind == "check" && !l.Checked && ((wsFieldGroups[l.Key] && l.Key != "type") || l.Key == "15b") {
			continue
		}
		bySection[l.Section] = append(bySection[l.Section], l)
	}
	for _, section := range order {
		lines := bySection[section]
		note := lay.notes[section]
		if len(lines) == 0 && note == "" {
			continue
		}
		title := lay.parts[section]
		if title == "" {
			title = section
		}
		w.part(title)
		for _, l := range lines {
			l.Label = strings.TrimPrefix(l.Label, title+": ") // "Type of Return: a. Amended" under "Type of Return"
			w.formLine(l, col2, lay)
		}
		if note != "" {
			w.line("", note, "", nil, nil)
		}
	}
}

// formLine writes one line of a form.
func (w *wsBuilder) formLine(l model.FormLine, col2 map[string]model.FormLine, lay wsLayout) {
	key := l.Key
	if wsFieldGroups[key] {
		key = ""
	}
	label := l.Label
	if l.Key != "" && strings.HasPrefix(label, l.Key+" ") {
		label = strings.TrimPrefix(label, l.Key+" ")
	}
	var entry string
	var c1, amt *int64
	switch l.Kind {
	case "check":
		if l.Checked {
			entry = "X"
		}
	case "count":
		entry = strconv.FormatInt(int64(math.Round(l.Value)), 10)
	case "number":
		entry = strconv.FormatFloat(l.Value, 'f', -1, 64)
	case "text":
		entry = l.Text
	case "money":
		v := store.Cents(l.Value)
		edited := l.Overridden
		switch {
		case l.Col == "1":
			c1 = cp(v)
			if c2, ok := col2[l.Key]; ok {
				amt = cp(store.Cents(c2.Value))
				label = strings.Replace(c2.Label, "Column 2 = ", "", 1)
				edited = edited || c2.Overridden
			}
		case lay.inner[l.Key]:
			c1 = cp(v)
		default:
			amt = cp(v)
		}
		if edited {
			entry = "Edited"
		}
	}
	r := w.line(key, label, entry, c1, amt)
	if d := lay.drills[l.Key]; d != nil && (l.Col == "" || l.Col == "1") {
		r.Drill = d
	}
}

// header writes the filing status and due date of the form.
func (w *wsBuilder) header(f *model.TaxForm) {
	w.part("Filing")
	status := "New"
	switch f.Status {
	case "draft":
		status = "Draft (saved)"
	case "filed":
		status = "Filed"
		if len(f.FiledAt) >= 10 {
			status += " " + mdy(f.FiledAt[:10])
		}
	}
	w.line("", "Status", status, nil, nil)
	if f.DueDate != "" {
		w.line("", "Due date", mdy(f.DueDate), nil, nil)
	}
}

// warnings lists the form's warnings (Check for Errors).
func (w *wsBuilder) warnings(f *model.TaxForm) {
	if len(f.Warnings) == 0 {
		return
	}
	w.part("Warnings")
	for _, s := range f.Warnings {
		w.line("", s, "", nil, nil)
	}
}

// taxItemDrill returns the Payroll Item Detail drill of the item of a tax code.
func (e *env) taxItemDrill(its itemSet, code, from, to string) *model.ReportDrill {
	var best *model.PayrollItem
	for _, it := range its {
		if it.TaxCode != code {
			continue
		}
		if best == nil || (it.Active && !best.Active) || (it.Active == best.Active && it.ID < best.ID) {
			best = it
		}
	}
	if best == nil {
		return nil
	}
	return drill("payroll_item_detail", "itemId", itoa(best.ID), "from", from, "to", to)
}

// extra values of a form computed in this process (forms.Form941/940)
func extraBool(f *model.TaxForm, key string) bool {
	b, _ := f.Extra[key].(bool)
	return b
}

func extraRows(f *model.TaxForm, key string) []map[string]any {
	switch v := f.Extra[key].(type) {
	case []map[string]any:
		return v
	case []any:
		var out []map[string]any
		for _, x := range v {
			if m, ok := x.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	}
	return nil
}

func anyNum(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}

func anyStr(v any) string {
	s, _ := v.(string)
	return s
}

// ---------------------------------------------------------------------------
// Form 941

func form941Worksheet(e *env) (*model.ReportResult, error) {
	p := e.p
	year, q := p.Year, p.Quarter
	from, to := store.QuarterRange(year, q)
	f, err := forms.Form941(e.ctx, e.q, year, q)
	if err != nil {
		return nil, err
	}
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	res := e.newResult("Form 941 Worksheet", false, wsColumns()...)
	res.DateRangeLabel = fmt.Sprintf("Quarter %d, %d (%s)", q, year, DateRangeLabel(from, to))
	res.Params = p.Echo()
	res.Params["year"], res.Params["quarter"] = strconv.Itoa(year), strconv.Itoa(q)
	res.Params["from"], res.Params["to"] = from, to
	w := &wsBuilder{e: e, res: res}
	w.header(f)

	monthly := false
	for i, l := range f.Lines {
		if l.Key == "16" && l.Col == "2" && l.Kind == "check" {
			monthly = l.Checked
		}
		// "Tax liability: Month 1 (July)"
		if l.Key == "16" && len(l.Col) == 2 && l.Col[0] == 'm' && l.Col[1] >= '1' && l.Col[1] <= '3' {
			f.Lines[i].Label += " (" + monthNames[(q-1)*3+int(l.Col[1]-'0')] + ")"
		}
	}
	fit := e.taxItemDrill(its, model.TaxFIT, from, to)
	w.formLines(f, wsLayout{
		parts: map[string]string{
			"Header": "Aggregate Return Filers Only",
			"Part 1": "Part 1: Answer these questions for this quarter.",
			"Part 2": "Part 2: Tell us about your deposit schedule and tax liability for this quarter.",
			"Part 3": "Part 3: Tell us about your business. If a question does NOT apply to your business, leave it blank.",
			"Part 4": "Part 4: May we speak with your third-party designee?",
			"Part 5": "Part 5: Sign here.",
		},
		hidden: func(l model.FormLine) bool {
			// month liabilities only for monthly schedule depositors (box 2)
			return l.Key == "16" && (l.Col == "m1" || l.Col == "m2" || l.Col == "m3" || l.Col == "total") && !monthly
		},
		drills: map[string]*model.ReportDrill{
			"2": fit, "3": fit,
			"5a": e.taxItemDrill(its, model.TaxSSEE, from, to),
			"5c": e.taxItemDrill(its, model.TaxMedEE, from, to),
			"5d": e.taxItemDrill(its, model.TaxAddlMed, from, to),
			"13": drill("payroll_transactions_by_payee", "from", from, "to", to),
		},
	})

	// Schedule B (semiweekly schedule depositors): daily liabilities by check date
	if extraBool(f, "scheduleBRequired") {
		w.part("Schedule B (Form 941): Report of Tax Liability for Semiweekly Schedule Depositors")
		days := extraRows(f, "scheduleB")
		var total int64
		for m := 1; m <= 3; m++ {
			month := (q-1)*3 + m
			var tot int64
			for _, d := range days {
				if int(anyNum(d["month"])) != m {
					continue
				}
				v := store.Cents(anyNum(d["amount"]))
				w.line(fmt.Sprintf("Month %d", m), fmt.Sprintf("Day %d (%s)", int(anyNum(d["day"])), mdy(anyStr(d["date"]))), "", nil, cp(v))
				tot += v
			}
			w.line(fmt.Sprintf("Month %d", m), "Tax liability for Month "+strconv.Itoa(m)+" ("+monthNames[month]+")", "", nil, cp(tot))
			total += tot
		}
		w.line("", "Total liability for the quarter (must equal line 12 on Form 941)", "", nil, cp(total))
	}
	w.warnings(f)
	return res, nil
}

// ---------------------------------------------------------------------------
// Form 940

func form940Worksheet(e *env) (*model.ReportResult, error) {
	p := e.p
	year := p.Year
	from, to := store.YearRange(year)
	f, err := forms.Form940(e.ctx, e.q, year)
	if err != nil {
		return nil, err
	}
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	res := e.newResult("Form 940 Worksheet", false, wsColumns()...)
	res.DateRangeLabel = DateRangeLabel(from, to)
	res.Params = p.Echo()
	res.Params["year"] = strconv.Itoa(year)
	res.Params["from"], res.Params["to"] = from, to
	w := &wsBuilder{e: e, res: res}
	w.header(f)

	part5 := extraBool(f, "part5Required")
	futa := e.taxItemDrill(its, model.TaxFUTA, from, to)
	w.formLines(f, wsLayout{
		parts: map[string]string{
			"Header": "Type of Return",
			"Part 1": "Part 1: Tell us about your return.",
			"Part 2": "Part 2: Determine your FUTA tax before adjustments.",
			"Part 3": "Part 3: Determine your adjustments.",
			"Part 4": "Part 4: Determine your FUTA tax and balance due or overpayment.",
			"Part 5": "Part 5: Report your FUTA tax liability by quarter only if line 12 is more than $500.",
			"Part 6": "Part 6: May we speak with your third-party designee?",
			"Part 7": "Part 7: Sign here.",
		},
		inner: map[string]bool{"4": true, "5": true},
		hidden: func(l model.FormLine) bool {
			return l.Section == "Part 5" && !part5
		},
		notes: part5Note(part5),
		drills: map[string]*model.ReportDrill{
			"8":  futa,
			"13": drill("payroll_transactions_by_payee", "from", from, "to", to),
		},
	})
	// Schedule A (multi-state employers and credit reduction states)
	if extraBool(f, "scheduleARequired") {
		w.part("Schedule A (Form 940): Multi-State Employer and Credit Reduction Information")
		var total int64
		for _, s := range extraRows(f, "scheduleA") {
			st := anyStr(s["state"])
			wages := store.Cents(anyNum(s["futaWages"]))
			rate := anyNum(s["reductionRate"])
			label := st + ": FUTA taxable wages"
			var amt *int64
			if rate > 0 {
				label = fmt.Sprintf("%s: FUTA taxable wages x %s credit reduction rate", st, pct(rate))
				v := store.Cents(anyNum(s["creditReduction"]))
				amt = cp(v)
				total += v
			}
			w.line(st, label, "X", cp(wages), amt)
		}
		w.line("", "Total credit reduction (Form 940 line 11)", "", nil, cp(total))
	}
	w.warnings(f)
	return res, nil
}

// part5Note: Form 940 Part 5 is only required when line 12 is more than $500.
func part5Note(required bool) map[string]string {
	if required {
		return nil
	}
	return map[string]string{"Part 5": "Line 12 is $500 or less: Part 5 is not required."}
}
