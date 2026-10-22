// Package liabilities serves payroll liabilities: balances, scheduled
// liabilities with due dates, liability payments (tax payments), earlier
// tax payments, adjustments and payment schedules.
//
// SerieX Books postings (tax payments, adjustment journal entries) are made
// by package posting after the payroll record is saved; void and delete call
// posting.Unpost first and abort when Books refuses.
package liabilities

import (
	"context"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Register adds the liability routes.
func Register(rt *httpx.Router) {
	rt.C("GET", "/liabilities/due", dueRoute)
	rt.C("GET", "/liabilities/balances", balancesRoute)

	rt.C("GET", "/payment-schedules", getSchedulesRoute)
	rt.C("PUT", "/payment-schedules", putSchedulesRoute)

	rt.C("GET", "/liability-payments", listPaymentsRoute)
	rt.C("POST", "/liability-payments", func(c *httpx.Ctx) error { return savePaymentRoute(c, 0) })
	rt.C("POST", "/liability-payments/from-due", fromDueRoute)
	rt.C("GET", "/liability-payments/{id}", getPaymentRoute)
	rt.C("PUT", "/liability-payments/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return savePaymentRoute(c, id)
	})
	rt.C("DELETE", "/liability-payments/{id}", deletePaymentRoute)
	rt.C("POST", "/liability-payments/{id}/void", voidPaymentRoute)

	rt.C("GET", "/liability-adjustments", listAdjustmentsRoute)
	rt.C("POST", "/liability-adjustments", func(c *httpx.Ctx) error { return saveAdjustmentRoute(c, 0) })
	rt.C("GET", "/liability-adjustments/{id}", getAdjustmentRoute)
	rt.C("PUT", "/liability-adjustments/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return saveAdjustmentRoute(c, id)
	})
	rt.C("DELETE", "/liability-adjustments/{id}", deleteAdjustmentRoute)
}

// Balances returns the liability balance of every item for paychecks,
// adjustments (by effective date) and payments (by period end) dated from..to.
func Balances(ctx context.Context, q store.Q, from, to string) ([]model.LiabilityBalance, error) {
	return balances(ctx, q, from, to)
}

// DueDate returns the due date of a payment group's liability for the period
// ending on periodEnd (federal_941 semiweekly uses the check date as periodEnd).
// Weekends and legal holidays move the date to the next business day. The
// Form 940 $500 carry-forward rule needs the amounts and is applied by the
// scheduled liabilities list, not here.
func DueDate(group, frequency, periodEnd string) string {
	t, err := store.ParseDate(periodEnd)
	if err != nil {
		return ""
	}
	if frequency == "" {
		frequency, _ = defaultSchedule(group, model.PayFreqMonthly)
	}
	return dueDate(group, frequency, t).Format("2006-01-02")
}
