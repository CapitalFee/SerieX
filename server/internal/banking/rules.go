package banking

import (
	"context"
	"database/sql"
	"net/http"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

func loadRules(ctx context.Context, q store.Q, where string, args ...any) ([]model.BankRule, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, account_id, match_text, direction, rename_to, name_id, target_account_id, priority
		FROM bank_rules `+where+` ORDER BY priority, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.BankRule{}
	for rows.Next() {
		var r model.BankRule
		var acct, name, target sql.NullInt64
		if err := rows.Scan(&r.ID, &r.Name, &acct, &r.MatchText, &r.Direction, &r.RenameTo, &name, &target, &r.Priority); err != nil {
			return nil, err
		}
		r.AccountID, r.NameID, r.TargetAccountID = store.PtrID(acct), store.PtrID(name), store.PtrID(target)
		out = append(out, r)
	}
	return out, rows.Err()
}

func loadRule(ctx context.Context, q store.Q, id int64) (model.BankRule, error) {
	rs, err := loadRules(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.BankRule{}, err
	}
	if len(rs) == 0 {
		return model.BankRule{}, apperr.NotFound("Bank rule not found.")
	}
	return rs[0], nil
}

func validateRule(ctx context.Context, q store.Q, r *model.BankRule) error {
	r.MatchText = strings.TrimSpace(r.MatchText)
	r.Name = strings.TrimSpace(r.Name)
	r.RenameTo = strings.TrimSpace(r.RenameTo)
	if r.MatchText == "" {
		return apperr.Validation("matchText", "Please enter the text the bank description must contain.")
	}
	if r.Name == "" {
		r.Name = r.MatchText
	}
	if r.Direction == "" {
		r.Direction = "any"
	}
	if !oneOf(r.Direction, "any", "in", "out") {
		return apperr.Validation("direction", "Invalid direction %q (any, in or out).", r.Direction)
	}
	for _, p := range []**int64{&r.AccountID, &r.NameID, &r.TargetAccountID} {
		if *p != nil && **p == 0 {
			*p = nil
		}
	}
	if r.AccountID != nil {
		a, err := getAcct(ctx, q, *r.AccountID)
		if err != nil {
			return apperr.Validation("accountId", "The bank account of the rule does not exist.")
		}
		if err := checkFeedAccount(a); err != nil {
			return err
		}
	}
	if r.TargetAccountID != nil {
		a, err := getAcct(ctx, q, *r.TargetAccountID)
		if err != nil {
			return apperr.Validation("targetAccountId", "The account of the rule does not exist.")
		}
		if a.Type == model.AcctAR || a.Type == model.AcctAP {
			return apperr.Validation("targetAccountId", "A bank rule cannot assign Accounts Receivable or Accounts Payable.")
		}
	}
	if r.NameID != nil {
		var n int
		if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM names WHERE id = ?`, *r.NameID).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return apperr.Validation("nameId", "The payee of the rule does not exist.")
		}
	}
	return nil
}

func listRules(c *httpx.Ctx) error {
	rs, err := loadRules(c.Context(), c.DB, "")
	if err != nil {
		return err
	}
	return c.JSON(rs)
}

func createRule(c *httpx.Ctx) error {
	var r model.BankRule
	if err := c.Decode(&r); err != nil {
		return err
	}
	ctx := c.Context()
	var out model.BankRule
	err := c.Write(func(tx *sql.Tx) error {
		if err := validateRule(ctx, tx, &r); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO bank_rules(name, account_id, match_text, direction, rename_to, name_id, target_account_id, priority, created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, r.Name, store.NullID(r.AccountID), r.MatchText, r.Direction, r.RenameTo,
			store.NullID(r.NameID), store.NullID(r.TargetAccountID), r.Priority, store.Now())
		if err != nil {
			return err
		}
		id, _ := res.LastInsertId()
		out, err = loadRule(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSONStatus(http.StatusCreated, out)
}

func updateRule(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out model.BankRule
	err = c.Write(func(tx *sql.Tx) error {
		r, err := loadRule(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := c.Decode(&r); err != nil {
			return err
		}
		if err := validateRule(ctx, tx, &r); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE bank_rules SET name = ?, account_id = ?, match_text = ?, direction = ?, rename_to = ?,
			name_id = ?, target_account_id = ?, priority = ? WHERE id = ?`, r.Name, store.NullID(r.AccountID), r.MatchText, r.Direction,
			r.RenameTo, store.NullID(r.NameID), store.NullID(r.TargetAccountID), r.Priority, id); err != nil {
			return err
		}
		out, err = loadRule(ctx, tx, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func deleteRule(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		res, err := tx.ExecContext(c.Context(), `DELETE FROM bank_rules WHERE id = ?`, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return apperr.NotFound("Bank rule not found.")
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.NoContent()
}
