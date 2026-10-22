// Package qbimport brings books kept in QuickBooks Desktop into SerieX Books.
//
// QuickBooks Desktop exports its lists as IIF files (File > Utilities >
// Export > Lists to IIF Files); transactions come as IIF transaction blocks
// (TRNS / SPL / ENDTRNS) and reports as CSV files. Two ways in are offered:
//
//   - transactions: the lists plus every IIF transaction block, entered one by
//     one through ledger.Save so that every derived figure (open balances,
//     inventory, deposits, aging) is computed the usual way;
//   - opening balances: the lists, a trial balance as of a conversion date and
//     the open invoices and unpaid bills of that date (CSV report exports), plus
//     the IIF transactions dated after the conversion date.
//
// Every run happens inside one database transaction: a dry run rolls it back
// and reports the problems found per line, a real run commits only when there
// are none (or when the caller chose to skip the lines with problems).
package qbimport

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"seriex/internal/store"
)

// record is one row of an IIF file, keyed by the column names of the latest
// header row (!KIND) of its kind.
type record struct {
	Line int    // 1-based line number in the file
	Kind string // ACCNT, CUST, TRNS, SPL, ENDTRNS...
	F    map[string]string
}

func (r *record) get(key string) string { return r.F[key] }

// has reports whether the row has a non-blank value for key.
func (r *record) has(key string) bool { return strings.TrimSpace(r.F[key]) != "" }

// iifFile is a parsed IIF file.
type iifFile struct {
	Product, Version string
	Lines            int
	Rows             []*record // list rows (every kind except TRNS / SPL / ENDTRNS / HDR)
	Blocks           []*block  // transaction blocks
	Problems         []Problem
	Kinds            map[string]int // row count per kind (list kinds and TRNS blocks)
}

// block is one transaction: its TRNS row and SPL rows.
type block struct {
	Trns   *record
	Splits []*record
}

// recordStart matches the beginning of a physical line that starts a new IIF
// row ("TRNS\t", "!SPL\t", "ENDTRNS"): a quoted field never runs past one.
var recordStart = regexp.MustCompile(`^!?[A-Z][A-Z0-9]{1,15}(\t|$)`)

// splitRows turns the text of an IIF file into rows of tab-separated fields.
// A field that starts with a double quote is quoted: a doubled quote inside is
// one quote, and it may span lines (QuickBooks writes notes with line breaks
// that way). A quote that is not closed before the next row starts is plain
// text (12" pipe).
func splitRows(text string) (rows [][]string, lineNos []int) {
	text = strings.TrimPrefix(text, "\uFEFF")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	for i := 0; i < len(lines); {
		start := i
		line := lines[i]
		i++
		if strings.TrimSpace(line) == "" {
			continue
		}
		var fields []string
		pos := 0
		for {
			if pos < len(line) && line[pos] == '"' {
				val, end, ok := quotedField(line, pos)
				// a quoted field may continue on the next lines
				for !ok && i < len(lines) && i-start < 50 && !recordStart.MatchString(lines[i]) {
					line += "\n" + lines[i]
					i++
					val, end, ok = quotedField(line, pos)
				}
				if ok {
					fields = append(fields, val)
					pos = end
					if pos >= len(line) {
						break
					}
					pos++ // the tab
					continue
				}
				// never closed: plain text up to the next tab (only the first line)
				if nl := strings.IndexByte(line[pos:], '\n'); nl >= 0 {
					// give the joined lines back
					extra := strings.Count(line[pos+nl:], "\n")
					i -= extra
					line = line[:pos+nl]
				}
			}
			tab := strings.IndexByte(line[pos:], '\t')
			if tab < 0 {
				fields = append(fields, line[pos:])
				break
			}
			fields = append(fields, line[pos:pos+tab])
			pos += tab + 1
		}
		rows = append(rows, fields)
		lineNos = append(lineNos, start+1)
	}
	return rows, lineNos
}

// quotedField reads the quoted field starting at s[pos] == '"'. It returns the
// value, the index just after the closing quote, and whether a closing quote
// followed by a tab or the end of the text was found.
func quotedField(s string, pos int) (string, int, bool) {
	var b strings.Builder
	for j := pos + 1; j < len(s); j++ {
		c := s[j]
		if c != '"' {
			b.WriteByte(c)
			continue
		}
		if j+1 < len(s) && s[j+1] == '"' {
			b.WriteByte('"')
			j++
			continue
		}
		if j+1 == len(s) || s[j+1] == '\t' {
			return b.String(), j + 1, true
		}
		b.WriteByte('"') // a stray quote inside the field
	}
	return "", 0, false
}

// parseIIF reads an IIF file (any encoding QuickBooks writes: Windows-1252,
// UTF-8 or UTF-16).
func parseIIF(data []byte) *iifFile {
	f := &iifFile{Kinds: map[string]int{}}
	text := string(store.DecodeText(data))
	rows, lineNos := splitRows(text)
	f.Lines = strings.Count(text, "\n") + 1
	headers := map[string][]string{}
	var cur *block
	closeBlock := func(line int, explicit bool) {
		if cur == nil {
			return
		}
		if !explicit {
			f.Problems = append(f.Problems, Problem{Line: cur.Trns.Line, Message: "This transaction has no ENDTRNS row; it ends where the next row starts."})
		}
		f.Blocks = append(f.Blocks, cur)
		f.Kinds["TRNS"]++
		cur = nil
	}
	for i, row := range rows {
		line := lineNos[i]
		first := strings.ToUpper(strings.TrimSpace(row[0]))
		if strings.HasPrefix(first, "!") {
			kind := strings.TrimPrefix(first, "!")
			cols := make([]string, len(row))
			for j, c := range row {
				cols[j] = strings.ToUpper(strings.TrimSpace(c))
			}
			headers[kind] = cols
			continue
		}
		if first == "" {
			f.Problems = append(f.Problems, Problem{Line: line, Message: "This row does not start with a row type (such as ACCNT, CUST or TRNS) and was ignored."})
			continue
		}
		cols, ok := headers[first]
		if !ok && first != "ENDTRNS" {
			f.Problems = append(f.Problems, Problem{Line: line, Message: fmt.Sprintf("There is no header row (!%s) before this %s row; it was ignored.", first, first)})
			continue
		}
		r := &record{Line: line, Kind: first, F: map[string]string{}}
		for j := 1; j < len(row) && j < len(cols); j++ {
			if cols[j] != "" {
				r.F[cols[j]] = strings.TrimSpace(row[j])
			}
		}
		switch first {
		case "HDR":
			f.Product, f.Version = r.get("PROD"), r.get("VER")
		case "TRNS":
			closeBlock(line, false)
			cur = &block{Trns: r}
		case "SPL":
			if cur == nil {
				f.Problems = append(f.Problems, Problem{Line: line, Message: "This SPL row is not inside a transaction (TRNS ... ENDTRNS) and was ignored."})
				continue
			}
			cur.Splits = append(cur.Splits, r)
		case "ENDTRNS":
			if cur == nil {
				continue
			}
			closeBlock(line, true)
		default:
			if cur != nil {
				closeBlock(line, false)
			}
			f.Rows = append(f.Rows, r)
			f.Kinds[first]++
		}
	}
	closeBlock(0, false)
	return f
}

// ---------------------------------------------------------------------------
// Values

// parseMoney reads an amount: "1,234.56", "-12", "(45.00)", "$9.99". ok is
// false for text that is not a number.
func parseMoney(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, true
	}
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg = true
		s = s[1 : len(s)-1]
	}
	s = strings.NewReplacer(",", "", "$", "", " ", "").Replace(s)
	if strings.HasSuffix(s, "-") { // 45.00- (trailing minus)
		neg = !neg
		s = strings.TrimSuffix(s, "-")
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > 9_999_999_999.99 {
		return 0, false
	}
	c := int64(math.Round(f * 100))
	if neg {
		c = -c
	}
	return c, true
}

// parseNumber reads a quantity, price or rate ("12", "-3.5", "7.25%").
// pct reports a trailing percent sign.
func parseNumber(s string) (v float64, pct bool, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false, false
	}
	if strings.HasSuffix(s, "%") {
		pct = true
		s = strings.TrimSpace(strings.TrimSuffix(s, "%"))
	}
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg = true
		s = s[1 : len(s)-1]
	}
	s = strings.NewReplacer(",", "", "$", "").Replace(s)
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, pct, false
	}
	if neg {
		f = -f
	}
	return f, pct, true
}

var dateLayouts = []string{"1/2/2006", "01/02/2006", "1/2/06", "01/02/06", "2006-01-02", "1-2-2006", "1-2-06", "1.2.2006",
	"Jan 2, 2006", "January 2, 2006", "Jan 2, 06", "2 Jan 2006"}

// parseDate reads the dates QuickBooks writes (MM/DD/YYYY, M/D/YY...).
// Two-digit years 00-69 are 2000-2069, 70-99 are 1970-1999.
func parseDate(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", false
	}
	for _, l := range dateLayouts {
		t, err := time.Parse(l, s)
		if err != nil {
			continue
		}
		if strings.Contains(l, "06") && !strings.Contains(l, "2006") {
			y := t.Year() % 100
			if y < 70 {
				t = t.AddDate(2000+y-t.Year(), 0, 0)
			} else {
				t = t.AddDate(1900+y-t.Year(), 0, 0)
			}
		}
		if t.Year() < 1900 || t.Year() > 2200 {
			return "", false
		}
		return t.Format("2006-01-02"), true
	}
	return "", false
}

// yes reads the Y/N flags of IIF files.
func yes(s string) bool {
	switch strings.ToUpper(strings.TrimSpace(s)) {
	case "Y", "YES", "T", "TRUE", "1":
		return true
	}
	return false
}

// splitFull splits a "Parent:Child" full name into its parts (blank parts dropped).
func splitFull(full string) []string {
	var out []string
	for _, p := range strings.Split(full, ":") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// normFull normalizes a full name for lookups: parts trimmed, case folded.
func normFull(full string) string {
	return strings.ToLower(strings.Join(splitFull(full), ":"))
}

// joinLines joins the non-blank address lines of a row.
func joinLines(r *record, keys ...string) string {
	var out []string
	for _, k := range keys {
		if v := strings.TrimSpace(r.get(k)); v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, "\n")
}
