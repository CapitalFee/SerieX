// Package ledger stores transactions and posts them to the general ledger.
//
// The exported functions in this file are the contract other packages
// (lists, banking, company, sample data) code against. The transaction engine
// lives in the core_*.go files; the query routes in the q_*.go files.
package ledger

import (
	"context"
	"database/sql"

	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// SaveOptions carries the request context for a save/delete/void.
type SaveOptions struct {
	User            string
	Force           bool            // the user answered Yes to every apperr.Confirm question
	Accept          map[string]bool // warning kinds (apperr.Warn*) the user answered Yes to
	ClosingPassword string          // closing date password typed by the user
}

// Accepts reports whether the user answered Yes to questions of kind.
func (o SaveOptions) Accepts(kind string) bool { return o.Force || o.Accept[kind] }

// Options returns the SaveOptions of a request: user, ?force=1, ?accept=...
// (or header X-Accept) and the X-Closing-Password header.
func Options(c *httpx.Ctx) SaveOptions {
	return SaveOptions{User: c.User, Force: c.Force(), Accept: c.Accepted(), ClosingPassword: c.ClosingPassword()}
}

// Save validates, stores and posts a transaction. t.ID == 0 creates a new
// transaction, otherwise the existing one is replaced (lines, links, ledger
// entries and inventory are rebuilt). Returns the transaction id. Computed
// fields of t (amount for sales forms, tax, open balance...) are filled in.
// On error the caller must roll the transaction back.
func Save(ctx context.Context, tx *sql.Tx, t *model.Txn, opt SaveOptions) (int64, error) {
	return saveTxn(ctx, tx, t, opt)
}

// Get loads a full transaction (lines, links, linked transactions).
func Get(ctx context.Context, q store.Q, id int64) (*model.Txn, error) {
	return getTxn(ctx, q, id)
}

// Delete removes a transaction and everything it posted.
func Delete(ctx context.Context, tx *sql.Tx, id int64, opt SaveOptions) error {
	return deleteTxn(ctx, tx, id, opt)
}

// Void zeroes a transaction's amounts but keeps it (memo gets "VOID: ").
func Void(ctx context.Context, tx *sql.Tx, id int64, opt SaveOptions) error {
	return voidTxn(ctx, tx, id, opt)
}

// Rebuild recomputes derived data for the whole company file: ledger entries
// of every transaction, open balances, inventory quantities/average costs and
// purchase order received quantities.
func Rebuild(ctx context.Context, tx *sql.Tx) error {
	return rebuildAll(ctx, tx)
}

// Register adds the transaction routes.
func Register(rt *httpx.Router) {
	registerTxnRoutes(rt)
	registerQueryRoutes(rt)
}
