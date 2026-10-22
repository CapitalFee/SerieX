package reports

// List reports (listings, phone and contact lists) and the name / item activity reports.

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	const li = "Lists"
	register(model.ReportInfo{Key: "account_listing", Title: "Account Listing", Category: li,
		Description: "What accounts are in my chart of accounts?", Params: []string{}, DefaultDates: "today"}, opsAccountListing)
	register(model.ReportInfo{Key: "item_listing", Title: "Item Listing", Category: li,
		Description: "What items do I sell and buy, and what are their prices and costs?", Params: []string{}, DefaultDates: "today"}, opsItemListing)
	register(model.ReportInfo{Key: "item_price_list", Title: "Item Price List", Category: li,
		Description: "What is the price of each item?", Params: []string{}, DefaultDates: "today"}, opsItemPriceList)
	register(model.ReportInfo{Key: "terms_listing", Title: "Terms Listing", Category: li,
		Description: "What payment terms do I use?", Params: []string{}, DefaultDates: "today"}, opsTermsListing)
	register(model.ReportInfo{Key: "customer_phone_list", Title: "Customer Phone List", Category: li,
		Description: "What are my customers' phone numbers?", Params: []string{}, DefaultDates: "today"}, opsPhoneList(model.NameCustomer))
	register(model.ReportInfo{Key: "customer_contact_list", Title: "Customer Contact List", Category: li,
		Description: "Who are my customers' contacts, and what are their addresses and balances?", Params: []string{}, DefaultDates: "today"}, opsContactList(model.NameCustomer))
	register(model.ReportInfo{Key: "vendor_phone_list", Title: "Vendor Phone List", Category: li,
		Description: "What are my vendors' phone numbers?", Params: []string{}, DefaultDates: "today"}, opsPhoneList(model.NameVendor))
	register(model.ReportInfo{Key: "vendor_contact_list", Title: "Vendor Contact List", Category: li,
		Description: "Who are my vendors' contacts, and what are their addresses and balances?", Params: []string{}, DefaultDates: "today"}, opsContactList(model.NameVendor))
	register(model.ReportInfo{Key: "other_names_phone_list", Title: "Other Names Phone List", Category: li,
		Description: "What are the phone numbers of my other names?", Params: []string{}, DefaultDates: "today"}, opsPhoneList(model.NameOther))

	const qr = "Activity Reports"
	register(model.ReportInfo{Key: "name_quickreport", Title: "Name Activity", Category: qr,
		Description: "All transactions of one customer, vendor or other name.",
		Params:      []string{"dates", "nameId", "filters"}, DefaultDates: "all"}, opsNameActivity)
	register(model.ReportInfo{Key: "item_quickreport", Title: "Item Activity", Category: qr,
		Description: "All transactions that use one item.",
		Params:      []string{"dates", "itemId", "filters"}, DefaultDates: "all"}, opsItemActivity)
}

// opsListResult starts a list report (no date range in the header).
func opsListResult(ctx context.Context, q store.Q, p *Params, title string, cols ...model.ReportColumn) *opsBuilder {
	b := opsNew(ctx, q, p, title, false, false, cols...)
	b.r.DateRangeLabel = ""
	return b
}

func opsAccountListing(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	own := map[int64]int64{}
	rows, err := q.QueryContext(ctx, `SELECT account_id, SUM(amount) FROM gl_entries GROUP BY account_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, amt int64
		if err := rows.Scan(&id, &amt); err != nil {
			rows.Close()
			return nil, err
		}
		own[id] = amt
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	children := map[int64][]int64{}
	for _, a := range accts {
		parent := a.ParentID
		if _, ok := accts[parent]; !ok {
			parent = 0
		}
		children[parent] = append(children[parent], a.ID)
	}
	less := func(x, y *opsAcct) bool {
		rx, ry := model.AccountTypeRank(x.Type), model.AccountTypeRank(y.Type)
		if x.ParentID == 0 && y.ParentID == 0 && rx != ry {
			return rx < ry
		}
		if p.Prefs.UseAccountNumbers && x.Number != y.Number {
			if x.Number == "" || y.Number == "" {
				return y.Number == ""
			}
			return x.Number < y.Number
		}
		return strings.ToLower(x.Name) < strings.ToLower(y.Name)
	}
	for k, ids := range children {
		sort.Slice(ids, func(i, j int) bool { return less(accts[ids[i]], accts[ids[j]]) })
		children[k] = ids
	}
	var total func(id int64) int64
	total = func(id int64) int64 {
		s := own[id]
		for _, c := range children[id] {
			s += total(c)
		}
		return s
	}
	cols := []model.ReportColumn{opsC("label", "Account", "text"), opsC("type", "Type", "text"),
		opsC("balance", "Balance Total", "money"), opsC("desc", "Description", "text")}
	if p.Prefs.UseAccountNumbers {
		cols = append(cols, opsC("number", "Accnt. #", "text"))
	}
	cols = append(cols, opsC("taxline", "Tax Line", "text"))
	b := opsListResult(ctx, q, p, "Account Listing", cols...)
	b.r.DateRangeLabel = longDate(p.Today)
	var walk func(id int64)
	walk = func(id int64) {
		a := accts[id]
		if a.Active || total(id) != 0 {
			cells := map[string]any{"label": opsAcctLabel(accts, id, p.Prefs), "type": a.Type, "desc": a.Description, "taxline": a.TaxLine}
			if p.Prefs.UseAccountNumbers {
				cells["number"] = a.Number
			}
			dates := "thisFiscalYearToDate"
			if model.IsBalanceSheet(a.Type) {
				bal := total(id)
				if !model.IsDebitNormal(a.Type) {
					bal = -bal
				}
				cells["balance"] = opsM(bal)
				dates = "all"
			}
			drill := opsDrill("account_quickreport", "accountId", opsID(id), "dates", dates)
			b.rowFull(model.ReportRow{Kind: "data", Level: 0, Cells: cells, Drill: drill})
		}
		for _, c := range children[id] {
			walk(c)
		}
	}
	for _, id := range children[0] {
		walk(id)
	}
	return b.r, nil
}

// opsItemsInListOrder returns item ids by type order then hierarchy (parents before children).
func opsItemsInListOrder(items map[int64]*opsItem, keep func(*opsItem) bool) []int64 {
	tree := opsItemTree(items)
	rank := map[string]int{}
	for i, t := range model.ItemTypeOrder {
		rank[t] = i
	}
	roots := append([]int64{}, tree.children[0]...)
	sort.SliceStable(roots, func(i, j int) bool {
		a, b := items[roots[i]], items[roots[j]]
		if a == nil || b == nil {
			return b == nil && a != nil
		}
		return rank[a.Type] < rank[b.Type]
	})
	var out []int64
	var walk func(id int64)
	walk = func(id int64) {
		if it, ok := items[id]; ok && keep(it) {
			out = append(out, id)
		}
		for _, c := range tree.children[id] {
			walk(c)
		}
	}
	for _, r := range roots {
		walk(r)
	}
	return out
}

func opsItemListing(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	bal, err := opsInvBalances(ctx, q, "9999-12-31", false)
	if err != nil {
		return nil, err
	}
	onPO, _, err := opsOnPO(ctx, q)
	if err != nil {
		return nil, err
	}
	b := opsListResult(ctx, q, p, "Item Listing",
		opsC("label", "Item", "text"), opsC("desc", "Description", "text"), opsC("type", "Type", "text"),
		opsC("cost", "Cost", "money"), opsC("price", "Price", "money"), opsC("taxcode", "Sales Tax Code", "text"),
		opsC("onhand", "Quantity On Hand", "number"), opsC("onpo", "Quantity On Purchase Order", "number"),
		opsC("reorder", "Reorder Pt (Min)", "number"), opsC("vendor", "Preferred Vendor", "text"))
	b.r.DateRangeLabel = longDate(p.Today)
	groupRate := map[int64]float64{}
	grows, err := q.QueryContext(ctx, `SELECT g.group_id, SUM(i.tax_rate) FROM item_group_lines g JOIN items i ON i.id = g.item_id GROUP BY g.group_id`)
	if err != nil {
		return nil, err
	}
	for grows.Next() {
		var gid int64
		var rate float64
		if err := grows.Scan(&gid, &rate); err != nil {
			grows.Close()
			return nil, err
		}
		groupRate[gid] = rate
	}
	if err := grows.Err(); err != nil {
		grows.Close()
		return nil, err
	}
	grows.Close()
	for _, id := range opsItemsInListOrder(items, func(it *opsItem) bool { return it.Active }) {
		it := items[id]
		cells := map[string]any{"label": it.Full, "desc": it.Description, "type": it.Type, "vendor": opsNameFull(names, it.PrefVendor)}
		switch it.Type {
		case model.ItemSalesTax:
			cells["price"] = fmt.Sprintf("%g%%", it.TaxRate)
		case model.ItemSalesTaxGroup:
			cells["price"] = fmt.Sprintf("%g%%", math.Round(groupRate[id]*10000)/10000)
		case model.ItemSubtotal, model.ItemGroup, model.ItemPayment:
		default:
			if it.RateIsPercent {
				cells["price"] = fmt.Sprintf("%g%%", it.SalesPrice)
			} else {
				cells["price"] = it.SalesPrice
			}
			if it.Type != model.ItemDiscount {
				cells["cost"] = it.Cost
			}
			if it.Taxable {
				cells["taxcode"] = "Tax"
			} else {
				cells["taxcode"] = "Non"
			}
		}
		if it.Type == model.ItemInventoryPart {
			cells["onhand"] = opsQty(bal[id][0])
			cells["onpo"] = opsQty(onPO[id])
			if it.ReorderPoint.Valid {
				cells["reorder"] = opsQty(it.ReorderPoint.Float64)
			}
		}
		b.rowFull(model.ReportRow{Kind: "data", Cells: cells, Drill: opsDrill("item_quickreport", "itemId", opsID(id), "dates", "all")})
	}
	return b.r, nil
}

func opsItemPriceList(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	b := opsListResult(ctx, q, p, "Item Price List",
		opsC("label", "Item", "text"), opsC("desc", "Description", "text"), opsC("vendor", "Preferred Vendor", "text"),
		opsC("price", "Price", "money"))
	b.r.DateRangeLabel = longDate(p.Today)
	keep := func(it *opsItem) bool {
		switch it.Type {
		case model.ItemService, model.ItemInventoryPart, model.ItemNonInventory, model.ItemOtherCharge:
			return it.Active
		}
		return false
	}
	for _, id := range opsItemsInListOrder(items, keep) {
		it := items[id]
		cells := map[string]any{"label": it.Full, "desc": it.Description, "vendor": opsNameFull(names, it.PrefVendor)}
		if it.RateIsPercent {
			cells["price"] = fmt.Sprintf("%g%%", it.SalesPrice)
		} else {
			cells["price"] = it.SalesPrice
		}
		b.rowFull(model.ReportRow{Kind: "data", Cells: cells, Drill: opsDrill("item_quickreport", "itemId", opsID(id), "dates", "all")})
	}
	return b.r, nil
}

func opsTermsListing(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	terms, err := opsTermsNames(ctx, q)
	if err != nil {
		return nil, err
	}
	b := opsListResult(ctx, q, p, "Terms Listing",
		opsC("label", "Terms", "text"), opsC("kind", "Type", "text"), opsC("net", "Net Due", "text"),
		opsC("discpct", "Discount %", "percent"), opsC("discdays", "Discount Days", "text"))
	var ids []int64
	for id, e := range terms {
		if e.Active {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return strings.ToLower(terms[ids[i]].Name) < strings.ToLower(terms[ids[j]].Name) })
	for _, id := range ids {
		e := terms[id]
		cells := map[string]any{"label": e.Name}
		if opsBool(e.Data, "dateDriven") {
			cells["kind"] = "Date Driven"
			cells["net"] = fmt.Sprintf("Day %g of the month", opsNum(e.Data, "dueDay"))
			if d := opsNum(e.Data, "discountDay"); d > 0 {
				cells["discdays"] = fmt.Sprintf("Day %g", d)
			}
		} else {
			cells["kind"] = "Standard"
			cells["net"] = fmt.Sprintf("%g days", opsNum(e.Data, "netDays"))
			if d := opsNum(e.Data, "discountDays"); d > 0 {
				cells["discdays"] = fmt.Sprintf("%g days", d)
			}
		}
		if pct := opsNum(e.Data, "discountPct"); pct != 0 {
			cells["discpct"] = pct
		}
		b.row("data", 0, "", cells)
	}
	return b.r, nil
}

// opsNamesOfKind returns the active names of a kind ordered by full name.
func opsNamesOfKind(names map[int64]*opsName, kind string) []*opsName {
	var out []*opsName
	for _, n := range names {
		if n.Kind == kind && n.Active {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Full) < strings.ToLower(out[j].Full) })
	return out
}

func opsKindTitle(kind string) string {
	switch kind {
	case model.NameCustomer:
		return "Customer"
	case model.NameVendor:
		return "Vendor"
	}
	return "Other Name"
}

func opsPhoneList(kind string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		title := opsKindTitle(kind) + " Phone List"
		if kind == model.NameOther {
			title = "Other Names Phone List"
		}
		b := opsListResult(ctx, q, p, title, opsC("label", opsKindTitle(kind), "text"), opsC("phone", "Main Phone", "text"))
		for _, n := range opsNamesOfKind(names, kind) {
			ph := n.Phone
			if ph == "" {
				ph = n.Mobile
			}
			b.rowFull(model.ReportRow{Kind: "data", Cells: map[string]any{"label": n.Full, "phone": ph},
				Drill: opsDrill("name_quickreport", "nameId", opsID(n.ID), "dates", "all")})
		}
		return b.r, nil
	}
}

func opsContactList(kind string) Func {
	return func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
		names, err := opsLoadNames(ctx, q)
		if err != nil {
			return nil, err
		}
		side := "ar"
		if kind == model.NameVendor {
			side = "ap"
		}
		bal, err := opsBalancesByName(ctx, q, side, "9999-12-31")
		if err != nil {
			return nil, err
		}
		// Balance Total includes the jobs of a customer.
		total := map[int64]int64{}
		for id, amt := range bal {
			seen := map[int64]bool{}
			for x := id; x != 0 && !seen[x]; {
				seen[x] = true
				total[x] += amt
				n, ok := names[x]
				if !ok {
					break
				}
				x = n.ParentID
			}
		}
		cols := []model.ReportColumn{opsC("label", opsKindTitle(kind), "text")}
		if kind == model.NameVendor {
			cols = append(cols, opsC("acctno", "Account No.", "text"), opsC("bill", "Bill from", "text"))
		} else {
			cols = append(cols, opsC("bill", "Bill to", "text"))
		}
		cols = append(cols, opsC("contact", "Primary Contact", "text"), opsC("phone", "Main Phone", "text"),
			opsC("fax", "Fax", "text"), opsC("balance", "Balance Total", "money"))
		b := opsListResult(ctx, q, p, opsKindTitle(kind)+" Contact List", cols...)
		for _, n := range opsNamesOfKind(names, kind) {
			cells := map[string]any{"label": n.Full, "bill": strings.ReplaceAll(n.billTo(), "\n", ", "), "contact": n.contact(),
				"phone": n.Phone, "fax": n.Fax, "balance": opsM(total[n.ID])}
			if kind == model.NameVendor {
				cells["acctno"] = n.AccountNumber
			}
			b.rowFull(model.ReportRow{Kind: "data", Cells: cells,
				Drill: opsDrill("name_quickreport", "nameId", opsID(n.ID), "dates", "all")})
		}
		return b.r, nil
	}
}

// opsNameTxnRow is one transaction of a name (transaction lists and activity reports).
type opsNameTxnRow struct {
	id, name, amount, acct, class int64
	typ, date, ref, memo          string
	post                          *opsPost
}

// opsLoadNameTxns returns the transactions of the names matching nameCond in
// the report period, grouped by name node. nameCond is a SQL condition with
// one %s for the name column (e.g. "%s IN (SELECT id FROM names WHERE kind = ?)"):
// transactions whose header name matches, plus general journal entries with
// lines for a matching name (one row per name, showing that name's lines).
func opsLoadNameTxns(ctx context.Context, q store.Q, p *Params, names map[int64]*opsName, accts map[int64]*opsAcct,
	filter map[int64]bool, nameCond string, args ...any) (map[int64][]opsNameTxnRow, error) {
	from, to := opsFromTo(p)
	types := opsTypeSet(p)
	hcond := fmt.Sprintf(nameCond, "t.name_id")
	posts, err := opsPostings(ctx, q, accts, p.Prefs, `t.type <> 'GENJRNL' AND t.date >= ? AND t.date <= ? AND `+hcond, append([]any{from, to}, args...)...)
	if err != nil {
		return nil, err
	}
	var list []opsNameTxnRow
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, t.memo, t.name_id, t.amount, IFNULL(t.account_id, 0),
		IFNULL(t.class_id, 0) FROM txns t WHERE t.type <> 'GENJRNL' AND t.date >= ? AND t.date <= ? AND `+hcond, append([]any{from, to}, args...)...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var x opsNameTxnRow
		if err := rows.Scan(&x.id, &x.typ, &x.date, &x.ref, &x.memo, &x.name, &x.amount, &x.acct, &x.class); err != nil {
			rows.Close()
			return nil, err
		}
		x.post = posts[x.id]
		list = append(list, x)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Journal entry lines with a name.
	jrows, err := q.QueryContext(ctx, `SELECT t.id, t.date, t.ref_number, t.memo, IFNULL(t.class_id, 0), g.name_id, g.account_id, g.amount, g.cleared
		FROM gl_entries g JOIN txns t ON t.id = g.txn_id
		WHERE t.type = 'GENJRNL' AND t.date >= ? AND t.date <= ? AND t.id IN (SELECT g2.txn_id FROM gl_entries g2 WHERE `+
		fmt.Sprintf(nameCond, "g2.name_id")+`) ORDER BY t.id, g.seq, g.id`, append([]any{from, to}, args...)...)
	if err != nil {
		return nil, err
	}
	type jent struct {
		name, acct, amt int64
		clr             string
	}
	jents := map[int64][]jent{}
	jhead := map[int64]opsNameTxnRow{}
	var jorder []int64
	for jrows.Next() {
		var x opsNameTxnRow
		var e jent
		var nm sql.NullInt64
		if err := jrows.Scan(&x.id, &x.date, &x.ref, &x.memo, &x.class, &nm, &e.acct, &e.amt, &e.clr); err != nil {
			jrows.Close()
			return nil, err
		}
		e.name = nm.Int64
		if _, ok := jhead[x.id]; !ok {
			x.typ = model.TxJournal
			jhead[x.id] = x
			jorder = append(jorder, x.id)
		}
		jents[x.id] = append(jents[x.id], e)
	}
	if err := jrows.Err(); err != nil {
		jrows.Close()
		return nil, err
	}
	jrows.Close()
	for _, tid := range jorder {
		es := jents[tid]
		seen := map[int64]bool{}
		for _, e := range es {
			if e.name == 0 || seen[e.name] {
				continue
			}
			seen[e.name] = true
			x := jhead[tid]
			x.name = e.name
			ps := &opsPost{AcctID: e.acct, Cleared: e.clr, HasGL: true}
			others := map[int64]bool{}
			for _, e2 := range es {
				if e2.acct == e.acct && e2.name == e.name {
					ps.Amount += e2.amt
				} else if e2.acct != e.acct {
					others[e2.acct] = true
				}
			}
			if len(others) == 1 {
				for a := range others {
					ps.Split = opsAcctLabel(accts, a, p.Prefs)
				}
			} else if len(others) > 1 {
				ps.Split = "-SPLIT-"
			}
			x.post, x.amount = ps, ps.Amount
			list = append(list, x)
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if list[i].date != list[j].date {
			return list[i].date < list[j].date
		}
		if list[i].ref != list[j].ref {
			return list[i].ref < list[j].ref
		}
		return list[i].id < list[j].id
	})
	out := map[int64][]opsNameTxnRow{}
	for _, x := range list {
		if (filter != nil && !filter[x.name]) || (types != nil && !types[x.typ]) || !opsClassOK(p, x.class) ||
			!opsTextOK(p, x.memo, x.ref) || !opsAmountOK(p, x.amount) {
			continue
		}
		id := opsNodeOf(names, x.name)
		out[id] = append(out[id], x)
	}
	return out, nil
}

// opsNameTxnCells fills Type, Date, Num, Memo, Account, Clr, Split and Amount and returns the amount.
func opsNameTxnCells(p *Params, x opsNameTxnRow, accts map[int64]*opsAcct) (map[string]any, int64) {
	cells := map[string]any{"type": opsTypeLabel(x.typ, opsAcctType(accts, x.acct)), "date": x.date, "num": x.ref, "memo": x.memo}
	amt := x.amount
	if ps := x.post; ps != nil {
		cells["account"] = opsAcctLabel(accts, ps.AcctID, p.Prefs)
		cells["clr"] = ps.Cleared
		cells["split"] = ps.Split
		amt = ps.Amount
	} else if x.acct != 0 {
		cells["account"] = opsAcctLabel(accts, x.acct, p.Prefs)
	}
	cells["amount"] = opsM(amt)
	return cells, amt
}

func opsNameActivity(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	id := p.ID("nameId")
	if id == 0 && len(p.Filters.NameIDs) > 0 {
		id = p.Filters.NameIDs[0]
	}
	if id == 0 {
		return nil, apperr.Validation("nameId", "Select a name for the activity report.")
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	n, ok := names[id]
	if !ok {
		return nil, apperr.NotFound("Name not found.")
	}
	accts, err := opsLoadAccounts(ctx, q)
	if err != nil {
		return nil, err
	}
	set := map[int64]bool{id: true}
	if n.Kind == model.NameCustomer {
		for x, nn := range names {
			for pp := nn.ParentID; pp != 0; {
				if pp == id {
					set[x] = true
					break
				}
				pn, ok := names[pp]
				if !ok {
					break
				}
				pp = pn.ParentID
			}
		}
	}
	ids := make([]string, 0, len(set))
	for x := range set {
		ids = append(ids, opsID(x))
	}
	byName, err := opsLoadNameTxns(ctx, q, p, names, accts, set, `%s IN (`+strings.Join(ids, ",")+`)`)
	if err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, opsKindTitle(n.Kind)+" Activity", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("memo", "Memo", "text"), opsC("account", "Account", "text"), opsC("clr", "Clr", "text"),
		opsC("split", "Split", "text"), opsC("amount", "Amount", "money"))
	spec := &opsDetSpec{
		tree:  opsNameTree(names, "No name"),
		roots: []int64{id},
		has:   func(x int64) bool { return len(byName[x]) > 0 },
		emit: func(x int64, level int, g string) opsVals {
			var sum int64
			for _, r := range byName[x] {
				cells, amt := opsNameTxnCells(p, r, accts)
				b.rowFull(model.ReportRow{Kind: "data", Level: level, Group: g, TxnID: opsTxnRef(r.id), Cells: cells})
				sum += amt
			}
			return opsVals{"amount": float64(sum)}
		},
		total: func(v opsVals) map[string]any { return map[string]any{"amount": opsMF(v["amount"])} },
	}
	if !spec.tree.hasAny(id, spec.has, map[int64]bool{}) {
		b.row("section", 0, "", map[string]any{"label": n.Name})
	}
	total := b.detTree(spec, 0)
	b.row("grandtotal", 0, "", map[string]any{"label": "TOTAL", "amount": opsMF(total["amount"])})
	return b.r, nil
}

func opsItemActivity(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	items, err := opsLoadItems(ctx, q)
	if err != nil {
		return nil, err
	}
	id := p.ID("itemId")
	if id == 0 && len(p.Filters.ItemIDs) > 0 {
		id = p.Filters.ItemIDs[0]
	}
	if id == 0 {
		return nil, apperr.Validation("itemId", "Select an item for the Item Activity report.")
	}
	it, ok := items[id]
	if !ok {
		return nil, apperr.NotFound("Item not found.")
	}
	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	set := opsItemFilter(p, items)
	if set == nil {
		set = map[int64]bool{id: true}
	}
	from, to := opsFromTo(p)
	rows, err := q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.ref_number, IFNULL(l.name_id, IFNULL(t.name_id, 0)), l.item_id,
		l.description, l.qty, l.rate, l.amount, t.memo
		FROM txn_lines l JOIN txns t ON t.id = l.txn_id
		WHERE l.item_id IS NOT NULL AND t.voided = 0 AND t.date >= ? AND t.date <= ?
		ORDER BY t.date, t.ref_number, t.id, l.seq`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type ln struct {
		txn, name            int64
		typ, date, ref, desc string
		qty, rate            sql.NullFloat64
		amount               int64
	}
	types := opsTypeSet(p)
	byItem := map[int64][]ln{}
	for rows.Next() {
		var x ln
		var item int64
		var memo string
		if err := rows.Scan(&x.txn, &x.typ, &x.date, &x.ref, &x.name, &item, &x.desc, &x.qty, &x.rate, &x.amount, &memo); err != nil {
			return nil, err
		}
		if !set[item] || (types != nil && !types[x.typ]) {
			continue
		}
		if x.desc == "" {
			x.desc = memo
		}
		byItem[item] = append(byItem[item], x)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	b := opsNew(ctx, q, p, "Item Activity", false, false,
		opsC("label", "", "text"), opsC("type", "Type", "text"), opsC("date", "Date", "date"), opsC("num", "Num", "text"),
		opsC("memo", "Memo", "text"), opsC("name", "Name", "text"), opsC("qty", "Qty", "number"),
		opsC("price", "Sales Price", "money"), opsC("amount", "Amount", "money"))
	// Quantity is shown as its effect on the items on hand, amounts as the
	// transaction shows them (credits negative). Each item's rows are grouped
	// into Purchases, Sales and Inventory Adjustments with their totals.
	qtySign := map[string]float64{model.TxInvoice: -1, model.TxSalesReceipt: -1, model.TxEstimate: -1, model.TxVendorCredit: -1, model.TxCCCredit: -1}
	amtSign := map[string]int64{model.TxCreditMemo: -1, model.TxVendorCredit: -1, model.TxCCCredit: -1}
	groupOf := func(typ string) int {
		switch typ {
		case model.TxCheck, model.TxBill, model.TxItemReceipt, model.TxCCCharge, model.TxVendorCredit, model.TxCCCredit, model.TxPurchaseOrder:
			return 0
		case model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxStatementCharge, model.TxEstimate:
			return 1
		case model.TxInventoryAdjust:
			return 2
		}
		return 3
	}
	groupLabels := []string{"Purchases", "Sales", "Inventory Adjustments", "Other"}
	spec := &opsDetSpec{
		tree:  opsItemTree(items),
		roots: []int64{id},
		has:   func(x int64) bool { return len(byItem[x]) > 0 },
		emit: func(x int64, level int, _ string) opsVals {
			for gi, glabel := range groupLabels {
				var sum int64
				var qsum float64
				n := 0
				var g string
				for _, r := range byItem[x] {
					if groupOf(r.typ) != gi {
						continue
					}
					if n == 0 {
						g = b.group()
						b.row("section", level, g, map[string]any{"label": glabel})
					}
					n++
					s := int64(1)
					if v, ok := amtSign[r.typ]; ok {
						s = v
					}
					cells := map[string]any{"type": opsTypeLabel(r.typ, ""), "date": r.date, "num": r.ref, "memo": r.desc,
						"name": opsNameFull(names, r.name), "amount": opsM(s * r.amount)}
					if r.qty.Valid {
						qs := 1.0
						if v, ok := qtySign[r.typ]; ok {
							qs = v
						}
						cells["qty"] = opsQty(qs * r.qty.Float64)
						qsum += qs * r.qty.Float64
					}
					if r.rate.Valid {
						cells["price"] = r.rate.Float64
					}
					b.rowFull(model.ReportRow{Kind: "data", Level: level + 1, Group: g, TxnID: opsTxnRef(r.txn), Cells: cells})
					sum += s * r.amount
				}
				if n > 0 {
					b.row("subtotal", level, g, map[string]any{"label": "Total " + glabel, "qty": opsQty(qsum), "amount": opsM(sum)})
				}
			}
			return nil
		},
		total: func(v opsVals) map[string]any { return map[string]any{} },
	}
	if !spec.tree.hasAny(id, spec.has, map[int64]bool{}) {
		b.row("section", 0, "", map[string]any{"label": it.Name})
	}
	b.detTree(spec, 0)
	return b.r, nil
}
