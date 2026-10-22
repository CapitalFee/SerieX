package reports

// Audit Trail: every transaction added, modified, voided or deleted in the
// date range (by the date it was entered / last modified), grouped by the user
// of the latest change, with the history of each transaction (Latest / Prior /
// Deleted versions and their lines).

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"seriex/internal/model"
	"seriex/internal/store"
)

type finAudit struct {
	id      int64
	ts      time.Time
	user    string
	action  string
	txnID   int64
	txnType string
	ref     string
	date    string
	name    string
	amount  int64
	snap    *model.Txn
}

type finItemAccts struct{ income, expense, asset int64 }

func finAuditTrail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, ts, user, action, txn_id, txn_type, ref_number, txn_date, name, amount, details
		FROM audit_log WHERE txn_id IS NOT NULL ORDER BY ts DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byTxn := map[int64][]*finAudit{}
	inRange := map[int64]bool{}
	userFilter := strings.ToLower(p.Str("user"))
	f := c.filter()
	for rows.Next() {
		a := &finAudit{}
		var ts, details string
		if err := rows.Scan(&a.id, &ts, &a.user, &a.action, &a.txnID, &a.txnType, &a.ref, &a.date, &a.name, &a.amount, &details); err != nil {
			return nil, err
		}
		t, err := time.Parse(time.RFC3339, ts)
		if err != nil {
			continue
		}
		a.ts = t.Local()
		var d struct {
			Before *model.Txn `json:"before"`
			After  *model.Txn `json:"after"`
		}
		if json.Unmarshal([]byte(details), &d) == nil {
			a.snap = d.After
			if a.snap == nil {
				a.snap = d.Before
			}
		}
		byTxn[a.txnID] = append(byTxn[a.txnID], a)
		day := a.ts.Format(iso)
		if day > p.To || (p.From != "" && day < p.From) {
			continue
		}
		if userFilter != "" && strings.ToLower(a.user) != userFilter {
			continue
		}
		if f.types != nil && !f.types[a.txnType] {
			continue
		}
		inRange[a.txnID] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	itemAccts := map[int64]finItemAccts{}
	irows, err := q.QueryContext(ctx, `SELECT id, IFNULL(income_account_id,0), IFNULL(expense_account_id,0), IFNULL(asset_account_id,0) FROM items`)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	for irows.Next() {
		var id int64
		var ia finItemAccts
		if err := irows.Scan(&id, &ia.income, &ia.expense, &ia.asset); err != nil {
			return nil, err
		}
		itemAccts[id] = ia
	}
	if err := irows.Err(); err != nil {
		return nil, err
	}
	lineAcct := func(typ string, ln *model.TxnLine) int64 {
		if ln.AccountID != nil && *ln.AccountID != 0 {
			return *ln.AccountID
		}
		if ln.ItemID == nil {
			return 0
		}
		ia := itemAccts[*ln.ItemID]
		switch typ {
		case model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxStatementCharge, model.TxEstimate:
			return ia.income
		}
		if it := c.items[*ln.ItemID]; it != nil && it.Kind == model.ItemInventoryPart && ia.asset != 0 {
			return ia.asset
		}
		return ia.expense
	}
	type txnGroup struct {
		id     int64
		list   []*finAudit
		latest *finAudit
	}
	byUser := map[string][]*txnGroup{}
	var users []string
	for id := range inRange {
		list := byTxn[id]
		g := &txnGroup{id: id, list: list, latest: list[0]}
		if _, ok := byUser[g.latest.user]; !ok {
			users = append(users, g.latest.user)
		}
		byUser[g.latest.user] = append(byUser[g.latest.user], g)
	}
	sort.Strings(users)
	cols := []finCol{
		{Key: "num", Label: "Num", Type: "text"},
		{Key: "entered", Label: "Entered/Last Modified", Type: "text"},
		{Key: "user", Label: "Last modified by", Type: "text"},
		{Key: "state", Label: "State", Type: "text"},
		{Key: "date", Label: "Date", Type: "date"},
		{Key: "name", Label: "Name", Type: "text"},
		{Key: "memo", Label: "Memo", Type: "text"},
		{Key: "account", Label: "Account", Type: "text"},
		{Key: "split", Label: "Split", Type: "text"},
		{Key: "amount", Label: "Amount", Type: "money"},
	}
	l := c.layout(cols, nil)
	for _, u := range users {
		gu := c.group()
		who := u
		if who == "" {
			who = "(unknown)"
		}
		l.add("section", 0, "Transactions entered or modified by "+who, nil, nil, gu)
		groups := byUser[u]
		sort.Slice(groups, func(i, j int) bool {
			if !groups[i].latest.ts.Equal(groups[j].latest.ts) {
				return groups[i].latest.ts.After(groups[j].latest.ts)
			}
			return groups[i].id > groups[j].id
		})
		for _, g := range groups {
			gt := c.group()
			typ := g.latest.txnType
			lbl := model.TxnTypeLabels[typ]
			if lbl == "" {
				lbl = typ
			}
			ref := g.latest.ref
			if g.latest.snap != nil && g.latest.snap.RefNumber != "" {
				ref = g.latest.snap.RefNumber
			}
			head := lbl
			if ref != "" {
				head += " " + ref
			}
			l.add("section", 1, head, nil, nil, gt)
			var txnPtr *int64
			if c.txns[g.id] != nil {
				txnPtr = finTxnPtr(g.id)
			}
			for i, a := range g.list {
				state := "Prior"
				if i == 0 {
					state = "Latest"
					if a.action == "delete" {
						state = "Deleted"
					}
				}
				cells := map[string]any{"label": "", "num": a.ref, "entered": a.ts.Format("01/02/2006 15:04:05"),
					"user": a.user, "state": state, "date": finDate(a.date), "name": a.name, "memo": "",
					"account": "", "split": "", "amount": store.Dollars(a.amount)}
				s := a.snap
				var lineRows []model.ReportRow
				if s != nil {
					cells["num"] = s.RefNumber
					cells["date"] = finDate(s.Date)
					cells["memo"] = s.Memo
					cells["amount"] = s.Amount
					if s.NameFull != "" {
						cells["name"] = s.NameFull
					} else if s.NameID != nil {
						cells["name"] = c.nameFull(*s.NameID)
					}
					hdr := int64(0)
					if s.AccountID != nil {
						hdr = *s.AccountID
					} else if s.ArApAccountID != nil {
						hdr = *s.ArApAccountID
					}
					cells["account"] = c.acctName(hdr)
					var other int64
					multi := false
					for k := range s.Lines {
						ln := &s.Lines[k]
						la := lineAcct(s.Type, ln)
						if la != 0 && la != hdr {
							if other != 0 && other != la {
								multi = true
							}
							other = la
						}
						name := ""
						if ln.NameID != nil {
							name = c.nameFull(*ln.NameID)
						}
						lineRows = append(lineRows, model.ReportRow{Kind: "data", Level: 3, Group: gt, TxnID: txnPtr, Cells: map[string]any{
							"label": "", "name": name, "memo": ln.Description, "account": c.acctName(la), "amount": ln.Amount}})
					}
					if other == 0 && !multi {
						// payments and transfers: the other side is the A/R / A/P or destination account
						for _, x := range []*int64{s.ArApAccountID, s.ToAccountID} {
							if x != nil && *x != 0 && *x != hdr {
								other = *x
							}
						}
					}
					if multi {
						cells["split"] = "-SPLIT-"
					} else if other != 0 {
						cells["split"] = c.acctName(other)
					}
				}
				l.rows = append(l.rows, model.ReportRow{Kind: "data", Level: 2, Group: gt, TxnID: txnPtr, Cells: cells})
				l.rows = append(l.rows, lineRows...)
			}
		}
	}
	res := NewResult(ctx, q, p, "Audit Trail", false, false)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(cols)...)
	res.Rows = l.rows
	if res.Rows == nil {
		res.Rows = []model.ReportRow{}
	}
	return res, nil
}
