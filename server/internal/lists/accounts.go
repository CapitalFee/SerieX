package lists

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

func registerAccountRoutes(rt *httpx.Router) {
	rt.C("GET", "/accounts", func(c *httpx.Ctx) error {
		mode, err := activeMode(c.Q("active"))
		if err != nil {
			return err
		}
		all, err := Accounts(c.Context(), c.DB)
		if err != nil {
			return err
		}
		types := splitList(c.Q("types"))
		out := []model.Account{}
		for _, a := range all {
			if !keepActive(mode, a.Active) {
				continue
			}
			if len(types) > 0 && !contains(types, a.Type) {
				continue
			}
			out = append(out, a)
		}
		return c.JSON(out)
	})
	rt.C("GET", "/accounts/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		a, err := GetAccount(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(a)
	})
	save := func(c *httpx.Ctx, id int64) error {
		var a model.Account
		act, err := decodeRecord(c, &a)
		if err != nil {
			return err
		}
		a.ID = id
		if id != 0 {
			a.OpeningBalance = nil
		}
		var saved int64
		err = c.Write(func(tx *sql.Tx) error {
			var err error
			if a.Active, err = resolveActive(c.Context(), tx, "accounts", id, act); err != nil {
				return err
			}
			saved, err = SaveAccount(c.Context(), tx, &a, saveOpts(c))
			return err
		})
		if err != nil {
			return err
		}
		out, err := GetAccount(c.Context(), c.DB, saved)
		if err != nil {
			return err
		}
		return c.JSON(out)
	}
	rt.C("POST", "/accounts", func(c *httpx.Ctx) error { return save(c, 0) })
	rt.C("PUT", "/accounts/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return save(c, id)
	})
	rt.C("PUT", "/accounts/{id}/active", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var body struct {
			Active bool `json:"active"`
		}
		if err := c.Decode(&body); err != nil {
			return err
		}
		err = c.Write(func(tx *sql.Tx) error {
			if ok, err := exists(c.Context(), tx, `SELECT 1 FROM accounts WHERE id = ?`, id); err != nil || !ok {
				if err == nil {
					err = apperr.NotFound("Account not found.")
				}
				return err
			}
			if err := setActive(c.Context(), tx, "accounts", id, body.Active); err != nil {
				return err
			}
			return touch(c.Context(), tx, "accounts", id)
		})
		if err != nil {
			return err
		}
		out, err := GetAccount(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(out)
	})
	rt.C("DELETE", "/accounts/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := c.Write(func(tx *sql.Tx) error { return DeleteAccount(c.Context(), tx, id) }); err != nil {
			return err
		}
		return c.NoContent()
	})
}

// ---------------------------------------------------------------------------
// Reading

const accountCols = `id, name, number, type, parent_id, description, note, bank_acct_number, routing_number, tax_line, special, active, updated_at`

// accountsUsed returns the ids of accounts referenced by any transaction.
func accountsUsed(ctx context.Context, q store.Q) (map[int64]bool, error) {
	return idSet(ctx, q, `SELECT DISTINCT account_id FROM gl_entries
		UNION SELECT account_id FROM txns WHERE account_id IS NOT NULL
		UNION SELECT ar_ap_account_id FROM txns WHERE ar_ap_account_id IS NOT NULL
		UNION SELECT to_account_id FROM txns WHERE to_account_id IS NOT NULL
		UNION SELECT cash_back_account_id FROM txns WHERE cash_back_account_id IS NOT NULL
		UNION SELECT account_id FROM txn_lines WHERE account_id IS NOT NULL
		UNION SELECT discount_account_id FROM txn_links WHERE discount_account_id IS NOT NULL`)
}

// Accounts returns every account (active and inactive) in chart of accounts
// order with fullName, level, balances (natural sign, all dates; 0 for P&L
// accounts), hasTxns and special filled in.
func Accounts(ctx context.Context, q store.Q) ([]model.Account, error) {
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT `+accountCols+` FROM accounts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []model.Account
	for rows.Next() {
		var a model.Account
		var parent sql.NullInt64
		var active int
		if err := rows.Scan(&a.ID, &a.Name, &a.Number, &a.Type, &parent, &a.Description, &a.Note, &a.BankAcctNumber,
			&a.RoutingNumber, &a.TaxLine, &a.Special, &active, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.ParentID = store.PtrID(parent)
		a.Active = active == 1
		list = append(list, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	sums, err := sumByID(ctx, q, `SELECT account_id, SUM(amount) FROM gl_entries GROUP BY account_id`)
	if err != nil {
		return nil, err
	}
	used, err := accountsUsed(ctx, q)
	if err != nil {
		return nil, err
	}

	names := map[int64]string{}
	parents := map[int64]int64{}
	for _, a := range list {
		names[a.ID] = a.Name
		if a.ParentID != nil {
			parents[a.ID] = *a.ParentID
		}
	}
	full := fullNames(names, parents)

	// own natural balance (cents) and roll-up into ancestors
	own := map[int64]int64{}
	byID := map[int64]*model.Account{}
	for i := range list {
		a := &list[i]
		byID[a.ID] = a
		s := sums[a.ID]
		if !model.IsDebitNormal(a.Type) {
			s = -s
		}
		own[a.ID] = s
	}
	total := map[int64]int64{}
	for id, s := range own {
		total[id] += s
		p, depth := parents[id], 0
		for p != 0 && depth < 64 {
			if _, ok := byID[p]; !ok {
				break
			}
			total[p] += s
			p = parents[p]
			depth++
		}
	}
	for i := range list {
		a := &list[i]
		a.FullName = full[a.ID]
		a.HasTxns = used[a.ID]
		if model.IsBalanceSheet(a.Type) {
			a.OwnBalance = store.Dollars(own[a.ID])
			a.Balance = store.Dollars(total[a.ID])
		}
	}

	useNum := prefs.UseAccountNumbers
	order, level := treeSort(len(list),
		func(i int) int64 { return list[i].ID },
		func(i int) int64 {
			if list[i].ParentID == nil {
				return 0
			}
			return *list[i].ParentID
		},
		func(x, y int) bool {
			a, b := list[x], list[y]
			ra, rb := model.AccountTypeRank(a.Type), model.AccountTypeRank(b.Type)
			if ra != rb {
				return ra < rb
			}
			if useNum && a.Number != b.Number {
				if a.Number == "" || b.Number == "" {
					return a.Number != "" // numbered accounts first
				}
				return lessNumber(a.Number, b.Number)
			}
			return lessFold(a.Name, b.Name)
		})
	out := make([]model.Account, 0, len(list))
	for _, i := range order {
		a := list[i]
		a.Level = level[i]
		out = append(out, a)
	}
	return out, nil
}

// lessNumber compares account numbers: numerically when both are plain
// integers of different length, else as strings ("10000" sorts before
// "10100" and "1200" after "1100").
func lessNumber(a, b string) bool {
	if isDigits(a) && isDigits(b) && len(a) != len(b) {
		ta, tb := strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
		if len(ta) != len(tb) {
			return len(ta) < len(tb)
		}
		return ta < tb
	}
	return a < b
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// GetAccount returns one account with its computed fields.
func GetAccount(ctx context.Context, q store.Q, id int64) (*model.Account, error) {
	all, err := Accounts(ctx, q)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, apperr.NotFound("Account not found.")
}

// ---------------------------------------------------------------------------
// Writing

// typeLocked are special accounts whose type can never change.
var typeLocked = map[string]bool{
	store.SpecialAR:                   true,
	store.SpecialAP:                   true,
	store.SpecialUndepositedFunds:     true,
	store.SpecialRetainedEarnings:     true,
	store.SpecialOpeningBalanceEquity: true,
	store.SpecialSalesTaxPayable:      true,
	store.SpecialInventoryAsset:       true,
	store.SpecialCOGS:                 true,
}

func validAccountType(t string) bool {
	for _, x := range model.AccountTypeOrder {
		if x == t {
			return true
		}
	}
	return false
}

// SaveAccount validates and stores an account (a.ID == 0 creates it). On
// create, a non-zero a.OpeningBalance of a balance sheet account posts a
// general journal entry against Opening Balance Equity via ledger.Save.
// Returns the account id.
func SaveAccount(ctx context.Context, tx *sql.Tx, a *model.Account, opt ledger.SaveOptions) (int64, error) {
	name, err := cleanName(a.Name, "account")
	if err != nil {
		return 0, err
	}
	a.Name = name
	a.Number = strings.TrimSpace(a.Number)
	a.Type = strings.TrimSpace(a.Type)
	a.ParentID = normID(a.ParentID)

	type oldAcct struct {
		typ, special string
		active       bool
	}
	var old *oldAcct
	if a.ID != 0 {
		if err := store.CheckStale(ctx, tx, "accounts", a.ID, a.UpdatedAt, "account"); err != nil {
			return 0, err
		}
		var o oldAcct
		var act int
		err := tx.QueryRowContext(ctx, `SELECT type, special, active FROM accounts WHERE id = ?`, a.ID).Scan(&o.typ, &o.special, &act)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, apperr.NotFound("Account not found.")
		}
		if err != nil {
			return 0, err
		}
		o.active = act == 1
		old = &o
		if a.Type == "" {
			a.Type = o.typ
		}
	}
	if !validAccountType(a.Type) {
		return 0, apperr.Validation("type", "Choose a valid account type.")
	}
	if a.ParentID != nil {
		pt, err := checkParent(ctx, tx, "accounts", a.ID, *a.ParentID, "type")
		if err != nil {
			return 0, err
		}
		if pt != a.Type {
			return 0, apperr.Validation("parentId", "A subaccount must be the same type as its parent account (%s).", pt)
		}
	}
	if a.Number != "" {
		if dup, err := exists(ctx, tx, `SELECT 1 FROM accounts WHERE number = ? AND id <> ?`, a.Number, a.ID); err != nil {
			return 0, err
		} else if dup {
			return 0, apperr.Validation("number", "The account number \"%s\" is already in use. Please use a different number.", a.Number)
		}
	}
	if dup, err := siblingExists(ctx, tx, "accounts", a.ParentID, a.Name, a.ID, ""); err != nil {
		return 0, err
	} else if dup {
		return 0, nameInUse(a.Name)
	}

	// type change rules (also applied to the subaccounts, which follow the parent)
	if old != nil && old.typ != a.Type {
		desc, err := store.Descendants(ctx, tx, "accounts", a.ID)
		if err != nil {
			return 0, err
		}
		used, err := accountsUsed(ctx, tx)
		if err != nil {
			return 0, err
		}
		for _, d := range desc {
			var dName, dType, dSpecial string
			if err := tx.QueryRowContext(ctx, `SELECT name, type, special FROM accounts WHERE id = ?`, d).Scan(&dName, &dType, &dSpecial); err != nil {
				return 0, err
			}
			if typeLocked[dSpecial] {
				return 0, apperr.Conflict("You cannot change the type of the \"%s\" account. SerieX Books uses it for special purposes.", dName)
			}
			arap := func(t string) bool { return t == model.AcctAR || t == model.AcctAP }
			if (arap(dType) || arap(a.Type)) && used[d] {
				return 0, apperr.Conflict("You cannot change the \"%s\" account to or from Accounts Receivable or Accounts Payable because it has transactions.", dName)
			}
		}
	}

	now := store.Now()
	var cv cols
	cv.add("name", a.Name)
	cv.add("number", a.Number)
	cv.add("type", a.Type)
	cv.add("parent_id", store.NullID(a.ParentID))
	cv.add("description", strings.TrimSpace(a.Description))
	cv.add("note", a.Note)
	cv.add("bank_acct_number", strings.TrimSpace(a.BankAcctNumber))
	cv.add("routing_number", strings.TrimSpace(a.RoutingNumber))
	cv.add("tax_line", a.TaxLine)
	cv.add("updated_at", store.Stamp())
	id := a.ID
	if old == nil {
		cv.add("active", store.B(a.Active))
		cv.add("created_at", now)
		id, err = cv.insert(ctx, tx, "accounts")
		if err != nil {
			return 0, mapDBError(err, a.Name)
		}
	} else {
		if err := cv.update(ctx, tx, "accounts", id); err != nil {
			return 0, mapDBError(err, a.Name)
		}
		if old.typ != a.Type {
			if _, err := tx.ExecContext(ctx, `WITH RECURSIVE d(id) AS (SELECT id FROM accounts WHERE parent_id = ?
				UNION ALL SELECT c.id FROM accounts c JOIN d ON c.parent_id = d.id)
				UPDATE accounts SET type = ?, updated_at = ? WHERE id IN (SELECT id FROM d)`, id, a.Type, now); err != nil {
				return 0, err
			}
		}
	}
	if old == nil || old.active != a.Active {
		if err := setActive(ctx, tx, "accounts", id, a.Active); err != nil {
			return 0, err
		}
	}

	if a.OpeningBalance != nil {
		if err := store.MoneyErr("openingBalance", "The opening balance", *a.OpeningBalance); err != nil {
			return 0, err
		}
	}
	if old == nil && a.OpeningBalance != nil && store.Cents(*a.OpeningBalance) != 0 {
		if err := accountOpeningBalance(ctx, tx, id, a, opt); err != nil {
			return 0, err
		}
	}
	return id, nil
}

// accountOpeningBalance posts "Account Opening Balance" as a journal entry
// between the new account and Opening Balance Equity, so that the account's
// natural balance equals the amount entered.
func accountOpeningBalance(ctx context.Context, tx *sql.Tx, id int64, a *model.Account, opt ledger.SaveOptions) error {
	switch {
	case a.Type == model.AcctAR || a.Type == model.AcctAP:
		return apperr.Validation("openingBalance", "Accounts receivable and accounts payable balances are entered for each customer or vendor, not for the account.")
	case !model.IsBalanceSheet(a.Type):
		return apperr.Validation("openingBalance", "Only balance sheet accounts have an opening balance.")
	}
	date := strings.TrimSpace(a.OpeningDate)
	if date == "" {
		date = store.Today()
	}
	if !store.ValidDate(date) {
		return apperr.Validation("openingDate", "Enter a valid opening balance date.")
	}
	obe, err := store.SpecialAccount(ctx, tx, store.SpecialOpeningBalanceEquity)
	if err != nil {
		return err
	}
	if obe == id {
		return apperr.Validation("openingBalance", "Opening Balance Equity cannot have an opening balance.")
	}
	amt := store.Round2(*a.OpeningBalance)
	if !model.IsDebitNormal(a.Type) {
		amt = -amt
	}
	acct, obeID := id, obe
	t := model.Txn{
		Type:  model.TxJournal,
		Date:  date,
		Memo:  "Account Opening Balance",
		Extra: map[string]any{"openingBalance": true},
		Lines: []model.TxnLine{
			{Seq: 0, Kind: model.LineJournal, AccountID: &acct, Amount: amt, Description: "Account Opening Balance"},
			{Seq: 1, Kind: model.LineJournal, AccountID: &obeID, Amount: -amt, Description: "Account Opening Balance"},
		},
	}
	_, err = ledger.Save(ctx, tx, &t, opt)
	return err
}

// DeleteAccount removes an account that has no transactions, no subaccounts
// and is not a special account.
func DeleteAccount(ctx context.Context, tx *sql.Tx, id int64) error {
	var name, special string
	err := tx.QueryRowContext(ctx, `SELECT name, special FROM accounts WHERE id = ?`, id).Scan(&name, &special)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFound("Account not found.")
	}
	if err != nil {
		return err
	}
	if special != "" {
		return apperr.Conflict("The \"%s\" account is used by SerieX Books and cannot be deleted. Make it inactive instead.", name)
	}
	if kids, err := exists(ctx, tx, `SELECT 1 FROM accounts WHERE parent_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if kids {
		return apperr.Conflict("This account has transactions or subaccounts. Make it inactive instead.")
	}
	used, err := exists(ctx, tx, `SELECT 1 FROM gl_entries WHERE account_id = ?1
		UNION SELECT 1 FROM txns WHERE account_id = ?1 OR ar_ap_account_id = ?1 OR to_account_id = ?1 OR cash_back_account_id = ?1
		UNION SELECT 1 FROM txn_lines WHERE account_id = ?1
		UNION SELECT 1 FROM txn_links WHERE discount_account_id = ?1 LIMIT 1`, id)
	if err != nil {
		return err
	}
	if used {
		return apperr.Conflict("This account has transactions or subaccounts. Make it inactive instead.")
	}
	if inItems, err := exists(ctx, tx, `SELECT 1 FROM items WHERE income_account_id = ?1 OR expense_account_id = ?1 OR asset_account_id = ?1 OR deposit_account_id = ?1 LIMIT 1`, id); err != nil {
		return err
	} else if inItems {
		return apperr.Conflict("This account is used by one or more items. Change those items or make the account inactive instead.")
	}
	if ref, err := exists(ctx, tx, `SELECT 1 FROM reconciliations WHERE account_id = ?1
		UNION SELECT 1 FROM bank_feed_items WHERE account_id = ?1
		UNION SELECT 1 FROM budget_lines WHERE account_id = ?1 LIMIT 1`, id); err != nil {
		return err
	} else if ref {
		return apperr.Conflict("This account is used by reconciliations, bank imports or budgets. Make it inactive instead.")
	}
	// bank rules and drafts that point at the account go away with it
	if _, err := tx.ExecContext(ctx, `DELETE FROM reconcile_drafts WHERE account_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bank_rules SET target_account_id = NULL WHERE target_account_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bank_rules SET account_id = NULL WHERE account_id = ?`, id); err != nil {
		return err
	}
	if err := clearPrefAccount(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM accounts WHERE id = ?`, id); err != nil {
		return mapDBError(err, name)
	}
	return nil
}

// clearPrefAccount removes a deleted account from the preferences that point at it.
func clearPrefAccount(ctx context.Context, tx *sql.Tx, id int64) error {
	p, err := store.LoadPrefs(ctx, tx)
	if err != nil {
		return err
	}
	changed := false
	for _, f := range []**int64{&p.VendorDiscountAccountID, &p.DefaultCheckAccountID, &p.DefaultBillPayAccountID,
		&p.DefaultDepositAccountID, &p.CustomerDiscountAccountID} {
		if *f != nil && **f == id {
			*f = nil
			changed = true
		}
	}
	if !changed {
		return nil
	}
	return store.SavePrefs(ctx, tx, p)
}
