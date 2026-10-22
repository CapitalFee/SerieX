package reports

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Params are the resolved parameters of one report run.
//
// Query parameters (same names as SerieX Books where they exist):
//
//	dates=<preset>   date preset key (see ResolvePreset); ignored when from/to are given
//	from, to         YYYY-MM-DD; from "" means "from the beginning" (preset "all")
//	asOf             YYYY-MM-DD for as-of reports (defaults to `to`)
//	columns          payroll_summary: employee (default) | total | month | quarter | year
//	                 payroll_liability_balances: month (default) | quarter | year | total
//	employeeId       only this employee
//	itemId           only this payroll item
//	year, quarter    tax form worksheets (default: the year / quarter of `to`)
//	state            employee_state_taxes_detail: only this state
//	active           list reports: active (default) | all | inactive
//	includeVoided    detail reports: 1 lists voided paychecks and payments (zero amounts)
//	differences      payroll_detail_review: 1 shows only lines whose amount was changed by hand
//	paidFor          payroll_item_detail: 1 selects tax payments by the period they pay
//	                 (period end) instead of their date (drill-down from Liability Balances)
//
// Payroll is calendar-year based: the fiscal presets of SerieX Books resolve
// to calendar quarters and years here (fiscal year start month = January).
type Params struct {
	Key        string
	From       string
	To         string
	AsOf       string
	Columns    string
	Today      string
	EmployeeID int64
	ItemID     int64
	Year       int
	Quarter    int
	State      string
	Values     url.Values
	Prefs      model.PayrollPrefs
}

// Str returns a raw query value.
func (p *Params) Str(name string) string { return p.Values.Get(name) }

// Bool is true for "1", "true", "yes".
func (p *Params) Bool(name string) bool {
	switch strings.ToLower(p.Values.Get(name)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// Echo returns the resolved parameters for ReportResult.Params.
func (p *Params) Echo() map[string]string {
	m := map[string]string{}
	for k, v := range p.Values {
		if len(v) > 0 {
			m[k] = v[0]
		}
	}
	m["from"] = p.From
	m["to"] = p.To
	m["asOf"] = p.AsOf
	if p.Columns != "" {
		m["columns"] = p.Columns
	}
	return m
}

// presetAliases maps the calendar preset names payroll uses to the
// SerieX Books preset keys (payroll quarters and years are calendar periods).
var presetAliases = map[string]string{
	"thisQuarter":         "thisFiscalQuarter",
	"thisQuarterToDate":   "thisFiscalQuarterToDate",
	"thisYear":            "thisFiscalYear",
	"thisYearToDate":      "thisFiscalYearToDate",
	"lastQuarter":         "lastFiscalQuarter",
	"lastQuarterToDate":   "lastFiscalQuarterToDate",
	"lastYear":            "lastFiscalYear",
	"lastYearToDate":      "lastFiscalYearToDate",
	"nextQuarter":         "nextFiscalQuarter",
	"nextYear":            "nextFiscalYear",
	"thisCalendarQuarter": "thisFiscalQuarter",
	"thisCalendarYear":    "thisFiscalYear",
	"lastCalendarQuarter": "lastFiscalQuarter",
	"lastCalendarYear":    "lastFiscalYear",
}

// ParseParams resolves the query parameters of a report request.
func ParseParams(ctx context.Context, q store.Q, info model.ReportInfo, v url.Values) (*Params, error) {
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	p := &Params{
		Key:     info.Key,
		Values:  v,
		Prefs:   prefs,
		Today:   store.Today(),
		Columns: strings.ToLower(strings.TrimSpace(v.Get("columns"))),
	}
	if t := v.Get("today"); t != "" && store.ValidDate(t) {
		p.Today = t
	}
	_, hasFrom := v["from"]
	_, hasTo := v["to"]
	switch {
	case hasFrom || hasTo:
		p.From, p.To = strings.TrimSpace(v.Get("from")), strings.TrimSpace(v.Get("to"))
	default:
		preset := v.Get("dates")
		if preset == "" {
			preset = info.DefaultDates
		}
		if preset == "" {
			preset = "thisMonthToDate"
		}
		p.From, p.To = ResolvePreset(preset, p.Today)
	}
	if p.From != "" && !store.ValidDate(p.From) {
		return nil, apperr.Validation("from", "Invalid From date %q", p.From)
	}
	if p.To == "" {
		p.To = p.Today
		if v.Get("dates") == "all" || (hasFrom && v.Get("to") == "") {
			p.To = "9999-12-31"
		}
	}
	if !store.ValidDate(p.To) {
		return nil, apperr.Validation("to", "Invalid To date %q", p.To)
	}
	if p.From != "" && p.From > p.To {
		return nil, apperr.Validation("from", "The From date must be on or before the To date.")
	}
	p.AsOf = strings.TrimSpace(v.Get("asOf"))
	if p.AsOf == "" {
		p.AsOf = p.To
		if p.AsOf >= "9999-12-31" {
			p.AsOf = p.Today
		}
	}
	if !store.ValidDate(p.AsOf) {
		return nil, apperr.Validation("asOf", "Invalid date %q", p.AsOf)
	}
	if s := v.Get("employeeId"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			return nil, apperr.Validation("employeeId", "Invalid employee %q", s)
		}
		p.EmployeeID = n
	}
	if s := v.Get("itemId"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n < 0 {
			return nil, apperr.Validation("itemId", "Invalid payroll item %q", s)
		}
		p.ItemID = n
	}
	// tax form worksheets: year / quarter (default: those of the To date)
	p.Year = store.Year(p.To)
	if p.To >= "9999-12-31" {
		p.Year = store.Year(p.Today)
	}
	p.Quarter = store.Quarter(p.To)
	if p.To >= "9999-12-31" {
		p.Quarter = store.Quarter(p.Today)
	}
	if s := v.Get("year"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1900 || n > 2999 {
			return nil, apperr.Validation("year", "Invalid year %q", s)
		}
		p.Year = n
	}
	if s := v.Get("quarter"); s != "" {
		n, err := strconv.Atoi(strings.TrimPrefix(strings.ToUpper(s), "Q"))
		if err != nil || n < 1 || n > 4 {
			return nil, apperr.Validation("quarter", "The quarter must be 1, 2, 3 or 4.")
		}
		p.Quarter = n
	}
	p.State = strings.ToUpper(strings.TrimSpace(v.Get("state")))
	return p, nil
}

// ---------------------------------------------------------------------------
// Date presets (same keys and logic as SerieX Books, with the fiscal year
// starting in January: payroll quarters and years are calendar periods; the
// labels are the client's, web/src/util/dates.ts)

const iso = "2006-01-02"

// ResolvePreset turns a preset key into from/to dates. "all" returns from = "".
// Unknown presets behave like "thisMonthToDate". Weeks start on Sunday.
func ResolvePreset(preset, today string) (string, string) {
	if a, ok := presetAliases[preset]; ok {
		preset = a
	}
	t, err := time.Parse(iso, today)
	if err != nil {
		t = time.Now()
	}
	t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	f := func(x time.Time) string { return x.Format(iso) }
	weekStart := t.AddDate(0, 0, -int(t.Weekday()))
	monthStart := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	yStart := time.Date(t.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	qStart := time.Date(t.Year(), time.Month((int(t.Month())-1)/3*3+1), 1, 0, 0, 0, 0, time.UTC)
	switch preset {
	case "all":
		return "", f(t)
	case "today":
		return f(t), f(t)
	case "yesterday":
		y := t.AddDate(0, 0, -1)
		return f(y), f(y)
	case "thisWeek":
		return f(weekStart), f(weekStart.AddDate(0, 0, 6))
	case "thisWeekToDate":
		return f(weekStart), f(t)
	case "thisMonth":
		return f(monthStart), f(monthStart.AddDate(0, 1, -1))
	case "thisFiscalQuarter":
		return f(qStart), f(qStart.AddDate(0, 3, -1))
	case "thisFiscalQuarterToDate":
		return f(qStart), f(t)
	case "thisFiscalYear":
		return f(yStart), f(yStart.AddDate(1, 0, -1))
	case "thisFiscalYearToDate":
		return f(yStart), f(t)
	case "lastWeek":
		s := weekStart.AddDate(0, 0, -7)
		return f(s), f(s.AddDate(0, 0, 6))
	case "lastWeekToDate":
		s := weekStart.AddDate(0, 0, -7)
		return f(s), f(t.AddDate(0, 0, -7))
	case "lastMonth":
		s := monthStart.AddDate(0, -1, 0)
		return f(s), f(monthStart.AddDate(0, 0, -1))
	case "lastMonthToDate":
		s := monthStart.AddDate(0, -1, 0)
		e := t.AddDate(0, -1, 0)
		if e.Month() != s.Month() {
			e = monthStart.AddDate(0, 0, -1)
		}
		return f(s), f(e)
	case "lastFiscalQuarter":
		s := qStart.AddDate(0, -3, 0)
		return f(s), f(qStart.AddDate(0, 0, -1))
	case "lastFiscalQuarterToDate":
		s := qStart.AddDate(0, -3, 0)
		return f(s), f(t.AddDate(0, -3, 0))
	case "lastFiscalYear":
		s := yStart.AddDate(-1, 0, 0)
		return f(s), f(yStart.AddDate(0, 0, -1))
	case "lastFiscalYearToDate":
		s := yStart.AddDate(-1, 0, 0)
		return f(s), f(t.AddDate(-1, 0, 0))
	case "nextWeek":
		s := weekStart.AddDate(0, 0, 7)
		return f(s), f(s.AddDate(0, 0, 6))
	case "nextFourWeeks":
		s := weekStart.AddDate(0, 0, 7)
		return f(s), f(s.AddDate(0, 0, 27))
	case "nextMonth":
		s := monthStart.AddDate(0, 1, 0)
		return f(s), f(s.AddDate(0, 1, -1))
	case "nextFiscalQuarter":
		s := qStart.AddDate(0, 3, 0)
		return f(s), f(s.AddDate(0, 3, -1))
	case "nextFiscalYear":
		s := yStart.AddDate(1, 0, 0)
		return f(s), f(s.AddDate(1, 0, -1))
	default: // thisMonthToDate
		return f(monthStart), f(t)
	}
}

// ---------------------------------------------------------------------------
// Labels and result construction

func longDate(d string) string {
	t, err := time.Parse(iso, d)
	if err != nil {
		return d
	}
	return t.Format("January 2, 2006")
}

// DateRangeLabel: "January 1 through October 17, 2026", "All Transactions" when from is "".
func DateRangeLabel(from, to string) string {
	if from == "" {
		if to == "" || to >= "9999-12-31" {
			return "All Transactions"
		}
		return "All Transactions through " + longDate(to)
	}
	ft, err1 := time.Parse(iso, from)
	tt, err2 := time.Parse(iso, to)
	if err1 != nil || err2 != nil {
		return from + " through " + to
	}
	if from == to {
		return longDate(to)
	}
	if to >= "9999-12-31" {
		return "From " + longDate(from)
	}
	if ft.Year() == tt.Year() {
		return ft.Format("January 2") + " through " + tt.Format("January 2, 2006")
	}
	return ft.Format("January 2, 2006") + " through " + tt.Format("January 2, 2006")
}

// AsOfLabel: "As of October 17, 2026".
func AsOfLabel(d string) string { return "As of " + longDate(d) }

// newResult starts a ReportResult with the standard header fields filled.
// asOf selects the "As of ..." label instead of a date range.
func (e *env) newResult(title string, asOf bool, cols ...model.ReportColumn) *model.ReportResult {
	r := &model.ReportResult{
		Key:         e.p.Key,
		Title:       title,
		CompanyName: store.CompanyName(e.ctx, e.q),
		Columns:     cols,
		Rows:        []model.ReportRow{},
		GeneratedAt: store.Now(),
	}
	if asOf {
		r.DateRangeLabel = AsOfLabel(e.p.AsOf)
	} else {
		r.DateRangeLabel = DateRangeLabel(e.p.From, e.p.To)
	}
	return r
}

// ---------------------------------------------------------------------------
// Period columns ("Show Columns" by week/month/quarter/year)

type Period struct {
	Key   string // column key prefix, e.g. "p0", "p1"...
	Label string
	From  string
	To    string
}

// Periods splits [from, to] into calendar months / quarters / years. from ""
// is treated as January 1 of to's year. Anything else returns nil.
func Periods(from, to, kind string) []Period {
	if from == "" {
		from = fmt.Sprintf("%04d-01-01", store.Year(to))
	}
	ft, err1 := time.Parse(iso, from)
	tt, err2 := time.Parse(iso, to)
	if err1 != nil || err2 != nil || ft.After(tt) {
		return nil
	}
	var out []Period
	add := func(s, e time.Time, label string) {
		if e.After(tt) {
			e = tt
		}
		out = append(out, Period{Key: fmt.Sprintf("p%d", len(out)), Label: label, From: s.Format(iso), To: e.Format(iso)})
	}
	s := ft
	for !s.After(tt) && len(out) < 400 {
		var e time.Time
		switch kind {
		case "month":
			e = time.Date(s.Year(), s.Month()+1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
		case "quarter":
			qs := time.Date(s.Year(), time.Month((int(s.Month())-1)/3*3+1), 1, 0, 0, 0, 0, time.UTC)
			e = qs.AddDate(0, 3, -1)
		case "year":
			e = time.Date(s.Year(), 12, 31, 0, 0, 0, 0, time.UTC)
		default:
			return nil
		}
		ee := e
		if ee.After(tt) {
			ee = tt
		}
		add(s, e, periodLabel(s.Format(iso), ee.Format(iso)))
		s = e.AddDate(0, 0, 1)
	}
	return out
}

// periodLabel is the column title of a period ("Jan 26", "Jan - Mar 26", "Jan 1 - Oct 17, 26").
func periodLabel(from, to string) string {
	if from == "" {
		return "TOTAL"
	}
	ft, err1 := time.Parse(iso, from)
	tt, err2 := time.Parse(iso, to)
	if err1 != nil || err2 != nil {
		return "TOTAL"
	}
	if from == to {
		return tt.Format("Jan 2, 06")
	}
	if ft.Year() == tt.Year() {
		if ft.Day() == 1 && tt.AddDate(0, 0, 1).Day() == 1 {
			if ft.Month() == tt.Month() {
				return tt.Format("Jan 06")
			}
			return ft.Format("Jan") + " - " + tt.Format("Jan 06")
		}
		return ft.Format("Jan 2") + " - " + tt.Format("Jan 2, 06")
	}
	return ft.Format("Jan 2, 06") + " - " + tt.Format("Jan 2, 06")
}

// periodOf returns the index of the period containing date (-1 when none).
func periodOf(ps []Period, date string) int {
	for i, pr := range ps {
		if (pr.From == "" || date >= pr.From) && date <= pr.To {
			return i
		}
	}
	return -1
}

// inRange reports whether date is in [from, to] (from "" = no lower bound).
func inRange(date, from, to string) bool {
	return (from == "" || date >= from) && date <= to
}
