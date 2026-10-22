package posting

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

func verify(c *httpx.Ctx, from, to string) (model.VerifyResult, error) {
	res := model.VerifyResult{Problems: []model.VerifyProblem{}, Accounts: []model.AccountTieOut{}}
	if to == "" {
		to = store.Today()
	}
	if !store.ValidDate(to) {
		return res, apperr.Validation("to", "Please enter a valid To date.")
	}
	if from != "" && !store.ValidDate(from) {
		return res, apperr.Validation("from", "Please enter a valid From date.")
	}
	if from != "" && from > to {
		return res, apperr.Validation("from", "The From date must be on or before the To date.")
	}
	ctx := c.Context()
	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return res, err
	}
	items, err := loadItems(ctx, c.DB)
	if err != nil {
		return res, err
	}
	lk := lookup(c)
	if !lk.OK {
		if !books.Default.Ping(ctx) {
			return res, apperr.BooksUnavailable("SerieX Books is not running at %s. Start SerieX Books and try again.", books.Default.BaseURL)
		}
	}

	refs, err := postedRefs(ctx, c.DB, from, to)
	if err != nil {
		return res, err
	}
	s := books.S(c)
	for _, ref := range refs {
		r, err := build(ctx, c.DB, ref.Entity, ref.ID, prefs, items)
		if err != nil {
			return res, err
		}
		problem := func(msg string) {
			res.Problems = append(res.Problems, model.VerifyProblem{Entity: r.Entity, ID: r.ID,
				Label: r.Label + " (" + mdy(r.Date) + ")", BooksTxnID: r.TxnID, Problem: msg})
		}
		bt, own, err := ownTxn(ctx, s, r.Entity, r.ID, *r.TxnID)
		if err != nil {
			return res, books.ToAppErr(err)
		}
		res.Checked++
		if !own {
			problem("missing in SerieX Books")
			continue
		}
		for _, msg := range compareTxn(r, &bt, lk) {
			problem(msg)
		}
	}

	accts, err := tieOut(c, lk, to)
	if err != nil {
		return res, err
	}
	res.Accounts = accts
	return res, nil
}

// postedRefs lists the posted records dated from..to (from "" = no lower bound).
func postedRefs(ctx context.Context, q store.Q, from, to string) ([]model.SyncRef, error) {
	if from == "" {
		from = "0000-01-01"
	}
	rows, err := q.QueryContext(ctx, `
		SELECT 'paycheck' AS entity, id, check_date AS d, 1 AS o FROM paychecks
			WHERE sync_status = 'posted' AND books_txn_id IS NOT NULL AND check_date BETWEEN ?1 AND ?2
		UNION ALL SELECT 'liability_payment', id, date, 2 FROM liability_payments
			WHERE sync_status = 'posted' AND books_txn_id IS NOT NULL AND date BETWEEN ?1 AND ?2
		UNION ALL SELECT 'adjustment', id, date, 3 FROM liability_adjustments
			WHERE sync_status = 'posted' AND books_txn_id IS NOT NULL AND date BETWEEN ?1 AND ?2
		ORDER BY d, o, id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.SyncRef
	for rows.Next() {
		var r model.SyncRef
		var d string
		var o int
		if err := rows.Scan(&r.Entity, &r.ID, &d, &o); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func idEq(a, b *int64) bool {
	if a == nil || *a == 0 {
		return b == nil || *b == 0
	}
	return b != nil && *a == *b
}

// compareTxn lists the differences between what payroll would post now and the Books transaction.
func compareTxn(r *record, bt *books.Txn, lk *Lookups) []string {
	var out []string
	if r.Voided != bt.Voided {
		if r.Voided {
			return []string{"voided in payroll but not in SerieX Books"}
		}
		return []string{"voided in SerieX Books but not in payroll"}
	}
	if r.Voided {
		return nil
	}
	if r.NoPost != "" {
		return []string{"should not be in SerieX Books: " + r.NoPost}
	}
	if r.Problem != "" {
		return []string{"cannot be compared: " + r.Problem}
	}
	exp := &r.Txn
	if bt.Type != exp.Type {
		return []string{fmt.Sprintf("transaction type differs: payroll %s, Books %s", exp.Type, bt.Type)}
	}
	if bt.Date != exp.Date {
		out = append(out, fmt.Sprintf("date differs: payroll %s, Books %s", mdy(exp.Date), mdy(bt.Date)))
	}
	if exp.Type == books.TxCheck {
		if !idEq(exp.AccountID, bt.AccountID) {
			out = append(out, fmt.Sprintf("bank account differs: payroll %s, Books %s", acctLabel(lk, exp.AccountID), acctLabel(lk, bt.AccountID)))
		}
		if !idEq(exp.NameID, bt.NameID) {
			out = append(out, fmt.Sprintf("payee differs: payroll %s, Books %s", nameLabel(lk, exp.NameID), firstNonEmpty(bt.NameFull, nameLabel(lk, bt.NameID))))
		}
		if exp.RefNumber != "" && !exp.ToBePrinted && bt.RefNumber != exp.RefNumber {
			out = append(out, fmt.Sprintf("check number differs: payroll %s, Books %s", exp.RefNumber, firstNonEmpty(bt.RefNumber, "(none)")))
		}
		if got := store.Cents(bt.Amount); got != r.Total {
			out = append(out, fmt.Sprintf("amount differs: payroll %s, Books %s", fmtMoney(r.Total), fmtMoney(got)))
		}
	} else {
		var got int64
		for _, l := range bt.Lines {
			if l.Amount > 0 {
				got += store.Cents(l.Amount)
			}
		}
		if got != r.Total {
			out = append(out, fmt.Sprintf("amount differs: payroll %s, Books %s", fmtMoney(r.Total), fmtMoney(got)))
		}
	}
	want, have := map[int64]int64{}, map[int64]int64{}
	for _, l := range exp.Lines {
		if l.AccountID != nil {
			want[*l.AccountID] += store.Cents(l.Amount)
		}
	}
	for _, l := range bt.Lines {
		if l.AccountID != nil {
			have[*l.AccountID] += store.Cents(l.Amount)
		}
	}
	var ids []int64
	for id := range want {
		ids = append(ids, id)
	}
	for id := range have {
		if _, ok := want[id]; !ok {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		if want[id] != have[id] {
			id := id
			out = append(out, fmt.Sprintf("account %s differs: payroll %s, Books %s", acctLabel(lk, &id), fmtMoney(want[id]), fmtMoney(have[id])))
		}
	}
	return out
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func acctLabel(lk *Lookups, id *int64) string {
	if id == nil || *id == 0 {
		return "(none)"
	}
	if n := lk.AccountName(id); n != "" {
		return n
	}
	return "#" + strconv.FormatInt(*id, 10)
}

func nameLabel(lk *Lookups, id *int64) string {
	if id == nil || *id == 0 {
		return "(none)"
	}
	for _, m := range []map[int64]books.Name{lk.Others, lk.Vendors, lk.Jobs} {
		if n, ok := m[*id]; ok {
			return n.FullName
		}
	}
	return "#" + strconv.FormatInt(*id, 10)
}

// ---------------------------------------------------------------------------
// Liability account tie-out

// tieOut compares, for every liability account used by payroll items, the
// payroll liability balance as of `to` (accrued on paychecks by check date +
// adjustments by adjustment date - liability payments by payment date: the
// dates their Books transactions carry) with the Books trial balance amount of
// the account (credit - debit). The part of the balance that is not in Books
// by design (year-to-date entries, earlier tax payments, adjustments that do not
// affect accounts, records saved while posting was off) and the part waiting
// to be posted (pending / error) are reported separately and left out of the
// difference, so a healthy file shows 0.00.
func tieOut(c *httpx.Ctx, lk *Lookups, to string) ([]model.AccountTieOut, error) {
	ctx := c.Context()
	const (
		posted = iota
		notInBooks
		notPosted
	)
	var bal [3]map[int64]int64
	for i := range bal {
		bal[i] = map[int64]int64{}
	}
	accts := map[int64]bool{}
	rows, err := c.DB.QueryContext(ctx, `SELECT DISTINCT liability_account_id FROM payroll_items WHERE liability_account_id IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		accts[id] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	// each query returns account, class (0 posted, 1 not in Books by design, 2 not posted yet), amount
	sums := []struct {
		sign int64
		sql  string
	}{
		{1, `SELECT pi.liability_account_id,
				CASE WHEN p.kind = 'ytd' OR p.sync_status = 'none' THEN 1 WHEN p.sync_status = 'posted' THEN 0 ELSE 2 END,
				SUM(pl.amount) FROM paycheck_lines pl
			JOIN paychecks p ON p.id = pl.paycheck_id JOIN payroll_items pi ON pi.id = pl.item_id
			WHERE p.voided = 0 AND p.check_date <= ? AND pl.category IN ('employee_tax','employer_tax','deduction','contribution')
			AND pi.liability_account_id IS NOT NULL GROUP BY 1, 2`},
		{1, `SELECT pi.liability_account_id,
				CASE WHEN a.sync_status = 'none' THEN 1 WHEN a.sync_status = 'posted' THEN 0 ELSE 2 END,
				SUM(l.amount) FROM liability_adjustment_lines l
			JOIN liability_adjustments a ON a.id = l.adjustment_id JOIN payroll_items pi ON pi.id = l.item_id
			WHERE a.date <= ? AND pi.liability_account_id IS NOT NULL GROUP BY 1, 2`},
		{-1, `SELECT pi.liability_account_id,
				CASE WHEN p.kind = 'prior' OR p.sync_status = 'none' THEN 1 WHEN p.sync_status = 'posted' THEN 0 ELSE 2 END,
				SUM(l.amount) FROM liability_payment_lines l
			JOIN liability_payments p ON p.id = l.payment_id JOIN payroll_items pi ON pi.id = l.item_id
			WHERE p.voided = 0 AND l.kind = 'item' AND p.date <= ? AND pi.liability_account_id IS NOT NULL
			GROUP BY 1, 2`},
	}
	for _, sq := range sums {
		rows, err := c.DB.QueryContext(ctx, sq.sql, to)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, amt int64
			var class int
			if err := rows.Scan(&id, &class, &amt); err != nil {
				rows.Close()
				return nil, err
			}
			if class < posted || class > notPosted {
				class = notPosted
			}
			bal[class][id] += sq.sign * amt
			accts[id] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}

	booksBal, err := trialBalance(ctx, books.S(c), to)
	if err != nil {
		return nil, err
	}
	out := []model.AccountTieOut{}
	for id := range accts {
		id := id
		pb, bb := bal[posted][id], booksBal[id]
		nb, np := bal[notInBooks][id], bal[notPosted][id]
		out = append(out, model.AccountTieOut{
			AccountID:      id,
			AccountName:    acctLabel(lk, &id),
			PayrollBalance: store.Dollars(pb + nb + np),
			BooksBalance:   store.Dollars(bb),
			Difference:     store.Dollars(pb - bb),
			NotInBooks:     store.Dollars(nb),
			NotPosted:      store.Dollars(np),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AccountName != out[j].AccountName {
			return strings.ToLower(out[i].AccountName) < strings.ToLower(out[j].AccountName)
		}
		return out[i].AccountID < out[j].AccountID
	})
	return out, nil
}

// trialBalance returns credit - debit (cents) of every account in the Books
// trial balance as of `to`.
func trialBalance(ctx context.Context, s books.Session, to string) (map[int64]int64, error) {
	rep, err := books.Default.Report(ctx, s, "trial_balance", map[string]string{"to": to, "basis": "accrual"})
	if err != nil {
		return nil, books.ToAppErr(err)
	}
	out := map[int64]int64{}
	rows, _ := rep["rows"].([]any)
	for _, raw := range rows {
		row, _ := raw.(map[string]any)
		if row == nil || row["kind"] != "data" {
			continue
		}
		drill, _ := row["drill"].(map[string]any)
		params, _ := drill["params"].(map[string]any)
		ids, _ := params["accountIds"].(string)
		id, err := strconv.ParseInt(ids, 10, 64)
		if err != nil || id <= 0 {
			continue
		}
		cells, _ := row["cells"].(map[string]any)
		debit, _ := cells["debit"].(float64)
		credit, _ := cells["credit"].(float64)
		out[id] += store.Cents(credit) - store.Cents(debit)
	}
	return out, nil
}
