package reports

// Detail reports: Profit and Loss Detail, Balance Sheet Detail, General
// Ledger, Transaction Detail by Account (drill-down target), Account
// Activity, Custom Transaction Detail, Journal, Transaction List by Date,
// Income by Customer Detail and Expenses by Vendor Detail.

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// finDetailCol are the columns detail reports can show (custom report "cols").
var finDetailCol = map[string]finCol{
	"trans":   {Key: "trans", Label: "Trans #", Type: "text"},
	"type":    {Key: "type", Label: "Type", Type: "text"},
	"date":    {Key: "date", Label: "Date", Type: "date"},
	"num":     {Key: "num", Label: "Num", Type: "text"},
	"name":    {Key: "name", Label: "Name", Type: "text"},
	"memo":    {Key: "memo", Label: "Memo", Type: "text"},
	"account": {Key: "account", Label: "Account", Type: "text"},
	"class":   {Key: "class", Label: "Class", Type: "text"},
	"item":    {Key: "item", Label: "Item", Type: "text"},
	"clr":     {Key: "clr", Label: "Clr", Type: "text"},
	"split":   {Key: "split", Label: "Split", Type: "text"},
	"debit":   {Key: "debit", Label: "Debit", Type: "money"},
	"credit":  {Key: "credit", Label: "Credit", Type: "money"},
	"amount":  {Key: "amount", Label: "Amount", Type: "money"},
	"balance": {Key: "balance", Label: "Balance", Type: "money"},
}

func finDetailCols(keys ...string) []finCol {
	out := make([]finCol, 0, len(keys))
	for _, k := range keys {
		if col, ok := finDetailCol[k]; ok {
			out = append(out, col)
		}
	}
	return out
}

// finCustomCols parses the "cols" parameter (falls back to def).
func finCustomCols(p *Params, def []string) []finCol {
	var keys []string
	for _, k := range strings.Split(p.Str("cols"), ",") {
		if k = strings.TrimSpace(k); k != "" {
			if _, ok := finDetailCol[k]; ok {
				keys = append(keys, k)
			}
		}
	}
	if len(keys) == 0 {
		keys = def
	}
	return finDetailCols(keys...)
}

func finDetailResult(ctx context.Context, q store.Q, p *Params, title string, asOf, basis bool, l *finLayout) *model.ReportResult {
	res := NewResult(ctx, q, p, title, asOf, basis)
	res.Columns = append([]model.ReportColumn{finLabelCol()}, finReportCols(l.cols)...)
	res.Rows = l.rows
	if res.Rows == nil {
		res.Rows = []model.ReportRow{}
	}
	return res
}

// entryRow appends a transaction row; amount is the natural-sign amount shown,
// bal the running balance.
func (l *finLayout) entryRow(e *finEntry, level int, group string, amount, bal int64) {
	c := l.c
	t := c.txns[e.TxnID]
	cells := map[string]any{"label": ""}
	for _, col := range l.cols {
		switch col.Key {
		case "trans":
			cells["trans"] = strconv.FormatInt(e.TxnID, 10)
		case "type":
			cells["type"] = c.typeLabel(t)
		case "date":
			cells["date"] = finDate(e.Date)
		case "num":
			if t != nil {
				cells["num"] = t.Ref
			}
		case "name":
			n := c.nameFull(e.NameID)
			if n == "" && t != nil {
				n = c.nameFull(t.NameID)
			}
			cells["name"] = n
		case "memo":
			cells["memo"] = e.Memo
		case "account":
			cells["account"] = c.acctName(e.AccountID)
		case "class":
			cells["class"] = c.className(e.ClassID)
		case "item":
			if it := c.items[e.ItemID]; it != nil {
				cells["item"] = it.Full
			} else {
				cells["item"] = ""
			}
		case "clr":
			cells["clr"] = finClr(e.Cleared)
		case "split":
			cells["split"] = c.split(e)
		case "debit":
			if e.Amount > 0 {
				cells["debit"] = store.Dollars(e.Amount)
			} else {
				cells["debit"] = nil
			}
		case "credit":
			if e.Amount < 0 {
				cells["credit"] = store.Dollars(-e.Amount)
			} else {
				cells["credit"] = nil
			}
		case "amount":
			cells["amount"] = store.Dollars(amount)
		case "balance":
			cells["balance"] = store.Dollars(bal)
		}
	}
	l.rows = append(l.rows, model.ReportRow{Kind: "data", Level: level, Cells: cells, TxnID: finTxnPtr(e.TxnID), Group: group})
}

func finByAccount(es []finEntry) map[int64][]finEntry {
	by := map[int64][]finEntry{}
	for _, e := range es {
		by[e.AccountID] = append(by[e.AccountID], e)
	}
	return by
}

// finBlocks emits one block per account: header (with the beginning
// balance when begin is set), its transactions, its subaccounts' blocks and
// "Total <Account>". Totals: amount (natural), debit, credit, balance (ending).
type finBlocks struct {
	by        map[int64][]finEntry
	begin     map[int64]int64 // natural beginning balances (nil = none)
	keepEmpty bool            // show accounts that only have a beginning balance
	has       map[int64]bool
}

func (o *finBlocks) active(a *finAcct) bool {
	if o.has == nil {
		o.has = map[int64]bool{}
	}
	if v, ok := o.has[a.ID]; ok {
		return v
	}
	v := len(o.by[a.ID]) > 0 || (o.keepEmpty && o.begin[a.ID] != 0)
	for _, ch := range a.Children {
		if o.active(ch) {
			v = true
		}
	}
	o.has[a.ID] = v
	return v
}

func (o *finBlocks) hook(l *finLayout, roots []*finAcct, level int, group string) (finVals, []int64) {
	total := finVals{}
	var ids []int64
	for _, a := range roots {
		ids = append(ids, a.subtreeIDs()...)
		if o.active(a) {
			total.add(o.block(l, a, level, a.rootLabel()), 1)
		}
	}
	return total, ids
}

func (o *finBlocks) block(l *finLayout, a *finAcct, level int, label string) finVals {
	g := l.c.group()
	bal := o.begin[a.ID]
	sec := l.add("section", level, label, nil, nil, g)
	if o.begin != nil {
		sec.Cells["balance"] = store.Dollars(bal)
	}
	sign := finSign(a.Type)
	tot := finVals{}
	list := o.by[a.ID]
	for i := range list {
		e := &list[i]
		nat := e.Amount * sign
		bal += nat
		l.entryRow(e, level+1, g, nat, bal)
		tot["amount"] += nat
		if e.Amount > 0 {
			tot["debit"] += e.Amount
		} else {
			tot["credit"] -= e.Amount
		}
	}
	tot["balance"] = bal
	for _, ch := range a.Children {
		if o.active(ch) {
			tot.add(o.block(l, ch, level+1, ch.Label), 1)
		}
	}
	l.add("subtotal", level, "Total "+label, tot, nil, g)
	return tot
}

// ---------------------------------------------------------------------------

func finProfitLossDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.plEntries(p.From, p.To)
	if err != nil {
		return nil, err
	}
	l := c.layout(finDetailCols("type", "date", "num", "name", "memo", "class", "clr", "split", "amount", "balance"), nil)
	o := &finBlocks{by: finByAccount(es)}
	l.acctsHook = o.hook
	l.profitLoss()
	return finDetailResult(ctx, q, p, "Profit and Loss Detail", false, true, l), nil
}

func finTxnDetailByAccount(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.entries(p.From, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.filter(), es)
	// plTo (drill-down of Retained Earnings): income and expenses only up to that date
	if plTo := c.p.Str("plTo"); plTo != "" {
		kept := es[:0:0]
		for _, e := range es {
			if a := c.accts[e.AccountID]; a != nil && model.IsProfitLoss(a.Type) && e.Date > plTo {
				continue
			}
			kept = append(kept, e)
		}
		es = kept
	}
	l := c.layout(finCustomCols(p, []string{"type", "date", "num", "name", "memo", "class", "clr", "split", "amount", "balance"}), nil)
	o := &finBlocks{by: finByAccount(es)}
	total, _ := o.hook(l, c.roots, 0, "")
	if side := c.p.Str("netTotal"); side == "credit" || side == "debit" {
		// a drill-down of a net amount (Retained Earnings, Total Equity): the
		// TOTAL is the net of every entry on that side
		var net int64
		for _, e := range es {
			net += e.Amount
		}
		if side == "credit" {
			net = -net
		}
		r := l.add("grandtotal", 0, "TOTAL", finVals{"debit": total["debit"], "credit": total["credit"], "amount": net}, nil, "")
		delete(r.Cells, "balance")
	} else {
		finGrandTotal(c, l, o.by, total)
	}
	return finDetailResult(ctx, q, p, "Transaction Detail by Account", false, true, l), nil
}

// finGrandTotal adds the TOTAL row of an account-grouped detail report. The
// amount total is only meaningful when every account has the same normal side.
func finGrandTotal(c *finCtx, l *finLayout, by map[int64][]finEntry, total finVals) {
	sides := map[int64]bool{}
	for id := range by {
		if a := c.accts[id]; a != nil {
			sides[finSign(a.Type)] = true
		}
	}
	v := finVals{"debit": total["debit"], "credit": total["credit"]}
	if len(sides) == 1 {
		v["amount"] = total["amount"]
		v["balance"] = total["balance"]
	}
	r := l.add("grandtotal", 0, "TOTAL", v, nil, "")
	if len(sides) != 1 {
		delete(r.Cells, "amount")
		delete(r.Cells, "balance")
	}
}

// glBegin returns natural beginning balances before from: balance sheet
// accounts from the beginning, profit & loss accounts from the fiscal year
// start, Retained Earnings including prior years' net income (as of fysRef's
// fiscal year). Also returns the entries dated in [from, to].
func (c *finCtx) glBegin(from, to, fysRef string, cash bool) (map[int64]int64, []finEntry, error) {
	all, err := c.entries("", to, cash)
	if err != nil {
		return nil, nil, err
	}
	begin := map[int64]int64{}
	fysFrom := FiscalYearStart(from, c.p.FiscalYearStartMonth)
	fys := ""
	if fysRef != "" {
		fys = FiscalYearStart(fysRef, c.p.FiscalYearStartMonth)
	}
	var in []finEntry
	var priorNI int64 // raw sum of P&L entries before fys
	for _, e := range all {
		a := c.accts[e.AccountID]
		if a == nil {
			continue
		}
		pl := model.IsProfitLoss(a.Type)
		if pl && e.Date < fys {
			priorNI += e.Amount
		}
		if from == "" || e.Date >= from {
			in = append(in, e)
			continue
		}
		if pl && e.Date < fysFrom {
			continue
		}
		begin[a.ID] += e.Amount * finSign(a.Type)
	}
	if c.reID != 0 && priorNI != 0 {
		begin[c.reID] -= priorNI
	}
	return begin, in, nil
}

func finGeneralLedger(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	begin, es, err := c.glBegin(p.From, p.To, p.From, p.IsCash())
	if err != nil {
		return nil, err
	}
	f := c.filter()
	es = c.apply(f, es)
	if f.accts != nil {
		for id := range begin {
			if !f.accts[id] {
				delete(begin, id)
			}
		}
	}
	l := c.layout(finCustomCols(p, []string{"type", "date", "num", "name", "memo", "split", "debit", "credit", "balance"}), nil)
	o := &finBlocks{by: finByAccount(es), begin: begin, keepEmpty: true}
	total, _ := o.hook(l, c.roots, 0, "")
	r := l.add("grandtotal", 0, "TOTAL", finVals{"debit": total["debit"], "credit": total["credit"]}, nil, "")
	delete(r.Cells, "balance")
	delete(r.Cells, "amount")
	return finDetailResult(ctx, q, p, "General Ledger", false, true, l), nil
}

func finAccountActivity(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	id := p.ID("accountId")
	if id == 0 && len(p.Filters.AccountIDs) == 1 {
		id = p.Filters.AccountIDs[0]
	}
	a := c.accts[id]
	if a == nil {
		return nil, apperr.Validation("accountId", "Select an account for the Account Activity report.")
	}
	begin, es, err := c.glBegin(p.From, p.To, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	ids := finSet(a.subtreeIDs())
	pf := p.Filters
	pf.AccountIDs = nil
	saved := p.Filters
	p.Filters = pf
	f := c.filter()
	p.Filters = saved
	var in []finEntry
	for i := range es {
		if ids[es[i].AccountID] && c.match(f, &es[i]) {
			in = append(in, es[i])
		}
	}
	for k := range begin {
		if !ids[k] || model.IsProfitLoss(c.accts[k].Type) {
			delete(begin, k)
		}
	}
	l := c.layout(finDetailCols("type", "date", "num", "name", "memo", "clr", "split", "amount", "balance"), nil)
	o := &finBlocks{by: finByAccount(in), begin: begin, keepEmpty: true}
	if model.IsProfitLoss(a.Type) {
		o.begin = nil // income and expense accounts start at zero
	}
	label := a.Full
	if !o.active(a) {
		r := l.add("section", 0, label, nil, nil, "")
		if o.begin != nil {
			r.Cells["balance"] = store.Dollars(begin[a.ID])
		}
		l.add("subtotal", 0, "Total "+label, finVals{"amount": 0, "balance": o.begin[a.ID]}, nil, "")
	} else {
		o.block(l, a, 0, label)
	}
	res := finDetailResult(ctx, q, p, "Account Activity", false, true, l)
	return res, nil
}

func finBalanceSheetDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	begin, es, err := c.glBegin(p.From, p.To, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	fys := FiscalYearStart(p.To, p.FiscalYearStartMonth)
	// Net Income row: ending balance = fiscal year to date; amount = the
	// part dated within the report range. P&L entries before the fiscal
	// year start are already in the Retained Earnings beginning balance.
	var niYTD, niRange int64
	by := map[int64][]finEntry{}
	for _, e := range es {
		a := c.accts[e.AccountID]
		if a == nil {
			continue
		}
		if model.IsProfitLoss(a.Type) {
			if e.Date >= fys {
				niRange -= e.Amount
			}
			continue
		}
		by[a.ID] = append(by[a.ID], e)
	}
	for id, v := range begin {
		a := c.accts[id]
		if a == nil || !model.IsProfitLoss(a.Type) {
			continue
		}
		if p.From >= fys {
			niYTD -= v * finSign(a.Type)
		}
		delete(begin, id)
	}
	niYTD += niRange
	reSynth := finVals{}
	if c.reID == 0 {
		var prior int64
		all, err := c.entries("", finAddDays(fys, -1), p.IsCash())
		if err != nil {
			return nil, err
		}
		for _, e := range all {
			if a := c.accts[e.AccountID]; a != nil && model.IsProfitLoss(a.Type) {
				prior -= e.Amount
			}
		}
		if prior != 0 {
			reSynth = finVals{"balance": prior}
		}
	}
	l := c.layout(finDetailCols("type", "date", "num", "name", "memo", "class", "clr", "split", "amount", "balance"), nil)
	o := &finBlocks{by: by, begin: begin, keepEmpty: true}
	l.acctsHook = o.hook
	ni := finVals{"amount": niRange, "balance": niYTD}
	l.balanceSheet(finEquityExtra{re: reSynth, ni: ni, niRow: func(l *finLayout, level int, group string) {
		if niRange == 0 && niYTD == 0 {
			return
		}
		l.add("data", level, "Net Income", ni, nil, group)
	}})
	return finDetailResult(ctx, q, p, "Balance Sheet Detail", false, true, l), nil
}

// ---------------------------------------------------------------------------
// Custom Transaction Detail Report

func finCustomTxnDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.entries(p.From, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.filter(), es)
	l := c.layout(finCustomCols(p, []string{"type", "date", "num", "name", "memo", "account", "class", "clr", "split", "amount", "balance"}), nil)
	totalBy := p.Str("totalBy")
	if totalBy == "" {
		totalBy = "account"
	}
	nat := func(e *finEntry) int64 {
		if a := c.accts[e.AccountID]; a != nil {
			return e.Amount * finSign(a.Type)
		}
		return e.Amount
	}
	switch totalBy {
	case "account":
		o := &finBlocks{by: finByAccount(es)}
		total, _ := o.hook(l, c.roots, 0, "")
		finGrandTotal(c, l, o.by, total)
	case "name", "class", "type", "item":
		keyOf := func(e *finEntry) (string, string) {
			t := c.txns[e.TxnID]
			switch totalBy {
			case "name":
				id := e.NameID
				if id == 0 && t != nil {
					id = t.NameID
				}
				if n := c.names[id]; n != nil {
					return n.Full, n.Full
				}
				return "~", "No name"
			case "class":
				if n := c.classes[e.ClassID]; n != nil {
					return n.Full, n.Full
				}
				return "~", "No Class"
			case "item":
				if n := c.items[e.ItemID]; n != nil {
					return n.Full, n.Full
				}
				return "~", "No item"
			}
			lbl := c.typeLabel(t)
			return lbl, lbl
		}
		groups := map[string][]finEntry{}
		labels := map[string]string{}
		var keys []string
		for _, e := range es {
			k, lbl := keyOf(&e)
			if _, ok := groups[k]; !ok {
				keys = append(keys, k)
				labels[k] = lbl
			}
			groups[k] = append(groups[k], e)
		}
		sort.Strings(keys)
		grand := finVals{}
		for _, k := range keys {
			g := c.group()
			l.add("section", 0, labels[k], nil, nil, g)
			tot := finVals{}
			for i := range groups[k] {
				e := &groups[k][i]
				tot["amount"] += nat(e)
				if e.Amount > 0 {
					tot["debit"] += e.Amount
				} else {
					tot["credit"] -= e.Amount
				}
				l.entryRow(e, 1, g, nat(e), tot["amount"])
			}
			tot["balance"] = tot["amount"]
			grand.add(tot, 1)
			l.add("subtotal", 0, "Total "+labels[k], tot, nil, g)
		}
		l.add("grandtotal", 0, "TOTAL", grand, nil, "")
	default:
		var bal, dr, cr int64
		for i := range es {
			e := &es[i]
			bal += nat(e)
			if e.Amount > 0 {
				dr += e.Amount
			} else {
				cr -= e.Amount
			}
			l.entryRow(e, 0, "", nat(e), bal)
		}
		l.add("grandtotal", 0, "TOTAL", finVals{"amount": bal, "balance": bal, "debit": dr, "credit": cr}, nil, "")
	}
	return finDetailResult(ctx, q, p, "Custom Transaction Detail Report", false, true, l), nil
}

// ---------------------------------------------------------------------------
// Income by Customer Detail / Expenses by Vendor Detail

func finEntityDetail(ctx context.Context, q store.Q, p *Params, title, kind string,
	keep func(a *finAcct) bool, value func(c *finCtx, e *finEntry) (int64, int64)) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.entries(p.From, p.To, p.IsCash())
	if err != nil {
		return nil, err
	}
	es = c.apply(c.filter(), es)
	type row struct {
		e   finEntry
		amt int64
	}
	rowsBy := map[int64][]row{}
	for i := range es {
		e := &es[i]
		a := c.accts[e.AccountID]
		if a == nil || !keep(a) {
			continue
		}
		id, v := value(c, e)
		if id == 0 {
			continue
		}
		rowsBy[id] = append(rowsBy[id], row{*e, v})
	}
	l := c.layout(finDetailCols("type", "date", "num", "memo", "account", "clr", "split", "amount", "balance"), nil)
	var has func(n *finNode) bool
	has = func(n *finNode) bool {
		if len(rowsBy[n.ID]) > 0 {
			return true
		}
		for _, ch := range n.Children {
			if has(ch) {
				return true
			}
		}
		return false
	}
	var block func(n *finNode, level int) int64
	block = func(n *finNode, level int) int64 {
		g := c.group()
		l.add("section", level, n.Name, nil, nil, g)
		var bal int64
		for i := range rowsBy[n.ID] {
			r := &rowsBy[n.ID][i]
			bal += r.amt
			l.entryRow(&r.e, level+1, g, r.amt, bal)
		}
		tot := bal
		for _, ch := range n.Children {
			if has(ch) {
				tot += block(ch, level+1)
			}
		}
		l.add("subtotal", level, "Total "+n.Name, finVals{"amount": tot, "balance": tot}, nil, g)
		return tot
	}
	var grand int64
	for _, n := range c.nameRoots {
		if n.Kind == kind && has(n) {
			grand += block(n, 0)
		}
	}
	l.add("grandtotal", 0, "TOTAL", finVals{"amount": grand, "balance": grand}, nil, "")
	return finDetailResult(ctx, q, p, title, false, true, l), nil
}

func finIncomeByCustomerDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finEntityDetail(ctx, q, p, "Income by Customer Detail", model.NameCustomer,
		func(a *finAcct) bool { return model.IsProfitLoss(a.Type) },
		func(c *finCtx, e *finEntry) (int64, int64) { return c.customerOf(e), -e.Amount })
}

func finExpensesByVendorDetail(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	return finEntityDetail(ctx, q, p, "Expenses by Vendor Detail", model.NameVendor, finIsExpense,
		func(c *finCtx, e *finEntry) (int64, int64) { return c.vendorOf(e), e.Amount })
}

// ---------------------------------------------------------------------------
// Journal

func finJournal(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	txnID := p.ID("txnId")
	var es []finEntry
	if txnID > 0 {
		t := c.txns[txnID]
		if t == nil {
			return nil, apperr.NotFound("Transaction %d not found", txnID)
		}
		rows, err := q.QueryContext(ctx, finEntrySel+` WHERE g.txn_id = ? ORDER BY g.seq, g.id`, txnID)
		if err != nil {
			return nil, err
		}
		if es, err = finScan(rows); err != nil {
			return nil, err
		}
		p.From, p.To = t.Date, t.Date
	} else {
		if es, err = c.entries(p.From, p.To, false); err != nil {
			return nil, err
		}
	}
	f := c.filter()
	byTxn := map[int64][]finEntry{}
	keep := map[int64]bool{}
	var order []int64
	for i := range es {
		e := &es[i]
		if _, ok := byTxn[e.TxnID]; !ok {
			order = append(order, e.TxnID)
		}
		byTxn[e.TxnID] = append(byTxn[e.TxnID], *e)
		if txnID > 0 || c.match(f, e) {
			keep[e.TxnID] = true
		}
	}
	// voided transactions have no entries but are listed with zero amounts
	for _, t := range c.txns {
		if !t.Voided || model.IsNonPosting(t.Type) || len(byTxn[t.ID]) > 0 {
			continue
		}
		if txnID > 0 && t.ID != txnID {
			continue
		}
		if txnID == 0 && (t.Date > p.To || (p.From != "" && t.Date < p.From) || !c.txnOK(f, t, t.Memo) ||
			f.accts != nil || f.classes != nil || f.items != nil || (f.names != nil && !f.names[t.NameID])) {
			continue
		}
		order = append(order, t.ID)
		keep[t.ID] = true
		byTxn[t.ID] = []finEntry{{TxnID: t.ID, Date: t.Date, AccountID: t.AccountID, NameID: t.NameID, Memo: t.Memo}}
	}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := c.txns[order[i]], c.txns[order[j]]
		if a == nil || b == nil {
			return order[i] < order[j]
		}
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		return a.ID < b.ID
	})
	l := c.layout(finDetailCols("trans", "type", "date", "num", "name", "memo", "account", "debit", "credit"), nil)
	var dr, cr int64
	for _, id := range order {
		if !keep[id] {
			continue
		}
		g := c.group()
		var tdr, tcr int64
		list := byTxn[id]
		for i := range list {
			e := &list[i]
			l.entryRow(e, 0, g, 0, 0)
			r := &l.rows[len(l.rows)-1]
			if i > 0 {
				r.Cells["trans"], r.Cells["type"], r.Cells["date"], r.Cells["num"] = "", "", nil, ""
			}
			if e.ID == 0 { // voided
				r.Cells["debit"], r.Cells["credit"] = 0.0, nil
			}
			if e.Amount > 0 {
				tdr += e.Amount
			} else {
				tcr -= e.Amount
			}
		}
		l.add("subtotal", 0, "", finVals{"debit": tdr, "credit": tcr}, nil, g)
		dr += tdr
		cr += tcr
	}
	l.add("grandtotal", 0, "TOTAL", finVals{"debit": dr, "credit": cr}, nil, "")
	title := "Journal"
	if txnID > 0 {
		title = "Transaction Journal"
	}
	return finDetailResult(ctx, q, p, title, false, false, l), nil
}

// ---------------------------------------------------------------------------
// Transaction List by Date

func finTxnListByDate(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error) {
	c, err := finNew(ctx, q, p)
	if err != nil {
		return nil, err
	}
	es, err := c.entries(p.From, p.To, false)
	if err != nil {
		return nil, err
	}
	byTxn := map[int64][]finEntry{}
	for _, e := range es {
		byTxn[e.TxnID] = append(byTxn[e.TxnID], e)
	}
	f := c.filter()
	var list []*finTxn
	for _, t := range c.txns {
		if t.Date > p.To || (p.From != "" && t.Date < p.From) {
			continue
		}
		list = append(list, t)
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].Date != list[j].Date {
			return list[i].Date < list[j].Date
		}
		return list[i].ID < list[j].ID
	})
	l := c.layout(finCustomCols(p, []string{"type", "date", "num", "name", "memo", "account", "clr", "split", "amount"}), nil)
	for _, t := range list {
		ents := byTxn[t.ID]
		if !c.txnOK(f, t, t.Memo) {
			continue
		}
		anyOK := func(test func(e *finEntry) bool) bool {
			for i := range ents {
				if test(&ents[i]) {
					return true
				}
			}
			return false
		}
		if f.accts != nil && !anyOK(func(e *finEntry) bool { return f.accts[e.AccountID] }) {
			continue
		}
		if f.classes != nil && !anyOK(func(e *finEntry) bool { return f.classes[e.ClassID] }) {
			continue
		}
		if f.items != nil && !anyOK(func(e *finEntry) bool { return f.items[e.ItemID] }) {
			continue
		}
		if f.names != nil && !f.names[t.NameID] && !anyOK(func(e *finEntry) bool { return f.names[e.NameID] }) {
			continue
		}
		var hdr *finEntry
		for i := range ents {
			if ents[i].Role == "header" {
				hdr = &ents[i]
				break
			}
		}
		if hdr == nil {
			for i := range ents {
				if ents[i].AccountID == t.AccountID {
					hdr = &ents[i]
					break
				}
			}
		}
		if hdr == nil && len(ents) > 0 {
			hdr = &ents[0]
		}
		clr := ""
		if hdr != nil {
			clr = hdr.Cleared
		}
		if (f.cleared == "cleared" && clr == "") || (f.cleared == "uncleared" && clr != "") || (f.cleared == "reconciled" && clr != "R") {
			continue
		}
		var amount int64
		var e finEntry
		if hdr != nil {
			e = *hdr
			amount = hdr.Amount
			if t.Type == model.TxJournal {
				amount = 0
				for _, x := range ents {
					if x.Amount > 0 {
						amount += x.Amount
					}
				}
			}
		} else {
			e = finEntry{TxnID: t.ID, Date: t.Date, AccountID: t.AccountID, NameID: t.NameID}
			if !t.Voided {
				amount = t.Amount
			}
		}
		e.Memo = t.Memo
		e.NameID = t.NameID
		l.entryRow(&e, 0, "", amount, 0)
		r := &l.rows[len(l.rows)-1]
		if hdr == nil {
			switch t.Type {
			case model.TxEstimate:
				r.Cells["account"] = "Estimates"
			case model.TxPurchaseOrder:
				r.Cells["account"] = "Purchase Orders"
			}
			if _, ok := r.Cells["split"]; ok {
				r.Cells["split"] = ""
			}
		}
	}
	return finDetailResult(ctx, q, p, "Transaction List by Date", false, false, l), nil
}
