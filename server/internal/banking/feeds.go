package banking

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// feedTxn is one transaction read from an imported file.
type feedTxn struct {
	FITID       string
	Date        string
	Description string
	CheckNumber string
	Amount      int64 // cents, + money in, - money out
	Raw         map[string]string
}

// asciiUpper upper-cases ASCII letters only, so byte offsets stay valid.
func asciiUpper(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

func isOFX(data []byte) bool {
	head := data
	if len(head) > 4096 {
		head = head[:4096]
	}
	u := asciiUpper(string(head))
	return strings.Contains(u, "OFXHEADER") || strings.Contains(u, "<OFX>") || strings.Contains(asciiUpper(string(data)), "<STMTTRN>")
}

// ofxField returns the text after <TAG> up to the next tag (SGML leaf
// elements have no closing tag; XML ones end with </TAG>).
func ofxField(block, upper, tag string) string {
	i := strings.Index(upper, "<"+tag+">")
	if i < 0 {
		return ""
	}
	rest := block[i+len(tag)+2:]
	if j := strings.IndexByte(rest, '<'); j >= 0 {
		rest = rest[:j]
	}
	return strings.TrimSpace(html.UnescapeString(rest))
}

// forwardFinder finds the next occurrence of a marker at or after a position
// that only moves forward, so a whole file is searched once (a search that
// found nothing is not repeated).
type forwardFinder struct {
	text, marker string
	at           int  // occurrence found by the last search
	from         int  // position the last search started at
	searched     bool // at/from are set
	done         bool // nothing left after from
}

func (f *forwardFinder) next(pos int) int {
	if f.done {
		return -1
	}
	if f.searched && f.at >= pos && f.from <= pos {
		return f.at
	}
	f.searched = true
	j := strings.Index(f.text[pos:], f.marker)
	if j < 0 {
		f.done = true
		return -1
	}
	f.at, f.from = pos+j, pos
	return f.at
}

// ofxAccountID returns the account number of the statement (ACCTID inside
// BANKACCTFROM or CCACCTFROM), "" when missing.
func ofxAccountID(text, upper string) string {
	for _, block := range []string{"<BANKACCTFROM>", "<CCACCTFROM>"} {
		if i := strings.Index(upper, block); i >= 0 {
			end := len(upper)
			if j := strings.Index(upper[i:], "</"+block[1:]); j >= 0 {
				end = i + j
			}
			if v := ofxField(text[i:end], upper[i:end], "ACCTID"); v != "" {
				return v
			}
		}
	}
	return ofxField(text, upper, "ACCTID")
}

// parseOFX reads the STMTTRN records of an OFX / QFX / QBO file (SGML or XML).
// It works in one pass over the file (large downloads stay fast).
func parseOFX(data []byte) (out []feedTxn, problems []model.BankFeedProblem, acctID string) {
	text := string(data)
	upper := asciiUpper(text)
	acctID = ofxAccountID(text, upper)
	open := &forwardFinder{text: upper, marker: "<STMTTRN>"}
	closeTag := &forwardFinder{text: upper, marker: "</STMTTRN>"}
	listEnd := &forwardFinder{text: upper, marker: "</BANKTRANLIST>"}
	pos, n := 0, 0
	for {
		i := open.next(pos)
		if i < 0 {
			break
		}
		start := i + len("<STMTTRN>")
		end := len(text)
		for _, f := range []*forwardFinder{closeTag, open, listEnd} {
			if j := f.next(start); j >= 0 && j < end {
				end = j
			}
		}
		block, ublock := text[start:end], upper[start:end]
		pos = end
		n++

		raw := map[string]string{}
		for _, tag := range []string{"TRNTYPE", "DTPOSTED", "DTUSER", "TRNAMT", "FITID", "CHECKNUM", "REFNUM", "NAME", "MEMO", "PAYEEID", "SIC"} {
			if v := ofxField(block, ublock, tag); v != "" {
				raw[tag] = v
			}
		}
		date := ofxDate(raw["DTPOSTED"])
		if date == "" {
			date = ofxDate(raw["DTUSER"])
		}
		amt, ok := parseAmount(raw["TRNAMT"])
		if date == "" {
			problems = append(problems, model.BankFeedProblem{Row: n, Reason: fmt.Sprintf("the date %q could not be read", raw["DTPOSTED"])})
			continue
		}
		if !ok {
			problems = append(problems, model.BankFeedProblem{Row: n, Reason: fmt.Sprintf("the amount %q could not be read", raw["TRNAMT"])})
			continue
		}
		desc := raw["NAME"]
		if desc == "" {
			desc = raw["MEMO"]
		}
		check := raw["CHECKNUM"]
		if check == "" && strings.EqualFold(raw["TRNTYPE"], "CHECK") {
			check = raw["REFNUM"]
		}
		out = append(out, feedTxn{FITID: raw["FITID"], Date: date, Description: collapseSpaces(desc), CheckNumber: check, Amount: amt, Raw: raw})
	}
	return out, problems, acctID
}

// ofxDate converts YYYYMMDD[HHMMSS[.XXX][TZ]] to YYYY-MM-DD.
func ofxDate(s string) string {
	if len(s) < 8 {
		return ""
	}
	d := s[:4] + "-" + s[4:6] + "-" + s[6:8]
	if !store.ValidDate(d) {
		return ""
	}
	return d
}

func collapseSpaces(s string) string { return strings.Join(strings.Fields(s), " ") }

// parseAmount reads money text: "1,234.56", "-45.00", "$45.00", "(45.00)",
// "45.00-", "45.00 DR", "1.234,56" / "45,00" (decimal comma). Returns cents.
func parseAmount(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	neg := false
	if strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")") {
		neg = true
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	up := strings.ToUpper(s)
	switch {
	case strings.HasSuffix(up, "CR"):
		s = strings.TrimSpace(s[:len(s)-2])
	case strings.HasSuffix(up, "DR"):
		neg = !neg
		s = strings.TrimSpace(s[:len(s)-2])
	}
	if strings.HasSuffix(s, "-") {
		neg = !neg
		s = strings.TrimSpace(s[:len(s)-1])
	}
	s = strings.NewReplacer("$", "", " ", "", " ", "", "USD", "", "usd", "").Replace(s)
	if strings.HasPrefix(s, "-") {
		neg = !neg
		s = s[1:]
	} else if strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	switch {
	case strings.Contains(s, ",") && strings.Contains(s, "."):
		if strings.LastIndex(s, ",") > strings.LastIndex(s, ".") { // 1.234,56
			s = strings.ReplaceAll(s, ".", "")
			s = strings.Replace(s, ",", ".", 1)
		} else {
			s = strings.ReplaceAll(s, ",", "")
		}
	case strings.Count(s, ",") == 1 && len(s)-strings.Index(s, ",") == 3: // 45,00
		s = strings.Replace(s, ",", ".", 1)
	default:
		s = strings.ReplaceAll(s, ",", "")
	}
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || store.MoneyErr("", "", f) != nil {
		return 0, false
	}
	c := store.Cents(f)
	if neg {
		c = -c
	}
	return c, true
}

var dateLayouts = []string{
	"2006-1-2", "1/2/2006", "1/2/06", "2006/1/2", "1-2-2006", "1-2-06", "1.2.2006", "20060102",
	"Jan 2, 2006", "January 2, 2006", "Jan 2 2006", "2 Jan 2006", "02-Jan-2006", "2-Jan-06", "02-Jan-06",
}

// dayFirstLayouts replace the month-first numeric layouts for day-first files.
var dayFirstLayouts = []string{
	"2006-1-2", "2/1/2006", "2/1/06", "2006/1/2", "2-1-2006", "2-1-06", "2.1.2006", "20060102",
	"Jan 2, 2006", "January 2, 2006", "Jan 2 2006", "2 Jan 2006", "02-Jan-2006", "2-Jan-06", "02-Jan-06",
}

// parseFlexDate reads MM/DD/YYYY, M/D/YY, YYYY-MM-DD and a few other common forms.
func parseFlexDate(s string) string { return parseFlexDateOrder(s, false) }

// shownDateOrder returns the order the numeric dates of a file show: "dmy"
// when a first part is above 12 somewhere, as in 13/03/2026 (and no second
// part is), "mdy"
// when a second part is (and no first part is), "" when every date reads
// both ways (or the file has no such dates).
func shownDateOrder(values []string) string {
	first, second := dateParts(values)
	switch {
	case first && !second:
		return "dmy"
	case second && !first:
		return "mdy"
	}
	return ""
}

// dateParts reports whether a first part / a second part of the numeric
// dates in values is above 12 somewhere.
func dateParts(values []string) (first, second bool) {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v == "" || len(v) < 6 || (v[0] >= '0' && v[0] <= '9' && len(v) >= 4 && v[2] != '/' && v[1] != '/' && v[2] != '.' && v[1] != '.' && v[2] != '-' && v[1] != '-') {
			continue // year first, or not numeric
		}
		parts := strings.FieldsFunc(strings.Fields(v)[0], func(r rune) bool { return r == '/' || r == '-' || r == '.' })
		if len(parts) < 3 {
			continue
		}
		a, err1 := strconv.Atoi(parts[0])
		b, err2 := strconv.Atoi(parts[1])
		if err1 != nil || err2 != nil {
			continue
		}
		if a > 12 && a <= 31 {
			first = true
		}
		if b > 12 && b <= 31 {
			second = true
		}
	}
	return first, second
}

func parseFlexDateOrder(s string, dmy bool) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	layouts := dateLayouts
	if dmy {
		layouts = dayFirstLayouts
	}
	try := func(v string) string {
		for _, l := range layouts {
			if t, err := time.Parse(l, v); err == nil && t.Year() > 1900 {
				return t.Format("2006-01-02")
			}
		}
		return ""
	}
	if d := try(s); d != "" {
		return d
	}
	// "10/01/2026 12:00:00 AM", "2026-10-01T00:00:00"
	if i := strings.IndexAny(s, " T"); i > 0 {
		return try(s[:i])
	}
	return ""
}

func normHeader(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		} else {
			b.WriteByte(' ')
		}
	}
	return collapseSpaces(b.String())
}

type csvCols struct {
	date, desc, memo, amount, debit, credit, check, typ int
}

func mapCSVHeader(cells []string) (csvCols, bool) {
	norm := make([]string, len(cells))
	for i, c := range cells {
		norm[i] = normHeader(c)
	}
	find := func(names ...string) int {
		for _, n := range names {
			for i, h := range norm {
				if h == n {
					return i
				}
			}
		}
		return -1
	}
	m := csvCols{}
	m.date = find("date", "transaction date", "trans date", "posted date", "posting date", "post date", "effective date", "booking date", "value date")
	if m.date < 0 {
		for i, h := range norm {
			if strings.Contains(h, "date") {
				m.date = i
				break
			}
		}
	}
	m.desc = find("description", "payee", "name", "transaction description", "payee name", "merchant", "merchant name", "details", "transaction details", "original description", "narrative")
	m.memo = find("memo", "notes", "note", "reference", "additional info")
	if m.desc < 0 {
		m.desc = m.memo
	}
	m.amount = find("amount", "transaction amount", "amount usd", "net amount")
	m.debit = find("debit", "debits", "debit amount", "amount debit", "withdrawal", "withdrawals", "withdrawal amount", "money out", "paid out", "outflow", "charge", "charges")
	m.credit = find("credit", "credits", "credit amount", "amount credit", "deposit", "deposits", "deposit amount", "money in", "paid in", "inflow", "payment", "payments")
	m.check = find("check", "check number", "check no", "check num", "chk", "chk no", "check or slip", "num", "number", "cheque", "cheque number")
	m.typ = find("type", "transaction type", "debit credit", "dr cr", "cr dr", "credit debit")
	ok := m.date >= 0 && (m.amount >= 0 || m.debit >= 0 || m.credit >= 0)
	return m, ok
}

// csvOptions: how to read a bank CSV file.
type csvOptions struct {
	dateOrder string // "mdy", "dmy" or "" (detect)
	// savedOrder: the account's saved order, used when dateOrder is not
	// given and the file's dates read both ways ("" = month first)
	savedOrder string
	// flipSigns: amounts are positive for money out (many credit card
	// exports). It only applies to files with one signed Amount column: in
	// files with separate Debit and Credit columns, or a Debit/Credit
	// indicator column, the file itself says which way the money went.
	flipSigns bool
}

// csvSignIndicators are the values of a Type (Debit/Credit) column that say
// which way the money went.
var csvSignIndicators = map[string]bool{"debit": true, "dr": true, "d": true, "withdrawal": true,
	"credit": true, "cr": true, "c": true, "deposit": true}

// parseCSV reads a bank CSV export: a header row (detected among the first
// rows) with Date, Description/Payee/Name and Amount or Debit/Credit columns.
// It returns the rows read, the rows that could not be read, and the date
// order used.
//
// flipApplies reports whether opt.flipSigns applies to the file (one signed
// Amount column); the signs were reversed when it applies and was set.
func parseCSV(data []byte, opt csvOptions) (out []feedTxn, problems []model.BankFeedProblem, order string, flipApplies bool, err error) {
	data = store.DecodeText(data)
	delim := store.CSVDelimiter(data)
	r := csv.NewReader(bytes.NewReader(data))
	r.Comma = delim
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	// (a tab counts as leading space: trimming would swallow empty tab-separated fields)
	r.TrimLeadingSpace = delim != '\t'
	var records [][]string
	var lines []int
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, "", false, apperr.Validation("file", "The file could not be read as CSV (%s).", plainCSVError(err))
		}
		line, _ := r.FieldPos(0)
		records = append(records, rec)
		lines = append(lines, line)
	}
	hdr := -1
	var cols csvCols
	for i := 0; i < len(records) && i < 20; i++ {
		if m, ok := mapCSVHeader(records[i]); ok {
			hdr, cols = i, m
			break
		}
	}
	if hdr < 0 {
		return nil, nil, "", false, apperr.Validation("file", "The CSV file needs a header row with a Date column, a Description (or Payee/Name) column and an Amount column (or Debit and Credit columns).")
	}
	headers := records[hdr]
	cell := func(row []string, i int) string {
		if i < 0 || i >= len(row) {
			return ""
		}
		return strings.TrimSpace(row[i])
	}
	// the sign comes from the file (Debit / Credit columns or an indicator
	// column): reversing the signs does not apply
	explicit := cols.amount < 0
	if !explicit && cols.typ >= 0 {
		for _, row := range records[hdr+1:] {
			if csvSignIndicators[strings.ToLower(cell(row, cols.typ))] {
				explicit = true
				break
			}
		}
	}
	flipApplies = !explicit
	flipped := opt.flipSigns && flipApplies
	order = validDateOrder(opt.dateOrder)
	if order == "" {
		// the order the dates show; when they read both ways, the saved one
		var dates []string
		for _, row := range records[hdr+1:] {
			dates = append(dates, cell(row, cols.date))
		}
		if order = shownDateOrder(dates); order == "" {
			if order = validDateOrder(opt.savedOrder); order == "" {
				order = "mdy"
			}
		}
	}
	for k, row := range records[hdr+1:] {
		line := lines[hdr+1+k]
		empty := true
		for _, v := range row {
			if strings.TrimSpace(v) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		date := parseFlexDateOrder(cell(row, cols.date), order == "dmy")
		if date == "" {
			problems = append(problems, model.BankFeedProblem{Row: line, Reason: fmt.Sprintf("the date %q could not be read", cell(row, cols.date))})
			continue
		}
		var amt int64
		ok := false
		bad := ""
		if cols.amount >= 0 {
			amt, ok = parseAmount(cell(row, cols.amount))
			bad = cell(row, cols.amount)
			if ok && amt > 0 && cols.typ >= 0 {
				switch strings.ToLower(cell(row, cols.typ)) {
				case "debit", "dr", "d", "withdrawal":
					amt = -amt
				}
			}
		} else {
			d, okD := parseAmount(cell(row, cols.debit))
			cr, okC := parseAmount(cell(row, cols.credit))
			if d < 0 {
				d = -d
			}
			if cr < 0 {
				cr = -cr
			}
			amt, ok = cr-d, okD || okC
			bad = strings.TrimSpace(cell(row, cols.debit) + " " + cell(row, cols.credit))
		}
		if !ok {
			problems = append(problems, model.BankFeedProblem{Row: line, Reason: fmt.Sprintf("the amount %q could not be read", bad)})
			continue
		}
		if flipped {
			amt = -amt
		}
		desc := cell(row, cols.desc)
		if desc == "" {
			desc = cell(row, cols.memo)
		}
		raw := map[string]string{}
		for i, h := range headers {
			if v := cell(row, i); v != "" && strings.TrimSpace(h) != "" {
				raw[strings.TrimSpace(h)] = v
			}
		}
		out = append(out, feedTxn{Date: date, Description: collapseSpaces(desc), CheckNumber: cell(row, cols.check), Amount: amt, Raw: raw})
	}
	return out, problems, order, flipApplies, nil
}

// plainCSVError describes a CSV reading error without Go details.
func plainCSVError(err error) string {
	var pe *csv.ParseError
	if errors.As(err, &pe) {
		return fmt.Sprintf("line %d: %s", pe.Line, pe.Err)
	}
	return "unexpected content"
}

func newBatchID() string {
	b := make([]byte, 3)
	rand.Read(b)
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(b)
}

func dupKey(date string, amount int64, desc string) string {
	return date + "|" + strconv.FormatInt(amount, 10) + "|" + strings.ToLower(collapseSpaces(desc))
}

func checkFeedAccount(a acct) error {
	if a.Type != model.AcctBank && a.Type != model.AcctCreditCard {
		return apperr.Validation("accountId", "Bank imports can only be used with bank and credit card accounts.")
	}
	return nil
}

// maxFeedFile is the largest bank file accepted.
const maxFeedFile = 20 << 20

// ImportOptions are the choices sent with a bank file (multipart fields).
type ImportOptions struct {
	FlipSigns *bool  // "flipSigns": reverse the CSV amount signs (nil: the account's saved choice)
	DateOrder string // "dateOrder": "mdy" | "dmy" | "" (detect / saved choice)
	Accept    map[string]bool
}

// POST /bank-feeds/{accountId}/import (multipart "file"; optional fields
// flipSigns=1|0, dateOrder=mdy|dmy) -> model.BankFeedImportResult.
// A file whose account number belongs to another account asks first
// (confirm, warning "account"; answer with ?accept=account).
func feedImport(c *httpx.Ctx) error {
	accountID, err := c.ID("accountId")
	if err != nil {
		return err
	}
	c.R.Body = http.MaxBytesReader(c.W, c.R.Body, maxFeedFile+(1<<20))
	if err := c.R.ParseMultipartForm(8 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return apperr.Validation("file", "The file is too large (20 MB maximum). Download a shorter date range from your bank.")
		}
		return apperr.Validation("file", "Please choose a file to import.")
	}
	f, _, err := c.R.FormFile("file")
	if err != nil {
		return apperr.Validation("file", "Please choose a file to import.")
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFeedFile+1))
	if err != nil {
		return apperr.Validation("file", "The file could not be read. Try again.")
	}
	if len(data) > maxFeedFile {
		return apperr.Validation("file", "The file is too large (20 MB maximum). Download a shorter date range from your bank.")
	}
	opts := ImportOptions{DateOrder: strings.ToLower(strings.TrimSpace(c.R.FormValue("dateOrder"))), Accept: c.Accepted()}
	if c.Force() {
		opts.Accept[apperr.WarnAccount] = true
	}
	if v := strings.TrimSpace(c.R.FormValue("flipSigns")); v != "" {
		b := v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
		opts.FlipSigns = &b
	}
	// read the saved choices, parse without holding the company's write lock
	saved, err := loadFeedSettings(c.Context(), c.DB, accountID)
	if err != nil {
		return err
	}
	p, err := parseFeed(data, saved, opts)
	if err != nil {
		return err
	}
	var res model.BankFeedImportResult
	err = c.Write(func(tx *sql.Tx) error {
		res, err = importParsed(c.Context(), tx, accountID, p, opts)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(res)
}

// validDateOrder returns order when it is a date order a file can be read
// with ("mdy" or "dmy"), else "" (not chosen).
func validDateOrder(order string) string {
	if order == "mdy" || order == "dmy" {
		return order
	}
	return ""
}

// feedSettings are the saved import choices of an account.
type feedSettings struct {
	flipSigns bool
	dateOrder string
}

func loadFeedSettings(ctx context.Context, q store.Q, accountID int64) (feedSettings, error) {
	var fs feedSettings
	var flip int
	err := q.QueryRowContext(ctx, `SELECT flip_signs, date_order FROM bank_feed_settings WHERE account_id = ?`, accountID).Scan(&flip, &fs.dateOrder)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fs, err
	}
	fs.flipSigns = flip == 1
	fs.dateOrder = validDateOrder(fs.dateOrder)
	return fs, nil
}

// parsedFeed is a bank file read into transactions.
type parsedFeed struct {
	format    string
	txns      []feedTxn
	problems  []model.BankFeedProblem
	acctID    string // OFX account number
	dateOrder string
	flipSigns bool // the amount signs were reversed
	// saveFlip is the "reverse the signs" choice to remember for the
	// account: the one sent when it applies to the file, else the saved one
	saveFlip bool
}

func parseFeed(data []byte, saved feedSettings, opts ImportOptions) (*parsedFeed, error) {
	p := &parsedFeed{format: "csv"}
	if isOFX(data) {
		p.format = "ofx"
		p.txns, p.problems, p.acctID = parseOFX(data)
	} else {
		// an order sent with the file wins; else the dates' own order, then
		// the saved one for dates that read both ways
		co := csvOptions{dateOrder: opts.DateOrder, savedOrder: saved.dateOrder, flipSigns: saved.flipSigns}
		if opts.FlipSigns != nil {
			co.flipSigns = *opts.FlipSigns
		}
		var err error
		var applies bool
		if p.txns, p.problems, p.dateOrder, applies, err = parseCSV(data, co); err != nil {
			return nil, err
		}
		p.flipSigns = co.flipSigns && applies
		p.saveFlip = saved.flipSigns
		if applies {
			p.saveFlip = co.flipSigns
		}
	}
	if len(p.txns) == 0 {
		if n := len(p.problems); n > 0 {
			return nil, apperr.Validation("file", "None of the %d transactions in the file could be read (for example, line %d: %s).", n, p.problems[0].Row, p.problems[0].Reason)
		}
		return nil, apperr.Validation("file", "No transactions were found in the file.")
	}
	return p, nil
}

// digitsOf keeps the digits of an account number.
func digitsOf(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sameAcctNumber: the numbers are equal, or one ends with the other (banks
// often send only the last digits) with at least 4 digits in common.
func sameAcctNumber(a, b string) bool {
	da, db := digitsOf(a), digitsOf(b)
	if da == "" || db == "" {
		return strings.EqualFold(strings.TrimSpace(a), strings.TrimSpace(b))
	}
	if len(da) < len(db) {
		da, db = db, da
	}
	return da == db || (len(db) >= 4 && strings.HasSuffix(da, db))
}

func lastDigits(s string) string {
	d := digitsOf(s)
	if d == "" {
		d = s
	}
	if len(d) > 4 {
		return "…" + d[len(d)-4:]
	}
	return d
}

// checkFeedAccountNumber compares the account number of an OFX file with
// the chosen account: a file for another account asks first; the number is
// remembered when the account has none yet.
func checkFeedAccountNumber(ctx context.Context, tx *sql.Tx, a acct, fileAcct string, opts ImportOptions) error {
	if fileAcct == "" {
		return nil
	}
	var own string
	if err := tx.QueryRowContext(ctx, `SELECT bank_acct_number FROM accounts WHERE id = ?`, a.ID).Scan(&own); err != nil {
		return err
	}
	if own != "" && sameAcctNumber(own, fileAcct) {
		return nil
	}
	// another bank or credit card account with that number?
	other := ""
	rows, err := tx.QueryContext(ctx, `SELECT id, bank_acct_number FROM accounts WHERE id <> ? AND bank_acct_number <> '' AND type IN (?, ?)`,
		a.ID, model.AcctBank, model.AcctCreditCard)
	if err != nil {
		return err
	}
	names, err := store.FullNames(ctx, tx, "accounts")
	if err != nil {
		rows.Close()
		return err
	}
	for rows.Next() {
		var id int64
		var num string
		if err := rows.Scan(&id, &num); err != nil {
			rows.Close()
			return err
		}
		if other == "" && sameAcctNumber(num, fileAcct) {
			other = names[id]
		}
	}
	rows.Close()
	if own == "" && other == "" {
		_, err := tx.ExecContext(ctx, `UPDATE accounts SET bank_acct_number = ? WHERE id = ?`, fileAcct, a.ID)
		return err
	}
	if opts.Accept[apperr.WarnAccount] {
		return nil
	}
	whose := ""
	if other != "" {
		whose = " (" + other + ")"
	}
	if own != "" {
		return apperr.ConfirmKind(apperr.WarnAccount, "This file is for account %s%s, but %s is account %s. Import it into %s anyway?",
			lastDigits(fileAcct), whose, a.FullName, lastDigits(own), a.FullName)
	}
	return apperr.ConfirmKind(apperr.WarnAccount, "This file is for account %s%s. Import it into %s anyway?", lastDigits(fileAcct), whose, a.FullName)
}

// ImportFeed imports a bank or credit card download (OFX/QFX/QBO, else CSV)
// into the bank feed items of accountID inside tx, skipping duplicates.
func ImportFeed(ctx context.Context, tx *sql.Tx, accountID int64, data []byte) (model.BankFeedImportResult, error) {
	saved, err := loadFeedSettings(ctx, tx, accountID)
	if err != nil {
		return model.BankFeedImportResult{}, err
	}
	opts := ImportOptions{Accept: map[string]bool{apperr.WarnAccount: true}}
	p, err := parseFeed(data, saved, opts)
	if err != nil {
		return model.BankFeedImportResult{}, err
	}
	return importParsed(ctx, tx, accountID, p, opts)
}

// importParsed stores the transactions of a parsed bank file.
func importParsed(ctx context.Context, tx *sql.Tx, accountID int64, p *parsedFeed, opts ImportOptions) (model.BankFeedImportResult, error) {
	res := model.BankFeedImportResult{BatchID: newBatchID(), Format: p.format, Invalid: len(p.problems),
		Problems: []model.BankFeedProblem{}, DateOrder: p.dateOrder, FlipSigns: p.flipSigns}
	for i, pr := range p.problems {
		if i == 20 {
			break
		}
		res.Problems = append(res.Problems, pr)
	}
	err := func() error {
		a, err := getAcct(ctx, tx, accountID)
		if err != nil {
			return err
		}
		if err := checkFeedAccount(a); err != nil {
			return err
		}
		if p.format == "ofx" {
			if err := checkFeedAccountNumber(ctx, tx, a, p.acctID, opts); err != nil {
				return err
			}
		} else if order := validDateOrder(opts.DateOrder); opts.FlipSigns != nil || order != "" {
			// remember the choices sent for the next file of this account; a
			// choice not sent keeps the saved one (saveFlip is the saved
			// "reverse the signs" unless one was sent and applies)
			if _, err := tx.ExecContext(ctx, `INSERT INTO bank_feed_settings(account_id, flip_signs, date_order) VALUES(?,?,?)
				ON CONFLICT(account_id) DO UPDATE SET flip_signs = excluded.flip_signs,
					date_order = CASE WHEN excluded.date_order = '' THEN bank_feed_settings.date_order ELSE excluded.date_order END`,
				accountID, store.B(p.saveFlip), order); err != nil {
				return err
			}
		}
		// Existing items: FITIDs, and date+amount+description counts (all items, and those without FITID).
		fitids := map[string]bool{}
		keysAll, keysNoFit := map[string]int{}, map[string]int{}
		rows, err := tx.QueryContext(ctx, `SELECT fitid, date, amount, description FROM bank_feed_items WHERE account_id = ?`, accountID)
		if err != nil {
			return err
		}
		for rows.Next() {
			var fitid, date, desc string
			var amt int64
			if err := rows.Scan(&fitid, &date, &amt, &desc); err != nil {
				rows.Close()
				return err
			}
			k := dupKey(date, amt, desc)
			keysAll[k]++
			if fitid != "" {
				fitids[fitid] = true
			} else {
				keysNoFit[k]++
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		now := store.Now()
		for _, t := range p.txns {
			k := dupKey(t.Date, t.Amount, t.Description)
			if t.FITID != "" {
				if fitids[t.FITID] {
					res.Skipped++
					continue
				}
				// the same transaction imported earlier from a file without ids (CSV)
				if keysNoFit[k] > 0 {
					keysNoFit[k]--
					keysAll[k]--
					res.Skipped++
					continue
				}
				fitids[t.FITID] = true
			} else if keysAll[k] > 0 {
				keysAll[k]--
				if keysNoFit[k] > 0 {
					keysNoFit[k]--
				}
				res.Skipped++
				continue
			}
			raw, _ := json.Marshal(t.Raw)
			if _, err := tx.ExecContext(ctx, `INSERT INTO bank_feed_items(account_id, batch_id, fitid, date, description, amount,
				check_number, status, raw, imported_at) VALUES(?,?,?,?,?,?,?,'new',?,?)`,
				accountID, res.BatchID, t.FITID, t.Date, t.Description, t.Amount, t.CheckNumber, string(raw), now); err != nil {
				return err
			}
			res.Imported++
		}
		return nil
	}()
	return res, err
}

// effStatus: an added/matched item whose transaction was deleted is new again.
const effStatus = `(CASE WHEN status IN ('added', 'matched') AND txn_id IS NULL THEN 'new' ELSE status END)`

// GET /bank-feeds/accounts -> [{accountId, accountName, accountType, newCount, lastImport}]
func feedAccounts(c *httpx.Ctx) error {
	ctx := c.Context()
	names, err := store.FullNames(ctx, c.DB, "accounts")
	if err != nil {
		return err
	}
	rows, err := c.DB.QueryContext(ctx, `SELECT a.id, a.type,
			(SELECT COUNT(*) FROM bank_feed_items b WHERE b.account_id = a.id AND `+effStatus+` = 'new'),
			COALESCE((SELECT MAX(imported_at) FROM bank_feed_items b WHERE b.account_id = a.id), ''),
			COALESCE(s.date_order, ''), COALESCE(s.flip_signs, 0)
		FROM accounts a LEFT JOIN bank_feed_settings s ON s.account_id = a.id WHERE a.type IN (?, ?) AND (a.active = 1 OR EXISTS (SELECT 1 FROM bank_feed_items b WHERE b.account_id = a.id))`,
		model.AcctBank, model.AcctCreditCard)
	if err != nil {
		return err
	}
	defer rows.Close()
	type feedAccount struct {
		AccountID   int64  `json:"accountId"`
		AccountName string `json:"accountName"`
		AccountType string `json:"accountType"`
		NewCount    int    `json:"newCount"`
		LastImport  string `json:"lastImport"`
		// the choices saved with the last CSV file imported: how its dates
		// were read ("mdy" | "dmy", "" = none saved) and whether the amount
		// signs were reversed
		DateOrder string `json:"dateOrder"`
		FlipSigns bool   `json:"flipSigns"`
	}
	out := []feedAccount{}
	for rows.Next() {
		var fa feedAccount
		var flip int
		if err := rows.Scan(&fa.AccountID, &fa.AccountType, &fa.NewCount, &fa.LastImport, &fa.DateOrder, &flip); err != nil {
			return err
		}
		fa.AccountName = names[fa.AccountID]
		fa.DateOrder = validDateOrder(fa.DateOrder)
		fa.FlipSigns = flip == 1
		out = append(out, fa)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.SliceStable(out, func(i, j int) bool {
		ri, rj := model.AccountTypeRank(out[i].AccountType), model.AccountTypeRank(out[j].AccountType)
		if ri != rj {
			return ri < rj
		}
		return strings.ToLower(out[i].AccountName) < strings.ToLower(out[j].AccountName)
	})
	return c.JSON(out)
}
