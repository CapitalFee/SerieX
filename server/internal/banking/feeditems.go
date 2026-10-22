package banking

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

type feedItemRow struct {
	model.BankFeedItem
	cents int64
}

func loadFeedItems(ctx context.Context, q store.Q, where string, args ...any) ([]feedItemRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, account_id, date, description, amount, check_number, `+effStatus+`, txn_id
		FROM bank_feed_items WHERE `+where+` ORDER BY date, id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []feedItemRow
	for rows.Next() {
		var it feedItemRow
		var txnID sql.NullInt64
		if err := rows.Scan(&it.ID, &it.AccountID, &it.Date, &it.Description, &it.cents, &it.CheckNumber, &it.Status, &txnID); err != nil {
			return nil, err
		}
		it.Amount = store.Dollars(it.cents)
		it.TxnID = store.PtrID(txnID)
		it.Matches = []model.BankFeedMatch{}
		out = append(out, it)
	}
	return out, rows.Err()
}

func loadFeedItem(ctx context.Context, q store.Q, id int64) (feedItemRow, error) {
	its, err := loadFeedItems(ctx, q, `id = ?`, id)
	if err != nil {
		return feedItemRow{}, err
	}
	if len(its) == 0 {
		return feedItemRow{}, apperr.NotFound("Downloaded transaction not found.")
	}
	return its[0], nil
}

// feedNatural converts a feed amount (+ money in) to the account's natural
// sign (bank: + deposit; credit card: + charge).
func feedNatural(cents int64, acctType string) int64 {
	if model.IsDebitNormal(acctType) {
		return cents
	}
	return -cents
}

// candidate is a register transaction a downloaded item may match.
type candidate struct {
	match   model.BankFeedMatch
	natural int64
	date    time.Time
}

func loadCandidates(ctx context.Context, q store.Q, a acct, names map[int64]string, where string, args ...any) ([]candidate, error) {
	rows, err := q.QueryContext(ctx, `SELECT g.txn_id, t.type, t.date, t.ref_number, t.name_id, COALESCE(ha.type, ''), SUM(g.amount)
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id LEFT JOIN accounts ha ON ha.id = t.account_id
		WHERE g.account_id = ? AND `+where+` GROUP BY g.txn_id ORDER BY t.date, g.txn_id`, append([]any{a.ID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []candidate
	for rows.Next() {
		var cd candidate
		var nameID sql.NullInt64
		var headerType string
		var sum int64
		m := &cd.match
		if err := rows.Scan(&m.TxnID, &m.Type, &m.Date, &m.RefNumber, &nameID, &headerType, &sum); err != nil {
			return nil, err
		}
		m.TypeLabel = typeLabel(m.Type, headerType)
		if nameID.Valid {
			m.NameFull = names[nameID.Int64]
		}
		cd.natural = natural(sum, a.Type)
		// amount in the feed's sign (+ money in) so it compares with the item amount
		m.Amount = store.Dollars(feedNatural(cd.natural, a.Type))
		cd.date, _ = store.ParseDate(m.Date)
		out = append(out, cd)
	}
	return out, rows.Err()
}

func absDays(a, b time.Time) int {
	d := a.Sub(b).Hours() / 24
	if d < 0 {
		d = -d
	}
	return int(d + 0.5)
}

// suggester proposes a payee and an account for new downloaded items.
type suggester struct {
	ctx      context.Context
	q        store.Q
	rules    []model.BankRule
	names    []nameEntry
	fullName map[int64]string
	byDesc   map[string]int64 // lower(description) of added items -> txn id
	acctOf   map[int64]*int64 // name id -> suggested account (cache)
}

type nameEntry struct {
	id    int64
	lower string
	kind  string
}

func newSuggester(ctx context.Context, q store.Q, fullName map[int64]string) (*suggester, error) {
	s := &suggester{ctx: ctx, q: q, fullName: fullName, byDesc: map[string]int64{}, acctOf: map[int64]*int64{}}
	var err error
	if s.rules, err = loadRules(ctx, q, ""); err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, name, kind FROM names WHERE active = 1`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var n nameEntry
		var name string
		if err := rows.Scan(&n.id, &name, &n.kind); err != nil {
			rows.Close()
			return nil, err
		}
		n.lower = strings.ToLower(collapseSpaces(name))
		if len(n.lower) >= 3 {
			s.names = append(s.names, n)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT description, txn_id FROM bank_feed_items WHERE status = 'added' AND txn_id IS NOT NULL ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d string
		var id int64
		if err := rows.Scan(&d, &id); err != nil {
			rows.Close()
			return nil, err
		}
		s.byDesc[strings.ToLower(collapseSpaces(d))] = id
	}
	rows.Close()
	return s, rows.Err()
}

func isWordChar(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= '0' && b <= '9' || b >= 'A' && b <= 'Z'
}

// containsWord: needle occurs in hay on word boundaries.
func containsWord(hay, needle string) bool {
	for from := 0; ; {
		i := strings.Index(hay[from:], needle)
		if i < 0 {
			return false
		}
		i += from
		end := i + len(needle)
		if (i == 0 || !isWordChar(hay[i-1]) || !isWordChar(needle[0])) && (end == len(hay) || !isWordChar(hay[end]) || !isWordChar(needle[len(needle)-1])) {
			return true
		}
		from = i + 1
	}
}

// lastAccountOf returns the account most recently used with a payee on
// checks, deposits, credit card charges/credits and bills.
func (s *suggester) lastAccountOf(nameID int64) *int64 {
	if v, ok := s.acctOf[nameID]; ok {
		return v
	}
	var id int64
	err := s.q.QueryRowContext(s.ctx, `SELECT l.account_id FROM txn_lines l JOIN txns t ON t.id = l.txn_id JOIN accounts a ON a.id = l.account_id
		WHERE t.name_id = ? AND t.voided = 0 AND t.type IN ('CHK', 'DEP', 'CCCHARGE', 'CCCREDIT', 'BILL', 'BILLCRED')
		  AND a.type NOT IN ('Accounts Receivable', 'Accounts Payable') AND a.special <> ?
		ORDER BY t.date DESC, t.id DESC, l.seq LIMIT 1`, nameID, store.SpecialUndepositedFunds).Scan(&id)
	var out *int64
	if err == nil {
		out = &id
	} else {
		// vendor prefill accounts
		var prefill string
		if s.q.QueryRowContext(s.ctx, `SELECT prefill_account_ids FROM names WHERE id = ?`, nameID).Scan(&prefill) == nil {
			var ids []int64
			if json.Unmarshal([]byte(prefill), &ids) == nil && len(ids) > 0 && ids[0] > 0 {
				out = &ids[0]
			}
		}
	}
	s.acctOf[nameID] = out
	return out
}

func (s *suggester) suggest(it *feedItemRow) {
	desc := strings.ToLower(collapseSpaces(it.Description))
	// 1. bank rules
	for _, r := range s.rules {
		if r.AccountID != nil && *r.AccountID != it.AccountID {
			continue
		}
		if (r.Direction == "in" && it.cents <= 0) || (r.Direction == "out" && it.cents >= 0) {
			continue
		}
		if r.MatchText == "" || !strings.Contains(desc, strings.ToLower(collapseSpaces(r.MatchText))) {
			continue
		}
		it.SuggestedNameID, it.SuggestedAccountID = r.NameID, r.TargetAccountID
		it.SuggestedPayee = r.RenameTo
		if it.SuggestedPayee == "" && r.NameID != nil {
			it.SuggestedPayee = s.fullName[*r.NameID]
		}
		if r.NameID != nil && r.TargetAccountID == nil {
			it.SuggestedAccountID = s.lastAccountOf(*r.NameID)
		}
		return
	}
	// 2. an earlier downloaded item with the same description that was added
	if txnID, ok := s.byDesc[desc]; ok {
		var nameID sql.NullInt64
		if s.q.QueryRowContext(s.ctx, `SELECT name_id FROM txns WHERE id = ?`, txnID).Scan(&nameID) == nil {
			var acctID int64
			err := s.q.QueryRowContext(s.ctx, `SELECT account_id FROM txn_lines WHERE txn_id = ? AND account_id IS NOT NULL ORDER BY seq LIMIT 1`, txnID).Scan(&acctID)
			it.SuggestedNameID = store.PtrID(nameID)
			if err == nil {
				it.SuggestedAccountID = &acctID
			}
			if nameID.Valid {
				it.SuggestedPayee = s.fullName[nameID.Int64]
			}
			return
		}
	}
	// 3. a payee whose name appears in the description (longest name wins;
	// vendors preferred for money out, customers for money in)
	var best *nameEntry
	for i := range s.names {
		n := &s.names[i]
		if !containsWord(desc, n.lower) {
			continue
		}
		if best == nil || len(n.lower) > len(best.lower) ||
			(len(n.lower) == len(best.lower) && preferKind(n.kind, it.cents) && !preferKind(best.kind, it.cents)) {
			best = n
		}
	}
	if best != nil {
		id := best.id
		it.SuggestedNameID = &id
		it.SuggestedPayee = s.fullName[id]
		it.SuggestedAccountID = s.lastAccountOf(id)
	}
}

func preferKind(kind string, cents int64) bool {
	if cents < 0 {
		return kind == model.NameVendor
	}
	return kind == model.NameCustomer
}

// GET /bank-feeds/{accountId}/items?status=new -> model.BankFeedItem[]
func feedItems(c *httpx.Ctx) error {
	accountID, err := c.ID("accountId")
	if err != nil {
		return err
	}
	ctx := c.Context()
	a, err := getAcct(ctx, c.DB, accountID)
	if err != nil {
		return err
	}
	where, args := `account_id = ?`, []any{accountID}
	if st := c.Q("status"); st != "" && st != "all" {
		if !oneOf(st, "new", "added", "matched", "ignored") {
			return apperr.Validation("status", "Invalid status %q.", st)
		}
		where += ` AND ` + effStatus + ` = ?`
		args = append(args, st)
	}
	items, err := loadFeedItems(ctx, c.DB, where, args...)
	if err != nil {
		return err
	}
	names, err := store.FullNames(ctx, c.DB, "names")
	if err != nil {
		return err
	}
	var open, linked []candidate
	var sug *suggester
	hasNew, hasLinked := false, false
	for _, it := range items {
		if it.Status == "new" {
			hasNew = true
		} else if it.TxnID != nil {
			hasLinked = true
		}
	}
	if hasNew {
		// Unreconciled register transactions not yet tied to another downloaded item of
		// this account (a transfer or a card payment can be matched once in each feed).
		if open, err = loadCandidates(ctx, c.DB, a, names, `g.cleared <> 'R' AND g.txn_id NOT IN
			(SELECT txn_id FROM bank_feed_items WHERE txn_id IS NOT NULL AND status IN ('added', 'matched') AND account_id = ?)`, accountID); err != nil {
			return err
		}
		if sug, err = newSuggester(ctx, c.DB, names); err != nil {
			return err
		}
	}
	if hasLinked {
		if linked, err = loadCandidates(ctx, c.DB, a, names, `g.txn_id IN (SELECT txn_id FROM bank_feed_items WHERE account_id = ? AND txn_id IS NOT NULL)`, accountID); err != nil {
			return err
		}
	}
	linkedByID := map[int64]model.BankFeedMatch{}
	for _, cd := range linked {
		linkedByID[cd.match.TxnID] = cd.match
	}
	out := make([]model.BankFeedItem, 0, len(items))
	for i := range items {
		it := &items[i]
		switch {
		case it.Status == "new":
			nat := feedNatural(it.cents, a.Type)
			d, _ := store.ParseDate(it.Date)
			type scored struct {
				m    model.BankFeedMatch
				days int
				chk  bool
			}
			var ms []scored
			for _, cd := range open {
				if cd.natural != nat {
					continue
				}
				days := absDays(cd.date, d)
				if days > 10 {
					continue
				}
				ms = append(ms, scored{cd.match, days, it.CheckNumber != "" && cd.match.RefNumber == it.CheckNumber})
			}
			sort.SliceStable(ms, func(x, y int) bool {
				if ms[x].chk != ms[y].chk {
					return ms[x].chk
				}
				return ms[x].days < ms[y].days
			})
			for _, s := range ms {
				it.Matches = append(it.Matches, s.m)
			}
			sug.suggest(it)
		case it.TxnID != nil:
			if m, ok := linkedByID[*it.TxnID]; ok {
				it.Matches = append(it.Matches, m)
			}
		}
		out = append(out, it.BankFeedItem)
	}
	return c.JSON(out)
}

func oneOf(v string, allowed ...string) bool {
	for _, a := range allowed {
		if v == a {
			return true
		}
	}
	return false
}

func absCents(c int64) int64 {
	if c < 0 {
		return -c
	}
	return c
}

// POST /bank-feed-items/{id}/add body model.BankFeedAdd -> {txnId}
func feedAdd(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body model.BankFeedAdd
	if err := c.Decode(&body); err != nil {
		return err
	}
	if body.AccountID == 0 {
		return apperr.Validation("accountId", "Please choose an account for this transaction.")
	}
	ctx := c.Context()
	var txnID int64
	err = c.Write(func(tx *sql.Tx) error {
		it, err := loadFeedItem(ctx, tx, id)
		if err != nil {
			return err
		}
		if it.Status != "new" {
			return apperr.Conflict("This downloaded transaction has already been %s. Undo it first.", it.Status)
		}
		a, err := getAcct(ctx, tx, it.AccountID)
		if err != nil {
			return err
		}
		if err := checkFeedAccount(a); err != nil {
			return err
		}
		if it.cents == 0 {
			return apperr.Validation("amount", "A transaction with a zero amount cannot be added.")
		}
		memo := strings.TrimSpace(body.Memo)
		if memo == "" {
			memo = it.Description
		}
		ref := strings.TrimSpace(body.RefNumber)
		if ref == "" {
			ref = it.CheckNumber
		}
		if body.NameID != nil && *body.NameID == 0 {
			body.NameID = nil
		}
		if body.ClassID != nil && *body.ClassID == 0 {
			body.ClassID = nil
		}
		acctID, otherID := a.ID, body.AccountID
		amt := store.Dollars(absCents(it.cents))
		t := model.Txn{Date: it.Date, RefNumber: ref, NameID: body.NameID, AccountID: &acctID, Memo: memo}
		line := model.TxnLine{Kind: model.LineExpense, AccountID: &otherID, Amount: amt, Description: memo, ClassID: body.ClassID}
		moneyIn := it.cents > 0
		other, err := getAcct(ctx, tx, otherID)
		if err != nil {
			return err
		}
		switch {
		case other.Type == model.AcctBank || other.Type == model.AcctCreditCard:
			// money moved between two of the company's own accounts (a credit card
			// payment from checking, a transfer to savings): record a transfer
			if other.ID == a.ID {
				return apperr.Validation("accountId", "Choose a different account: the money cannot move from %s to itself.", a.FullName)
			}
			t.Type = model.TxTransfer
			t.NameID = nil
			t.ClassID = body.ClassID
			t.Amount = amt
			from, to := a.ID, other.ID
			if moneyIn {
				from, to = other.ID, a.ID
			}
			t.AccountID, t.ToAccountID = &from, &to
		case a.Type == model.AcctBank && !moneyIn:
			t.Type = model.TxCheck
		case a.Type == model.AcctBank && moneyIn:
			t.Type = model.TxDeposit
			line.Kind = model.LineDeposit
			line.NameID = body.NameID
		case a.Type == model.AcctCreditCard && !moneyIn:
			t.Type = model.TxCCCharge
		default:
			t.Type = model.TxCCCredit
		}
		if t.Type != model.TxTransfer {
			t.Lines = []model.TxnLine{line}
		}
		txnID, err = ledger.Save(ctx, tx, &t, saveOpts(c))
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE bank_feed_items SET status = 'added', txn_id = ? WHERE id = ?`, txnID, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"txnId": txnID})
}

// POST /bank-feed-items/{id}/match body {txnId}
func feedMatch(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	var body struct {
		TxnID int64 `json:"txnId"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	if body.TxnID <= 0 {
		return apperr.Validation("txnId", "Please choose the register transaction to match.")
	}
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		it, err := loadFeedItem(ctx, tx, id)
		if err != nil {
			return err
		}
		if it.Status != "new" {
			return apperr.Conflict("This downloaded transaction has already been %s. Undo it first.", it.Status)
		}
		a, err := getAcct(ctx, tx, it.AccountID)
		if err != nil {
			return err
		}
		var sum int64
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(amount), 0), COUNT(*) FROM gl_entries WHERE txn_id = ? AND account_id = ?`,
			body.TxnID, it.AccountID).Scan(&sum, &n); err != nil {
			return err
		}
		if n == 0 {
			return apperr.Validation("txnId", "The selected transaction is not in the %s register.", a.FullName)
		}
		var other int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bank_feed_items WHERE txn_id = ? AND status IN ('added', 'matched')
			AND account_id = ? AND id <> ?`, body.TxnID, it.AccountID, id).Scan(&other); err != nil {
			return err
		}
		if other > 0 {
			return apperr.Conflict("The selected transaction is already matched to another downloaded transaction.")
		}
		if got := feedNatural(natural(sum, a.Type), a.Type); got != it.cents && !c.Force() {
			return apperr.Confirm("The amount of the register transaction (%s) is different from the downloaded amount (%s). Do you want to match them anyway?",
				fmtMoney(got), fmtMoney(it.cents))
		}
		_, err = tx.ExecContext(ctx, `UPDATE bank_feed_items SET status = 'matched', txn_id = ? WHERE id = ?`, body.TxnID, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true, "txnId": body.TxnID})
}

// POST /bank-feed-items/{id}/ignore
func feedIgnore(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	err = c.Write(func(tx *sql.Tx) error {
		it, err := loadFeedItem(ctx, tx, id)
		if err != nil {
			return err
		}
		switch it.Status {
		case "ignored":
			return nil
		case "added", "matched":
			return apperr.Conflict("This downloaded transaction has already been %s. Undo it first.", it.Status)
		}
		_, err = tx.ExecContext(ctx, `UPDATE bank_feed_items SET status = 'ignored', txn_id = NULL WHERE id = ?`, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true})
}

// POST /bank-feed-items/{id}/undo: back to "new". A transaction created by
// "add" is deleted unless it has been reconciled (then it stays in the register).
func feedUndo(c *httpx.Ctx) error {
	id, err := c.ID("id")
	if err != nil {
		return err
	}
	ctx := c.Context()
	deleted := false
	err = c.Write(func(tx *sql.Tx) error {
		it, err := loadFeedItem(ctx, tx, id)
		if err != nil {
			return err
		}
		if it.Status == "added" && it.TxnID != nil {
			var reconciled int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM gl_entries WHERE txn_id = ? AND cleared = 'R'`, *it.TxnID).Scan(&reconciled); err != nil {
				return err
			}
			if reconciled == 0 {
				var exists int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM txns WHERE id = ?`, *it.TxnID).Scan(&exists); err != nil {
					return err
				}
				if exists > 0 {
					if err := ledger.Delete(ctx, tx, *it.TxnID, saveOpts(c)); err != nil {
						return err
					}
					deleted = true
				}
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE bank_feed_items SET status = 'new', txn_id = NULL WHERE id = ?`, id)
		return err
	})
	if err != nil {
		return err
	}
	return c.JSON(map[string]any{"ok": true, "deleted": deleted})
}
