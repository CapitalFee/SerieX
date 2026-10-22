package liabilities

import (
	"context"
	"database/sql"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

// isLiabilityCategory: paycheck line categories that create a liability.
func isLiabilityCategory(cat string) bool {
	switch cat {
	case model.CatEmployeeTax, model.CatEmployerTax, model.CatDeduction, model.CatContribution:
		return true
	}
	return false
}

// liabilityItems loads every payroll item (active and inactive) and keeps the
// ones that carry a liability (taxes, deductions, company contributions).
func liabilityItems(ctx context.Context, q store.Q) (map[int64]*model.PayrollItem, error) {
	all, err := items.All(ctx, q)
	if err != nil {
		return nil, err
	}
	out := map[int64]*model.PayrollItem{}
	for id, it := range all {
		if isLiabilityCategory(it.Category) && it.EffectiveGroup != "" {
			out[id] = it
		}
	}
	return out, nil
}

// itemRank orders liability items like the Payroll Liability Balances report:
// federal, state and other taxes, then deductions and company contributions.
func itemRank(t string) int {
	switch t {
	case model.ItemFederalTax:
		return 0
	case model.ItemStateTax:
		return 1
	case model.ItemOtherTax:
		return 2
	case model.ItemDeduction:
		return 3
	case model.ItemContribution:
		return 4
	}
	return 5
}

func lessItem(a, b *model.PayrollItem) bool {
	if ra, rb := itemRank(a.Type), itemRank(b.Type); ra != rb {
		return ra < rb
	}
	if la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name); la != lb {
		return la < lb
	}
	return a.ID < b.ID
}

// groupRank orders payment groups: federal 941, federal 940, state groups, vendors, unassigned.
func groupRank(g string) int {
	switch {
	case g == model.GroupFederal941:
		return 0
	case g == model.GroupFederal940:
		return 1
	case strings.HasPrefix(g, "state_wh:"):
		return 2
	case strings.HasPrefix(g, "state_ui:"):
		return 3
	case strings.HasPrefix(g, "vendor:"):
		return 4
	}
	return 5
}

// validGroup reports whether g is a payment group key.
func validGroup(g string) bool {
	switch {
	case g == model.GroupFederal941, g == model.GroupFederal940, g == model.GroupUnassigned:
		return true
	case strings.HasPrefix(g, "state_wh:"), strings.HasPrefix(g, "state_ui:"):
		st := g[strings.IndexByte(g, ':')+1:]
		return len(st) == 2 && strings.ToUpper(st) == st
	case strings.HasPrefix(g, "vendor:"):
		n, err := strconv.ParseInt(strings.TrimPrefix(g, "vendor:"), 10, 64)
		return err == nil && n > 0
	}
	return false
}

// groupVendor is the vendor of a "vendor:<id>" group (nil otherwise).
func groupVendor(g string) *int64 {
	if !strings.HasPrefix(g, "vendor:") {
		return nil
	}
	n, err := strconv.ParseInt(strings.TrimPrefix(g, "vendor:"), 10, 64)
	if err != nil || n <= 0 {
		return nil
	}
	return &n
}

// groupLabel is the PAYMENT column text of a group ("Federal 941/944/943",
// "CA Withholding", "CA UI and ETT", a vendor name...).
func groupLabel(g string, its []*model.PayrollItem, vendorName string) string {
	switch {
	case g == model.GroupFederal941:
		return "Federal 941/944/943"
	case g == model.GroupFederal940:
		return "Federal 940"
	case strings.HasPrefix(g, "state_wh:"):
		return strings.TrimPrefix(g, "state_wh:") + " Withholding"
	case strings.HasPrefix(g, "state_ui:"):
		var keys []string
		seen := map[string]bool{}
		for _, it := range its {
			k := it.TaxKey
			if it.TaxCode == model.TaxSUIEE || it.TaxCode == model.TaxSUIER || k == "" || seen[k] {
				continue
			}
			seen[k] = true
			keys = append(keys, k)
		}
		sort.Strings(keys)
		label := strings.TrimPrefix(g, "state_ui:") + " UI"
		switch len(keys) {
		case 0:
		case 1:
			label += " and " + keys[0]
		default:
			label += ", " + strings.Join(keys[:len(keys)-1], ", ") + " and " + keys[len(keys)-1]
		}
		return label
	}
	if vendorName != "" {
		return vendorName
	}
	var names []string
	for _, it := range its {
		names = append(names, it.Name)
	}
	if g == model.GroupUnassigned {
		if len(names) == 0 {
			return "Unassigned (no payee)"
		}
		return "Unassigned (no payee)"
	}
	if len(names) > 0 {
		return strings.Join(names, ", ")
	}
	return g
}

// ---------------------------------------------------------------------------
// Payment schedules (stored rows + defaults)

type schedule struct {
	Group  string
	Vendor *int64
	Freq   string
	Method string
	Stored bool
}

type schedules struct {
	rows    map[string]*schedule
	deposit string
}

func loadSchedules(ctx context.Context, q store.Q) (*schedules, error) {
	s := &schedules{rows: map[string]*schedule{}, deposit: model.PayFreqMonthly}
	var dep string
	if err := q.QueryRowContext(ctx, `SELECT federal_deposit_schedule FROM company WHERE id = 1`).Scan(&dep); err != nil && err != sql.ErrNoRows {
		return nil, err
	}
	if dep != "" {
		s.deposit = dep
	}
	rows, err := q.QueryContext(ctx, `SELECT payment_group, agency_vendor_id, frequency, method FROM payment_schedules`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var r schedule
		var v sql.NullInt64
		if err := rows.Scan(&r.Group, &v, &r.Freq, &r.Method); err != nil {
			return nil, err
		}
		r.Vendor, r.Stored = store.PtrID(v), true
		s.rows[r.Group] = &r
	}
	return s, rows.Err()
}

// get returns the schedule of a group: the stored row or the defaults. The
// agency is the stored one, else the vendor of a vendor group, else the first
// agency of the group's items.
func (s *schedules) get(g string, its []*model.PayrollItem) *schedule {
	out := schedule{Group: g}
	if r := s.rows[g]; r != nil {
		out = *r
	}
	if !validFrequency(out.Freq) || out.Method == "" {
		f, m := defaultSchedule(g, s.deposit)
		if !validFrequency(out.Freq) {
			out.Freq = f
		}
		if out.Method == "" {
			out.Method = m
		}
	}
	if out.Vendor == nil {
		out.Vendor = groupVendor(g)
	}
	if out.Vendor == nil {
		for _, it := range its {
			if it.AgencyVendorID != nil && *it.AgencyVendorID > 0 {
				v := *it.AgencyVendorID
				out.Vendor = &v
				break
			}
		}
	}
	return &out
}

// ---------------------------------------------------------------------------
// Names

// cachedAgencyNames returns the vendor names stored on liability payments
// (used when SerieX Books cannot be read).
func cachedAgencyNames(ctx context.Context, q store.Q) (map[int64]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT agency_vendor_id, agency_name FROM liability_payments
		WHERE agency_vendor_id IS NOT NULL AND agency_name <> '' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var n string
		if err := rows.Scan(&id, &n); err != nil {
			return nil, err
		}
		out[id] = n
	}
	return out, rows.Err()
}

// namer gives SerieX Books names for display: the cached Books lookups, with
// the agency names stored on payments as a fallback.
type namer struct {
	lk     *posting.Lookups
	cached map[int64]string
}

func newNamer(c *httpx.Ctx) *namer {
	n := &namer{lk: posting.Lookup(c)}
	n.cached, _ = cachedAgencyNames(c.Context(), c.DB)
	return n
}

// booksLookup returns the SerieX Books lookups used to check the references of
// a request. The lookups are cached for 30 seconds, so a vendor, account or
// class created in SerieX Books a moment ago may be missing: when has reports
// a missing reference, the lookups are read again once before the request is
// refused.
func booksLookup(c *httpx.Ctx, has func(lk *posting.Lookups) bool) *posting.Lookups {
	lk := posting.Lookup(c)
	if lk.OK && !has(lk) {
		posting.Invalidate(c.CompanyID)
		lk = posting.Lookup(c)
	}
	return lk
}

// hasVendors / hasAccount report whether the lookups contain the references.
func hasVendors(lk *posting.Lookups, ids ...*int64) bool {
	for _, id := range ids {
		if id != nil {
			if _, ok := lk.Vendors[*id]; !ok {
				return false
			}
		}
	}
	return true
}

func hasAccount(lk *posting.Lookups, id *int64) bool {
	if id == nil {
		return true
	}
	_, ok := lk.Accounts[*id]
	return ok
}

func (n *namer) vendor(id *int64) string {
	if n == nil || id == nil {
		return ""
	}
	if s := n.lk.VendorName(id); s != "" {
		return s
	}
	if v, ok := n.lk.Vendors[*id]; ok && v.Name != "" {
		return v.Name
	}
	return n.cached[*id]
}

func (n *namer) account(id *int64) string {
	if n == nil || id == nil {
		return ""
	}
	if s := n.lk.AccountName(id); s != "" {
		return s
	}
	if a, ok := n.lk.Accounts[*id]; ok {
		return a.Name
	}
	return ""
}

// ---------------------------------------------------------------------------
// Query helpers

// dateFilter adds "col >= from AND col <= to" for the bounds that are set.
func dateFilter(col, from, to string, where *[]string, args *[]any) {
	if from != "" {
		*where = append(*where, col+" >= ?")
		*args = append(*args, from)
	}
	if to != "" {
		*where = append(*where, col+" <= ?")
		*args = append(*args, to)
	}
}

// rangeParams reads and validates ?from&to (both optional).
func rangeParams(c *httpx.Ctx) (string, string, error) {
	from, to := strings.TrimSpace(c.Q("from")), strings.TrimSpace(c.Q("to"))
	if from != "" && !store.ValidDate(from) {
		return "", "", apperr.Validation("from", "Please enter a valid From date.")
	}
	if to != "" && !store.ValidDate(to) {
		return "", "", apperr.Validation("to", "Please enter a valid To date.")
	}
	if from != "" && to != "" && from > to {
		return "", "", apperr.Validation("from", "The From date must be on or before the To date.")
	}
	return from, to, nil
}

// mdy formats YYYY-MM-DD as MM/DD/YYYY.
func mdy(date string) string {
	t, err := store.ParseDate(date)
	if err != nil {
		return date
	}
	return t.Format("01/02/2006")
}

// fmtMoney formats cents as 1,234.56 (with "-" for negatives).
func fmtMoney(c int64) string {
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
	cents := strconv.FormatInt(c%100, 10)
	if len(cents) == 1 {
		cents = "0" + cents
	}
	out := b.String() + "." + cents
	if neg {
		return "-" + out
	}
	return out
}
