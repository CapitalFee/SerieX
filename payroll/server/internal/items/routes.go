package items

import (
	"database/sql"
	"encoding/json"
	"errors"
	"reflect"
	"sort"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

func registerRoutes(rt *httpx.Router) {
	rt.C("GET", "/items", listItems)
	rt.C("POST", "/items", func(c *httpx.Ctx) error { return saveItem(c, 0) })
	rt.C("POST", "/items/defaults", createDefaultsRoute)
	rt.C("GET", "/items/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return writeItem(c, id)
	})
	rt.C("PUT", "/items/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return saveItem(c, id)
	})
	rt.C("DELETE", "/items/{id}", deleteItem)
	rt.C("PUT", "/items/{id}/active", setActive)
}

// activeMode parses ?active=all|active|inactive (default active), like SerieX Books.
func activeMode(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "active", "1", "true":
		return "active", nil
	case "all":
		return "all", nil
	case "inactive", "0", "false":
		return "inactive", nil
	}
	return "", apperr.Validation("active", "active must be all, active or inactive")
}

func keepActive(mode string, active bool) bool {
	switch mode {
	case "all":
		return true
	case "inactive":
		return !active
	}
	return active
}

// fillNames sets the (ro) SerieX Books names ("" when Books is unreachable).
func fillNames(it *model.PayrollItem, lk *posting.Lookups) {
	it.ExpenseAccountName, it.LiabilityAccountName, it.AgencyName = "", "", ""
	if lk == nil {
		return
	}
	if it.ExpenseAccountID != nil {
		it.ExpenseAccountName = accountName(lk, *it.ExpenseAccountID)
	}
	if it.LiabilityAccountID != nil {
		it.LiabilityAccountName = accountName(lk, *it.LiabilityAccountID)
	}
	if it.AgencyVendorID != nil {
		if v, ok := lk.Vendors[*it.AgencyVendorID]; ok {
			it.AgencyName = v.FullName
			if it.AgencyName == "" {
				it.AgencyName = v.Name
			}
		}
	}
}

func accountName(lk *posting.Lookups, id int64) string {
	a, ok := lk.Accounts[id]
	if !ok {
		return ""
	}
	if a.FullName != "" {
		return a.FullName
	}
	return a.Name
}

func listItems(c *httpx.Ctx) error {
	mode, err := activeMode(c.Q("active"))
	if err != nil {
		return err
	}
	types := map[string]bool{}
	for _, t := range strings.Split(c.Q("types"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			types[t] = true
		}
	}
	all, err := All(c.Context(), c.DB)
	if err != nil {
		return err
	}
	used, err := itemsOnPaychecks(c.Context(), c.DB)
	if err != nil {
		return err
	}
	lk := posting.Lookup(c)
	out := []*model.PayrollItem{}
	for _, it := range all {
		if !keepActive(mode, it.Active) || (len(types) > 0 && !types[it.Type]) {
			continue
		}
		it.HasPaychecks = used[it.ID]
		fillNames(it, lk)
		out = append(out, it)
	}
	sortItems(out)
	return c.JSON(out)
}

// sortItems orders items like the Payroll Items window: by type, then name.
func sortItems(list []*model.PayrollItem) {
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if ra, rb := typeRank(a.Type), typeRank(b.Type); ra != rb {
			return ra < rb
		}
		if la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name); la != lb {
			return la < lb
		}
		return a.ID < b.ID
	})
}

func loadFull(c *httpx.Ctx, id int64) (*model.PayrollItem, error) {
	it, err := Get(c.Context(), c.DB, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Payroll item not found.")
	}
	if err != nil {
		return nil, err
	}
	if it.HasPaychecks, err = usedOnPaychecks(c.Context(), c.DB, id); err != nil {
		return nil, err
	}
	fillNames(it, posting.Lookup(c))
	return it, nil
}

func writeItem(c *httpx.Ctx, id int64) error {
	it, err := loadFull(c, id)
	if err != nil {
		return err
	}
	return c.JSON(it)
}

// decodeItem reads the body and tells whether "active" was sent.
func decodeItem(c *httpx.Ctx) (*model.PayrollItem, *bool, error) {
	body, err := httpx.ReadJSONBody(c.R, 1<<20)
	if err != nil {
		return nil, nil, err
	}
	var it model.PayrollItem
	if err := json.Unmarshal(body, &it); err != nil {
		return nil, nil, httpx.BodyError(err)
	}
	var a struct {
		Active *bool `json:"active"`
	}
	json.Unmarshal(body, &a)
	return &it, a.Active, nil
}

// checkBooksRefs verifies the SerieX Books accounts/agency when Books can be
// read. The lookups are cached for 30 seconds, so a miss is checked again
// with fresh lookups (the account may have been created in Books just now).
func checkBooksRefs(c *httpx.Ctx, it *model.PayrollItem, old *model.PayrollItem) error {
	lk := posting.Lookup(c)
	if !lk.OK && refsChanged(it, old) {
		// an expired SerieX Books session: sign in again so the accounts can
		// be checked (an unreachable Books server does not block the save)
		if _, err := books.Default.Accounts(c.Context(), books.S(c), books.AcctBank); err != nil && books.IsAuth(err) {
			return books.ToAppErr(err)
		}
	}
	err := missingBooksRefs(lk, it, old)
	if err == nil {
		return nil
	}
	posting.Invalidate(c.CompanyID)
	return missingBooksRefs(posting.Lookup(c), it, old)
}

// refsChanged reports whether the item points to SerieX Books records it did not use before.
func refsChanged(it, old *model.PayrollItem) bool {
	changed := func(a, b *int64) bool {
		if a == nil {
			return false
		}
		return b == nil || *a != *b
	}
	if old == nil {
		return it.ExpenseAccountID != nil || it.LiabilityAccountID != nil || it.AgencyVendorID != nil
	}
	return changed(it.ExpenseAccountID, old.ExpenseAccountID) || changed(it.LiabilityAccountID, old.LiabilityAccountID) ||
		changed(it.AgencyVendorID, old.AgencyVendorID)
}

func missingBooksRefs(lk *posting.Lookups, it *model.PayrollItem, old *model.PayrollItem) error {
	if lk == nil || !lk.OK {
		return nil
	}
	same := func(a, b *int64) bool { return a != nil && b != nil && *a == *b }
	if it.ExpenseAccountID != nil && (old == nil || !same(old.ExpenseAccountID, it.ExpenseAccountID)) {
		if _, ok := lk.Accounts[*it.ExpenseAccountID]; !ok {
			return apperr.Validation("expenseAccountId", "The expense account does not exist in SerieX Books.")
		}
	}
	if it.LiabilityAccountID != nil && (old == nil || !same(old.LiabilityAccountID, it.LiabilityAccountID)) {
		if _, ok := lk.Accounts[*it.LiabilityAccountID]; !ok {
			return apperr.Validation("liabilityAccountId", "The liability account does not exist in SerieX Books.")
		}
	}
	if it.AgencyVendorID != nil && (old == nil || !same(old.AgencyVendorID, it.AgencyVendorID)) {
		if _, ok := lk.Vendors[*it.AgencyVendorID]; !ok {
			return apperr.Validation("agencyVendorId", "The agency is not a vendor in SerieX Books.")
		}
	}
	return nil
}

func saveItem(c *httpx.Ctx, id int64) error {
	it, act, err := decodeItem(c)
	if err != nil {
		return err
	}
	it.ID = id
	var old *model.PayrollItem
	if id != 0 {
		old, err = Get(c.Context(), c.DB, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Payroll item not found.")
		} else if err != nil {
			return err
		}
	}
	switch {
	case act != nil:
		it.Active = *act
	case old != nil:
		it.Active = old.Active
	default:
		it.Active = true
	}
	if err := normalize(it); err != nil {
		return err
	}
	if err := checkBooksRefs(c, it, old); err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		var before *model.PayrollItem
		if id != 0 {
			var err error
			if before, err = Get(c.Context(), tx, id); errors.Is(err, sql.ErrNoRows) {
				return apperr.NotFound("Payroll item not found.")
			} else if err != nil {
				return err
			}
		}
		if err := checkItem(c.Context(), tx, it, before); err != nil {
			return err
		}
		if id == 0 {
			newID, err := insertItem(c.Context(), tx, it)
			if err != nil {
				return err
			}
			it.ID = newID
			fillRO(it)
			return store.Audit(c.Context(), tx, c.User, "add", "item", newID, "Payroll item "+it.Name, it)
		}
		if err := updateItem(c.Context(), tx, it); err != nil {
			return err
		}
		fillRO(it)
		return store.Audit(c.Context(), tx, c.User, "modify", "item", id, "Payroll item "+it.Name, changes(before, it))
	})
	if err != nil {
		return err
	}
	return writeItem(c, it.ID)
}

func deleteItem(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		it, err := Get(c.Context(), tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Payroll item not found.")
		} else if err != nil {
			return err
		}
		where, err := usage(c.Context(), tx, id)
		if err != nil {
			return err
		}
		if where != "" {
			return usedMessage(where)
		}
		if _, err := tx.ExecContext(c.Context(), `DELETE FROM payroll_items WHERE id = ?`, id); err != nil {
			return err
		}
		return store.Audit(c.Context(), tx, c.User, "delete", "item", id, "Payroll item "+it.Name, it)
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}

func setActive(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body struct {
		Active *bool `json:"active"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	if body.Active == nil {
		return apperr.Validation("active", "Send active true or false.")
	}
	err = c.Write(func(tx *sql.Tx) error {
		it, err := Get(c.Context(), tx, id)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Payroll item not found.")
		} else if err != nil {
			return err
		}
		if it.Active == *body.Active {
			return nil
		}
		it.Active = *body.Active
		if it.Active {
			// only the uniqueness rule matters when reactivating
			if err := checkItem(c.Context(), tx, it, it); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(c.Context(), `UPDATE payroll_items SET active = ?, updated_at = ? WHERE id = ?`, store.B(it.Active), store.Now(), id); err != nil {
			return err
		}
		action := "make_inactive"
		if it.Active {
			action = "make_active"
		}
		return store.Audit(c.Context(), tx, c.User, action, "item", id, "Payroll item "+it.Name, map[string]any{"active": it.Active})
	})
	if err != nil {
		return err
	}
	return writeItem(c, id)
}

// changes lists the fields that differ between two versions of a record (audit details).
func changes(before, after any) map[string]any {
	toMap := func(v any) map[string]any {
		m := map[string]any{}
		b, _ := json.Marshal(v)
		json.Unmarshal(b, &m)
		return m
	}
	a, b := toMap(before), toMap(after)
	out := map[string]any{}
	for k, v := range b {
		if !reflect.DeepEqual(a[k], v) {
			out[k] = map[string]any{"before": a[k], "after": v}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// POST /items/defaults {state, year}

// Names of the accounts created by Payroll Setup in SerieX Books.
const (
	acctWages      = "Payroll Expenses:Wages"
	acctTaxes      = "Payroll Expenses:Payroll Taxes"
	acctBenefits   = "Payroll Expenses:Benefits"
	acctReimb      = "Payroll Expenses:Reimbursements"
	acctFederal    = "Payroll Liabilities:Federal Taxes (941)"
	acctFUTA       = "Payroll Liabilities:Federal Unemployment (940)"
	acctStateWH    = "Payroll Liabilities:State Withholding"
	acctStateUI    = "Payroll Liabilities:State Unemployment & Disability"
	acctLocal      = "Payroll Liabilities:Local Taxes"
	acctRetirement = "Payroll Liabilities:Retirement Plans"
	acctHealth     = "Payroll Liabilities:Health & Benefits"
	acctOther      = "Payroll Liabilities:Other Deductions"
	irsVendorName  = "United States Treasury"
)

func createDefaultsRoute(c *httpx.Ctx) error {
	var body struct {
		State string `json:"state"`
		Year  int    `json:"year"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	state := strings.ToUpper(strings.TrimSpace(body.State))
	if state == "" {
		c.DB.QueryRowContext(c.Context(), `SELECT primary_state FROM company WHERE id = 1`).Scan(&state)
	}
	year := body.Year
	if year == 0 {
		year = time.Now().Year()
	}
	if year < 2000 || year > 2100 {
		return apperr.Validation("year", "Invalid year.")
	}
	var st *model.StateTax
	if state != "" {
		tables, _, err := taxes.Tables(year)
		if err != nil {
			return apperr.BadRequest("The tax tables could not be loaded: %v", err)
		}
		s, ok := tables.States[state]
		if !ok {
			return apperr.Validation("state", "There are no tax tables for the state %q.", state)
		}
		if s.State == "" {
			s.State = state
		}
		st = &s
	}
	refs, warnings, err := defaultRefs(c, st)
	if err != nil {
		return err
	}

	created := 0
	err = c.Write(func(tx *sql.Tx) error {
		n, err := createDefaults(c.Context(), tx, state, year, refs)
		if err != nil {
			return err
		}
		created = n
		if n == 0 {
			return nil
		}
		summary := "Default payroll items"
		if state != "" {
			summary += " for " + state
		}
		return store.Audit(c.Context(), tx, c.User, "add", "item", 0, summary, map[string]any{"state": state, "year": year, "created": n})
	})
	if err != nil {
		return err
	}
	if warnings == nil {
		warnings = []string{}
	}
	return c.JSON(map[string]any{"created": created, "warnings": warnings})
}

// defaultRefs finds the accounts and agencies new default items should use:
// first the ones the company's existing items already use, then the SerieX
// Books accounts and vendors created by Payroll Setup (by name). Missing state
// agencies are created in SerieX Books as vendors. An expired SerieX Books
// session is returned as an error (books_auth: the client signs in again)
// instead of creating items without accounts.
func defaultRefs(c *httpx.Ctx, st *model.StateTax) (DefaultRefs, []string, error) {
	var refs DefaultRefs
	var warnings []string
	ctx := c.Context()
	all, _ := All(ctx, c.DB)
	list := make([]*model.PayrollItem, 0, len(all))
	for _, it := range all {
		list = append(list, it)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Active != list[j].Active {
			return list[i].Active
		}
		return list[i].ID < list[j].ID
	})
	pick := func(dst **int64, src *int64) {
		if *dst == nil && src != nil && *src > 0 {
			v := *src
			*dst = &v
		}
	}
	state := ""
	if st != nil {
		state = st.State
	}
	for _, it := range list {
		switch {
		case it.Type == model.ItemSalary || it.Type == model.ItemHourly:
			pick(&refs.WagesExpense, it.ExpenseAccountID)
		case it.Type == model.ItemAddition && it.TaxTracking == model.TrackNone:
			pick(&refs.ReimbExpense, it.ExpenseAccountID)
		case it.Type == model.ItemContribution:
			pick(&refs.BenefitsExpense, it.ExpenseAccountID)
		case it.Type == model.ItemDeduction && (it.TaxTracking == model.Track401k || it.TaxTracking == model.TrackRoth401k):
			pick(&refs.RetirementLiab, it.LiabilityAccountID)
		case it.Type == model.ItemDeduction && (it.TaxTracking == model.Track125 || it.TaxTracking == model.TrackHSA):
			pick(&refs.HealthLiab, it.LiabilityAccountID)
		case it.Type == model.ItemOtherTax:
			pick(&refs.LocalLiab, it.LiabilityAccountID)
		}
		switch it.TaxCode {
		case model.TaxFIT:
			pick(&refs.FederalLiab, it.LiabilityAccountID)
			pick(&refs.IRSVendor, it.AgencyVendorID)
		case model.TaxSSER, model.TaxMedER:
			pick(&refs.TaxesExpense, it.ExpenseAccountID)
			pick(&refs.FederalLiab, it.LiabilityAccountID)
		case model.TaxFUTA:
			pick(&refs.FUTALiab, it.LiabilityAccountID)
			pick(&refs.TaxesExpense, it.ExpenseAccountID)
		case model.TaxSIT:
			pick(&refs.StateWHLiab, it.LiabilityAccountID)
			if it.State == state {
				pick(&refs.StateWHVendor, it.AgencyVendorID)
			}
		case model.TaxSUIER:
			pick(&refs.StateUILiab, it.LiabilityAccountID)
			if it.State == state {
				pick(&refs.StateUIVendor, it.AgencyVendorID)
			}
		}
	}

	posting.Invalidate(c.CompanyID) // accounts/vendors may have been added in SerieX Books just now
	lk := posting.Lookup(c)
	if !lk.OK {
		if _, err := books.Default.Accounts(ctx, books.S(c), books.AcctBank); err != nil && books.IsAuth(err) {
			return refs, nil, books.ToAppErr(err)
		}
	}
	byName := map[string]int64{}
	for id, a := range lk.Accounts {
		byName[strings.ToLower(a.FullName)] = id
	}
	acct := func(dst **int64, full string) {
		if *dst != nil {
			return
		}
		if id, ok := byName[strings.ToLower(full)]; ok {
			*dst = &id
		}
	}
	acct(&refs.WagesExpense, acctWages)
	acct(&refs.TaxesExpense, acctTaxes)
	acct(&refs.BenefitsExpense, acctBenefits)
	acct(&refs.ReimbExpense, acctReimb)
	acct(&refs.FederalLiab, acctFederal)
	acct(&refs.FUTALiab, acctFUTA)
	acct(&refs.StateWHLiab, acctStateWH)
	acct(&refs.StateUILiab, acctStateUI)
	acct(&refs.LocalLiab, acctLocal)
	acct(&refs.RetirementLiab, acctRetirement)
	acct(&refs.HealthLiab, acctHealth)
	acct(&refs.OtherLiab, acctOther)

	// Agencies: find the vendor by name (like Payroll Setup: a customer or
	// other name already using it means "<name> (Agency)"), make it active
	// again when needed, or create it.
	names := map[int64]books.Name{}
	for _, m := range []map[int64]books.Name{lk.Vendors, lk.Others, lk.Jobs} {
		for id, n := range m {
			names[id] = n
		}
	}
	created := map[string]int64{}
	vendor := func(dst **int64, name string) {
		name = strings.TrimSpace(strings.ReplaceAll(name, ":", "-"))
		if *dst != nil || name == "" || !lk.OK {
			return
		}
		for _, cand := range []string{name, name + " (Agency)"} {
			if id, ok := created[strings.ToLower(cand)]; ok {
				*dst = &id
				return
			}
			var found *books.Name
			for _, n := range names {
				if n.ParentID == nil && strings.EqualFold(n.Name, cand) {
					n := n
					found = &n
					break
				}
			}
			if found != nil && found.Kind != books.NameVendor {
				continue // the name belongs to a customer or other name
			}
			if found != nil {
				if !found.Active {
					if _, err := books.Default.SetNameActive(ctx, books.S(c), found.ID, true); err != nil {
						warnings = append(warnings, "Could not make the vendor \""+cand+"\" active in SerieX Books: "+books.ToAppErr(err).Error())
					} else {
						posting.Invalidate(c.CompanyID)
					}
				}
				id := found.ID
				*dst = &id
				return
			}
			n, err := books.Default.CreateName(ctx, books.S(c), books.Name{Kind: books.NameVendor, Name: cand, CompanyName: name,
				PrintOnCheckAs: name, Active: true})
			if err != nil {
				warnings = append(warnings, "Could not create the vendor \""+cand+"\" in SerieX Books: "+books.ToAppErr(err).Error())
				return
			}
			posting.Invalidate(c.CompanyID)
			created[strings.ToLower(cand)] = n.ID
			id := n.ID
			*dst = &id
			return
		}
		warnings = append(warnings, "The name \""+name+"\" is already used in SerieX Books by a customer or other name; choose the agency of the new items yourself.")
	}
	// agencies are looked up (and created) only for tax items still to be created
	needWH, needUI := map[string]bool{}, map[string]bool{}
	have := map[string]bool{}
	for _, it := range all {
		if it.Type == model.ItemFederalTax || it.Type == model.ItemStateTax {
			have[taxIdentity(it.TaxCode, it.State, it.TaxKey)] = true
		}
	}
	stateCode := ""
	if st != nil {
		stateCode = st.State
	}
	for _, d := range defaultItems(stateCode, 0, nil, st, DefaultRefs{}) {
		if d.Type != model.ItemFederalTax && d.Type != model.ItemStateTax || have[taxIdentity(d.TaxCode, d.State, d.TaxKey)] {
			continue
		}
		switch {
		case d.Type == model.ItemFederalTax:
			needWH["IRS"] = true
		case d.TaxCode == model.TaxSIT:
			needWH[d.State] = true
		default:
			needUI[d.State] = true
		}
	}
	if needWH["IRS"] {
		vendor(&refs.IRSVendor, irsVendorName)
	}
	if st != nil && needWH[st.State] && st.Income.Has {
		vendor(&refs.StateWHVendor, st.AgencyWithholding)
	}
	if st != nil && needUI[st.State] {
		if refs.StateUIVendor == nil && refs.StateWHVendor != nil &&
			strings.EqualFold(strings.TrimSpace(st.AgencyUnemployment), strings.TrimSpace(st.AgencyWithholding)) {
			v := *refs.StateWHVendor
			refs.StateUIVendor = &v
		}
		vendor(&refs.StateUIVendor, st.AgencyUnemployment)
	}
	if !lk.OK {
		warnings = append(warnings, "SerieX Books could not be reached: the new items have no accounts or agencies where none could be found. Edit them before paying employees.")
	}
	return refs, warnings, nil
}
