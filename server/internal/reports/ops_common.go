package reports

// Shared helpers of the operational reports (customers, vendors, sales,
// purchases, inventory, banking, lists). Every package-level identifier of the
// ops_*.go files starts with "ops".

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriex/internal/model"
	"seriex/internal/store"
)

// ---------------------------------------------------------------------------
// Values, cells and columns

// opsVals accumulates numbers by column key (money in cents, quantities as is).
type opsVals map[string]float64

func (v opsVals) add(o opsVals) {
	for k, x := range o {
		v[k] += x
	}
}

func (v opsVals) clone() opsVals {
	c := opsVals{}
	c.add(v)
	return c
}

func opsC(key, label, typ string) model.ReportColumn {
	return model.ReportColumn{Key: key, Label: label, Type: typ}
}

// opsM converts cents to dollars for a money cell.
func opsM(c int64) float64 { return store.Dollars(c) }

// opsMF converts (possibly fractional, after cash-basis scaling) cents to dollars.
func opsMF(c float64) float64 { return store.Dollars(int64(math.Round(c))) }

// opsQty rounds a quantity for display.
func opsQty(q float64) float64 { return math.Round(q*10000) / 10000 }

// opsPct returns a percentage (12.5 means 12.5%) rounded to 2 decimals, or nil when den is 0.
func opsPct(num, den float64) any {
	if den == 0 {
		return nil
	}
	return math.Round(num/den*10000) / 100
}

// opsShortDate formats YYYY-MM-DD as "Oct 17, 26" (report column headers).
func opsShortDate(d string) string {
	t, err := time.Parse(iso, d)
	if err != nil {
		return d
	}
	return t.Format("Jan 2, 06")
}

// opsUSDate formats YYYY-MM-DD as MM/DD/YYYY (statement descriptions).
func opsUSDate(d string) string {
	t, err := time.Parse(iso, d)
	if err != nil {
		return d
	}
	return t.Format("01/02/2006")
}

// opsMoneyText formats cents as "1,234.56" (statement descriptions).
func opsMoneyText(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	s := strconv.FormatInt(c/100, 10)
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	out := fmt.Sprintf("%s.%02d", b.String(), c%100)
	if neg {
		return "-" + out
	}
	return out
}

// opsDays returns the number of days from a to b (b - a).
func opsDays(a, b string) int {
	ta, err1 := time.Parse(iso, a)
	tb, err2 := time.Parse(iso, b)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(math.Round(tb.Sub(ta).Hours() / 24))
}

// opsPeriodLabel is the column title of a single-period summary report ("Jan 1 - Oct 17, 26").
func opsPeriodLabel(from, to string) string {
	if from == "" {
		return "TOTAL"
	}
	ft, err1 := time.Parse(iso, from)
	tt, err2 := time.Parse(iso, to)
	if err1 != nil || err2 != nil {
		return "TOTAL"
	}
	if from == to {
		return tt.Format("Jan 2, 06")
	}
	if ft.Year() == tt.Year() {
		if ft.Day() == 1 && tt.AddDate(0, 0, 1).Day() == 1 {
			if ft.Month() == tt.Month() {
				return tt.Format("Jan 06")
			}
			return ft.Format("Jan") + " - " + tt.Format("Jan 06")
		}
		return ft.Format("Jan 2") + " - " + tt.Format("Jan 2, 06")
	}
	return ft.Format("Jan 2, 06") + " - " + tt.Format("Jan 2, 06")
}

// opsPeriods returns the period columns of a summary report: one column for
// "total" (or no columns param), else one per week/month/quarter/year plus TOTAL.
func opsPeriods(p *Params) []Period {
	switch p.Columns {
	case "week", "month", "quarter", "year":
		ps := Periods(p.From, p.To, p.Columns, p.FiscalYearStartMonth)
		if len(ps) > 1 {
			return ps
		}
	}
	return []Period{{Key: "total", Label: opsPeriodLabel(p.From, p.To), From: p.From, To: p.To}}
}

// opsPeriodKey returns the key of the period containing date ("" when none).
func opsPeriodKey(ps []Period, date string) string {
	for _, pr := range ps {
		if (pr.From == "" || date >= pr.From) && date <= pr.To {
			return pr.Key
		}
	}
	return ""
}

func opsTypeLabel(typ, headerAcctType string) string {
	if typ == model.TxBillPayment && headerAcctType == model.AcctCreditCard {
		return "Bill Pmt -CCard"
	}
	if l, ok := model.TxnTypeLabels[typ]; ok {
		return l
	}
	return typ
}

func opsDrill(report string, kv ...string) *model.ReportDrill {
	d := &model.ReportDrill{Report: report, Params: map[string]string{}}
	for i := 0; i+1 < len(kv); i += 2 {
		d.Params[kv[i]] = kv[i+1]
	}
	return d
}

func opsID(id int64) string { return strconv.FormatInt(id, 10) }

func opsTxnRef(id int64) *int64 { return &id }

// ---------------------------------------------------------------------------
// Builder

type opsBuilder struct {
	r   *model.ReportResult
	gid int
}

func opsNew(ctx context.Context, q store.Q, p *Params, title string, asOf, basis bool, cols ...model.ReportColumn) *opsBuilder {
	r := NewResult(ctx, q, p, title, asOf, basis)
	r.Columns = cols
	return &opsBuilder{r: r}
}

func (b *opsBuilder) group() string {
	b.gid++
	return "g" + strconv.Itoa(b.gid)
}

func (b *opsBuilder) row(kind string, level int, group string, cells map[string]any) {
	if cells == nil {
		cells = map[string]any{}
	}
	b.r.Rows = append(b.r.Rows, model.ReportRow{Kind: kind, Level: level, Group: group, Cells: cells})
}

func (b *opsBuilder) rowFull(r model.ReportRow) {
	if r.Cells == nil {
		r.Cells = map[string]any{}
	}
	b.r.Rows = append(b.r.Rows, r)
}

// ---------------------------------------------------------------------------
// Lists loaded once per report

type opsName struct {
	ID, ParentID                                   int64
	Kind, Name, Full                               string
	Level                                          int
	Active                                         bool
	CompanyName, Salutation, First, Middle, Last   string
	JobTitle, Phone, AltPhone, Mobile, Fax, Email  string
	Bill1, Bill2, Bill3, City, State, Zip, Country string
	AccountNumber                                  string
	TermsID, RepID                                 int64
	parent                                         *opsName
}

func (n *opsName) contact() string {
	parts := []string{}
	for _, s := range []string{n.First, n.Middle, n.Last} {
		if s = strings.TrimSpace(s); s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, " ")
}

// billTo returns the multi-line bill to address (a job without an address
// uses its customer's).
func (n *opsName) billTo() string {
	if n.parent != nil && strings.TrimSpace(n.Bill1+n.Bill2+n.Bill3+n.City+n.State+n.Zip) == "" {
		return n.parent.billTo()
	}
	var lines []string
	for _, s := range []string{n.Bill1, n.Bill2, n.Bill3} {
		if s = strings.TrimSpace(s); s != "" {
			lines = append(lines, s)
		}
	}
	csz := strings.TrimSpace(n.City)
	if n.State != "" {
		if csz != "" {
			csz += ", "
		}
		csz += n.State
	}
	if n.Zip != "" {
		if csz != "" {
			csz += " "
		}
		csz += n.Zip
	}
	if csz != "" {
		lines = append(lines, csz)
	}
	if c := strings.TrimSpace(n.Country); c != "" && c != "US" && c != "USA" {
		lines = append(lines, c)
	}
	if len(lines) > 0 {
		first := strings.ToLower(lines[0])
		if (n.CompanyName != "" && strings.ToLower(n.CompanyName) == first) || strings.ToLower(n.contact()) == first || strings.ToLower(n.Name) == first {
			return strings.Join(lines, "\n")
		}
	}
	head := n.CompanyName
	if head == "" {
		head = n.contact()
	}
	if head == "" {
		head = n.Name
	}
	return strings.Join(append([]string{head}, lines...), "\n")
}

func opsLoadNames(ctx context.Context, q store.Q) (map[int64]*opsName, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, kind, name, IFNULL(parent_id, 0), active, company_name, salutation,
		first_name, middle_name, last_name, job_title, phone, alt_phone, mobile, fax, email,
		bill_line1, bill_line2, bill_line3, bill_city, bill_state, bill_zip, bill_country,
		account_number, IFNULL(terms_id, 0), IFNULL(rep_id, 0) FROM names`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*opsName{}
	for rows.Next() {
		n := &opsName{}
		if err := rows.Scan(&n.ID, &n.Kind, &n.Name, &n.ParentID, &n.Active, &n.CompanyName, &n.Salutation,
			&n.First, &n.Middle, &n.Last, &n.JobTitle, &n.Phone, &n.AltPhone, &n.Mobile, &n.Fax, &n.Email,
			&n.Bill1, &n.Bill2, &n.Bill3, &n.City, &n.State, &n.Zip, &n.Country,
			&n.AccountNumber, &n.TermsID, &n.RepID); err != nil {
			return nil, err
		}
		out[n.ID] = n
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, n := range out {
		if pn, ok := out[n.ParentID]; ok && pn != n {
			n.parent = pn
		}
		parts := []string{n.Name}
		seen := map[int64]bool{n.ID: true}
		for p := n.ParentID; p != 0; {
			pn, ok := out[p]
			if !ok || seen[p] {
				break
			}
			seen[p] = true
			parts = append([]string{pn.Name}, parts...)
			p = pn.ParentID
		}
		n.Full = strings.Join(parts, ":")
		n.Level = len(parts) - 1
	}
	return out, nil
}

// opsNameFull returns the full name of a name id ("" for 0 / unknown).
func opsNameFull(names map[int64]*opsName, id int64) string {
	if n, ok := names[id]; ok {
		return n.Full
	}
	return ""
}

type opsAcct struct {
	ID, ParentID                      int64
	Name, Number, Type, Special, Full string
	Description, TaxLine              string
	Active                            bool
	Level                             int
}

func opsLoadAccounts(ctx context.Context, q store.Q) (map[int64]*opsAcct, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, number, type, IFNULL(parent_id, 0), special, description, tax_line, active FROM accounts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*opsAcct{}
	for rows.Next() {
		a := &opsAcct{}
		if err := rows.Scan(&a.ID, &a.Name, &a.Number, &a.Type, &a.ParentID, &a.Special, &a.Description, &a.TaxLine, &a.Active); err != nil {
			return nil, err
		}
		out[a.ID] = a
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, a := range out {
		parts := []string{a.Name}
		seen := map[int64]bool{a.ID: true}
		for p := a.ParentID; p != 0; {
			pa, ok := out[p]
			if !ok || seen[p] {
				break
			}
			seen[p] = true
			parts = append([]string{pa.Name}, parts...)
			p = pa.ParentID
		}
		a.Full = strings.Join(parts, ":")
		a.Level = len(parts) - 1
	}
	return out, nil
}

// opsAcctLabel is the account name shown in report columns (full name, with
// the number prefix when account numbers are on).
func opsAcctLabel(accts map[int64]*opsAcct, id int64, prefs store.Prefs) string {
	a, ok := accts[id]
	if !ok {
		return ""
	}
	if prefs.UseAccountNumbers && a.Number != "" {
		return a.Number + " · " + a.Full
	}
	return a.Full
}

type opsItem struct {
	ID, ParentID                       int64
	Type, Name, Full                   string
	Description, PurchaseDescription   string
	SalesPrice, Cost                   float64
	RateIsPercent, Taxable, Active     bool
	IncomeAcct, ExpenseAcct, AssetAcct int64
	PrefVendor                         int64
	ReorderPoint, MaxQty               sql.NullFloat64
	QtyOnHand, AvgCost                 float64
	AssetValue                         int64
	TaxRate                            float64
	TaxAgency                          int64
	Level                              int
}

func opsLoadItems(ctx context.Context, q store.Q) (map[int64]*opsItem, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, type, name, IFNULL(parent_id, 0), description, purchase_description,
		sales_price, cost, rate_is_percent, taxable, active, IFNULL(income_account_id, 0), IFNULL(expense_account_id, 0),
		IFNULL(asset_account_id, 0), IFNULL(preferred_vendor_id, 0), reorder_point, max_qty, qty_on_hand, avg_cost,
		asset_value, tax_rate, IFNULL(tax_agency_id, 0) FROM items`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*opsItem{}
	for rows.Next() {
		it := &opsItem{}
		if err := rows.Scan(&it.ID, &it.Type, &it.Name, &it.ParentID, &it.Description, &it.PurchaseDescription,
			&it.SalesPrice, &it.Cost, &it.RateIsPercent, &it.Taxable, &it.Active, &it.IncomeAcct, &it.ExpenseAcct,
			&it.AssetAcct, &it.PrefVendor, &it.ReorderPoint, &it.MaxQty, &it.QtyOnHand, &it.AvgCost,
			&it.AssetValue, &it.TaxRate, &it.TaxAgency); err != nil {
			return nil, err
		}
		out[it.ID] = it
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, it := range out {
		parts := []string{it.Name}
		seen := map[int64]bool{it.ID: true}
		for p := it.ParentID; p != 0; {
			pi, ok := out[p]
			if !ok || seen[p] {
				break
			}
			seen[p] = true
			parts = append([]string{pi.Name}, parts...)
			p = pi.ParentID
		}
		it.Full = strings.Join(parts, ":")
		it.Level = len(parts) - 1
	}
	return out, nil
}

type opsEntry struct {
	ID, ParentID int64
	Name         string
	Active       bool
	Data         map[string]any
}

func opsLoadList(ctx context.Context, q store.Q, list string) (map[int64]*opsEntry, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, IFNULL(parent_id, 0), active, data FROM list_entries WHERE list = ?`, list)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*opsEntry{}
	for rows.Next() {
		e := &opsEntry{}
		var data string
		if err := rows.Scan(&e.ID, &e.Name, &e.ParentID, &e.Active, &data); err != nil {
			return nil, err
		}
		e.Data = map[string]any{}
		if data != "" {
			json.Unmarshal([]byte(data), &e.Data)
		}
		out[e.ID] = e
	}
	return out, rows.Err()
}

func opsListName(m map[int64]*opsEntry, id int64) string {
	if e, ok := m[id]; ok {
		return e.Name
	}
	return ""
}

func opsNum(m map[string]any, key string) float64 {
	switch v := m[key].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case string:
		f, _ := strconv.ParseFloat(v, 64)
		return f
	}
	return 0
}

func opsBool(m map[string]any, key string) bool {
	switch v := m[key].(type) {
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v == "true" || v == "1"
	}
	return false
}

// ---------------------------------------------------------------------------
// Filters

// opsNameSet returns the allowed name ids for the nameIds filter (plus the
// nameId parameter), including jobs unless includeJobs=0. nil means no filter.
func opsNameSet(p *Params, names map[int64]*opsName) map[int64]bool {
	ids := append([]int64{}, p.Filters.NameIDs...)
	if id := p.ID("nameId"); id > 0 {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	set := map[int64]bool{}
	for _, id := range ids {
		set[id] = true
	}
	if p.Filters.IncludeJobs {
		children := map[int64][]int64{}
		for _, n := range names {
			children[n.ParentID] = append(children[n.ParentID], n.ID)
		}
		stack := append([]int64{}, ids...)
		for len(stack) > 0 {
			id := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, c := range children[id] {
				if !set[c] {
					set[c] = true
					stack = append(stack, c)
				}
			}
		}
	}
	return set
}

// opsItemSet returns the allowed item ids for the itemIds filter / itemId
// parameter including sub-items. nil means no filter.
func opsItemSet(p *Params, items map[int64]*opsItem) map[int64]bool {
	ids := append([]int64{}, p.Filters.ItemIDs...)
	if id := p.ID("itemId"); id > 0 {
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return nil
	}
	set := map[int64]bool{}
	children := map[int64][]int64{}
	for _, it := range items {
		children[it.ParentID] = append(children[it.ParentID], it.ID)
	}
	stack := append([]int64{}, ids...)
	for _, id := range ids {
		set[id] = true
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, c := range children[id] {
			if !set[c] {
				set[c] = true
				stack = append(stack, c)
			}
		}
	}
	return set
}

func opsTypeSet(p *Params) map[string]bool {
	if len(p.Filters.Types) == 0 {
		return nil
	}
	m := map[string]bool{}
	for _, t := range p.Filters.Types {
		m[t] = true
	}
	return m
}

func opsClassOK(p *Params, classID int64) bool {
	if len(p.Filters.ClassIDs) == 0 {
		return true
	}
	for _, c := range p.Filters.ClassIDs {
		if c == classID {
			return true
		}
	}
	return false
}

func opsTextOK(p *Params, memo, ref string) bool {
	if p.Filters.Memo != "" && !strings.Contains(strings.ToLower(memo), strings.ToLower(p.Filters.Memo)) {
		return false
	}
	if p.Filters.RefNumber != "" && !strings.Contains(strings.ToLower(ref), strings.ToLower(p.Filters.RefNumber)) {
		return false
	}
	return true
}

func opsAmountOK(p *Params, cents int64) bool {
	a := math.Abs(store.Dollars(cents))
	if p.Filters.AmountMin != nil && a < *p.Filters.AmountMin-0.0001 {
		return false
	}
	if p.Filters.AmountMax != nil && a > *p.Filters.AmountMax+0.0001 {
		return false
	}
	return true
}

// opsFromTo returns the report range with "" from mapped to the lowest date.
func opsFromTo(p *Params) (string, string) {
	from := p.From
	if from == "" {
		from = "0000-01-01"
	}
	return from, p.To
}

// ---------------------------------------------------------------------------
// Hierarchies (customers:jobs, items) rendered as indented report sections

const opsNoName int64 = -1

type opsTree struct {
	label    map[int64]string
	children map[int64][]int64 // 0 = roots
	parent   map[int64]int64
}

func opsNewTree() *opsTree {
	return &opsTree{label: map[int64]string{}, children: map[int64][]int64{}, parent: map[int64]int64{}}
}

func (t *opsTree) add(id, parent int64, label string) {
	if _, dup := t.label[id]; dup {
		return
	}
	t.label[id] = label
	t.parent[id] = parent
	t.children[parent] = append(t.children[parent], id)
}

// sort orders siblings by label (case-insensitive); the "no name" node goes last.
func (t *opsTree) sort() {
	for k, kids := range t.children {
		sort.SliceStable(kids, func(i, j int) bool {
			a, b := kids[i], kids[j]
			if (a < 0) != (b < 0) {
				return b < 0
			}
			la, lb := strings.ToLower(t.label[a]), strings.ToLower(t.label[b])
			if la != lb {
				return la < lb
			}
			return a < b
		})
		t.children[k] = kids
	}
}

// opsNameTree builds the customer:job hierarchy of all names (any kind).
// Unnamed entries use id opsNoName labelled noName.
func opsNameTree(names map[int64]*opsName, noName string) *opsTree {
	t := opsNewTree()
	ids := make([]int64, 0, len(names))
	for id := range names {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return names[ids[i]].Level < names[ids[j]].Level })
	for _, id := range ids {
		n := names[id]
		parent := n.ParentID
		if _, ok := names[parent]; !ok {
			parent = 0
		}
		t.add(id, parent, n.Name)
	}
	t.add(opsNoName, 0, noName)
	t.sort()
	return t
}

// opsItemTree builds the item hierarchy.
func opsItemTree(items map[int64]*opsItem) *opsTree {
	t := opsNewTree()
	ids := make([]int64, 0, len(items))
	for id := range items {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return items[ids[i]].Level < items[ids[j]].Level })
	for _, id := range ids {
		it := items[id]
		parent := it.ParentID
		if _, ok := items[parent]; !ok {
			parent = 0
		}
		t.add(id, parent, it.Name)
	}
	t.add(opsNoName, 0, "No item")
	t.sort()
	return t
}

// hasAny reports whether id or one of its descendants is in set.
func (t *opsTree) hasAny(id int64, set func(int64) bool, memo map[int64]bool) bool {
	if v, ok := memo[id]; ok {
		return v
	}
	r := set(id)
	for _, c := range t.children[id] {
		if t.hasAny(c, set, memo) {
			r = true
		}
	}
	memo[id] = r
	return r
}

// opsSumSpec describes a hierarchical summary (one row per node).
type opsSumSpec struct {
	tree  *opsTree
	vals  map[int64]opsVals
	roots []int64 // nil = tree roots
	cells func(v opsVals) map[string]any
	// totalCells, when set, gives the cells of "Total <name>" rows (default cells).
	totalCells func(v opsVals) map[string]any
	drill      func(id int64, ownOnly bool) *model.ReportDrill
	// cellDrills, when set, gives per-cell drill-downs of a row (v = the row's
	// values) and the row gets no row-level drill: cells left out (zero
	// amounts) do not drill.
	cellDrills func(id int64, ownOnly bool, v opsVals) map[string]*model.ReportDrill
}

// sumTree writes the rows of a summary hierarchy and returns the grand total.
// Parents with children become sections with a "Total <name>" subtotal; their
// own amounts show as "<name> - Other".
func (b *opsBuilder) sumTree(s *opsSumSpec, level int, group string) opsVals {
	memo := map[int64]bool{}
	has := func(id int64) bool { _, ok := s.vals[id]; return ok }
	total := opsVals{}
	roots := s.roots
	if roots == nil {
		roots = s.tree.children[0]
	}
	for _, id := range roots {
		if s.tree.hasAny(id, has, memo) {
			total.add(b.sumNode(s, id, level, group, has, memo))
		}
	}
	return total
}

func (b *opsBuilder) sumNode(s *opsSumSpec, id int64, level int, group string, has func(int64) bool, memo map[int64]bool) opsVals {
	label := s.tree.label[id]
	own, hasOwn := s.vals[id]
	var kids []int64
	for _, c := range s.tree.children[id] {
		if s.tree.hasAny(c, has, memo) {
			kids = append(kids, c)
		}
	}
	drill := func(own bool) *model.ReportDrill {
		if s.drill == nil || s.cellDrills != nil {
			return nil
		}
		return s.drill(id, own)
	}
	cellDrills := func(own bool, v opsVals) map[string]*model.ReportDrill {
		if s.cellDrills == nil {
			return nil
		}
		return s.cellDrills(id, own, v)
	}
	if len(kids) == 0 {
		cells := s.cells(own)
		cells["label"] = label
		b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: group, Cells: cells, Drill: drill(false), CellDrills: cellDrills(false, own)})
		return own.clone()
	}
	g := b.group()
	b.row("section", level, g, map[string]any{"label": label})
	sum := opsVals{}
	for _, c := range kids {
		sum.add(b.sumNode(s, c, level+1, g, has, memo))
	}
	if hasOwn {
		cells := s.cells(own)
		cells["label"] = label + " - Other"
		b.rowFull(model.ReportRow{Kind: "data", Level: level + 1, Group: g, Cells: cells, Drill: drill(true), CellDrills: cellDrills(true, own)})
		sum.add(own)
	}
	tc := s.cells
	if s.totalCells != nil {
		tc = s.totalCells
	}
	cells := tc(sum)
	cells["label"] = "Total " + label
	b.rowFull(model.ReportRow{Kind: "subtotal", Level: level, Group: g, Cells: cells, Drill: drill(false), CellDrills: cellDrills(false, sum)})
	return sum
}

// opsDetSpec describes a hierarchical detail report: every node with rows
// is a section with its own rows followed by the sections of its children.
type opsDetSpec struct {
	tree  *opsTree
	has   func(id int64) bool
	roots []int64 // nil = tree roots
	// emit writes the node's own data rows and returns their totals.
	emit func(id int64, level int, group string) opsVals
	// total returns the cells of a "Total <name>" row (nil: no total rows).
	total func(v opsVals) map[string]any
	// section optionally adds cells to the section header row.
	section func(id int64) map[string]any
}

func (b *opsBuilder) detTree(s *opsDetSpec, level int) opsVals {
	memo := map[int64]bool{}
	total := opsVals{}
	roots := s.roots
	if roots == nil {
		roots = s.tree.children[0]
	}
	for _, id := range roots {
		if s.tree.hasAny(id, s.has, memo) {
			total.add(b.detNode(s, id, level, memo))
		}
	}
	return total
}

func (b *opsBuilder) detNode(s *opsDetSpec, id int64, level int, memo map[int64]bool) opsVals {
	label := s.tree.label[id]
	g := b.group()
	head := map[string]any{}
	if s.section != nil {
		for k, v := range s.section(id) {
			head[k] = v
		}
	}
	head["label"] = label
	b.row("section", level, g, head)
	sum := opsVals{}
	if s.has(id) {
		sum.add(s.emit(id, level+1, g))
	}
	for _, c := range s.tree.children[id] {
		if s.tree.hasAny(c, s.has, memo) {
			sum.add(b.detNode(s, c, level+1, memo))
		}
	}
	if s.total != nil {
		cells := s.total(sum)
		cells["label"] = "Total " + label
		b.row("subtotal", level, g, cells)
	}
	return sum
}

// ---------------------------------------------------------------------------
// Aging

type opsAging struct {
	interval, through int
	keys, labels      []string
}

// opsNewAging reads agingInterval (days per period, default 30) and
// agingThrough (days past due, default 90).
func opsNewAging(p *Params) *opsAging {
	iv := int(p.ID("agingInterval"))
	if iv <= 0 {
		iv = 30
	}
	th := int(p.ID("agingThrough"))
	if th <= 0 {
		th = 90
	}
	if th < iv {
		th = iv
	}
	n := (th + iv - 1) / iv
	if n > 36 {
		n = 36
		th = n * iv
	}
	a := &opsAging{interval: iv, through: th}
	a.keys = append(a.keys, "current")
	a.labels = append(a.labels, "Current")
	for i := 1; i <= n; i++ {
		lo := (i-1)*iv + 1
		hi := i * iv
		if hi > th {
			hi = th
		}
		a.keys = append(a.keys, fmt.Sprintf("d%d", i))
		a.labels = append(a.labels, fmt.Sprintf("%d - %d", lo, hi))
	}
	a.keys = append(a.keys, "over")
	a.labels = append(a.labels, fmt.Sprintf("> %d", th))
	return a
}

func (a *opsAging) idx(days int) int {
	if days <= 0 {
		return 0
	}
	if days > a.through {
		return len(a.keys) - 1
	}
	return (days-1)/a.interval + 1
}

func (a *opsAging) params(p *Params) []string {
	return []string{"agingInterval", strconv.Itoa(a.interval), "agingThrough", strconv.Itoa(a.through)}
}

// ---------------------------------------------------------------------------
// Open A/R and A/P documents as of a date

type opsDoc struct {
	TxnID     int64
	Type      string
	Date      string
	Ref       string
	NameID    int64
	DueDate   string
	TermsID   int64
	PONumber  string
	Memo      string
	ClassID   int64
	AcctID    int64 // A/R or A/P account
	HdrAcctID int64 // txns.account_id (bank / credit card for payments)
	HdrName   int64 // txns.name_id (the payer of a payment)
	TxnAmount int64
	Orig      int64 // natural-sign A/R (A/P) effect of the transaction for this name
	Open      int64 // natural-sign open balance as of the date
}

// ageDate is the date aging is counted from.
func (d *opsDoc) ageDate(prefs store.Prefs) string {
	if prefs.AgingFrom == "transaction" || d.DueDate == "" {
		return d.Date
	}
	return d.DueDate
}

// opsOpenDocs returns every transaction that touches an A/R (side "ar") or
// A/P (side "ap") account on or before asOf, with its open balance as of that
// date computed from the payment / credit links (not from txns.open_balance).
// Amounts are in natural sign (A/R: debit positive, A/P: credit positive).
//
// Every link moves value between documents: the target (to) is reduced by
// amount + discount, the source (from) by amount and the owner (the payment
// that recorded the discount) by the discount; "reduced" means moved toward
// zero. A link counts once both of its documents exist (latest of the link and
// both transaction dates). The sum of the open balances therefore always equals
// the A/R (A/P) general ledger balance as of the date.
//
// The zero-sum A/R entries (role "credit") that move a credit applied across
// two jobs of a customer from the credit's job to the invoice's job are left
// out: they are not documents, and the link that applies the credit already
// closes both the credit and the invoice here.
func opsOpenDocs(ctx context.Context, q store.Q, side, asOf string) ([]*opsDoc, error) {
	acctType, sign := model.AcctAR, int64(1)
	if side == "ap" {
		acctType, sign = model.AcctAP, -1
	}
	rows, err := q.QueryContext(ctx, `SELECT g.txn_id, IFNULL(g.name_id, 0), SUM(g.amount), MIN(g.account_id),
		t.type, t.date, t.ref_number, t.due_date, IFNULL(t.terms_id, 0), t.po_number, t.memo, IFNULL(t.class_id, 0), t.amount,
		IFNULL(t.account_id, 0), IFNULL(t.name_id, 0)
		FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN txns t ON t.id = g.txn_id
		WHERE a.type = ? AND g.date <= ? AND g.role <> 'credit'
		GROUP BY g.txn_id, IFNULL(g.name_id, 0)
		ORDER BY t.date, t.ref_number, t.id`, acctType, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var docs []*opsDoc
	byTxn := map[int64][]*opsDoc{}
	for rows.Next() {
		d := &opsDoc{}
		var amt int64
		if err := rows.Scan(&d.TxnID, &d.NameID, &amt, &d.AcctID, &d.Type, &d.Date, &d.Ref, &d.DueDate, &d.TermsID,
			&d.PONumber, &d.Memo, &d.ClassID, &d.TxnAmount, &d.HdrAcctID, &d.HdrName); err != nil {
			return nil, err
		}
		d.Orig = amt * sign
		d.Open = d.Orig
		docs = append(docs, d)
		byTxn[d.TxnID] = append(byTxn[d.TxnID], d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	lrows, err := q.QueryContext(ctx, `SELECT l.from_txn_id, l.to_txn_id, l.owner_txn_id, l.amount, l.discount
		FROM txn_links l JOIN txns f ON f.id = l.from_txn_id JOIN txns t ON t.id = l.to_txn_id
		WHERE MAX(l.date, f.date, t.date) <= ? ORDER BY MAX(l.date, f.date, t.date), l.id`, asOf)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	// pick chooses the part of a transaction a link applies to. A payment's
	// A/R entries are split by the customer:job of the invoices it pays, the
	// unapplied rest stays with the payer: use the part with the same name
	// while it still has an open amount, else the payer's part, else the part
	// with the largest open amount.
	pick := func(tid, name int64) *opsDoc {
		ds := byTxn[tid]
		if len(ds) <= 1 {
			if len(ds) == 1 {
				return ds[0]
			}
			return nil
		}
		for _, d := range ds {
			if d.NameID == name && d.Open != 0 {
				return d
			}
		}
		for _, d := range ds {
			if d.NameID == d.HdrName && d.Open != 0 {
				return d
			}
		}
		best := ds[0]
		for _, d := range ds {
			if opsAbs(d.Open) > opsAbs(best.Open) {
				best = d
			}
		}
		return best
	}
	reduce := func(d *opsDoc, x int64) {
		if d == nil || x == 0 {
			return
		}
		if d.Orig >= 0 {
			d.Open -= x
		} else {
			d.Open += x
		}
	}
	for lrows.Next() {
		var from, to, owner, amt, disc int64
		if err := lrows.Scan(&from, &to, &owner, &amt, &disc); err != nil {
			return nil, err
		}
		dt := pick(to, 0)
		if dt == nil {
			continue // not an A/R (A/P) application
		}
		// A payment's A/R entries are split by the customer:job of the
		// invoices it pays: use the part with the invoice's name.
		df := pick(from, dt.NameID)
		if df == nil {
			continue
		}
		reduce(dt, amt+disc)
		reduce(df, amt)
		if do := pick(owner, dt.NameID); do != nil {
			reduce(do, disc)
		} else {
			reduce(df, disc)
		}
	}
	return docs, lrows.Err()
}

// opsBalancesByName returns the natural-sign A/R (A/P) general ledger balance
// of every name as of a date (0 = entries without a name).
func opsBalancesByName(ctx context.Context, q store.Q, side, asOf string) (map[int64]int64, error) {
	acctType, sign := model.AcctAR, int64(1)
	if side == "ap" {
		acctType, sign = model.AcctAP, -1
	}
	rows, err := q.QueryContext(ctx, `SELECT IFNULL(g.name_id, 0), SUM(g.amount) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE a.type = ? AND g.date <= ? GROUP BY IFNULL(g.name_id, 0)`, acctType, asOf)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var id, amt int64
		if err := rows.Scan(&id, &amt); err != nil {
			return nil, err
		}
		out[id] = amt * sign
	}
	return out, rows.Err()
}

// opsTermsName returns the terms names by id.
func opsTermsNames(ctx context.Context, q store.Q) (map[int64]*opsEntry, error) {
	return opsLoadList(ctx, q, model.ListTerms)
}

// ---------------------------------------------------------------------------
// Transaction postings summary (Account / Split / Clr / Amount columns)

type opsPost struct {
	AcctID  int64
	Amount  int64 // signed, debit positive
	Cleared string
	Split   string
	HasGL   bool
}

// opsPostings summarizes the general ledger entries of the transactions
// matching where (a condition on txns t): the header account (txns.account_id,
// else the 'header' entry, else the first entry), its signed amount and
// cleared flag, and the split ("-SPLIT-" when several other accounts).
func opsPostings(ctx context.Context, q store.Q, accts map[int64]*opsAcct, prefs store.Prefs, where string, args ...any) (map[int64]*opsPost, error) {
	rows, err := q.QueryContext(ctx, `SELECT g.txn_id, IFNULL(t.account_id, 0), g.account_id, g.amount, g.role, g.cleared
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id WHERE `+where+` ORDER BY g.txn_id, g.seq, g.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type ent struct {
		acct, amt int64
		role, clr string
	}
	byTxn := map[int64][]ent{}
	hdr := map[int64]int64{}
	var order []int64
	for rows.Next() {
		var tid, tacct int64
		var e ent
		if err := rows.Scan(&tid, &tacct, &e.acct, &e.amt, &e.role, &e.clr); err != nil {
			return nil, err
		}
		if _, ok := byTxn[tid]; !ok {
			order = append(order, tid)
		}
		byTxn[tid] = append(byTxn[tid], e)
		hdr[tid] = tacct
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[int64]*opsPost{}
	for _, tid := range order {
		es := byTxn[tid]
		h := int64(0)
		for _, e := range es {
			if e.acct == hdr[tid] {
				h = e.acct
				break
			}
		}
		if h == 0 {
			for _, e := range es {
				if e.role == "header" {
					h = e.acct
					break
				}
			}
		}
		if h == 0 {
			h = es[0].acct
		}
		p := &opsPost{AcctID: h, HasGL: true}
		others := map[int64]bool{}
		var otherOrder []int64
		for _, e := range es {
			if e.acct == h {
				p.Amount += e.amt
				if p.Cleared == "" {
					p.Cleared = e.clr
				}
			} else if !others[e.acct] {
				others[e.acct] = true
				otherOrder = append(otherOrder, e.acct)
			}
		}
		switch len(otherOrder) {
		case 0:
		case 1:
			p.Split = opsAcctLabel(accts, otherOrder[0], prefs)
		default:
			p.Split = "-SPLIT-"
		}
		out[tid] = p
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Sales lines (sales reports): income posted from item lines of invoices,
// sales receipts, credit memos and statement charges, with their COGS.

type opsSale struct {
	TxnID   int64
	Type    string
	Date    string // posting date (payment date on the cash basis)
	Ref     string
	NameID  int64
	RepID   int64
	Memo    string
	LineID  int64
	ItemID  int64
	Desc    string
	Qty     float64
	Rate    float64
	HasRate bool
	Amount  float64 // cents, positive = sale
	Cogs    float64 // cents
}

const opsSalesWhere = `t.type IN ('INV','SALESRCPT','CREDMEM','STMTCHG') AND g.role IN ('','cogs')
	AND i.type NOT IN ('Payment','Sales Tax Item','Sales Tax Group','Subtotal')`

func opsScanSales(ctx context.Context, q store.Q, cond string, args ...any) ([]*opsSale, error) {
	rows, err := q.QueryContext(ctx, `SELECT g.txn_id, t.type, g.date, t.ref_number, IFNULL(g.name_id, IFNULL(t.name_id, 0)),
		IFNULL(t.rep_id, 0), t.memo, IFNULL(g.line_id, 0), g.id, g.item_id, IFNULL(l.description, ''), l.qty, l.rate, g.amount, g.role
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id JOIN items i ON i.id = g.item_id
		LEFT JOIN txn_lines l ON l.id = g.line_id
		WHERE `+opsSalesWhere+` AND `+cond+`
		ORDER BY g.date, t.ref_number, g.txn_id, IFNULL(l.seq, 0), g.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*opsSale
	byLine := map[[2]int64]*opsSale{}
	for rows.Next() {
		var s opsSale
		var gid, amt int64
		var qty, rate sql.NullFloat64
		var role string
		if err := rows.Scan(&s.TxnID, &s.Type, &s.Date, &s.Ref, &s.NameID, &s.RepID, &s.Memo, &s.LineID, &gid, &s.ItemID,
			&s.Desc, &qty, &rate, &amt, &role); err != nil {
			return nil, err
		}
		key := [2]int64{s.TxnID, s.LineID}
		if s.LineID == 0 {
			key = [2]int64{s.TxnID, -gid}
		}
		cur := byLine[key]
		if cur == nil {
			cur = &s
			if qty.Valid {
				cur.Qty = qty.Float64
				if cur.Type == model.TxCreditMemo {
					cur.Qty = -cur.Qty
				}
			}
			if rate.Valid {
				cur.Rate, cur.HasRate = rate.Float64, true
			}
			byLine[key] = cur
			out = append(out, cur)
		}
		if role == "cogs" {
			cur.Cogs += float64(amt)
		} else {
			cur.Amount -= float64(amt)
		}
	}
	return out, rows.Err()
}

// opsLoadSales returns the sales lines posted within [from, to]. On the cash
// basis invoices, statement charges and credit memos count when paid: each
// payment / credit link dated in the period recognizes the fraction
// (amount + discount) / transaction total of their lines, dated at the link.
func opsLoadSales(ctx context.Context, q store.Q, from, to string, cash bool) ([]*opsSale, error) {
	if !cash {
		return opsScanSales(ctx, q, `g.date >= ? AND g.date <= ?`, from, to)
	}
	out, err := opsScanSales(ctx, q, `t.type = 'SALESRCPT' AND g.date >= ? AND g.date <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	type part struct {
		txn  int64
		frac float64
		date string
	}
	rows, err := q.QueryContext(ctx, `SELECT l.from_txn_id, f.type, f.amount, l.to_txn_id, t.type, t.amount, l.amount + l.discount, l.date
		FROM txn_links l JOIN txns f ON f.id = l.from_txn_id JOIN txns t ON t.id = l.to_txn_id
		WHERE l.date >= ? AND l.date <= ?`, from, to)
	if err != nil {
		return nil, err
	}
	var parts []part
	need := map[int64]bool{}
	for rows.Next() {
		var fid, famt, tid, tamt, x int64
		var ftype, ttype, date string
		if err := rows.Scan(&fid, &ftype, &famt, &tid, &ttype, &tamt, &x, &date); err != nil {
			rows.Close()
			return nil, err
		}
		switch ttype {
		case model.TxInvoice, model.TxStatementCharge, model.TxCreditMemo:
			if tamt != 0 {
				parts = append(parts, part{tid, float64(x) / float64(tamt), date})
				need[tid] = true
			}
		}
		if ftype == model.TxCreditMemo && famt != 0 {
			parts = append(parts, part{fid, float64(x) / float64(famt), date})
			need[fid] = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(parts) == 0 {
		return out, nil
	}
	ids := make([]string, 0, len(need))
	for id := range need {
		ids = append(ids, opsID(id))
	}
	base, err := opsScanSales(ctx, q, `t.id IN (`+strings.Join(ids, ",")+`)`)
	if err != nil {
		return nil, err
	}
	byTxn := map[int64][]*opsSale{}
	for _, s := range base {
		byTxn[s.TxnID] = append(byTxn[s.TxnID], s)
	}
	for _, pt := range parts {
		for _, s := range byTxn[pt.txn] {
			c := *s
			c.Date = pt.date
			c.Amount = s.Amount * pt.frac
			c.Cogs = s.Cogs * pt.frac
			c.Qty = s.Qty * pt.frac
			out = append(out, &c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date < out[j].Date
		}
		return out[i].TxnID < out[j].TxnID
	})
	return out, nil
}

// opsItemGroupLabel is the heading of an item type group.
func opsItemGroupLabel(t string) string {
	switch t {
	case model.ItemInventoryPart:
		return "Inventory"
	case model.ItemService:
		return "Service"
	case model.ItemNonInventory:
		return "Non-inventory Parts"
	case model.ItemOtherCharge:
		return "Other Charges"
	case model.ItemDiscount:
		return "Discounts"
	case model.ItemGroup:
		return "Groups"
	case model.ItemPayment:
		return "Payments"
	case model.ItemSalesTax, model.ItemSalesTaxGroup:
		return "Sales Tax"
	}
	return "Other"
}

var opsItemGroupOrder = []string{model.ItemInventoryPart, model.ItemService, model.ItemNonInventory, model.ItemOtherCharge,
	model.ItemDiscount, model.ItemGroup, model.ItemPayment, model.ItemSalesTax}

// opsItemTypeGroups splits the item tree roots by item type group (Inventory,
// Service, Non-inventory Parts... are shown as sections).
func opsItemTypeGroups(t *opsTree, items map[int64]*opsItem) [][2]any {
	byType := map[string][]int64{}
	for _, id := range t.children[0] {
		typ := ""
		if it, ok := items[id]; ok {
			typ = it.Type
			if typ == model.ItemSalesTaxGroup {
				typ = model.ItemSalesTax
			}
		}
		byType[typ] = append(byType[typ], id)
	}
	var out [][2]any
	for _, typ := range opsItemGroupOrder {
		if ids := byType[typ]; len(ids) > 0 {
			out = append(out, [2]any{opsItemGroupLabel(typ), ids})
		}
	}
	if ids := byType[""]; len(ids) > 0 {
		out = append(out, [2]any{"Other", ids})
	}
	return out
}

// opsAgingCols returns the aging bucket columns.
func opsAgingCols(a *opsAging) []model.ReportColumn {
	cols := []model.ReportColumn{opsC("label", "", "text")}
	for i, k := range a.keys {
		cols = append(cols, opsC(k, a.labels[i], "money"))
	}
	return append(cols, opsC("total", "TOTAL", "money"))
}

// opsTermsOf returns the terms name of a document (falls back to the name's terms).
func opsTermsOf(terms map[int64]*opsEntry, id int64) string { return opsListName(terms, id) }

func opsAbs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
