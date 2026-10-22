package ledger

import (
	"database/sql"
	"sort"

	"seriex/internal/model"
)

// recost re-values the inventory moves of the given items from date `from`
// ("" = from the beginning) and updates quantities, values and average costs.
func (e *env) recost(items map[int64]bool, from string) error {
	ids := keys(items)
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if err := e.recostItem(id, from); err != nil {
			return err
		}
	}
	return nil
}

type moveRow struct {
	id, txnID, lineID int64
	qty               float64
	value             int64
	known             bool
	txnType           string
}

// recostItem walks the item's moves in (date, txn id, move id) order with a
// running quantity Q and value V (average cost). Known-cost moves add their
// value; computed moves are valued at V/Q, or when there is no stock at the
// last average cost the item had (its Cost field when it never had stock). A move that
// empties the stock takes all remaining value so V is 0 whenever Q is 0.
// Computed values that changed are written back to the move, the line's cogs
// and its ledger entries (role inv = value, role cogs = -value).
func (e *env) recostItem(itemID int64, from string) error {
	var cost float64
	err := e.q.QueryRowContext(e.ctx, `SELECT cost FROM items WHERE id = ?`, itemID).Scan(&cost)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	unitCost := cost * 100 // cents per unit
	var Q float64
	var V int64
	if from != "" {
		if err := e.q.QueryRowContext(e.ctx, `SELECT IFNULL(SUM(qty), 0), IFNULL(SUM(value), 0) FROM inventory_moves
			WHERE item_id = ? AND date < ?`, itemID, from).Scan(&Q, &V); err != nil {
			return err
		}
		if Q <= qtyEps {
			// out of stock before from: the last known average cost comes
			// from earlier moves, so walk the whole history
			from, Q, V = "", 0, 0
		}
	}
	// lastAvg: the average cost the last time there was stock (cents per unit);
	// sales made with no stock are valued at it, the item's Cost
	// field is used only when the item never had stock.
	lastAvg, haveAvg := 0.0, false
	if Q > qtyEps {
		lastAvg, haveAvg = float64(V)/Q, true
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT m.id, m.txn_id, IFNULL(m.line_id, 0), m.qty, m.value, m.cost_known, t.type
		FROM inventory_moves m JOIN txns t ON t.id = m.txn_id
		WHERE m.item_id = ? AND m.date >= ? ORDER BY m.date, m.txn_id, m.id`, itemID, from)
	if err != nil {
		return err
	}
	var moves []moveRow
	for rows.Next() {
		var m moveRow
		var known int
		if err := rows.Scan(&m.id, &m.txnID, &m.lineID, &m.qty, &m.value, &known, &m.txnType); err != nil {
			rows.Close()
			return err
		}
		m.known = known == 1
		moves = append(moves, m)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	var changed []moveRow
	for _, m := range moves {
		if m.known {
			Q += m.qty
			V += m.value
			if nearZero(Q) {
				Q = 0
			}
			if Q > qtyEps {
				lastAvg, haveAvg = float64(V)/Q, true
			}
			continue
		}
		unit := unitCost
		if haveAvg {
			unit = lastAvg
		}
		if Q > qtyEps {
			unit = float64(V) / Q
			lastAvg, haveAvg = unit, true
		}
		var val int64
		switch {
		case m.qty == 0:
			val = 0
		case nearZero(Q + m.qty):
			val = -V // emptied (or brought back to zero): no value left behind
		case m.qty < 0:
			val = -rnd(unit * -m.qty)
		default:
			val = rnd(unit * m.qty)
		}
		Q += m.qty
		V += val
		if nearZero(Q) {
			Q = 0
		}
		if Q > qtyEps {
			lastAvg, haveAvg = float64(V)/Q, true
		}
		if val != m.value {
			m.value = val
			changed = append(changed, m)
		}
	}
	avg := cost
	if haveAvg {
		avg = lastAvg / 100
	}
	if Q > qtyEps {
		avg = float64(V) / Q / 100
	}
	if _, err := e.q.ExecContext(e.ctx, `UPDATE items SET qty_on_hand = ?, asset_value = ?, avg_cost = ? WHERE id = ?`, Q, V, avg, itemID); err != nil {
		return err
	}

	adjusted := map[int64]bool{}
	for _, m := range changed {
		if _, err := e.q.ExecContext(e.ctx, `UPDATE inventory_moves SET value = ? WHERE id = ?`, m.value, m.id); err != nil {
			return err
		}
		if m.lineID == 0 {
			continue
		}
		if m.txnType == model.TxInventoryAdjust {
			if _, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET amount = ?, cogs = ? WHERE id = ?`, m.value, m.value, m.lineID); err != nil {
				return err
			}
			adjusted[m.txnID] = true
		} else {
			if _, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET cogs = ? WHERE id = ?`, cogsOf(m.txnType, m.value), m.lineID); err != nil {
				return err
			}
			if _, err := e.q.ExecContext(e.ctx, `UPDATE gl_entries SET amount = ? WHERE txn_id = ? AND line_id = ? AND role = 'cogs'`, -m.value, m.txnID, m.lineID); err != nil {
				return err
			}
		}
		if _, err := e.q.ExecContext(e.ctx, `UPDATE gl_entries SET amount = ? WHERE txn_id = ? AND line_id = ? AND role = 'inv'`, m.value, m.txnID, m.lineID); err != nil {
			return err
		}
	}
	// quantity adjustments: the adjustment account entry and the total follow the lines
	for txnID := range adjusted {
		if _, err := e.q.ExecContext(e.ctx, `UPDATE gl_entries SET amount = -(SELECT IFNULL(SUM(amount), 0) FROM gl_entries
			WHERE txn_id = ? AND role = 'inv') WHERE txn_id = ? AND role = 'header'`, txnID, txnID); err != nil {
			return err
		}
		if _, err := e.q.ExecContext(e.ctx, `UPDATE txns SET amount = (SELECT IFNULL(SUM(amount), 0) FROM txn_lines
			WHERE txn_id = ?) WHERE id = ?`, txnID, txnID); err != nil {
			return err
		}
	}
	return nil
}
