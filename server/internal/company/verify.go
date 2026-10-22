package company

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"

	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

const maxProblems = 500

type verifier struct {
	ctx      context.Context
	q        store.Q
	problems []string
	labels   map[int64]string
}

func (v *verifier) add(format string, args ...any) {
	if len(v.problems) < maxProblems {
		v.problems = append(v.problems, fmt.Sprintf(format, args...))
	}
}

// txnName describes a transaction for problem messages ("Invoice #1001 (05/01/2026, id 12)").
func (v *verifier) txnName(id int64) string {
	if s, ok := v.labels[id]; ok {
		return s
	}
	return fmt.Sprintf("transaction id %d", id)
}

func (v *verifier) loadLabels() error {
	v.labels = map[int64]string{}
	rows, err := v.q.QueryContext(v.ctx, `SELECT id, type, ref_number, date FROM txns`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var typ, ref, date string
		if err := rows.Scan(&id, &typ, &ref, &date); err != nil {
			return err
		}
		label := model.TxnTypeLabels[typ]
		if label == "" {
			label = typ
		}
		if ref != "" {
			label += " #" + ref
		}
		if t, err := store.ParseDate(date); err == nil {
			date = t.Format("01/02/2006")
		}
		v.labels[id] = fmt.Sprintf("%s (%s, id %d)", label, date, id)
	}
	return rows.Err()
}

// rowsOf runs query and calls fn for each row.
func (v *verifier) rowsOf(query string, fn func(rows *sql.Rows) error, args ...any) error {
	rows, err := v.q.QueryContext(v.ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := fn(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (v *verifier) run() error {
	if err := v.loadLabels(); err != nil {
		return err
	}
	money := func(c int64) string { return fmt.Sprintf("%.2f", store.Dollars(c)) }

	// 1. Every transaction's ledger entries must sum to zero (debits = credits).
	err := v.rowsOf(`SELECT txn_id, SUM(amount) FROM gl_entries GROUP BY txn_id HAVING SUM(amount) <> 0`, func(rows *sql.Rows) error {
		var id, sum int64
		if err := rows.Scan(&id, &sum); err != nil {
			return err
		}
		v.add("%s is out of balance: debits and credits differ by %s.", v.txnName(id), money(sum))
		return nil
	})
	if err != nil {
		return err
	}

	// 2. Estimates and purchase orders must not post; voided and pending transactions must not post amounts.
	err = v.rowsOf(`SELECT DISTINCT t.id FROM txns t JOIN gl_entries g ON g.txn_id = t.id
		WHERE t.type IN ('EST', 'PURCHORD') OR ((t.voided = 1 OR t.is_pending = 1) AND g.amount <> 0)`, func(rows *sql.Rows) error {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return err
		}
		v.add("%s should not have amounts in the general ledger.", v.txnName(id))
		return nil
	})
	if err != nil {
		return err
	}

	// 3. Open balances must equal the amount minus the payments and credits linked to it.
	err = v.rowsOf(`SELECT t.id, t.type, t.amount, t.open_balance,
			COALESCE((SELECT SUM(l.amount + l.discount) FROM txn_links l WHERE l.to_txn_id = t.id), 0),
			COALESCE((SELECT SUM(l.amount) FROM txn_links l WHERE l.from_txn_id = t.id), 0),
			COALESCE((SELECT SUM(l.amount) FROM txn_links l WHERE l.to_txn_id = t.id), 0),
			CASE WHEN t.type = 'GENJRNL' THEN (SELECT CASE WHEN COUNT(*) = 1 THEN ABS(SUM(g.amount)) ELSE 0 END FROM gl_entries g
				JOIN accounts a ON a.id = g.account_id WHERE g.txn_id = t.id AND a.type IN ('Accounts Receivable', 'Accounts Payable')) ELSE 0 END
		FROM txns t WHERE t.is_pending = 0 AND t.voided = 0`, func(rows *sql.Rows) error {
		var id, amount, open, toWithDisc, from, to, jeDoc int64
		var typ string
		if err := rows.Scan(&id, &typ, &amount, &open, &toWithDisc, &from, &to, &jeDoc); err != nil {
			return err
		}
		var want int64
		switch typ {
		case model.TxInvoice, model.TxStatementCharge, model.TxBill, model.TxItemReceipt:
			want = amount - toWithDisc
		case model.TxCreditMemo, model.TxVendorCredit, model.TxPayment, model.TxBillPayment:
			// credits are used by applications (links from it) and refunds (links to it);
			// a bill payment whose bill was deleted keeps its amount as a credit
			want = amount - from - to
		case model.TxJournal:
			// a journal entry with one A/R or A/P line is an open document of that line
			want = jeDoc - toWithDisc - from
		default:
			want = 0
		}
		if open != want {
			v.add("%s has an open balance of %s but its amount and applied payments/credits give %s.", v.txnName(id), money(open), money(want))
		}
		return nil
	})
	if err != nil {
		return err
	}

	// 3b. The A/R and A/P balances must equal the open documents (open invoices and
	// bills less unused credits and payments) plus journal entry lines to them.
	for _, side := range []struct {
		acctType, charges, credits, label string
		sign                              int64
	}{
		{model.AcctAR, `'INV','STMTCHG'`, `'CREDMEM','PMT'`, "Accounts Receivable", 1},
		{model.AcctAP, `'BILL','ITEMRCPT'`, `'BILLCRED','BILLPMT'`, "Accounts Payable", -1},
	} {
		var gl, je, charges, credits int64
		if err := v.q.QueryRowContext(v.ctx, `SELECT COALESCE(SUM(g.amount), 0) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
			WHERE a.type = ?`, side.acctType).Scan(&gl); err != nil {
			return err
		}
		// journal entries: one A/R (A/P) line = an open document (its open balance on the
		// side of the line); several lines = their ledger amounts
		if err := v.q.QueryRowContext(v.ctx, `SELECT COALESCE(SUM(CASE WHEN x.n = 1 THEN (CASE WHEN x.amt > 0 THEN t.open_balance ELSE -t.open_balance END)
				ELSE x.amt END), 0)
			FROM (SELECT g.txn_id, SUM(g.amount) AS amt, (SELECT COUNT(*) FROM gl_entries g2 JOIN accounts a2 ON a2.id = g2.account_id
					WHERE g2.txn_id = g.txn_id AND a2.type IN ('Accounts Receivable', 'Accounts Payable')) AS n
				FROM gl_entries g JOIN accounts a ON a.id = g.account_id
				JOIN txns t ON t.id = g.txn_id WHERE a.type = ? AND t.type = 'GENJRNL' GROUP BY g.txn_id) x
			JOIN txns t ON t.id = x.txn_id`, side.acctType).Scan(&je); err != nil {
			return err
		}
		if err := v.q.QueryRowContext(v.ctx, `SELECT COALESCE(SUM(open_balance), 0) FROM txns WHERE type IN (`+side.charges+`)
			AND voided = 0 AND is_pending = 0`).Scan(&charges); err != nil {
			return err
		}
		if err := v.q.QueryRowContext(v.ctx, `SELECT COALESCE(SUM(open_balance), 0) FROM txns WHERE type IN (`+side.credits+`)
			AND voided = 0`).Scan(&credits); err != nil {
			return err
		}
		docs := side.sign*(charges-credits) + je
		if gl != docs {
			v.add("The %s balance (%s) does not match its open transactions (%s).", side.label, money(side.sign*gl), money(side.sign*docs))
		}
	}

	// 3c. Per customer:job / vendor and A/R or A/P account: the ledger balance
	// must equal that name's open documents, and both sides of every
	// payment/credit link must belong to the same customer (or vendor).
	if err := v.checkNames(money); err != nil {
		return err
	}

	// 4. Inventory: quantity on hand must equal the sum of the quantity movements.
	itemNames, err := store.FullNames(v.ctx, v.q, "items")
	if err != nil {
		return err
	}
	err = v.rowsOf(`SELECT i.id, i.qty_on_hand, COALESCE((SELECT SUM(m.qty) FROM inventory_moves m WHERE m.item_id = i.id), 0)
		FROM items i WHERE i.type = ?`, func(rows *sql.Rows) error {
		var id int64
		var qty, moves float64
		if err := rows.Scan(&id, &qty, &moves); err != nil {
			return err
		}
		if math.Abs(qty-moves) > 0.00001 {
			v.add("Item %s shows %s on hand but its transactions add up to %s.", itemNames[id], fmtQty(qty), fmtQty(moves))
		}
		return nil
	}, model.ItemInventoryPart)
	if err != nil {
		return err
	}

	// 5. Inventory asset accounts: general ledger balance vs the asset value of the items using them.
	var invAcct int64
	if err := v.q.QueryRowContext(v.ctx, `SELECT id FROM accounts WHERE special = ? ORDER BY id LIMIT 1`, store.SpecialInventoryAsset).Scan(&invAcct); err != nil && err != sql.ErrNoRows {
		return err
	}
	acctNames, err := store.FullNames(v.ctx, v.q, "accounts")
	if err != nil {
		return err
	}
	err = v.rowsOf(`SELECT x.acct, x.value, COALESCE((SELECT SUM(g.amount) FROM gl_entries g WHERE g.account_id = x.acct), 0)
		FROM (SELECT COALESCE(asset_account_id, ?) AS acct, SUM(asset_value) AS value FROM items WHERE type = ? GROUP BY 1) x
		WHERE x.acct IS NOT NULL AND x.acct <> 0`, func(rows *sql.Rows) error {
		var acct, value, gl int64
		if err := rows.Scan(&acct, &value, &gl); err != nil {
			return err
		}
		if value != gl {
			v.add("Inventory asset account %s has a balance of %s but the inventory items in it are valued at %s.", acctNames[acct], money(gl), money(value))
		}
		return nil
	}, invAcct, model.ItemInventoryPart)
	if err != nil {
		return err
	}

	// 6. Orphan rows (references to missing transactions, lines or accounts).
	orphans := []struct{ query, msg string }{
		{`SELECT COUNT(*) FROM txn_lines l WHERE NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = l.txn_id)`, "transaction lines without a transaction"},
		{`SELECT COUNT(*) FROM txn_links l WHERE NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = l.from_txn_id)
			OR NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = l.to_txn_id) OR NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = l.owner_txn_id)`, "payment/credit links to missing transactions"},
		{`SELECT COUNT(*) FROM gl_entries g WHERE NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = g.txn_id)`, "ledger entries without a transaction"},
		{`SELECT COUNT(*) FROM gl_entries g WHERE g.line_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM txn_lines l WHERE l.id = g.line_id)`, "ledger entries pointing to missing transaction lines"},
		{`SELECT COUNT(*) FROM gl_entries g WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = g.account_id)`, "ledger entries posted to missing accounts"},
		{`SELECT COUNT(*) FROM inventory_moves m WHERE NOT EXISTS (SELECT 1 FROM txns t WHERE t.id = m.txn_id)
			OR NOT EXISTS (SELECT 1 FROM items i WHERE i.id = m.item_id)`, "inventory movements without a transaction or item"},
		{`SELECT COUNT(*) FROM budget_lines b WHERE NOT EXISTS (SELECT 1 FROM budgets x WHERE x.id = b.budget_id)`, "budget lines without a budget"},
	}
	for _, o := range orphans {
		var n int
		if err := v.q.QueryRowContext(v.ctx, o.query).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			v.add("Found %d %s.", n, o.msg)
		}
	}
	return nil
}

// POST /verify -> {ok, problems}
func verifyData(c *httpx.Ctx) error {
	v := &verifier{ctx: c.Context(), q: c.DB, problems: []string{}}
	if err := v.run(); err != nil {
		return err
	}
	if len(v.problems) >= maxProblems {
		v.problems = append(v.problems, fmt.Sprintf("Only the first %d problems are listed.", maxProblems))
	}
	return c.JSON(map[string]any{"ok": len(v.problems) == 0, "problems": v.problems})
}

// POST /rebuild -> {ok: true}
func rebuildData(c *httpx.Ctx) error {
	err := c.Write(func(tx *sql.Tx) error {
		if err := store.RequireAdmin(c.Context(), tx, c.User, "Only an administrator can rebuild the company file."); err != nil {
			return err
		}
		return ledger.Rebuild(c.Context(), tx)
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true})
}

// checkNames compares A/R and A/P balances by account and name with the open
// documents of each name, and checks that links never cross customers or vendors.
func (v *verifier) checkNames(money func(int64) string) error {
	names, err := store.FullNames(v.ctx, v.q, "names")
	if err != nil {
		return err
	}
	acctNames, err := store.FullNames(v.ctx, v.q, "accounts")
	if err != nil {
		return err
	}
	parent := map[int64]int64{}
	kind := map[int64]string{}
	if err := v.rowsOf(`SELECT id, IFNULL(parent_id, 0), kind FROM names`, func(rows *sql.Rows) error {
		var id, p int64
		var k string
		if err := rows.Scan(&id, &p, &k); err != nil {
			return err
		}
		parent[id], kind[id] = p, k
		return nil
	}); err != nil {
		return err
	}
	root := func(id int64) int64 {
		for i := 0; i < 64 && parent[id] != 0; i++ {
			id = parent[id]
		}
		return id
	}
	type key struct{ acct, name int64 }
	gl := map[key]int64{}
	docs := map[key]int64{}
	acctType := map[int64]string{}
	if err := v.rowsOf(`SELECT g.account_id, a.type, IFNULL(g.name_id, 0), SUM(g.amount) FROM gl_entries g
		JOIN accounts a ON a.id = g.account_id WHERE a.type IN ('Accounts Receivable', 'Accounts Payable')
		GROUP BY g.account_id, IFNULL(g.name_id, 0)`, func(rows *sql.Rows) error {
		var k key
		var typ string
		var amt int64
		if err := rows.Scan(&k.acct, &typ, &k.name, &amt); err != nil {
			return err
		}
		gl[k] += amt
		acctType[k.acct] = typ
		return nil
	}); err != nil {
		return err
	}
	// documents: charges (+ on A/R, - on A/P), credits (- on A/R, + on A/P)
	if err := v.rowsOf(`SELECT t.type, CASE WHEN t.type IN ('PMT','BILLPMT') THEN t.ar_ap_account_id ELSE t.account_id END,
			IFNULL(t.name_id, 0), t.open_balance, a.type
		FROM txns t JOIN accounts a ON a.id = CASE WHEN t.type IN ('PMT','BILLPMT') THEN t.ar_ap_account_id ELSE t.account_id END
		WHERE t.voided = 0 AND t.is_pending = 0 AND t.open_balance <> 0
		  AND t.type IN ('INV','STMTCHG','CREDMEM','PMT','BILL','ITEMRCPT','BILLCRED','BILLPMT')`, func(rows *sql.Rows) error {
		var typ, at string
		var k key
		var open int64
		if err := rows.Scan(&typ, &k.acct, &k.name, &open, &at); err != nil {
			return err
		}
		switch typ {
		case model.TxInvoice, model.TxStatementCharge:
			docs[k] += open
		case model.TxCreditMemo, model.TxPayment:
			docs[k] -= open
		case model.TxBill, model.TxItemReceipt:
			docs[k] -= open
		case model.TxVendorCredit, model.TxBillPayment:
			docs[k] += open
		}
		acctType[k.acct] = at
		return nil
	}); err != nil {
		return err
	}
	// journal entries: one A/R or A/P line = an open document; several = their amounts
	if err := v.rowsOf(`SELECT g.txn_id, g.account_id, IFNULL(g.name_id, 0), g.amount, t.open_balance,
			(SELECT COUNT(*) FROM gl_entries g2 JOIN accounts a2 ON a2.id = g2.account_id
				WHERE g2.txn_id = g.txn_id AND a2.type IN ('Accounts Receivable', 'Accounts Payable'))
		FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN txns t ON t.id = g.txn_id
		WHERE a.type IN ('Accounts Receivable', 'Accounts Payable') AND t.type = 'GENJRNL'`, func(rows *sql.Rows) error {
		var id, open int64
		var k key
		var amt int64
		var n int
		if err := rows.Scan(&id, &k.acct, &k.name, &amt, &open, &n); err != nil {
			return err
		}
		if n == 1 {
			if amt > 0 {
				docs[k] += open
			} else {
				docs[k] -= open
			}
		} else {
			docs[k] += amt
		}
		return nil
	}); err != nil {
		return err
	}
	seen := map[key]bool{}
	var keys []key
	for k := range gl {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	for k := range docs {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].acct != keys[j].acct {
			return keys[i].acct < keys[j].acct
		}
		return names[keys[i].name] < names[keys[j].name]
	})
	for _, k := range keys {
		if gl[k] == docs[k] {
			continue
		}
		sign := int64(1)
		if acctType[k.acct] == model.AcctAP {
			sign = -1
		}
		who := names[k.name]
		if who == "" {
			who = "(no name)"
		}
		v.add("In %s, the balance of %s (%s) does not match its open transactions (%s).", acctNames[k.acct], who, money(sign*gl[k]), money(sign*docs[k]))
	}

	// links: both sides belong to the same customer (jobs of one customer may
	// mix) or to the same vendor
	docName := `CASE WHEN x.type = 'GENJRNL' THEN (SELECT IFNULL(g.name_id, 0) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE g.txn_id = x.id AND a.type IN ('Accounts Receivable', 'Accounts Payable') ORDER BY g.id LIMIT 1) ELSE IFNULL(x.name_id, 0) END`
	return v.rowsOf(`SELECT l.from_txn_id, l.to_txn_id, l.owner_txn_id,
			(SELECT `+docName+` FROM txns x WHERE x.id = l.from_txn_id),
			(SELECT `+docName+` FROM txns x WHERE x.id = l.to_txn_id)
		FROM txn_links l ORDER BY l.id`, func(rows *sql.Rows) error {
		var from, to, owner int64
		var fn, tn sql.NullInt64
		if err := rows.Scan(&from, &to, &owner, &fn, &tn); err != nil {
			return err
		}
		a, b := fn.Int64, tn.Int64
		same := a == b
		if !same && kind[a] == model.NameCustomer && kind[b] == model.NameCustomer {
			same = root(a) == root(b)
		}
		if !same {
			v.add("%s is applied to %s, but they belong to different names (%s and %s).", v.txnName(from), v.txnName(to), names[a], names[b])
		}
		return nil
	})
}
