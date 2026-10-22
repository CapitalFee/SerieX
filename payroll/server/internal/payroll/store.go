package payroll

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

const (
	syncNone    = "none"
	syncPending = "pending"
)

// header is a saved paycheck row.
type header struct {
	model.Paycheck
	sickAcc, sickUsed, vacAcc, vacUsed float64
	inputs                             string
}

const headerCols = `p.id, p.run_id, p.kind, p.employee_id, p.period_start, p.period_end, p.check_date, p.bank_account_id,
	p.check_number, p.to_be_printed, p.direct_deposit, p.memo, p.class_id, p.gross, p.not_paid, p.deductions, p.employee_taxes,
	p.net, p.employer_taxes, p.contributions, p.total_hours, p.sick_accrued, p.sick_used, p.vac_accrued, p.vac_used,
	p.no_accrual, p.inputs, p.voided, p.books_txn_id, p.sync_status, p.sync_error, p.created_by, p.created_at, p.updated_at,
	e.display_name`

type scanner interface {
	Scan(dest ...any) error
}

func scanHeader(s scanner) (*header, error) {
	h := &header{}
	p := &h.Paycheck
	var run, bank, class, txn sql.NullInt64
	var gross, notPaid, ded, eeTax, net, erTax, contrib int64
	var toBePrinted, dd, noAccrual, voided int
	err := s.Scan(&p.ID, &run, &p.Kind, &p.EmployeeID, &p.PeriodStart, &p.PeriodEnd, &p.CheckDate, &bank,
		&p.CheckNumber, &toBePrinted, &dd, &p.Memo, &class, &gross, &notPaid, &ded, &eeTax,
		&net, &erTax, &contrib, &p.TotalHours, &h.sickAcc, &h.sickUsed, &h.vacAcc, &h.vacUsed,
		&noAccrual, &h.inputs, &voided, &txn, &p.SyncStatus, &p.SyncError, &p.CreatedBy, &p.CreatedAt, &p.UpdatedAt,
		&p.EmployeeName)
	if err != nil {
		return nil, err
	}
	p.RunID, p.BankAccountID, p.ClassID, p.BooksTxnID = store.PtrID(run), store.PtrID(bank), store.PtrID(class), store.PtrID(txn)
	p.ToBePrinted, p.DirectDeposit, p.NoAccrual, p.Voided = toBePrinted == 1, dd == 1, noAccrual == 1, voided == 1
	p.Gross, p.NotPaid, p.Deductions, p.EmployeeTaxes = store.Dollars(gross), store.Dollars(notPaid), store.Dollars(ded), store.Dollars(eeTax)
	p.Net, p.EmployerTaxes, p.Contributions = store.Dollars(net), store.Dollars(erTax), store.Dollars(contrib)
	p.Warnings = []string{}
	return h, nil
}

func loadHeader(ctx context.Context, q store.Q, id int64) (*header, error) {
	h, err := scanHeader(q.QueryRowContext(ctx, `SELECT `+headerCols+` FROM paychecks p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Paycheck not found.")
	}
	return h, err
}

// loadLines reads the lines of a paycheck in order.
func loadLines(ctx context.Context, q store.Q, all map[int64]*model.PayrollItem, id int64) ([]lineRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, item_id, category, rate, qty, amount, wage_base, subject_wages, computed,
		job_name_id, class_id, manual FROM paycheck_lines WHERE paycheck_id = ? ORDER BY seq, id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []lineRow
	for rows.Next() {
		var l lineRow
		var itemID int64
		var rate, qty sql.NullFloat64
		var job, class sql.NullInt64
		var manual int
		if err := rows.Scan(&l.id, &itemID, &l.category, &rate, &qty, &l.amount, &l.wageBase, &l.subject, &l.computed,
			&job, &class, &manual); err != nil {
			return nil, err
		}
		l.item = all[itemID]
		if l.item == nil {
			l.item = &model.PayrollItem{ID: itemID, Name: "(deleted item)"}
		}
		if rate.Valid {
			l.rate = fptr(rate.Float64)
		}
		if qty.Valid {
			l.qty = fptr(qty.Float64)
		}
		l.job, l.class, l.manual = store.PtrID(job), store.PtrID(class), manual == 1
		out = append(out, l)
	}
	return out, rows.Err()
}

func nullF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

// writeLines replaces the lines of a paycheck.
func writeLines(ctx context.Context, tx *sql.Tx, id int64, lines []*cline) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM paycheck_lines WHERE paycheck_id = ?`, id); err != nil {
		return err
	}
	for i, l := range lines {
		if _, err := tx.ExecContext(ctx, `INSERT INTO paycheck_lines(paycheck_id, seq, item_id, category, rate, qty, amount, wage_base,
			subject_wages, computed, job_name_id, class_id, manual) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, i+1, l.item.ID, l.category, nullF(l.rate), nullF(l.qty), l.amount, l.wageBase, l.subject, l.computed,
			store.NullID(l.job), store.NullID(l.class), store.B(l.manual)); err != nil {
			return err
		}
	}
	return nil
}

// insertPaycheck saves a calculated paycheck (header from r.pc) and its lines.
func insertPaycheck(ctx context.Context, tx *sql.Tx, r *calcResult, runID *int64, user, syncStatus string) (int64, error) {
	p := &r.pc.PaycheckInput
	now := store.Now()
	res, err := tx.ExecContext(ctx, `INSERT INTO paychecks(run_id, kind, employee_id, period_start, period_end, check_date,
		bank_account_id, check_number, to_be_printed, direct_deposit, memo, class_id, gross, not_paid, deductions, employee_taxes,
		net, employer_taxes, contributions, total_hours, sick_accrued, sick_used, vac_accrued, vac_used, no_accrual, inputs,
		sync_status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		store.NullID(runID), p.Kind, p.EmployeeID, p.PeriodStart, p.PeriodEnd, p.CheckDate,
		store.NullID(p.BankAccountID), p.CheckNumber, store.B(p.ToBePrinted), store.B(p.DirectDeposit), p.Memo, store.NullID(p.ClassID),
		r.gross, r.notPaid, r.ded, r.eeTax, r.net, r.erTax, r.contrib, r.hours, r.sickAcc, r.sickUsed, r.vacAcc, r.vacUsed,
		store.B(p.NoAccrual), store.JSONText(r.inputs), syncStatus, user, now, now)
	if err != nil {
		return 0, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	return id, writeLines(ctx, tx, id, r.lines)
}

// updatePaycheck replaces a saved paycheck with a new calculation.
func updatePaycheck(ctx context.Context, tx *sql.Tx, id int64, r *calcResult) error {
	p := &r.pc.PaycheckInput
	_, err := tx.ExecContext(ctx, `UPDATE paychecks SET period_start = ?, period_end = ?, check_date = ?, bank_account_id = ?,
		check_number = ?, to_be_printed = ?, direct_deposit = ?, memo = ?, class_id = ?, gross = ?, not_paid = ?, deductions = ?,
		employee_taxes = ?, net = ?, employer_taxes = ?, contributions = ?, total_hours = ?, sick_accrued = ?, sick_used = ?,
		vac_accrued = ?, vac_used = ?, no_accrual = ?, inputs = ?, updated_at = ? WHERE id = ?`,
		p.PeriodStart, p.PeriodEnd, p.CheckDate, store.NullID(p.BankAccountID), p.CheckNumber, store.B(p.ToBePrinted),
		store.B(p.DirectDeposit), p.Memo, store.NullID(p.ClassID), r.gross, r.notPaid, r.ded, r.eeTax, r.net, r.erTax, r.contrib,
		r.hours, r.sickAcc, r.sickUsed, r.vacAcc, r.vacUsed, store.B(p.NoAccrual), store.JSONText(r.inputs), store.Now(), id)
	if err != nil {
		return err
	}
	return writeLines(ctx, tx, id, r.lines)
}

// get loads a saved paycheck with its lines, YTD columns, summaries and PTO.
func get(ctx context.Context, q store.Q, id int64) (*model.Paycheck, error) {
	h, err := loadHeader(ctx, q, id)
	if err != nil {
		return nil, err
	}
	all, err := items.All(ctx, q)
	if err != nil {
		return nil, err
	}
	lines, err := loadLines(ctx, q, all, id)
	if err != nil {
		return nil, err
	}
	y, err := loadYTD(ctx, q, all, h.EmployeeID, h.CheckDate, id)
	if err != nil {
		return nil, err
	}
	pc := h.Paycheck
	fillOutput(&pc, lines, y)
	for i, kind := range []string{"sick", "vacation"} {
		before, _, _, err := employees.PTOBalance(ctx, q, h.EmployeeID, kind, h.CheckDate, id)
		if err != nil {
			return nil, err
		}
		acc, used := h.sickAcc, h.sickUsed
		if i == 1 {
			acc, used = h.vacAcc, h.vacUsed
		}
		snap := model.PTOSnapshot{AvailableBefore: round4(before), Accrued: acc, Used: used, AvailableAfter: round4(before + acc - used)}
		if i == 0 {
			pc.Sick = snap
		} else {
			pc.Vacation = snap
		}
	}
	var in struct {
		Warnings []string `json:"warnings"`
	}
	if json.Unmarshal([]byte(h.inputs), &in) == nil && in.Warnings != nil {
		pc.Warnings = in.Warnings
	}
	if pc.Voided {
		pc.Warnings = []string{"This paycheck is void."}
	}
	return &pc, nil
}

// ---------------------------------------------------------------------------
// Paycheck lists

const summaryCols = `p.id, p.run_id, p.kind, p.employee_id, e.display_name, p.period_start, p.period_end, p.check_date,
	p.check_number, p.to_be_printed, p.direct_deposit, p.bank_account_id, p.gross, p.employee_taxes, p.deductions, p.net,
	p.employer_taxes, p.contributions, p.total_hours, p.memo, p.voided, p.books_txn_id, p.sync_status, p.sync_error`

func scanSummary(s scanner) (model.PaycheckSummary, error) {
	var p model.PaycheckSummary
	var run, bank, txn sql.NullInt64
	var toBePrinted, dd, voided int
	var gross, taxes, ded, net, erTax, contrib int64
	err := s.Scan(&p.ID, &run, &p.Kind, &p.EmployeeID, &p.EmployeeName, &p.PeriodStart, &p.PeriodEnd, &p.CheckDate,
		&p.CheckNumber, &toBePrinted, &dd, &bank, &gross, &taxes, &ded, &net, &erTax, &contrib, &p.TotalHours, &p.Memo, &voided,
		&txn, &p.SyncStatus, &p.SyncError)
	if err != nil {
		return p, err
	}
	p.RunID, p.BankAccountID, p.BooksTxnID = store.PtrID(run), store.PtrID(bank), store.PtrID(txn)
	p.ToBePrinted, p.DirectDeposit, p.Voided = toBePrinted == 1, dd == 1, voided == 1
	p.Gross, p.EmployeeTaxes, p.Deductions, p.Net = store.Dollars(gross), store.Dollars(taxes), store.Dollars(ded), store.Dollars(net)
	p.EmployerTaxes, p.Contributions = store.Dollars(erTax), store.Dollars(contrib)
	return p, nil
}

// listSummaries returns paycheck summaries matching where (SQL on p and e).
func listSummaries(ctx context.Context, q store.Q, where []string, args []any, order string) ([]model.PaycheckSummary, error) {
	query := `SELECT ` + summaryCols + ` FROM paychecks p JOIN employees e ON e.id = p.employee_id`
	if len(where) > 0 {
		query += ` WHERE ` + strings.Join(where, " AND ")
	}
	rows, err := q.QueryContext(ctx, query+` ORDER BY `+order, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.PaycheckSummary{}
	for rows.Next() {
		p, err := scanSummary(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func summaryByID(ctx context.Context, q store.Q, id int64) (model.PaycheckSummary, error) {
	list, err := listSummaries(ctx, q, []string{"p.id = ?"}, []any{id}, "p.id")
	if err != nil {
		return model.PaycheckSummary{}, err
	}
	if len(list) == 0 {
		return model.PaycheckSummary{}, apperr.NotFound("Paycheck not found.")
	}
	return list[0], nil
}

// auditView is the paycheck as recorded in the audit trail.
func auditView(pc *model.Paycheck) map[string]any {
	lines := []map[string]any{}
	for _, l := range pc.Lines {
		m := map[string]any{"item": l.ItemName, "amount": l.Amount}
		if l.Qty != nil {
			m["qty"] = *l.Qty
		}
		if l.Rate != nil {
			m["rate"] = *l.Rate
		}
		if l.Manual {
			m["manual"] = true
		}
		lines = append(lines, m)
	}
	return map[string]any{
		"employee": pc.EmployeeName, "kind": pc.Kind, "checkDate": pc.CheckDate, "periodStart": pc.PeriodStart,
		"periodEnd": pc.PeriodEnd, "checkNumber": pc.CheckNumber, "toBePrinted": pc.ToBePrinted,
		"directDeposit": pc.DirectDeposit, "bankAccountId": pc.BankAccountID, "memo": pc.Memo, "gross": pc.Gross,
		"employeeTaxes": pc.EmployeeTaxes, "deductions": pc.Deductions, "net": pc.Net, "employerTaxes": pc.EmployerTaxes,
		"contributions": pc.Contributions, "voided": pc.Voided, "lines": lines,
	}
}
