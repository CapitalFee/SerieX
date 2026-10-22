package forms

import (
	"bytes"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// SSA EFW2 (Publication 42-007, tax year 2026): RA, RE, RW (+RO), RT, RU, RF
// records of exactly 512 bytes, each followed by CR/LF. Alphanumeric fields
// are upper case, left justified and blank filled; money fields are cents,
// right justified and zero filled; unused money fields are zeros.

const recLen = 512

type record [recLen]byte

func newRecord(id string) *record {
	r := &record{}
	for i := range r {
		r[i] = ' '
	}
	r.raw(1, 2, id)
	return r
}

// raw writes s left justified into positions start..end (1-based, inclusive).
func (r *record) raw(start, end int, s string) {
	n := end - start + 1
	if len(s) > n {
		s = s[:n]
	}
	copy(r[start-1:end], []byte(s))
}

// alpha writes an upper case alphanumeric field.
func (r *record) alpha(start, end int, s string) { r.raw(start, end, strings.ToUpper(ascii(s))) }

// num writes a right justified, zero filled number (money in cents).
func (r *record) num(start, end int, v int64) {
	if v < 0 {
		v = 0
	}
	n := end - start + 1
	s := strconv.FormatInt(v, 10)
	if len(s) > n {
		s = strings.Repeat("9", n)
	}
	r.raw(start, end, strings.Repeat("0", n-len(s))+s)
}

// ascii keeps printable ASCII characters (accents dropped).
func ascii(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c >= 32 && c < 127 {
			b.WriteRune(c)
		}
	}
	return strings.TrimSpace(b.String())
}

// nameField keeps the characters SSA accepts in name fields (letters, space, hyphen, apostrophe).
func nameField(s string) string {
	var b strings.Builder
	for _, c := range strings.ToUpper(ascii(s)) {
		if (c >= 'A' && c <= 'Z') || c == ' ' || c == '-' || c == '\'' {
			b.WriteRune(c)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

// addrField keeps letters, digits, spaces and common address punctuation.
func addrField(s string) string {
	var b strings.Builder
	for _, c := range strings.ToUpper(ascii(s)) {
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || strings.ContainsRune(" -/#.,&'", c) {
			b.WriteRune(c)
		}
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func zipParts(z string) (string, string) {
	d := store.Digits(z)
	switch {
	case len(d) >= 9:
		return d[:5], d[5:9]
	case len(d) >= 5:
		return d[:5], ""
	}
	return d, ""
}

// money fields of the RW / RO records by box 12 code.
var rwBox12 = map[string][2]int{
	"D": {287, 297}, "E": {298, 308}, "F": {309, 319}, "G": {320, 330}, "H": {331, 341}, "W": {364, 374}, "Q": {386, 396},
	"C": {408, 418}, "V": {419, 429}, "Y": {430, 440}, "AA": {441, 451}, "BB": {452, 462}, "DD": {463, 473}, "FF": {474, 484},
}
var roBox12 = map[string][2]int{
	"R": {34, 44}, "S": {45, 55}, "T": {56, 66}, "M": {67, 77}, "N": {78, 88}, "Z": {89, 99}, "EE": {111, 121}, "GG": {122, 132},
	"HH": {133, 143}, "II": {144, 154}, "A": {155, 165}, "B": {166, 176}, "J": {177, 187}, "K": {188, 198}, "L": {199, 209},
	"P": {210, 220}, "TA": {221, 231}, "TP": {232, 242}, "TT": {243, 253},
}

// RT / RU total fields for the RW / RO fields (by RW/RO start position).
var rtFields = map[int][2]int{
	188: {10, 24}, 199: {25, 39}, 210: {40, 54}, 221: {55, 69}, 232: {70, 84}, 243: {85, 99}, 254: {100, 114}, 276: {130, 144},
	287: {145, 159}, 298: {160, 174}, 309: {175, 189}, 320: {190, 204}, 331: {205, 219}, 353: {235, 249}, 364: {250, 264},
	375: {265, 279}, 386: {280, 294}, 463: {295, 309}, 408: {310, 324}, 419: {340, 354}, 430: {355, 369}, 441: {370, 384},
	452: {385, 399}, 474: {400, 414},
}
var ruFields = map[int][2]int{
	12: {10, 24}, 34: {40, 54}, 45: {55, 69}, 56: {70, 84}, 67: {85, 99}, 78: {100, 114}, 89: {115, 129}, 111: {145, 159},
	122: {160, 174}, 133: {175, 189}, 144: {190, 204}, 155: {205, 219}, 166: {220, 234}, 177: {235, 249}, 188: {250, 264},
	199: {265, 279}, 210: {280, 294}, 221: {295, 309}, 232: {310, 324}, 243: {325, 339},
}

// invalid EIN prefixes (EFW2 RA/RE EIN rules)
var badEINPrefix = map[string]bool{"07": true, "08": true, "09": true, "17": true, "18": true, "19": true, "28": true, "29": true,
	"49": true, "69": true, "70": true, "78": true, "79": true, "89": true}

type efw2Params struct {
	submitterID  string
	submitter    string // submitter name
	contact      string
	phone        string
	ext          string
	email        string
	fax          string
	preparer     string // A, L, S, P, O
	resub        bool
	wfid         string
	terminating  bool
	pin          string
	softwareCode string
}

// efw2Route serves GET /forms/w2/efw2 (administrators only, audited).
func efw2Route(c *httpx.Ctx) error {
	if c.Assistant {
		return apperr.Forbidden("AI assistants cannot create the W-2 electronic file (it contains full social security numbers).")
	}
	if !c.IsAdmin {
		return apperr.Forbidden("Only a SerieX Books administrator can create the W-2 electronic file (it contains full social security numbers).")
	}
	year, err := parseYear(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	co, err := loadCompany(ctx, c.DB)
	if err != nil {
		return err
	}
	p := efw2Params{
		submitterID: strings.ToUpper(strings.TrimSpace(c.Q("submitterId"))), submitter: strings.TrimSpace(c.Q("submitterName")),
		contact: strings.TrimSpace(c.Q("contact")), phone: store.Digits(c.Q("phone")), ext: store.Digits(c.Q("ext")),
		email: strings.TrimSpace(c.Q("email")), fax: store.Digits(c.Q("fax")), preparer: strings.ToUpper(strings.TrimSpace(c.Q("preparer"))),
		resub: c.QBool("resub"), wfid: strings.ToUpper(strings.TrimSpace(c.Q("wfid"))), terminating: c.QBool("terminating"),
		pin: strings.ToUpper(strings.TrimSpace(c.Q("pin"))), softwareCode: "98",
	}
	if p.submitter == "" {
		p.submitter = co.Name
	}
	if p.contact == "" {
		p.contact = co.ContactName
	}
	if p.phone == "" {
		p.phone = store.Digits(co.ContactPhone)
	}
	if p.email == "" {
		p.email = co.email
	}
	if p.preparer == "" {
		p.preparer = "L"
	}
	if len(p.submitterID) != 8 || strings.Trim(p.submitterID, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") != "" {
		return apperr.Validation("submitterId", "Enter the 8-character User ID (letters and numbers) of your SSA Business Services Online (BSO) account.")
	}
	if !strings.Contains("ALSPO", p.preparer) || len(p.preparer) != 1 {
		return apperr.Validation("preparer", "Preparer code: A (accounting firm), L (self-prepared), S (service bureau), P (parent company) or O (other).")
	}
	if p.pin != "" && !validSignaturePIN(p.pin) {
		return apperr.Validation("pin", "The employer signature PIN has the form S-123456-7 (from SSA Business Services Online).")
	}
	if p.resub && len(p.wfid) != 6 {
		return apperr.Validation("wfid", "A resubmission needs the 6-character Wage File Identifier (WFID) from the SSA notice.")
	}
	ein := store.Digits(co.EIN)
	if len(ein) != 9 {
		return apperr.Validation("ein", "The company has no valid employer identification number (EIN). Enter it in Company Payroll Information.")
	}
	res, _, err := computeW2(ctx, c.DB, year, true)
	if err != nil {
		return err
	}
	if len(res.Employees) == 0 {
		return apperr.Validation("year", "No employee was paid in %d: there are no W-2s to file.", year)
	}
	emps, err := loadEmployees(ctx, c.DB)
	if err != nil {
		return err
	}

	// questions the user can answer with "create the file anyway"
	var issues []string
	if badEINPrefix[ein[:2]] {
		issues = append(issues, fmt.Sprintf("The EIN %s begins with %s, which SSA does not accept.", co.EIN, ein[:2]))
	}
	if strings.TrimSpace(co.Address.Line1) == "" || strings.TrimSpace(co.Address.City) == "" || len(store.Digits(co.Address.Zip)) < 5 {
		issues = append(issues, "The company address is incomplete.")
	}
	if p.contact == "" || p.phone == "" || p.email == "" {
		issues = append(issues, "The employer contact name, phone number or e-mail address is missing.")
	}
	for _, w := range res.Employees {
		ssn := store.Digits(w.SSN)
		if len(ssn) != 9 {
			issues = append(issues, fmt.Sprintf("%s has no social security number (zeros will be reported).", w.EmployeeName))
		} else if strings.HasPrefix(ssn, "666") || ssn[0] == '9' {
			issues = append(issues, fmt.Sprintf("%s: social security number %s is not valid for SSA.", w.EmployeeName, store.MaskSSN(ssn)))
		}
		for _, v := range []float64{w.Box1, w.Box2, w.Box3, w.Box4, w.Box5, w.Box6, w.Box7, w.Box10} {
			if v < 0 {
				issues = append(issues, fmt.Sprintf("%s has a negative W-2 amount (reported as zero).", w.EmployeeName))
				break
			}
		}
		for _, b := range w.Box12 {
			if b.Amount < 0 {
				issues = append(issues, fmt.Sprintf("%s: box 12 code %s is negative (reported as zero).", w.EmployeeName, b.Code))
			}
			if b.Code == "TP" && len(w.Box14b) == 0 {
				issues = append(issues, fmt.Sprintf("%s: box 12 code TP needs a Treasury Tipped Occupation Code (box 14b).", w.EmployeeName))
			}
			if _, ok := rwBox12[b.Code]; !ok {
				if _, ok := roBox12[b.Code]; !ok {
					issues = append(issues, fmt.Sprintf("%s: box 12 code %s has no field in the EFW2 file and is left out.", w.EmployeeName, b.Code))
				}
			}
		}
	}
	if len(issues) > 0 && !c.Force() {
		return apperr.Confirm("The W-2 file has problems:\n%s\nCreate the file anyway?", strings.Join(issues, "\n"))
	}

	file, rw := buildEFW2(year, co, res, emps, p)
	if err := c.Write(func(tx *sql.Tx) error {
		return store.Audit(ctx, tx, c.User, "export", "form", 0, fmt.Sprintf("W-2 electronic file (EFW2) %d: %d employees", year, rw),
			map[string]any{"form": "W-2", "year": year, "records": rw, "issues": len(issues)})
	}); err != nil {
		return err
	}
	w := c.W
	w.Header().Set("Content-Type", "text/plain; charset=us-ascii")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="W2REPORT_%d.txt"`, year))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-RW-Records", strconv.Itoa(rw))
	_, err = w.Write(file)
	return err
}

// buildEFW2 returns the file and the number of RW records.
func buildEFW2(year int, co *companyRow, res *model.W2Result, emps map[int64]*employeeRow, p efw2Params) ([]byte, int) {
	var out bytes.Buffer
	put := func(r *record) {
		out.Write(r[:])
		out.WriteString("\r\n")
	}
	ein := store.Digits(co.EIN)
	czip, cext := zipParts(co.Address.Zip)

	// RA submitter
	ra := newRecord("RA")
	ra.raw(3, 11, ein)
	ra.alpha(12, 19, p.submitterID)
	if p.resub {
		ra.raw(29, 29, "1")
		ra.alpha(30, 35, p.wfid)
	} else {
		ra.raw(29, 29, "0")
	}
	ra.raw(36, 37, p.softwareCode)
	ra.alpha(38, 94, addrField(co.Name))
	ra.alpha(95, 116, addrField(co.Address.Line2))
	ra.alpha(117, 138, addrField(co.Address.Line1))
	ra.alpha(139, 160, addrField(co.Address.City))
	ra.alpha(161, 162, co.Address.State)
	ra.raw(163, 167, czip)
	ra.raw(168, 171, cext)
	ra.alpha(217, 273, addrField(p.submitter))
	ra.alpha(274, 295, addrField(co.Address.Line2))
	ra.alpha(296, 317, addrField(co.Address.Line1))
	ra.alpha(318, 339, addrField(co.Address.City))
	ra.alpha(340, 341, co.Address.State)
	ra.raw(342, 346, czip)
	ra.raw(347, 350, cext)
	ra.alpha(396, 422, nameField(p.contact))
	ra.raw(423, 437, p.phone)
	ra.raw(438, 442, p.ext)
	ra.raw(446, 485, ascii(p.email)) // e-mail keeps its case
	ra.raw(489, 498, p.fax)
	ra.raw(500, 500, p.preparer)
	put(ra)

	// RE employer
	re := newRecord("RE")
	re.num(3, 6, int64(year))
	re.raw(8, 16, ein)
	if p.terminating {
		re.raw(26, 26, "1")
	} else {
		re.raw(26, 26, "0")
	}
	re.alpha(40, 96, addrField(co.Name))
	re.alpha(97, 118, addrField(co.Address.Line2))
	re.alpha(119, 140, addrField(co.Address.Line1))
	re.alpha(141, 162, addrField(co.Address.City))
	re.alpha(163, 164, co.Address.State)
	re.raw(165, 169, czip)
	re.raw(170, 173, cext)
	re.raw(174, 174, "N") // kind of employer: none apply
	re.raw(219, 219, "R") // employment code: regular (Form 941)
	re.raw(221, 221, "0") // third-party sick pay
	re.alpha(222, 248, nameField(p.contact))
	re.raw(249, 263, p.phone)
	re.raw(264, 268, p.ext)
	re.raw(269, 278, p.fax)
	re.raw(279, 318, ascii(p.email))
	re.alpha(319, 328, p.pin)
	put(re)

	rtTot := map[int]int64{}
	ruTot := map[int]int64{}
	rwCount, roCount := 0, 0
	for _, w := range res.Employees {
		e := emps[w.EmployeeID]
		rw := newRecord("RW")
		ssn := store.Digits(w.SSN)
		if len(ssn) != 9 {
			ssn = "000000000"
		}
		rw.raw(3, 11, ssn)
		first, middle, last, suffix := w.FirstName, "", w.LastName, w.Suffix
		var addr model.Address = w.Address
		if e != nil {
			middle = e.middle
		}
		rw.alpha(12, 26, nameField(first))
		rw.alpha(27, 41, nameField(middle))
		rw.alpha(42, 61, nameField(last))
		rw.alpha(62, 65, strings.ReplaceAll(nameField(suffix), " ", ""))
		rw.alpha(66, 87, addrField(addr.Line2))
		rw.alpha(88, 109, addrField(addr.Line1))
		rw.alpha(110, 131, addrField(addr.City))
		rw.alpha(132, 133, addr.State)
		z, x := zipParts(addr.Zip)
		rw.raw(134, 138, z)
		rw.raw(139, 142, x)
		vals := map[int]int64{
			188: store.Cents(w.Box1), 199: store.Cents(w.Box2), 210: store.Cents(w.Box3), 221: store.Cents(w.Box4),
			232: store.Cents(w.Box5), 243: store.Cents(w.Box6), 254: store.Cents(w.Box7), 276: store.Cents(w.Box10),
			353: 0, 375: 0, // box 11 nonqualified plans (not tracked)
		}
		ro := map[int]int64{12: store.Cents(w.Box8)}
		for _, b := range w.Box12 {
			if pos, ok := rwBox12[b.Code]; ok {
				vals[pos[0]] += store.Cents(b.Amount)
			} else if pos, ok := roBox12[b.Code]; ok {
				ro[pos[0]] += store.Cents(b.Amount)
			}
		}
		for _, f := range [][2]int{{188, 198}, {199, 209}, {210, 220}, {221, 231}, {232, 242}, {243, 253}, {254, 264}, {276, 286},
			{287, 297}, {298, 308}, {309, 319}, {320, 330}, {331, 341}, {353, 363}, {364, 374}, {375, 385}, {386, 396},
			{408, 418}, {419, 429}, {430, 440}, {441, 451}, {452, 462}, {463, 473}, {474, 484}} {
			rw.num(f[0], f[1], vals[f[0]])
			rtTot[f[0]] += vals[f[0]]
		}
		rw.raw(486, 486, boolDigit(w.Statutory))
		rw.raw(488, 488, boolDigit(w.RetirementPlan))
		rw.raw(489, 489, boolDigit(w.ThirdPartySick))
		if len(w.Box14b) > 0 {
			rw.raw(490, 492, store.Digits(w.Box14b[0]))
		}
		if len(w.Box14b) > 1 {
			rw.raw(493, 495, store.Digits(w.Box14b[1]))
		}
		put(rw)
		rwCount++

		hasRO := false
		for _, v := range ro {
			if v != 0 {
				hasRO = true
			}
		}
		if hasRO {
			r := newRecord("RO")
			for pos, end := range roFieldEnds() {
				r.num(pos, end, ro[pos])
				ruTot[pos] += ro[pos]
			}
			put(r)
			roCount++
		}
	}

	// RT total
	rt := newRecord("RT")
	rt.num(3, 9, int64(rwCount))
	for pos, f := range rtFields {
		rt.num(f[0], f[1], rtTot[pos])
	}
	rt.num(325, 339, 0) // income tax withheld by a third-party sick pay payer
	put(rt)
	if roCount > 0 {
		ru := newRecord("RU")
		ru.num(3, 9, int64(roCount))
		ru.num(25, 39, 0) // combined A+B field: valid through 2025 only
		for pos, f := range ruFields {
			ru.num(f[0], f[1], ruTot[pos])
		}
		for _, f := range [][2]int{{355, 369}, {370, 384}, {385, 399}, {400, 414}, {415, 429}, {430, 444}, {445, 459}, {460, 474}, {475, 489}} {
			ru.num(f[0], f[1], 0) // Puerto Rico and territories
		}
		put(ru)
	}
	// RF final
	rf := newRecord("RF")
	rf.num(8, 16, int64(rwCount))
	put(rf)
	return out.Bytes(), rwCount
}

// roFieldEnds lists every RO money field (start -> end) written with zeros when unused.
func roFieldEnds() map[int]int {
	m := map[int]int{12: 22, 23: 33}
	for _, f := range roBox12 {
		m[f[0]] = f[1]
	}
	for _, f := range [][2]int{{275, 285}, {286, 296}, {297, 307}, {308, 318}, {319, 329}, {330, 340}, {341, 351}, {363, 373}, {374, 384}} {
		m[f[0]] = f[1] // Puerto Rico and territories
	}
	return m
}

// validSignaturePIN: RE positions 319-328, "S-XXXXXX-Y" with digits (2026).
func validSignaturePIN(pin string) bool {
	if len(pin) != 10 || pin[0] != 'S' || pin[1] != '-' || pin[8] != '-' {
		return false
	}
	return store.Digits(pin[2:8]) == pin[2:8] && store.Digits(pin[9:]) == pin[9:]
}

func boolDigit(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
