package items

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

const itemCols = `id, name, type, tax_code, state, tax_key, pto, calc, rate, annual_limit, limit_kind,
	match_item_id, match_cap_pct, tax_tracking, w2_box12, w2_box14, taxability, supplemental, not_paid,
	expense_account_id, liability_account_id, agency_vendor_id, payment_group, active`

type scanner interface {
	Scan(dest ...any) error
}

func scanItem(s scanner) (*model.PayrollItem, error) {
	it := &model.PayrollItem{}
	var limit, match, exp, liab, agency sql.NullInt64
	var taxability string
	var supp, notPaid, active int
	err := s.Scan(&it.ID, &it.Name, &it.Type, &it.TaxCode, &it.State, &it.TaxKey, &it.Pto, &it.Calc, &it.Rate, &limit, &it.LimitKind,
		&match, &it.MatchCapPct, &it.TaxTracking, &it.W2Box12, &it.W2Box14, &taxability, &supp, &notPaid,
		&exp, &liab, &agency, &it.PaymentGroup, &active)
	if err != nil {
		return nil, err
	}
	if limit.Valid {
		v := store.Dollars(limit.Int64)
		it.AnnualLimit = &v
	}
	it.MatchItemID = store.PtrID(match)
	it.ExpenseAccountID = store.PtrID(exp)
	it.LiabilityAccountID = store.PtrID(liab)
	it.AgencyVendorID = store.PtrID(agency)
	it.Supplemental = supp == 1
	it.NotPaid = notPaid == 1
	it.Active = active == 1
	it.Taxability = map[string]bool{}
	if taxability != "" {
		json.Unmarshal([]byte(taxability), &it.Taxability)
		if it.Taxability == nil {
			it.Taxability = map[string]bool{}
		}
	}
	fillRO(it)
	return it, nil
}

// fillRO sets the computed fields that do not need SerieX Books.
func fillRO(it *model.PayrollItem) {
	it.Category = model.ItemCategory(it.Type, it.TaxCode)
	it.EffectiveGroup = it.PaymentGroup
	if it.EffectiveGroup == "" {
		it.EffectiveGroup = model.DefaultPaymentGroup(it)
	}
}

func limitCents(f *float64) any {
	if f == nil {
		return nil
	}
	return store.Cents(*f)
}

// taxabilityJSON stores only the known wage base keys that are true.
func taxabilityJSON(m map[string]bool) string {
	out := map[string]bool{}
	for _, b := range model.WageBases {
		if m[b] {
			out[b] = true
		}
	}
	return store.JSONText(out)
}

func insertItem(ctx context.Context, tx *sql.Tx, it *model.PayrollItem) (int64, error) {
	now := store.Now()
	res, err := tx.ExecContext(ctx, `INSERT INTO payroll_items(name, type, tax_code, state, tax_key, pto, calc, rate, annual_limit, limit_kind,
		match_item_id, match_cap_pct, tax_tracking, w2_box12, w2_box14, taxability, supplemental, not_paid,
		expense_account_id, liability_account_id, agency_vendor_id, payment_group, active, created_at, updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		it.Name, it.Type, it.TaxCode, it.State, it.TaxKey, it.Pto, it.Calc, it.Rate, limitCents(it.AnnualLimit), it.LimitKind,
		store.NullID(it.MatchItemID), it.MatchCapPct, it.TaxTracking, it.W2Box12, it.W2Box14, taxabilityJSON(it.Taxability),
		store.B(it.Supplemental), store.B(it.NotPaid), store.NullID(it.ExpenseAccountID), store.NullID(it.LiabilityAccountID),
		store.NullID(it.AgencyVendorID), it.PaymentGroup, store.B(it.Active), now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func updateItem(ctx context.Context, tx *sql.Tx, it *model.PayrollItem) error {
	_, err := tx.ExecContext(ctx, `UPDATE payroll_items SET name = ?, type = ?, tax_code = ?, state = ?, tax_key = ?, pto = ?, calc = ?,
		rate = ?, annual_limit = ?, limit_kind = ?, match_item_id = ?, match_cap_pct = ?, tax_tracking = ?, w2_box12 = ?, w2_box14 = ?,
		taxability = ?, supplemental = ?, not_paid = ?, expense_account_id = ?, liability_account_id = ?, agency_vendor_id = ?,
		payment_group = ?, active = ?, updated_at = ? WHERE id = ?`,
		it.Name, it.Type, it.TaxCode, it.State, it.TaxKey, it.Pto, it.Calc, it.Rate, limitCents(it.AnnualLimit), it.LimitKind,
		store.NullID(it.MatchItemID), it.MatchCapPct, it.TaxTracking, it.W2Box12, it.W2Box14, taxabilityJSON(it.Taxability),
		store.B(it.Supplemental), store.B(it.NotPaid), store.NullID(it.ExpenseAccountID), store.NullID(it.LiabilityAccountID),
		store.NullID(it.AgencyVendorID), it.PaymentGroup, store.B(it.Active), store.Now(), it.ID)
	return err
}

// usedOnPaychecks reports whether paychecks (any kind, voided or not) reference the item.
func usedOnPaychecks(ctx context.Context, q store.Q, id int64) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM paycheck_lines WHERE item_id = ?)`, id).Scan(&n)
	return n == 1, err
}

// itemsOnPaychecks returns the ids of every item used on a paycheck line.
func itemsOnPaychecks(ctx context.Context, q store.Q) (map[int64]bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT item_id FROM paycheck_lines`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

type usageCheck struct{ query, what string }

var txnChecks = []usageCheck{
	{`SELECT EXISTS(SELECT 1 FROM paycheck_lines WHERE item_id = ?)`, "paychecks"},
	{`SELECT EXISTS(SELECT 1 FROM liability_payment_lines WHERE item_id = ?)`, "tax payments"},
	{`SELECT EXISTS(SELECT 1 FROM liability_adjustment_lines WHERE item_id = ?)`, "tax balance adjustments"},
}

var recordChecks = []usageCheck{
	{`SELECT EXISTS(SELECT 1 FROM employee_items WHERE item_id = ?)`, "employee records"},
	{`SELECT EXISTS(SELECT 1 FROM payroll_items WHERE match_item_id = ?)`, "another payroll item (company match)"},
}

func firstUse(ctx context.Context, q store.Q, id int64, checks []usageCheck) (string, error) {
	for _, ch := range checks {
		var n int
		if err := q.QueryRowContext(ctx, ch.query, id).Scan(&n); err != nil {
			return "", err
		}
		if n == 1 {
			return ch.what, nil
		}
	}
	return "", nil
}

// usedInTransactions tells which kind of transaction (paychecks, liability
// payments or adjustments) uses the item ("" when none).
func usedInTransactions(ctx context.Context, q store.Q, id int64) (string, error) {
	return firstUse(ctx, q, id, txnChecks)
}

// usage describes where an item is used (empty when it can be deleted).
func usage(ctx context.Context, q store.Q, id int64) (string, error) {
	if where, err := firstUse(ctx, q, id, append(append([]usageCheck{}, txnChecks...), recordChecks...)); err != nil || where != "" {
		return where, err
	}
	// the employee defaults (meta) may list the item too
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'employee_defaults'`).Scan(&raw)
	if err == nil && raw != "" {
		var d model.EmployeeDefaults
		if json.Unmarshal([]byte(raw), &d) == nil {
			for _, e := range append(append([]model.EmployeeItem{}, d.Earnings...), d.Items...) {
				if e.ItemID == id {
					return "the employee defaults", nil
				}
			}
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	return "", nil
}

func isStateCode(code string) bool {
	switch code {
	case model.TaxSIT, model.TaxSUIER, model.TaxSUIEE, model.TaxStateEE, model.TaxStateER:
		return true
	}
	return false
}

func isFederalCode(code string) bool {
	switch code {
	case model.TaxFIT, model.TaxSSEE, model.TaxSSER, model.TaxMedEE, model.TaxMedER, model.TaxAddlMed, model.TaxFUTA:
		return true
	}
	return false
}

func isLocalCode(code string) bool { return code == model.TaxLocalEE || code == model.TaxLocalER }

// typeRank is the position of an item type in the Payroll Items window.
func typeRank(t string) int {
	for i, x := range model.ItemTypeOrder {
		if x == t {
			return i
		}
	}
	return len(model.ItemTypeOrder)
}

func validType(t string) bool { return typeRank(t) < len(model.ItemTypeOrder) }

func lower(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
