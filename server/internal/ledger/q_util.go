package ledger

// Shared helpers of the transaction query routes.
// Every package-level identifier in the q_*.go files starts with "qry".

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"

	"seriex/internal/model"
	"seriex/internal/store"
)

// qryTypeLabel returns the display name of a transaction type. accountType is
// the type of the header account (bill payments from a credit card account are
// "Bill Pmt -CCard").
func qryTypeLabel(txnType, accountType string) string {
	return TypeLabel(txnType, accountType)
}

// qryIn builds "(?,?,?)" and its arguments for an id list. An empty list gives
// "(NULL)", which matches nothing.
func qryIn(ids []int64) (string, []any) {
	if len(ids) == 0 {
		return "(NULL)", nil
	}
	var b strings.Builder
	args := make([]any, len(ids))
	b.WriteByte('(')
	for i, id := range ids {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteByte('?')
		args[i] = id
	}
	b.WriteByte(')')
	return b.String(), args
}

// qryInStr is qryIn for strings.
func qryInStr(vals []string) (string, []any) {
	if len(vals) == 0 {
		return "(NULL)", nil
	}
	args := make([]any, len(vals))
	for i, v := range vals {
		args[i] = v
	}
	return "(" + strings.TrimSuffix(strings.Repeat("?,", len(vals)), ",") + ")", args
}

// qryLike returns a LIKE pattern matching s anywhere (use with ESCAPE '\').
func qryLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return "%" + r.Replace(s) + "%"
}

// qryNameSet returns the name and (when withJobs) all jobs below it.
func qryNameSet(ctx context.Context, q store.Q, id int64, withJobs bool) ([]int64, error) {
	if !withJobs {
		return []int64{id}, nil
	}
	return store.Descendants(ctx, q, "names", id)
}

// qrySpecialIDs returns the ids of the accounts flagged special (read only;
// unlike store.SpecialAccount it never creates the account).
func qrySpecialIDs(ctx context.Context, q store.Q, special string) ([]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM accounts WHERE special = ? ORDER BY id`, special)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// qryNatural converts a signed ledger sum (debit +) to the natural sign of an account type.
func qryNatural(accountType string, cents int64) int64 {
	if model.IsDebitNormal(accountType) {
		return cents
	}
	return -cents
}

// qryAcctLabel is the account name shown in lists and registers: the full
// name, prefixed with the account number when account numbers are enabled.
func qryAcctLabel(useNumbers bool, number, full string) string {
	if useNumbers && number != "" && full != "" {
		return number + " · " + full
	}
	return full
}

// qryIsDigits reports whether s is a non-empty string of ASCII digits.
func qryIsDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// qryRefCompare orders reference numbers: blank first, then numeric ones by
// value, then the others alphabetically (case-insensitive).
func qryRefCompare(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		return -1
	}
	if b == "" {
		return 1
	}
	na, nb := qryIsDigits(a), qryIsDigits(b)
	switch {
	case na && nb:
		ta, tb := strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
		if len(ta) != len(tb) {
			if len(ta) < len(tb) {
				return -1
			}
			return 1
		}
		return strings.Compare(ta, tb)
	case na:
		return -1
	case nb:
		return 1
	}
	return strings.Compare(strings.ToLower(a), strings.ToLower(b))
}

// qryIncRef returns the reference number that follows s: the trailing digit
// run is incremented keeping its width ("1009" -> "1010", "A-099" -> "A-100");
// a blank reference gives "1" and one without digits gets "1" appended.
func qryIncRef(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "1"
	}
	end := len(s)
	start := end
	for start > 0 && s[start-1] >= '0' && s[start-1] <= '9' {
		start--
	}
	if start == end {
		return s + "1"
	}
	digits := []byte(s[start:end])
	i := len(digits) - 1
	for ; i >= 0; i-- {
		if digits[i] == '9' {
			digits[i] = '0'
			continue
		}
		digits[i]++
		break
	}
	if i < 0 {
		digits = append([]byte{'1'}, digits...)
	}
	return s[:start] + string(digits)
}

// qryTerms is the data of a terms list entry.
type qryTerms struct {
	DateDriven       bool    `json:"dateDriven"`
	NetDays          int     `json:"netDays"`
	DueDay           int     `json:"dueDay"`
	DueNextMonthDays int     `json:"dueNextMonthDays"`
	DiscountPct      float64 `json:"discountPct"`
	DiscountDays     int     `json:"discountDays"`
	DiscountDay      int     `json:"discountDay"`
}

// qryLoadTerms reads every terms list entry.
func qryLoadTerms(ctx context.Context, q store.Q) (map[int64]qryTerms, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, data FROM list_entries WHERE list = ?`, model.ListTerms)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]qryTerms{}
	for rows.Next() {
		var id int64
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, err
		}
		var t qryTerms
		if raw != "" {
			// numbers may arrive as strings from older clients; decode loosely
			var m map[string]any
			if json.Unmarshal([]byte(raw), &m) == nil {
				t = qryTermsFromMap(m)
			}
		}
		out[id] = t
	}
	return out, rows.Err()
}

func qryTermsFromMap(m map[string]any) qryTerms {
	num := func(k string) float64 {
		switch v := m[k].(type) {
		case float64:
			return v
		case string:
			f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
			return f
		case bool:
			if v {
				return 1
			}
		}
		return 0
	}
	t := qryTerms{
		NetDays:          int(num("netDays")),
		DueDay:           int(num("dueDay")),
		DueNextMonthDays: int(num("dueNextMonthDays")),
		DiscountPct:      num("discountPct"),
		DiscountDays:     int(num("discountDays")),
		DiscountDay:      int(num("discountDay")),
	}
	if b, ok := m["dateDriven"].(bool); ok {
		t.DateDriven = b
	}
	return t
}

// qryDayOfMonth returns year-month-day with the day clamped to the month length.
func qryDayOfMonth(y int, m time.Month, day int) time.Time {
	if day < 1 {
		day = 1
	}
	last := time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if day > last {
		day = last
	}
	return time.Date(y, m, day, 0, 0, 0, 0, time.UTC)
}

// qryDiscountDate returns the last date the terms discount applies to a
// transaction dated date ("" when the terms have no discount).
//   - standard terms: date + discountDays
//   - date driven terms: discountDay of the month the transaction is due in
//     (due the next month when dated after dueDay or within dueNextMonthDays of
//     it); no discount when that day is before the transaction date.
func qryDiscountDate(date string, t qryTerms) string {
	if t.DiscountPct <= 0 {
		return ""
	}
	d, err := store.ParseDate(date)
	if err != nil {
		return ""
	}
	if !t.DateDriven {
		if t.DiscountDays <= 0 {
			return ""
		}
		return d.AddDate(0, 0, t.DiscountDays).Format("2006-01-02")
	}
	if t.DiscountDay <= 0 {
		return ""
	}
	due := dateDrivenDue(d, t.DueDay, t.DueNextMonthDays) // the same rule as the due date
	disc := qryDayOfMonth(due.Year(), due.Month(), t.DiscountDay)
	if disc.Before(d) {
		return ""
	}
	return disc.Format("2006-01-02")
}

// qryPctOf returns round(cents × pct / 100).
func qryPctOf(cents int64, pct float64) int64 {
	return int64(math.Round(float64(cents) * pct / 100))
}

// qryNullStr returns the string or "".
func qryNullStr(s sql.NullString) string {
	if s.Valid {
		return s.String
	}
	return ""
}
