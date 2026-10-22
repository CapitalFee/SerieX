package seriexmcp

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// maxColumns is the most report columns shown (the last one, usually the
// total, is always kept).
const maxColumns = 30

// isTotalRow: a subtotal or total row (kept when a report is shortened).
func isTotalRow(kind string) bool {
	return kind == "subtotal" || kind == "total" || kind == "grandtotal"
}

// renderReport turns a report into a compact Markdown table. At most
// maxRows rows are shown; subtotal and total rows are always kept.
func renderReport(r *reportResult, maxRows int) string {
	var b strings.Builder
	hiddenCols := 0
	if len(r.Columns) > maxColumns {
		hiddenCols = len(r.Columns) - maxColumns
		cols := append([]reportColumn{}, r.Columns[:maxColumns-1]...)
		r.Columns = append(cols, r.Columns[len(r.Columns)-1])
	}
	b.WriteString("**" + r.Title + "**")
	if r.CompanyName != "" {
		b.WriteString(" — " + r.CompanyName)
	}
	b.WriteString("\n")
	if s := joinNonEmpty(" · ", r.DateRangeLabel, r.Basis); s != "" {
		b.WriteString(s + "\n")
	}
	b.WriteString("\n")
	if len(r.Columns) == 0 {
		b.WriteString("(This report has no columns.)\n")
		return b.String()
	}
	hasTxn := false
	var rows []reportRow
	for _, row := range r.Rows {
		if row.Kind == "blank" {
			continue
		}
		if row.TxnID != nil {
			hasTxn = true
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		b.WriteString("Nothing to show for these dates and filters.\n")
		return b.String()
	}
	var head []string
	for i, c := range r.Columns {
		h := c.Label
		if h == "" && i == 0 {
			h = " "
		}
		if c.Type == "money" || c.Type == "number" || c.Type == "percent" {
			h = ">" + h
		}
		head = append(head, h)
	}
	if hasTxn {
		head = append(head, ">Txn id")
	}
	t := newTable(head...)
	addRow := func(row reportRow) {
		cells := make([]string, 0, len(head))
		for i, c := range r.Columns {
			v := formatCell(row.Cells[c.Key], c.Type)
			if i == 0 {
				v = strings.Repeat("  ", max(row.Level, 0)) + v
			}
			if v != "" && (row.Kind == "section" || isTotalRow(row.Kind)) {
				v = "**" + strings.TrimSpace(v) + "**"
				if i == 0 {
					v = strings.Repeat("  ", max(row.Level, 0)) + v
				}
			}
			cells = append(cells, v)
		}
		if hasTxn {
			id := ""
			if row.TxnID != nil {
				id = fmt.Sprint(*row.TxnID)
			}
			cells = append(cells, id)
		}
		t.add(cells...)
	}
	shown := 0
	for i, row := range rows {
		if i < maxRows {
			addRow(row)
			shown++
		}
	}
	if len(rows) > maxRows {
		hidden := 0
		var totals []reportRow
		for _, row := range rows[maxRows:] {
			if isTotalRow(row.Kind) {
				totals = append(totals, row)
			} else {
				hidden++
			}
		}
		filler := make([]string, len(head))
		filler[0] = fmt.Sprintf("… %d more rows not shown …", hidden)
		t.add(filler...)
		for _, row := range totals {
			addRow(row)
			shown++
		}
		b.WriteString(t.String())
		b.WriteString(fmt.Sprintf("\nShowing %d of %d rows (subtotals and totals kept). For the rest, narrow the dates or filters, or raise max_rows (up to %d).\n", shown, len(rows), maxReportRows))
		b.WriteString(columnsNote(hiddenCols))
		return b.String()
	}
	b.WriteString(t.String())
	b.WriteString(columnsNote(hiddenCols))
	if hasTxn {
		b.WriteString("\nUse get_transaction with a Txn id to see a transaction in full.\n")
	}
	return b.String()
}

// maxReportRows is the largest max_rows of a report.
const maxReportRows = 500

func columnsNote(hidden int) string {
	if hidden == 0 {
		return ""
	}
	return fmt.Sprintf("\n%d more columns are not shown (only the first %d and the last one are). Use fewer columns (for example columns total, or a shorter date range).\n", hidden, maxColumns-1)
}

// sensitiveColumn: the key or label of a report column names social
// security or taxpayer identification numbers ("ssn", "employeeSsn",
// "SS No.", "Social Security", "Tax ID", "TIN", "EIN").
func sensitiveColumn(s string) bool {
	words := splitWords(s)
	for i, w := range words {
		next := ""
		if i+1 < len(words) {
			next = words[i+1]
		}
		switch {
		case w == "ssn", w == "taxid", w == "tin", w == "ein", w == "ssno":
			return true
		case w == "social" && next == "security", w == "ss" && (next == "no" || next == "number" || next == "num"),
			w == "tax" && (next == "id" || next == "number"):
			return true
		}
	}
	return false
}

// splitWords splits "employeeSsn", "SS No.", "tax_id" into lower case words.
func splitWords(s string) []string {
	var words []string
	var cur []rune
	flush := func() {
		if len(cur) > 0 {
			words = append(words, strings.ToLower(string(cur)))
			cur = cur[:0]
		}
	}
	rs := []rune(s)
	for i, r := range rs {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			cur = append(cur, r)
		case r >= 'A' && r <= 'Z':
			// a capital starts a word, except inside an all-capitals run ("SSN")
			if len(cur) > 0 && !(i > 0 && rs[i-1] >= 'A' && rs[i-1] <= 'Z' && (i+1 >= len(rs) || !(rs[i+1] >= 'a' && rs[i+1] <= 'z'))) {
				flush()
			}
			cur = append(cur, r)
		default:
			flush()
		}
	}
	flush()
	return words
}

// dropSensitiveColumns removes columns of social security and tax ID numbers.
func dropSensitiveColumns(r *reportResult) {
	for _, c := range append([]reportColumn{}, r.Columns...) {
		if sensitiveColumn(c.Key) || sensitiveColumn(c.Label) {
			dropColumn(r, c.Key)
		}
	}
}

// fullSSN matches a full social security number written 123-45-6789.
var fullSSN = regexp.MustCompile(`\b\d{3}-\d{2}-(\d{4})\b`)

// maskSSNs hides all but the last 4 digits of anything written like a full
// social security number.
func maskSSNs(s string) string {
	if !strings.Contains(s, "-") {
		return s
	}
	return fullSSN.ReplaceAllString(s, "XXX-XX-$1")
}

func formatCell(v any, typ string) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		if x {
			return "Yes"
		}
		return ""
	case float64:
		switch typ {
		case "money":
			return money(x)
		case "percent":
			return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%.2f", x), "0"), ".0") + "%"
		case "number":
			return qty(x)
		}
		if x == math.Trunc(x) {
			return fmt.Sprintf("%.0f", x)
		}
		return qty(x)
	}
	return fmt.Sprint(v)
}
