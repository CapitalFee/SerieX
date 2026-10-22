package employees

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

const defaultsKey = "employee_defaults"

func registerDefaultsRoutes(rt *httpx.Router) {
	rt.C("GET", "/employee-defaults", func(c *httpx.Ctx) error {
		d, err := LoadDefaults(c.Context(), c.DB)
		if err != nil {
			return err
		}
		return c.JSON(d)
	})
	rt.C("PUT", "/employee-defaults", func(c *httpx.Ctx) error {
		var d model.EmployeeDefaults
		if err := c.Decode(&d); err != nil {
			return err
		}
		err := c.Write(func(tx *sql.Tx) error {
			if err := validateDefaults(c.Context(), tx, &d); err != nil {
				return err
			}
			if _, err := tx.ExecContext(c.Context(), `INSERT INTO meta(key, value) VALUES(?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`, defaultsKey, defaultsJSON(d)); err != nil {
				return err
			}
			return store.Audit(c.Context(), tx, c.User, "modify", "employee_defaults", 0, "Employee defaults", nil)
		})
		if err != nil {
			return err
		}
		out, err := LoadDefaults(c.Context(), c.DB)
		if err != nil {
			return err
		}
		return c.JSON(out)
	})
}

// LoadDefaults returns the employee defaults (built-in values when never saved):
// the company's primary work state, the first active pay schedule, subject to
// SUI and state disability, no paid time off accrual.
func LoadDefaults(ctx context.Context, q store.Q) (*model.EmployeeDefaults, error) {
	d := &model.EmployeeDefaults{}
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, defaultsKey).Scan(&raw)
	saved := err == nil && raw != ""
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if saved {
		if err := json.Unmarshal([]byte(raw), d); err != nil {
			return nil, err
		}
	} else {
		d.SubjectSUI, d.SubjectSDI = true, true
		var id int64
		var freq string
		if err := q.QueryRowContext(ctx, `SELECT id, frequency FROM pay_schedules WHERE active = 1 ORDER BY id LIMIT 1`).Scan(&id, &freq); err == nil {
			d.PayScheduleID, d.PayFrequency = &id, freq
		} else {
			d.PayFrequency = model.FreqBiweekly
		}
	}
	if d.WorkState == "" {
		q.QueryRowContext(ctx, `SELECT primary_state FROM company WHERE id = 1`).Scan(&d.WorkState)
	}
	normalizePTO(&d.Sick)
	normalizePTO(&d.Vacation)
	if d.Earnings == nil {
		d.Earnings = []model.EmployeeItem{}
	}
	if d.Items == nil {
		d.Items = []model.EmployeeItem{}
	}
	// item names may have changed since the defaults were saved; drop deleted items
	all, err := items.All(ctx, q)
	if err != nil {
		return nil, err
	}
	fill := func(list []model.EmployeeItem) []model.EmployeeItem {
		out := []model.EmployeeItem{}
		for _, it := range list {
			if p := all[it.ItemID]; p != nil {
				it.ItemName, it.ItemType, it.Calc = p.Name, p.Type, p.Calc
				out = append(out, it)
			}
		}
		return out
	}
	d.Earnings, d.Items = fill(d.Earnings), fill(d.Items)
	if d.PayScheduleID != nil {
		var n int
		q.QueryRowContext(ctx, `SELECT COUNT(*) FROM pay_schedules WHERE id = ?`, *d.PayScheduleID).Scan(&n)
		if n == 0 {
			d.PayScheduleID = nil
		}
	}
	return d, nil
}

func defaultsJSON(d model.EmployeeDefaults) string {
	strip := func(list []model.EmployeeItem) []model.EmployeeItem {
		out := make([]model.EmployeeItem, len(list))
		for i, it := range list {
			it.ItemName, it.ItemType, it.Calc = "", "", ""
			out[i] = it
		}
		return out
	}
	d.Earnings, d.Items = strip(d.Earnings), strip(d.Items)
	d.Sick.Available, d.Sick.AccruedYTD, d.Sick.UsedYTD = 0, 0, 0
	d.Vacation.Available, d.Vacation.AccruedYTD, d.Vacation.UsedYTD = 0, 0, 0
	return store.JSONText(d)
}

// validateDefaults checks the employee defaults with the same rules as an
// employee record (items, schedule, state, PTO) except the personal fields.
func validateDefaults(ctx context.Context, tx *sql.Tx, d *model.EmployeeDefaults) error {
	if d.PayScheduleID != nil && *d.PayScheduleID <= 0 {
		d.PayScheduleID = nil
	}
	if d.PayScheduleID != nil {
		var freq string
		err := tx.QueryRowContext(ctx, `SELECT frequency FROM pay_schedules WHERE id = ?`, *d.PayScheduleID).Scan(&freq)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.Validation("payScheduleId", "The pay schedule does not exist.")
		} else if err != nil {
			return err
		}
		d.PayFrequency = freq
	}
	if d.PayFrequency == "" {
		d.PayFrequency = model.FreqBiweekly
	}
	if _, ok := model.PayPeriods[d.PayFrequency]; !ok {
		return apperr.Validation("payFrequency", "Unknown pay frequency %q.", d.PayFrequency)
	}
	d.WorkState = strings.ToUpper(strings.TrimSpace(d.WorkState))
	if d.WorkState != "" {
		st, err := stateTax(d.WorkState)
		if err != nil {
			return apperr.BadRequest("The tax tables could not be loaded: %v", err)
		}
		if st == nil {
			return apperr.Validation("workState", "There are no tax tables for the state %q.", d.WorkState)
		}
	}
	// reuse the employee item rules through a scratch employee
	tmp := &model.Employee{Earnings: d.Earnings, Items: d.Items}
	all, err := items.All(ctx, tx)
	if err != nil {
		return err
	}
	seen := map[int64]bool{}
	for i, list := range [][]model.EmployeeItem{tmp.Earnings, tmp.Items} {
		for j := range list {
			it := &list[j]
			p := all[it.ItemID]
			if p == nil {
				return apperr.Validation("items", "Line %d: the payroll item does not exist.", j+1)
			}
			wage := model.IsWageType(p.Type)
			if (i == 0) != wage {
				if wage {
					return apperr.Validation("items", "%s is a wage item; add it under earnings.", p.Name)
				}
				return apperr.Validation("earnings", "%s is not a wage item.", p.Name)
			}
			if p.Type == model.ItemFederalTax || p.Type == model.ItemStateTax {
				return apperr.Validation("items", "%s is calculated automatically and cannot be added here.", p.Name)
			}
			if seen[p.ID] {
				return apperr.Validation("items", "%s is listed twice.", p.Name)
			}
			seen[p.ID] = true
			if p.Type == model.ItemDeduction {
				if it.Rate < 0 {
					it.Rate = -it.Rate
				}
				if it.AnnualLimit != nil && *it.AnnualLimit < 0 {
					v := -*it.AnnualLimit
					it.AnnualLimit = &v
				}
			}
			if it.Rate < 0 || (it.AnnualLimit != nil && *it.AnnualLimit < 0) || (it.Qty != nil && *it.Qty < 0) {
				return apperr.Validation("items", "%s: amounts cannot be negative.", p.Name)
			}
			if (p.Calc == model.CalcPercent || p.Type == model.ItemOtherTax) && it.Rate > 100 {
				return apperr.Validation("items", "%s: the percent cannot be more than 100.", p.Name)
			}
			if wage {
				it.AnnualLimit = nil
			}
		}
	}
	if err := validatePTO("sick", &d.Sick); err != nil {
		return err
	}
	return validatePTO("vacation", &d.Vacation)
}
