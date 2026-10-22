package banking

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

const discrepancyAccountName = "Reconciliation Discrepancies"

// draftData is the JSON kept in reconcile_drafts.data.
type draftData struct {
	ServiceCharge *model.ReconcileAdj `json:"serviceCharge"`
	Interest      *model.ReconcileAdj `json:"interest"`
}

func checkReconcilable(a acct) error {
	if !model.IsBalanceSheet(a.Type) || a.Type == model.AcctAR || a.Type == model.AcctAP {
		return apperr.Validation("accountId", "%s cannot be reconciled. Choose a bank, credit card or other balance sheet account (not Accounts Receivable or Accounts Payable).", a.FullName)
	}
	return nil
}

// loadEntries returns ledger entries joined with their transaction, amounts in
// the natural sign of acctType.
func loadEntries(ctx context.Context, q store.Q, acctType, where string, args ...any) ([]model.ReconcileEntry, error) {
	names, err := nameMap(ctx, q)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT g.id, g.txn_id, t.type, g.date, t.ref_number, COALESCE(g.name_id, t.name_id),
			g.memo, t.memo, g.amount, g.cleared, COALESCE(ha.type, '')
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id LEFT JOIN accounts ha ON ha.id = t.account_id
		WHERE `+where+` ORDER BY g.date, t.ref_number, g.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ReconcileEntry{}
	for rows.Next() {
		var e model.ReconcileEntry
		var nameID sql.NullInt64
		var gmemo, tmemo, headerType string
		var amount int64
		if err := rows.Scan(&e.GLID, &e.TxnID, &e.Type, &e.Date, &e.RefNumber, &nameID, &gmemo, &tmemo, &amount, &e.Cleared, &headerType); err != nil {
			return nil, err
		}
		e.TypeLabel = typeLabel(e.Type, headerType)
		if nameID.Valid {
			e.NameFull = names[nameID.Int64]
		}
		e.Memo = gmemo
		if e.Memo == "" {
			e.Memo = tmemo
		}
		e.Amount = store.Dollars(natural(amount, acctType))
		out = append(out, e)
	}
	return out, rows.Err()
}

func reconciledSum(ctx context.Context, q store.Q, accountID int64) (int64, error) {
	var s int64
	err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount), 0) FROM gl_entries WHERE account_id = ? AND cleared = 'R'`, accountID).Scan(&s)
	return s, err
}

func loadDraft(ctx context.Context, q store.Q, accountID int64) (*model.ReconcileDraft, error) {
	var d model.ReconcileDraft
	var ending int64
	var data string
	err := q.QueryRowContext(ctx, `SELECT statement_date, ending_balance, data FROM reconcile_drafts WHERE account_id = ?`, accountID).Scan(&d.StatementDate, &ending, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.EndingBalance = store.Dollars(ending)
	var dd draftData
	json.Unmarshal([]byte(data), &dd)
	d.ServiceCharge, d.Interest = dd.ServiceCharge, dd.Interest
	d.MarkedGLIDs = []int64{}
	rows, err := q.QueryContext(ctx, `SELECT id FROM gl_entries WHERE account_id = ? AND cleared = '*' ORDER BY id`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		d.MarkedGLIDs = append(d.MarkedGLIDs, id)
	}
	return &d, rows.Err()
}

// GET /reconcile/{accountId} -> model.ReconcileStart
func reconcileStart(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	ctx := c.Context()
	a, err := getAcct(ctx, c.DB, id)
	if err != nil {
		return err
	}
	if err := checkReconcilable(a); err != nil {
		return err
	}
	var out model.ReconcileStart
	if out.Account, err = loadAccountModel(ctx, c.DB, id); err != nil {
		return err
	}
	rsum, err := reconciledSum(ctx, c.DB, id)
	if err != nil {
		return err
	}
	out.BeginningBalance = store.Dollars(natural(rsum, a.Type))
	var lastEnd int64
	err = c.DB.QueryRowContext(ctx, `SELECT statement_date, ending_balance FROM reconciliations WHERE account_id = ?
		ORDER BY statement_date DESC, id DESC LIMIT 1`, id).Scan(&out.LastStatementDate, &lastEnd)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		v := store.Dollars(lastEnd)
		out.LastEndingBalance = &v
	}
	if out.Draft, err = loadDraft(ctx, c.DB, id); err != nil {
		return err
	}
	if out.Entries, err = loadEntries(ctx, c.DB, a.Type, `g.account_id = ? AND g.cleared <> 'R'`, id); err != nil {
		return err
	}
	return c.JSON(out)
}

// checkGLIDs verifies entries belong to the account and are not reconciled yet;
// returns them without duplicates, in order.
func checkGLIDs(ctx context.Context, q store.Q, accountID int64, ids []int64, field string) ([]int64, error) {
	seen := map[int64]bool{}
	var out []int64
	for _, gid := range ids {
		if seen[gid] {
			continue
		}
		var acc int64
		var cl string
		err := q.QueryRowContext(ctx, `SELECT account_id, cleared FROM gl_entries WHERE id = ?`, gid).Scan(&acc, &cl)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, apperr.Validation(field, "A marked transaction no longer exists. Close the reconcile window and start again.")
		}
		if err != nil {
			return nil, err
		}
		if acc != accountID {
			return nil, apperr.Validation(field, "A marked entry (id %d) does not belong to this account.", gid)
		}
		if cl == "R" {
			return nil, apperr.Validation(field, "A marked entry (id %d) has already been reconciled.", gid)
		}
		seen[gid] = true
		out = append(out, gid)
	}
	return out, nil
}

// PUT /reconcile/{accountId}/draft ("Leave"): keeps the header values and the marks.
func reconcileSaveDraft(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	var d model.ReconcileDraft
	if err := c.Decode(&d); err != nil {
		return err
	}
	if d.StatementDate != "" && !store.ValidDate(d.StatementDate) {
		return apperr.Validation("statementDate", "Please enter a valid statement date.")
	}
	ctx := c.Context()
	if err := store.MoneyErr("endingBalance", "The ending balance", d.EndingBalance); err != nil {
		return err
	}
	err = c.Write(func(tx *sql.Tx) error {
		a, err := getAcct(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := checkReconcilable(a); err != nil {
			return err
		}
		if d.StatementDate != "" {
			if err := checkStatementDate(ctx, tx, id, d.StatementDate); err != nil {
				return err
			}
		}
		marks, err := checkGLIDs(ctx, tx, id, d.MarkedGLIDs, "markedGlIds")
		if err != nil {
			return err
		}
		data, _ := json.Marshal(draftData{ServiceCharge: d.ServiceCharge, Interest: d.Interest})
		if _, err := tx.ExecContext(ctx, `INSERT INTO reconcile_drafts(account_id, statement_date, ending_balance, data, updated_at)
			VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET statement_date = excluded.statement_date,
			ending_balance = excluded.ending_balance, data = excluded.data, updated_at = excluded.updated_at`,
			id, d.StatementDate, store.Cents(d.EndingBalance), string(data), store.Now()); err != nil {
			return err
		}
		// markedGlIds absent/null: header only, the current marks stay as they are.
		if d.MarkedGLIDs == nil {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = '' WHERE account_id = ? AND cleared = '*'`, id); err != nil {
			return err
		}
		for _, gid := range marks {
			if _, err := tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = '*' WHERE id = ?`, gid); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true})
}

// adjTxn builds the service charge (interest=false) or interest (interest=true)
// transaction of a reconciliation: checks/deposits for bank accounts, charges/
// credits for credit cards, journal entries for other balance sheet accounts.
func adjTxn(a acct, adj model.ReconcileAdj, date string, interest bool) model.Txn {
	amt := store.Round2(adj.Amount)
	memo := "Service Charge"
	if interest {
		memo = "Interest Earned"
	}
	if a.Type == model.AcctCreditCard && !interest {
		memo = "Finance Charge"
	}
	accountID := a.ID
	t := model.Txn{Date: date, Memo: memo, AccountID: &accountID}
	line := model.TxnLine{Kind: model.LineExpense, AccountID: adj.AccountID, Amount: amt, Description: memo, ClassID: adj.ClassID}
	switch {
	case a.Type == model.AcctBank && !interest:
		t.Type = model.TxCheck
	case a.Type == model.AcctBank && interest:
		t.Type = model.TxDeposit
		line.Kind = model.LineDeposit
	case a.Type == model.AcctCreditCard && !interest:
		t.Type = model.TxCCCharge
	case a.Type == model.AcctCreditCard && interest:
		t.Type = model.TxCCCredit
	default:
		// service charge: credit the account, debit the expense; interest: the reverse
		t.Type = model.TxJournal
		t.AccountID = nil
		sign := 1.0
		if interest {
			sign = -1.0
		}
		t.Lines = []model.TxnLine{
			{Seq: 0, Kind: model.LineJournal, AccountID: &accountID, Amount: -sign * amt, Description: memo, ClassID: adj.ClassID},
			{Seq: 1, Kind: model.LineJournal, AccountID: adj.AccountID, Amount: sign * amt, Description: memo, ClassID: adj.ClassID},
		}
		return t
	}
	t.Lines = []model.TxnLine{line}
	return t
}

// entriesOf returns the ids of the ledger entries txnID posted to accountID.
func entriesOf(ctx context.Context, q store.Q, txnID, accountID int64) ([]int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM gl_entries WHERE txn_id = ? AND account_id = ? ORDER BY id`, txnID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// discrepancyAccount finds (or creates) the Expense account that receives
// reconciliation balance adjustments.
func discrepancyAccount(ctx context.Context, tx *sql.Tx) (int64, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM accounts WHERE name = ? AND type = ? ORDER BY parent_id IS NOT NULL, id LIMIT 1`,
		discrepancyAccountName, model.AcctExpense).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	name := discrepancyAccountName
	for i := 2; ; i++ {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE parent_id IS NULL AND name = ?`, name).Scan(&n); err != nil {
			return 0, err
		}
		if n == 0 {
			break
		}
		name = fmt.Sprintf("%s %d", discrepancyAccountName, i)
	}
	now := store.Now()
	res, err := tx.ExecContext(ctx, `INSERT INTO accounts(name, type, description, created_at, updated_at) VALUES(?,?,?,?,?)`,
		name, model.AcctExpense, "Balance adjustments entered when reconciling", now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func fmtMoney(cents int64) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	whole, frac := cents/100, cents%100
	s := fmt.Sprintf("%d", whole)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	s = fmt.Sprintf("%s.%02d", s, frac)
	if neg {
		s = "-" + s
	}
	return s
}

func loadReconciliations(ctx context.Context, q store.Q, where string, args ...any) ([]model.Reconciliation, error) {
	accts, err := store.FullNames(ctx, q, "accounts")
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, account_id, statement_date, beginning_balance, ending_balance, cleared_balance,
		completed_at, completed_by FROM reconciliations `+where+` ORDER BY statement_date DESC, id DESC`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Reconciliation{}
	for rows.Next() {
		var r model.Reconciliation
		var beg, end, cl int64
		if err := rows.Scan(&r.ID, &r.AccountID, &r.StatementDate, &beg, &end, &cl, &r.CompletedAt, &r.CompletedBy); err != nil {
			return nil, err
		}
		r.BeginningBalance, r.EndingBalance, r.ClearedBalance = store.Dollars(beg), store.Dollars(end), store.Dollars(cl)
		r.AccountName = accts[r.AccountID]
		out = append(out, r)
	}
	return out, rows.Err()
}

func loadReconciliation(ctx context.Context, q store.Q, id int64) (model.Reconciliation, error) {
	rs, err := loadReconciliations(ctx, q, `WHERE id = ?`, id)
	if err != nil {
		return model.Reconciliation{}, err
	}
	if len(rs) == 0 {
		return model.Reconciliation{}, apperr.NotFound("Reconciliation not found.")
	}
	return rs[0], nil
}

// POST /reconcile/{accountId}/finish -> model.Reconciliation ("Reconcile Now").
func reconcileFinish(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	var f model.ReconcileFinish
	if err := c.Decode(&f); err != nil {
		return err
	}
	var out model.Reconciliation
	err = c.Write(func(tx *sql.Tx) error {
		out, err = FinishReconcile(c.Context(), tx, id, f, saveOpts(c))
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(out)
}

// FinishReconcile completes a reconciliation of accountID inside tx (POST
// /reconcile/{accountId}/finish): enters the service charge / interest (and a
// balance adjustment when f.EnterAdjustment), marks the cleared entries 'R'
// and stores the reconciliation row.
func FinishReconcile(ctx context.Context, tx *sql.Tx, id int64, f model.ReconcileFinish, opt ledger.SaveOptions) (model.Reconciliation, error) {
	var out model.Reconciliation
	if !store.ValidDate(f.StatementDate) {
		return out, apperr.Validation("statementDate", "Please enter a valid statement date.")
	}
	if err := store.MoneyErr("endingBalance", "The ending balance", f.EndingBalance); err != nil {
		return out, err
	}
	for _, adj := range []*model.ReconcileAdj{f.ServiceCharge, f.Interest} {
		if adj != nil {
			if err := store.MoneyErr("serviceCharge", "The amount", adj.Amount); err != nil {
				return out, err
			}
		}
	}
	err := func() error {
		a, err := getAcct(ctx, tx, id)
		if err != nil {
			return err
		}
		if err := checkReconcilable(a); err != nil {
			return err
		}
		if err := checkStatementDate(ctx, tx, id, f.StatementDate); err != nil {
			return err
		}
		rsum, err := reconciledSum(ctx, tx, id)
		if err != nil {
			return err
		}
		beginning := natural(rsum, a.Type)
		cleared, err := checkGLIDs(ctx, tx, id, f.ClearedGLIDs, "clearedGlIds")
		if err != nil {
			return err
		}

		// Service charge and interest are entered now and are cleared by this reconciliation.
		var txnIDs [3]int64 // service charge, interest, adjustment
		for i, adj := range []*model.ReconcileAdj{f.ServiceCharge, f.Interest} {
			if adj == nil || store.Cents(adj.Amount) == 0 {
				continue
			}
			field := "serviceCharge"
			if i == 1 {
				field = "interest"
			}
			if adj.Amount < 0 {
				return apperr.Validation(field, "The %s amount cannot be negative.", map[string]string{"serviceCharge": "service charge", "interest": "interest"}[field])
			}
			if adj.AccountID == nil || *adj.AccountID == 0 {
				return apperr.Validation(field+".accountId", "Please choose an account for the %s.", map[string]string{"serviceCharge": "service charge", "interest": "interest earned"}[field])
			}
			date := adj.Date
			if date == "" {
				date = f.StatementDate
			}
			if !store.ValidDate(date) {
				return apperr.Validation(field+".date", "Please enter a valid date.")
			}
			t := adjTxn(a, *adj, date, i == 1)
			tid, err := ledger.Save(ctx, tx, &t, opt)
			if err != nil {
				return err
			}
			txnIDs[i] = tid
			gids, err := entriesOf(ctx, tx, tid, id)
			if err != nil {
				return err
			}
			cleared = append(cleared, gids...)
		}

		clearedSum := func() (int64, error) {
			var sum int64
			for _, gid := range cleared {
				var amt int64
				if err := tx.QueryRowContext(ctx, `SELECT amount FROM gl_entries WHERE id = ?`, gid).Scan(&amt); err != nil {
					return 0, err
				}
				sum += natural(amt, a.Type)
			}
			return sum, nil
		}
		csum, err := clearedSum()
		if err != nil {
			return err
		}
		ending := store.Cents(f.EndingBalance)
		if diff := ending - (beginning + csum); diff != 0 {
			if !f.EnterAdjustment {
				return apperr.Validation("endingBalance", "The difference between the statement ending balance (%s) and the cleared balance (%s) is %s. Mark the missing transactions, correct the ending balance, or enter an adjustment for the difference.",
					fmtMoney(ending), fmtMoney(beginning+csum), fmtMoney(diff))
			}
			discID, err := discrepancyAccount(ctx, tx)
			if err != nil {
				return err
			}
			amt := store.Dollars(signed(diff, a.Type))
			acctID := id
			t := model.Txn{Type: model.TxJournal, Date: f.StatementDate, Memo: "Balance Adjustment", Lines: []model.TxnLine{
				{Seq: 0, Kind: model.LineJournal, AccountID: &acctID, Amount: amt, Description: "Balance Adjustment"},
				{Seq: 1, Kind: model.LineJournal, AccountID: &discID, Amount: -amt, Description: "Balance Adjustment"},
			}}
			tid, err := ledger.Save(ctx, tx, &t, opt)
			if err != nil {
				return err
			}
			txnIDs[2] = tid
			gids, err := entriesOf(ctx, tx, tid, id)
			if err != nil {
				return err
			}
			cleared = append(cleared, gids...)
			if csum, err = clearedSum(); err != nil {
				return err
			}
			if ending != beginning+csum {
				return fmt.Errorf("reconcile: balance adjustment did not close the difference (%d)", ending-beginning-csum)
			}
		}

		nullTxn := func(v int64) any {
			if v == 0 {
				return nil
			}
			return v
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO reconciliations(account_id, statement_date, beginning_balance, ending_balance,
			cleared_balance, service_charge_txn_id, interest_txn_id, adjustment_txn_id, completed_at, completed_by)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, id, f.StatementDate, beginning, ending, beginning+csum,
			nullTxn(txnIDs[0]), nullTxn(txnIDs[1]), nullTxn(txnIDs[2]), store.Now(), opt.User)
		if err != nil {
			return err
		}
		recID, _ := res.LastInsertId()
		for _, gid := range cleared {
			if _, err := tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = 'R', reconcile_id = ? WHERE id = ?`, recID, gid); err != nil {
				return err
			}
		}
		// Keep what was cleared, with the amounts as reconciled.
		items, err := loadEntries(ctx, tx, a.Type, `g.reconcile_id = ?`, recID)
		if err != nil {
			return err
		}
		for _, e := range items {
			if _, err := tx.ExecContext(ctx, `INSERT INTO reconcile_items(reconcile_id, gl_id, txn_id, txn_type, type_label, date,
				ref_number, name, memo, amount) VALUES(?,?,?,?,?,?,?,?,?,?)`, recID, e.GLID, e.TxnID, e.Type, e.TypeLabel, e.Date,
				e.RefNumber, e.NameFull, e.Memo, store.Cents(e.Amount)); err != nil {
				return err
			}
		}
		// Entries left unmarked are uncleared again.
		if _, err := tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = '' WHERE account_id = ? AND cleared = '*'`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM reconcile_drafts WHERE account_id = ?`, id); err != nil {
			return err
		}
		out, err = loadReconciliation(ctx, tx, recID)
		return err
	}()
	return out, err
}

// POST /reconcile/{accountId}/undo-last: un-reconciles the last reconciliation
// of the account. Service charges, interest and adjustments entered by it stay.
func reconcileUndoLast(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var recID int64
	var stmt string
	err = c.Write(func(tx *sql.Tx) error {
		if _, err := getAcct(ctx, tx, id); err != nil {
			return err
		}
		err := tx.QueryRowContext(ctx, `SELECT id, statement_date FROM reconciliations WHERE account_id = ?
			ORDER BY statement_date DESC, id DESC LIMIT 1`, id).Scan(&recID, &stmt)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.Conflict("This account has no previous reconciliation to undo.")
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = '', reconcile_id = NULL WHERE reconcile_id = ?`, recID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM reconciliations WHERE id = ?`, recID)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true, "reconciliationId": recID, "statementDate": stmt})
}

// GET /reconciliations?accountId= -> model.Reconciliation[] (newest statement first)
func listReconciliations(c *httpx.Ctx) error {
	where, args := "", []any{}
	if id := c.QInt("accountId"); id > 0 {
		where, args = "WHERE account_id = ?", append(args, id)
	}
	rs, err := loadReconciliations(c.Context(), c.DB, where, args...)
	if err != nil {
		return err
	}
	return c.JSON(rs)
}

// GET /reconciliations/{id}/report -> model.ReconcileReport
func reconcileReport(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	var out model.ReconcileReport
	if out.Reconciliation, err = loadReconciliation(ctx, c.DB, id); err != nil {
		return err
	}
	rec := out.Reconciliation
	a, err := getAcct(ctx, c.DB, rec.AccountID)
	if err != nil {
		return err
	}
	snap, hasSnap, err := snapshotEntries(ctx, c.DB, id)
	if err != nil {
		return err
	}
	if hasSnap {
		out.Cleared = snap
	} else if out.Cleared, err = loadEntries(ctx, c.DB, a.Type, `g.reconcile_id = ?`, id); err != nil {
		return err
	}
	if out.Changes, err = reconcileChanges(ctx, c.DB, a.Type, rec); err != nil {
		return err
	}
	// Not cleared at this reconciliation: still open, or cleared by a later one.
	if out.Uncleared, err = loadEntries(ctx, c.DB, a.Type, `g.account_id = ? AND g.date <= ? AND (g.reconcile_id IS NULL OR g.reconcile_id > ?)`,
		rec.AccountID, rec.StatementDate, id); err != nil {
		return err
	}
	var inc, dec int64
	for _, e := range out.Cleared {
		if v := store.Cents(e.Amount); v > 0 {
			inc += v
		} else {
			dec -= v
		}
	}
	out.ClearedIncrease, out.ClearedDecrease = store.Dollars(inc), store.Dollars(dec)
	var reg int64
	if err := c.DB.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount), 0) FROM gl_entries WHERE account_id = ? AND date <= ?`,
		rec.AccountID, rec.StatementDate).Scan(&reg); err != nil {
		return err
	}
	out.RegisterBalance = store.Dollars(natural(reg, a.Type))
	return c.JSON(out)
}

// PUT /gl/{id}/cleared body {cleared: "" | "*"}: register check mark toggle.
// Applies to every entry the transaction posted to that account. Reconciled
// entries need a confirmation and are detached from their reconciliation.
func setCleared(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body struct {
		Cleared string `json:"cleared"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	if body.Cleared != "" && body.Cleared != "*" {
		return apperr.Validation("cleared", "Cleared status must be blank or \"*\".")
	}
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		var txnID, accountID int64
		err := tx.QueryRowContext(ctx, `SELECT txn_id, account_id FROM gl_entries WHERE id = ?`, id).Scan(&txnID, &accountID)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Ledger entry not found.")
		}
		if err != nil {
			return err
		}
		var reconciled int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM gl_entries WHERE txn_id = ? AND account_id = ? AND cleared = 'R'`, txnID, accountID).Scan(&reconciled); err != nil {
			return err
		}
		if reconciled > 0 && !c.Accepts(apperr.WarnReconciled) {
			return apperr.ConfirmKind(apperr.WarnReconciled, "This transaction has been reconciled. Changing its cleared status will change the beginning balance of your next reconciliation; the previous reconciliation report will list it as a change. Do you want to continue?")
		}
		_, err = tx.ExecContext(ctx, `UPDATE gl_entries SET cleared = ?, reconcile_id = NULL WHERE txn_id = ? AND account_id = ?`, body.Cleared, txnID, accountID)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true, "cleared": body.Cleared})
}

// checkStatementDate refuses a statement date on or before the account's last
// reconciliation (reports and "undo last" rely on reconciliations in date order).
func checkStatementDate(ctx context.Context, q store.Q, accountID int64, date string) error {
	var last sql.NullString
	if err := q.QueryRowContext(ctx, `SELECT MAX(statement_date) FROM reconciliations WHERE account_id = ?`, accountID).Scan(&last); err != nil {
		return err
	}
	if last.Valid && last.String != "" && date <= last.String {
		return apperr.Validation("statementDate", "This statement date is not after your last reconciliation (%s). Choose a later date, or undo the last reconciliation first.",
			store.FmtDate(last.String))
	}
	return nil
}

// snapshotEntries returns what a reconciliation cleared, with the amounts as
// reconciled (false when it was finished before snapshots were kept).
func snapshotEntries(ctx context.Context, q store.Q, recID int64) ([]model.ReconcileEntry, bool, error) {
	rows, err := q.QueryContext(ctx, `SELECT gl_id, txn_id, txn_type, type_label, date, ref_number, name, memo, amount
		FROM reconcile_items WHERE reconcile_id = ? ORDER BY date, ref_number, gl_id`, recID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	out := []model.ReconcileEntry{}
	for rows.Next() {
		var e model.ReconcileEntry
		var amt int64
		if err := rows.Scan(&e.GLID, &e.TxnID, &e.Type, &e.TypeLabel, &e.Date, &e.RefNumber, &e.NameFull, &e.Memo, &amt); err != nil {
			return nil, false, err
		}
		e.Amount = store.Dollars(amt)
		e.Cleared = "R"
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return out, len(out) > 0, nil
}

// reconcileChanges lists the transactions a reconciliation cleared that were
// changed, unmarked, voided or deleted since (compared with its snapshot).
func reconcileChanges(ctx context.Context, q store.Q, acctType string, rec model.Reconciliation) ([]model.ReconcileChange, error) {
	out := []model.ReconcileChange{}
	snap, has, err := snapshotEntries(ctx, q, rec.ID)
	if err != nil || !has {
		return out, err
	}
	cur, err := loadEntries(ctx, q, acctType, `g.reconcile_id = ?`, rec.ID)
	if err != nil {
		return nil, err
	}
	type agg struct {
		info       model.ReconcileEntry
		snap, live int64
		inSnap     bool
		inLive     bool
	}
	by := map[int64]*agg{}
	var order []int64
	get := func(e model.ReconcileEntry) *agg {
		a, ok := by[e.TxnID]
		if !ok {
			a = &agg{info: e}
			by[e.TxnID] = a
			order = append(order, e.TxnID)
		}
		return a
	}
	for _, e := range snap {
		a := get(e)
		a.snap += store.Cents(e.Amount)
		a.inSnap = true
	}
	for _, e := range cur {
		a := get(e)
		a.live += store.Cents(e.Amount)
		a.inLive = true
		if !a.inSnap {
			a.info = e
		}
	}
	for _, id := range order {
		a := by[id]
		if a.snap == a.live && a.inSnap == a.inLive {
			continue
		}
		var exists, voided int
		err := q.QueryRowContext(ctx, `SELECT COUNT(*), IFNULL(MAX(voided), 0) FROM txns WHERE id = ?`, id).Scan(&exists, &voided)
		if err != nil {
			return nil, err
		}
		change := "Amount changed"
		switch {
		case exists == 0:
			change = "Deleted"
		case voided == 1:
			change = "Voided"
		case !a.inLive:
			change = "Uncleared"
		}
		out = append(out, model.ReconcileChange{
			ReconciliationID: rec.ID, StatementDate: rec.StatementDate, TxnID: id, Type: a.info.Type, TypeLabel: a.info.TypeLabel,
			Date: a.info.Date, RefNumber: a.info.RefNumber, NameFull: a.info.NameFull,
			ReconciledAmount: store.Dollars(a.snap), CurrentAmount: store.Dollars(a.live), Change: change,
			Effect: store.Dollars(a.live - a.snap),
		})
	}
	return out, nil
}

// GET /reconcile/{accountId}/discrepancies -> model.ReconcileDiscrepancies:
// every reconciled transaction of the account changed since its reconciliation.
func reconcileDiscrepancies(c *httpx.Ctx) error {
	id, err := c.ID("accountId")
	if err != nil {
		return err
	}
	ctx := c.Context()
	a, err := getAcct(ctx, c.DB, id)
	if err != nil {
		return err
	}
	if err := checkReconcilable(a); err != nil {
		return err
	}
	out := model.ReconcileDiscrepancies{AccountID: id, AccountName: a.FullName, Changes: []model.ReconcileChange{}}
	rsum, err := reconciledSum(ctx, c.DB, id)
	if err != nil {
		return err
	}
	out.BeginningBalance = store.Dollars(natural(rsum, a.Type))
	recs, err := loadReconciliations(ctx, c.DB, `WHERE account_id = ?`, id)
	if err != nil {
		return err
	}
	if len(recs) > 0 {
		out.LastStatementDate = recs[0].StatementDate
		out.LastEndingBalance = recs[0].EndingBalance
	}
	for _, r := range recs {
		ch, err := reconcileChanges(ctx, c.DB, a.Type, r)
		if err != nil {
			return err
		}
		out.Changes = append(out.Changes, ch...)
	}
	out.Difference = store.Round2(out.BeginningBalance - out.LastEndingBalance)
	return c.JSON(out)
}
