// Package company serves company information, preferences, closing date,
// users and login, audit trail, memorized transactions and reports, budgets,
// to dos, reminders and data rebuild/verify.
package company

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Register adds the company routes (and sets rt.Auth).
func Register(rt *httpx.Router) {
	registerAuth(rt)

	rt.C("GET", "/company", getCompany)
	rt.C("PUT", "/company", putCompany)
	rt.C("GET", "/prefs", getPrefs)
	rt.C("PUT", "/prefs", putPrefs)
	rt.C("GET", "/closing-date", getClosingDate)
	rt.C("PUT", "/closing-date", putClosingDate)

	registerUsers(rt)
	rt.C("GET", "/audit", listAudit)
	registerMemorized(rt)
	registerMemorizedReports(rt)
	registerBudgets(rt)
	registerTodos(rt)
	rt.C("GET", "/reminders", getReminders)
	rt.C("POST", "/verify", verifyData)
	rt.C("POST", "/rebuild", rebuildData)
}

// ---------------------------------------------------------------------------
// Company information

func loadCompanyInfo(ctx context.Context, q store.Q, companyID string) (model.CompanyInfo, error) {
	var ci model.CompanyInfo
	var hash string
	err := q.QueryRowContext(ctx, `SELECT name, legal_name, address1, address2, city, state, zip, country,
		phone, fax, email, website, tax_id, industry, entity_type, fiscal_year_start_month,
		tax_year_start_month, closing_date, closing_password_hash, created_at
		FROM company WHERE id = 1`).Scan(&ci.Name, &ci.LegalName, &ci.Address1, &ci.Address2, &ci.City,
		&ci.State, &ci.Zip, &ci.Country, &ci.Phone, &ci.Fax, &ci.Email, &ci.Website, &ci.TaxID,
		&ci.Industry, &ci.EntityType, &ci.FiscalYearStartMonth, &ci.TaxYearStartMonth, &ci.ClosingDate,
		&hash, &ci.CreatedAt)
	if err != nil {
		return ci, err
	}
	ci.HasClosingPassword = hash != ""
	ci.CompanyID = companyID
	return ci, nil
}

func getCompany(c *httpx.Ctx) error {
	ci, err := loadCompanyInfo(c.Context(), c.DB, c.CompanyID)
	if err != nil {
		return err
	}
	return c.JSON(ci)
}

func putCompany(c *httpx.Ctx) error {
	ctx := c.Context()
	var out model.CompanyInfo
	err := c.Write(func(tx *sql.Tx) error {
		if err := store.RequireAdmin(ctx, tx, c.User, "Only an administrator can change the company information."); err != nil {
			return err
		}
		ci, err := loadCompanyInfo(ctx, tx, c.CompanyID)
		if err != nil {
			return err
		}
		// Decode over the current values so omitted fields are kept.
		if err := c.Decode(&ci); err != nil {
			return err
		}
		if err := cleanCompanyInfo(&ci); err != nil {
			return err
		}
		if ci.FiscalYearStartMonth < 1 || ci.FiscalYearStartMonth > 12 {
			return apperr.Validation("fiscalYearStartMonth", "The first month of the fiscal year must be between 1 and 12.")
		}
		if ci.TaxYearStartMonth == 0 {
			ci.TaxYearStartMonth = 1
		}
		if ci.TaxYearStartMonth < 1 || ci.TaxYearStartMonth > 12 {
			return apperr.Validation("taxYearStartMonth", "The first month of the income tax year must be between 1 and 12.")
		}
		_, err = tx.ExecContext(ctx, `UPDATE company SET name = ?, legal_name = ?, address1 = ?, address2 = ?,
			city = ?, state = ?, zip = ?, country = ?, phone = ?, fax = ?, email = ?, website = ?, tax_id = ?,
			industry = ?, entity_type = ?, fiscal_year_start_month = ?, tax_year_start_month = ?, updated_at = ?
			WHERE id = 1`, ci.Name, strings.TrimSpace(ci.LegalName), ci.Address1, ci.Address2, ci.City, ci.State,
			ci.Zip, ci.Country, ci.Phone, ci.Fax, ci.Email, ci.Website, ci.TaxID, ci.Industry, ci.EntityType,
			ci.FiscalYearStartMonth, ci.TaxYearStartMonth, store.Now())
		if err != nil {
			return err
		}
		out, err = loadCompanyInfo(ctx, tx, c.CompanyID)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// Preferences

func getPrefs(c *httpx.Ctx) error {
	p, err := store.LoadPrefs(c.Context(), c.DB)
	if err != nil {
		return err
	}
	return c.JSON(p)
}

func putPrefs(c *httpx.Ctx) error {
	ctx := c.Context()
	var out store.Prefs
	err := c.Write(func(tx *sql.Tx) error {
		p, err := store.LoadPrefs(ctx, tx)
		if err != nil {
			return err
		}
		before := p
		// Decode over the current preferences so a partial body only changes what it sends.
		if err := c.Decode(&p); err != nil {
			return err
		}
		admin, err := isAdmin(ctx, tx, c.User)
		if err != nil {
			return err
		}
		if !admin && companyPrefsChanged(before, p) {
			return forbidden("Only an administrator can change company preferences. You can change your own preferences (workspace, checking defaults, automatic recall and fill-in).")
		}
		if err := validatePrefs(ctx, tx, &p); err != nil {
			return err
		}
		if err := store.SavePrefs(ctx, tx, p); err != nil {
			return err
		}
		out = p
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// companyPrefsChanged reports whether anything but the personal preferences
// (the per-user "My Preferences") differs between a and b.
func companyPrefsChanged(a, b store.Prefs) bool {
	personal := func(p *store.Prefs, from store.Prefs) {
		p.WindowMode, p.IconBar, p.AutoRecall, p.AutoFillPayee = from.WindowMode, from.IconBar, from.AutoRecall, from.AutoFillPayee
		p.ShowHomePageOnOpen, p.ShowRemindersOnOpen = from.ShowHomePageOnOpen, from.ShowRemindersOnOpen
		p.DefaultCheckAccountID, p.DefaultBillPayAccountID, p.DefaultDepositAccountID = from.DefaultCheckAccountID, from.DefaultBillPayAccountID, from.DefaultDepositAccountID
	}
	x := b
	personal(&x, a) // b with a's personal values: equal to a when only personal values changed
	ja, _ := json.Marshal(a)
	jx, _ := json.Marshal(x)
	return string(ja) != string(jx)
}

// cleanCompanyInfo trims and checks the company information fields.
func cleanCompanyInfo(ci *model.CompanyInfo) error {
	for _, f := range []struct {
		v     *string
		field string
		label string
		max   int
	}{
		{&ci.Name, "name", "The company name", 100}, {&ci.LegalName, "legalName", "The legal name", 100},
		{&ci.Address1, "address1", "The address", 100}, {&ci.Address2, "address2", "The address", 100},
		{&ci.City, "city", "The city", 100}, {&ci.State, "state", "The state", 40}, {&ci.Zip, "zip", "The ZIP code", 20},
		{&ci.Country, "country", "The country", 60}, {&ci.Phone, "phone", "The phone number", 40}, {&ci.Fax, "fax", "The fax number", 40},
		{&ci.Email, "email", "The email address", 200}, {&ci.Website, "website", "The web site", 200},
		{&ci.TaxID, "taxId", "The tax ID", 40}, {&ci.Industry, "industry", "The industry", 60}, {&ci.EntityType, "entityType", "The type of business", 60},
	} {
		v, err := store.CleanText(*f.v, f.field, f.label, f.max)
		if err != nil {
			return err
		}
		*f.v = v
	}
	if ci.Name == "" {
		return apperr.Validation("name", "Company name is required.")
	}
	return nil
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func validatePrefs(ctx context.Context, q store.Q, p *store.Prefs) error {
	enums := []struct {
		field   string
		value   *string
		def     string
		allowed []string
	}{
		{"windowMode", &p.WindowMode, "multiple", []string{"multiple", "one"}},
		{"iconBar", &p.IconBar, "left", []string{"left", "top", "hidden"}},
		{"reportBasis", &p.ReportBasis, "accrual", []string{"accrual", "cash"}},
		{"agingFrom", &p.AgingFrom, "due", []string{"due", "transaction"}},
		{"reportAccountDisplay", &p.ReportAccountDisplay, "name", []string{"name", "description", "both"}},
		{"defaultInvoiceTemplate", &p.DefaultInvoiceTemplate, "Product Invoice", []string{"Product Invoice", "Service Invoice", "Professional Invoice"}},
		{"salesTaxBasis", &p.SalesTaxBasis, "accrual", []string{"accrual", "cash"}},
		{"salesTaxFrequency", &p.SalesTaxFrequency, "monthly", []string{"monthly", "quarterly", "annually"}},
	}
	for _, e := range enums {
		if *e.value == "" {
			*e.value = e.def
		}
		if !oneOf(*e.value, e.allowed...) {
			return apperr.Validation(e.field, "Invalid value %q for %s (allowed: %s).", *e.value, e.field, strings.Join(e.allowed, ", "))
		}
	}
	ints := []struct {
		field string
		value int
		max   int
	}{
		{"datePastWarnDays", p.DatePastWarnDays, 99999},
		{"dateFutureWarnDays", p.DateFutureWarnDays, 99999},
		{"billsDueDays", p.BillsDueDays, 999},
	}
	for _, e := range ints {
		if e.value < 0 || e.value > e.max {
			return apperr.Validation(e.field, "%s must be between 0 and %d.", e.field, e.max)
		}
	}
	if p.DefaultMarkupPercent < 0 {
		return apperr.Validation("defaultMarkupPercent", "The default markup percentage cannot be negative.")
	}
	// Optional references: zero means none; otherwise the record must exist with a suitable type.
	accts := []struct {
		field string
		id    **int64
		types []string
	}{
		{"vendorDiscountAccountId", &p.VendorDiscountAccountID, nil},
		{"customerDiscountAccountId", &p.CustomerDiscountAccountID, nil},
		{"defaultCheckAccountId", &p.DefaultCheckAccountID, []string{model.AcctBank}},
		{"defaultBillPayAccountId", &p.DefaultBillPayAccountID, []string{model.AcctBank, model.AcctCreditCard}},
		{"defaultDepositAccountId", &p.DefaultDepositAccountID, []string{model.AcctBank, model.AcctOCA}},
	}
	for _, a := range accts {
		if *a.id != nil && **a.id == 0 {
			*a.id = nil
		}
		if *a.id == nil {
			continue
		}
		var typ string
		err := q.QueryRowContext(ctx, `SELECT type FROM accounts WHERE id = ?`, **a.id).Scan(&typ)
		if err == sql.ErrNoRows {
			return apperr.Validation(a.field, "The selected account does not exist.")
		}
		if err != nil {
			return err
		}
		if a.types != nil && !oneOf(typ, a.types...) {
			return apperr.Validation(a.field, "The selected account must be of type %s.", strings.Join(a.types, " or "))
		}
	}
	if p.DefaultShipViaID != nil && *p.DefaultShipViaID == 0 {
		p.DefaultShipViaID = nil
	}
	if p.DefaultShipViaID != nil {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM list_entries WHERE id = ? AND list = ?`, *p.DefaultShipViaID, model.ListShipVia).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return apperr.Validation("defaultShipViaId", "The selected shipping method does not exist.")
		}
	}
	if p.DefaultSalesTaxItemID != nil && *p.DefaultSalesTaxItemID == 0 {
		p.DefaultSalesTaxItemID = nil
	}
	if p.DefaultSalesTaxItemID != nil {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM items WHERE id = ? AND type IN (?, ?)`, *p.DefaultSalesTaxItemID, model.ItemSalesTax, model.ItemSalesTaxGroup).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return apperr.Validation("defaultSalesTaxItemId", "The most common sales tax must be a sales tax item or sales tax group.")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Closing date

func getClosingDate(c *httpx.Ctx) error {
	var cd, hash string
	if err := c.DB.QueryRowContext(c.Context(), `SELECT closing_date, closing_password_hash FROM company WHERE id = 1`).Scan(&cd, &hash); err != nil {
		return err
	}
	return c.JSON(map[string]any{"closingDate": cd, "hasPassword": hash != ""})
}

func putClosingDate(c *httpx.Ctx) error {
	var body struct {
		ClosingDate   string `json:"closingDate"`
		Password      string `json:"password"`
		ClearPassword bool   `json:"clearPassword"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	body.ClosingDate = strings.TrimSpace(body.ClosingDate)
	if body.ClosingDate != "" && !store.ValidDate(body.ClosingDate) {
		return apperr.Validation("closingDate", "Please enter a valid closing date.")
	}
	ctx := c.Context()
	var result map[string]any
	err := c.Write(func(tx *sql.Tx) error {
		admin, err := isAdmin(ctx, tx, c.User)
		if err != nil {
			return err
		}
		if !admin {
			return forbidden("Only an administrator can set the closing date.")
		}
		var oldDate, oldHash string
		if err := tx.QueryRowContext(ctx, `SELECT closing_date, closing_password_hash FROM company WHERE id = 1`).Scan(&oldDate, &oldHash); err != nil {
			return err
		}
		hash := oldHash
		pwChanged := false
		if body.ClearPassword {
			pwChanged = oldHash != ""
			hash = ""
		} else if body.Password != "" {
			hash = store.HashPassword(body.Password)
			pwChanged = true
		}
		if _, err := tx.ExecContext(ctx, `UPDATE company SET closing_date = ?, closing_password_hash = ?, updated_at = ? WHERE id = 1`,
			body.ClosingDate, hash, store.Now()); err != nil {
			return err
		}
		if err := store.Audit(ctx, tx, store.AuditEntry{
			User:    c.User,
			Action:  "closing_date",
			TxnDate: body.ClosingDate,
			Details: map[string]any{
				"before":          oldDate,
				"after":           body.ClosingDate,
				"passwordChanged": pwChanged,
				"hasPassword":     hash != "",
			},
		}); err != nil {
			return err
		}
		result = map[string]any{"closingDate": body.ClosingDate, "hasPassword": hash != ""}
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(result)
}
