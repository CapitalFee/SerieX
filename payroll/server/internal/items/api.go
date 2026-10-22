// Package items serves the payroll items (Payroll Items window) and creates
// the default payroll items of a company.
//
// The payroll, setup, liabilities, forms and reports packages call the
// exported functions of this file.
package items

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the payroll item routes.
func Register(rt *httpx.Router) { registerRoutes(rt) }

// All loads every payroll item (active and inactive) keyed by id, with the
// (ro) fields Category and EffectiveGroup filled in (Books names are not).
func All(ctx context.Context, q store.Q) (map[int64]*model.PayrollItem, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+itemCols+` FROM payroll_items`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]*model.PayrollItem{}
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out[it.ID] = it
	}
	return out, rows.Err()
}

// Get loads one payroll item (store.ErrNotFound style: sql.ErrNoRows when missing).
func Get(ctx context.Context, q store.Q, id int64) (*model.PayrollItem, error) {
	return scanItem(q.QueryRowContext(ctx, `SELECT `+itemCols+` FROM payroll_items WHERE id = ?`, id))
}

// FindTax returns the active item with a tax code (and state, and program key
// for ST_EE/ST_ER) or nil when the company has none.
func FindTax(ctx context.Context, q store.Q, taxCode, state, taxKey string) (*model.PayrollItem, error) {
	query := `SELECT ` + itemCols + ` FROM payroll_items WHERE active = 1 AND tax_code = ?`
	args := []any{taxCode}
	if isStateCode(taxCode) {
		query += ` AND state = ? COLLATE NOCASE`
		args = append(args, strings.ToUpper(strings.TrimSpace(state)))
	}
	if taxCode == model.TaxStateEE || taxCode == model.TaxStateER {
		query += ` AND tax_key = ? COLLATE NOCASE`
		args = append(args, strings.TrimSpace(taxKey))
	}
	query += ` ORDER BY id LIMIT 1`
	it, err := scanItem(q.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return it, err
}

// DefaultRefs are the SerieX Books accounts and vendors the default items point to.
type DefaultRefs struct {
	WagesExpense    *int64 // Payroll Expenses:Wages
	TaxesExpense    *int64 // Payroll Expenses:Payroll Taxes
	BenefitsExpense *int64 // Payroll Expenses:Benefits
	ReimbExpense    *int64 // Payroll Expenses:Reimbursements

	FederalLiab    *int64 // Payroll Liabilities:Federal Taxes (941)
	FUTALiab       *int64 // Payroll Liabilities:Federal Unemployment (940)
	StateWHLiab    *int64 // Payroll Liabilities:State Withholding
	StateUILiab    *int64 // Payroll Liabilities:State Unemployment & Disability
	LocalLiab      *int64 // Payroll Liabilities:Local Taxes
	RetirementLiab *int64 // Payroll Liabilities:Retirement Plans
	HealthLiab     *int64 // Payroll Liabilities:Health & Benefits
	OtherLiab      *int64 // Payroll Liabilities:Other Deductions

	IRSVendor     *int64 // United States Treasury
	StateWHVendor *int64 // state withholding agency
	StateUIVendor *int64 // state unemployment agency
}

// CreateDefaults adds the default payroll items that do not exist yet (by
// name): wages (salary, hourly, overtime 1.5x, double time, sick and vacation
// hourly/salary, holiday, bonus, commission, tips), the federal taxes, the
// taxes of state (withholding, unemployment, and one item per program in the
// state's tax tables for year), and common deductions/contributions
// (401(k), Roth 401(k), Health Insurance (pre-tax), HSA, 401(k) Company Match,
// Mileage Reimbursement). Idempotent.
func CreateDefaults(ctx context.Context, tx *sql.Tx, state string, year int, refs DefaultRefs) error {
	_, err := createDefaults(ctx, tx, state, year, refs)
	return err
}
