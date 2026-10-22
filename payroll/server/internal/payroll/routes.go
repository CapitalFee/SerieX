package payroll

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

func registerRoutes(rt *httpx.Router) {
	rt.C("GET", "/payroll/scheduled", scheduledRoute)
	rt.C("POST", "/payroll/start", startRoute)
	rt.C("POST", "/payroll/create", createRoute)
	rt.C("POST", "/paychecks/calculate", calculateRoute)
	rt.C("POST", "/paychecks", createPaycheckRoute)
	rt.C("GET", "/paychecks", listRoute)
	rt.C("GET", "/paychecks/to-print", toPrintRoute)
	rt.C("POST", "/paychecks/mark-printed", markPrintedRoute)
	rt.C("GET", "/paychecks/{id}", getRoute)
	rt.C("PUT", "/paychecks/{id}", updateRoute)
	rt.C("DELETE", "/paychecks/{id}", deleteRoute)
	rt.C("POST", "/paychecks/{id}/void", voidRoute)
	rt.C("GET", "/paystubs", payStubsRoute)
}

// fillNames sets the SerieX Books names shown with a paycheck ("" when Books is unreachable).
func fillNames(c *httpx.Ctx, pc *model.Paycheck) {
	lk := posting.Lookup(c)
	if pc.BankAccountID != nil {
		if a, ok := lk.Accounts[*pc.BankAccountID]; ok {
			pc.BankAccountName = a.FullName
			if pc.BankAccountName == "" {
				pc.BankAccountName = a.Name
			}
		}
	}
	for i := range pc.Lines {
		l := &pc.Lines[i]
		if l.JobNameID != nil {
			if j, ok := lk.Jobs[*l.JobNameID]; ok {
				l.JobName = j.FullName
				if l.JobName == "" {
					l.JobName = j.Name
				}
			}
		}
	}
}

func respond(c *httpx.Ctx, id int64, extra ...string) error {
	pc, err := get(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	fillNames(c, pc)
	pc.Warnings = append(pc.Warnings, extra...)
	return c.JSON(pc)
}

// laterPaychecksWarning: year-to-date amounts entered (or changed) after
// paychecks dated later in the year were written do not recalculate those
// paychecks (saved paychecks keep their amounts); the answer says so.
func laterPaychecksWarning(ctx context.Context, q store.Q, id int64) ([]string, error) {
	var emp int64
	var date string
	if err := q.QueryRowContext(ctx, `SELECT employee_id, check_date FROM paychecks WHERE id = ?`, id).Scan(&emp, &date); err != nil {
		return nil, err
	}
	_, yearEnd := store.YearRange(store.Year(date))
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM paychecks WHERE employee_id = ? AND voided = 0 AND kind = 'regular'
		AND check_date > ? AND check_date <= ? AND id <> ?`, emp, date, yearEnd, id).Scan(&n); err != nil {
		return nil, err
	}
	switch {
	case n == 1:
		return []string{"1 paycheck dated after these year-to-date amounts was not recalculated: its wage base and annual limits do not include them. Edit it and recalculate if needed."}, nil
	case n > 1:
		return []string{fmt.Sprintf("%d paychecks dated after these year-to-date amounts were not recalculated: their wage base and annual limits do not include them. Edit them and recalculate if needed.", n)}, nil
	}
	return nil, nil
}

func getRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	return respond(c, id)
}

// POST /paychecks/calculate: preview a paycheck (nothing is saved).
func calculateRoute(c *httpx.Ctx) error {
	var in model.PaycheckInput
	if err := c.Decode(&in); err != nil {
		return err
	}
	// a new paycheck is always calculated; a saved one keeps the amounts sent unless Recalculate
	r, err := calculate(c.Context(), c.DB, nil, &in, calcOpts{keepAll: in.ID > 0 && !in.Recalculate})
	if err != nil {
		return err
	}
	pc := r.pc
	if in.ID > 0 {
		if h, err := loadHeader(c.Context(), c.DB, in.ID); err == nil {
			pc.RunID, pc.Voided, pc.BooksTxnID, pc.SyncStatus, pc.SyncError = h.RunID, h.Voided, h.BooksTxnID, h.SyncStatus, h.SyncError
			pc.CreatedBy, pc.CreatedAt, pc.UpdatedAt = h.CreatedBy, h.CreatedAt, h.UpdatedAt
		}
	}
	fillNames(c, pc)
	return c.JSON(pc)
}

// GET /paychecks?employeeId=&from=&to=&kind=&runId=&includeVoided=1&q=
func listRoute(c *httpx.Ctx) error {
	var where []string
	var args []any
	if id := c.QInt("employeeId"); id > 0 {
		where, args = append(where, "p.employee_id = ?"), append(args, id)
	}
	if from := c.Q("from"); from != "" {
		if !store.ValidDate(from) {
			return apperr.Validation("from", "Please enter a valid From date.")
		}
		where, args = append(where, "p.check_date >= ?"), append(args, from)
	}
	if to := c.Q("to"); to != "" {
		if !store.ValidDate(to) {
			return apperr.Validation("to", "Please enter a valid To date.")
		}
		where, args = append(where, "p.check_date <= ?"), append(args, to)
	}
	if k := c.Q("kind"); k != "" {
		if !validKind(k) {
			return apperr.Validation("kind", "kind must be regular or ytd")
		}
		where, args = append(where, "p.kind = ?"), append(args, k)
	}
	if id := c.QInt("runId"); id > 0 {
		where, args = append(where, "p.run_id = ?"), append(args, id)
	}
	if !c.QBool("includeVoided") {
		where = append(where, "p.voided = 0")
	}
	if s := strings.TrimSpace(c.Q("q")); s != "" {
		like := "%" + strings.ReplaceAll(strings.ReplaceAll(s, "%", ""), "_", "") + "%"
		where = append(where, "(e.display_name LIKE ? OR p.check_number LIKE ? OR p.memo LIKE ?)")
		args = append(args, like, like, like)
	}
	list, err := listSummaries(c.Context(), c.DB, where, args, "p.check_date DESC, p.id DESC")
	if err != nil {
		return err
	}
	return c.JSON(list)
}

// ---------------------------------------------------------------------------
// Check numbers

// nextNumber increments the number at the end of a check number ("1009" ->
// "1010", "A-099" -> "A-100").
func nextNumber(s string) string {
	i := len(s)
	for i > 0 && s[i-1] >= '0' && s[i-1] <= '9' {
		i--
	}
	digits := s[i:]
	if digits == "" {
		return s
	}
	n, err := strconv.ParseUint(digits, 10, 64)
	if err != nil {
		return s
	}
	next := strconv.FormatUint(n+1, 10)
	if len(next) < len(digits) {
		next = strings.Repeat("0", len(digits)-len(next)) + next
	}
	return s[:i] + next
}

func validCheckNumber(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && len(s) <= 20 && s[len(s)-1] >= '0' && s[len(s)-1] <= '9'
}

// duplicateCheck asks (confirm) when a check number is already used by
// another paycheck of the same bank account (prefs.warnDuplicateCheckNumbers).
// q is the write transaction of the request (the numbers are saved in it).
func duplicateCheck(c *httpx.Ctx, q store.Q, bank int64, numbers []string, exclude int64) error {
	if c.Force() || len(numbers) == 0 {
		return nil
	}
	prefs, err := store.LoadPrefs(c.Context(), q)
	if err != nil {
		return err
	}
	if !prefs.WarnDuplicateCheckNumbers {
		return nil
	}
	for _, n := range numbers {
		var name, date string
		err := q.QueryRowContext(c.Context(), `SELECT e.display_name, p.check_date FROM paychecks p JOIN employees e ON e.id = p.employee_id
			WHERE p.bank_account_id = ? AND p.check_number = ? AND p.voided = 0 AND p.kind = 'regular' AND p.id <> ? LIMIT 1`,
			bank, n, exclude).Scan(&name, &date)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return err
		}
		return apperr.Confirm("Check number %s is already used by the paycheck to %s dated %s. Do you want to use it anyway?", n, name, mdy(date))
	}
	return nil
}

func mdy(date string) string {
	t, err := store.ParseDate(date)
	if err != nil {
		return date
	}
	return t.Format("01/02/2006")
}

// ---------------------------------------------------------------------------
// POST /paychecks: one unscheduled paycheck (kind regular) or a Set Up YTD
// Amounts entry (kind ytd: the quarter, no check, never posted).

func createPaycheckRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	var in model.PaycheckInput
	if err := c.Decode(&in); err != nil {
		return err
	}
	in.ID = 0
	in.Recalculate = true
	if in.Kind == "" {
		in.Kind = model.PaycheckRegular
	}
	if !validKind(in.Kind) {
		return apperr.Validation("kind", "Unknown paycheck kind %q.", in.Kind)
	}
	if in.Kind == model.PaycheckYTD {
		in.BankAccountID, in.CheckNumber, in.ToBePrinted, in.DirectDeposit, in.NoAccrual = nil, "", false, false, true
	} else {
		if in.BankAccountID == nil || *in.BankAccountID <= 0 {
			prefs, err := store.LoadPrefs(ctx, c.DB)
			if err != nil {
				return err
			}
			in.BankAccountID = prefs.DefaultBankAccountID
		}
		if in.BankAccountID == nil || *in.BankAccountID <= 0 {
			return apperr.Validation("bankAccountId", "Choose the bank account the paycheck is drawn on.")
		}
		in.CheckNumber = strings.TrimSpace(in.CheckNumber)
		if in.ToBePrinted || in.DirectDeposit {
			in.CheckNumber = ""
		}
	}
	status := syncPending
	if in.Kind == model.PaycheckYTD {
		status = syncNone
	}
	var id int64
	// calculated inside the write transaction (year-to-date amounts and check
	// numbers of paychecks saved at the same time are seen)
	err := c.Write(func(tx *sql.Tx) error {
		r, err := calculate(ctx, tx, nil, &in, calcOpts{})
		if err != nil {
			return err
		}
		if in.Kind == model.PaycheckRegular {
			if err := checkPayable(r); err != nil {
				return err
			}
			if in.DirectDeposit && !r.emp.DirectDeposit.Enabled {
				return apperr.Validation("directDeposit", "%s is not set up for direct deposit.", r.emp.DisplayName)
			}
			if in.CheckNumber != "" {
				if err := duplicateCheck(c, tx, *in.BankAccountID, []string{in.CheckNumber}, 0); err != nil {
					return err
				}
			}
		}
		if id, err = insertPaycheck(ctx, tx, r, nil, c.User, status); err != nil {
			return err
		}
		if in.DirectDeposit {
			r.pc.CheckNumber = "DD" + strconv.FormatInt(id, 10)
			if _, err := tx.ExecContext(ctx, `UPDATE paychecks SET check_number = ? WHERE id = ?`, r.pc.CheckNumber, id); err != nil {
				return err
			}
		}
		r.pc.ID = id
		summary := "Paycheck - " + r.emp.DisplayName
		if in.Kind == model.PaycheckYTD {
			summary = "Year-to-date amounts - " + r.emp.DisplayName
		}
		return store.Audit(ctx, tx, c.User, "add", "paycheck", id, summary, map[string]any{"after": auditView(r.pc)})
	})
	if err != nil {
		return err
	}
	if in.Kind == model.PaycheckRegular {
		if _, err := posting.PostPaycheck(c, id, books.Opts(c)); err != nil {
			return err
		}
		return respond(c, id)
	}
	warn, err := laterPaychecksWarning(ctx, c.DB, id)
	if err != nil {
		return err
	}
	return respond(c, id, warn...)
}

// checkPayable rejects paychecks that cannot be written.
func checkPayable(r *calcResult) error {
	earnings, any := false, false
	for _, l := range r.lines {
		if l.amount != 0 {
			any = true
			if l.category == model.CatEarning || l.category == model.CatAddition {
				earnings = true
			}
		}
	}
	if !any || (!earnings && r.net < 0) {
		return apperr.Validation("lines", "The paycheck of %s has no earnings. Enter hours or amounts before creating it.", r.emp.DisplayName)
	}
	if r.net < 0 {
		return apperr.Validation("lines", "Net pay cannot be less than zero. The paycheck of %s has a net pay of %s; reduce its deductions or taxes.",
			r.emp.DisplayName, money(r.net))
	}
	return nil
}

// ---------------------------------------------------------------------------
// PUT /paychecks/{id}: edit a saved paycheck (past paychecks can be edited).
// Recalculate decides whether the amounts are computed again.

func updateRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var in model.PaycheckInput
	if err := c.Decode(&in); err != nil {
		return err
	}
	var kind string
	// read, recalculated and saved in one write transaction: a paycheck saved
	// or voided at the same time by another request is never overwritten with
	// amounts calculated from an older state
	err = c.Write(func(tx *sql.Tx) error {
		h, err := loadHeader(ctx, tx, id)
		if err != nil {
			return err
		}
		if h.Voided {
			return apperr.Conflict("This paycheck is void and cannot be changed.")
		}
		if in.EmployeeID != 0 && in.EmployeeID != h.EmployeeID {
			return apperr.Validation("employeeId", "The employee of a paycheck cannot be changed. Void or delete it and create a new paycheck.")
		}
		in.ID, in.EmployeeID, in.Kind = id, h.EmployeeID, h.Kind
		kind = h.Kind
		if in.CheckDate == "" {
			in.CheckDate = h.CheckDate
		}
		if in.PeriodEnd == "" {
			in.PeriodEnd = h.PeriodEnd
		}
		if in.PeriodStart == "" {
			in.PeriodStart = h.PeriodStart
		}
		before, err := get(ctx, tx, id)
		if err != nil {
			return err
		}
		keepAll := !in.Recalculate
		if in.Lines == nil {
			in.Lines = before.Lines // header-only change: the saved lines as they are
			keepAll = true
		}
		if in.Kind == model.PaycheckYTD {
			in.BankAccountID, in.CheckNumber, in.ToBePrinted, in.DirectDeposit, in.NoAccrual = nil, "", false, false, true
		} else {
			if in.BankAccountID == nil || *in.BankAccountID <= 0 {
				in.BankAccountID = h.BankAccountID
			}
			if in.BankAccountID == nil || *in.BankAccountID <= 0 {
				return apperr.Validation("bankAccountId", "Choose the bank account the paycheck is drawn on.")
			}
			in.CheckNumber = strings.TrimSpace(in.CheckNumber)
			dd := "DD" + strconv.FormatInt(id, 10)
			switch {
			case in.DirectDeposit:
				in.CheckNumber, in.ToBePrinted = dd, false
			case in.ToBePrinted:
				in.CheckNumber = ""
			case strings.EqualFold(in.CheckNumber, dd):
				// direct deposit turned off: the DD number is not a check number; the check is to be printed
				in.CheckNumber, in.ToBePrinted = "", true
			}
		}
		r, err := calculate(ctx, tx, nil, &in, calcOpts{keepAll: keepAll})
		if err != nil {
			return err
		}
		if in.Kind == model.PaycheckRegular {
			if err := checkPayable(r); err != nil {
				return err
			}
			if in.DirectDeposit && !h.DirectDeposit && !r.emp.DirectDeposit.Enabled {
				return apperr.Validation("directDeposit", "%s is not set up for direct deposit.", r.emp.DisplayName)
			}
			if in.CheckNumber != "" && !in.DirectDeposit && in.CheckNumber != h.CheckNumber {
				if err := duplicateCheck(c, tx, *in.BankAccountID, []string{in.CheckNumber}, id); err != nil {
					return err
				}
			}
		}
		r.pc.ID = id
		r.pc.EmployeeName = h.EmployeeName
		if err := updatePaycheck(ctx, tx, id, r); err != nil {
			return err
		}
		return store.Audit(ctx, tx, c.User, "modify", "paycheck", id, "Paycheck - "+h.EmployeeName,
			map[string]any{"before": auditView(before), "after": auditView(r.pc)})
	})
	if err != nil {
		return err
	}
	if kind == model.PaycheckRegular {
		// re-post: replaces the Books check (same Books id); problems are kept on the paycheck
		if _, err := posting.PostPaycheck(c, id, books.Opts(c)); err != nil {
			return err
		}
		return respond(c, id)
	}
	warn, err := laterPaychecksWarning(ctx, c.DB, id)
	if err != nil {
		return err
	}
	return respond(c, id, warn...)
}

// ---------------------------------------------------------------------------
// POST /paychecks/{id}/void: the Books check is voided first (abort on error),
// then the paycheck and its lines are set to zero and kept as void.

func voidRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	h, err := loadHeader(ctx, c.DB, id)
	if err != nil {
		return err
	}
	if h.Voided {
		return apperr.Conflict("This paycheck is already void.")
	}
	// the Books void and the payroll void run under the paycheck's posting lock:
	// a Books Sync retry of this paycheck waits until both are done
	err = posting.WithRecordLock(c, posting.EntityPaycheck, id, func(c *httpx.Ctx) error {
		if err := posting.Unpost(c, posting.EntityPaycheck, id, "void", books.Opts(c)); err != nil {
			return err
		}
		return c.Write(func(tx *sql.Tx) error {
			h, err := loadHeader(ctx, tx, id)
			if err != nil {
				return err
			}
			if h.Voided {
				return apperr.Conflict("This paycheck is already void.")
			}
			before, err := get(ctx, tx, id)
			if err != nil {
				return err
			}
			memo := h.Memo
			if !strings.HasPrefix(memo, "VOID:") {
				memo = strings.TrimSpace("VOID: " + memo)
			}
			if _, err := tx.ExecContext(ctx, `UPDATE paychecks SET gross = 0, not_paid = 0, deductions = 0, employee_taxes = 0, net = 0,
			employer_taxes = 0, contributions = 0, total_hours = 0, sick_accrued = 0, sick_used = 0, vac_accrued = 0, vac_used = 0,
			voided = 1, to_be_printed = 0, memo = ?, updated_at = ?,
			sync_status = CASE WHEN books_txn_id IS NULL THEN 'none' ELSE sync_status END,
			sync_error = CASE WHEN books_txn_id IS NULL THEN '' ELSE sync_error END
			WHERE id = ?`, memo, store.Now(), id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE paycheck_lines SET amount = 0, wage_base = 0, subject_wages = 0, computed = 0,
			qty = CASE WHEN qty IS NULL THEN NULL ELSE 0 END WHERE paycheck_id = ?`, id); err != nil {
				return err
			}
			return store.Audit(ctx, tx, c.User, "void", "paycheck", id, "Paycheck - "+h.EmployeeName,
				map[string]any{"before": auditView(before)})
		})
	})
	if err != nil {
		return err
	}
	// A posting that ran (or was still running) between the Books void and the
	// payroll void (Books Sync retry, an edit's re-post) may have linked a new
	// Books check: posting the voided paycheck waits for it and voids that check
	// in Books too. Usually the check is already void (Books is only read) or the
	// paycheck was never posted (Books is not called).
	if _, err := posting.PostPaycheck(c, id, books.Opts(c)); err != nil {
		return err
	}
	return respond(c, id)
}

// DELETE /paychecks/{id}: the Books check is deleted first (abort on error).
func deleteRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	if _, err := loadHeader(ctx, c.DB, id); err != nil {
		return err
	}
	// the Books delete and the payroll delete run under the paycheck's posting
	// lock: a Books Sync retry of this paycheck cannot post it again in between
	err = posting.WithRecordLock(c, posting.EntityPaycheck, id, func(c *httpx.Ctx) error {
		if err := posting.Unpost(c, posting.EntityPaycheck, id, "delete", books.Opts(c)); err != nil {
			return err
		}
		return c.Write(func(tx *sql.Tx) error {
			h, err := loadHeader(ctx, tx, id)
			if err != nil {
				return err
			}
			if h.BooksTxnID != nil {
				// posted again by another request after the Books check was deleted
				return apperr.Conflict("The paycheck was posted to SerieX Books again while it was being deleted. Delete it again.")
			}
			before, err := get(ctx, tx, id)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM paychecks WHERE id = ?`, id); err != nil {
				return err
			}
			if h.RunID != nil {
				if _, err := tx.ExecContext(ctx, `DELETE FROM payroll_runs WHERE id = ? AND NOT EXISTS (SELECT 1 FROM paychecks WHERE run_id = ?)`,
					*h.RunID, *h.RunID); err != nil {
					return err
				}
			}
			return store.Audit(ctx, tx, c.User, "delete", "paycheck", id, "Paycheck - "+h.EmployeeName,
				map[string]any{"before": auditView(before)})
		})
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}

// ---------------------------------------------------------------------------
// Printing

// GET /paychecks/to-print?bankAccountId=
func toPrintRoute(c *httpx.Ctx) error {
	where := []string{"p.to_be_printed = 1", "p.voided = 0", "p.kind = 'regular'", "p.direct_deposit = 0"}
	var args []any
	if id := c.QInt("bankAccountId"); id > 0 {
		where, args = append(where, "p.bank_account_id = ?"), append(args, id)
	}
	list, err := listSummaries(c.Context(), c.DB, where, args, "p.check_date, e.display_name COLLATE NOCASE, p.id")
	if err != nil {
		return err
	}
	return c.JSON(list)
}

// POST /paychecks/mark-printed {ids, firstNumber}: numbers the printed
// paychecks in the given order, clears "to be printed" and re-posts them.
func markPrintedRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	var body struct {
		IDs         []int64 `json:"ids"`
		FirstNumber string  `json:"firstNumber"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	if len(body.IDs) == 0 {
		return apperr.Validation("ids", "Select the paychecks that were printed.")
	}
	body.FirstNumber = strings.TrimSpace(body.FirstNumber)
	if !validCheckNumber(body.FirstNumber) {
		return apperr.Validation("firstNumber", "Enter the first check number (it must end with a number).")
	}
	numbers := make([]string, len(body.IDs))
	headers := make([]*header, len(body.IDs))
	seen := map[int64]bool{}
	for _, id := range body.IDs {
		if seen[id] {
			return apperr.Validation("ids", "Paycheck #%d is listed twice.", id)
		}
		seen[id] = true
	}
	err := c.Write(func(tx *sql.Tx) error {
		n := body.FirstNumber
		byBank := map[int64][]string{}
		for i, id := range body.IDs {
			h, err := loadHeader(ctx, tx, id)
			if err != nil {
				return err
			}
			switch {
			case h.Voided:
				return apperr.Validation("ids", "The paycheck to %s dated %s is void.", h.EmployeeName, mdy(h.CheckDate))
			case h.Kind != model.PaycheckRegular:
				return apperr.Validation("ids", "Year-to-date amounts are not printed.")
			case h.DirectDeposit:
				return apperr.Validation("ids", "The paycheck to %s is a direct deposit and is not printed as a check.", h.EmployeeName)
			}
			headers[i], numbers[i] = h, n
			if h.BankAccountID != nil {
				byBank[*h.BankAccountID] = append(byBank[*h.BankAccountID], n)
			}
			n = nextNumber(n)
		}
		for bank, nums := range byBank {
			if err := duplicateCheck(c, tx, bank, nums, -1); err != nil {
				// numbers already used by the selected paychecks themselves (reprints) are fine
				same, serr := samePaychecks(ctx, tx, bank, nums, seen)
				if serr != nil {
					return serr
				}
				if !same {
					return err
				}
			}
		}
		for i, h := range headers {
			if _, err := tx.ExecContext(ctx, `UPDATE paychecks SET check_number = ?, to_be_printed = 0, updated_at = ? WHERE id = ?`,
				numbers[i], store.Now(), h.ID); err != nil {
				return err
			}
			if err := store.Audit(ctx, tx, c.User, "modify", "paycheck", h.ID, "Paycheck - "+h.EmployeeName+" printed",
				map[string]any{"before": map[string]any{"checkNumber": h.CheckNumber, "toBePrinted": h.ToBePrinted},
					"after": map[string]any{"checkNumber": numbers[i], "toBePrinted": false}}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	res := struct {
		Updated  int                 `json:"updated"`
		Posted   int                 `json:"posted"`
		Problems []model.SyncProblem `json:"problems"`
	}{Updated: len(headers), Problems: []model.SyncProblem{}}
	res.Posted, res.Problems = postAll(c, body.IDs, books.Opts(c))
	return c.JSON(res)
}

// samePaychecks reports whether every paycheck using one of the numbers is one of ids.
func samePaychecks(ctx context.Context, q store.Q, bank int64, numbers []string, ids map[int64]bool) (bool, error) {
	for _, n := range numbers {
		rows, err := q.QueryContext(ctx, `SELECT id FROM paychecks WHERE bank_account_id = ? AND check_number = ? AND voided = 0 AND kind = 'regular'`, bank, n)
		if err != nil {
			return false, err
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return false, err
			}
			if !ids[id] {
				rows.Close()
				return false, nil
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return false, err
		}
	}
	return true, nil
}

// postAll posts paychecks to SerieX Books. After SerieX Books is found
// unreachable (or the session expired) the remaining paychecks are not sent;
// they are marked with the same problem so the Books Sync window lists them.
func postAll(c *httpx.Ctx, ids []int64, opt books.Options) (int, []model.SyncProblem) {
	problems := []model.SyncProblem{}
	posted := 0
	var stop *model.SyncProblem
	var skipped []int64
	for _, id := range ids {
		if stop != nil {
			p := *stop
			p.ID = id
			p.Label = labelOf(c, id)
			problems = append(problems, p)
			skipped = append(skipped, id)
			continue
		}
		p, err := posting.PostPaycheck(c, id, opt)
		if err != nil {
			p = &model.SyncProblem{Entity: posting.EntityPaycheck, ID: id, Label: labelOf(c, id), Code: apperr.CodeInternal, Message: posting.ProblemMessage(err)}
		}
		if p != nil {
			problems = append(problems, *p)
			if p.Code == apperr.CodeBooksUnavailable || p.Code == apperr.CodeBooksAuth {
				stop = p
			}
			continue
		}
		var status string
		c.DB.QueryRowContext(c.Context(), `SELECT sync_status FROM paychecks WHERE id = ?`, id).Scan(&status)
		if status == "posted" {
			posted++
		}
	}
	if stop != nil && len(skipped) > 0 {
		c.Write(func(tx *sql.Tx) error {
			for _, id := range skipped {
				if _, err := tx.ExecContext(c.Context(), `UPDATE paychecks SET sync_status = 'error', sync_error = ? WHERE id = ? AND sync_status IN ('pending','error')`,
					stop.Message, id); err != nil {
					return err
				}
			}
			return nil
		})
	}
	return posted, problems
}

func labelOf(c *httpx.Ctx, id int64) string {
	var name string
	c.DB.QueryRowContext(c.Context(), `SELECT e.display_name FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`, id).Scan(&name)
	return fmt.Sprintf("Paycheck - %s", name)
}
