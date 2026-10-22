// Package employees serves employees (Employee Center, New/Edit Employee),
// employee defaults, paid time off and pay schedules.
//
// The payroll, forms and reports packages call the exported functions of
// this file.
package employees

import (
	"context"
	"database/sql"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the employee, employee defaults, PTO and pay schedule routes.
func Register(rt *httpx.Router) {
	registerEmployeeRoutes(rt)
	registerPTORoutes(rt)
	registerDefaultsRoutes(rt)
	registerScheduleRoutes(rt)
}

// Load returns one employee with its items. SSN and direct deposit numbers are
// returned UNMASKED when reveal is true (server-side use: forms, pay stubs) and
// masked otherwise.
func Load(ctx context.Context, q store.Q, id int64, reveal bool) (*model.Employee, error) {
	list, err := loadEmployees(ctx, q, id, reveal, store.Today())
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, sql.ErrNoRows
	}
	return list[0], nil
}

// PTOBalance returns the sick or vacation hours available on asOf (after
// every paycheck dated on or before asOf except excludePaycheckID, plus
// pto_adjustments; beginning_of_year accruals and yearly resets applied), and
// the hours accrued and used in the calendar year of asOf.
func PTOBalance(ctx context.Context, q store.Q, employeeID int64, kind, asOf string, excludePaycheckID int64) (available, accruedYTD, usedYTD float64, err error) {
	if kind != "sick" && kind != "vacation" {
		return 0, 0, 0, errBadPTOKind
	}
	if !store.ValidDate(asOf) {
		asOf = store.Today()
	}
	var hire, sick, vac string
	err = q.QueryRowContext(ctx, `SELECT hire_date, sick, vacation FROM employees WHERE id = ?`, employeeID).Scan(&hire, &sick, &vac)
	if err != nil {
		return 0, 0, 0, err
	}
	data, err := loadPTOData(ctx, q, employeeID, asOf, excludePaycheckID)
	if err != nil {
		return 0, 0, 0, err
	}
	raw := sick
	if kind == "vacation" {
		raw = vac
	}
	set := parsePTO(raw)
	var events []ptoEvent
	if d := data[employeeID]; d != nil {
		events = d.events(kind)
	}
	available, accruedYTD, usedYTD = computePTO(set, hire, events, asOf, ptoFloor(ctx, q))
	return available, accruedYTD, usedYTD, nil
}

// NextPeriod returns the period start/end and check date that follow a
// schedule's current next period (used to advance it after a payroll).
func NextPeriod(s *model.PaySchedule) (periodStart, periodEnd, checkDate string) {
	return nextPeriod(s)
}

// PeriodStart returns the first day of the pay period that ends on periodEnd.
func PeriodStart(frequency, periodEnd string, semiFirstDay int) string {
	return periodStart(frequency, periodEnd, semiFirstDay)
}
