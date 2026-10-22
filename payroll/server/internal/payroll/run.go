package payroll

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// ---------------------------------------------------------------------------
// GET /payroll/scheduled: the Payroll Center "Pay Employees" list.

func loadSchedule(ctx context.Context, q store.Q, id int64) (*model.PaySchedule, error) {
	s := &model.PaySchedule{}
	var active int
	err := q.QueryRowContext(ctx, `SELECT id, name, frequency, next_period_end, next_check_date, semi_first_day, active
		FROM pay_schedules WHERE id = ?`, id).Scan(&s.ID, &s.Name, &s.Frequency, &s.NextPeriodEnd, &s.NextCheckDate, &s.SemiFirstDay, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Pay schedule not found.")
	}
	if err != nil {
		return nil, err
	}
	s.Active = active == 1
	s.NextPeriodStart = employees.PeriodStart(s.Frequency, s.NextPeriodEnd, s.SemiFirstDay)
	return s, nil
}

func scheduledRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	// employees on the schedule with their release dates (released before the
	// next pay period starts: not in the payroll of the schedule any more)
	type empRel struct {
		schedule int64
		release  string
	}
	var emps []empRel
	erows, err := c.DB.QueryContext(ctx, `SELECT pay_schedule_id, release_date FROM employees WHERE active = 1 AND pay_schedule_id IS NOT NULL`)
	if err != nil {
		return err
	}
	for erows.Next() {
		var e empRel
		if err := erows.Scan(&e.schedule, &e.release); err != nil {
			erows.Close()
			return err
		}
		emps = append(emps, e)
	}
	erows.Close()
	if err := erows.Err(); err != nil {
		return err
	}
	rows, err := c.DB.QueryContext(ctx, `SELECT s.id, s.name, s.frequency, s.next_period_end, s.next_check_date, s.semi_first_day
		FROM pay_schedules s WHERE s.active = 1`)
	if err != nil {
		return err
	}
	defer rows.Close()
	today := store.Today()
	soon := store.AddDays(today, 7)
	out := []model.ScheduledPayroll{}
	for rows.Next() {
		var sp model.ScheduledPayroll
		var semi int
		if err := rows.Scan(&sp.PayScheduleID, &sp.Name, &sp.Frequency, &sp.PeriodEnd, &sp.CheckDate, &semi); err != nil {
			return err
		}
		sp.PeriodStart = employees.PeriodStart(sp.Frequency, sp.PeriodEnd, semi)
		for _, e := range emps {
			if e.schedule == sp.PayScheduleID && (e.release == "" || e.release >= sp.PeriodStart) {
				sp.EmployeeCount++
			}
		}
		if sp.EmployeeCount == 0 {
			continue
		}
		switch {
		case sp.CheckDate < today:
			sp.Status = "Overdue"
		case sp.CheckDate <= soon:
			sp.Status = "Due"
		default:
			sp.Status = "Upcoming"
		}
		out = append(out, sp)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CheckDate != out[j].CheckDate {
			return out[i].CheckDate < out[j].CheckDate
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return c.JSON(out)
}

// ---------------------------------------------------------------------------
// POST /payroll/start: the defaults of the Hours and Pay step.

func startRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	var req model.StartPayrollRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	if req.Kind == "" {
		req.Kind = model.RunScheduled
	}
	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return err
	}
	draft := &model.PayrollDraft{Kind: req.Kind, BankAccountID: prefs.DefaultBankAccountID,
		EarningColumns: []model.PayrollItem{}, Employees: []model.PayrollDraftEmployee{}}
	var ids []int64
	selected := true
	semi := 15
	freq := ""
	switch req.Kind {
	case model.RunScheduled:
		if req.PayScheduleID == nil || *req.PayScheduleID <= 0 {
			return apperr.Validation("payScheduleId", "Choose a pay schedule.")
		}
		s, err := loadSchedule(ctx, c.DB, *req.PayScheduleID)
		if err != nil {
			return err
		}
		draft.PayScheduleID, draft.ScheduleName = &s.ID, s.Name
		draft.PeriodEnd, draft.CheckDate = s.NextPeriodEnd, s.NextCheckDate
		semi, freq = s.SemiFirstDay, s.Frequency
		if req.PeriodEnd != "" && store.ValidDate(req.PeriodEnd) {
			draft.PeriodEnd = req.PeriodEnd
		}
		// employees released before the pay period starts are not paid by the
		// payroll of the schedule any more (a last check is a final paycheck)
		start := employees.PeriodStart(s.Frequency, draft.PeriodEnd, s.SemiFirstDay)
		rows, err := c.DB.QueryContext(ctx, `SELECT id FROM employees WHERE pay_schedule_id = ? AND active = 1
			AND (release_date = '' OR release_date >= ?) ORDER BY display_name COLLATE NOCASE, id`, s.ID, start)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
	case model.RunUnscheduled, model.RunTermination:
		ids = req.EmployeeIDs
		if len(ids) == 0 {
			if req.Kind == model.RunTermination {
				return apperr.Validation("employeeIds", "Choose the employees who get a final paycheck.")
			}
			selected = false
			rows, err := c.DB.QueryContext(ctx, `SELECT id FROM employees WHERE active = 1 ORDER BY display_name COLLATE NOCASE, id`)
			if err != nil {
				return err
			}
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					rows.Close()
					return err
				}
				ids = append(ids, id)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
		}
		draft.PeriodEnd, draft.CheckDate = store.Today(), store.Today()
	default:
		return apperr.Validation("kind", "Unknown payroll kind %q.", req.Kind)
	}
	if req.PeriodEnd != "" {
		if !store.ValidDate(req.PeriodEnd) {
			return apperr.Validation("periodEnd", "Please enter a valid pay period end date.")
		}
		draft.PeriodEnd = req.PeriodEnd
	}
	if req.CheckDate != "" {
		if !store.ValidDate(req.CheckDate) {
			return apperr.Validation("checkDate", "Please enter a valid check date.")
		}
		draft.CheckDate = req.CheckDate
	}
	if req.ReleaseDate != "" && !store.ValidDate(req.ReleaseDate) {
		return apperr.Validation("releaseDate", "Please enter a valid release date.")
	}

	all, err := items.All(ctx, c.DB)
	if err != nil {
		return err
	}
	colSeen := map[int64]bool{}
	for _, id := range ids {
		e, err := employees.Load(ctx, c.DB, id, false)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Employee #%d not found.", id)
		}
		if err != nil {
			return err
		}
		if freq == "" {
			freq = e.PayFrequency
			semi = semiFirstDay(ctx, c.DB, e)
		}
		de, err := draftEmployee(ctx, c.DB, prefs, e, all)
		if err != nil {
			return err
		}
		de.Selected = selected
		if req.Kind == model.RunTermination && req.ReleaseDate != "" && e.ReleaseDate != "" && e.ReleaseDate != req.ReleaseDate {
			de.Warnings = append(de.Warnings, "The release date "+mdy(e.ReleaseDate)+" will be changed to "+mdy(req.ReleaseDate)+".")
		}
		for _, l := range de.Lines {
			if !colSeen[l.ItemID] {
				colSeen[l.ItemID] = true
				draft.EarningColumns = append(draft.EarningColumns, *all[l.ItemID])
			}
		}
		draft.Employees = append(draft.Employees, *de)
	}
	if freq == "" {
		freq = model.FreqBiweekly
	}
	draft.PeriodStart = employees.PeriodStart(freq, draft.PeriodEnd, semi)

	// next check number of the bank account in SerieX Books ("" when Books is down)
	if draft.BankAccountID != nil && *draft.BankAccountID > 0 {
		bctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		ref, err := books.Default.NextRef(bctx, books.S(c), books.TxCheck, *draft.BankAccountID)
		cancel()
		if err == nil {
			draft.NextCheckNumber = ref
		}
	}
	return c.JSON(draft)
}

// defaultHours is the salaried hours of a pay period (40 hours a week).
func defaultHours(freq string) float64 {
	p := model.PayPeriods[freq]
	if p <= 0 {
		return 0
	}
	return math.Round(2080/float64(p)*100) / 100
}

// draftEmployee builds the default earnings lines of one employee: the lines
// of the previous paycheck (prefs.copyEarningsFromPrevious; hours when
// prefs.recallHours) or the employee's earnings items with rate and default hours.
func draftEmployee(ctx context.Context, q store.Q, prefs model.PayrollPrefs, e *model.Employee, all map[int64]*model.PayrollItem) (*model.PayrollDraftEmployee, error) {
	de := &model.PayrollDraftEmployee{EmployeeID: e.ID, EmployeeName: e.DisplayName, Lines: []model.PaycheckLine{},
		DirectDeposit: e.DirectDeposit.Enabled, PayFrequency: e.PayFrequency, LastCheckDate: e.LastCheckDate, Warnings: []string{}}
	var input []model.PaycheckLine
	if prefs.CopyEarningsFromPrevious {
		var last int64
		err := q.QueryRowContext(ctx, `SELECT id FROM paychecks WHERE employee_id = ? AND kind = 'regular' AND voided = 0
			ORDER BY check_date DESC, id DESC LIMIT 1`, e.ID).Scan(&last)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if last > 0 {
			rows, err := loadLines(ctx, q, all, last)
			if err != nil {
				return nil, err
			}
			for _, l := range rows {
				if l.category != model.CatEarning || l.item.Type == "" {
					continue
				}
				in := model.PaycheckLine{ItemID: l.item.ID, JobNameID: l.job, ClassID: l.class}
				// the earnings line is copied (items, rates, and hours when
				// recallHours), the way a new paycheck copies the earnings details of
				// the previous one: hourly/overtime rates and hours, commission percents.
				// One-time amounts are not repeated: bonus, fixed commission, paid and
				// reported tips keep their column with amount 0, and the sales of a
				// percent commission are not copied. Salary is recalculated from the
				// annual salary.
				oneTime := oneTimeEarning(l.item)
				switch {
				case oneTime:
					in.Rate = fptr(0)
				case l.rate != nil && l.item.Type != model.ItemSalary:
					in.Rate = fptr(*l.rate)
				}
				if prefs.RecallHours && l.qty != nil && !oneTime && l.item.Type != model.ItemCommission {
					in.Qty = fptr(*l.qty)
				}
				input = append(input, in)
			}
		}
	}
	// the employee's earnings items (Payroll Info tab): every item is a column of
	// the Hours and Pay grid, so items the copied paycheck did not
	// use are added empty (rate only)
	copied := input != nil
	have := map[int64]bool{}
	for _, l := range input {
		have[l.ItemID] = true
	}
	for _, ei := range e.Earnings {
		it := all[ei.ItemID]
		if it == nil || !it.Active || !model.IsWageType(it.Type) || have[it.ID] {
			continue
		}
		have[it.ID] = true
		in := model.PaycheckLine{ItemID: it.ID}
		if ei.Rate > 0 && it.Type != model.ItemSalary && it.Type != model.ItemOvertime {
			in.Rate = fptr(ei.Rate)
		}
		if ei.Qty != nil && !copied {
			in.Qty = fptr(*ei.Qty)
		}
		input = append(input, in)
	}
	// salaried hours: the first regular salary line gets the period's hours when none were given
	firstSalary := true
	for i := range input {
		it := all[input[i].ItemID]
		if it.Type == model.ItemSalary && it.Pto == "" && firstSalary {
			firstSalary = false
			if input[i].Qty == nil || *input[i].Qty == 0 {
				input[i].Qty = fptr(defaultHours(e.PayFrequency))
			}
		}
	}
	if len(input) == 0 {
		de.Warnings = append(de.Warnings, e.DisplayName+" has no earnings items. Add them on the Payroll Info tab of the employee.")
	}
	if e.WorkState == "" {
		de.Warnings = append(de.Warnings, e.DisplayName+" has no work state; state taxes will not be calculated.")
	}
	periods := model.PayPeriods[e.PayFrequency]
	if periods <= 0 {
		periods = 26
	}
	r := &calcResult{}
	lines := computeEarningsAll(e, all, input, periods, r)
	de.Warnings = append(de.Warnings, r.warnings...)
	for _, l := range lines {
		pl := model.PaycheckLine{ItemID: l.item.ID, Rate: l.rate, Qty: l.qty, Amount: store.Dollars(l.amount),
			Computed: store.Dollars(l.computed), JobNameID: l.job, ClassID: l.class, ItemName: l.item.Name, ItemType: l.item.Type,
			Category: model.CatEarning, Pto: l.item.Pto}
		de.Lines = append(de.Lines, pl)
		if hourBased(l.item.Type) && l.qty != nil {
			de.TotalHours += *l.qty
		}
	}
	de.TotalHours = round4(de.TotalHours)
	return de, nil
}

// oneTimeEarning: earnings paid as an amount (bonus, fixed commission, paid
// and reported tips) that a copied paycheck must not pay again.
func oneTimeEarning(it *model.PayrollItem) bool {
	switch it.Type {
	case model.ItemBonus, model.ItemTips, model.ItemReportedTips:
		return true
	case model.ItemCommission:
		return it.Calc != model.CalcQuantity
	}
	return false
}

// computeEarningsAll computes earnings like a paycheck but keeps empty lines
// (the Pay Employees grid shows every earnings column of the employee).
func computeEarningsAll(e *model.Employee, all map[int64]*model.PayrollItem, input []model.PaycheckLine, periods int, r *calcResult) []*cline {
	out := computeEarnings(e, all, input, periods, false, false, r)
	byItem := map[int64][]*cline{}
	for _, l := range out {
		byItem[l.item.ID] = append(byItem[l.item.ID], l)
	}
	var lines []*cline
	for _, in := range input {
		if list := byItem[in.ItemID]; len(list) > 0 {
			lines = append(lines, list[0])
			byItem[in.ItemID] = list[1:]
			continue
		}
		it := all[in.ItemID]
		l := &cline{item: it, category: model.CatEarning, rate: in.Rate, qty: in.Qty, job: in.JobNameID, class: in.ClassID}
		if it.Type == model.ItemOvertime && l.rate == nil && e.HourlyRate > 0 {
			mult := it.Rate
			if mult <= 0 {
				mult = 1.5
			}
			l.rate = fptr(round4(mult * e.HourlyRate))
		}
		if it.Type == model.ItemHourly && l.rate == nil {
			if ei := employeeItem(e.Earnings, it.ID); ei != nil && ei.Rate > 0 {
				l.rate = fptr(ei.Rate)
			} else if e.HourlyRate > 0 {
				l.rate = fptr(e.HourlyRate)
			}
		}
		lines = append(lines, l)
	}
	return lines
}

// ---------------------------------------------------------------------------
// POST /payroll/create: Create Paychecks.

func createRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	var req model.CreatePayrollRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	switch req.Kind {
	case model.RunScheduled, model.RunUnscheduled, model.RunTermination:
	case "":
		req.Kind = model.RunUnscheduled
	default:
		return apperr.Validation("kind", "Unknown payroll kind %q.", req.Kind)
	}
	if req.Kind == model.RunScheduled && (req.PayScheduleID == nil || *req.PayScheduleID <= 0) {
		return apperr.Validation("payScheduleId", "Choose a pay schedule.")
	}
	if !store.ValidDate(req.CheckDate) {
		return apperr.Validation("checkDate", "Please enter a valid check date.")
	}
	if !store.ValidDate(req.PeriodEnd) {
		return apperr.Validation("periodEnd", "Please enter a valid pay period end date.")
	}
	if req.PeriodStart != "" && !store.ValidDate(req.PeriodStart) {
		return apperr.Validation("periodStart", "Please enter a valid pay period start date.")
	}
	if req.PeriodStart != "" && req.PeriodStart > req.PeriodEnd {
		return apperr.Validation("periodStart", "The pay period start date must be on or before the pay period end date.")
	}
	if req.BankAccountID <= 0 {
		return apperr.Validation("bankAccountId", "Choose the bank account the paychecks are drawn on.")
	}
	switch req.PrintMode {
	case "":
		req.PrintMode = "print"
	case "print", "handwritten":
	default:
		return apperr.Validation("printMode", "Choose to print the paychecks or to assign check numbers to handwritten checks.")
	}
	req.FirstCheckNumber = strings.TrimSpace(req.FirstCheckNumber)
	if req.PrintMode == "handwritten" && !validCheckNumber(req.FirstCheckNumber) {
		return apperr.Validation("firstCheckNumber", "Enter the first check number (it must end with a number).")
	}
	if len(req.Paychecks) == 0 {
		return apperr.Validation("paychecks", "Select at least one employee to pay.")
	}
	release := ""
	if req.Kind == model.RunTermination {
		release = req.ReleaseDate
		if release == "" {
			release = req.CheckDate
		}
		if !store.ValidDate(release) {
			return apperr.Validation("releaseDate", "Please enter a valid release date.")
		}
	}

	// Everything that reads year-to-date amounts, check numbers or the pay
	// schedule runs inside the write transaction: two payrolls created at the
	// same time are calculated one after the other, so the second one sees the
	// first one's paychecks (wage base caps, annual limits, check numbers).
	bank := req.BankAccountID
	var runID int64
	var ids []int64
	err := c.Write(func(tx *sql.Tx) error {
		var sched *model.PaySchedule
		if req.Kind == model.RunScheduled {
			s, err := loadSchedule(ctx, tx, *req.PayScheduleID)
			if err != nil {
				return err
			}
			sched = s
			// the same scheduled period paid twice (Create Paychecks clicked twice,
			// two users at once): ask before paying it again
			if !c.Force() {
				var n int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM paychecks p JOIN payroll_runs r ON r.id = p.run_id
					WHERE r.kind = 'scheduled' AND r.pay_schedule_id = ? AND r.period_end = ? AND p.voided = 0`,
					s.ID, req.PeriodEnd).Scan(&n); err != nil {
					return err
				}
				if n > 0 {
					count := "1 paycheck"
					if n > 1 {
						count = strconv.Itoa(n) + " paychecks"
					}
					return apperr.Confirm("The %s payroll for the pay period ending %s was already created (%s). Do you want to create these paychecks anyway?",
						s.Name, mdy(req.PeriodEnd), count)
				}
			}
		}

		// validate and calculate every paycheck first (manual lines are kept)
		env, err := newEnv(ctx, tx)
		if err != nil {
			return err
		}
		results := make([]*calcResult, 0, len(req.Paychecks))
		runStart, ownStart, err := runPeriodStarts(ctx, tx, sched, req)
		if err != nil {
			return err
		}
		seen := map[int64]bool{}
		var numbers []string
		n := req.FirstCheckNumber
		for i := range req.Paychecks {
			in := req.Paychecks[i]
			if seen[in.EmployeeID] {
				return apperr.Validation("paychecks", "An employee is listed twice in this payroll.")
			}
			seen[in.EmployeeID] = true
			in.ID, in.Kind, in.Recalculate = 0, model.PaycheckRegular, true
			in.CheckDate = req.CheckDate
			if !store.ValidDate(in.PeriodEnd) {
				in.PeriodEnd = req.PeriodEnd
			}
			if !store.ValidDate(in.PeriodStart) || in.PeriodStart > in.PeriodEnd {
				// A paycheck sent without its period start: the run's period start
				// applies only to an employee whose own pay period is the run's;
				// otherwise calculate starts the period by the employee's own pay
				// frequency (employees.PeriodStart).
				in.PeriodStart = ""
				if in.PeriodEnd == req.PeriodEnd && runStart != "" && ownStart[in.EmployeeID] == runStart {
					in.PeriodStart = req.PeriodStart
				}
			}
			in.BankAccountID = &bank
			in.CheckNumber, in.ToBePrinted = "", false
			r, err := calculate(ctx, tx, env, &in, calcOpts{})
			if err != nil {
				if ae := apperr.As(err); ae != nil && in.EmployeeID > 0 {
					var name string
					tx.QueryRowContext(ctx, `SELECT display_name FROM employees WHERE id = ?`, in.EmployeeID).Scan(&name)
					if name != "" && !strings.Contains(ae.Message, name) {
						ae.Message = name + ": " + ae.Message
					}
				}
				return err
			}
			if err := checkPayable(r); err != nil {
				return err
			}
			if in.DirectDeposit && !r.emp.DirectDeposit.Enabled {
				return apperr.Validation("paychecks", "%s is not set up for direct deposit.", r.emp.DisplayName)
			}
			switch {
			case in.DirectDeposit:
				// numbered DD<paycheck id> once saved
			case req.PrintMode == "handwritten":
				r.pc.CheckNumber = n
				numbers = append(numbers, n)
				n = nextNumber(n)
			default:
				r.pc.ToBePrinted = true
			}
			results = append(results, r)
		}
		if err := duplicateCheck(c, tx, bank, numbers, 0); err != nil {
			return err
		}

		ids = make([]int64, 0, len(results))
		res, err := tx.ExecContext(ctx, `INSERT INTO payroll_runs(kind, pay_schedule_id, period_start, period_end, check_date,
			bank_account_id, created_by, created_at) VALUES(?,?,?,?,?,?,?,?)`, req.Kind, store.NullID(req.PayScheduleID),
			firstNonEmpty(req.PeriodStart, results[0].pc.PeriodStart), req.PeriodEnd, req.CheckDate, bank, c.User, store.Now())
		if err != nil {
			return err
		}
		if runID, err = res.LastInsertId(); err != nil {
			return err
		}
		for _, r := range results {
			id, err := insertPaycheck(ctx, tx, r, &runID, c.User, syncPending)
			if err != nil {
				return err
			}
			if r.pc.DirectDeposit {
				r.pc.CheckNumber = "DD" + strconv.FormatInt(id, 10)
				if _, err := tx.ExecContext(ctx, `UPDATE paychecks SET check_number = ? WHERE id = ?`, r.pc.CheckNumber, id); err != nil {
					return err
				}
			}
			r.pc.ID = id
			r.pc.RunID = &runID
			ids = append(ids, id)
			if err := store.Audit(ctx, tx, c.User, "add", "paycheck", id, "Paycheck - "+r.emp.DisplayName,
				map[string]any{"after": auditView(r.pc)}); err != nil {
				return err
			}
		}
		// payroll of a pay schedule: the schedule moves past the period just paid
		if sched != nil {
			s := *sched
			moved := false
			for i := 0; i < 1000 && s.NextPeriodEnd <= req.PeriodEnd; i++ {
				_, end, check := employees.NextPeriod(&s)
				if end == "" || end <= s.NextPeriodEnd {
					break
				}
				s.NextPeriodEnd, s.NextCheckDate = end, check
				moved = true
			}
			if moved {
				if _, err := tx.ExecContext(ctx, `UPDATE pay_schedules SET next_period_end = ?, next_check_date = ?, updated_at = ? WHERE id = ?`,
					s.NextPeriodEnd, s.NextCheckDate, store.Now(), s.ID); err != nil {
					return err
				}
				if err := store.Audit(ctx, tx, c.User, "modify", "pay_schedule", s.ID, "Pay schedule "+s.Name+" advanced",
					map[string]any{"before": map[string]string{"nextPeriodEnd": sched.NextPeriodEnd, "nextCheckDate": sched.NextCheckDate},
						"after": map[string]string{"nextPeriodEnd": s.NextPeriodEnd, "nextCheckDate": s.NextCheckDate}}); err != nil {
					return err
				}
			}
		}
		// termination: the employees' release date
		if release != "" {
			for _, r := range results {
				if _, err := tx.ExecContext(ctx, `UPDATE employees SET release_date = ?, updated_at = ? WHERE id = ?`,
					release, store.Now(), r.emp.ID); err != nil {
					return err
				}
				if err := store.Audit(ctx, tx, c.User, "modify", "employee", r.emp.ID, "Employee "+r.emp.DisplayName+" released",
					map[string]any{"before": map[string]string{"releaseDate": r.emp.ReleaseDate},
						"after": map[string]string{"releaseDate": release}}); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	// post to SerieX Books (outside the transaction); problems never undo the payroll
	out := model.CreatePayrollResult{RunID: runID, Problems: []model.SyncProblem{}}
	out.Posted, out.Problems = postAll(c, ids, books.Opts(c))
	list, err := listSummaries(ctx, c.DB, []string{"p.run_id = ?"}, []any{runID}, "p.id")
	if err != nil {
		return err
	}
	out.Paychecks = list
	return c.JSON(out)
}

// runPeriodStarts returns the first day of the run's own pay period ending on
// req.PeriodEnd (scheduled: by the schedule's frequency; otherwise by the
// frequency every employee of the run shares, "" when they differ) and the
// first day of each employee's own pay period ending on req.PeriodEnd. Both
// are "" when the request has no period start to hand out.
func runPeriodStarts(ctx context.Context, q store.Q, sched *model.PaySchedule, req model.CreatePayrollRequest) (string, map[int64]string, error) {
	own := map[int64]string{}
	if req.PeriodStart == "" {
		return "", own, nil
	}
	for _, in := range req.Paychecks {
		var freq string
		var semi int
		err := q.QueryRowContext(ctx, `SELECT e.pay_frequency, COALESCE(s.semi_first_day, 0) FROM employees e
			LEFT JOIN pay_schedules s ON s.id = e.pay_schedule_id WHERE e.id = ?`, in.EmployeeID).Scan(&freq, &semi)
		if errors.Is(err, sql.ErrNoRows) {
			continue // reported by calculate
		}
		if err != nil {
			return "", nil, err
		}
		if semi <= 0 {
			semi = 15
		}
		own[in.EmployeeID] = employees.PeriodStart(freq, req.PeriodEnd, semi)
	}
	if sched != nil {
		semi := sched.SemiFirstDay
		if semi <= 0 {
			semi = 15
		}
		return employees.PeriodStart(sched.Frequency, req.PeriodEnd, semi), own, nil
	}
	run := ""
	for _, st := range own {
		if run != "" && st != run {
			return "", own, nil
		}
		run = st
	}
	return run, own, nil
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
