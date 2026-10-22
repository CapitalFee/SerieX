package qbimport

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"regexp"
	"strings"

	"seriex/internal/store"
)

// CSV exports of QuickBooks Desktop reports (Excel > Create New Worksheet >
// "Create a comma separated values (.csv) file"). Report rows are grouped by
// account, customer or vendor: the group labels sit in the leading columns,
// one column per level, and "Total ..." rows close the groups. Simple flat
// files with named columns (Account, Debit, Credit / Customer, Type, Date,
// Num, Due Date, Open Balance) are read too.

type csvRow struct {
	Line  int
	Cells []string
}

func readCSV(data []byte) ([]csvRow, error) {
	text := store.DecodeText(data)
	text = bytes.TrimPrefix(text, []byte("\uFEFF"))
	r := csv.NewReader(bytes.NewReader(text))
	r.Comma = store.CSVDelimiter(text)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var out []csvRow
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the file could not be read as CSV (%v)", err)
		}
		cells := make([]string, len(rec))
		blank := true
		for i, c := range rec {
			cells[i] = strings.TrimSpace(c)
			if cells[i] != "" {
				blank = false
			}
		}
		if !blank {
			ln, _ := r.FieldPos(0)
			out = append(out, csvRow{Line: ln, Cells: cells})
		}
	}
	return out, nil
}

func cell(r csvRow, i int) string {
	if i < 0 || i >= len(r.Cells) {
		return ""
	}
	return r.Cells[i]
}

// findCol returns the index of the first cell matching one of the names (case
// and punctuation ignored), or -1.
func findCol(r csvRow, names ...string) int {
	for i, c := range r.Cells {
		k := strings.ToLower(lettersOnly.ReplaceAllString(strings.ToUpper(c), ""))
		for _, n := range names {
			if k == strings.ToLower(lettersOnly.ReplaceAllString(strings.ToUpper(n), "")) {
				return i
			}
		}
	}
	return -1
}

// numberedSegment matches "6010 · Telephone" (QuickBooks shows account numbers that way).
var numberedSegment = regexp.MustCompile(`^\s*([0-9][0-9A-Za-z.\-]*)\s*·\s*(.+?)\s*$`)

// splitAccountLabel turns "6000 · Utilities:6010 · Telephone" into the full
// name "Utilities:Telephone" and the number of the last segment ("6010").
func splitAccountLabel(label string) (full, number string) {
	var parts []string
	for _, seg := range strings.Split(label, ":") {
		seg = strings.TrimSpace(seg)
		if m := numberedSegment.FindStringSubmatch(seg); m != nil {
			number, seg = m[1], m[2]
		} else {
			number = ""
		}
		if seg != "" {
			parts = append(parts, seg)
		}
	}
	return strings.Join(parts, ":"), number
}

// ---------------------------------------------------------------------------
// Trial balance

type tbRow struct {
	Line   int
	Label  string // as written
	Full   string // account full name without numbers
	Number string
	Amount int64 // debit positive, credit negative
}

type trialBalance struct {
	Rows    []tbRow
	AsOf    string // date found in the report heading ("" when none)
	Debits  int64
	Credits int64
}

var asOfPrefix = regexp.MustCompile(`(?i)^(as of|as at)\s+`)

func parseTrialBalance(data []byte) (*trialBalance, []Problem) {
	var probs []Problem
	errAt := func(line int, format string, args ...any) {
		probs = append(probs, Problem{File: "tb", Line: line, Level: levelError, Message: fmt.Sprintf(format, args...)})
	}
	rows, err := readCSV(data)
	if err != nil {
		errAt(0, "The trial balance %s.", err.Error())
		return nil, probs
	}
	tb := &trialBalance{}
	head := -1
	debit, credit, balance, acctCol := -1, -1, -1, -1
	for i, r := range rows {
		d, c := findCol(r, "Debit", "Debits"), findCol(r, "Credit", "Credits")
		b := findCol(r, "Balance", "Amount")
		if (d >= 0 && c >= 0) || (b >= 0 && findCol(r, "Account", "Account Name", "Name") >= 0) {
			head, debit, credit, balance = i, d, c, b
			acctCol = findCol(r, "Account", "Account Name", "Name")
			break
		}
		// heading rows: the date of the report ("Dec 31, 25", "As of December 31, 2025")
		for _, x := range r.Cells {
			if dt, ok := parseDate(asOfPrefix.ReplaceAllString(x, "")); ok && tb.AsOf == "" {
				tb.AsOf = dt
			}
		}
	}
	if head < 0 {
		errAt(0, "The trial balance file has no header row with Debit and Credit columns (or Account and Balance columns). Export the Trial Balance report from QuickBooks® Desktop to a CSV file and choose it again.")
		return nil, probs
	}
	if debit >= 0 && credit >= 0 {
		balance = -1
	}
	firstAmt := debit
	if firstAmt < 0 || (credit >= 0 && credit < firstAmt) {
		firstAmt = credit
	}
	if balance >= 0 {
		firstAmt = balance
	}
	for _, r := range rows[head+1:] {
		label := ""
		if acctCol >= 0 {
			label = cell(r, acctCol)
		} else {
			for i := 0; i < firstAmt && i < len(r.Cells); i++ {
				if r.Cells[i] != "" {
					label = r.Cells[i]
					break
				}
			}
		}
		if label == "" || strings.HasPrefix(strings.ToUpper(label), "TOTAL") {
			continue
		}
		var amt int64
		if balance >= 0 {
			v, ok := parseMoney(cell(r, balance))
			if !ok {
				errAt(r.Line, "The balance %q of %s is not a number.", cell(r, balance), label)
				continue
			}
			amt = v
		} else {
			dv, ok1 := parseMoney(cell(r, debit))
			cv, ok2 := parseMoney(cell(r, credit))
			if !ok1 || !ok2 {
				errAt(r.Line, "The debit or credit of %s is not a number.", label)
				continue
			}
			amt = dv - cv
		}
		full, num := splitAccountLabel(label)
		if full == "" {
			continue
		}
		tb.Rows = append(tb.Rows, tbRow{Line: r.Line, Label: label, Full: full, Number: num, Amount: amt})
		if amt > 0 {
			tb.Debits += amt
		} else {
			tb.Credits -= amt
		}
	}
	if len(tb.Rows) == 0 {
		errAt(0, "The trial balance file has no account rows.")
	}
	if tb.Debits != tb.Credits {
		errAt(0, "The trial balance does not balance: debits are %s and credits are %s (difference %s).",
			fmtCents(tb.Debits), fmtCents(tb.Credits), fmtCents(tb.Debits-tb.Credits))
	}
	return tb, probs
}

// ---------------------------------------------------------------------------
// Open invoices / unpaid bills

type openDoc struct {
	Line     int
	Name     string // customer:job or vendor
	TypeText string // "Invoice", "Credit Memo", "Bill", "Credit"...
	Date     string
	DueDate  string
	Num      string
	Terms    string
	PONum    string
	Memo     string
	Open     int64 // open balance; negative = a credit
}

// parseOpenDocs reads an Open Invoices (file "invoices") or Unpaid Bills
// Detail (file "bills") report export.
func parseOpenDocs(data []byte, file string) ([]openDoc, []Problem) {
	var probs []Problem
	what := map[string]string{"invoices": "open invoices", "bills": "unpaid bills"}[file]
	errAt := func(line int, format string, args ...any) {
		probs = append(probs, Problem{File: file, Line: line, Level: levelError, Message: fmt.Sprintf(format, args...)})
	}
	rows, err := readCSV(data)
	if err != nil {
		errAt(0, "The %s file %s.", what, err.Error())
		return nil, probs
	}
	head := -1
	for i, r := range rows {
		if findCol(r, "Type") >= 0 && findCol(r, "Open Balance", "Open Bal", "Amount Due", "Balance", "Open Amount") >= 0 {
			head = i
			break
		}
	}
	if head < 0 {
		errAt(0, "The %s file has no header row with Type and Open Balance columns. Export the report from QuickBooks® Desktop to a CSV file and choose it again.", what)
		return nil, probs
	}
	h := rows[head]
	typ := findCol(h, "Type")
	date := findCol(h, "Date")
	num := findCol(h, "Num", "Number", "No", "Ref No", "Invoice No", "Bill No")
	due := findCol(h, "Due Date", "Due")
	terms := findCol(h, "Terms")
	po := findCol(h, "P. O. #", "PO #", "P.O. No.", "PO Number", "P. O. Number")
	memo := findCol(h, "Memo", "Description")
	open := findCol(h, "Open Balance", "Open Bal", "Amount Due", "Open Amount", "Balance")
	nameCol := findCol(h, "Customer", "Customer:Job", "Vendor", "Name", "Source Name")
	used := map[int]bool{typ: true, date: true, num: true, due: true, terms: true, po: true, memo: true, open: true, nameCol: true}
	var stack []string
	var out []openDoc
	for _, r := range rows[head+1:] {
		t := cell(r, typ)
		if t == "" {
			// a group label (customer, job, vendor) or a total row
			for i := 0; i < typ && i < len(r.Cells); i++ {
				if used[i] || r.Cells[i] == "" {
					continue
				}
				label := r.Cells[i]
				if len(stack) > i {
					stack = stack[:i]
				}
				if strings.HasPrefix(strings.ToLower(label), "total") {
					break
				}
				for len(stack) < i {
					stack = append(stack, "")
				}
				stack = append(stack, label)
				break
			}
			continue
		}
		if strings.HasPrefix(strings.ToLower(t), "total") {
			continue
		}
		name := ""
		if nameCol >= 0 {
			name = cell(r, nameCol)
		}
		if name == "" {
			var parts []string
			for _, p := range stack {
				if p != "" {
					parts = append(parts, p)
				}
			}
			name = strings.Join(parts, ":")
		}
		name = strings.Join(splitFull(name), ":")
		d := openDoc{Line: r.Line, Name: name, TypeText: t, Num: cell(r, num), Terms: cell(r, terms), PONum: cell(r, po), Memo: cell(r, memo)}
		if name == "" {
			errAt(r.Line, "This %s row has no customer or vendor name.", strings.ToLower(t))
			continue
		}
		var ok bool
		if d.Date, ok = parseDate(cell(r, date)); !ok {
			errAt(r.Line, "The date %q of this %s could not be read.", cell(r, date), strings.ToLower(t))
			continue
		}
		d.DueDate, _ = parseDate(cell(r, due))
		v, ok := parseMoney(cell(r, open))
		if !ok {
			errAt(r.Line, "The open balance %q of this %s is not a number.", cell(r, open), strings.ToLower(t))
			continue
		}
		if v == 0 {
			continue
		}
		d.Open = v
		out = append(out, d)
	}
	return out, probs
}
