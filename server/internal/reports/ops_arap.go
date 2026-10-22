package reports

// Customers and Invoices and Vendors and Bills reports: aging, balances,
// open invoices / unpaid bills, collections and transaction lists by name.

import (
	"context"

	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const cr, vp = "Customers and Invoices", "Vendors and Bills"
	register(model.ReportInfo{Key: "ar_aging_summary", Title: "A/R Aging Summary", Category: cr,
		Description: "How much does each customer owe, and how much of it is overdue?",
		Params:      []string{"asOf", "agingInterval", "filters"}, DefaultDates: "today"}, opsAgingSummary("ar"))
	register(model.ReportInfo{Key: "ar_aging_detail", Title: "A/R Aging Detail", Category: cr,
		Description: "Which invoices are open, and how many days overdue is each one?",
		Params:      []string{"asOf", "agingInterval", "filters"}, DefaultDates: "today"}, opsAgingDetail("ar"))
	register(model.ReportInfo{Key: "customer_balance_summary", Title: "Customer Balance Summary", Category: cr,
		Description: "How much does each customer owe?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "all"}, opsBalanceSummary("ar"))
	register(model.ReportInfo{Key: "customer_balance_detail", Title: "Customer Balance Detail", Category: cr,
		Description: "Which invoices and payments make up each customer's balance?",
		Params:      []string{"dates", "filters"}, DefaultDates: "all"}, opsBalanceDetail("ar"))
	register(model.ReportInfo{Key: "open_invoices", Title: "Open Invoices", Category: cr,
		Description: "Which invoices are unpaid or partially paid?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "today"}, opsOpenDetail("ar"))
	register(model.ReportInfo{Key: "collections", Title: "Overdue Invoices with Contacts", Category: cr,
		Description: "Which customers are overdue, and how can I contact them?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "today"}, opsCollections)
	register(model.ReportInfo{Key: "transaction_list_by_customer", Title: "Transaction List by Customer", Category: cr,
		Description: "What transactions have I entered for each customer?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisFiscalYearToDate"}, opsTxnListByName(model.NameCustomer))

	register(model.ReportInfo{Key: "ap_aging_summary", Title: "A/P Aging Summary", Category: vp,
		Description: "How much do I owe each vendor, and how much of it is overdue?",
		Params:      []string{"asOf", "agingInterval", "filters"}, DefaultDates: "today"}, opsAgingSummary("ap"))
	register(model.ReportInfo{Key: "ap_aging_detail", Title: "A/P Aging Detail", Category: vp,
		Description: "Which bills are unpaid, and how many days overdue is each one?",
		Params:      []string{"asOf", "agingInterval", "filters"}, DefaultDates: "today"}, opsAgingDetail("ap"))
	register(model.ReportInfo{Key: "vendor_balance_summary", Title: "Vendor Balance Summary", Category: vp,
		Description: "How much do I owe each vendor?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "all"}, opsBalanceSummary("ap"))
	register(model.ReportInfo{Key: "vendor_balance_detail", Title: "Vendor Balance Detail", Category: vp,
		Description: "Which bills and payments make up each vendor's balance?",
		Params:      []string{"dates", "filters"}, DefaultDates: "all"}, opsBalanceDetail("ap"))
	register(model.ReportInfo{Key: "unpaid_bills_detail", Title: "Unpaid Bills Detail", Category: vp,
		Description: "Which bills are unpaid, by vendor?",
		Params:      []string{"asOf", "filters"}, DefaultDates: "today"}, opsOpenDetail("ap"))
	register(model.ReportInfo{Key: "transaction_list_by_vendor", Title: "Transaction List by Vendor", Category: vp,
		Description: "What transactions have I entered for each vendor?",
		Params:      []string{"dates", "filters"}, DefaultDates: "thisFiscalYearToDate"}, opsTxnListByName(model.NameVendor))
}

// opsDocFilter applies the standard filters to an open document.
func opsDocFilter(p *Params, d *opsDoc, names map[int64]bool, types map[string]bool) bool {
	if names != nil && !names[d.NameID] {
		return false
	}
	if types != nil && !types[d.Type] {
		return false
	}
	return opsClassOK(p, d.ClassID) && opsTextOK(p, d.Memo, d.Ref)
}

func opsNodeOf(names map[int64]*opsName, id int64) int64 {
	if _, ok := names[id]; ok {
		return id
	}
	return opsNoName
}

func opsAgingSummary(side string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		title, detail := "A/R Aging Summary", "ar_aging_detail"
		if side == "ap" {
			title, detail = "A/P Aging Summary", "ap_aging_detail"
		}
		docs, err := opsOpenDocs(ctx, q, side, p.AsOf)
		if err != nil {
			return nil, err
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		filter, types := opsNameSet(p, names), opsTypeSet(p)
		ag := opsNewAging(p)
		vals := map[int64]opsVals{}
		for _, d := range docs {
			if d.Open == 0 || !opsDocFilter(p, d, filter, types) {
				continue
			}
			id := opsNodeOf(names, d.NameID)
			v := vals[id]
			if v == nil {
				v = opsVals{}
				vals[id] = v
			}
			v[ag.keys[ag.idx(opsDays(d.ageDate(p.Prefs), p.AsOf))]] += float64(d.Open)
			v["total"] += float64(d.Open)
		}
		b := opsNew(ctx, q, p, title, true, false, opsAgingCols(ag)...)
		cells := func(v opsVals) map[string]any {
			c := map[string]any{}
			for _, k := range ag.keys {
				c[k] = opsMF(v[k])
			}
			c["total"] = opsMF(v["total"])
			return c
		}
		drill := func(id int64, own bool) *model.ReportDrill {
			kv := append([]string{"asOf", p.AsOf}, ag.params(p)...)
			if id > 0 {
				jobs := "1"
				if own {
					jobs = "0"
				}
				kv = append(kv, "nameIds", opsID(id), "includeJobs", jobs)
			}
			return opsDrill(detail, kv...)
		}
		// each amount drills down to the aging detail of its bucket; 0.00 does not drill
		cellDrills := func(id int64, own bool, v opsVals) map[string]*model.ReportDrill {
			out := map[string]*model.ReportDrill{}
			for _, k := range append(append([]string{}, ag.keys...), "total") {
				if v[k] == 0 {
					continue
				}
				d := drill(id, own)
				if k != "total" {
					d.Params["bucket"] = k
				}
				out[k] = d
			}
			if d := drill(id, own); len(out) > 0 {
				out["label"] = d
			}
			return out
		}
		total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill, cellDrills: cellDrills}, 0, "")
		c := cells(total)
		c["label"] = "TOTAL"
		b.rowFull(model.ReportRow{Kind: "grandtotal", Cells: c, CellDrills: cellDrills(0, false, total)})
		return b.r, nil
	}
}

func opsAgingDetail(side string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		docs, err := opsOpenDocs(ctx, q, side, p.AsOf)
		if err != nil {
			return nil, err
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		accts, err := opsLoadAccounts(ctx, q)
		if err != nil {
			return nil, err
		}
		terms, err := opsTermsNames(ctx, q)
		if err != nil {
			return nil, err
		}
		filter, types := opsNameSet(p, names), opsTypeSet(p)
		ag := opsNewAging(p)
		var b *opsBuilder
		if side == "ap" {
			b = opsNew(ctx, q, p, "A/P Aging Detail", true, false,
				opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
				opsC("name", "Name", "text"), opsC("due", "Due Date", "date"), opsC("aging", "Aging", "number"),
				opsC("open", "Open Balance", "money"))
		} else {
			b = opsNew(ctx, q, p, "A/R Aging Detail", true, false,
				opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
				opsC("po", "P. O. #", "text"), opsC("name", "Name", "text"), opsC("terms", "Terms", "text"),
				opsC("due", "Due Date", "date"), opsC("aging", "Aging", "number"), opsC("open", "Open Balance", "money"))
		}
		buckets := make([][]*opsDoc, len(ag.keys))
		days := map[*opsDoc]int{}
		for _, d := range docs {
			if d.Open == 0 || !opsDocFilter(p, d, filter, types) {
				continue
			}
			n := opsDays(d.ageDate(p.Prefs), p.AsOf)
			days[d] = n
			i := ag.idx(n)
			buckets[i] = append(buckets[i], d)
		}
		only := p.Str("bucket") // drill-down of one aging column of the summary
		var grand int64
		for i, list := range buckets {
			if len(list) == 0 || (only != "" && ag.keys[i] != only) {
				continue
			}
			g := b.group()
			b.row("section", 0, g, map[string]any{"label": ag.labels[i]})
			var sum int64
			for _, d := range list {
				cells := map[string]any{
					"type": opsTypeLabel(d.Type, opsAcctType(accts, d.HdrAcctID)), "date": d.Date, "num": d.Ref,
					"name": opsNameFull(names, d.NameID), "open": opsM(d.Open),
				}
				if d.DueDate != "" {
					cells["due"] = d.DueDate
				}
				if side == "ar" {
					cells["po"] = d.PONumber
					cells["terms"] = opsTermsOf(terms, d.TermsID)
				}
				if days[d] > 0 {
					cells["aging"] = days[d]
				}
				b.rowFull(model.ReportRow{Kind: "data", Level: 1, Group: g, Cells: cells, TxnID: opsTxnRef(d.TxnID)})
				sum += d.Open
			}
			b.row("subtotal", 0, g, map[string]any{"label": "Total " + ag.labels[i], "open": opsM(sum)})
			grand += sum
		}
		b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "open": opsM(grand)})
		return b.r, nil
	}
}

func opsAcctType(accts map[int64]*opsAcct, id int64) string {
	if a, ok := accts[id]; ok {
		return a.Type
	}
	return ""
}

func opsBalanceSummary(side string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		title, detail := "Customer Balance Summary", "customer_balance_detail"
		if side == "ap" {
			title, detail = "Vendor Balance Summary", "vendor_balance_detail"
		}
		bal, err := opsBalancesByName(ctx, q, side, p.AsOf)
		if err != nil {
			return nil, err
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		filter := opsNameSet(p, names)
		vals := map[int64]opsVals{}
		for id, amt := range bal {
			if amt == 0 || (filter != nil && !filter[id]) {
				continue
			}
			vals[opsNodeOf(names, id)] = opsVals{"balance": float64(amt)}
		}
		b := opsNew(ctx, q, p, title, true, false, opsC("label", "", "text"), opsC("balance", opsShortDate(p.AsOf), "money"))
		cells := func(v opsVals) map[string]any { return map[string]any{"balance": opsMF(v["balance"])} }
		drill := func(id int64, own bool) *model.ReportDrill {
			kv := []string{"from", "", "to", p.AsOf}
			if id > 0 {
				jobs := "1"
				if own {
					jobs = "0"
				}
				kv = append(kv, "nameIds", opsID(id), "includeJobs", jobs)
			}
			return opsDrill(detail, kv...)
		}
		total := b.sumTree(&opsSumSpec{tree: opsNameTree(names, "No name"), vals: vals, cells: cells, drill: drill}, 0, "")
		c := cells(total)
		c["label"] = "TOTAL"
		b.row("grandtotal", 0, "", c)
		return b.r, nil
	}
}

type opsNameTxn struct {
	TxnID, NameID, AcctID, HdrAcct int64
	Type, Date, Ref, Memo          string
	Amount                         int64 // natural sign
}

func opsBalanceDetail(side string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		title := "Customer Balance Detail"
		acctType, sign := model.AcctAR, int64(1)
		if side == "ap" {
			title = "Vendor Balance Detail"
			acctType, sign = model.AcctAP, -1
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		accts, err := opsLoadAccounts(ctx, q)
		if err != nil {
			return nil, err
		}
		filter, types := opsNameSet(p, names), opsTypeSet(p)
		from, to := opsFromTo(p)
		rows, err := q.QueryContext(ctx, `SELECT g.txn_id, IFNULL(g.name_id, 0), SUM(g.amount), MIN(g.account_id), IFNULL(t.account_id, 0),
			t.type, t.date, t.ref_number, t.memo
			FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN txns t ON t.id = g.txn_id
			WHERE a.type = ? AND g.date >= ? AND g.date <= ?
			GROUP BY g.txn_id, IFNULL(g.name_id, 0) ORDER BY t.date, t.ref_number, t.id`, acctType, from, to)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		byName := map[int64][]*opsNameTxn{}
		for rows.Next() {
			x := &opsNameTxn{}
			if err := rows.Scan(&x.TxnID, &x.NameID, &x.Amount, &x.AcctID, &x.HdrAcct, &x.Type, &x.Date, &x.Ref, &x.Memo); err != nil {
				return nil, err
			}
			x.Amount *= sign
			if filter != nil && !filter[x.NameID] {
				continue
			}
			if types != nil && !types[x.Type] {
				continue
			}
			if !opsTextOK(p, x.Memo, x.Ref) {
				continue
			}
			id := opsNodeOf(names, x.NameID)
			byName[id] = append(byName[id], x)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		// Customers (with their jobs) whose balance as of the end date is zero are not shown.
		bal, err := opsBalancesByName(ctx, q, side, p.To)
		if err != nil {
			return nil, err
		}
		tree := opsNameTree(names, "No name")
		rootBal := map[int64]int64{}
		for id, amt := range bal {
			if filter != nil && !filter[id] {
				continue
			}
			rootBal[opsRootOf(tree, opsNodeOf(names, id))] += amt
		}
		b := opsNew(ctx, q, p, title, false, false,
			opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
			opsC("account", "Account", "text"), opsC("amount", "Amount", "money"), opsC("balance", "Balance", "money"))
		spec := &opsDetSpec{
			tree: tree,
			has: func(id int64) bool {
				return len(byName[id]) > 0 && rootBal[opsRootOf(tree, id)] != 0
			},
			emit: func(id int64, level int, g string) opsVals {
				var run int64
				for _, x := range byName[id] {
					run += x.Amount
					b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(x.TxnID), Cells: map[string]any{
						"type": opsTypeLabel(x.Type, opsAcctType(accts, x.HdrAcct)), "date": x.Date, "num": x.Ref,
						"account": opsAcctLabel(accts, x.AcctID, p.Prefs), "amount": opsM(x.Amount), "balance": opsM(run),
					}})
				}
				return opsVals{"amount": float64(run)}
			},
			total: func(v opsVals) map[string]any {
				return map[string]any{"amount": opsMF(v["amount"]), "balance": opsMF(v["amount"])}
			},
		}
		total := b.detTree(spec, 0)
		b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsMF(total["amount"]), "balance": opsMF(total["amount"])})
		return b.r, nil
	}
}

// opsRootOf returns the top-level ancestor of a tree node.
func opsRootOf(t *opsTree, id int64) int64 {
	seen := 0
	for {
		p, ok := t.parent[id]
		if !ok || p == 0 || seen > 50 {
			return id
		}
		id = p
		seen++
	}
}

// opsOpenDetail is Open Invoices (A/R) and Unpaid Bills Detail (A/P).
func opsOpenDetail(side string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		docs, err := opsOpenDocs(ctx, q, side, p.AsOf)
		if err != nil {
			return nil, err
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		accts, err := opsLoadAccounts(ctx, q)
		if err != nil {
			return nil, err
		}
		terms, err := opsTermsNames(ctx, q)
		if err != nil {
			return nil, err
		}
		filter, types := opsNameSet(p, names), opsTypeSet(p)
		var b *opsBuilder
		if side == "ap" {
			b = opsNew(ctx, q, p, "Unpaid Bills Detail", true, false,
				opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
				opsC("due", "Due Date", "date"), opsC("aging", "Aging", "number"), opsC("open", "Open Balance", "money"))
		} else {
			b = opsNew(ctx, q, p, "Open Invoices", true, false,
				opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
				opsC("po", "P. O. #", "text"), opsC("terms", "Terms", "text"), opsC("due", "Due Date", "date"),
				opsC("aging", "Aging", "number"), opsC("open", "Open Balance", "money"))
		}
		byName := map[int64][]*opsDoc{}
		for _, d := range docs {
			if d.Open == 0 || !opsDocFilter(p, d, filter, types) {
				continue
			}
			id := opsNodeOf(names, d.NameID)
			byName[id] = append(byName[id], d)
		}
		spec := &opsDetSpec{
			tree: opsNameTree(names, "No name"),
			has:  func(id int64) bool { return len(byName[id]) > 0 },
			emit: func(id int64, level int, g string) opsVals {
				var sum int64
				for _, d := range byName[id] {
					b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(d.TxnID),
						Cells: opsDocCells(p, d, side, accts, terms)})
					sum += d.Open
				}
				return opsVals{"open": float64(sum)}
			},
			total: func(v opsVals) map[string]any { return map[string]any{"open": opsMF(v["open"])} },
		}
		total := b.detTree(spec, 0)
		b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "open": opsMF(total["open"])})
		return b.r, nil
	}
}

func opsDocCells(p *Params, d *opsDoc, side string, accts map[int64]*opsAcct, terms map[int64]*opsEntry) map[string]any {
	cells := map[string]any{
		"type": opsTypeLabel(d.Type, opsAcctType(accts, d.HdrAcctID)), "date": d.Date, "num": d.Ref, "open": opsM(d.Open),
	}
	if d.DueDate != "" {
		cells["due"] = d.DueDate
	}
	if side == "ar" {
		cells["po"] = d.PONumber
		cells["terms"] = opsTermsOf(terms, d.TermsID)
	}
	if n := opsDays(d.ageDate(p.Prefs), p.AsOf); n > 0 {
		cells["aging"] = n
	}
	return cells
}

func opsCollections(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	docs, err := opsOpenDocs(ctx, q, "ar", p.AsOf)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	terms, err := opsTermsNames(ctx, q)
	if err != nil {
		return nil, err
	}
	filter, types := opsNameSet(p, names), opsTypeSet(p)
	b := opsNew(ctx, q, p, "Overdue Invoices with Contacts", true, false,
		opsC("label", "", "text"), opsC("contact", "Contact", "text"), opsC("phone", "Phone", "text"),
		opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"), opsC("po", "P. O. #", "text"),
		opsC("terms", "Terms", "text"), opsC("due", "Due Date", "date"), opsC("aging", "Aging", "number"),
		opsC("open", "Open Balance", "money"))
	byName := map[int64][]*opsDoc{}
	for _, d := range docs {
		if d.Open <= 0 || !opsDocFilter(p, d, filter, types) {
			continue
		}
		if opsDays(d.ageDate(p.Prefs), p.AsOf) <= 0 {
			continue
		}
		id := opsNodeOf(names, d.NameID)
		byName[id] = append(byName[id], d)
	}
	spec := &opsDetSpec{
		tree: opsNameTree(names, "No name"),
		has:  func(id int64) bool { return len(byName[id]) > 0 },
		section: func(id int64) map[string]any {
			n, ok := names[id]
			if !ok {
				return nil
			}
			ph := n.Phone
			if ph == "" {
				ph = n.Mobile
			}
			return map[string]any{"contact": n.contact(), "phone": ph}
		},
		emit: func(id int64, level int, g string) opsVals {
			var sum int64
			for _, d := range byName[id] {
				b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(d.TxnID),
					Cells: opsDocCells(p, d, "ar", accts, terms)})
				sum += d.Open
			}
			return opsVals{"open": float64(sum)}
		},
		total: func(v opsVals) map[string]any { return map[string]any{"open": opsMF(v["open"])} },
	}
	total := b.detTree(spec, 0)
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "open": opsMF(total["open"])})
	return b.r, nil
}

// opsTxnListByName is Transaction List by Customer / by Vendor: every
// transaction whose name is a customer:job (vendor) in the date range.
func opsTxnListByName(kind string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		title := "Transaction List by Customer"
		if kind == model.NameVendor {
			title = "Transaction List by Vendor"
		}
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		accts, err := opsLoadAccounts(ctx, q)
		if err != nil {
			return nil, err
		}
		byName, err := opsLoadNameTxns(ctx, q, p, names, accts, opsNameSet(p, names), `%s IN (SELECT id FROM names WHERE kind = ?)`, kind)
		if err != nil {
			return nil, err
		}
		b := opsNew(ctx, q, p, title, false, false,
			opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
			opsC("memo", "Memo", "text"), opsC("account", "Account", "text"), opsC("clr", "Clr", "text"),
			opsC("split", "Split", "text"), opsC("amount", "Amount", "money"))
		spec := &opsDetSpec{
			tree: opsNameTree(names, "No name"),
			has:  func(id int64) bool { return len(byName[id]) > 0 },
			emit: func(id int64, level int, g string) opsVals {
				for _, x := range byName[id] {
					cells, _ := opsNameTxnCells(p, x, accts)
					b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(x.id), Cells: cells})
				}
				return nil
			},
		}
		b.detTree(spec, 0)
		return b.r, nil
	}
}
