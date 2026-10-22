// Package payroll calculates and stores paychecks: Pay Employees (scheduled,
// unscheduled and termination payrolls), paycheck preview/detail, edit, void,
// delete, Enter Year-to-Date Amounts, pay stubs and printing.
//
//	calc.go    the paycheck calculation
//	ytd.go     year-to-date amounts and wage bases of an employee
//	store.go   paycheck rows, lines and lists
//	run.go     payrolls of the pay schedules, Pay Employees defaults, Create Paychecks
//	routes.go  paycheck routes (calculate, single paycheck, edit, void, delete, printing)
//	stubs.go   pay stubs and the amount in words
package payroll

import (
	"context"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the payroll routes.
func Register(rt *httpx.Router) { registerRoutes(rt) }

// Calculate computes a paycheck from its input without saving it.
// Used by /paychecks/calculate, payroll creation and edits.
// Every non-manual line is calculated (Recalculate = false is honored by the
// edit routes, which keep the amounts sent).
func Calculate(ctx context.Context, q store.Q, in *model.PaycheckInput) (*model.Paycheck, error) {
	r, err := calculate(ctx, q, nil, in, calcOpts{})
	if err != nil {
		return nil, err
	}
	return r.pc, nil
}

// Get loads a saved paycheck with its lines, summaries and YTD columns.
func Get(ctx context.Context, q store.Q, id int64) (*model.Paycheck, error) {
	return get(ctx, q, id)
}
