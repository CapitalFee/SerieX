package liabilities

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// ---------------------------------------------------------------------------
// Legal holidays and business days

// holidayCache: "<year>/<dc>" -> set of observed holiday dates (YYYY-MM-DD).
var holidayCache sync.Map

// observed moves a holiday that falls on a Saturday to the Friday before and
// one that falls on a Sunday to the Monday after (5 U.S.C. 6103, EO 11582).
func observed(t time.Time) time.Time {
	switch t.Weekday() {
	case time.Saturday:
		return t.AddDate(0, 0, -1)
	case time.Sunday:
		return t.AddDate(0, 0, 1)
	}
	return t
}

func nthWeekday(year int, month time.Month, wd time.Weekday, n int) time.Time {
	t := time.Date(year, month, 1, 0, 0, 0, 0, time.UTC)
	for t.Weekday() != wd {
		t = t.AddDate(0, 0, 1)
	}
	return t.AddDate(0, 0, 7*(n-1))
}

func lastWeekday(year int, month time.Month, wd time.Weekday) time.Time {
	t := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC)
	for t.Weekday() != wd {
		t = t.AddDate(0, 0, -1)
	}
	return t
}

// holidaysOf returns the observed US federal legal holidays of a year. With dc
// it adds the District of Columbia legal holidays the IRS also counts for
// federal tax deposits (Pub 15 "Legal holiday"): DC Emancipation Day and
// Inauguration Day. New Year's Day of `year` observed on December 31 of the
// year before is part of this year's set (callers look at year and year+1).
func holidaysOf(year int, dc bool) map[string]bool {
	key := fmt.Sprintf("%d/%v", year, dc)
	if v, ok := holidayCache.Load(key); ok {
		return v.(map[string]bool)
	}
	m := map[string]bool{}
	add := func(t time.Time) { m[t.Format("2006-01-02")] = true }
	day := func(mo time.Month, d int) time.Time { return time.Date(year, mo, d, 0, 0, 0, 0, time.UTC) }
	add(observed(day(time.January, 1)))                  // New Year's Day
	add(nthWeekday(year, time.January, time.Monday, 3))  // Birthday of Martin Luther King, Jr.
	add(nthWeekday(year, time.February, time.Monday, 3)) // Washington's Birthday
	add(lastWeekday(year, time.May, time.Monday))        // Memorial Day
	if year >= 2021 {
		add(observed(day(time.June, 19))) // Juneteenth National Independence Day
	}
	add(observed(day(time.July, 4)))                       // Independence Day
	add(nthWeekday(year, time.September, time.Monday, 1))  // Labor Day
	add(nthWeekday(year, time.October, time.Monday, 2))    // Columbus Day
	add(observed(day(time.November, 11)))                  // Veterans Day
	add(nthWeekday(year, time.November, time.Thursday, 4)) // Thanksgiving Day
	add(observed(day(time.December, 25)))                  // Christmas Day
	if dc {
		if year >= 2005 {
			add(observed(day(time.April, 16))) // DC Emancipation Day
		}
		if year%4 == 1 { // Inauguration Day (a Sunday inauguration is observed Monday)
			t := day(time.January, 20)
			if t.Weekday() == time.Sunday {
				t = t.AddDate(0, 0, 1)
			}
			add(t)
		}
	}
	holidayCache.Store(key, m)
	return m
}

// isHoliday reports whether t is an observed legal holiday.
func isHoliday(t time.Time, dc bool) bool {
	d := t.Format("2006-01-02")
	return holidaysOf(t.Year(), dc)[d] || holidaysOf(t.Year()+1, dc)[d]
}

func isBusinessDay(t time.Time, dc bool) bool {
	if wd := t.Weekday(); wd == time.Saturday || wd == time.Sunday {
		return false
	}
	return !isHoliday(t, dc)
}

// nextBusinessDay returns t when it is a business day, else the next one.
func nextBusinessDay(t time.Time, dc bool) time.Time {
	for !isBusinessDay(t, dc) {
		t = t.AddDate(0, 0, 1)
	}
	return t
}

// addBusinessDays returns the n-th business day after t.
func addBusinessDays(t time.Time, n int, dc bool) time.Time {
	for i := 0; i < n; i++ {
		t = t.AddDate(0, 0, 1)
		for !isBusinessDay(t, dc) {
			t = t.AddDate(0, 0, 1)
		}
	}
	return t
}

// isFederalGroup: federal deposits use the IRS (District of Columbia) legal holidays.
func isFederalGroup(group string) bool {
	return group == model.GroupFederal941 || group == model.GroupFederal940
}

// ---------------------------------------------------------------------------
// Payment frequencies, periods and due dates

var frequencies = []string{model.PayFreqSemiweekly, model.PayFreqMonthly, model.PayFreqQuarterly,
	model.PayFreqAnnually, model.PayFreqAfterPayroll}

func validFrequency(f string) bool {
	for _, v := range frequencies {
		if v == f {
			return true
		}
	}
	return false
}

// defaultSchedule is the payment frequency and method of a payment group
// without a stored schedule (the same defaults Payroll Setup creates).
func defaultSchedule(group, deposit string) (freq, method string) {
	switch {
	case group == model.GroupFederal941:
		if deposit == model.PayFreqSemiweekly {
			return model.PayFreqSemiweekly, "e-pay"
		}
		return model.PayFreqMonthly, "e-pay"
	case group == model.GroupFederal940:
		return model.PayFreqQuarterly, "e-pay"
	case strings.HasPrefix(group, "state_wh:"):
		return model.PayFreqMonthly, "e-pay"
	case strings.HasPrefix(group, "state_ui:"):
		return model.PayFreqQuarterly, "e-pay"
	}
	return model.PayFreqAfterPayroll, "check"
}

// periodOf returns the liability period of a payment frequency that contains
// date: calendar month / quarter / year; semiweekly and after-payroll groups
// use every check date as its own period.
func periodOf(freq, date string) (string, string) {
	switch freq {
	case model.PayFreqMonthly:
		return date[:8] + "01", store.LastDayOfMonth(date)
	case model.PayFreqQuarterly:
		return store.QuarterRange(store.Year(date), store.Quarter(date))
	case model.PayFreqAnnually:
		return store.YearRange(store.Year(date))
	}
	return date, date
}

// dueDate is DueDate on parsed dates.
func dueDate(group, frequency string, end time.Time) time.Time {
	dc := isFederalGroup(group)
	var due time.Time
	switch frequency {
	case model.PayFreqSemiweekly:
		// Paydays Wednesday-Friday form one deposit period (closing Friday),
		// Saturday-Tuesday the other (closing Tuesday). The deposit is due 3
		// business days after the period closes: the following Wednesday or
		// Friday, plus one day for each legal holiday among those 3 weekdays (Pub 15).
		var toClose int
		switch end.Weekday() {
		case time.Wednesday:
			toClose = 2
		case time.Thursday:
			toClose = 1
		case time.Friday:
			toClose = 0
		case time.Saturday:
			toClose = 3
		case time.Sunday:
			toClose = 2
		case time.Monday:
			toClose = 1
		case time.Tuesday:
			toClose = 0
		}
		return addBusinessDays(end.AddDate(0, 0, toClose), 3, dc)
	case model.PayFreqMonthly:
		// 15th of the following month
		due = time.Date(end.Year(), end.Month()+1, 15, 0, 0, 0, 0, time.UTC)
	case model.PayFreqQuarterly:
		// last day of the month after the quarter; state groups follow the
		// state's quarterly return (taxes.StateQuarterlyDue, also used by the
		// state report due dates of forms)
		if state := groupState(group); state != "" {
			d, moves := taxes.StateQuarterlyDue(state, end)
			if !moves {
				return d
			}
			due = d
			break
		}
		qEnd := ((int(end.Month())-1)/3 + 1) * 3
		due = time.Date(end.Year(), time.Month(qEnd+2), 0, 0, 0, 0, 0, time.UTC)
	case model.PayFreqAnnually:
		due = time.Date(end.Year()+1, time.January, 31, 0, 0, 0, 0, time.UTC)
	default: // after each payroll: the check date
		due = end
	}
	return nextBusinessDay(due, dc)
}

// groupState returns the state of a state_wh / state_ui payment group ("" otherwise).
func groupState(group string) string {
	for _, p := range []string{"state_wh:", "state_ui:"} {
		if strings.HasPrefix(group, p) {
			return strings.ToUpper(strings.TrimPrefix(group, p))
		}
	}
	return ""
}

// fmtPeriod is the PERIOD column text: "Jan 2026", "Q1 2026", "2026" or "01/16/2026".
func fmtPeriod(freq, start, end string) string {
	t, err := store.ParseDate(start)
	if err != nil {
		return start + " - " + end
	}
	switch {
	case freq == model.PayFreqMonthly && start[:8]+"01" == start && store.LastDayOfMonth(start) == end:
		return t.Format("Jan 2006")
	case freq == model.PayFreqQuarterly:
		return fmt.Sprintf("Q%d %d", store.Quarter(start), t.Year())
	case freq == model.PayFreqAnnually:
		return t.Format("2006")
	case start == end:
		return t.Format("01/02/2006")
	}
	e, _ := store.ParseDate(end)
	return t.Format("01/02/2006") + " - " + e.Format("01/02/2006")
}
