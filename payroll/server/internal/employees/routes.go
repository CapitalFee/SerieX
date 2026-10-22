package employees

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

func registerEmployeeRoutes(rt *httpx.Router) {
	rt.C("GET", "/employees", listEmployees)
	rt.C("POST", "/employees", func(c *httpx.Ctx) error { return saveRoute(c, 0) })
	rt.C("GET", "/employees/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		e, err := loadMasked(c, id)
		if err != nil {
			return err
		}
		return c.JSON(e)
	})
	rt.C("PUT", "/employees/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return saveRoute(c, id)
	})
	rt.C("DELETE", "/employees/{id}", deleteRoute)
	rt.C("PUT", "/employees/{id}/active", activeRoute)
	rt.C("GET", "/employees/{id}/ssn", ssnRoute)
	rt.C("GET", "/employees/{id}/summary", summaryRoute)
	rt.C("POST", "/employees/{id}/books-sync", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := mustExist(c.Context(), c.DB, id); err != nil {
			return err
		}
		syncErr := syncBooks(c, id)
		if ae := apperr.As(syncErr); ae != nil && (ae.Code == apperr.CodeBooksAuth || ae.Code == apperr.CodeAuth) {
			return syncErr // the client signs in to SerieX Books again and retries
		}
		return respond(c, id, syncErr)
	})
}

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

func listEmployees(c *httpx.Ctx) error {
	mode, err := activeMode(c.Q("active"))
	if err != nil {
		return err
	}
	all, err := loadEmployees(c.Context(), c.DB, 0, false, store.Today())
	if err != nil {
		return err
	}
	q := strings.ToLower(strings.TrimSpace(c.Q("q")))
	out := []*model.Employee{}
	for _, e := range all {
		if !keepActive(mode, e.Active) {
			continue
		}
		if q != "" && !matches(e, q) {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return strings.ToLower(out[i].DisplayName) < strings.ToLower(out[j].DisplayName)
	})
	return c.JSON(out)
}

func matches(e *model.Employee, q string) bool {
	for _, s := range []string{e.DisplayName, e.FirstName, e.LastName, e.EmployeeNumber, e.Email, e.Phone, e.Mobile, e.Address.City} {
		if strings.Contains(strings.ToLower(s), q) {
			return true
		}
	}
	return false
}

func loadMasked(c *httpx.Ctx, id int64) (*model.Employee, error) {
	e, err := Load(c.Context(), c.DB, id, false)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Employee not found.")
	}
	return e, err
}

// syncBooks creates/updates the employee's SerieX Books name (outside any transaction).
func syncBooks(c *httpx.Ctx, id int64) error {
	_, err := posting.EnsureEmployeeName(c, id)
	return err
}

// respond writes the saved employee (masked) with the Books sync problem, if any.
func respond(c *httpx.Ctx, id int64, syncErr error) error {
	e, err := loadMasked(c, id)
	if err != nil {
		return err
	}
	if syncErr != nil {
		e.BooksSyncError = posting.ProblemMessage(syncErr)
	}
	return c.JSON(e)
}

// decodeEmployee reads the body and tells whether "active" was sent and which
// top-level fields were sent.
func decodeEmployee(c *httpx.Ctx) (*model.Employee, *bool, map[string]bool, error) {
	body, err := httpx.ReadJSONBody(c.R, 4<<20)
	if err != nil {
		return nil, nil, nil, err
	}
	var e model.Employee
	if err := json.Unmarshal(body, &e); err != nil {
		return nil, nil, nil, httpx.BodyError(err)
	}
	var a struct {
		Active *bool `json:"active"`
	}
	json.Unmarshal(body, &a)
	var keys map[string]json.RawMessage
	json.Unmarshal(body, &keys)
	sent := map[string]bool{}
	for k, v := range keys {
		sent[k] = string(v) != "null"
	}
	return &e, a.Active, sent, nil
}

// subjectDefaults fills the "subject to" flags a new employee was sent
// without: social security, Medicare and federal unemployment are checked
// (as in the New Employee window), SUI and SDI follow the employee defaults.
func subjectDefaults(ctx context.Context, tx *sql.Tx, e *model.Employee, sent map[string]bool) error {
	if !sent["subjectSs"] {
		e.SubjectSS = true
	}
	if !sent["subjectMedicare"] {
		e.SubjectMedicare = true
	}
	if !sent["subjectFuta"] {
		e.SubjectFUTA = true
	}
	if sent["subjectSui"] && sent["subjectSdi"] {
		return nil
	}
	d, err := LoadDefaults(ctx, tx)
	if err != nil {
		return err
	}
	if !sent["subjectSui"] {
		e.SubjectSUI = d.SubjectSUI
	}
	if !sent["subjectSdi"] {
		e.SubjectSDI = d.SubjectSDI
	}
	return nil
}

func saveRoute(c *httpx.Ctx, id int64) error {
	in, act, sent, err := decodeEmployee(c)
	if err != nil {
		return err
	}
	ctx := c.Context()
	saved := id
	err = c.Write(func(tx *sql.Tx) error {
		var old *model.Employee
		if id != 0 {
			var err error
			old, err = Load(ctx, tx, id, true)
			if errors.Is(err, sql.ErrNoRows) {
				return apperr.NotFound("Employee not found.")
			} else if err != nil {
				return err
			}
		}
		in.ID = id
		if old == nil {
			if err := subjectDefaults(ctx, tx, in, sent); err != nil {
				return err
			}
		}
		switch {
		case act != nil:
			in.Active = *act
		case old != nil:
			in.Active = old.Active
		default:
			in.Active = true
		}
		if err := prepareEmployee(ctx, tx, in, old, c.Force()); err != nil {
			return err
		}
		newID, err := saveEmployee(ctx, tx, in)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Employee not found.")
		} else if err != nil {
			return err
		}
		saved = newID
		after, err := Load(ctx, tx, newID, false)
		if err != nil {
			return err
		}
		if old == nil {
			return store.Audit(ctx, tx, c.User, "add", "employee", newID, "Employee "+after.DisplayName, auditView(after))
		}
		oldSSN, oldRouting, oldAccount := old.SSN, old.DirectDeposit.Routing, old.DirectDeposit.Account
		mask(old)
		ch := changes(auditView(old), auditView(after))
		// a new number with the same last digits looks unchanged once masked
		for _, f := range []struct{ key, before, after, masked string }{
			{"ssn", oldSSN, in.SSN, store.MaskSSN(in.SSN)},
			{"directDeposit.routing", oldRouting, in.DirectDeposit.Routing, store.MaskAccount(in.DirectDeposit.Routing)},
			{"directDeposit.account", oldAccount, in.DirectDeposit.Account, store.MaskAccount(in.DirectDeposit.Account)},
		} {
			if _, listed := ch[f.key]; f.before != f.after && !listed {
				ch[f.key] = map[string]any{"changed": true, "after": f.masked}
			}
		}
		return store.Audit(ctx, tx, c.User, "modify", "employee", newID, "Employee "+after.DisplayName, ch)
	})
	if err != nil {
		return err
	}
	return respond(c, saved, syncBooks(c, saved))
}

// auditView is the employee as recorded in the audit trail: masked numbers,
// no computed fields.
func auditView(e *model.Employee) map[string]any {
	m := map[string]any{}
	b, _ := json.Marshal(e)
	json.Unmarshal(b, &m)
	for _, k := range []string{"ssnOnFile", "payScheduleName", "hourlyRate", "annualSalary", "ytdGross", "lastCheckDate", "hasPaychecks", "booksSyncError", "booksNameId"} {
		delete(m, k)
	}
	for _, k := range []string{"sick", "vacation"} {
		if p, ok := m[k].(map[string]any); ok {
			delete(p, "available")
			delete(p, "accruedYtd")
			delete(p, "usedYtd")
		}
	}
	return m
}

// changes lists the fields that differ (audit details).
func changes(before, after map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range after {
		if !reflect.DeepEqual(before[k], v) {
			out[k] = map[string]any{"before": before[k], "after": v}
		}
	}
	return out
}

func deleteRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	// An expired SerieX Books session would leave the employee's Books name
	// behind: ask the user to sign in again before deleting anything.
	var linked sql.NullInt64
	if err := c.DB.QueryRowContext(ctx, `SELECT books_name_id FROM employees WHERE id = ?`, id).Scan(&linked); err == nil && linked.Valid {
		if _, err := books.Default.GetName(ctx, books.S(c), linked.Int64); err != nil && books.IsAuth(err) {
			return books.ToAppErr(err)
		}
	}
	var booksName sql.NullInt64
	var name, first, last string
	err = c.Write(func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT display_name, first_name, last_name, books_name_id FROM employees WHERE id = ?`, id).Scan(&name, &first, &last, &booksName)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Employee not found.")
		} else if err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM paychecks WHERE employee_id = ?)`, id).Scan(&n); err != nil {
			return err
		}
		if n == 1 {
			return apperr.Conflict("%s has paychecks and cannot be deleted. You can make the employee inactive instead.", name)
		}
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM liability_adjustments WHERE employee_id = ?)`, id).Scan(&n); err != nil {
			return err
		}
		if n == 1 {
			return apperr.Conflict("%s has tax balance adjustments and cannot be deleted. You can make the employee inactive instead.", name)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM employees WHERE id = ?`, id); err != nil {
			return err
		}
		return store.Audit(ctx, tx, c.User, "delete", "employee", id, "Employee "+name, nil)
	})
	if err != nil {
		return err
	}
	if booksName.Valid {
		removeBooksName(c, booksName.Int64, name, first, last)
	}
	return c.NoContent()
}

// removeBooksName deletes the deleted employee's SerieX Books "other" name, or
// makes it inactive when Books keeps it (used by Books transactions). Best
// effort: the payroll employee is already deleted. SerieX Books reuses the id
// of a deleted record, so the name is touched only when it is still this
// employee's "other" name (same name, or same first and last name).
func removeBooksName(c *httpx.Ctx, nameID int64, display, first, last string) {
	ctx := c.Context()
	s := books.S(c)
	n, err := books.Default.GetName(ctx, s, nameID)
	if err != nil {
		if !books.IsNotFound(err) {
			log.Printf("employees: SerieX Books name %d of a deleted employee was kept: %v", nameID, err)
		}
		return
	}
	if !isEmployeeName(n, display, first, last) {
		log.Printf("employees: SerieX Books name %d is no longer the deleted employee's name; it was left unchanged", nameID)
		return
	}
	err = books.Default.Do(ctx, http.MethodDelete, books.CPath(c.CompanyID, "/names/"+strconv.FormatInt(nameID, 10)), &s, nil, nil, books.Options{})
	if err == nil {
		posting.Invalidate(c.CompanyID)
		return
	}
	if books.IsNotFound(err) {
		return
	}
	if n.Active {
		n.Active = false
		if _, uerr := books.Default.UpdateName(ctx, s, n); uerr != nil {
			log.Printf("employees: could not make SerieX Books name %d inactive: %v", nameID, uerr)
			return
		}
		posting.Invalidate(c.CompanyID)
	}
}

// isEmployeeName reports whether a SerieX Books name is the "other" name that
// payroll created for an employee (display name, "<display name> (Employee)"
// with the Books name rules, or the same first and last name).
func isEmployeeName(n books.Name, display, first, last string) bool {
	if n.Kind != books.NameOther || n.ParentID != nil {
		return false
	}
	want := strings.TrimSpace(strings.ReplaceAll(display, ":", "-"))
	if strings.EqualFold(n.Name, want) || strings.EqualFold(n.Name, want+" (Employee)") {
		return true
	}
	// long display names are cut to fit the Books name length
	if want != "" && len([]rune(want)) > 80 && strings.HasPrefix(strings.ToLower(n.Name), strings.ToLower(string([]rune(want)[:80]))) {
		return true
	}
	return first+last != "" && strings.EqualFold(n.FirstName, first) && strings.EqualFold(n.LastName, last)
}

func activeRoute(c *httpx.Ctx) error {
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
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		var name string
		var active int
		err := tx.QueryRowContext(ctx, `SELECT display_name, active FROM employees WHERE id = ?`, id).Scan(&name, &active)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Employee not found.")
		} else if err != nil {
			return err
		}
		if (active == 1) == *body.Active {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `UPDATE employees SET active = ?, updated_at = ? WHERE id = ?`, store.B(*body.Active), store.Now(), id); err != nil {
			return err
		}
		action := "make_inactive"
		if *body.Active {
			action = "make_active"
		}
		return store.Audit(ctx, tx, c.User, action, "employee", id, "Employee "+name, map[string]any{"active": *body.Active})
	})
	if err != nil {
		return err
	}
	return respond(c, id, syncBooks(c, id))
}

func ssnRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	if c.Assistant {
		return apperr.Forbidden("AI assistants cannot see full social security numbers.")
	}
	if !c.IsAdmin {
		return apperr.Forbidden("Only a SerieX Books administrator can view social security numbers.")
	}
	var name, ssn string
	err = c.DB.QueryRowContext(c.Context(), `SELECT display_name, ssn FROM employees WHERE id = ?`, id).Scan(&name, &ssn)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFound("Employee not found.")
	} else if err != nil {
		return err
	}
	if err := c.Write(func(tx *sql.Tx) error {
		return store.Audit(c.Context(), tx, c.User, "view_ssn", "employee", id, "Viewed the social security number of "+name, nil)
	}); err != nil {
		return err
	}
	return c.JSON(map[string]string{"ssn": store.FormatSSN(ssn)})
}

// ---------------------------------------------------------------------------
// GET /employees/{id}/summary?year=

var categoryOrder = map[string]int{
	model.CatEarning: 0, model.CatAddition: 1, model.CatDeduction: 2, model.CatEmployeeTax: 3,
	model.CatEmployerTax: 4, model.CatContribution: 5,
}

func summaryRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	year := int(c.QInt("year"))
	if year == 0 {
		year = store.Year(store.Today())
	}
	if year < 1900 || year > 2200 {
		return apperr.Validation("year", "Invalid year.")
	}
	s, err := Summary(c.Context(), c.DB, id, year)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFound("Employee not found.")
	} else if err != nil {
		return err
	}
	return c.JSON(s)
}

// Summary builds the Employee Center summary of one employee for a calendar
// year: totals of non-voided paychecks (regular and YTD entries) plus the
// employee's liability adjustments, the last paycheck, PTO and YTD by item.
func Summary(ctx context.Context, q store.Q, id int64, year int) (*model.EmployeeSummary, error) {
	from, to := store.YearRange(year)
	asOf := store.Today()
	if to < asOf {
		asOf = to
	}
	var name, hire, sick, vac string
	if err := q.QueryRowContext(ctx, `SELECT display_name, hire_date, sick, vacation FROM employees WHERE id = ?`, id).Scan(&name, &hire, &sick, &vac); err != nil {
		return nil, err
	}
	out := &model.EmployeeSummary{EmployeeID: id, Year: year, YTDByItem: []model.SummaryRow{}}

	var gross, net, taxes, ded int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(gross),0), COALESCE(SUM(net),0), COALESCE(SUM(employee_taxes),0), COALESCE(SUM(deductions),0)
		FROM paychecks WHERE employee_id = ? AND voided = 0 AND check_date BETWEEN ? AND ?`, id, from, to).Scan(&gross, &net, &taxes, &ded); err != nil {
		return nil, err
	}

	// last regular paycheck of the year
	last, err := lastPaycheck(ctx, q, id, name, from, to)
	if err != nil {
		return nil, err
	}
	out.LastPaycheck = last
	lastAmounts := map[int64]int64{}
	if last != nil {
		rows, err := q.QueryContext(ctx, `SELECT item_id, SUM(amount) FROM paycheck_lines WHERE paycheck_id = ? GROUP BY item_id`, last.ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var item, amt int64
			if err := rows.Scan(&item, &amt); err != nil {
				rows.Close()
				return nil, err
			}
			lastAmounts[item] = amt
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}

	type agg struct {
		name, typ, cat string
		ytd            int64
	}
	byItem := map[int64]*agg{}
	rows, err := q.QueryContext(ctx, `SELECT l.item_id, p.name, p.type, l.category, SUM(l.amount)
		FROM paycheck_lines l JOIN paychecks pc ON pc.id = l.paycheck_id JOIN payroll_items p ON p.id = l.item_id
		WHERE pc.employee_id = ? AND pc.voided = 0 AND pc.check_date BETWEEN ? AND ?
		GROUP BY l.item_id, l.category`, id, from, to)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item, amt int64
		var n, typ, cat string
		if err := rows.Scan(&item, &n, &typ, &cat, &amt); err != nil {
			rows.Close()
			return nil, err
		}
		if a := byItem[item]; a != nil {
			a.ytd += amt
		} else {
			byItem[item] = &agg{n, typ, cat, amt}
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// tax balance adjustments of the employee change the year-to-date totals
	rows, err = q.QueryContext(ctx, `SELECT al.item_id, p.name, p.type, p.tax_code, SUM(al.amount)
		FROM liability_adjustment_lines al JOIN liability_adjustments a ON a.id = al.adjustment_id JOIN payroll_items p ON p.id = al.item_id
		WHERE a.employee_id = ? AND a.effective_date BETWEEN ? AND ?
		GROUP BY al.item_id`, id, from, to)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var item, amt int64
		var n, typ, code string
		if err := rows.Scan(&item, &n, &typ, &code, &amt); err != nil {
			rows.Close()
			return nil, err
		}
		cat := model.ItemCategory(typ, code)
		switch cat {
		case model.CatEmployeeTax:
			taxes += amt
		case model.CatDeduction:
			ded += amt
		}
		if a := byItem[item]; a != nil {
			a.ytd += amt
		} else {
			byItem[item] = &agg{n, typ, cat, amt}
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for item, a := range byItem {
		out.YTDByItem = append(out.YTDByItem, model.SummaryRow{ItemID: item, ItemName: a.name, Category: a.cat,
			Amount: store.Dollars(lastAmounts[item]), YTD: store.Dollars(a.ytd)})
	}
	types := map[int64]string{}
	for item, a := range byItem {
		types[item] = a.typ
	}
	sort.Slice(out.YTDByItem, func(i, j int) bool {
		a, b := out.YTDByItem[i], out.YTDByItem[j]
		if categoryOrder[a.Category] != categoryOrder[b.Category] {
			return categoryOrder[a.Category] < categoryOrder[b.Category]
		}
		if ra, rb := typeRank(types[a.ItemID]), typeRank(types[b.ItemID]); ra != rb {
			return ra < rb
		}
		return strings.ToLower(a.ItemName) < strings.ToLower(b.ItemName)
	})
	out.YTDGross, out.YTDNet = store.Dollars(gross), store.Dollars(net)
	out.YTDTaxes, out.YTDDeductions = store.Dollars(taxes), store.Dollars(ded)

	data, err := loadPTOData(ctx, q, id, asOf, 0)
	if err != nil {
		return nil, err
	}
	d := data[id]
	if d == nil {
		d = &ptoData{}
	}
	out.Sick, out.Vacation = parsePTO(sick), parsePTO(vac)
	floor := ptoFloor(ctx, q)
	out.Sick.Available, out.Sick.AccruedYTD, out.Sick.UsedYTD = computePTO(out.Sick, hire, d.events("sick"), asOf, floor)
	out.Vacation.Available, out.Vacation.AccruedYTD, out.Vacation.UsedYTD = computePTO(out.Vacation, hire, d.events("vacation"), asOf, floor)
	return out, nil
}

func typeRank(t string) int {
	for i, x := range model.ItemTypeOrder {
		if x == t {
			return i
		}
	}
	return len(model.ItemTypeOrder)
}

func lastPaycheck(ctx context.Context, q store.Q, employeeID int64, name, from, to string) (*model.PaycheckSummary, error) {
	p := &model.PaycheckSummary{EmployeeID: employeeID, EmployeeName: name}
	var run, bank, txn sql.NullInt64
	var toBePrinted, dd, voided int
	var gross, taxes, ded, net, erTaxes, contrib int64
	err := q.QueryRowContext(ctx, `SELECT id, run_id, kind, period_start, period_end, check_date, check_number, to_be_printed, direct_deposit,
			bank_account_id, gross, employee_taxes, deductions, net, employer_taxes, contributions, total_hours, memo, voided,
			books_txn_id, sync_status, sync_error
		FROM paychecks WHERE employee_id = ? AND voided = 0 AND kind = 'regular' AND check_date BETWEEN ? AND ?
		ORDER BY check_date DESC, id DESC LIMIT 1`, employeeID, from, to).Scan(
		&p.ID, &run, &p.Kind, &p.PeriodStart, &p.PeriodEnd, &p.CheckDate, &p.CheckNumber, &toBePrinted, &dd,
		&bank, &gross, &taxes, &ded, &net, &erTaxes, &contrib, &p.TotalHours, &p.Memo, &voided,
		&txn, &p.SyncStatus, &p.SyncError)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.RunID, p.BankAccountID, p.BooksTxnID = store.PtrID(run), store.PtrID(bank), store.PtrID(txn)
	p.ToBePrinted, p.DirectDeposit, p.Voided = toBePrinted == 1, dd == 1, voided == 1
	p.Gross, p.EmployeeTaxes, p.Deductions = store.Dollars(gross), store.Dollars(taxes), store.Dollars(ded)
	p.Net, p.EmployerTaxes, p.Contributions = store.Dollars(net), store.Dollars(erTaxes), store.Dollars(contrib)
	return p, nil
}

// decodeWithActive reads the body into v and tells whether "active" was sent.
func decodeWithActive(c *httpx.Ctx, v any) (*bool, error) {
	body, err := httpx.ReadJSONBody(c.R, 1<<20)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, v); err != nil {
		return nil, httpx.BodyError(err)
	}
	var a struct {
		Active *bool `json:"active"`
	}
	json.Unmarshal(body, &a)
	return a.Active, nil
}
