package posting

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"sync"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

const (
	statusNone    = "none"
	statusPending = "pending"
	statusPosted  = "posted"
	statusError   = "error"
)

// recordLocks serializes the posting of one record so two requests never
// create two Books transactions for it.
var recordLocks sync.Map // "company/entity/id" -> *sync.Mutex

// heldLocks is the context key of the record locks a request holds through
// WithRecordLock (map[string]bool, never modified once stored).
type heldLocks struct{}

func lockKey(companyID, entity string, id int64) string {
	return fmt.Sprintf("%s/%s/%d", companyID, entity, id)
}

// lockRecord takes the posting lock of a record (a no-op when the request
// already holds it through WithRecordLock).
func lockRecord(ctx context.Context, companyID, entity string, id int64) func() {
	k := lockKey(companyID, entity, id)
	if held, _ := ctx.Value(heldLocks{}).(map[string]bool); held[k] {
		return func() {}
	}
	l, _ := recordLocks.LoadOrStore(k, &sync.Mutex{})
	mu := l.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

func withRecordLock(c *httpx.Ctx, entity string, id int64, fn func(c *httpx.Ctx) error) error {
	ctx := c.Context()
	k := lockKey(c.CompanyID, entity, id)
	unlock := lockRecord(ctx, c.CompanyID, entity, id)
	defer unlock()
	held := map[string]bool{k: true}
	if prev, _ := ctx.Value(heldLocks{}).(map[string]bool); prev != nil {
		for x := range prev {
			held[x] = true
		}
	}
	cc := *c
	cc.R = c.R.WithContext(context.WithValue(ctx, heldLocks{}, held))
	return fn(&cc)
}

// detached returns a copy of c whose request context cannot be canceled: once
// a Books transaction was sent, its id must be stored even when the browser
// went away (otherwise a retry would post it twice). The caller's c is not
// modified, so several postings may run at the same time with one request.
func detached(c *httpx.Ctx) *httpx.Ctx {
	cc := *c
	cc.R = c.R.WithContext(context.WithoutCancel(c.R.Context()))
	return &cc
}

// problemOf converts a Books (or other) error into a sync problem.
func problemOf(r *record, err error) *model.SyncProblem {
	p := &model.SyncProblem{Entity: r.Entity, ID: r.ID, Label: r.Label, Code: apperr.CodeInternal}
	if ae := apperr.As(books.ToAppErr(err)); ae != nil {
		p.Code, p.Message = ae.Code, ae.Message
	} else {
		p.Message = httpx.InternalMessage(err.Error())
	}
	return p
}

// ProblemMessage is the text shown for a SerieX Books sync problem: the
// message of a payroll or SerieX Books error, or a plain message with a
// reference for anything else (the detail is logged, never shown).
func ProblemMessage(err error) string {
	if ae := apperr.As(books.ToAppErr(err)); ae != nil {
		return ae.Message
	}
	return httpx.InternalMessage(err.Error())
}

// setSync stores the sync state of a record. txnID is stored when setTxn is true.
func setSync(c *httpx.Ctx, table string, id int64, status, msg string, txnID *int64, setTxn bool) error {
	ctx := c.Context()
	return c.Write(func(tx *sql.Tx) error {
		q := `UPDATE ` + table + ` SET sync_status = ?, sync_error = ?`
		args := []any{status, msg}
		if status == statusPosted {
			q += `, synced_at = ?`
			args = append(args, store.Now())
		}
		if setTxn {
			q += `, books_txn_id = ?`
			args = append(args, store.NullID(txnID))
		}
		q += ` WHERE id = ?`
		args = append(args, id)
		_, err := tx.ExecContext(ctx, q, args...)
		return err
	})
}

func notFoundErr(entity string) error {
	switch entity {
	case EntityPaycheck:
		return apperr.NotFound("Paycheck not found.")
	case EntityPayment:
		return apperr.NotFound("Tax payment not found.")
	case EntityAdjustment:
		return apperr.NotFound("Tax balance adjustment not found.")
	}
	return apperr.NotFound("Record not found.")
}

// post posts one record and returns its new sync status.
func post(c *httpx.Ctx, entity string, id int64, opt books.Options) (string, *model.SyncProblem, error) {
	if tableOf(entity) == "" {
		return "", nil, apperr.BadRequest("unknown payroll record type %q", entity)
	}
	c = detached(c)
	unlock := lockRecord(c.Context(), c.CompanyID, entity, id)
	defer unlock()
	ctx := c.Context()

	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return "", nil, err
	}
	items, err := loadItems(ctx, c.DB)
	if err != nil {
		return "", nil, err
	}
	r, err := build(ctx, c.DB, entity, id, prefs, items)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, notFoundErr(entity)
	}
	if err != nil {
		return "", nil, err
	}
	s := books.S(c)
	cl := books.Default

	// Posting turned off: nothing is sent to (or read from) SerieX Books. A
	// transaction posted earlier keeps its link and is updated when posting is
	// turned back on. Voids and records that must leave Books are still applied.
	if !prefs.PostToBooks && !r.Voided && r.NoPost == "" {
		return statusNone, nil, setSync(c, r.Table, id, statusNone, "", nil, false)
	}

	// The Books transaction posted earlier (nil when it no longer exists in Books).
	var cur *books.Txn
	if r.TxnID != nil {
		t, own, err := ownTxn(ctx, s, entity, id, *r.TxnID)
		if err != nil {
			p := problemOf(r, err)
			return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
		}
		if own {
			cur = &t
		}
	}

	// Voided records: the Books transaction is voided too.
	if r.Voided {
		if cur == nil {
			return statusNone, nil, setSync(c, r.Table, id, statusNone, "", nil, true)
		}
		if !cur.Voided {
			if _, err := cl.VoidTxn(ctx, s, cur.ID, opt); err != nil {
				p := problemOf(r, err)
				return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
			}
		}
		return statusPosted, nil, setSync(c, r.Table, id, statusPosted, "", nil, false)
	}

	// Records that never go to Books (a transaction posted earlier is removed).
	if r.NoPost != "" {
		if cur != nil {
			if err := cl.DeleteTxn(ctx, s, cur.ID, opt); err != nil && !books.IsNotFound(err) {
				p := problemOf(r, err)
				return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
			}
		}
		return statusNone, nil, setSync(c, r.Table, id, statusNone, "", nil, true)
	}

	// The employee needs a Books name before the paycheck can name the payee.
	ensured := false
	ensureName := func() (*model.SyncProblem, error) {
		ensured = true
		if _, err := ensureEmployeeName(c, r.EmployeeID); err != nil {
			return problemOf(r, err), nil
		}
		nr, err := build(ctx, c.DB, entity, id, prefs, items)
		if err != nil {
			return nil, err
		}
		r = nr
		return nil, nil
	}
	if r.EmployeeID != 0 {
		ok, err := linkedNameOK(ctx, s, r.EmployeeBooksID, r.EmployeeName)
		if err != nil {
			p := problemOf(r, err)
			return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
		}
		if !ok {
			p, err := ensureName()
			if err != nil {
				return "", nil, err
			}
			if p != nil {
				return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
			}
		}
	}

	if r.Problem != "" {
		p := &model.SyncProblem{Entity: entity, ID: id, Label: r.Label, Code: apperr.CodeValidation, Message: r.Problem}
		return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
	}

	// A tax payment check's address box is the agency vendor's address in Books
	// (as Write Checks fills it). A vendor that no longer exists is reported by
	// Books when the check is sent.
	if entity == EntityPayment && r.Txn.NameID != nil {
		v, err := cl.GetName(ctx, s, *r.Txn.NameID)
		switch {
		case err == nil:
			r.Txn.BillAddress = books.CheckAddress(v)
		case !books.IsNotFound(err):
			p := problemOf(r, err)
			return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
		}
	}

	send := func() (books.Txn, error) {
		t := r.Txn
		// Replace the transaction posted earlier. When it was deleted in Books, or
		// voided there (a voided transaction stays voided as history), the record
		// is posted again as a new transaction.
		if cur != nil && !cur.Voided {
			t.ID = cur.ID
			out, err := cl.UpdateTxn(ctx, s, t, opt)
			if !books.IsNotFound(err) {
				return out, err
			}
			t.ID = 0
		}
		return cl.CreateTxn(ctx, s, t, opt)
	}
	out, err := send()
	if err != nil && !ensured && r.EmployeeID != 0 && staleName(err) {
		// the employee's Books name was deleted in Books: create it again and resend
		p, lerr := ensureName()
		if lerr != nil {
			return "", nil, lerr
		}
		if p != nil {
			return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
		}
		out, err = send()
	}
	if err != nil {
		p := problemOf(r, err)
		return statusError, p, setSync(c, r.Table, id, statusError, p.Message, nil, false)
	}
	return statusPosted, nil, setSync(c, r.Table, id, statusPosted, "", &out.ID, true)
}

// ownTxn reads the Books transaction a record is linked to. own is false when
// it no longer exists or carries another record's payroll tag: Books reuses
// the id of a deleted transaction, and payroll must never change a transaction
// it did not post.
func ownTxn(ctx context.Context, s books.Session, entity string, id, txnID int64) (books.Txn, bool, error) {
	t, err := books.Default.GetTxn(ctx, s, txnID)
	if books.IsNotFound(err) {
		return t, false, nil
	}
	if err != nil {
		return t, false, err
	}
	return t, isOwn(&t, entity, id), nil
}

// isOwn reports whether a Books transaction carries the payroll tag of a record.
func isOwn(t *books.Txn, entity string, id int64) bool {
	p, _ := t.Extra["payroll"].(map[string]any)
	if p == nil || t.ID == 0 {
		return false
	}
	kind, _ := p["kind"].(string)
	n, _ := p["id"].(float64)
	return kind == entity && int64(n) == id
}

// staleName: Books rejected the transaction because a name it refers to no longer exists.
func staleName(err error) bool {
	e := books.AsError(err)
	if e == nil || e.Code != apperr.CodeValidation {
		return false
	}
	return e.Field == "nameId" || strings.Contains(e.Message, "name no longer exists")
}

// ---------------------------------------------------------------------------
// Retry

func openRefs(ctx context.Context, q store.Q) ([]model.SyncRef, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT 'paycheck' AS entity, id, check_date AS d, 1 AS o FROM paychecks WHERE sync_status IN ('pending','error')
		UNION ALL SELECT 'liability_payment', id, date, 2 FROM liability_payments WHERE sync_status IN ('pending','error')
		UNION ALL SELECT 'adjustment', id, date, 3 FROM liability_adjustments WHERE sync_status IN ('pending','error')
		ORDER BY d, o, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.SyncRef
	for rows.Next() {
		var r model.SyncRef
		var d string
		var o int
		if err := rows.Scan(&r.Entity, &r.ID, &d, &o); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func retry(c *httpx.Ctx, refs []model.SyncRef, opt books.Options) (model.RetryResult, error) {
	res := model.RetryResult{Problems: []model.SyncProblem{}}
	if len(refs) == 0 {
		var err error
		if refs, err = openRefs(c.Context(), c.DB); err != nil {
			return res, err
		}
	}
	var stop *model.SyncProblem // Books unreachable / session expired: do not try the others
	for _, ref := range refs {
		if stop != nil {
			p := *stop
			p.Entity, p.ID, p.Label = ref.Entity, ref.ID, labelOf(c, ref)
			res.Problems = append(res.Problems, p)
			continue
		}
		var p *model.SyncProblem
		switch ref.Entity {
		case EntityPaycheck, EntityPayment, EntityAdjustment:
			st, prob, err := post(c, ref.Entity, ref.ID, opt)
			if ae := apperr.As(err); ae != nil && ae.Code == apperr.CodeNotFound {
				prob, err = &model.SyncProblem{Entity: ref.Entity, ID: ref.ID, Code: apperr.CodeNotFound, Message: ae.Message}, nil
			}
			if err != nil {
				return res, err
			}
			p = prob
			if p == nil && st == statusPosted {
				res.Posted++
			}
		case EntityEmployee:
			if _, err := ensureEmployeeName(c, ref.ID); err != nil {
				ae := apperr.As(err)
				if ae == nil {
					return res, err
				}
				p = &model.SyncProblem{Entity: EntityEmployee, ID: ref.ID, Label: labelOf(c, ref), Code: ae.Code, Message: ae.Message}
			} else {
				res.Posted++
			}
		default:
			return res, apperr.Validation("items", "Unknown record type %q.", ref.Entity)
		}
		if p != nil {
			res.Problems = append(res.Problems, *p)
			if p.Code == apperr.CodeBooksUnavailable || p.Code == apperr.CodeBooksAuth {
				stop = p
			}
		}
	}
	return res, nil
}

// labelOf names a record for problem lists ("" when it cannot be read).
func labelOf(c *httpx.Ctx, ref model.SyncRef) string {
	ctx := c.Context()
	var s string
	switch ref.Entity {
	case EntityPaycheck:
		c.DB.QueryRowContext(ctx, `SELECT 'Paycheck - ' || e.display_name FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`, ref.ID).Scan(&s)
	case EntityPayment:
		c.DB.QueryRowContext(ctx, `SELECT 'Tax Payment' || CASE WHEN agency_name <> '' THEN ' - ' || agency_name ELSE '' END FROM liability_payments WHERE id = ?`, ref.ID).Scan(&s)
	case EntityAdjustment:
		c.DB.QueryRowContext(ctx, `SELECT 'Tax Balance Adjustment - ' || IFNULL(e.display_name, 'Company') FROM liability_adjustments a LEFT JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`, ref.ID).Scan(&s)
	case EntityEmployee:
		c.DB.QueryRowContext(ctx, `SELECT 'Employee - ' || display_name FROM employees WHERE id = ?`, ref.ID).Scan(&s)
	}
	return s
}

// ---------------------------------------------------------------------------
// Unpost

func unpost(c *httpx.Ctx, entity string, id int64, mode string, opt books.Options) error {
	table := tableOf(entity)
	if table == "" {
		return apperr.BadRequest("unknown payroll record type %q", entity)
	}
	if mode != "void" && mode != "delete" {
		return apperr.BadRequest("unknown unpost mode %q (void or delete)", mode)
	}
	c = detached(c)
	unlock := lockRecord(c.Context(), c.CompanyID, entity, id)
	defer unlock()
	ctx := c.Context()
	var txn sql.NullInt64
	err := c.DB.QueryRowContext(ctx, `SELECT books_txn_id FROM `+table+` WHERE id = ?`, id).Scan(&txn)
	if errors.Is(err, sql.ErrNoRows) {
		return notFoundErr(entity)
	}
	if err != nil {
		return err
	}
	if !txn.Valid {
		return nil
	}
	s := books.S(c)
	cur, own, err := ownTxn(ctx, s, entity, id, txn.Int64)
	if err != nil {
		return books.ToAppErr(err)
	}
	if !own {
		// already removed in Books (its id may even belong to another transaction now): nothing left to undo
		return setSync(c, table, id, statusNone, "", nil, true)
	}
	switch {
	case mode == "delete":
		err = books.Default.DeleteTxn(ctx, s, cur.ID, opt)
	case !cur.Voided:
		_, err = books.Default.VoidTxn(ctx, s, cur.ID, opt)
	}
	gone := mode == "delete"
	if err != nil {
		if !books.IsNotFound(err) {
			return books.ToAppErr(err)
		}
		gone = true
	}
	if gone {
		return setSync(c, table, id, statusNone, "", nil, true)
	}
	return setSync(c, table, id, statusPosted, "", nil, false)
}
