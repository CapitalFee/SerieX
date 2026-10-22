package reports

// Banking reports: Deposit Detail, Check Detail and Missing Checks.

import (
	"context"
	"math"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const bk = "Banking"
	register(model.ReportInfo{Key: "deposit_detail", Title: "Deposit Detail", Category: bk,
		Description: "Which payments make up each deposit?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisMonthToDate"}, opsDepositDetail)
	register(model.ReportInfo{Key: "check_detail", Title: "Check Detail", Category: bk,
		Description: "What did each check pay for?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisMonthToDate"}, opsCheckDetail)
	register(model.ReportInfo{Key: "missing_checks", Title: "Missing Checks", Category: bk,
		Description: "Are any check numbers missing or used twice?",
		Params:      []string{"accountId", "dates"}, DefaultDates: "all"}, opsMissingChecks)
}

func opsAcctOK(p *Params, id int64) bool {
	ids := p.Filters.AccountIDs
	if a := p.ID("accountId"); a > 0 {
		ids = append(ids, a)
	}
	if len(ids) == 0 {
		return true
	}
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

type opsBankTxn struct {
	ID, NameID, Acct, CashAcct      int64
	Type, Date, Ref, Memo, CashMemo string
	Amount, CashBack                int64
}

func opsLoadBankTxns(ctx context.Context, q store.Q, p *Params, cond string) ([]*opsBankTxn, error) {
	from, to := opsFromTo(p)
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, IFNULL(t.name_id, 0), IFNULL(t.account_id, 0), t.amount, t.memo,
		IFNULL(t.cash_back_account_id, 0), t.cash_back_amount, t.cash_back_memo
		FROM txns t JOIN accounts a ON a.id = t.account_id
		WHERE t.voided = 0 AND t.is_pending = 0 AND t.date >= ? AND t.date <= ? AND (`+cond+`)
		ORDER BY t.date, t.ref_number, t.id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*opsBankTxn
	for rows.Next() {
		x := &opsBankTxn{}
		if err := rows.Scan(&x.ID, &x.Type, &x.Date, &x.Ref, &x.NameID, &x.Acct, &x.Amount, &x.Memo, &x.CashAcct, &x.CashBack, &x.CashMemo); err != nil {
			return nil, err
		}
		if !opsAcctOK(p, x.Acct) || !opsTextOK(p, x.Memo, x.Ref) || !opsAmountOK(p, x.Amount) {
			continue
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

type opsGL struct {
	Acct, Amount, Item, Name int64
	Role                     string
}

// opsTxnGL returns the general ledger entries of the given transactions.
func opsTxnGL(ctx context.Context, q store.Q, ids []int64) (map[int64][]opsGL, error) {
	out := map[int64][]opsGL{}
	for start := 0; start < len(ids); start += 500 {
		end := start + 500
		if end > len(ids) {
			end = len(ids)
		}
		parts := make([]string, 0, end-start)
		for _, id := range ids[start:end] {
			parts = append(parts, opsID(id))
		}
		rows, err := q.QueryContext(ctx, `SELECT txn_id, account_id, amount, IFNULL(item_id, 0), IFNULL(name_id, 0), role FROM gl_entries
			WHERE txn_id IN (`+strings.Join(parts, ",")+`) ORDER BY txn_id, seq, id`)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var tid int64
			var e opsGL
			if err := rows.Scan(&tid, &e.Acct, &e.Amount, &e.Item, &e.Name, &e.Role); err != nil {
				rows.Close()
				return nil, err
			}
			out[tid] = append(out[tid], e)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

func opsDepositDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	txs, err := opsLoadBankTxns(ctx, q, p, `t.type = 'DEP' OR (t.type IN ('PMT','SALESRCPT') AND a.type = 'Bank')`)
	if err != nil {
		return nil, err
	}
	nf := opsNameSet(p, names)
	from, to := opsFromTo(p)
	type depLine struct {
		acct, amount, name, linked, lname int64
		desc, ref, ltype, ldate, lref     string
	}
	lines := map[int64][]depLine{}
	rows, err := q.QueryContext(ctx, `SELECT l.txn_id, IFNULL(l.account_id, 0), l.amount, IFNULL(l.name_id, 0), l.description, l.ref_number,
		IFNULL(l.linked_txn_id, 0), IFNULL(lt.type, ''), IFNULL(lt.date, ''), IFNULL(lt.ref_number, ''), IFNULL(lt.name_id, 0)
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id LEFT JOIN txns lt ON lt.id = l.linked_txn_id
		WHERE t.type = 'DEP' AND t.date >= ? AND t.date <= ? ORDER BY l.txn_id, l.seq`, from, to)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var tid int64
		var l depLine
		if err := rows.Scan(&tid, &l.acct, &l.amount, &l.name, &l.desc, &l.ref, &l.linked, &l.ltype, &l.ldate, &l.lref, &l.lname); err != nil {
			rows.Close()
			return nil, err
		}
		lines[tid] = append(lines[tid], l)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	var direct []int64
	for _, x := range txs {
		if x.Type != model.TxDeposit {
			direct = append(direct, x.ID)
		}
	}
	gl, err := opsTxnGL(ctx, q, direct)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Deposit Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("num", "Num", "text"), opsC("date", "Date", "date"),
		opsC("name", "Name", "text"), opsC("account", "Account", "text"), opsC("amount", "Amount", "money"))
	for _, x := range txs {
		if nf != nil && !nf[x.NameID] {
			match := false
			for _, l := range lines[x.ID] {
				if nf[l.name] || nf[l.lname] {
					match = true
				}
			}
			if !match {
				continue
			}
		}
		g := b.group()
		b.rowFull(model.ReportRow{Kind: "data", Level: 0, Group: g, TxnID: opsTxnRef(x.ID), Cells: map[string]any{
			"type": opsTypeLabel(x.Type, ""), "num": x.Ref, "date": x.Date, "name": opsNameFull(names, x.NameID),
			"account": opsAcctLabel(accts, x.Acct, p.Prefs), "amount": opsM(x.Amount)}})
		var sum int64
		if x.Type == model.TxDeposit {
			for _, l := range lines[x.ID] {
				cells := map[string]any{"account": opsAcctLabel(accts, l.acct, p.Prefs), "amount": opsM(-l.amount)}
				id := x.ID
				name := l.name
				if l.linked != 0 {
					id = l.linked
					cells["type"] = opsTypeLabel(l.ltype, "")
					cells["num"] = l.lref
					cells["date"] = l.ldate
					if name == 0 {
						name = l.lname
					}
				} else if l.ref != "" {
					cells["num"] = l.ref
				}
				cells["name"] = opsNameFull(names, name)
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(id), Cells: cells})
				sum -= l.amount
			}
			if x.CashBack != 0 {
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(x.ID), Cells: map[string]any{
					"name": "Cash back", "account": opsAcctLabel(accts, x.CashAcct, p.Prefs), "amount": opsM(x.CashBack)}})
				sum += x.CashBack
			}
		} else {
			for _, e := range gl[x.ID] {
				if e.Acct == x.Acct {
					continue
				}
				name := e.Name
				if name == 0 {
					name = x.NameID
				}
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(x.ID), Cells: map[string]any{
					"type": opsTypeLabel(x.Type, ""), "num": x.Ref, "date": x.Date, "name": opsNameFull(names, name),
					"account": opsAcctLabel(accts, e.Acct, p.Prefs), "amount": opsM(e.Amount)}})
				sum += e.Amount
			}
		}
		b.row("subtotal", 0, g, map[string]any{"label": "TOTAL", "amount": opsM(sum)})
		b.row("blank", 0, "", nil)
	}
	return b.r, nil
}

func opsCheckDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	txs, err := opsLoadBankTxns(ctx, q, p, `t.type IN ('CHK','BILLPMT','TAXPMT','REFUND') AND a.type = 'Bank'`)
	if err != nil {
		return nil, err
	}
	nf := opsNameSet(p, names)
	var ids []int64
	isPmt := map[int64]bool{}
	for _, x := range txs {
		ids = append(ids, x.ID)
		if x.Type == model.TxBillPayment {
			isPmt[x.ID] = true
		}
	}
	gl, err := opsTxnGL(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	// Bills paid by the bill payments.
	type paid struct {
		bill, amount, billAmount int64
		ref, date                string
	}
	paidBy := map[int64][]paid{}
	var billIDs []int64
	if len(isPmt) > 0 {
		from, to := opsFromTo(p)
		rows, err := q.QueryContext(ctx, `SELECT l.from_txn_id, l.to_txn_id, l.amount, b.amount, b.ref_number, b.date
			FROM txn_links l JOIN txns f ON f.id = l.from_txn_id JOIN txns b ON b.id = l.to_txn_id
			WHERE f.type = 'BILLPMT' AND f.date >= ? AND f.date <= ? ORDER BY l.id`, from, to)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var pid int64
			var x paid
			if err := rows.Scan(&pid, &x.bill, &x.amount, &x.billAmount, &x.ref, &x.date); err != nil {
				rows.Close()
				return nil, err
			}
			if isPmt[pid] {
				paidBy[pid] = append(paidBy[pid], x)
				billIDs = append(billIDs, x.bill)
			}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	billGL, err := opsTxnGL(ctx, q, billIDs)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Check Detail", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("num", "Num", "text"), opsC("date", "Date", "date"),
		opsC("name", "Name", "text"), opsC("item", "Item", "text"), opsC("account", "Account", "text"),
		opsC("paid", "Paid Amount", "money"), opsC("orig", "Original Amount", "money"))
	itemName := func(id int64) string {
		if it, ok := items[id]; ok {
			return it.Full
		}
		return ""
	}
	for _, x := range txs {
		if nf != nil && !nf[x.NameID] {
			continue
		}
		g := b.group()
		b.rowFull(model.ReportRow{Kind: "data", Level: 0, Group: g, TxnID: opsTxnRef(x.ID), Cells: map[string]any{
			"type": opsTypeLabel(x.Type, opsAcctType(accts, x.Acct)), "num": x.Ref, "date": x.Date,
			"name": opsNameFull(names, x.NameID), "account": opsAcctLabel(accts, x.Acct, p.Prefs), "orig": opsM(-x.Amount)}})
		var sumPaid, sumOrig int64
		if x.Type == model.TxBillPayment && len(paidBy[x.ID]) > 0 {
			for _, pb := range paidBy[x.ID] {
				var es []opsGL
				for _, e := range billGL[pb.bill] {
					if opsAcctType(accts, e.Acct) != model.AcctAP {
						es = append(es, e)
					}
				}
				var used int64
				for i, e := range es {
					part := int64(0)
					if pb.billAmount != 0 {
						part = int64(math.Round(float64(e.Amount) * float64(pb.amount) / float64(pb.billAmount)))
					}
					if i == len(es)-1 {
						var tot int64
						for _, e2 := range es {
							tot += e2.Amount
						}
						if tot == pb.billAmount {
							part = pb.amount - used
						}
					}
					used += part
					b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(pb.bill), Cells: map[string]any{
						"type": "Bill", "num": pb.ref, "date": pb.date, "item": itemName(e.Item),
						"account": opsAcctLabel(accts, e.Acct, p.Prefs), "paid": opsM(-part), "orig": opsM(e.Amount)}})
					sumPaid -= part
					sumOrig += e.Amount
				}
			}
		} else {
			for _, e := range gl[x.ID] {
				if e.Acct == x.Acct {
					continue
				}
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, TxnID: opsTxnRef(x.ID), Cells: map[string]any{
					"item": itemName(e.Item), "account": opsAcctLabel(accts, e.Acct, p.Prefs),
					"paid": opsM(-e.Amount), "orig": opsM(e.Amount)}})
				sumPaid -= e.Amount
				sumOrig += e.Amount
			}
		}
		b.row("subtotal", 0, g, map[string]any{"label": "TOTAL", "paid": opsM(sumPaid), "orig": opsM(sumOrig)})
		b.row("blank", 0, "", nil)
	}
	return b.r, nil
}

func opsMissingChecks(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	acct := p.ID("accountId")
	if acct == 0 && len(p.Filters.AccountIDs) > 0 {
		acct = p.Filters.AccountIDs[0]
	}
	if acct == 0 {
		var banks []*opsAcct
		for _, a := range accts {
			if a.Type == model.AcctBank && a.Active {
				banks = append(banks, a)
			}
		}
		sort.Slice(banks, func(i, j int) bool { return strings.ToLower(banks[i].Full) < strings.ToLower(banks[j].Full) })
		if len(banks) > 0 {
			acct = banks[0].ID
		}
	}
	if acct != 0 {
		if _, ok := accts[acct]; !ok {
			return nil, apperr.Validation("accountId", "Account not found.")
		}
	}
	from, to := opsFromTo(p)
	posts, err := opsPostings(ctx, q, accts, p.Prefs, `t.account_id = ? AND t.date >= ? AND t.date <= ?`, acct, from, to)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, IFNULL(t.name_id, 0), t.memo, t.amount
		FROM txns t WHERE t.account_id = ? AND t.type IN ('CHK','BILLPMT','TAXPMT','REFUND') AND t.ref_number <> ''
		AND t.date >= ? AND t.date <= ?`, acct, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type chk struct {
		id, name, amount     int64
		typ, date, ref, memo string
		num                  uint64
	}
	var list []chk
	for rows.Next() {
		var c chk
		if err := rows.Scan(&c.id, &c.typ, &c.date, &c.ref, &c.name, &c.memo, &c.amount); err != nil {
			return nil, err
		}
		n, err := strconv.ParseUint(strings.TrimSpace(c.ref), 10, 64)
		if err != nil {
			continue
		}
		c.num = n
		list = append(list, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].num != list[j].num {
			return list[i].num < list[j].num
		}
		if list[i].date != list[j].date {
			return list[i].date < list[j].date
		}
		return list[i].id < list[j].id
	})
	b := opsNew(ctx, q, p, "Missing Checks", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("name", "Name", "text"), opsC("memo", "Memo", "text"), opsC("account", "Account", "text"),
		opsC("split", "Split", "text"), opsC("amount", "Amount", "money"))
	if acct != 0 {
		b.r.Title = "Missing Checks"
		b.row("section", 0, "", map[string]any{"label": opsAcctLabel(accts, acct, p.Prefs)})
	}
	for i, c := range list {
		if i > 0 {
			prev := list[i-1].num
			if c.num == prev {
				b.row("data", 1, "", map[string]any{"label": "*** Duplicate document numbers ***"})
			} else if c.num > prev+1 {
				b.row("data", 1, "", map[string]any{"label": "*** Missing numbers here ***"})
			}
		}
		cells := map[string]any{"type": opsTypeLabel(c.typ, opsAcctType(accts, acct)), "date": c.date, "num": c.ref,
			"name": opsNameFull(names, c.name), "memo": c.memo, "account": opsAcctLabel(accts, acct, p.Prefs)}
		if ps, ok := posts[c.id]; ok {
			cells["split"] = ps.Split
			cells["amount"] = opsM(ps.Amount)
		} else {
			cells["amount"] = opsM(-c.amount)
		}
		b.rowFull(model.ReportRow{Kind: "data", Level: 1, TxnID: opsTxnRef(c.id), Cells: cells})
	}
	return b.r, nil
}
