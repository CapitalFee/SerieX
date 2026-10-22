package banking

import (
	"context"
	"database/sql"

	"seriex/internal/model"
	"seriex/internal/store"
)

// CreateRule stores a new bank rule (POST /bank-rules) inside tx.
func CreateRule(ctx context.Context, tx *sql.Tx, r *model.BankRule) (int64, error) {
	if err := validateRule(ctx, tx, r); err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO bank_rules(name, account_id, match_text, direction, rename_to, name_id, target_account_id, priority, created_at)
		VALUES(?,?,?,?,?,?,?,?,?)`, r.Name, store.NullID(r.AccountID), r.MatchText, r.Direction, r.RenameTo,
		store.NullID(r.NameID), store.NullID(r.TargetAccountID), r.Priority, store.Now())
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}
