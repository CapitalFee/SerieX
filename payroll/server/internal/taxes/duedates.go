package taxes

import (
	"strings"
	"time"
)

// Quarterly state returns (and the payments made with them) are due the last
// day of the month after the quarter, moved to the next business day when it
// falls on a weekend or legal holiday, except in the states listed here. One
// table for every package: liabilities (due dates of quarterly state payment
// groups) and forms (state report due dates) both use StateQuarterlyDue.
type quarterlyDue struct {
	day         int  // day of the month after the quarter
	noExtension bool // a weekend or legal holiday does not move the date
}

var stateQuarterlyDue = map[string]quarterlyDue{
	// NJ-927 / WR-30 (income tax and UI/WF/SWF/DI/FLI contributions): the 30th
	// day of the month after the quarter, no weekend/holiday extension for NJDOL.
	"NJ": {day: 30, noExtension: true},
}

// StateQuarterlyDue returns the due date of a state's quarterly return for the
// quarter that contains quarterEnd, and whether a weekend or legal holiday
// moves it to the next business day.
func StateQuarterlyDue(state string, quarterEnd time.Time) (due time.Time, moves bool) {
	qEnd := ((int(quarterEnd.Month())-1)/3 + 1) * 3
	if r, ok := stateQuarterlyDue[strings.ToUpper(strings.TrimSpace(state))]; ok {
		last := time.Date(quarterEnd.Year(), time.Month(qEnd+2), 0, 0, 0, 0, 0, time.UTC).Day()
		day := r.day
		if day > last {
			day = last
		}
		return time.Date(quarterEnd.Year(), time.Month(qEnd+1), day, 0, 0, 0, 0, time.UTC), !r.noExtension
	}
	return time.Date(quarterEnd.Year(), time.Month(qEnd+2), 0, 0, 0, 0, 0, time.UTC), true
}
