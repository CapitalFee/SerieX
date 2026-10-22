package company

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

var memFrequencies = []string{"never", "daily", "weekly", "biweekly", "semimonthly", "monthly", "quarterly", "semiannually", "annually"}

func registerMemorized(rt *httpx.Router) {
	rt.C("GET", "/memorized", listMemorized)
	rt.C("POST", "/memorized", createMemorized)
	rt.C("POST", "/memorized/process-due", processDueMemorized)
	rt.C("PUT", "/memorized/{id}", updateMemorized)
	rt.C("DELETE", "/memorized/{id}", deleteMemorized)
	rt.C("POST", "/memorized/{id}/enter", enterMemorizedRoute)
	rt.C("POST", "/memorized/{id}/advance", advanceMemorizedRoute)
	rt.C("GET", "/memorized/{id}/template", memorizedTemplate)
}

// readBody decodes the JSON body into v. reset is called first with the
// top-level keys of the body so nested values (slices, maps) the body replaces
// can be cleared instead of being merged into.
func readBody(r *http.Request, v any, reset func(keys map[string]json.RawMessage)) error {
	if r.Body == nil {
		return apperr.BadRequest("missing request body")
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
	if err != nil {
		return httpx.BodyError(err)
	}
	keys := map[string]json.RawMessage{}
	if err := json.Unmarshal(b, &keys); err != nil {
		return httpx.BodyError(err)
	}
	if reset != nil {
		reset(keys)
	}
	if err := json.Unmarshal(b, v); err != nil {
		return httpx.BodyError(err)
	}
	return nil
}

// decodeOptional decodes a JSON body when there is one (an empty body is fine).
func decodeOptional(r *http.Request, v any) error {
	if r.Body == nil {
		return nil
	}
	err := json.NewDecoder(r.Body).Decode(v)
	if err != nil && !errors.Is(err, io.EOF) {
		return httpx.BodyError(err)
	}
	return nil
}

// stripTemplate removes everything that belongs to one particular saved
// transaction: ids, number, dates, links and computed values.
func stripTemplate(t *model.Txn) {
	t.ID = 0
	t.RefNumber = ""
	t.Date = ""
	t.DueDate = ""
	t.ShipDate = ""
	t.OpenBalance = 0
	t.Voided = false
	t.Cleared = ""
	t.CreatedBy, t.CreatedAt, t.UpdatedAt = "", "", ""
	t.NameFull = ""
	t.Links = []model.TxnLink{}
	t.Linked = []model.LinkedTxn{}
	if t.Extra == nil {
		t.Extra = map[string]any{}
	}
	if t.Type == model.TxInvoice || t.Type == model.TxBill || t.Type == model.TxEstimate || t.Type == model.TxPurchaseOrder {
		t.Status = ""
	}
	for i := range t.Lines {
		l := &t.Lines[i]
		if l.Kind == "" {
			// a template stored without line kinds (older files): the kind the
			// line gets when the transaction is saved, so forms show the line
			l.Kind = ledger.LineKind(t.Type, l)
		}
		l.ID = 0
		l.Seq = i
		l.BilledTxnID = nil
		l.LinkedTxnID = nil
		l.LinkedLineID = nil
		l.ReceivedQty = 0
		l.Closed = false
		l.Cogs = 0
	}
	if t.Lines == nil {
		t.Lines = []model.TxnLine{}
	}
}

// templateAmount is the total shown in the memorized transaction list.
func templateAmount(t *model.Txn) float64 {
	if t.Amount != 0 {
		return store.Round2(t.Amount)
	}
	var sum int64
	for _, l := range t.Lines {
		a := store.Cents(l.Amount)
		if t.Type == model.TxJournal {
			if a > 0 {
				sum += a
			}
			continue
		}
		sum += a
	}
	if t.Type != model.TxJournal {
		sum += store.Cents(t.TaxAmount) - store.Cents(t.CashBackAmount)
	}
	return store.Dollars(sum)
}

func copyTxn(t model.Txn) model.Txn {
	b, _ := json.Marshal(t)
	var out model.Txn
	json.Unmarshal(b, &out)
	return out
}

func daysIn(y int, m time.Month) int {
	return time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func addMonthsClamped(t time.Time, n int) time.Time {
	first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, n, 0)
	d := t.Day()
	if last := daysIn(first.Year(), first.Month()); d > last {
		d = last
	}
	return time.Date(first.Year(), first.Month(), d, 0, 0, 0, 0, time.UTC)
}

// advanceDate moves a schedule date forward by one period ("" for "never").
func advanceDate(date, freq string) string {
	t, err := store.ParseDate(date)
	if err != nil {
		return ""
	}
	switch freq {
	case "daily":
		t = t.AddDate(0, 0, 1)
	case "weekly":
		t = t.AddDate(0, 0, 7)
	case "biweekly":
		t = t.AddDate(0, 0, 14)
	case "semimonthly":
		// Twice a month, about 15 days apart: day d (<=15) -> d+15 of the same
		// month (capped at month end); day d (>15) -> d-15 of the next month.
		if d := t.Day(); d <= 15 {
			nd := d + 15
			if last := daysIn(t.Year(), t.Month()); nd > last {
				nd = last
			}
			t = time.Date(t.Year(), t.Month(), nd, 0, 0, 0, 0, time.UTC)
		} else {
			first := time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, 1, 0)
			t = time.Date(first.Year(), first.Month(), d-15, 0, 0, 0, 0, time.UTC)
		}
	case "monthly":
		t = addMonthsClamped(t, 1)
	case "quarterly":
		t = addMonthsClamped(t, 3)
	case "semiannually":
		t = addMonthsClamped(t, 6)
	case "annually":
		t = addMonthsClamped(t, 12)
	default:
		return ""
	}
	return t.Format("2006-01-02")
}

const memCols = `id, name, txn_type, template, schedule, frequency, next_date, days_in_advance, remaining, group_name`

func scanMemorized(rows *sql.Rows) (model.MemorizedTxn, error) {
	var m model.MemorizedTxn
	var tmpl string
	var remaining sql.NullInt64
	if err := rows.Scan(&m.ID, &m.Name, &m.TxnType, &tmpl, &m.Schedule, &m.Frequency, &m.NextDate, &m.DaysInAdvance, &remaining, &m.GroupName); err != nil {
		return m, err
	}
	json.Unmarshal([]byte(tmpl), &m.Template)
	if m.Template.Lines == nil {
		m.Template.Lines = []model.TxnLine{}
	}
	if m.Template.Type == "" {
		m.Template.Type = m.TxnType
	}
	for i := range m.Template.Lines {
		if l := &m.Template.Lines[i]; l.Kind == "" {
			l.Kind = ledger.LineKind(m.Template.Type, l)
		}
	}
	if remaining.Valid {
		r := int(remaining.Int64)
		m.Remaining = &r
	}
	m.Amount = templateAmount(&m.Template)
	return m, nil
}

func loadMemorizedList(ctx context.Context, q store.Q, where string, args ...any) ([]model.MemorizedTxn, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+memCols+` FROM memorized_txns `+where+` ORDER BY group_name, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.MemorizedTxn{}
	for rows.Next() {
		m, err := scanMemorized(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func loadMemorized(ctx context.Context, q store.Q, id int64) (model.MemorizedTxn, error) {
	ms, err := loadMemorizedList(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.MemorizedTxn{}, err
	}
	if len(ms) == 0 {
		return model.MemorizedTxn{}, apperr.NotFound("Memorized transaction not found.")
	}
	return ms[0], nil
}

func validateMemorized(ctx context.Context, q store.Q, m *model.MemorizedTxn, exceptID int64) error {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return apperr.Validation("name", "Please enter a name for the memorized transaction.")
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM memorized_txns WHERE name = ? AND id <> ?`, m.Name, exceptID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apperr.Validation("name", "A memorized transaction named %q already exists. Please choose a different name.", m.Name)
	}
	if m.TxnType == "" {
		m.TxnType = m.Template.Type
	}
	if _, ok := model.TxnTypeLabels[m.TxnType]; !ok {
		return apperr.Validation("txnType", "Unknown transaction type %q.", m.TxnType)
	}
	m.Template.Type = m.TxnType
	if m.Schedule == "" {
		m.Schedule = "none"
	}
	if !oneOf(m.Schedule, "none", "remind", "auto") {
		return apperr.Validation("schedule", "Invalid schedule %q.", m.Schedule)
	}
	if m.Frequency == "" {
		m.Frequency = "never"
	}
	if !oneOf(m.Frequency, memFrequencies...) {
		return apperr.Validation("frequency", "Invalid frequency %q.", m.Frequency)
	}
	m.NextDate = strings.TrimSpace(m.NextDate)
	if m.NextDate != "" && !store.ValidDate(m.NextDate) {
		return apperr.Validation("nextDate", "Please enter a valid next date.")
	}
	if m.Schedule != "none" && m.NextDate == "" {
		return apperr.Validation("nextDate", "Please enter the next date for a scheduled memorized transaction.")
	}
	if m.DaysInAdvance < 0 || m.DaysInAdvance > 365 {
		return apperr.Validation("daysInAdvance", "Days in advance must be between 0 and 365.")
	}
	if m.Remaining != nil && *m.Remaining < 0 {
		return apperr.Validation("remaining", "Number remaining cannot be negative.")
	}
	m.GroupName = strings.TrimSpace(m.GroupName)
	stripTemplate(&m.Template)
	return nil
}

func remainingArg(r *int) any {
	if r == nil {
		return nil
	}
	return *r
}

func listMemorized(c *httpx.Ctx) error {
	ms, err := loadMemorizedList(c.Context(), c.DB, "")
	if err != nil {
		return err
	}
	return c.JSON(ms)
}

func createMemorized(c *httpx.Ctx) error {
	var m model.MemorizedTxn
	if err := c.Decode(&m); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.MemorizedTxn
	err := c.Write(func(tx *sql.Tx) error {
		if err := validateMemorized(ctx, tx, &m, 0); err != nil {
			return err
		}
		tmpl, _ := json.Marshal(m.Template)
		res, err := tx.ExecContext(ctx, `INSERT INTO memorized_txns(name, txn_type, template, schedule, frequency, next_date,
			days_in_advance, remaining, group_name, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			m.Name, m.TxnType, string(tmpl), m.Schedule, m.Frequency, m.NextDate, m.DaysInAdvance, remainingArg(m.Remaining), m.GroupName, store.Now())
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		out, err = loadMemorized(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

func updateMemorized(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out model.MemorizedTxn
	err = c.Write(func(tx *sql.Tx) error {
		m, err := loadMemorized(ctx, tx, id)
		if err != nil {
			return err
		}
		// Decode over the stored values; a body without "template" keeps the stored one.
		if err := readBody(c.R, &m, func(keys map[string]json.RawMessage) {
			if _, ok := keys["template"]; ok {
				m.Template = model.Txn{}
			}
		}); err != nil {
			return err
		}
		if err := validateMemorized(ctx, tx, &m, id); err != nil {
			return err
		}
		tmpl, _ := json.Marshal(m.Template)
		if _, err := tx.ExecContext(ctx, `UPDATE memorized_txns SET name = ?, txn_type = ?, template = ?, schedule = ?, frequency = ?,
			next_date = ?, days_in_advance = ?, remaining = ?, group_name = ? WHERE id = ?`,
			m.Name, m.TxnType, string(tmpl), m.Schedule, m.Frequency, m.NextDate, m.DaysInAdvance, remainingArg(m.Remaining), m.GroupName, id); err != nil {
			return err
		}
		out, err = loadMemorized(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func deleteMemorized(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		res, err := tx.ExecContext(c.Context(), `DELETE FROM memorized_txns WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("Memorized transaction not found.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}

// templateFor builds the transaction a memorized template produces for date.
func templateFor(m model.MemorizedTxn, date string) model.Txn {
	t := copyTxn(m.Template)
	stripTemplate(&t)
	t.Type = m.TxnType
	t.Date = date
	return t
}

// enterMemorized saves one transaction from m dated date and moves the
// schedule forward (next date by frequency, one less remaining).
func enterMemorized(ctx context.Context, tx *sql.Tx, m model.MemorizedTxn, date string, opt ledger.SaveOptions) (int64, string, error) {
	t := templateFor(m, date)
	id, err := ledger.Save(ctx, tx, &t, opt)
	if err != nil {
		return 0, "", err
	}
	next, err := advanceMemorized(ctx, tx, m)
	return id, next, err
}

// advanceMemorized moves a memorized transaction's schedule forward (next
// date by frequency, one less remaining) and returns the new next date.
func advanceMemorized(ctx context.Context, tx *sql.Tx, m model.MemorizedTxn) (string, error) {
	next := m.NextDate
	if next != "" {
		if m.Frequency == "never" {
			next = ""
		} else {
			next = advanceDate(next, m.Frequency)
		}
	}
	remaining := m.Remaining
	if remaining != nil && *remaining > 0 {
		r := *remaining - 1
		remaining = &r
	}
	if _, err := tx.ExecContext(ctx, `UPDATE memorized_txns SET next_date = ?, remaining = ? WHERE id = ?`, next, remainingArg(remaining), m.ID); err != nil {
		return "", err
	}
	return next, nil
}

// POST /memorized/{id}/advance (optional body {txnId}) -> {nextDate, remaining}:
// the user entered the reminded transaction through its form (GET
// /memorized/{id}/template), so the schedule moves forward exactly as
// /enter does, without creating a transaction.
func advanceMemorizedRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body struct {
		TxnID int64 `json:"txnId"`
	}
	if err := decodeOptional(c.R, &body); err != nil {
		return err
	}
	ctx := c.Context()
	var next string
	var remaining *int
	err = c.Write(func(tx *sql.Tx) error {
		m, err := loadMemorized(ctx, tx, id)
		if err != nil {
			return err
		}
		if body.TxnID != 0 {
			var typ string
			if err := tx.QueryRowContext(ctx, `SELECT type FROM txns WHERE id = ?`, body.TxnID).Scan(&typ); err != nil {
				return apperr.Validation("txnId", "The transaction entered from this memorized transaction was not found.")
			}
		}
		if m.NextDate == "" {
			return apperr.Conflict("This memorized transaction has no scheduled date to move forward.")
		}
		if next, err = advanceMemorized(ctx, tx, m); err != nil {
			return err
		}
		m2, err := loadMemorized(ctx, tx, id)
		if err != nil {
			return err
		}
		remaining = m2.Remaining
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"nextDate": next, "remaining": remaining})
}

// POST /memorized/{id}/enter body {date?} -> {txnId, nextDate}
func enterMemorizedRoute(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body struct {
		Date string `json:"date"`
	}
	if err := decodeOptional(c.R, &body); err != nil {
		return err
	}
	if body.Date != "" && !store.ValidDate(body.Date) {
		return apperr.Validation("date", "Please enter a valid date.")
	}
	ctx := c.Context()
	var txnID int64
	var next string
	err = c.Write(func(tx *sql.Tx) error {
		m, err := loadMemorized(ctx, tx, id)
		if err != nil {
			return err
		}
		date := body.Date
		if date == "" {
			date = m.NextDate
		}
		if date == "" {
			date = store.Today()
		}
		txnID, next, err = enterMemorized(ctx, tx, m, date, ledger.Options(c))
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"txnId": txnID, "nextDate": next})
}

// GET /memorized/{id}/template?date= -> model.Txn ready to open in a form (id 0).
func memorizedTemplate(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	m, err := loadMemorized(c.Context(), c.DB, id)
	if err != nil {
		return err
	}
	date := c.Q("date")
	if date != "" && !store.ValidDate(date) {
		return apperr.Validation("date", "Please enter a valid date.")
	}
	if date == "" {
		date = m.NextDate
	}
	if date == "" {
		date = store.Today()
	}
	t := templateFor(m, date)
	return c.JSON(t)
}

// POST /memorized/process-due -> {entered, errors}: enters every "auto"
// memorized transaction whose next date is today (+ days in advance) or
// earlier, repeating until each schedule is caught up.
func processDueMemorized(c *httpx.Ctx) error {
	ctx := c.Context()
	ms, err := loadMemorizedList(ctx, c.DB, `WHERE schedule = 'auto' AND next_date <> '' AND (remaining IS NULL OR remaining > 0)`)
	if err != nil {
		return err
	}
	today := store.Today()
	entered := 0
	problems := []string{}
	opt := ledger.SaveOptions{User: c.User}
	for _, first := range ms {
		for i := 0; i < 1000; i++ {
			done := false
			err := c.Write(func(tx *sql.Tx) error {
				m, err := loadMemorized(ctx, tx, first.ID)
				if err != nil {
					return err
				}
				limit := store.AddDays(today, m.DaysInAdvance)
				if m.Schedule != "auto" || m.NextDate == "" || m.NextDate > limit || (m.Remaining != nil && *m.Remaining <= 0) {
					done = true
					return nil
				}
				_, _, err = enterMemorized(ctx, tx, m, m.NextDate, opt)
				return err
			})
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s: %s", first.Name, err.Error()))
				break
			}
			if done {
				break
			}
			entered++
		}
	}
	return c.JSON(map[string]any{"entered": entered, "errors": problems})
}

// ---------------------------------------------------------------------------
// Memorized reports

func registerMemorizedReports(rt *httpx.Router) {
	rt.C("GET", "/memorized-reports", listMemorizedReports)
	rt.C("POST", "/memorized-reports", createMemorizedReport)
	rt.C("PUT", "/memorized-reports/{id}", updateMemorizedReport)
	rt.C("DELETE", "/memorized-reports/{id}", deleteMemorizedReport)
}

func loadMemorizedReports(ctx context.Context, q store.Q, where string, args ...any) ([]model.MemorizedReport, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, report_key, params, group_name FROM memorized_reports `+where+` ORDER BY group_name, name`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.MemorizedReport{}
	for rows.Next() {
		var r model.MemorizedReport
		var params string
		if err := rows.Scan(&r.ID, &r.Name, &r.ReportKey, &params, &r.GroupName); err != nil {
			return nil, err
		}
		r.Params = map[string]string{}
		json.Unmarshal([]byte(params), &r.Params)
		out = append(out, r)
	}
	return out, rows.Err()
}

func loadMemorizedReport(ctx context.Context, q store.Q, id int64) (model.MemorizedReport, error) {
	rs, err := loadMemorizedReports(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.MemorizedReport{}, err
	}
	if len(rs) == 0 {
		return model.MemorizedReport{}, apperr.NotFound("Memorized report not found.")
	}
	return rs[0], nil
}

func validateMemorizedReport(ctx context.Context, q store.Q, r *model.MemorizedReport, exceptID int64) error {
	r.Name = strings.TrimSpace(r.Name)
	r.ReportKey = strings.TrimSpace(r.ReportKey)
	r.GroupName = strings.TrimSpace(r.GroupName)
	if r.Name == "" {
		return apperr.Validation("name", "Please enter a name for the memorized report.")
	}
	if r.ReportKey == "" {
		return apperr.Validation("reportKey", "The report is missing.")
	}
	var n int
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM memorized_reports WHERE name = ? AND id <> ?`, r.Name, exceptID).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return apperr.Validation("name", "A memorized report named %q already exists. Please choose a different name.", r.Name)
	}
	if r.Params == nil {
		r.Params = map[string]string{}
	}
	return nil
}

func listMemorizedReports(c *httpx.Ctx) error {
	rs, err := loadMemorizedReports(c.Context(), c.DB, "")
	if err != nil {
		return err
	}
	return c.JSON(rs)
}

func createMemorizedReport(c *httpx.Ctx) error {
	var r model.MemorizedReport
	if err := c.Decode(&r); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.MemorizedReport
	err := c.Write(func(tx *sql.Tx) error {
		if err := validateMemorizedReport(ctx, tx, &r, 0); err != nil {
			return err
		}
		params, _ := json.Marshal(r.Params)
		res, err := tx.ExecContext(ctx, `INSERT INTO memorized_reports(name, report_key, params, group_name, created_at) VALUES(?,?,?,?,?)`,
			r.Name, r.ReportKey, string(params), r.GroupName, store.Now())
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		out, err = loadMemorizedReport(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

func updateMemorizedReport(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out model.MemorizedReport
	err = c.Write(func(tx *sql.Tx) error {
		r, err := loadMemorizedReport(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := readBody(c.R, &r, func(keys map[string]json.RawMessage) {
			if _, ok := keys["params"]; ok {
				r.Params = nil
			}
		}); err != nil {
			return err
		}
		if err := validateMemorizedReport(ctx, tx, &r, id); err != nil {
			return err
		}
		params, _ := json.Marshal(r.Params)
		if _, err := tx.ExecContext(ctx, `UPDATE memorized_reports SET name = ?, report_key = ?, params = ?, group_name = ? WHERE id = ?`,
			r.Name, r.ReportKey, string(params), r.GroupName, id); err != nil {
			return err
		}
		out, err = loadMemorizedReport(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func deleteMemorizedReport(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		res, err := tx.ExecContext(c.Context(), `DELETE FROM memorized_reports WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("Memorized report not found.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}
