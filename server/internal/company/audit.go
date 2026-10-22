package company

import (
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// localDayStartUTC converts a local YYYY-MM-DD to the RFC3339 UTC timestamp of
// its first second, so it can be compared with audit_log.ts.
func localDayStartUTC(date string) (string, bool) {
	t, err := time.ParseInLocation("2006-01-02", date, time.Local)
	if err != nil {
		return "", false
	}
	return t.UTC().Format(time.RFC3339), true
}

// GET /audit?from&to&user&txnId -> newest first, at most 2000 rows.
func listAudit(c *httpx.Ctx) error {
	if err := store.RequireAdmin(c.Context(), c.DB, c.User, "Only an administrator can view the audit trail."); err != nil {
		return err
	}
	where := []string{"1 = 1"}
	var args []any
	if f := c.Q("from"); f != "" {
		ts, ok := localDayStartUTC(f)
		if !ok {
			return apperr.Validation("from", "Invalid from date.")
		}
		where = append(where, "ts >= ?")
		args = append(args, ts)
	}
	if t := c.Q("to"); t != "" {
		if !store.ValidDate(t) {
			return apperr.Validation("to", "Invalid to date.")
		}
		ts, _ := localDayStartUTC(store.AddDays(t, 1))
		where = append(where, "ts < ?")
		args = append(args, ts)
	}
	if u := strings.TrimSpace(c.Q("user")); u != "" {
		where = append(where, "user = ? COLLATE NOCASE")
		args = append(args, u)
	}
	if id := c.QInt("txnId"); id > 0 {
		where = append(where, "txn_id = ?")
		args = append(args, id)
	}
	if a := strings.TrimSpace(c.Q("action")); a != "" {
		where = append(where, "action = ?")
		args = append(args, a)
	}
	rows, err := c.DB.QueryContext(c.Context(), `SELECT id, ts, user, action, txn_id, txn_type, ref_number, txn_date, name, amount, details
		FROM audit_log WHERE `+strings.Join(where, " AND ")+` ORDER BY ts DESC, id DESC LIMIT 2000`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []model.AuditRow{}
	for rows.Next() {
		var r model.AuditRow
		var txnID sql.NullInt64
		var amount int64
		var details string
		if err := rows.Scan(&r.ID, &r.Ts, &r.User, &r.Action, &txnID, &r.TxnType, &r.RefNumber, &r.TxnDate, &r.Name, &amount, &details); err != nil {
			return err
		}
		r.TxnID = store.PtrID(txnID)
		r.Amount = store.Dollars(amount)
		r.Details = map[string]any{}
		if details != "" {
			json.Unmarshal([]byte(details), &r.Details)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return c.JSON(out)
}
