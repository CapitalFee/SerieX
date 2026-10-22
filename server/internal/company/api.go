package company

// Exported helpers for other packages (the sample company generator): the
// same validation and storage as the HTTP routes, inside a caller's write
// transaction.

import (
	"context"
	"database/sql"
	"encoding/json"

	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// CreateMemorized stores a new memorized transaction (POST /memorized).
func CreateMemorized(ctx context.Context, tx *sql.Tx, m *model.MemorizedTxn) (int64, error) {
	if err := validateMemorized(ctx, tx, m, 0); err != nil {
		return 0, err
	}
	tmpl, _ := json.Marshal(m.Template)
	res, err := tx.ExecContext(ctx, `INSERT INTO memorized_txns(name, txn_type, template, schedule, frequency, next_date,
		days_in_advance, remaining, group_name, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		m.Name, m.TxnType, string(tmpl), m.Schedule, m.Frequency, m.NextDate, m.DaysInAdvance, remainingArg(m.Remaining), m.GroupName, store.Now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// EnterMemorized saves one transaction from memorized transaction id dated
// date and moves its schedule forward (POST /memorized/{id}/enter).
func EnterMemorized(ctx context.Context, tx *sql.Tx, id int64, date string, opt ledger.SaveOptions) (int64, error) {
	m, err := loadMemorized(ctx, tx, id)
	if err != nil {
		return 0, err
	}
	txnID, _, err := enterMemorized(ctx, tx, m, date, opt)
	return txnID, err
}

// CreateBudget stores a new budget with its lines (POST /budgets).
func CreateBudget(ctx context.Context, tx *sql.Tx, b *model.Budget) (int64, error) {
	if err := validateBudget(ctx, tx, b, 0); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO budgets(name, fiscal_year, kind, criteria, created_at) VALUES(?,?,?,?,?)`,
		b.Name, b.FiscalYear, b.Kind, b.Criteria, store.Now())
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, saveBudgetLines(ctx, tx, id, b.Lines)
}

// CreateTodo stores a new to do (POST /todos).
func CreateTodo(ctx context.Context, tx *sql.Tx, t *model.Todo) (int64, error) {
	if err := validateTodo(ctx, tx, t); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO todos(title, notes, due_date, name_id, done, created_at) VALUES(?,?,?,?,?,?)`,
		t.Title, t.Notes, t.DueDate, store.NullID(t.NameID), store.B(t.Done), store.Now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Verify runs the company file checks (POST /verify) and returns the problems found.
func Verify(ctx context.Context, q store.Q) ([]string, error) {
	v := &verifier{ctx: ctx, q: q, problems: []string{}}
	if err := v.run(); err != nil {
		return nil, err
	}
	return v.problems, nil
}
