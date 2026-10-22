package setup

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

// GET /api/info
func handleInfo(w http.ResponseWriter, r *http.Request) error {
	addProof(w, r) // X-SerieX-Challenge -> X-SerieX-Proof (see proof.go)
	years := taxes.Years()
	if years == nil {
		years = []int{}
	}
	return httpx.WriteJSON(w, http.StatusOK, model.AppInfo{
		App:            "SerieX Payroll",
		Version:        AppVersion,
		BooksURL:       books.Default.BaseURL,
		BooksReachable: books.Default.Ping(r.Context()),
		TaxYears:       years,
	})
}

// GET /api/meta
func handleMeta(w http.ResponseWriter, r *http.Request) error {
	return httpx.WriteJSON(w, http.StatusOK, buildMeta())
}

// GET /api/companies: SerieX Books company files with their payroll status.
func handleCompanies(w http.ResponseWriter, r *http.Request) error {
	list, err := books.Default.Companies(r.Context())
	if err != nil {
		return books.ToAppErr(err)
	}
	out := []model.PayrollCompanyFile{}
	for _, cf := range list {
		pc := model.PayrollCompanyFile{ID: cf.ID, Name: cf.Name, BooksModified: cf.Modified}
		if mgr.Exists(cf.ID) {
			pc.PayrollSetUp = true
			if db, err := mgr.Open(cf.ID); err == nil {
				db.QueryRowContext(r.Context(), `SELECT setup_done FROM company WHERE id = 1`).Scan(&pc.SetupDone)
			}
		}
		out = append(out, pc)
	}
	return httpx.WriteJSON(w, http.StatusOK, out)
}

// GET /api/companies/{id}/bank-accounts: the Books bank accounts for the
// Payroll Setup default bank account picker (the payroll file does not exist yet).
func handleSetupBankAccounts(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return apperr.NotFound("Company file not found.")
	}
	sess, err := sessionFor(r, id)
	if err != nil {
		return err
	}
	accts, err := books.Default.Accounts(r.Context(), books.Session{CompanyID: id, Token: sess.BooksToken, Assistant: sess.Assistant}, books.AcctBank)
	if err != nil {
		return books.ToAppErr(err)
	}
	out := []model.BooksAccount{}
	for _, a := range accts {
		out = append(out, toBooksAccount(a))
	}
	return httpx.WriteJSON(w, http.StatusOK, out)
}

// ---------------------------------------------------------------------------
// Payroll setup

var setupMu sync.Mutex

// POST /api/companies/{id}/setup (SetupRequest) -> PayrollCompany
func handleSetup(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return apperr.NotFound("Company file not found.")
	}
	sess, err := sessionFor(r, id)
	if err != nil {
		return err
	}
	if !sess.IsAdmin {
		return forbidden("Only a SerieX Books administrator can set up payroll.")
	}
	var req model.SetupRequest
	if err := httpx.DecodeJSON(r, &req); err != nil {
		return err
	}
	setupMu.Lock()
	defer setupMu.Unlock()
	if mgr.Exists(id) {
		return apperr.Conflict("Payroll is already set up for this company file.")
	}
	// Books records are created before the payroll file: finish even when the browser goes away.
	ctx := context.WithoutCancel(r.Context())

	// --- validate
	state := strings.ToUpper(strings.TrimSpace(req.PrimaryState))
	if state == "" {
		return apperr.Validation("primaryState", "Choose the state where your employees work.")
	}
	if stateName(state) == "" {
		return apperr.Validation("primaryState", "%q is not a US state.", req.PrimaryState)
	}
	year := req.FirstPayrollYear
	if year == 0 {
		year = time.Now().Year()
	}
	if year < 2000 || year > 2100 {
		return apperr.Validation("firstPayrollYear", "Enter the year of your first payroll.")
	}
	ty, _, err := taxes.Tables(year)
	if err != nil {
		return apperr.New(http.StatusInternalServerError, apperr.CodeInternal, "The payroll tax tables could not be loaded: %v", err)
	}
	st, ok := ty.States[state]
	if !ok {
		return apperr.Validation("primaryState", "There are no payroll tax tables for %s.", stateName(state))
	}
	dep := strings.TrimSpace(req.FederalDepositSchedule)
	if dep == "" {
		dep = model.PayFreqMonthly
	}
	if dep != model.PayFreqMonthly && dep != model.PayFreqSemiweekly {
		return apperr.Validation("federalDepositSchedule", "The federal deposit schedule must be monthly or semiweekly.")
	}
	freq := strings.TrimSpace(req.PayFrequency)
	if freq == "" {
		freq = model.FreqBiweekly
	}
	if _, ok := model.PayPeriods[freq]; !ok {
		return apperr.Validation("payFrequency", "Choose how often you pay your employees.")
	}
	periodEnd := strings.TrimSpace(req.NextPeriodEnd)
	if periodEnd == "" {
		periodEnd = store.Today()
	}
	if !store.ValidDate(periodEnd) {
		return apperr.Validation("nextPeriodEnd", "Enter a valid pay period end date.")
	}
	checkDate := strings.TrimSpace(req.NextCheckDate)
	if checkDate == "" {
		checkDate = periodEnd
	}
	if !store.ValidDate(checkDate) {
		return apperr.Validation("nextCheckDate", "Enter a valid check date.")
	}
	ein := store.Digits(req.EIN)
	if ein != "" && len(ein) != 9 {
		return apperr.Validation("ein", "The federal employer identification number (EIN) must have 9 digits.")
	}
	if req.UIRate != nil && (*req.UIRate < 0 || *req.UIRate > 100) {
		return apperr.Validation("uiRate", "Enter the state unemployment rate as a percent (for example 3.4).")
	}

	// --- SerieX Books
	bs := books.Session{CompanyID: id, Token: sess.BooksToken, Assistant: sess.Assistant}
	ci, err := books.Default.CompanyInfo(ctx, bs)
	if err != nil {
		return books.ToAppErr(err)
	}
	banks, err := books.Default.Accounts(ctx, bs, books.AcctBank)
	if err != nil {
		return books.ToAppErr(err)
	}
	bank := req.DefaultBankAccountID
	if bank != nil && *bank != 0 {
		found := false
		for _, a := range banks {
			found = found || a.ID == *bank
		}
		if !found {
			return apperr.Validation("defaultBankAccountId", "Choose a SerieX Books bank account for paychecks.")
		}
	} else {
		bank = nil
		for _, a := range banks {
			if a.Active {
				v := a.ID
				bank = &v
				break
			}
		}
	}
	refs := items.DefaultRefs{}
	var created []string
	if req.CreateAccounts {
		c, err := ensureAccounts(ctx, bs, &refs)
		if err != nil {
			return err
		}
		created = append(created, c...)
	}
	if req.CreateAgencies {
		c, err := ensureAgencies(ctx, bs, &st, &refs)
		if err != nil {
			return err
		}
		created = append(created, c...)
	}
	posting.Invalidate(id)
	if ein == "" && len(store.Digits(ci.TaxID)) == 9 {
		ein = store.Digits(ci.TaxID)
	}
	name := strings.TrimSpace(ci.Name)
	if name == "" {
		name = id
	}

	// --- payroll company file
	err = mgr.Create(ctx, id, func(tx *sql.Tx) error {
		now := store.Now()
		prefs := model.DefaultPrefs()
		prefs.DefaultBankAccountID = bank
		if _, err := tx.ExecContext(ctx, `INSERT INTO company(id, books_company_id, name, legal_name, address1, address2, city, state, zip,
			phone, email, ein, primary_state, federal_deposit_schedule, first_payroll_year, prefs, setup_done, setup_state, created_at, updated_at)
			VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'{}',?,?)`,
			id, name, strings.TrimSpace(ci.LegalName), ci.Address1, ci.Address2, ci.City, ci.State, ci.Zip, ci.Phone, ci.Email,
			ein, state, dep, year, store.JSONText(prefs), now, now); err != nil {
			return err
		}
		uiRates := map[string]float64{}
		if req.UIRate != nil {
			uiRates[strconv.Itoa(year)] = *req.UIRate
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO state_settings(state, ui_rates, other_rates, created_at, updated_at) VALUES(?,?,'{}',?,?)`,
			state, store.JSONText(uiRates), now, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO pay_schedules(name, frequency, next_period_end, next_check_date, semi_first_day, active, created_at, updated_at)
			VALUES(?,?,?,?,15,1,?,?)`, model.FrequencyLabels[freq], freq, periodEnd, checkDate, now, now); err != nil {
			return err
		}
		if err := items.CreateDefaults(ctx, tx, state, year, refs); err != nil {
			return fmt.Errorf("default payroll items: %w", err)
		}
		if err := createPaymentSchedules(ctx, tx, dep, &refs); err != nil {
			return err
		}
		return store.Audit(ctx, tx, sess.User, "setup", "company", 0, "Payroll set up for "+name, map[string]any{
			"primaryState": state, "firstPayrollYear": year, "federalDepositSchedule": dep, "payFrequency": freq,
			"defaultBankAccountId": bank, "createdInBooks": created,
		})
	})
	if err != nil {
		if ae := apperr.As(err); ae != nil {
			return ae
		}
		if strings.Contains(err.Error(), "already exists") {
			return apperr.Conflict("Payroll is already set up for this company file.")
		}
		return err
	}
	db, err := mgr.Open(id)
	if err != nil {
		return err
	}
	pc, err := loadCompany(ctx, db)
	if err != nil {
		return err
	}
	return httpx.WriteJSON(w, http.StatusOK, pc)
}

// createPaymentSchedules adds the default payment schedule of every payment
// group used by the payroll items (and the federal and primary state groups).
func createPaymentSchedules(ctx context.Context, tx *sql.Tx, deposit string, refs *items.DefaultRefs) error {
	groups := map[string]bool{model.GroupFederal941: true, model.GroupFederal940: true}
	rows, err := tx.QueryContext(ctx, `SELECT type, tax_code, state, agency_vendor_id, payment_group FROM payroll_items WHERE active = 1`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var it model.PayrollItem
		var ag sql.NullInt64
		if err := rows.Scan(&it.Type, &it.TaxCode, &it.State, &ag, &it.PaymentGroup); err != nil {
			rows.Close()
			return err
		}
		it.AgencyVendorID = store.PtrID(ag)
		g := it.PaymentGroup
		if g == "" {
			g = model.DefaultPaymentGroup(&it)
		}
		if g != "" {
			groups[g] = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var keys []string
	for g := range groups {
		keys = append(keys, g)
	}
	sort.Strings(keys)
	now := store.Now()
	for _, g := range keys {
		freq, method := defaultSchedule(g, deposit)
		var vendor *int64
		switch {
		case g == model.GroupFederal941 || g == model.GroupFederal940:
			vendor = refs.IRSVendor
		case strings.HasPrefix(g, "state_wh:"):
			vendor = refs.StateWHVendor
		case strings.HasPrefix(g, "state_ui:"):
			vendor = refs.StateUIVendor
		case strings.HasPrefix(g, "vendor:"):
			if v, err := strconv.ParseInt(strings.TrimPrefix(g, "vendor:"), 10, 64); err == nil {
				vendor = &v
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO payment_schedules(payment_group, agency_vendor_id, frequency, method, updated_at)
			VALUES(?,?,?,?,?)`, g, store.NullID(vendor), freq, method, now); err != nil {
			return err
		}
	}
	return nil
}

// defaultSchedule is the default payment frequency and method of a payment group.
func defaultSchedule(group, deposit string) (freq, method string) {
	switch {
	case group == model.GroupFederal941:
		if deposit == model.PayFreqSemiweekly {
			return model.PayFreqSemiweekly, "e-pay"
		}
		return model.PayFreqMonthly, "e-pay"
	case group == model.GroupFederal940:
		return model.PayFreqQuarterly, "e-pay"
	case strings.HasPrefix(group, "state_wh:"):
		return model.PayFreqMonthly, "e-pay"
	case strings.HasPrefix(group, "state_ui:"):
		return model.PayFreqQuarterly, "e-pay"
	}
	return model.PayFreqAfterPayroll, "check"
}

// ---------------------------------------------------------------------------
// Find-or-create SerieX Books accounts and agency vendors

func booksSafeName(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, ":", " -"))
	if r := []rune(s); len(r) > 100 {
		s = strings.TrimSpace(string(r[:100]))
	}
	return s
}

// withArticle: "an Expense", "a Bank".
func withArticle(s string) string {
	if s != "" && strings.ContainsRune("AEIOUaeiou", rune(s[0])) {
		return "an " + s
	}
	return "a " + s
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// ensureAccounts finds (by full name, case-insensitive) or creates the payroll
// accounts in SerieX Books and fills refs. Returns the full names created.
func ensureAccounts(ctx context.Context, bs books.Session, refs *items.DefaultRefs) ([]string, error) {
	cl := books.Default
	all, err := cl.Accounts(ctx, bs)
	if err != nil {
		return nil, books.ToAppErr(err)
	}
	var created []string
	ensure := func(name string, parent *books.Account, allowed []string, createType string) (*books.Account, error) {
		full := name
		var parentID *int64
		if parent != nil {
			full = parent.FullName + ":" + name
			createType, allowed = parent.Type, []string{parent.Type}
			pid := parent.ID
			parentID = &pid
		}
		for i := range all {
			a := &all[i]
			if !strings.EqualFold(a.FullName, full) {
				continue
			}
			if !contains(allowed, a.Type) {
				return nil, apperr.Conflict("The SerieX Books account %q is %s account; payroll needs %s account with this name. Rename that account in SerieX Books and try again.", a.FullName, withArticle(a.Type), withArticle(createType))
			}
			if !a.Active {
				up, err := cl.SetAccountActive(ctx, bs, a.ID, true)
				if err != nil {
					return nil, books.ToAppErr(err)
				}
				*a = up
			}
			return a, nil
		}
		a, err := cl.CreateAccount(ctx, bs, books.Account{Name: name, Type: createType, ParentID: parentID, Active: true})
		if err != nil {
			return nil, books.ToAppErr(err)
		}
		all = append(all, a)
		created = append(created, a.FullName)
		return &all[len(all)-1], nil
	}
	exp, err := ensure("Payroll Expenses", nil, []string{books.AcctExpense, books.AcctOtherExpense}, books.AcctExpense)
	if err != nil {
		return nil, err
	}
	expParent := *exp
	liab, err := ensure("Payroll Liabilities", nil, []string{books.AcctOCL}, books.AcctOCL)
	if err != nil {
		return nil, err
	}
	liabParent := *liab
	subs := []struct {
		parent *books.Account
		name   string
		ref    **int64
	}{
		{&expParent, "Wages", &refs.WagesExpense},
		{&expParent, "Payroll Taxes", &refs.TaxesExpense},
		{&expParent, "Benefits", &refs.BenefitsExpense},
		{&expParent, "Reimbursements", &refs.ReimbExpense},
		{&liabParent, "Federal Taxes (941)", &refs.FederalLiab},
		{&liabParent, "Federal Unemployment (940)", &refs.FUTALiab},
		{&liabParent, "State Withholding", &refs.StateWHLiab},
		{&liabParent, "State Unemployment & Disability", &refs.StateUILiab},
		{&liabParent, "Local Taxes", &refs.LocalLiab},
		{&liabParent, "Retirement Plans", &refs.RetirementLiab},
		{&liabParent, "Health & Benefits", &refs.HealthLiab},
		{&liabParent, "Other Deductions", &refs.OtherLiab},
	}
	for _, s := range subs {
		a, err := ensure(s.name, s.parent, nil, "")
		if err != nil {
			return nil, err
		}
		id := a.ID
		*s.ref = &id
	}
	return created, nil
}

// ensureAgencies finds (by name, case-insensitive) or creates the tax agency
// vendors in SerieX Books and fills refs. Returns the names created.
func ensureAgencies(ctx context.Context, bs books.Session, st *model.StateTax, refs *items.DefaultRefs) ([]string, error) {
	cl := books.Default
	names, err := cl.Names(ctx, bs, "")
	if err != nil {
		return nil, books.ToAppErr(err)
	}
	var created []string
	vendor := func(name string) (*int64, error) {
		name = booksSafeName(name)
		if name == "" {
			return nil, nil
		}
		// a non-vendor already using the name: use "<name> (Agency)" instead
		for _, cand := range []string{name, booksSafeName(name + " (Agency)")} {
			var other bool
			for i := range names {
				n := &names[i]
				if n.ParentID != nil || !strings.EqualFold(n.Name, cand) {
					continue
				}
				if n.Kind != books.NameVendor {
					other = true
					break
				}
				if !n.Active {
					up, err := cl.SetNameActive(ctx, bs, n.ID, true)
					if err != nil {
						return nil, books.ToAppErr(err)
					}
					*n = up
				}
				id := n.ID
				return &id, nil
			}
			if other {
				continue
			}
			// the agency's real name (without " (Agency)") is printed on tax payments
			v, err := cl.CreateName(ctx, bs, books.Name{Kind: books.NameVendor, Name: cand, CompanyName: name, PrintOnCheckAs: name, Active: true})
			if err != nil {
				return nil, books.ToAppErr(err)
			}
			names = append(names, v)
			created = append(created, v.Name)
			id := v.ID
			return &id, nil
		}
		return nil, apperr.Conflict("The name %q is already used in SerieX Books by a customer or other name.", name)
	}
	var err2 error
	if refs.IRSVendor, err2 = vendor("United States Treasury"); err2 != nil {
		return nil, err2
	}
	if st.AgencyWithholding != "" && st.Income.Has {
		if refs.StateWHVendor, err2 = vendor(st.AgencyWithholding); err2 != nil {
			return nil, err2
		}
	}
	if st.AgencyUnemployment != "" {
		if refs.StateUIVendor, err2 = vendor(st.AgencyUnemployment); err2 != nil {
			return nil, err2
		}
	}
	return created, nil
}
