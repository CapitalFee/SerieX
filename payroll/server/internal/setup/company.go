package setup

import (
	"context"
	"database/sql"
	"encoding/json"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

func registerCompany(rt *httpx.Router) {
	rt.C("GET", "/company", func(c *httpx.Ctx) error {
		pc, err := loadCompany(c.Context(), c.DB)
		if err != nil {
			return err
		}
		return c.JSON(pc)
	})
	rt.C("PUT", "/company", putCompany)
	rt.C("POST", "/company/refresh", refreshCompany)
	rt.C("GET", "/prefs", func(c *httpx.Ctx) error {
		p, err := store.LoadPrefs(c.Context(), c.DB)
		if err != nil {
			return err
		}
		return c.JSON(p)
	})
	rt.C("PUT", "/prefs", putPrefs)
	rt.C("GET", "/state-settings", listStateSettings)
	rt.C("PUT", "/state-settings/{state}", putStateSettings)
	rt.C("GET", "/access", getAccess)
	rt.C("PUT", "/access", putAccess)
	rt.C("GET", "/audit", listAudit)
}

// readBody reads the raw JSON body and the set of top-level keys it contains.
func readBody(c *httpx.Ctx) ([]byte, map[string]json.RawMessage, error) {
	b, err := httpx.ReadJSONBody(c.R, 4<<20)
	if err != nil {
		return nil, nil, err
	}
	keys := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &keys); err != nil {
		return nil, nil, httpx.BodyError(err)
	}
	return b, keys, nil
}

// ---------------------------------------------------------------------------
// Company

func loadCompany(ctx context.Context, q store.Q) (*model.PayrollCompany, error) {
	var pc model.PayrollCompany
	var setupState string
	err := q.QueryRowContext(ctx, `SELECT books_company_id, name, legal_name, trade_name, address1, address2, city, state, zip,
		phone, email, ein, contact_name, contact_title, contact_phone, primary_state, federal_deposit_schedule, first_payroll_year,
		setup_done, setup_state FROM company WHERE id = 1`).Scan(&pc.BooksCompanyID, &pc.Name, &pc.LegalName, &pc.TradeName,
		&pc.Address.Line1, &pc.Address.Line2, &pc.Address.City, &pc.Address.State, &pc.Address.Zip, &pc.Phone, &pc.Email, &pc.EIN,
		&pc.ContactName, &pc.ContactTitle, &pc.ContactPhone, &pc.PrimaryState, &pc.FederalDepositSchedule, &pc.FirstPayrollYear,
		&pc.SetupDone, &setupState)
	if err != nil {
		return nil, err
	}
	pc.EIN = store.FormatEIN(pc.EIN)
	pc.SetupState = map[string]any{}
	if setupState != "" {
		json.Unmarshal([]byte(setupState), &pc.SetupState)
		if pc.SetupState == nil {
			pc.SetupState = map[string]any{}
		}
	}
	pc.BooksURL = books.Default.BaseURL
	return &pc, nil
}

func putCompany(c *httpx.Ctx) error {
	if err := requireAdmin(c, "change the payroll company information"); err != nil {
		return err
	}
	body, keys, err := readBody(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out *model.PayrollCompany
	err = c.Write(func(tx *sql.Tx) error {
		cur, err := loadCompany(ctx, tx)
		if err != nil {
			return err
		}
		before := *cur
		in := *cur
		if _, ok := keys["setupState"]; ok {
			in.SetupState = nil
		}
		if err := json.Unmarshal(body, &in); err != nil {
			return httpx.BodyError(err)
		}
		in.Name = strings.TrimSpace(in.Name)
		if in.Name == "" {
			return apperr.Validation("name", "Enter the company name.")
		}
		ein := store.Digits(in.EIN)
		if ein != "" && len(ein) != 9 {
			return apperr.Validation("ein", "The federal employer identification number (EIN) must have 9 digits.")
		}
		in.PrimaryState = strings.ToUpper(strings.TrimSpace(in.PrimaryState))
		if in.PrimaryState != "" && stateName(in.PrimaryState) == "" {
			return apperr.Validation("primaryState", "%q is not a US state.", in.PrimaryState)
		}
		if in.FederalDepositSchedule != model.PayFreqMonthly && in.FederalDepositSchedule != model.PayFreqSemiweekly {
			return apperr.Validation("federalDepositSchedule", "The federal deposit schedule must be monthly or semiweekly.")
		}
		if in.FirstPayrollYear != 0 && (in.FirstPayrollYear < 2000 || in.FirstPayrollYear > 2100) {
			return apperr.Validation("firstPayrollYear", "Enter a valid year.")
		}
		if in.SetupState == nil {
			in.SetupState = map[string]any{}
		}
		now := store.Now()
		if _, err := tx.ExecContext(ctx, `UPDATE company SET name = ?, legal_name = ?, trade_name = ?, address1 = ?, address2 = ?,
			city = ?, state = ?, zip = ?, phone = ?, email = ?, ein = ?, contact_name = ?, contact_title = ?, contact_phone = ?,
			primary_state = ?, federal_deposit_schedule = ?, first_payroll_year = ?, setup_done = ?, setup_state = ?, updated_at = ?
			WHERE id = 1`, in.Name, strings.TrimSpace(in.LegalName), strings.TrimSpace(in.TradeName),
			strings.TrimSpace(in.Address.Line1), strings.TrimSpace(in.Address.Line2), strings.TrimSpace(in.Address.City),
			strings.ToUpper(strings.TrimSpace(in.Address.State)), strings.TrimSpace(in.Address.Zip), strings.TrimSpace(in.Phone),
			strings.TrimSpace(in.Email), ein, strings.TrimSpace(in.ContactName), strings.TrimSpace(in.ContactTitle),
			strings.TrimSpace(in.ContactPhone), in.PrimaryState, in.FederalDepositSchedule, in.FirstPayrollYear,
			store.B(in.SetupDone), store.JSONText(in.SetupState), now); err != nil {
			return err
		}
		// the 941 payment schedule follows the deposit schedule when it still has the old default
		if in.FederalDepositSchedule != before.FederalDepositSchedule {
			if _, err := tx.ExecContext(ctx, `UPDATE payment_schedules SET frequency = ?, updated_at = ?
				WHERE payment_group = ? AND frequency = ?`, in.FederalDepositSchedule, now, model.GroupFederal941,
				before.FederalDepositSchedule); err != nil {
				return err
			}
		}
		if in.PrimaryState != "" && in.PrimaryState != before.PrimaryState {
			if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO state_settings(state, ui_rates, other_rates, created_at, updated_at)
				VALUES(?,'{}','{}',?,?)`, in.PrimaryState, now, now); err != nil {
				return err
			}
		}
		if out, err = loadCompany(ctx, tx); err != nil {
			return err
		}
		finished := out.SetupDone && !before.SetupDone
		summary := "Company information changed"
		if finished {
			summary = "Payroll setup finished"
		}
		after := *out
		before.SetupState, after.SetupState = nil, nil
		// the Payroll Setup wizard saves its progress (setupState) on every page: that alone is
		// not a change of the company information, so it is not written to the audit trail
		if !finished && reflect.DeepEqual(before, after) {
			return nil
		}
		return store.Audit(ctx, tx, c.User, "modify", "company", 0, summary, map[string]any{"before": before, "after": after})
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// POST /company/refresh: copy the company name, address and contact details from SerieX Books.
func refreshCompany(c *httpx.Ctx) error {
	if err := requireAdmin(c, "change the payroll company information"); err != nil {
		return err
	}
	ctx := c.Context()
	ci, err := books.Default.CompanyInfo(ctx, books.S(c))
	if err != nil {
		return books.ToAppErr(err)
	}
	var out *model.PayrollCompany
	err = c.Write(func(tx *sql.Tx) error {
		before, err := loadCompany(ctx, tx)
		if err != nil {
			return err
		}
		// a field left blank in SerieX Books keeps the payroll value
		keep := func(fromBooks, cur string) string {
			if v := strings.TrimSpace(fromBooks); v != "" {
				return v
			}
			return cur
		}
		name := keep(ci.Name, before.Name)
		legal := keep(ci.LegalName, before.LegalName)
		phone := keep(ci.Phone, before.Phone)
		email := keep(ci.Email, before.Email)
		addr := model.Address{
			Line1: keep(ci.Address1, before.Address.Line1),
			Line2: keep(ci.Address2, before.Address.Line2),
			City:  keep(ci.City, before.Address.City),
			State: strings.ToUpper(keep(ci.State, before.Address.State)),
			Zip:   keep(ci.Zip, before.Address.Zip),
		}
		if strings.TrimSpace(ci.Address1) != "" {
			// a street address from Books comes with its own second line (none when blank)
			addr.Line2 = strings.TrimSpace(ci.Address2)
		}
		ein := store.Digits(before.EIN)
		if d := store.Digits(ci.TaxID); len(d) == 9 {
			ein = d
		}
		if _, err := tx.ExecContext(ctx, `UPDATE company SET name = ?, legal_name = ?, address1 = ?, address2 = ?, city = ?, state = ?,
			zip = ?, phone = ?, email = ?, ein = ?, updated_at = ? WHERE id = 1`, name, legal, addr.Line1,
			addr.Line2, addr.City, addr.State, addr.Zip, phone, email, ein, store.Now()); err != nil {
			return err
		}
		if out, err = loadCompany(ctx, tx); err != nil {
			return err
		}
		b, a := *before, *out
		b.SetupState, a.SetupState = nil, nil
		return store.Audit(ctx, tx, c.User, "modify", "company", 0, "Company information refreshed from SerieX Books",
			map[string]any{"before": b, "after": a})
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// Preferences

func putPrefs(c *httpx.Ctx) error {
	if err := requireAdmin(c, "change the payroll preferences"); err != nil {
		return err
	}
	body, _, err := readBody(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	cur, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return err
	}
	in := cur
	if cur.DefaultBankAccountID != nil { // decode into a copy: cur must keep the stored value
		v := *cur.DefaultBankAccountID
		in.DefaultBankAccountID = &v
	}
	if err := json.Unmarshal(body, &in); err != nil {
		return httpx.BodyError(err)
	}
	switch in.DisplayNameOrder {
	case "first", "last":
	default:
		return apperr.Validation("displayNameOrder", "Choose how employee names are displayed (first or last name first).")
	}
	switch in.ClassTracking {
	case "none", "paycheck", "earnings":
	case "":
		in.ClassTracking = "none"
	default:
		return apperr.Validation("classTracking", "Class tracking must be none, paycheck or earnings.")
	}
	if in.DueSoonDays < 0 || in.DueSoonDays > 90 {
		return apperr.Validation("dueSoonDays", "Enter a number of days between 0 and 90.")
	}
	if in.DefaultBankAccountID != nil && *in.DefaultBankAccountID == 0 {
		in.DefaultBankAccountID = nil
	}
	if in.DefaultBankAccountID != nil && !idEqual(in.DefaultBankAccountID, cur.DefaultBankAccountID) {
		// validated when SerieX Books can be reached
		accts, err := books.Default.Accounts(ctx, books.S(c), books.AcctBank)
		if err == nil {
			found := false
			for _, a := range accts {
				found = found || a.ID == *in.DefaultBankAccountID
			}
			if !found {
				return apperr.Validation("defaultBankAccountId", "Choose a SerieX Books bank account.")
			}
		} else if !books.IsUnavailable(err) {
			return books.ToAppErr(err)
		}
	}
	err = c.Write(func(tx *sql.Tx) error {
		if err := store.SavePrefs(ctx, tx, in); err != nil {
			return err
		}
		if in.PostToBooks && !cur.PostToBooks {
			// posting turned back on: records skipped meanwhile wait in the SerieX Books sync list
			for _, q := range []string{
				`UPDATE paychecks SET sync_status = 'pending', sync_error = '' WHERE sync_status = 'none' AND kind = 'regular' AND (voided = 0 OR books_txn_id IS NOT NULL)`,
				`UPDATE liability_payments SET sync_status = 'pending', sync_error = '' WHERE sync_status = 'none' AND kind = 'payment' AND (voided = 0 OR books_txn_id IS NOT NULL)`,
				`UPDATE liability_adjustments SET sync_status = 'pending', sync_error = '' WHERE sync_status = 'none' AND affects_accounts = 1`,
			} {
				if _, err := tx.ExecContext(ctx, q); err != nil {
					return err
				}
			}
		}
		return store.Audit(ctx, tx, c.User, "modify", "prefs", 0, "Payroll preferences changed", map[string]any{"before": cur, "after": in})
	})
	if err != nil {
		return err
	}
	return c.JSON(in)
}

func idEqual(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// ---------------------------------------------------------------------------
// State settings

func listStateSettings(c *httpx.Ctx) error {
	rows, err := c.DB.QueryContext(c.Context(), `SELECT state, withholding_id, ui_id, ui_rates, other_rates FROM state_settings ORDER BY state`)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []model.StateSettings{}
	for rows.Next() {
		s, err := scanStateSettings(rows)
		if err != nil {
			return err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(out)
}

type scanner interface{ Scan(dest ...any) error }

func scanStateSettings(r scanner) (*model.StateSettings, error) {
	var s model.StateSettings
	var ui, other string
	if err := r.Scan(&s.State, &s.WithholdingID, &s.UIID, &ui, &other); err != nil {
		return nil, err
	}
	s.UIRates = map[string]float64{}
	s.OtherRates = map[string]map[string]float64{}
	json.Unmarshal([]byte(ui), &s.UIRates)
	json.Unmarshal([]byte(other), &s.OtherRates)
	if s.UIRates == nil {
		s.UIRates = map[string]float64{}
	}
	if s.OtherRates == nil {
		s.OtherRates = map[string]map[string]float64{}
	}
	s.StateName = stateName(s.State)
	return &s, nil
}

func validRate(r float64) bool { return r >= 0 && r <= 100 }

func validYearKey(k string) bool {
	y, err := strconv.Atoi(k)
	return err == nil && len(k) == 4 && y >= 2000 && y <= 2100
}

func putStateSettings(c *httpx.Ctx) error {
	state := strings.ToUpper(strings.TrimSpace(c.R.PathValue("state")))
	if stateName(state) == "" {
		return apperr.NotFound("%q is not a US state.", c.R.PathValue("state"))
	}
	// partial body: only the keys sent change (uiRates / otherRates are replaced as a whole when sent)
	body, keys, err := readBody(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out *model.StateSettings
	err = c.Write(func(tx *sql.Tx) error {
		now := store.Now()
		before, err := scanStateSettings(tx.QueryRowContext(ctx, `SELECT state, withholding_id, ui_id, ui_rates, other_rates FROM state_settings WHERE state = ?`, state))
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		in := model.StateSettings{UIRates: map[string]float64{}, OtherRates: map[string]map[string]float64{}}
		if before != nil {
			in = *before
		}
		if _, ok := keys["uiRates"]; ok {
			in.UIRates = nil
		}
		if _, ok := keys["otherRates"]; ok {
			in.OtherRates = nil
		}
		if err := json.Unmarshal(body, &in); err != nil {
			return httpx.BodyError(err)
		}
		for k, v := range in.UIRates {
			if !validYearKey(k) {
				return apperr.Validation("uiRates", "%q is not a valid year.", k)
			}
			if !validRate(v) {
				return apperr.Validation("uiRates", "Enter the %s unemployment rate as a percent between 0 and 100.", k)
			}
		}
		for k, progs := range in.OtherRates {
			if !validYearKey(k) {
				return apperr.Validation("otherRates", "%q is not a valid year.", k)
			}
			for p, v := range progs {
				if strings.TrimSpace(p) == "" {
					return apperr.Validation("otherRates", "A state tax rate has no program.")
				}
				if !validRate(v) {
					return apperr.Validation("otherRates", "Enter the %s %s rate as a percent between 0 and 100.", k, p)
				}
			}
		}
		if in.UIRates == nil {
			in.UIRates = map[string]float64{}
		}
		if in.OtherRates == nil {
			in.OtherRates = map[string]map[string]float64{}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO state_settings(state, withholding_id, ui_id, ui_rates, other_rates, created_at, updated_at)
			VALUES(?,?,?,?,?,?,?) ON CONFLICT(state) DO UPDATE SET withholding_id = excluded.withholding_id, ui_id = excluded.ui_id,
			ui_rates = excluded.ui_rates, other_rates = excluded.other_rates, updated_at = excluded.updated_at`,
			state, strings.TrimSpace(in.WithholdingID), strings.TrimSpace(in.UIID), store.JSONText(in.UIRates),
			store.JSONText(in.OtherRates), now, now); err != nil {
			return err
		}
		if out, err = scanStateSettings(tx.QueryRowContext(ctx, `SELECT state, withholding_id, ui_id, ui_rates, other_rates FROM state_settings WHERE state = ?`, state)); err != nil {
			return err
		}
		return store.Audit(ctx, tx, c.User, "modify", "state_settings", 0, stateName(state)+" settings changed",
			map[string]any{"before": before, "after": out})
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// User access

type booksUser struct {
	Name    string `json:"name"`
	IsAdmin bool   `json:"isAdmin"`
}

type accessInfo struct {
	Users      []string    `json:"users"`
	BooksUsers []booksUser `json:"booksUsers"`
}

func loadAccess(c *httpx.Ctx) (*accessInfo, []books.User, error) {
	ctx := c.Context()
	out := &accessInfo{Users: []string{}, BooksUsers: []booksUser{}}
	rows, err := c.DB.QueryContext(ctx, `SELECT user FROM access ORDER BY user`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, nil, err
		}
		out.Users = append(out.Users, u)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	users, err := books.Default.Users(ctx, books.S(c))
	if err != nil {
		if books.IsUnavailable(err) {
			return out, nil, nil
		}
		return nil, nil, books.ToAppErr(err)
	}
	for _, u := range users {
		if u.Active {
			out.BooksUsers = append(out.BooksUsers, booksUser{Name: u.Name, IsAdmin: u.IsAdmin})
		}
	}
	return out, users, nil
}

func getAccess(c *httpx.Ctx) error {
	out, _, err := loadAccess(c)
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func putAccess(c *httpx.Ctx) error {
	if err := requireAdmin(c, "choose who can use payroll"); err != nil {
		return err
	}
	var in struct {
		Users []string `json:"users"`
	}
	if err := c.Decode(&in); err != nil {
		return err
	}
	ctx := c.Context()
	users, err := books.Default.Users(ctx, books.S(c))
	if err != nil && !books.IsUnavailable(err) {
		return books.ToAppErr(err)
	}
	known := map[string]string{}
	for _, u := range users {
		known[strings.ToLower(u.Name)] = u.Name
	}
	keep := map[string]bool{}
	list := []string{}
	for _, u := range in.Users {
		u = strings.TrimSpace(u)
		if u == "" || keep[strings.ToLower(u)] {
			continue
		}
		if users != nil {
			name, ok := known[strings.ToLower(u)]
			if !ok {
				return apperr.Validation("users", "%s is not a SerieX Books user.", u)
			}
			u = name
		}
		keep[strings.ToLower(u)] = true
		list = append(list, u)
	}
	sort.Strings(list)
	err = c.Write(func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `DELETE FROM access`); err != nil {
			return err
		}
		now := store.Now()
		for _, u := range list {
			if _, err := tx.ExecContext(ctx, `INSERT INTO access(user, created_at) VALUES(?,?)`, u, now); err != nil {
				return err
			}
		}
		return store.Audit(ctx, tx, c.User, "modify", "access", 0, "Payroll user access changed", map[string]any{"users": list})
	})
	if err != nil {
		return err
	}
	for _, s := range dropUsersWithout(c.CompanyID, keep) {
		if s.booksToken != "" {
			books.Default.Logout(ctx, books.Session{CompanyID: s.companyID, Token: s.booksToken})
		}
	}
	out, _, err := loadAccess(c)
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// Audit trail

func listAudit(c *httpx.Ctx) error {
	from, to := c.Q("from"), c.Q("to")
	if from != "" && !store.ValidDate(from) {
		return apperr.Validation("from", "Please enter a valid From date.")
	}
	if to != "" && !store.ValidDate(to) {
		return apperr.Validation("to", "Please enter a valid To date.")
	}
	// audit timestamps are UTC (store.Now); the From/To dates are local calendar days
	utcStart := func(date string) string {
		t, _ := time.ParseInLocation("2006-01-02", date, time.Local)
		return t.UTC().Format(time.RFC3339)
	}
	where := []string{"1 = 1"}
	var args []any
	if from != "" {
		where = append(where, "ts >= ?")
		args = append(args, utcStart(from))
	}
	if to != "" {
		where = append(where, "ts < ?")
		args = append(args, utcStart(store.AddDays(to, 1)))
	}
	if e := strings.TrimSpace(c.Q("entity")); e != "" {
		where = append(where, "entity = ?")
		args = append(args, e)
	}
	if u := strings.TrimSpace(c.Q("user")); u != "" {
		where = append(where, "user = ? COLLATE NOCASE")
		args = append(args, u)
	}
	rows, err := c.DB.QueryContext(c.Context(), `SELECT id, ts, user, action, entity, entity_id, summary, details FROM audit_log
		WHERE `+strings.Join(where, " AND ")+` ORDER BY ts DESC, id DESC LIMIT 2000`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []model.AuditRow{}
	for rows.Next() {
		var a model.AuditRow
		var eid sql.NullInt64
		var details string
		if err := rows.Scan(&a.ID, &a.Ts, &a.User, &a.Action, &a.Entity, &eid, &a.Summary, &details); err != nil {
			return err
		}
		a.EntityID = store.PtrID(eid)
		a.Details = map[string]any{}
		if details != "" && json.Unmarshal([]byte(details), &a.Details) != nil {
			a.Details = map[string]any{"text": details}
		}
		if a.Details == nil {
			a.Details = map[string]any{}
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(out)
}
