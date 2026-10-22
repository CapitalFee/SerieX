package employees

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

const empCols = `e.id, e.books_name_id, e.first_name, e.middle_name, e.last_name, e.suffix, e.display_name, e.print_as, e.ssn,
	e.birth_date, e.gender, e.address1, e.address2, e.city, e.state, e.zip, e.phone, e.mobile, e.email, e.employee_number,
	e.hire_date, e.original_hire_date, e.release_date, e.employment_type, e.pay_schedule_id, e.pay_frequency, e.class_id, e.work_state,
	e.w4_version, e.fed_filing_status, e.w4_step2, e.w4_dependents, e.w4_other_income, e.w4_deductions, e.w4_extra, e.fed_allowances,
	e.fed_exempt, e.nonresident_alien, e.subject_ss, e.subject_medicare, e.subject_futa,
	e.state_filing_status, e.state_allowances, e.state_extra, e.state_exempt, e.state_data, e.subject_sui, e.subject_sdi,
	e.dd_enabled, e.dd_bank_name, e.dd_routing, e.dd_account, e.dd_account_type, e.sick, e.vacation, e.notes, e.active,
	COALESCE(s.name, ''), e.w4_exempt_year, e.books_sync_error`

type scanner interface {
	Scan(dest ...any) error
}

func scanEmployee(s scanner) (*model.Employee, error) {
	e := &model.Employee{}
	var booksName, sched, class sql.NullInt64
	var step2, fedExempt, nra, subSS, subMed, subFUTA, stExempt, subSUI, subSDI, ddEnabled, active int
	var dependents, otherIncome, deductions, extra, stExtra int64
	var stateData, sick, vac string
	a := &e.Address
	err := s.Scan(&e.ID, &booksName, &e.FirstName, &e.MiddleName, &e.LastName, &e.Suffix, &e.DisplayName, &e.PrintAs, &e.SSN,
		&e.BirthDate, &e.Gender, &a.Line1, &a.Line2, &a.City, &a.State, &a.Zip, &e.Phone, &e.Mobile, &e.Email, &e.EmployeeNumber,
		&e.HireDate, &e.OriginalHireDate, &e.ReleaseDate, &e.EmploymentType, &sched, &e.PayFrequency, &class, &e.WorkState,
		&e.W4.Version, &e.W4.FilingStatus, &step2, &dependents, &otherIncome, &deductions, &extra, &e.W4.Allowances,
		&fedExempt, &nra, &subSS, &subMed, &subFUTA,
		&e.StateW4.FilingStatus, &e.StateW4.Allowances, &stExtra, &stExempt, &stateData, &subSUI, &subSDI,
		&ddEnabled, &e.DirectDeposit.BankName, &e.DirectDeposit.Routing, &e.DirectDeposit.Account, &e.DirectDeposit.AccountType,
		&sick, &vac, &e.Notes, &active, &e.PayScheduleName, &e.W4.ExemptYear, &e.BooksSyncError)
	if err != nil {
		return nil, err
	}
	e.BooksNameID = store.PtrID(booksName)
	e.PayScheduleID = store.PtrID(sched)
	e.ClassID = store.PtrID(class)
	e.W4.Step2 = step2 == 1
	e.W4.Dependents = store.Dollars(dependents)
	e.W4.OtherIncome = store.Dollars(otherIncome)
	e.W4.Deductions = store.Dollars(deductions)
	e.W4.ExtraWithholding = store.Dollars(extra)
	e.W4.Exempt = fedExempt == 1
	e.W4.NonresidentAlien = nra == 1
	e.SubjectSS, e.SubjectMedicare, e.SubjectFUTA = subSS == 1, subMed == 1, subFUTA == 1
	e.StateW4.ExtraWithholding = store.Dollars(stExtra)
	e.StateW4.Exempt = stExempt == 1
	e.StateW4.Data = map[string]any{}
	if stateData != "" {
		json.Unmarshal([]byte(stateData), &e.StateW4.Data)
		if e.StateW4.Data == nil {
			e.StateW4.Data = map[string]any{}
		}
	}
	e.SubjectSUI, e.SubjectSDI = subSUI == 1, subSDI == 1
	e.DirectDeposit.Enabled = ddEnabled == 1
	e.Sick = parsePTO(sick)
	e.Vacation = parsePTO(vac)
	e.Active = active == 1
	e.SSNOnFile = e.SSN != ""
	e.Earnings = []model.EmployeeItem{}
	e.Items = []model.EmployeeItem{}
	return e, nil
}

// mask hides the SSN and the direct deposit numbers.
func mask(e *model.Employee) {
	e.SSN = store.MaskSSN(e.SSN)
	e.DirectDeposit.Routing = store.MaskAccount(e.DirectDeposit.Routing)
	e.DirectDeposit.Account = store.MaskAccount(e.DirectDeposit.Account)
}

// loadEmployees loads one employee (id > 0) or all employees with their
// items and computed fields; PTO balances are as of asOf.
func loadEmployees(ctx context.Context, q store.Q, id int64, reveal bool, asOf string) ([]*model.Employee, error) {
	query := `SELECT ` + empCols + ` FROM employees e LEFT JOIN pay_schedules s ON s.id = e.pay_schedule_id`
	var args []any
	if id > 0 {
		query += ` WHERE e.id = ?`
		args = append(args, id)
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY e.display_name COLLATE NOCASE, e.id`, args...)
	if err != nil {
		return nil, err
	}
	var list []*model.Employee
	byID := map[int64]*model.Employee{}
	for rows.Next() {
		e, err := scanEmployee(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, e)
		byID[e.ID] = e
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return list, nil
	}

	// default payroll items
	query = `SELECT ei.employee_id, ei.item_id, ei.rate, ei.annual_limit, ei.qty, p.name, p.type, p.calc
		FROM employee_items ei JOIN payroll_items p ON p.id = ei.item_id`
	args = nil
	if id > 0 {
		query += ` WHERE ei.employee_id = ?`
		args = append(args, id)
	}
	rows, err = q.QueryContext(ctx, query+` ORDER BY ei.employee_id, ei.seq, ei.id`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var emp int64
		var it model.EmployeeItem
		var limit sql.NullInt64
		var qty sql.NullFloat64
		if err := rows.Scan(&emp, &it.ItemID, &it.Rate, &limit, &qty, &it.ItemName, &it.ItemType, &it.Calc); err != nil {
			rows.Close()
			return nil, err
		}
		if limit.Valid {
			v := store.Dollars(limit.Int64)
			it.AnnualLimit = &v
		}
		if qty.Valid {
			v := qty.Float64
			it.Qty = &v
		}
		e := byID[emp]
		if e == nil {
			continue
		}
		if model.IsWageType(it.ItemType) {
			e.Earnings = append(e.Earnings, it)
		} else {
			e.Items = append(e.Items, it)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// paycheck facts: YTD gross (calendar year of asOf), last check date, any paycheck
	from, to := store.YearRange(store.Year(asOf))
	query = `SELECT employee_id,
			COALESCE(SUM(CASE WHEN voided = 0 AND check_date BETWEEN ? AND ? THEN gross ELSE 0 END), 0),
			COALESCE(MAX(CASE WHEN voided = 0 AND kind = 'regular' THEN check_date END), ''),
			COUNT(*)
		FROM paychecks`
	args = []any{from, to}
	if id > 0 {
		query += ` WHERE employee_id = ?`
		args = append(args, id)
	}
	rows, err = q.QueryContext(ctx, query+` GROUP BY employee_id`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var emp, gross int64
		var last string
		var n int
		if err := rows.Scan(&emp, &gross, &last, &n); err != nil {
			rows.Close()
			return nil, err
		}
		if e := byID[emp]; e != nil {
			e.YTDGross = store.Dollars(gross)
			e.LastCheckDate = last
			e.HasPaychecks = n > 0
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// paid time off as of asOf
	pto, err := loadPTOData(ctx, q, id, asOf, 0)
	if err != nil {
		return nil, err
	}
	floor := ptoFloor(ctx, q)
	for _, e := range list {
		d := pto[e.ID]
		if d == nil {
			d = &ptoData{}
		}
		e.Sick.Available, e.Sick.AccruedYTD, e.Sick.UsedYTD = computePTO(e.Sick, e.HireDate, d.events("sick"), asOf, floor)
		e.Vacation.Available, e.Vacation.AccruedYTD, e.Vacation.UsedYTD = computePTO(e.Vacation, e.HireDate, d.events("vacation"), asOf, floor)
		fillRates(e)
		if !reveal {
			mask(e)
		}
	}
	return list, nil
}

// fillRates sets HourlyRate (first hourly wage, else salary / 2080) and AnnualSalary.
func fillRates(e *model.Employee) {
	e.HourlyRate, e.AnnualSalary = 0, 0
	for _, it := range e.Earnings {
		if it.ItemType == model.ItemSalary && e.AnnualSalary == 0 {
			e.AnnualSalary = it.Rate
		}
		if it.ItemType == model.ItemHourly && e.HourlyRate == 0 {
			e.HourlyRate = it.Rate
		}
	}
	if e.HourlyRate == 0 && e.AnnualSalary > 0 {
		e.HourlyRate = e.AnnualSalary / 2080
	}
}

// saveEmployee inserts (ID 0) or updates an employee and replaces its items.
// e holds the full (unmasked) SSN and bank numbers.
func saveEmployee(ctx context.Context, tx *sql.Tx, e *model.Employee) (int64, error) {
	now := store.Now()
	a := e.Address
	vals := []any{e.FirstName, e.MiddleName, e.LastName, e.Suffix, e.DisplayName, e.PrintAs, e.SSN,
		e.BirthDate, e.Gender, a.Line1, a.Line2, a.City, a.State, a.Zip, e.Phone, e.Mobile, e.Email, e.EmployeeNumber,
		e.HireDate, e.OriginalHireDate, e.ReleaseDate, e.EmploymentType, store.NullID(e.PayScheduleID), e.PayFrequency,
		store.NullID(e.ClassID), e.WorkState,
		e.W4.Version, e.W4.FilingStatus, store.B(e.W4.Step2), store.Cents(e.W4.Dependents), store.Cents(e.W4.OtherIncome),
		store.Cents(e.W4.Deductions), store.Cents(e.W4.ExtraWithholding), e.W4.Allowances, store.B(e.W4.Exempt),
		store.B(e.W4.NonresidentAlien), store.B(e.SubjectSS), store.B(e.SubjectMedicare), store.B(e.SubjectFUTA),
		e.StateW4.FilingStatus, e.StateW4.Allowances, store.Cents(e.StateW4.ExtraWithholding), store.B(e.StateW4.Exempt),
		store.JSONText(e.StateW4.Data), store.B(e.SubjectSUI), store.B(e.SubjectSDI),
		store.B(e.DirectDeposit.Enabled), e.DirectDeposit.BankName, e.DirectDeposit.Routing, e.DirectDeposit.Account,
		e.DirectDeposit.AccountType, ptoJSON(e.Sick), ptoJSON(e.Vacation), e.Notes, store.B(e.Active), e.W4.ExemptYear}
	cols := `first_name, middle_name, last_name, suffix, display_name, print_as, ssn,
		birth_date, gender, address1, address2, city, state, zip, phone, mobile, email, employee_number,
		hire_date, original_hire_date, release_date, employment_type, pay_schedule_id, pay_frequency, class_id, work_state,
		w4_version, fed_filing_status, w4_step2, w4_dependents, w4_other_income, w4_deductions, w4_extra, fed_allowances, fed_exempt,
		nonresident_alien, subject_ss, subject_medicare, subject_futa,
		state_filing_status, state_allowances, state_extra, state_exempt, state_data, subject_sui, subject_sdi,
		dd_enabled, dd_bank_name, dd_routing, dd_account, dd_account_type, sick, vacation, notes, active, w4_exempt_year`
	id := e.ID
	if id == 0 {
		ph := strings.TrimSuffix(strings.Repeat("?,", len(vals)+2), ",")
		res, err := tx.ExecContext(ctx, `INSERT INTO employees(`+cols+`, created_at, updated_at) VALUES(`+ph+`)`, append(vals, now, now)...)
		if err != nil {
			return 0, err
		}
		if id, err = res.LastInsertId(); err != nil {
			return 0, err
		}
	} else {
		var set []string
		for _, c := range strings.Split(cols, ",") {
			set = append(set, strings.TrimSpace(c)+" = ?")
		}
		res, err := tx.ExecContext(ctx, `UPDATE employees SET `+strings.Join(set, ", ")+`, updated_at = ? WHERE id = ?`, append(vals, now, id)...)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return 0, sql.ErrNoRows
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM employee_items WHERE employee_id = ?`, id); err != nil {
			return 0, err
		}
	}
	seq := 0
	for _, list := range [][]model.EmployeeItem{e.Earnings, e.Items} {
		for _, it := range list {
			seq++
			var limit, qty any
			if it.AnnualLimit != nil {
				limit = store.Cents(*it.AnnualLimit)
			}
			if it.Qty != nil {
				qty = *it.Qty
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO employee_items(employee_id, item_id, seq, rate, annual_limit, qty) VALUES(?,?,?,?,?,?)`,
				id, it.ItemID, seq, it.Rate, limit, qty); err != nil {
				return 0, fmt.Errorf("employee item %d: %w", it.ItemID, err)
			}
		}
	}
	return id, nil
}
