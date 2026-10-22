package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"seriexpayroll/internal/model"
)

// LoadPrefs reads the payroll preferences (defaults filled in).
func LoadPrefs(ctx context.Context, q Q) (model.PayrollPrefs, error) {
	p := model.DefaultPrefs()
	var raw string
	if err := q.QueryRowContext(ctx, `SELECT prefs FROM company WHERE id = 1`).Scan(&raw); err != nil {
		return p, err
	}
	if raw != "" && raw != "{}" {
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			return p, fmt.Errorf("company preferences: %w", err)
		}
	}
	return p, nil
}

// SavePrefs stores the payroll preferences.
func SavePrefs(ctx context.Context, tx *sql.Tx, p model.PayrollPrefs) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE company SET prefs = ?, updated_at = ? WHERE id = 1`, string(b), Now())
	return err
}

// BooksCompanyID returns the SerieX Books company id this payroll file belongs to.
func BooksCompanyID(ctx context.Context, q Q) string {
	var id string
	q.QueryRowContext(ctx, `SELECT books_company_id FROM company WHERE id = 1`).Scan(&id)
	return id
}

// CompanyName returns the company name ("" when not set).
func CompanyName(ctx context.Context, q Q) string {
	var n string
	q.QueryRowContext(ctx, `SELECT name FROM company WHERE id = 1`).Scan(&n)
	return n
}

// Audit writes one audit trail row. details is marshalled to JSON (nil -> {}).
func Audit(ctx context.Context, q Q, user, action, entity string, entityID int64, summary string, details any) error {
	d := "{}"
	if details != nil {
		b, err := json.Marshal(details)
		if err != nil {
			return err
		}
		d = string(b)
	}
	var eid any
	if entityID != 0 {
		eid = entityID
	}
	_, err := q.ExecContext(ctx, `INSERT INTO audit_log(ts, user, action, entity, entity_id, summary, details) VALUES(?,?,?,?,?,?,?)`,
		Now(), user, action, entity, eid, summary, d)
	return err
}

// MaskSSN shows only the last 4 digits ("XXX-XX-1234"; "" when empty).
func MaskSSN(ssn string) string {
	d := Digits(ssn)
	if d == "" {
		return ""
	}
	if len(d) < 4 {
		return "XXX-XX-" + d
	}
	return "XXX-XX-" + d[len(d)-4:]
}

// FormatSSN formats 9 digits as 123-45-6789 (other input returned as is).
func FormatSSN(ssn string) string {
	d := Digits(ssn)
	if len(d) != 9 {
		return ssn
	}
	return d[:3] + "-" + d[3:5] + "-" + d[5:]
}

// FormatEIN formats 9 digits as 12-3456789.
func FormatEIN(ein string) string {
	d := Digits(ein)
	if len(d) != 9 {
		return ein
	}
	return d[:2] + "-" + d[2:]
}

// MaskAccount shows only the last 4 characters of a bank account/routing number.
func MaskAccount(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if len(s) <= 4 {
		return strings.Repeat("*", len(s))
	}
	return strings.Repeat("*", len(s)-4) + s[len(s)-4:]
}

// Digits keeps only 0-9.
func Digits(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// Year returns the calendar year of a YYYY-MM-DD date (0 when invalid).
func Year(date string) int {
	t, err := ParseDate(date)
	if err != nil {
		return 0
	}
	return t.Year()
}

// Quarter returns the calendar quarter (1-4) of a YYYY-MM-DD date (0 when invalid).
func Quarter(date string) int {
	t, err := ParseDate(date)
	if err != nil {
		return 0
	}
	return (int(t.Month())-1)/3 + 1
}

// QuarterRange returns the first and last day of a calendar quarter.
func QuarterRange(year, quarter int) (string, string) {
	start := time.Date(year, time.Month((quarter-1)*3+1), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 3, -1)
	return start.Format("2006-01-02"), end.Format("2006-01-02")
}

// YearRange returns January 1 and December 31 of a year.
func YearRange(year int) (string, string) {
	return fmt.Sprintf("%04d-01-01", year), fmt.Sprintf("%04d-12-31", year)
}

// AddMonths adds n calendar months to a date, clamping the day to the month length.
func AddMonths(date string, n int) string {
	t, err := ParseDate(date)
	if err != nil {
		return date
	}
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, n, 0)
	last := first.AddDate(0, 1, -1).Day()
	d := t.Day()
	if d > last {
		d = last
	}
	return time.Date(first.Year(), first.Month(), d, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
}

// LastDayOfMonth returns the last day of the month of date.
func LastDayOfMonth(date string) string {
	t, err := ParseDate(date)
	if err != nil {
		return date
	}
	return time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
}

// Weekday returns the day of the week of a date (time.Sunday when invalid).
func Weekday(date string) time.Weekday {
	t, err := ParseDate(date)
	if err != nil {
		return time.Sunday
	}
	return t.Weekday()
}

// DaysBetween returns b - a in days.
func DaysBetween(a, b string) int {
	ta, err1 := ParseDate(a)
	tb, err2 := ParseDate(b)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

// JSONText marshals v for a TEXT column ("{}" for nil).
func JSONText(v any) string {
	if v == nil {
		return "{}"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}
