package ledger

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// qryLoadAccount reads one account with its full name and balances (natural
// sign, all dates).
func qryLoadAccount(ctx context.Context, q store.Q, id int64) (*model.Account, error) {
	var a model.Account
	var parent sql.NullInt64
	var active int
	err := q.QueryRowContext(ctx, `SELECT id, name, number, type, parent_id, description, note,
		bank_acct_number, routing_number, tax_line, special, active FROM accounts WHERE id = ?`, id).
		Scan(&a.ID, &a.Name, &a.Number, &a.Type, &parent, &a.Description, &a.Note,
			&a.BankAcctNumber, &a.RoutingNumber, &a.TaxLine, &a.Special, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.NotFound("Account not found.")
	}
	if err != nil {
		return nil, err
	}
	a.ParentID = store.PtrID(parent)
	a.Active = active != 0
	a.FullName = store.FullName(ctx, q, "accounts", id)
	if a.FullName == "" {
		a.FullName = a.Name
	}
	a.Level = strings.Count(a.FullName, ":")
	var own, total int64
	if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(amount), 0) FROM gl_entries WHERE account_id = ?`, id).Scan(&own); err != nil {
		return nil, err
	}
	desc, err := store.Descendants(ctx, q, "accounts", id)
	if err != nil {
		return nil, err
	}
	in, args := qryIn(desc)
	if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(amount), 0) FROM gl_entries WHERE account_id IN `+in, args...).Scan(&total); err != nil {
		return nil, err
	}
	a.OwnBalance = store.Dollars(qryNatural(a.Type, own))
	a.Balance = store.Dollars(qryNatural(a.Type, total))
	var has int
	q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM gl_entries WHERE account_id = ?1)
		OR EXISTS(SELECT 1 FROM txns WHERE account_id = ?1 OR ar_ap_account_id = ?1 OR to_account_id = ?1)
		OR EXISTS(SELECT 1 FROM txn_lines WHERE account_id = ?1)`, id).Scan(&has)
	a.HasTxns = has != 0
	return &a, nil
}

// qryRegisterLabels returns the increase/decrease column labels of a register.
func qryRegisterLabels(accountType string) (string, string) {
	switch accountType {
	case model.AcctBank:
		return "DEPOSIT", "PAYMENT"
	case model.AcctCreditCard:
		return "CHARGE", "PAYMENT"
	case model.AcctAR:
		return "AMT CHRG", "AMT PAID"
	case model.AcctAP:
		return "BILLED", "PAID"
	}
	return "INCREASE", "DECREASE"
}

// qryRegRow accumulates the entries of one transaction in a register.
type qryRegRow struct {
	row    model.RegisterRow
	sum    int64 // signed ledger sum on this account
	others map[int64]bool
	hdrNm  sql.NullInt64
	entNm  sql.NullInt64
	hdrMem string
	entMem string
}

// qryRegister builds the register of an account between from and to (both
// optional). nameIDs (optional) limits it to the entries of those names, e.g.
// one customer's A/R register (Enter Statement Charges).
func qryRegister(ctx context.Context, q store.Q, accountID int64, from, to string, nameIDs []int64) (*model.RegisterResult, error) {
	acct, err := qryLoadAccount(ctx, q, accountID)
	if err != nil {
		return nil, err
	}
	prefs, _ := store.LoadPrefs(ctx, q)
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	acctNames, err := qryAccountLabels(ctx, q, prefs.UseAccountNumbers)
	if err != nil {
		return nil, err
	}
	isARAP := acct.Type == model.AcctAR || acct.Type == model.AcctAP

	// opening balance before "from"
	nameCond, nameArgs := "", []any(nil)
	if nameIDs != nil {
		in, a := qryIn(nameIDs)
		nameCond, nameArgs = " AND g.name_id IN "+in, a
	}
	var opening int64
	if from != "" {
		if err := q.QueryRowContext(ctx, `SELECT IFNULL(SUM(g.amount), 0) FROM gl_entries g WHERE g.account_id = ? AND g.date < ?`+nameCond,
			append([]any{accountID, from}, nameArgs...)...).Scan(&opening); err != nil {
			return nil, err
		}
	}

	dateCond := nameCond
	dateArgs := append([]any(nil), nameArgs...)
	if from != "" {
		dateCond += " AND g.date >= ?"
		dateArgs = append(dateArgs, from)
	}
	if to != "" {
		dateCond += " AND g.date <= ?"
		dateArgs = append(dateArgs, to)
	}

	rowsByTxn := map[int64]*qryRegRow{}
	var order []int64
	rows, err := q.QueryContext(ctx, `SELECT g.id, g.txn_id, g.amount, g.cleared, g.memo, g.name_id,
		t.type, t.ref_number, t.date, t.name_id, t.memo, t.due_date, t.open_balance, t.voided
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id
		WHERE g.account_id = ?`+dateCond+` ORDER BY g.txn_id, g.id`, append([]any{accountID}, dateArgs...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var glID, txnID, amount, open int64
		var cleared, gMemo, typ, ref, date, tMemo, due string
		var gName, tName sql.NullInt64
		var voided int
		if err := rows.Scan(&glID, &txnID, &amount, &cleared, &gMemo, &gName, &typ, &ref, &date, &tName, &tMemo, &due, &open, &voided); err != nil {
			rows.Close()
			return nil, err
		}
		r := rowsByTxn[txnID]
		if r == nil {
			r = &qryRegRow{others: map[int64]bool{}, hdrNm: tName, entNm: gName, hdrMem: tMemo, entMem: gMemo}
			r.row = model.RegisterRow{TxnID: txnID, GLID: glID, Date: date, RefNumber: ref, Type: typ,
				TypeAbbrev: qryTypeAbbrev(typ), Cleared: cleared, Voided: voided != 0}
			if isARAP {
				r.row.DueDate = due
				r.row.OpenBalance = store.Dollars(open)
			}
			rowsByTxn[txnID] = r
			order = append(order, txnID)
		}
		r.sum += amount
		if !r.entNm.Valid && gName.Valid {
			r.entNm = gName
		}
		if r.entMem == "" {
			r.entMem = gMemo
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// other accounts of the posted transactions
	if len(order) > 0 {
		orows, err := q.QueryContext(ctx, `SELECT DISTINCT g2.txn_id, g2.account_id FROM gl_entries g2
			WHERE g2.account_id <> ? AND g2.txn_id IN (SELECT g.txn_id FROM gl_entries g WHERE g.account_id = ?`+dateCond+`)`,
			append([]any{accountID, accountID}, dateArgs...)...)
		if err != nil {
			return nil, err
		}
		for orows.Next() {
			var txnID, acc int64
			if err := orows.Scan(&txnID, &acc); err != nil {
				orows.Close()
				return nil, err
			}
			if r := rowsByTxn[txnID]; r != nil {
				r.others[acc] = true
			}
		}
		orows.Close()
		if err := orows.Err(); err != nil {
			return nil, err
		}
	}

	// voided transactions whose header (or a line) used this account: shown with 0 amounts
	vCond := ""
	var vArgs []any
	if nameIDs != nil {
		in, a := qryIn(nameIDs)
		vCond, vArgs = " AND t.name_id IN "+in, a
	}
	if from != "" {
		vCond += " AND t.date >= ?"
		vArgs = append(vArgs, from)
	}
	if to != "" {
		vCond += " AND t.date <= ?"
		vArgs = append(vArgs, to)
	}
	vrows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.ref_number, t.date, t.name_id, t.memo, t.due_date,
		t.open_balance, t.account_id, t.ar_ap_account_id, t.to_account_id
		FROM txns t WHERE t.voided = 1 AND (t.account_id = ?1 OR t.ar_ap_account_id = ?1 OR t.to_account_id = ?1
		OR EXISTS (SELECT 1 FROM txn_lines l WHERE l.txn_id = t.id AND l.account_id = ?1))`+vCond+` ORDER BY t.id`, append([]any{accountID}, vArgs...)...)
	if err != nil {
		return nil, err
	}
	var voidedIDs []int64
	for vrows.Next() {
		var id, open int64
		var typ, ref, date, memo, due string
		var name, a1, a2, a3 sql.NullInt64
		if err := vrows.Scan(&id, &typ, &ref, &date, &name, &memo, &due, &open, &a1, &a2, &a3); err != nil {
			vrows.Close()
			return nil, err
		}
		if rowsByTxn[id] != nil {
			continue
		}
		r := &qryRegRow{others: map[int64]bool{}, hdrNm: name, hdrMem: memo}
		r.row = model.RegisterRow{TxnID: id, Date: date, RefNumber: ref, Type: typ, TypeAbbrev: qryTypeAbbrev(typ), Voided: true}
		if isARAP {
			r.row.DueDate = due
			r.row.OpenBalance = store.Dollars(open)
		}
		for _, a := range []sql.NullInt64{a1, a2, a3} {
			if a.Valid && a.Int64 != accountID {
				r.others[a.Int64] = true
			}
		}
		rowsByTxn[id] = r
		order = append(order, id)
		voidedIDs = append(voidedIDs, id)
	}
	vrows.Close()
	if err := vrows.Err(); err != nil {
		return nil, err
	}
	for start := 0; start < len(voidedIDs); start += 500 {
		end := min(start+500, len(voidedIDs))
		in, args := qryIn(voidedIDs[start:end])
		lrows, err := q.QueryContext(ctx, `SELECT l.txn_id, COALESCE(l.account_id,
			CASE WHEN t.type IN ('INV','SALESRCPT','CREDMEM','STMTCHG') THEN i.income_account_id
			     WHEN i.type = 'Inventory Part' THEN i.asset_account_id ELSE i.expense_account_id END)
			FROM txn_lines l JOIN txns t ON t.id = l.txn_id LEFT JOIN items i ON i.id = l.item_id
			WHERE l.txn_id IN `+in, args...)
		if err != nil {
			return nil, err
		}
		for lrows.Next() {
			var txnID int64
			var acc sql.NullInt64
			if err := lrows.Scan(&txnID, &acc); err != nil {
				lrows.Close()
				return nil, err
			}
			if acc.Valid && acc.Int64 != accountID {
				rowsByTxn[txnID].others[acc.Int64] = true
			}
		}
		lrows.Close()
		if err := lrows.Err(); err != nil {
			return nil, err
		}
	}

	list := make([]*qryRegRow, 0, len(order))
	for _, id := range order {
		list = append(list, rowsByTxn[id])
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i].row, list[j].row
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if c := qryRefCompare(a.RefNumber, b.RefNumber); c != 0 {
			return c < 0
		}
		return a.TxnID < b.TxnID
	})

	res := &model.RegisterResult{Account: *acct, Rows: make([]model.RegisterRow, 0, len(list))}
	res.IncreaseLabel, res.DecreaseLabel = qryRegisterLabels(acct.Type)
	balance := qryNatural(acct.Type, opening)
	for _, r := range list {
		nat := qryNatural(acct.Type, r.sum)
		if r.row.Voided {
			nat = 0
		}
		if nat > 0 {
			r.row.Increase = store.Dollars(nat)
		} else if nat < 0 {
			r.row.Decrease = store.Dollars(-nat)
		}
		balance += nat
		r.row.Balance = store.Dollars(balance)
		nm := r.hdrNm
		if !nm.Valid {
			nm = r.entNm
		}
		if nm.Valid {
			id := nm.Int64
			r.row.NameID = &id
			r.row.NameFull = names[id]
		}
		r.row.Memo = r.entMem
		if r.row.Memo == "" || r.row.Voided {
			r.row.Memo = r.hdrMem
		}
		switch len(r.others) {
		case 0:
		case 1:
			for acc := range r.others {
				r.row.OtherAccount = acctNames[acc]
			}
		default:
			r.row.OtherAccount = "-split-"
		}
		res.Rows = append(res.Rows, r.row)
	}
	res.EndingBalance = store.Dollars(balance)
	return res, nil
}

// qryTypeAbbrev is the register TYPE column text.
func qryTypeAbbrev(typ string) string {
	if s, ok := model.TxnTypeAbbrev[typ]; ok {
		return s
	}
	return typ
}

// qryAccountLabels returns id -> displayed account name (full name, with number when enabled).
func qryAccountLabels(ctx context.Context, q store.Q, useNumbers bool) (map[int64]string, error) {
	full, err := store.FullNames(ctx, q, "accounts")
	if err != nil {
		return nil, err
	}
	if !useNumbers {
		return full, nil
	}
	rows, err := q.QueryContext(ctx, `SELECT id, number FROM accounts WHERE number <> ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var num string
		if err := rows.Scan(&id, &num); err != nil {
			return nil, err
		}
		full[id] = qryAcctLabel(true, num, full[id])
	}
	return full, rows.Err()
}
