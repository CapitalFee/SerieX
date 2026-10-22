// Package banking serves reconciliation, cleared status, bank feeds
// (OFX / QFX / QBO / CSV import, matching, adding) and bank rules.
package banking

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Register adds the banking routes.
func Register(rt *httpx.Router) {
	rt.C("GET", "/reconcile/{accountId}", reconcileStart)
	rt.C("PUT", "/reconcile/{accountId}/draft", reconcileSaveDraft)
	rt.C("POST", "/reconcile/{accountId}/finish", reconcileFinish)
	rt.C("POST", "/reconcile/{accountId}/undo-last", reconcileUndoLast)
	rt.C("GET", "/reconcile/{accountId}/discrepancies", reconcileDiscrepancies)
	rt.C("GET", "/reconciliations", listReconciliations)
	rt.C("GET", "/reconciliations/{id}/report", reconcileReport)
	rt.C("PUT", "/gl/{id}/cleared", setCleared)

	rt.C("GET", "/bank-feeds/accounts", feedAccounts)
	rt.C("POST", "/bank-feeds/{accountId}/import", feedImport)
	rt.C("GET", "/bank-feeds/{accountId}/items", feedItems)
	rt.C("POST", "/bank-feed-items/{id}/add", feedAdd)
	rt.C("POST", "/bank-feed-items/{id}/match", feedMatch)
	rt.C("POST", "/bank-feed-items/{id}/ignore", feedIgnore)
	rt.C("POST", "/bank-feed-items/{id}/undo", feedUndo)

	rt.C("GET", "/bank-rules", listRules)
	rt.C("POST", "/bank-rules", createRule)
	rt.C("PUT", "/bank-rules/{id}", updateRule)
	rt.C("DELETE", "/bank-rules/{id}", deleteRule)
}

// acct is the part of an account the banking code needs.
type acct struct {
	ID       int64
	Name     string
	FullName string
	Type     string
	Special  string
	Active   bool
}

func getAcct(ctx context.Context, q store.Q, id int64) (acct, error) {
	a := acct{ID: id}
	err := q.QueryRowContext(ctx, `SELECT name, type, special, active FROM accounts WHERE id = ?`, id).Scan(&a.Name, &a.Type, &a.Special, &a.Active)
	if errors.Is(err, sql.ErrNoRows) {
		return a, apperr.NotFound("Account not found.")
	}
	if err != nil {
		return a, err
	}
	a.FullName = store.FullName(ctx, q, "accounts", id)
	if a.FullName == "" {
		a.FullName = a.Name
	}
	return a, nil
}

// natural converts a signed ledger amount (+ debit) to the account's natural
// sign: positive increases the normal balance (deposits for a bank, charges
// for a credit card).
func natural(cents int64, acctType string) int64 {
	if model.IsDebitNormal(acctType) {
		return cents
	}
	return -cents
}

// signed converts a natural-sign amount back to a ledger amount (+ debit).
func signed(nat int64, acctType string) int64 { return natural(nat, acctType) }

// typeLabel is the report name of a transaction type; bill payments drawn on a
// credit card read "Bill Pmt -CCard".
func typeLabel(typ, headerAcctType string) string {
	if typ == model.TxBillPayment && headerAcctType == model.AcctCreditCard {
		return "Bill Pmt -CCard"
	}
	if l, ok := model.TxnTypeLabels[typ]; ok {
		return l
	}
	return typ
}

func saveOpts(c *httpx.Ctx) ledger.SaveOptions {
	return ledger.Options(c)
}

// loadAccountModel returns the full model.Account (balances in natural sign, all dates).
func loadAccountModel(ctx context.Context, q store.Q, id int64) (model.Account, error) {
	var a model.Account
	var parent sql.NullInt64
	err := q.QueryRowContext(ctx, `SELECT id, name, number, type, parent_id, description, note, bank_acct_number,
		routing_number, tax_line, special, active FROM accounts WHERE id = ?`, id).Scan(&a.ID, &a.Name, &a.Number, &a.Type,
		&parent, &a.Description, &a.Note, &a.BankAcctNumber, &a.RoutingNumber, &a.TaxLine, &a.Special, &a.Active)
	if errors.Is(err, sql.ErrNoRows) {
		return a, apperr.NotFound("Account not found.")
	}
	if err != nil {
		return a, err
	}
	a.ParentID = store.PtrID(parent)
	a.FullName = store.FullName(ctx, q, "accounts", id)
	if a.FullName == "" {
		a.FullName = a.Name
	}
	a.Level = strings.Count(a.FullName, ":")
	ids, err := store.Descendants(ctx, q, "accounts", id)
	if err != nil {
		return a, err
	}
	var own, total int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount), 0) FROM gl_entries WHERE account_id = ?`, id).Scan(&own); err != nil {
		return a, err
	}
	total = own
	for _, d := range ids {
		if d == id {
			continue
		}
		var s int64
		if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount), 0) FROM gl_entries WHERE account_id = ?`, d).Scan(&s); err != nil {
			return a, err
		}
		total += s
	}
	if model.IsBalanceSheet(a.Type) {
		a.OwnBalance = store.Dollars(natural(own, a.Type))
		a.Balance = store.Dollars(natural(total, a.Type))
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM gl_entries WHERE account_id = ?)
		OR EXISTS(SELECT 1 FROM txns WHERE account_id = ? OR ar_ap_account_id = ? OR to_account_id = ?)`, id, id, id, id).Scan(&n); err != nil {
		return a, err
	}
	a.HasTxns = n > 0
	return a, nil
}

func nameMap(ctx context.Context, q store.Q) (map[int64]string, error) {
	return store.FullNames(ctx, q, "names")
}
