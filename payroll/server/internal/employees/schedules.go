package employees

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// ---------------------------------------------------------------------------
// Pay period math

func isMonthEnd(date string) bool { return date == store.LastDayOfMonth(date) }

func dayOf(date string) int {
	t, err := store.ParseDate(date)
	if err != nil {
		return 0
	}
	return t.Day()
}

func semiDay(d int) int {
	if d < 1 || d > 27 {
		return 15
	}
	return d
}

// withDay returns the date in the month of date with the given day (clamped to the month length).
func withDay(date string, day int) string {
	first := date[:8] + "01"
	last := dayOf(store.LastDayOfMonth(first))
	if day > last {
		day = last
	}
	return fmt.Sprintf("%s%02d", date[:8], day)
}

// addBusinessDays moves n business days (Monday-Friday) forward (n > 0) or back (n < 0).
func addBusinessDays(date string, n int) string {
	step := 1
	if n < 0 {
		step, n = -1, -n
	}
	for n > 0 {
		date = store.AddDays(date, step)
		if wd := store.Weekday(date); wd != time.Saturday && wd != time.Sunday {
			n--
		}
	}
	return date
}

// monthsOf is the length in months of the monthly-based frequencies.
func monthsOf(freq string) int {
	switch freq {
	case model.FreqMonthly:
		return 1
	case model.FreqQuarterly:
		return 3
	case model.FreqSemiannually:
		return 6
	case model.FreqAnnually:
		return 12
	}
	return 0
}

// nextPeriodEnd returns the end of the period that follows the one ending on end.
func nextPeriodEnd(freq, end string, semiFirst int) string {
	switch freq {
	case model.FreqWeekly:
		return store.AddDays(end, 7)
	case model.FreqBiweekly:
		return store.AddDays(end, 14)
	case model.FreqDaily:
		return addBusinessDays(end, 1)
	case model.FreqSemimonthly:
		sd := semiDay(semiFirst)
		if dayOf(end) < sd {
			return withDay(end, sd)
		}
		if !isMonthEnd(end) {
			return store.LastDayOfMonth(end) // first period of the month ended on SemiFirstDay
		}
		return withDay(store.AddMonths(end[:8]+"01", 1), sd)
	}
	if n := monthsOf(freq); n > 0 {
		if isMonthEnd(end) {
			return store.LastDayOfMonth(store.AddMonths(end[:8]+"01", n))
		}
		return store.AddMonths(end, n)
	}
	return store.AddDays(end, 14)
}

// prevPeriodEnd returns the end of the period before the one ending on end.
func prevPeriodEnd(freq, end string, semiFirst int) string {
	switch freq {
	case model.FreqWeekly:
		return store.AddDays(end, -7)
	case model.FreqBiweekly:
		return store.AddDays(end, -14)
	case model.FreqDaily:
		return addBusinessDays(end, -1)
	case model.FreqSemimonthly:
		sd := semiDay(semiFirst)
		if dayOf(end) > sd {
			return withDay(end, sd) // second period: the first one ended on SemiFirstDay
		}
		return store.AddDays(end[:8]+"01", -1) // first period: last day of the previous month
	}
	if n := monthsOf(freq); n > 0 {
		if isMonthEnd(end) {
			return store.LastDayOfMonth(store.AddMonths(end[:8]+"01", -n))
		}
		return store.AddMonths(end, -n)
	}
	return store.AddDays(end, -14)
}

// periodStart = previous period end + 1 day.
func periodStart(freq, end string, semiFirst int) string {
	if !store.ValidDate(end) {
		return ""
	}
	return store.AddDays(prevPeriodEnd(freq, end, semiFirst), 1)
}

// nextPeriod advances a schedule by one period; the check date keeps its
// offset in days from the period end.
func nextPeriod(s *model.PaySchedule) (string, string, string) {
	if s == nil || !store.ValidDate(s.NextPeriodEnd) {
		return "", "", ""
	}
	end := nextPeriodEnd(s.Frequency, s.NextPeriodEnd, s.SemiFirstDay)
	check := end
	if store.ValidDate(s.NextCheckDate) {
		check = store.AddDays(end, store.DaysBetween(s.NextPeriodEnd, s.NextCheckDate))
	}
	return store.AddDays(s.NextPeriodEnd, 1), end, check
}

// ---------------------------------------------------------------------------
// Pay schedules (Pay Schedule List)

func registerScheduleRoutes(rt *httpx.Router) {
	rt.C("GET", "/pay-schedules", func(c *httpx.Ctx) error {
		mode, err := activeMode(c.Q("active"))
		if err != nil {
			return err
		}
		all, err := loadSchedules(c.Context(), c.DB, 0)
		if err != nil {
			return err
		}
		out := []model.PaySchedule{}
		for _, s := range all {
			if keepActive(mode, s.Active) {
				out = append(out, s)
			}
		}
		return c.JSON(out)
	})
	rt.C("GET", "/pay-schedules/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return writeSchedule(c, id)
	})
	rt.C("POST", "/pay-schedules", func(c *httpx.Ctx) error { return saveSchedule(c, 0) })
	rt.C("PUT", "/pay-schedules/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return saveSchedule(c, id)
	})
	// Assign the schedule to every active employee paid at its frequency who
	// has no schedule yet (the question asked after saving a new schedule).
	rt.C("POST", "/pay-schedules/{id}/assign", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		assigned := int64(0)
		err = c.Write(func(tx *sql.Tx) error {
			list, err := loadSchedules(c.Context(), tx, id)
			if err != nil {
				return err
			}
			if len(list) == 0 {
				return apperr.NotFound("Pay schedule not found.")
			}
			res, err := tx.ExecContext(c.Context(), `UPDATE employees SET pay_schedule_id = ?, updated_at = ?
				WHERE pay_schedule_id IS NULL AND active = 1 AND pay_frequency = ?`, id, store.Now(), list[0].Frequency)
			if err != nil {
				return err
			}
			assigned, _ = res.RowsAffected()
			if assigned == 0 {
				return nil
			}
			return store.Audit(c.Context(), tx, c.User, "modify", "pay_schedule", id,
				fmt.Sprintf("Pay schedule %s assigned to %d employee(s)", list[0].Name, assigned), nil)
		})
		if err != nil {
			return err
		}
		return c.JSON(map[string]any{"assigned": assigned})
	})
	rt.C("DELETE", "/pay-schedules/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		err = c.Write(func(tx *sql.Tx) error {
			list, err := loadSchedules(c.Context(), tx, id)
			if err != nil {
				return err
			}
			if len(list) == 0 {
				return apperr.NotFound("Pay schedule not found.")
			}
			var n int
			if err := tx.QueryRowContext(c.Context(), `SELECT COUNT(*) FROM employees WHERE pay_schedule_id = ?`, id).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				return apperr.Conflict("The pay schedule %q is assigned to %d employee(s). Assign them another schedule (or none) before deleting it.", list[0].Name, n)
			}
			if _, err := tx.ExecContext(c.Context(), `DELETE FROM pay_schedules WHERE id = ?`, id); err != nil {
				return err
			}
			return store.Audit(c.Context(), tx, c.User, "delete", "pay_schedule", id, "Pay schedule "+list[0].Name, list[0])
		})
		if err != nil {
			return err
		}
		return c.NoContent()
	})
}

// loadSchedules loads one schedule (id > 0) or all of them, sorted by name.
func loadSchedules(ctx context.Context, q store.Q, id int64) ([]model.PaySchedule, error) {
	query := `SELECT s.id, s.name, s.frequency, s.next_period_end, s.next_check_date, s.semi_first_day, s.active,
		(SELECT COUNT(*) FROM employees e WHERE e.pay_schedule_id = s.id AND e.active = 1)
		FROM pay_schedules s`
	var args []any
	if id > 0 {
		query += ` WHERE s.id = ?`
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.PaySchedule{}
	for rows.Next() {
		var s model.PaySchedule
		var active int
		if err := rows.Scan(&s.ID, &s.Name, &s.Frequency, &s.NextPeriodEnd, &s.NextCheckDate, &s.SemiFirstDay, &active, &s.EmployeeCount); err != nil {
			return nil, err
		}
		s.Active = active == 1
		s.NextPeriodStart = periodStart(s.Frequency, s.NextPeriodEnd, s.SemiFirstDay)
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	return out, nil
}

func writeSchedule(c *httpx.Ctx, id int64) error {
	list, err := loadSchedules(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	if len(list) == 0 {
		return apperr.NotFound("Pay schedule not found.")
	}
	return c.JSON(list[0])
}

func validateSchedule(s *model.PaySchedule) error {
	s.Name = strings.TrimSpace(s.Name)
	s.Frequency = strings.ToLower(strings.TrimSpace(s.Frequency))
	s.NextPeriodEnd = strings.TrimSpace(s.NextPeriodEnd)
	s.NextCheckDate = strings.TrimSpace(s.NextCheckDate)
	if s.Name == "" {
		return apperr.Validation("name", "Enter a name for the pay schedule.")
	}
	if len(s.Name) > 60 {
		return apperr.Validation("name", "The pay schedule name is too long (60 characters at most).")
	}
	if _, ok := model.PayPeriods[s.Frequency]; !ok {
		return apperr.Validation("frequency", "Choose how often employees on this schedule are paid.")
	}
	if !store.ValidDate(s.NextPeriodEnd) {
		return apperr.Validation("nextPeriodEnd", "Enter the end date of the next pay period.")
	}
	if !store.ValidDate(s.NextCheckDate) {
		return apperr.Validation("nextCheckDate", "Enter the check date of the next paycheck.")
	}
	if d := store.DaysBetween(s.NextPeriodEnd, s.NextCheckDate); d < -366 || d > 366 {
		return apperr.Validation("nextCheckDate", "The check date must be within a year of the pay period end date.")
	}
	if s.Frequency == model.FreqSemimonthly {
		if s.SemiFirstDay == 0 {
			s.SemiFirstDay = 15
		}
		if s.SemiFirstDay < 1 || s.SemiFirstDay > 27 {
			return apperr.Validation("semiFirstDay", "The first pay period of the month must end between day 1 and day 27.")
		}
		if dayOf(s.NextPeriodEnd) != s.SemiFirstDay && !isMonthEnd(s.NextPeriodEnd) {
			return apperr.Validation("nextPeriodEnd", "A semimonthly pay period ends on day %d or on the last day of the month.", s.SemiFirstDay)
		}
	} else if s.SemiFirstDay < 1 || s.SemiFirstDay > 27 {
		s.SemiFirstDay = 15
	}
	if s.Frequency == model.FreqDaily {
		if wd := store.Weekday(s.NextPeriodEnd); wd == time.Saturday || wd == time.Sunday {
			return apperr.Validation("nextPeriodEnd", "A daily pay period ends on a business day (Monday to Friday).")
		}
	}
	return nil
}

func saveSchedule(c *httpx.Ctx, id int64) error {
	var s model.PaySchedule
	act, err := decodeWithActive(c, &s)
	if err != nil {
		return err
	}
	if err := validateSchedule(&s); err != nil {
		return err
	}
	ctx := c.Context()
	saved := id
	err = c.Write(func(tx *sql.Tx) error {
		var before *model.PaySchedule
		if id != 0 {
			list, err := loadSchedules(ctx, tx, id)
			if err != nil {
				return err
			}
			if len(list) == 0 {
				return apperr.NotFound("Pay schedule not found.")
			}
			before = &list[0]
		}
		switch {
		case act != nil:
			s.Active = *act
		case before != nil:
			s.Active = before.Active
		default:
			s.Active = true
		}
		var other int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM pay_schedules WHERE name = ? COLLATE NOCASE AND id <> ?`, s.Name, id).Scan(&other)
		if err == nil {
			return apperr.Validation("name", "There is already a pay schedule named %q.", s.Name)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		now := store.Now()
		if id == 0 {
			res, err := tx.ExecContext(ctx, `INSERT INTO pay_schedules(name, frequency, next_period_end, next_check_date, semi_first_day, active, created_at, updated_at)
				VALUES(?,?,?,?,?,?,?,?)`, s.Name, s.Frequency, s.NextPeriodEnd, s.NextCheckDate, s.SemiFirstDay, store.B(s.Active), now, now)
			if err != nil {
				return err
			}
			saved, _ = res.LastInsertId()
			s.ID = saved
			s.NextPeriodStart = periodStart(s.Frequency, s.NextPeriodEnd, s.SemiFirstDay)
			return store.Audit(ctx, tx, c.User, "add", "pay_schedule", saved, "Pay schedule "+s.Name, s)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE pay_schedules SET name = ?, frequency = ?, next_period_end = ?, next_check_date = ?,
			semi_first_day = ?, active = ?, updated_at = ? WHERE id = ?`,
			s.Name, s.Frequency, s.NextPeriodEnd, s.NextCheckDate, s.SemiFirstDay, store.B(s.Active), now, id); err != nil {
			return err
		}
		// employees on the schedule are paid at its frequency
		if before.Frequency != s.Frequency {
			if _, err := tx.ExecContext(ctx, `UPDATE employees SET pay_frequency = ?, updated_at = ? WHERE pay_schedule_id = ?`, s.Frequency, now, id); err != nil {
				return err
			}
		}
		s.ID = id
		s.NextPeriodStart = periodStart(s.Frequency, s.NextPeriodEnd, s.SemiFirstDay)
		s.EmployeeCount = before.EmployeeCount
		return store.Audit(ctx, tx, c.User, "modify", "pay_schedule", id, "Pay schedule "+s.Name, map[string]any{"before": before, "after": s})
	})
	if err != nil {
		return err
	}
	return writeSchedule(c, saved)
}
