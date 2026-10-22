// Package posting keeps SerieX Books in step with payroll: it creates, updates,
// voids and deletes the Books transactions of paychecks (CHK), liability
// payments (CHK) and liability adjustments (GENJRNL), creates the employees'
// Books "other" names, verifies payroll against Books and caches Books lookups
// (account / vendor / class / job names) for display.
//
// RULE: never call these functions while holding c.Write (they take the
// company write lock themselves to store the sync state, and they make network
// calls). Save the payroll record first, then post.
//
// Other packages call the exported functions of this file; the
// implementation lives in the other files of the package.
package posting

import (
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
)

// Entity names used in sync records.
const (
	EntityPaycheck   = "paycheck"
	EntityPayment    = "liability_payment"
	EntityAdjustment = "adjustment"
	EntityEmployee   = "employee"
)

// PostPaycheck creates (books_txn_id NULL) or replaces (PUT) the Books check of
// a paycheck and stores sync_status/sync_error/synced_at/books_txn_id. Books
// problems are stored on the paycheck and returned as a *model.SyncProblem
// (nil when posted, or when nothing has to be posted: kind ytd, voided before
// posting, prefs.postToBooks off -> sync_status 'none'). err is only returned
// for local failures.
func PostPaycheck(c *httpx.Ctx, id int64, opt books.Options) (*model.SyncProblem, error) {
	_, p, err := post(c, EntityPaycheck, id, opt)
	return p, err
}

// PostLiabilityPayment does the same for a liability payment (kind prior -> 'none').
func PostLiabilityPayment(c *httpx.Ctx, id int64, opt books.Options) (*model.SyncProblem, error) {
	_, p, err := post(c, EntityPayment, id, opt)
	return p, err
}

// PostAdjustment does the same for a liability adjustment (affectsAccounts false -> 'none').
func PostAdjustment(c *httpx.Ctx, id int64, opt books.Options) (*model.SyncProblem, error) {
	_, p, err := post(c, EntityAdjustment, id, opt)
	return p, err
}

// Retry posts the given records again (all pending/error records when refs is empty).
func Retry(c *httpx.Ctx, refs []model.SyncRef, opt books.Options) (model.RetryResult, error) {
	return retry(c, refs, opt)
}

// Unpost voids (mode "void") or deletes (mode "delete") the Books transaction of
// a record BEFORE the payroll record is voided/deleted. Records never posted
// (books_txn_id NULL) return nil. Books errors are returned converted with
// books.ToAppErr so the client can answer confirm / closing date questions and
// re-send the request; the caller must then abort its own change.
func Unpost(c *httpx.Ctx, entity string, id int64, mode string, opt books.Options) error {
	return unpost(c, entity, id, mode, opt)
}

// WithRecordLock runs fn while holding the posting lock of a record: a posting
// of the record already running (a Books Sync retry, a re-post after an edit)
// finishes first, and no other posting of it starts before fn returns. Post*,
// Unpost and Retry called with the *httpx.Ctx passed to fn do not wait for the
// lock again. Void/delete routes unpost and change the payroll record inside
// fn, so a retry can never post the record again in between.
func WithRecordLock(c *httpx.Ctx, entity string, id int64, fn func(c *httpx.Ctx) error) error {
	return withRecordLock(c, entity, id, fn)
}

// EnsureEmployeeName creates or updates the employee's Books "other" name
// (name = display name, address, phone, email; inactive when the employee is
// inactive) and stores employees.books_name_id. Returns the Books name id.
// Books problems are returned as errors (books.ToAppErr) but the employee
// record itself is never rolled back by this function.
func EnsureEmployeeName(c *httpx.Ctx, employeeID int64) (int64, error) {
	return ensureEmployeeName(c, employeeID)
}

// Verify compares every posted record dated from..to with its Books transaction
// and the payroll liability balances with the Books liability account balances.
func Verify(c *httpx.Ctx, from, to string) (model.VerifyResult, error) {
	return verify(c, from, to)
}

// Lookups are Books names for display (empty maps when Books is unreachable).
type Lookups struct {
	Accounts map[int64]books.Account
	Vendors  map[int64]books.Name
	Others   map[int64]books.Name
	Jobs     map[int64]books.Name // customers and jobs (FullName "Customer:Job")
	Classes  map[int64]books.ListEntry
	OK       bool // false when Books could not be read
}

// Lookup returns the cached Books lookups of the request's company (refreshed
// after 30 seconds, or immediately after Invalidate).
func Lookup(c *httpx.Ctx) *Lookups {
	return lookup(c)
}

// Invalidate drops the cached lookups of a company (after creating accounts/vendors).
func Invalidate(companyID string) {
	invalidate(companyID)
}
