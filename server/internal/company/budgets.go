package company

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// ---------------------------------------------------------------------------
// Budgets

func registerBudgets(rt *httpx.Router) {
	rt.C("GET", "/budgets", listBudgets)
	rt.C("POST", "/budgets", createBudget)
	rt.C("GET", "/budgets/{id}", getBudget)
	rt.C("PUT", "/budgets/{id}", updateBudget)
	rt.C("DELETE", "/budgets/{id}", deleteBudget)
}

func loadBudgets(ctx context.Context, q store.Q, where string, args ...any) ([]model.Budget, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, fiscal_year, kind, criteria FROM budgets `+where+` ORDER BY fiscal_year DESC, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Budget{}
	idx := map[int64]int{}
	for rows.Next() {
		var b model.Budget
		if err := rows.Scan(&b.ID, &b.Name, &b.FiscalYear, &b.Kind, &b.Criteria); err != nil {
			return nil, err
		}
		b.Lines = []model.BudgetLine{}
		idx[b.ID] = len(out)
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(out) == 0 {
		return out, nil
	}
	lrows, err := q.QueryContext(ctx, `SELECT l.budget_id, l.account_id, l.class_id, l.name_id, l.amounts
		FROM budget_lines l WHERE l.budget_id IN (SELECT id FROM budgets `+where+`) ORDER BY l.budget_id, l.id`, args...)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var budgetID int64
		var l model.BudgetLine
		var classID, nameID sql.NullInt64
		var amounts string
		if err := lrows.Scan(&budgetID, &l.AccountID, &classID, &nameID, &amounts); err != nil {
			return nil, err
		}
		i, ok := idx[budgetID]
		if !ok {
			continue
		}
		l.ClassID = store.PtrID(classID)
		l.NameID = store.PtrID(nameID)
		var cents []int64
		json.Unmarshal([]byte(amounts), &cents)
		for m := 0; m < 12 && m < len(cents); m++ {
			l.Amounts[m] = store.Dollars(cents[m])
		}
		out[i].Lines = append(out[i].Lines, l)
	}
	return out, lrows.Err()
}

func loadBudget(ctx context.Context, q store.Q, id int64) (model.Budget, error) {
	bs, err := loadBudgets(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.Budget{}, err
	}
	if len(bs) == 0 {
		return model.Budget{}, apperr.NotFound("Budget not found.")
	}
	return bs[0], nil
}

func validateBudget(ctx context.Context, q store.Q, b *model.Budget, exceptID int64) error {
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" {
		return apperr.Validation("name", "Please enter a name for the budget.")
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM budgets WHERE name = ? AND id <> ?`, b.Name, exceptID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apperr.Validation("name", "A budget named %q already exists. Please choose a different name.", b.Name)
	}
	if b.FiscalYear < 1900 || b.FiscalYear > 2999 {
		return apperr.Validation("fiscalYear", "Please enter a valid fiscal year.")
	}
	if b.Kind == "" {
		b.Kind = "pl"
	}
	if !oneOf(b.Kind, "pl", "bs") {
		return apperr.Validation("kind", "Invalid budget type %q.", b.Kind)
	}
	if b.Criteria == "" {
		b.Criteria = "none"
	}
	if !oneOf(b.Criteria, "none", "class", "customer") {
		return apperr.Validation("criteria", "Invalid budget criteria %q.", b.Criteria)
	}
	if b.Lines == nil {
		b.Lines = []model.BudgetLine{}
	}
	for i := range b.Lines {
		l := &b.Lines[i]
		var typ string
		err := q.QueryRowContext(ctx, `SELECT type FROM accounts WHERE id = ?`, l.AccountID).Scan(&typ)
		if err == sql.ErrNoRows {
			return apperr.Validation("lines", "Budget line %d: the account does not exist.", i+1)
		}
		if err != nil {
			return err
		}
		if b.Kind == "pl" && !model.IsProfitLoss(typ) {
			return apperr.Validation("lines", "Budget line %d: a Profit and Loss budget can only contain income and expense accounts.", i+1)
		}
		if b.Kind == "bs" && !model.IsBalanceSheet(typ) {
			return apperr.Validation("lines", "Budget line %d: a Balance Sheet budget can only contain balance sheet accounts.", i+1)
		}
		if l.ClassID != nil && *l.ClassID == 0 {
			l.ClassID = nil
		}
		if l.NameID != nil && *l.NameID == 0 {
			l.NameID = nil
		}
		if b.Criteria != "class" {
			l.ClassID = nil
		}
		if b.Criteria != "customer" {
			l.NameID = nil
		}
		for m := range l.Amounts {
			if err := store.MoneyErr("lines", "Budget line "+strconv.Itoa(i+1)+": an amount", l.Amounts[m]); err != nil {
				return err
			}
			l.Amounts[m] = store.Round2(l.Amounts[m])
		}
	}
	return nil
}

func saveBudgetLines(ctx context.Context, tx *sql.Tx, id int64, lines []model.BudgetLine) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM budget_lines WHERE budget_id = ?`, id); err != nil {
		return err
	}
	for _, l := range lines {
		cents := make([]int64, 12)
		for m := 0; m < 12; m++ {
			cents[m] = store.Cents(l.Amounts[m])
		}
		a, _ := json.Marshal(cents)
		if _, err := tx.ExecContext(ctx, `INSERT INTO budget_lines(budget_id, account_id, class_id, name_id, amounts) VALUES(?,?,?,?,?)`,
			id, l.AccountID, store.NullID(l.ClassID), store.NullID(l.NameID), string(a)); err != nil {
			return err
		}
	}
	return nil
}

func listBudgets(c *httpx.Ctx) error {
	bs, err := loadBudgets(c.Context(), c.DB, "")
	if err != nil {
		return err
	}
	return c.JSON(bs)
}

func getBudget(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	b, err := loadBudget(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	return c.JSON(b)
}

func createBudget(c *httpx.Ctx) error {
	var b model.Budget
	if err := c.Decode(&b); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.Budget
	err := c.Write(func(tx *sql.Tx) error {
		if err := validateBudget(ctx, tx, &b, 0); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO budgets(name, fiscal_year, kind, criteria, created_at) VALUES(?,?,?,?,?)`,
			b.Name, b.FiscalYear, b.Kind, b.Criteria, store.Now())
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		if err := saveBudgetLines(ctx, tx, id, b.Lines); err != nil {
			return err
		}
		out, err = loadBudget(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

// PUT /budgets/{id}: header fields and lines are replaced by the body.
func updateBudget(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var b model.Budget
	if err := c.Decode(&b); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.Budget
	err = c.Write(func(tx *sql.Tx) error {
		if _, err := loadBudget(ctx, tx, id); err != nil {
			return err
		}
		if err := validateBudget(ctx, tx, &b, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE budgets SET name = ?, fiscal_year = ?, kind = ?, criteria = ? WHERE id = ?`,
			b.Name, b.FiscalYear, b.Kind, b.Criteria, id); err != nil {
			return err
		}
		if err := saveBudgetLines(ctx, tx, id, b.Lines); err != nil {
			return err
		}
		out, err = loadBudget(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func deleteBudget(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		ctx := c.Context()
		if _, err := tx.ExecContext(ctx, `DELETE FROM budget_lines WHERE budget_id = ?`, id); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM budgets WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("Budget not found.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}

// ---------------------------------------------------------------------------
// To Do notes

func registerTodos(rt *httpx.Router) {
	rt.C("GET", "/todos", listTodos)
	rt.C("POST", "/todos", createTodo)
	rt.C("PUT", "/todos/{id}", updateTodo)
	rt.C("DELETE", "/todos/{id}", deleteTodo)
}

func loadTodos(ctx context.Context, q store.Q, where string, args ...any) ([]model.Todo, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, title, notes, due_date, name_id, done FROM todos `+where+`
		ORDER BY done, CASE WHEN due_date = '' THEN 1 ELSE 0 END, due_date, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Todo{}
	for rows.Next() {
		var t model.Todo
		var nameID sql.NullInt64
		if err := rows.Scan(&t.ID, &t.Title, &t.Notes, &t.DueDate, &nameID, &t.Done); err != nil {
			return nil, err
		}
		t.NameID = store.PtrID(nameID)
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadTodo(ctx context.Context, q store.Q, id int64) (model.Todo, error) {
	ts, err := loadTodos(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.Todo{}, err
	}
	if len(ts) == 0 {
		return model.Todo{}, apperr.NotFound("To Do not found.")
	}
	return ts[0], nil
}

func validateTodo(ctx context.Context, q store.Q, t *model.Todo) error {
	t.Title = strings.TrimSpace(t.Title)
	if t.Title == "" {
		return apperr.Validation("title", "Please enter the To Do text.")
	}
	t.DueDate = strings.TrimSpace(t.DueDate)
	if t.DueDate != "" && !store.ValidDate(t.DueDate) {
		return apperr.Validation("dueDate", "Please enter a valid due date.")
	}
	if t.NameID != nil && *t.NameID == 0 {
		t.NameID = nil
	}
	if t.NameID != nil {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM names WHERE id = ?`, *t.NameID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return apperr.Validation("nameId", "The selected name does not exist.")
		}
	}
	return nil
}

func listTodos(c *httpx.Ctx) error {
	where, args := "", []any{}
	switch c.Q("status") {
	case "open":
		where = "WHERE done = 0"
	case "done":
		where = "WHERE done = 1"
	}
	if id := c.QInt("nameId"); id > 0 {
		if where == "" {
			where = "WHERE name_id = ?"
		} else {
			where += " AND name_id = ?"
		}
		args = append(args, id)
	}
	ts, err := loadTodos(c.Context(), c.DB, where, args...)
	if err != nil {
		return err
	}
	return c.JSON(ts)
}

func createTodo(c *httpx.Ctx) error {
	var t model.Todo
	if err := c.Decode(&t); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.Todo
	err := c.Write(func(tx *sql.Tx) error {
		if err := validateTodo(ctx, tx, &t); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO todos(title, notes, due_date, name_id, done, created_at) VALUES(?,?,?,?,?,?)`,
			t.Title, t.Notes, t.DueDate, store.NullID(t.NameID), store.B(t.Done), store.Now())
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		out, err = loadTodo(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

func updateTodo(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out model.Todo
	err = c.Write(func(tx *sql.Tx) error {
		t, err := loadTodo(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := c.Decode(&t); err != nil {
			return err
		}
		if err := validateTodo(ctx, tx, &t); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE todos SET title = ?, notes = ?, due_date = ?, name_id = ?, done = ? WHERE id = ?`,
			t.Title, t.Notes, t.DueDate, store.NullID(t.NameID), store.B(t.Done), id); err != nil {
			return err
		}
		out, err = loadTodo(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func deleteTodo(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		res, err := tx.ExecContext(c.Context(), `DELETE FROM todos WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("To Do not found.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}
