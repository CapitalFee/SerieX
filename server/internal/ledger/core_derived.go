package ledger

import (
	"seriex/internal/model"
)

// derived collects what must be recomputed after a transaction changes.
type derived struct {
	txns      map[int64]bool // open balances / statuses
	pos       map[int64]bool // purchase orders: received qty and status
	ests      map[int64]bool // estimates: Closed while invoiced
	billLines map[int64]bool // billable cost lines: billed_txn_id
}

func newDerived() *derived {
	return &derived{txns: map[int64]bool{}, pos: map[int64]bool{}, ests: map[int64]bool{}, billLines: map[int64]bool{}}
}

// collectDerived adds everything s refers to (call it for the old and the new version).
func (e *env) collectDerived(d *derived, s *stxn) error {
	d.txns[s.ID] = true
	for _, l := range s.Links {
		d.txns[or64(l.From, s.ID)] = true
		d.txns[l.To] = true
	}
	if s.Type == model.TxPurchaseOrder {
		d.pos[s.ID] = true
	}
	var lineRefs []int64
	for _, l := range s.Lines {
		if isCostSource(s.Type) && l.ID != 0 {
			d.billLines[l.ID] = true
		}
		if l.LinkedLineID != 0 {
			lineRefs = append(lineRefs, l.LinkedLineID)
		}
		if l.LinkedTxnID != 0 && s.Type != model.TxDeposit {
			b, err := e.brief(l.LinkedTxnID)
			if err != nil {
				return err
			}
			if b != nil {
				switch b.Type {
				case model.TxPurchaseOrder:
					d.pos[b.ID] = true
				case model.TxEstimate:
					d.ests[b.ID] = true
				}
			}
		}
	}
	if len(lineRefs) > 0 {
		in, args := placeholders(lineRefs)
		rows, err := e.q.QueryContext(e.ctx, `SELECT l.id, l.txn_id, t.type FROM txn_lines l JOIN txns t ON t.id = l.txn_id WHERE l.id IN `+in, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var lineID, txnID int64
			var typ string
			if err := rows.Scan(&lineID, &txnID, &typ); err != nil {
				return err
			}
			switch {
			case typ == model.TxPurchaseOrder:
				d.pos[txnID] = true
			case typ == model.TxEstimate:
				d.ests[txnID] = true
			case isCostSource(typ):
				d.billLines[lineID] = true
			}
		}
		if err := rows.Err(); err != nil {
			return err
		}
	}
	return nil
}

func (e *env) refreshDerived(d *derived) error {
	if err := e.refreshOpen(keys(d.txns)); err != nil {
		return err
	}
	if err := e.refreshPOs(keys(d.pos)); err != nil {
		return err
	}
	if err := e.refreshEstimates(keys(d.ests)); err != nil {
		return err
	}
	return e.refreshBilled(keys(d.billLines))
}

const openBalanceExpr = `CASE
	WHEN voided = 1 OR is_pending = 1 THEN 0
	WHEN type IN ('INV','STMTCHG','BILL') THEN amount - IFNULL((SELECT SUM(l.amount + l.discount) FROM txn_links l WHERE l.to_txn_id = txns.id), 0)
	WHEN type = 'ITEMRCPT' THEN amount
	WHEN type IN ('CREDMEM','BILLCRED','PMT','BILLPMT') THEN amount
		- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.from_txn_id = txns.id), 0)
		- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.to_txn_id = txns.id), 0)
	WHEN type = 'GENJRNL' THEN (SELECT CASE WHEN COUNT(*) = 1 THEN ABS(SUM(g.amount)) ELSE 0 END FROM gl_entries g
			JOIN accounts a ON a.id = g.account_id WHERE g.txn_id = txns.id AND a.type IN ('Accounts Receivable','Accounts Payable'))
		- IFNULL((SELECT SUM(l.amount + l.discount) FROM txn_links l WHERE l.to_txn_id = txns.id), 0)
		- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.from_txn_id = txns.id), 0)
	ELSE 0 END`

const invStatusExpr = `CASE WHEN type IN ('INV','SALESRCPT') AND is_pending = 1 THEN 'Pending'
	WHEN type IN ('INV','BILL','STMTCHG') THEN (CASE WHEN open_balance = 0 AND amount > 0 THEN 'Paid' ELSE 'Open' END)
	WHEN type = 'SALESRCPT' THEN '' ELSE status END`

// refreshOpen recomputes open balances (and INV/BILL statuses) of the given
// transactions; nil ids = every transaction.
func (e *env) refreshOpen(ids []int64) error {
	where, args := "", []any(nil)
	if ids != nil {
		if len(ids) == 0 {
			return nil
		}
		in, a := placeholders(ids)
		where, args = " WHERE id IN "+in, a
	}
	if _, err := e.q.ExecContext(e.ctx, `UPDATE txns SET open_balance = `+openBalanceExpr+where, args...); err != nil {
		return err
	}
	_, err := e.q.ExecContext(e.ctx, `UPDATE txns SET status = `+invStatusExpr+where, args...)
	return err
}

// refreshPOs recomputes received quantities and statuses of purchase orders;
// nil ids = every purchase order. A line with no quantity counts as 1 unit.
func (e *env) refreshPOs(ids []int64) error {
	where, args := "", []any(nil)
	if ids != nil {
		if len(ids) == 0 {
			return nil
		}
		in, a := placeholders(ids)
		where, args = " AND id IN "+in, a
	}
	if _, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET received_qty = IFNULL((SELECT SUM(COALESCE(r.qty, 1))
		FROM txn_lines r JOIN txns rt ON rt.id = r.txn_id
		WHERE r.linked_line_id = txn_lines.id AND rt.type <> 'PURCHORD' AND rt.voided = 0), 0)
		WHERE txn_id IN (SELECT id FROM txns WHERE type = 'PURCHORD'`+where+`)`, args...); err != nil {
		return err
	}
	// lines that count: items other than subtotals, or lines with an amount
	_, err := e.q.ExecContext(e.ctx, `UPDATE txns SET status = CASE
		WHEN EXISTS (SELECT 1 FROM txn_lines l LEFT JOIN items i ON i.id = l.item_id WHERE l.txn_id = txns.id
			AND (l.item_id IS NOT NULL OR l.amount <> 0) AND IFNULL(i.type, '') <> 'Subtotal'
			AND l.closed = 0 AND l.received_qty < COALESCE(l.qty, 1) - 0.000000001) THEN 'Open'
		WHEN EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = txns.id AND (l.item_id IS NOT NULL OR l.amount <> 0)) THEN 'Closed'
		ELSE 'Open' END
		WHERE type = 'PURCHORD'`+where, args...)
	return err
}

// (two EXISTS instead of one with OR, so both can use an index)
const estimateInvoicedExpr = `(EXISTS (SELECT 1 FROM txn_lines l JOIN txns i ON i.id = l.txn_id
	WHERE l.linked_txn_id = txns.id AND i.type = 'INV' AND i.voided = 0)
	OR EXISTS (SELECT 1 FROM txn_lines s CROSS JOIN txn_lines l ON l.linked_line_id = s.id CROSS JOIN txns i ON i.id = l.txn_id
	WHERE s.txn_id = txns.id AND i.type = 'INV' AND i.voided = 0))` // CROSS JOIN keeps this join order (estimate lines first)

// refreshEstimates: an estimate is Closed while an invoice uses it and goes
// back to the status it had before (extra.statusBeforeInvoice, else Pending)
// when no invoice does any more.
func (e *env) refreshEstimates(ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	in, args := placeholders(ids)
	_, err := e.q.ExecContext(e.ctx, `UPDATE txns SET
		status = CASE WHEN `+estimateInvoicedExpr+` THEN 'Closed'
			WHEN status = 'Closed' THEN COALESCE(json_extract(extra, '$.statusBeforeInvoice'), 'Pending') ELSE status END,
		extra = CASE WHEN `+estimateInvoicedExpr+` THEN (CASE WHEN status <> 'Closed' THEN json_set(extra, '$.statusBeforeInvoice', status) ELSE extra END)
			WHEN json_extract(extra, '$.statusBeforeInvoice') IS NOT NULL THEN json_remove(extra, '$.statusBeforeInvoice') ELSE extra END
		WHERE type = 'EST' AND id IN `+in, args...)
	return err
}

// estimateOnSave keeps a saved estimate Closed while invoices use it
// (remembering the status chosen on the form for when they are removed).
func (e *env) estimateOnSave(id int64) error {
	_, err := e.q.ExecContext(e.ctx, `UPDATE txns SET
		extra = CASE WHEN status <> 'Closed' THEN json_set(extra, '$.statusBeforeInvoice', status) ELSE extra END,
		status = 'Closed' WHERE id = ? AND `+estimateInvoicedExpr, id)
	return err
}

// refreshBilled sets billed_txn_id of billable cost lines from the invoice
// lines that reference them; nil ids = every purchase line. The type test is
// a correlated EXISTS: "txn_id IN (SELECT id FROM txns WHERE type IN ...)"
// lists every cost transaction of the company on each save.
func (e *env) refreshBilled(ids []int64) error {
	where, args := "", []any(nil)
	if ids != nil {
		if len(ids) == 0 {
			return nil
		}
		in, a := placeholders(ids)
		where, args = " AND id IN "+in, a
	}
	_, err := e.q.ExecContext(e.ctx, `UPDATE txn_lines SET billed_txn_id = (SELECT l.txn_id FROM txn_lines l JOIN txns i ON i.id = l.txn_id
		WHERE l.linked_line_id = txn_lines.id AND i.type IN ('INV','SALESRCPT') AND i.voided = 0 ORDER BY l.txn_id LIMIT 1)
		WHERE EXISTS (SELECT 1 FROM txns t WHERE t.id = txn_lines.txn_id AND t.type IN ('CHK','BILL','ITEMRCPT','CCCHARGE'))`+where, args...)
	return err
}
