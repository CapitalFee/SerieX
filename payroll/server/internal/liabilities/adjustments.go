package liabilities

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

const adjustmentCols = `a.id, a.date, a.effective_date, a.employee_id, a.memo, a.affects_accounts, a.class_id, a.books_txn_id,
	a.sync_status, a.sync_error, a.created_by, a.created_at, IFNULL(e.display_name, '')`

func scanAdjustment(s interface{ Scan(...any) error }) (*model.LiabilityAdjustment, error) {
	a := &model.LiabilityAdjustment{Lines: []model.LiabilityAdjustmentLine{}}
	var emp, class, txn sql.NullInt64
	err := s.Scan(&a.ID, &a.Date, &a.EffectiveDate, &emp, &a.Memo, &a.AffectsAccounts, &class, &txn,
		&a.SyncStatus, &a.SyncError, &a.CreatedBy, &a.CreatedAt, &a.EmployeeName)
	if err != nil {
		return nil, err
	}
	a.EmployeeID, a.ClassID, a.BooksTxnID = store.PtrID(emp), store.PtrID(class), store.PtrID(txn)
	return a, nil
}

func loadAdjustmentLines(ctx context.Context, q store.Q, list []*model.LiabilityAdjustment) error {
	if len(list) == 0 {
		return nil
	}
	byID := map[int64]*model.LiabilityAdjustment{}
	ids := make([]string, 0, len(list))
	for _, a := range list {
		byID[a.ID] = a
		ids = append(ids, strconv.FormatInt(a.ID, 10))
	}
	rows, err := q.QueryContext(ctx, `SELECT l.adjustment_id, l.item_id, l.amount, l.wage_base, l.memo, IFNULL(i.name, '')
		FROM liability_adjustment_lines l LEFT JOIN payroll_items i ON i.id = l.item_id
		WHERE l.adjustment_id IN (`+strings.Join(ids, ",")+`) ORDER BY l.adjustment_id, l.seq, l.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var aid, amt, wb int64
		var l model.LiabilityAdjustmentLine
		if err := rows.Scan(&aid, &l.ItemID, &amt, &wb, &l.Memo, &l.ItemName); err != nil {
			return err
		}
		l.Amount, l.WageBase = store.Dollars(amt), store.Dollars(wb)
		if a := byID[aid]; a != nil {
			a.Lines = append(a.Lines, l)
		}
	}
	return rows.Err()
}

func loadAdjustment(ctx context.Context, q store.Q, id int64) (*model.LiabilityAdjustment, error) {
	a, err := scanAdjustment(q.QueryRowContext(ctx, `SELECT `+adjustmentCols+` FROM liability_adjustments a
		LEFT JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Tax balance adjustment not found.")
	}
	if err != nil {
		return nil, err
	}
	if err := loadAdjustmentLines(ctx, q, []*model.LiabilityAdjustment{a}); err != nil {
		return nil, err
	}
	return a, nil
}

// GET /liability-adjustments?from&to&employeeId (by adjustment date, newest first)
func listAdjustmentsRoute(c *httpx.Ctx) error {
	from, to, err := rangeParams(c)
	if err != nil {
		return err
	}
	where := []string{"1 = 1"}
	var args []any
	dateFilter("a.date", from, to, &where, &args)
	if v := c.QInt("employeeId"); v > 0 {
		where = append(where, "a.employee_id = ?")
		args = append(args, v)
	}
	ctx := c.Context()
	rows, err := c.DB.QueryContext(ctx, `SELECT `+adjustmentCols+` FROM liability_adjustments a
		LEFT JOIN employees e ON e.id = a.employee_id WHERE `+strings.Join(where, " AND ")+` ORDER BY a.date DESC, a.id DESC`, args...)
	if err != nil {
		return err
	}
	list := []*model.LiabilityAdjustment{}
	for rows.Next() {
		a, err := scanAdjustment(rows)
		if err != nil {
			rows.Close()
			return err
		}
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := loadAdjustmentLines(ctx, c.DB, list); err != nil {
		return err
	}
	return c.JSON(list)
}

func getAdjustmentRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	a, err := loadAdjustment(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	return c.JSON(a)
}

type adjLine struct {
	ItemID   int64
	Amount   int64
	WageBase int64
	Memo     string
}

type adjustmentRecord struct {
	Date            string
	EffectiveDate   string
	EmployeeID      *int64
	EmployeeName    string
	Memo            string
	AffectsAccounts bool
	ClassID         *int64
	Lines           []adjLine
}

// posts reports whether the adjustment creates a SerieX Books journal entry.
func (r *adjustmentRecord) posts() bool {
	if !r.AffectsAccounts {
		return false
	}
	for _, l := range r.Lines {
		if l.Amount != 0 {
			return true
		}
	}
	return false
}

func validateAdjustment(c *httpx.Ctx, in *model.LiabilityAdjustment) (*adjustmentRecord, error) {
	ctx := c.Context()
	r := &adjustmentRecord{
		Date: strings.TrimSpace(in.Date), EffectiveDate: strings.TrimSpace(in.EffectiveDate), EmployeeID: in.EmployeeID,
		Memo: strings.TrimSpace(in.Memo), AffectsAccounts: in.AffectsAccounts, ClassID: in.ClassID,
	}
	if !store.ValidDate(r.Date) {
		return nil, apperr.Validation("date", "Please enter a valid adjustment date.")
	}
	if r.EffectiveDate == "" {
		r.EffectiveDate = r.Date
	}
	if !store.ValidDate(r.EffectiveDate) {
		return nil, apperr.Validation("effectiveDate", "Please enter a valid effective date.")
	}
	if r.EmployeeID != nil && *r.EmployeeID <= 0 {
		r.EmployeeID = nil
	}
	if r.ClassID != nil && *r.ClassID <= 0 {
		r.ClassID = nil
	}
	if r.EmployeeID != nil {
		err := c.DB.QueryRowContext(ctx, `SELECT display_name FROM employees WHERE id = ?`, *r.EmployeeID).Scan(&r.EmployeeName)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, apperr.Validation("employeeId", "The employee does not exist.")
		}
		if err != nil {
			return nil, err
		}
	}
	its, err := liabilityItems(ctx, c.DB)
	if err != nil {
		return nil, err
	}
	for i, l := range in.Lines {
		field := fmt.Sprintf("lines[%d]", i)
		amt, wb := store.Cents(l.Amount), store.Cents(l.WageBase)
		if l.ItemID <= 0 {
			if amt == 0 && wb == 0 {
				continue
			}
			return nil, apperr.Validation(field, "Choose the payroll item of every adjustment line.")
		}
		it := its[l.ItemID]
		if it == nil {
			return nil, apperr.Validation(field, "Payroll item #%d is not a tax, deduction or company contribution item.", l.ItemID)
		}
		if amt == 0 && wb == 0 {
			continue
		}
		if wb != 0 && r.EmployeeID == nil {
			return nil, apperr.Validation(field, "Income subject to tax (%s) can only be adjusted for an employee.", it.Name)
		}
		r.Lines = append(r.Lines, adjLine{ItemID: it.ID, Amount: amt, WageBase: wb, Memo: strings.TrimSpace(l.Memo)})
	}
	if len(r.Lines) == 0 {
		return nil, apperr.Validation("lines", "Enter at least one amount or wage base to adjust.")
	}
	if r.ClassID != nil {
		lk := booksLookup(c, func(lk *posting.Lookups) bool {
			_, ok := lk.Classes[*r.ClassID]
			return ok
		})
		if lk.OK {
			if _, ok := lk.Classes[*r.ClassID]; !ok {
				return nil, apperr.Validation("classId", "The class does not exist in SerieX Books.")
			}
		}
	}
	return r, nil
}

func insertAdjustmentLines(ctx context.Context, tx *sql.Tx, id int64, lines []adjLine) error {
	for i, l := range lines {
		if _, err := tx.ExecContext(ctx, `INSERT INTO liability_adjustment_lines(adjustment_id, seq, item_id, amount, wage_base, memo)
			VALUES(?,?,?,?,?,?)`, id, i+1, l.ItemID, l.Amount, l.WageBase, l.Memo); err != nil {
			return err
		}
	}
	return nil
}

func adjustmentSummary(r *adjustmentRecord) string {
	who := "Company"
	if r.EmployeeID != nil {
		who = r.EmployeeName
	}
	var total int64
	for _, l := range r.Lines {
		total += l.Amount
	}
	return fmt.Sprintf("Tax balance adjustment - %s %s on %s (effective %s)", who, fmtMoney(total), mdy(r.Date), mdy(r.EffectiveDate))
}

// POST /liability-adjustments, PUT /liability-adjustments/{id}
func saveAdjustmentRoute(c *httpx.Ctx, id int64) error {
	var in model.LiabilityAdjustment
	if err := c.Decode(&in); err != nil {
		return err
	}
	ctx := c.Context()
	var before *model.LiabilityAdjustment
	if id != 0 {
		var err error
		if before, err = loadAdjustment(ctx, c.DB, id); err != nil {
			return err
		}
	}
	r, err := validateAdjustment(c, &in)
	if err != nil {
		return err
	}
	status := "none"
	if r.posts() {
		status = "pending"
	}
	err = c.Write(func(tx *sql.Tx) error {
		now := store.Now()
		if id == 0 {
			res, err := tx.ExecContext(ctx, `INSERT INTO liability_adjustments(date, effective_date, employee_id, memo, affects_accounts,
				class_id, sync_status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, r.Date, r.EffectiveDate,
				store.NullID(r.EmployeeID), r.Memo, store.B(r.AffectsAccounts), store.NullID(r.ClassID), status, c.User, now, now)
			if err != nil {
				return err
			}
			if id, err = res.LastInsertId(); err != nil {
				return err
			}
			if err := insertAdjustmentLines(ctx, tx, id, r.Lines); err != nil {
				return err
			}
			return store.Audit(ctx, tx, c.User, "add", posting.EntityAdjustment, id, adjustmentSummary(r), r)
		}
		res, err := tx.ExecContext(ctx, `UPDATE liability_adjustments SET date = ?, effective_date = ?, employee_id = ?, memo = ?,
			affects_accounts = ?, class_id = ?, updated_at = ? WHERE id = ?`, r.Date, r.EffectiveDate, store.NullID(r.EmployeeID),
			r.Memo, store.B(r.AffectsAccounts), store.NullID(r.ClassID), now, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("Tax balance adjustment not found.")
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM liability_adjustment_lines WHERE adjustment_id = ?`, id); err != nil {
			return err
		}
		if err := insertAdjustmentLines(ctx, tx, id, r.Lines); err != nil {
			return err
		}
		return store.Audit(ctx, tx, c.User, "modify", posting.EntityAdjustment, id, adjustmentSummary(r),
			map[string]any{"before": before, "after": r})
	})
	if err != nil {
		return err
	}
	// new adjustments that change accounts are posted; an edited one is
	// re-posted, or its journal entry is removed when it no longer affects accounts
	if status == "pending" || before != nil {
		if _, err := posting.PostAdjustment(c, id, books.Opts(c)); err != nil {
			return err
		}
	}
	a, err := loadAdjustment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	return c.JSON(a)
}

// DELETE /liability-adjustments/{id}: the Books journal entry is deleted first.
func deleteAdjustmentRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	a, err := loadAdjustment(ctx, c.DB, id)
	if err != nil {
		return err
	}
	// Books delete + payroll delete under the adjustment's posting lock (a
	// Books Sync retry cannot post it again in between)
	err = posting.WithRecordLock(c, posting.EntityAdjustment, id, func(c *httpx.Ctx) error {
		if err := posting.Unpost(c, posting.EntityAdjustment, id, "delete", books.Opts(c)); err != nil {
			return err
		}
		return c.Write(func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, `DELETE FROM liability_adjustments WHERE id = ?`, id)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n == 0 {
				return apperr.NotFound("Tax balance adjustment not found.")
			}
			who := a.EmployeeName
			if who == "" {
				who = "Company"
			}
			return store.Audit(ctx, tx, c.User, "delete", posting.EntityAdjustment, id,
				fmt.Sprintf("Tax balance adjustment - %s on %s", who, mdy(a.Date)), a)
		})
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}
