package reports

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Params are the resolved parameters of one report run.
//
// Standard query parameters:
//
//	dates=<preset>   date preset key (see ResolvePreset); ignored when from/to are given
//	from, to         YYYY-MM-DD; from "" means "from the beginning" (preset "all")
//	asOf             YYYY-MM-DD for as-of reports (defaults to `to`)
//	basis            "accrual" | "cash" (default: company preference)
//	columns          "total" | "month" | "quarter" | "year" | "week" | "class" | "customer" | "vendor" | "item"
//	accountIds, nameIds, itemIds, classIds   comma separated id filters
//	types            comma separated transaction type codes (model.Tx*)
//	cleared          "" | "cleared" | "uncleared"
//	amountMin, amountMax   absolute amount range
//	memo             memo contains
//	refNumber        number contains
//	q                text search: number, memo or name contains (the Find window's text)
//	includeJobs      "1" to include jobs of nameIds customers (default 1)
//	sortBy           report specific
//	cols             detail reports: comma separated column keys to show
type Params struct {
	Key                  string
	From                 string
	To                   string
	AsOf                 string
	Basis                string
	Columns              string
	FiscalYearStartMonth int
	Today                string
	Filters              Filters
	Values               url.Values
	Prefs                store.Prefs
}

type Filters struct {
	AccountIDs  []int64
	NameIDs     []int64
	ItemIDs     []int64
	ClassIDs    []int64
	Types       []string
	Cleared     string
	AmountMin   *float64
	AmountMax   *float64
	Memo        string
	RefNumber   string
	Text        string // q: number, memo or name contains
	IncludeJobs bool
}

// Str returns a raw query value.
func (p *Params) Str(name string) string { return p.Values.Get(name) }

// ID returns an integer query value (0 when absent).
func (p *Params) ID(name string) int64 {
	n, _ := strconv.ParseInt(p.Values.Get(name), 10, 64)
	return n
}

// IDs parses a comma separated id list.
func (p *Params) IDs(name string) []int64 { return parseIDs(p.Values.Get(name)) }

// Bool is true for "1", "true", "yes".
func (p *Params) Bool(name string) bool {
	switch strings.ToLower(p.Values.Get(name)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// IsCash reports whether the cash basis was requested.
func (p *Params) IsCash() bool { return p.Basis == "cash" }

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
	m["basis"] = p.Basis
	if p.Columns != "" {
		m["columns"] = p.Columns
	}
	return m
}

func parseIDs(s string) []int64 {
	var out []int64
	for _, part := range strings.Split(s, ",") {
		if n, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// ParseParams resolves the query parameters of a report request.
func ParseParams(ctx context.Context, q store.Q, info model.ReportInfo, v url.Values) (*Params, error) {
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	p := &Params{
		Key:                  info.Key,
		Values:               v,
		Prefs:                prefs,
		FiscalYearStartMonth: store.FiscalYearStartMonth(ctx, q),
		Today:                store.Today(),
		Columns:              v.Get("columns"),
	}
	if t := v.Get("today"); t != "" && store.ValidDate(t) {
		p.Today = t
	}
	_, hasFrom := v["from"]
	_, hasTo := v["to"]
	switch {
	case hasFrom || hasTo:
		p.From, p.To = v.Get("from"), v.Get("to")
	default:
		preset := v.Get("dates")
		if preset == "" {
			preset = info.DefaultDates
		}
		if preset == "" {
			preset = "thisMonthToDate"
		}
		p.From, p.To = ResolvePreset(preset, p.Today, p.FiscalYearStartMonth)
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
	p.AsOf = v.Get("asOf")
	if p.AsOf == "" {
		p.AsOf = p.To
	}
	if !store.ValidDate(p.AsOf) {
		return nil, apperr.Validation("asOf", "Invalid date %q", p.AsOf)
	}
	p.Basis = strings.ToLower(v.Get("basis"))
	if p.Basis != "cash" && p.Basis != "accrual" {
		p.Basis = prefs.ReportBasis
		if p.Basis != "cash" {
			p.Basis = "accrual"
		}
	}
	f := &p.Filters
	f.AccountIDs = p.IDs("accountIds")
	f.NameIDs = p.IDs("nameIds")
	f.ItemIDs = p.IDs("itemIds")
	f.ClassIDs = p.IDs("classIds")
	for _, t := range strings.Split(v.Get("types"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			f.Types = append(f.Types, t)
		}
	}
	f.Cleared = v.Get("cleared")
	if s := v.Get("amountMin"); s != "" {
		if x, err := strconv.ParseFloat(s, 64); err == nil {
			f.AmountMin = &x
		}
	}
	if s := v.Get("amountMax"); s != "" {
		if x, err := strconv.ParseFloat(s, 64); err == nil {
			f.AmountMax = &x
		}
	}
	f.Memo = v.Get("memo")
	f.RefNumber = v.Get("refNumber")
	f.Text = strings.TrimSpace(v.Get("q"))
	f.IncludeJobs = v.Get("includeJobs") != "0"
	return p, nil
}

// ---------------------------------------------------------------------------
// Date presets (keep in sync with web/src/util/dates.ts)

// PresetLabels maps preset keys to the labels shown in the Dates drop-down.
var PresetLabels = [][2]string{
	{"all", "All"},
	{"today", "Today"},
	{"thisWeek", "This Week"},
	{"thisWeekToDate", "This Week-to-date"},
	{"thisMonth", "This Month"},
	{"thisMonthToDate", "This Month-to-date"},
	{"thisFiscalQuarter", "This Fiscal Quarter"},
	{"thisFiscalQuarterToDate", "This Fiscal Quarter-to-date"},
	{"thisFiscalYear", "This Fiscal Year"},
	{"thisFiscalYearToDate", "This Fiscal Year-to-date"},
	{"yesterday", "Yesterday"},
	{"lastWeek", "Last Week"},
	{"lastWeekToDate", "Last Week-to-date"},
	{"lastMonth", "Last Month"},
	{"lastMonthToDate", "Last Month-to-date"},
	{"lastFiscalQuarter", "Last Fiscal Quarter"},
	{"lastFiscalQuarterToDate", "Last Fiscal Quarter-to-date"},
	{"lastFiscalYear", "Last Fiscal Year"},
	{"lastFiscalYearToDate", "Last Fiscal Year-to-date"},
	{"nextWeek", "Next Week"},
	{"nextFourWeeks", "Next 4 Weeks"},
	{"nextMonth", "Next Month"},
	{"nextFiscalQuarter", "Next Fiscal Quarter"},
	{"nextFiscalYear", "Next Fiscal Year"},
}

const iso = "2006-01-02"

// FiscalYearStart returns the first day of the fiscal year containing date.
func FiscalYearStart(date string, fyStartMonth int) string {
	t, err := time.Parse(iso, date)
	if err != nil {
		return date
	}
	y := t.Year()
	if int(t.Month()) < fyStartMonth {
		y--
	}
	return time.Date(y, time.Month(fyStartMonth), 1, 0, 0, 0, 0, time.UTC).Format(iso)
}

// ResolvePreset turns a preset key into from/to dates. "all" returns from = "".
// Unknown presets behave like "thisMonthToDate". Weeks start on Sunday.
func ResolvePreset(preset, today string, fyStartMonth int) (string, string) {
	t, err := time.Parse(iso, today)
	if err != nil {
		t = time.Now()
	}
	t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	f := func(x time.Time) string { return x.Format(iso) }
	weekStart := t.AddDate(0, 0, -int(t.Weekday()))
	monthStart := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	fyStart, _ := time.Parse(iso, FiscalYearStart(f(t), fyStartMonth))
	monthsIntoFY := (int(t.Month()) - fyStartMonth + 12) % 12
	qStart := fyStart.AddDate(0, (monthsIntoFY/3)*3, 0)
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
		return f(fyStart), f(fyStart.AddDate(1, 0, -1))
	case "thisFiscalYearToDate":
		return f(fyStart), f(t)
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
		s := fyStart.AddDate(-1, 0, 0)
		return f(s), f(fyStart.AddDate(0, 0, -1))
	case "lastFiscalYearToDate":
		s := fyStart.AddDate(-1, 0, 0)
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
		s := fyStart.AddDate(1, 0, 0)
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
	if ft.Year() == tt.Year() {
		return ft.Format("January 2") + " through " + tt.Format("January 2, 2006")
	}
	return ft.Format("January 2, 2006") + " through " + tt.Format("January 2, 2006")
}

// AsOfLabel: "As of October 17, 2026".
func AsOfLabel(d string) string { return "As of " + longDate(d) }

// BasisLabel returns "Accrual Basis" or "Cash Basis".
func BasisLabel(basis string) string {
	if basis == "cash" {
		return "Cash Basis"
	}
	return "Accrual Basis"
}

// NewResult starts a ReportResult with the standard header fields filled.
// asOf selects the "As of ..." label instead of a date range. withBasis adds the basis label.
func NewResult(ctx context.Context, q store.Q, p *Params, title string, asOf, withBasis bool) *model.ReportResult {
	r := &model.ReportResult{
		Key:         p.Key,
		Title:       title,
		CompanyName: store.CompanyName(ctx, q),
		Rows:        []model.ReportRow{},
		GeneratedAt: store.Now(),
	}
	if asOf {
		r.DateRangeLabel = AsOfLabel(p.AsOf)
	} else {
		r.DateRangeLabel = DateRangeLabel(p.From, p.To)
	}
	if withBasis {
		r.Basis = BasisLabel(p.Basis)
	}
	return r
}

// ---------------------------------------------------------------------------
// Period columns ("Show Columns" by week/month/quarter/year)

type Period struct {
	Key   string // column key, e.g. "p0", "p1"...
	Label string
	From  string
	To    string
}

// Periods splits [from, to] into columns. kind: "week" | "month" | "quarter" | "year".
// Anything else returns a single "total" period. from "" is treated as to's fiscal year start.
// partialPeriodLabel labels a period column cut by the report's From or To
// date with its exact days: "Oct 1 - 19, 26", "Sep 15 - Oct 19, 26".
func partialPeriodLabel(s, e time.Time) string {
	if s.Year() == e.Year() && s.Month() == e.Month() {
		return s.Format("Jan 2") + " - " + e.Format("2, 06")
	}
	return s.Format("Jan 2") + " - " + e.Format("Jan 2, 06")
}

func Periods(from, to, kind string, fyStartMonth int) []Period {
	if from == "" {
		from = FiscalYearStart(to, fyStartMonth)
	}
	ft, err1 := time.Parse(iso, from)
	tt, err2 := time.Parse(iso, to)
	if err1 != nil || err2 != nil || ft.After(tt) {
		return []Period{{Key: "total", Label: "TOTAL", From: from, To: to}}
	}
	var out []Period
	add := func(s, e time.Time, label string) {
		if e.After(tt) {
			e = tt
		}
		out = append(out, Period{Key: fmt.Sprintf("p%d", len(out)), Label: label, From: s.Format(iso), To: e.Format(iso)})
	}
	switch kind {
	case "week":
		s := ft
		for !s.After(tt) && len(out) < 400 {
			e := s.AddDate(0, 0, 6-int(s.Weekday()))
			lbl := s.Format("Jan 2")
			ee := e
			if ee.After(tt) {
				ee = tt
			}
			if ee.Month() == s.Month() {
				lbl += " - " + ee.Format("2, 06")
			} else {
				lbl += " - " + ee.Format("Jan 2, 06")
			}
			add(s, e, lbl)
			s = e.AddDate(0, 0, 1)
		}
	case "month":
		s := ft
		for !s.After(tt) && len(out) < 400 {
			e := time.Date(s.Year(), s.Month()+1, 1, 0, 0, 0, 0, time.UTC).AddDate(0, 0, -1)
			lbl := s.Format("Jan 06")
			if s.Day() != 1 || e.After(tt) {
				ee := e
				if ee.After(tt) {
					ee = tt
				}
				lbl = partialPeriodLabel(s, ee)
			}
			add(s, e, lbl)
			s = e.AddDate(0, 0, 1)
		}
	case "quarter":
		fys, _ := time.Parse(iso, FiscalYearStart(from, fyStartMonth))
		qs := fys
		for qs.AddDate(0, 3, 0).Before(ft) || qs.AddDate(0, 3, 0).Equal(ft) {
			qs = qs.AddDate(0, 3, 0)
		}
		s := ft
		for !s.After(tt) && len(out) < 400 {
			e := qs.AddDate(0, 3, -1)
			ee := e
			if ee.After(tt) {
				ee = tt
			}
			lbl := s.Format("Jan") + " - " + ee.Format("Jan 06")
			if !s.Equal(qs) || e.After(tt) {
				lbl = partialPeriodLabel(s, ee) // cut by the report's From or To date
			}
			add(s, e, lbl)
			qs = qs.AddDate(0, 3, 0)
			s = qs
		}
	case "year":
		fys, _ := time.Parse(iso, FiscalYearStart(from, fyStartMonth))
		s := ft
		for !s.After(tt) && len(out) < 100 {
			e := fys.AddDate(1, 0, -1)
			ee := e
			if ee.After(tt) {
				ee = tt
			}
			lbl := s.Format("Jan") + " - " + ee.Format("Jan 06")
			if !s.Equal(fys) || e.After(tt) {
				lbl = partialPeriodLabel(s, ee)
			}
			add(s, e, lbl)
			fys = fys.AddDate(1, 0, 0)
			s = fys
		}
	default:
		return []Period{{Key: "total", Label: "TOTAL", From: from, To: to}}
	}
	return out
}
