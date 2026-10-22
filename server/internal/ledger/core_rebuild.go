package ledger

import (
	"context"
	"database/sql"
	"fmt"

	"seriex/internal/model"
)

// rebuildAll re-posts every transaction from its stored header, lines and
// links (date order, no warnings) and recomputes every derived value.
func rebuildAll(ctx context.Context, tx *sql.Tx) error {
	e, err := newEnv(ctx, tx, SaveOptions{})
	if err != nil {
		return err
	}
	e.quiet = true
	all, ids, err := loadAllStored(ctx, tx)
	if err != nil {
		return err
	}
	olds, err := e.loadAllOldPostings(all)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s, op := all[id], olds[id]
		amount, sub := s.Amount, s.Subtotal
		if err := e.sumTotals(s); err != nil {
			return err
		}
		if amount != s.Amount || sub != s.Subtotal {
			if _, err := tx.ExecContext(ctx, `UPDATE txns SET amount = ?, subtotal = ? WHERE id = ?`, s.Amount, s.Subtotal, id); err != nil {
				return err
			}
		}
		post, err := e.buildPosting(s, op)
		if err != nil {
			return fmt.Errorf("rebuild %s %d (%s): %w", s.Type, s.ID, s.Ref, err)
		}
		post.bindLines(s)
		if postingSame(s, post, op) {
			continue // nothing to repair: leave the stored entries alone
		}
		if _, err := e.writePosting(s, post, op); err != nil {
			return err
		}
	}

	// inventory from scratch
	items := map[int64]bool{}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM items WHERE type = ? UNION SELECT DISTINCT item_id FROM inventory_moves`, model.ItemInventoryPart)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		items[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if err := e.recost(items, ""); err != nil {
		return err
	}
	if err := e.fixLineCogs(); err != nil {
		return err
	}

	if err := e.refreshOpen(nil); err != nil {
		return err
	}
	if err := e.refreshPOs(nil); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE txns SET status = 'Closed' WHERE type = 'EST' AND `+estimateInvoicedExpr); err != nil {
		return err
	}
	return e.refreshBilled(nil)
}

// fixLineCogs makes txn_lines.cogs agree with the computed inventory moves.
func (e *env) fixLineCogs() error {
	want := map[int64]int64{}
	rows, err := e.q.QueryContext(e.ctx, `SELECT m.line_id, m.value, t.type FROM inventory_moves m JOIN txns t ON t.id = m.txn_id
		WHERE m.cost_known = 0 AND m.line_id IS NOT NULL`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var line, value int64
		var typ string
		if err := rows.Scan(&line, &value, &typ); err != nil {
			rows.Close()
			return err
		}
		want[line] = cogsOf(typ, value)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	type fix struct{ id, cogs int64 }
	var fixes []fix
	rows, err = e.q.QueryContext(e.ctx, `SELECT id, cogs FROM txn_lines WHERE cogs <> 0`)
	if err != nil {
		return err
	}
	have := map[int64]int64{}
	for rows.Next() {
		var id, cogs int64
		if err := rows.Scan(&id, &cogs); err != nil {
			rows.Close()
			return err
		}
		have[id] = cogs
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for id, c := range have {
		if want[id] != c {
			fixes = append(fixes, fix{id, want[id]})
		}
	}
	for id, c := range want {
		if _, ok := have[id]; !ok && c != 0 {
			fixes = append(fixes, fix{id, c})
		}
	}
	for _, f := range fixes {
		if _, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET cogs = ? WHERE id = ?`, f.cogs, f.id); err != nil {
			return err
		}
	}
	return nil
}

// postingSame reports whether the stored ledger entries and inventory moves of
// s are exactly what buildPosting produced (then Rebuild need not rewrite them).
func postingSame(s *stxn, p *posting, op *oldPosting) bool {
	if len(p.entries) != len(op.entries) || len(p.moves) != len(op.moves) {
		return false
	}
	if len(p.moves) > 0 && op.date != s.Date {
		return false
	}
	type ek struct {
		acct, line, amount, name, class, item int64
		role, memo, date                      string
	}
	count := map[ek]int{}
	for _, o := range op.entries {
		count[ek{o.acct, o.line, o.amount, o.name, o.class, o.item, o.role, o.memo, o.date}]++
	}
	for _, en := range p.entries {
		k := ek{en.AccountID, en.LineID, en.Amount, en.NameID, en.ClassID, en.ItemID, en.Role, en.Memo, s.Date}
		if count[k] == 0 {
			return false
		}
		count[k]--
	}
	for i, m := range p.moves {
		o := op.moves[i]
		if o != (moveSig{m.LineID, m.ItemID, m.Qty, m.Value, m.Known}) {
			return false
		}
	}
	return true
}
