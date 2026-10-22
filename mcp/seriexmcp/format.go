package seriexmcp

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// money formats dollars as $1,234.56 (-$1,234.56 when negative).
func money(v float64) string {
	neg := v < 0
	cents := int64(math.Round(math.Abs(v) * 100))
	whole := strconv.FormatInt(cents/100, 10)
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	s := fmt.Sprintf("$%s.%02d", b.String(), cents%100)
	if neg && cents != 0 {
		return "-" + s
	}
	return s
}

// qty formats a quantity without trailing zeros (2, 2.5, 0.125).
func qty(v float64) string {
	return strconv.FormatFloat(math.Round(v*100000)/100000, 'f', -1, 64)
}

// round2 rounds to cents.
func round2(v float64) float64 { return math.Round(v*100) / 100 }

func today() string { return time.Now().Format("2006-01-02") }

// parseDate accepts YYYY-MM-DD or "today" ("" stays "").
func parseDate(field, s string) (string, error) {
	s = strings.TrimSpace(s)
	switch strings.ToLower(s) {
	case "":
		return "", nil
	case "today":
		return today(), nil
	}
	if _, err := time.Parse("2006-01-02", s); err != nil {
		return "", userErr("%s must be a date written YYYY-MM-DD (for example 2026-10-20) or \"today\" (got %q).", field, s)
	}
	return s, nil
}

// addDays adds n days to a YYYY-MM-DD date.
func addDays(date string, n int) string {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// daysBetween is b - a in days (0 when a date is invalid).
func daysBetween(a, b string) int {
	ta, err1 := time.Parse("2006-01-02", a)
	tb, err2 := time.Parse("2006-01-02", b)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(tb.Sub(ta).Hours() / 24)
}

var monthNames = []string{"", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"}

func monthName(m int) string {
	if m >= 1 && m <= 12 {
		return monthNames[m]
	}
	return "?"
}

// short cuts a text to n characters on one line.
func short(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// table renders a Markdown table. Columns whose header starts with ">" are
// right aligned (the ">" is not shown).
type table struct {
	head []string
	rows [][]string
}

func newTable(head ...string) *table { return &table{head: head} }

func (t *table) add(cells ...string) { t.rows = append(t.rows, cells) }

func (t *table) len() int { return len(t.rows) }

func cell(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	s = strings.ReplaceAll(s, "\n", " / ")
	return strings.ReplaceAll(s, "|", "\\|")
}

func (t *table) String() string {
	var b strings.Builder
	b.WriteString("|")
	for _, h := range t.head {
		b.WriteString(" " + cell(strings.TrimPrefix(h, ">")) + " |")
	}
	b.WriteString("\n|")
	for _, h := range t.head {
		if strings.HasPrefix(h, ">") {
			b.WriteString("---:|")
		} else {
			b.WriteString("---|")
		}
	}
	b.WriteString("\n")
	for _, r := range t.rows {
		b.WriteString("|")
		for i := range t.head {
			v := ""
			if i < len(r) {
				v = r[i]
			}
			b.WriteString(" " + cell(v) + " |")
		}
		b.WriteString("\n")
	}
	return b.String()
}

// plural: "1 invoice", "2 invoices".
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// clamp keeps n within [lo, hi]; def when n is 0.
func clamp(n, def, lo, hi int) int {
	if n == 0 {
		n = def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// joinNonEmpty joins the non-empty parts.
func joinNonEmpty(sep string, parts ...string) string {
	var out []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// formatAddress is the address block a sales form prints (as the web client builds it).
func formatAddress(addressee string, a address) string {
	city := joinNonEmpty(", ", a.City, joinNonEmpty(" ", a.State, a.Zip))
	return joinNonEmpty("\n", addressee, a.Line1, a.Line2, a.Line3, city, a.Country)
}

func hasAddress(a address) bool {
	return a.Line1 != "" || a.Line2 != "" || a.Line3 != "" || a.City != "" || a.State != "" || a.Zip != "" || a.Country != ""
}

func oneLineAddress(a address) string {
	return strings.ReplaceAll(formatAddress("", a), "\n", ", ")
}

// containsStr reports whether list has s.
func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// rateText formats a rate: dollars ($12.50, $0.12345) or a percent.
func rateText(v float64, percent bool) string {
	if percent {
		return qty(v) + "%"
	}
	if math.Abs(v*100-math.Round(v*100)) < 1e-9 {
		return money(v)
	}
	if v < 0 {
		return "-$" + qty(-v)
	}
	return "$" + qty(v)
}
