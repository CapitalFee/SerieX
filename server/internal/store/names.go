package store

import (
	"context"
	"fmt"
)

// FullNames returns id -> "Parent:Child:Grandchild" for a hierarchical table:
// "accounts", "names", "items" or "list_entries".
func FullNames(ctx context.Context, q Q, table string) (map[int64]string, error) {
	switch table {
	case "accounts", "names", "items", "list_entries":
	default:
		return nil, fmt.Errorf("FullNames: unsupported table %q", table)
	}
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE t(id, full) AS (
		SELECT id, name FROM `+table+` WHERE parent_id IS NULL
		UNION ALL
		SELECT c.id, t.full || ':' || c.name FROM `+table+` c JOIN t ON c.parent_id = t.id
	) SELECT id, full FROM t`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var full string
		if err := rows.Scan(&id, &full); err != nil {
			return nil, err
		}
		out[id] = full
	}
	return out, rows.Err()
}

// FullName returns the hierarchical name of one row ("" when not found).
func FullName(ctx context.Context, q Q, table string, id int64) string {
	switch table {
	case "accounts", "names", "items", "list_entries":
	default:
		return ""
	}
	var full string
	q.QueryRowContext(ctx, `WITH RECURSIVE up(id, parent_id, full) AS (
		SELECT id, parent_id, name FROM `+table+` WHERE id = ?
		UNION ALL
		SELECT p.id, p.parent_id, p.name || ':' || up.full FROM `+table+` p JOIN up ON p.id = up.parent_id
	) SELECT full FROM up WHERE parent_id IS NULL`, id).Scan(&full)
	return full
}

// Descendants returns id plus the ids of all rows below it in the hierarchy.
func Descendants(ctx context.Context, q Q, table string, id int64) ([]int64, error) {
	switch table {
	case "accounts", "names", "items", "list_entries":
	default:
		return nil, fmt.Errorf("Descendants: unsupported table %q", table)
	}
	rows, err := q.QueryContext(ctx, `WITH RECURSIVE d(id) AS (
		SELECT ? UNION ALL SELECT c.id FROM `+table+` c JOIN d ON c.parent_id = d.id
	) SELECT id FROM d`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var x int64
		if err := rows.Scan(&x); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}
