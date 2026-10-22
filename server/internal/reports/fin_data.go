package reports

// Shared data layer of the financial / accountant / budget reports (fin_*.go):
// chart of accounts tree, names/classes/items trees, transactions, general
// ledger entries (accrual or cash basis), filters, labels and drill helpers.

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"seriex/internal/model"
	"seriex/internal/store"
)

// finAcct is one account with its report display data.
type finAcct struct {
	ID       int64
	Name     string
	Number   string
	Type     string
	ParentID int64
	Special  string
	Desc     string
	Active   bool
	Label    string     // label at its own level ("number · name")
	Full     string     // label with its parents ("Utilities:Telephone")
	Children []*finAcct // subaccounts of the same type, in order
	Orphan   bool       // subaccount shown as a root (parent of another type)
}

// finNode is a name (customer/job, vendor, other), class or item.
type finNode struct {
	ID       int64
	Kind     string // names: kind; items: type
	Name     string
	ParentID int64
	Full     string
	Active   bool
	Children []*finNode
}

type finTxn struct {
	ID        int64
	Type      string
	Ref       string
	Date      string
	NameID    int64
	AccountID int64
	ArApID    int64
	ToAcctID  int64
	Amount    int64
	Memo      string
	Voided    bool
	Pending   bool
	DueDate   string
	CreatedBy string
	CreatedAt string
	UpdatedAt string
}

// finEntry is one general ledger entry (debit +, credit -).
type finEntry struct {
	ID        int64
	TxnID     int64
	LineID    int64
	Seq       int
	Date      string
	AccountID int64
	Amount    int64
	NameID    int64
	ClassID   int64
	ItemID    int64
	Memo      string
	Role      string
	Cleared   string
	// Src is, for an entry recognized on the cash basis, the payment or
	// credit that recognized it (0 for ordinary entries)
	Src int64
}

type finTA struct {
	acct int64
	role string
}

// finCtx holds everything a financial report needs for one run.
type finCtx struct {
	ctx        context.Context
	q          store.Q
	p          *Params
	accts      map[int64]*finAcct
	order      []*finAcct // chart of accounts order (parents before children)
	roots      []*finAcct
	names      map[int64]*finNode
	nameRoots  []*finNode
	classes    map[int64]*finNode
	classRoots []*finNode
	items      map[int64]*finNode
	itemRoots  []*finNode
	txns       map[int64]*finTxn
	reID       int64
	gseq       int
	txnAccts   map[int64][]finTA
}

// finARTypes are the transactions that post to A/R or A/P and are
// recognized when paid on the cash basis.
var finARTypes = map[string]bool{
	model.TxInvoice: true, model.TxStatementCharge: true, model.TxCreditMemo: true,
	model.TxBill: true, model.TxVendorCredit: true, model.TxItemReceipt: true,
}

const finARList = `'INV','STMTCHG','CREDMEM','BILL','BILLCRED','ITEMRCPT'`

func finNew(ctx context.Context, q store.Q, p *Params) (*finCtx, error) {
	c := &finCtx{ctx: ctx, q: q, p: p}
	if err := c.loadAccounts(); err != nil {
		return nil, err
	}
	var err error
	if c.names, c.nameRoots, err = c.loadTree(`SELECT id, kind, name, IFNULL(parent_id,0), active FROM names`); err != nil {
		return nil, err
	}
	if c.classes, c.classRoots, err = c.loadTree(`SELECT id, '', name, IFNULL(parent_id,0), active FROM list_entries WHERE list = 'class'`); err != nil {
		return nil, err
	}
	if c.items, c.itemRoots, err = c.loadTree(`SELECT id, type, name, IFNULL(parent_id,0), active FROM items`); err != nil {
		return nil, err
	}
	if err := c.loadTxns(); err != nil {
		return nil, err
	}
	return c, nil
}

func finNumLess(a, b string) bool {
	if a == "" || b == "" {
		return b == "" && a != ""
	}
	fa, ea := strconv.ParseFloat(a, 64)
	fb, eb := strconv.ParseFloat(b, 64)
	if ea == nil && eb == nil && fa != fb {
		return fa < fb
	}
	return a < b
}

func (c *finCtx) acctLess(a, b *finAcct) bool {
	ra, rb := model.AccountTypeRank(a.Type), model.AccountTypeRank(b.Type)
	if ra != rb {
		return ra < rb
	}
	if c.p.Prefs.UseAccountNumbers && a.Number != b.Number {
		return finNumLess(a.Number, b.Number)
	}
	la, lb := strings.ToLower(a.Name), strings.ToLower(b.Name)
	if la != lb {
		return la < lb
	}
	return a.ID < b.ID
}

func (c *finCtx) loadAccounts() error {
	rows, err := c.q.QueryContext(c.ctx, `SELECT id, name, number, type, IFNULL(parent_id,0), special, description, active FROM accounts`)
	if err != nil {
		return err
	}
	defer rows.Close()
	c.accts = map[int64]*finAcct{}
	for rows.Next() {
		a := &finAcct{}
		var active int
		if err := rows.Scan(&a.ID, &a.Name, &a.Number, &a.Type, &a.ParentID, &a.Special, &a.Desc, &active); err != nil {
			return err
		}
		a.Active = active != 0
		c.accts[a.ID] = a
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, a := range c.accts {
		a.Label = c.ownLabel(a)
		if a.Special == store.SpecialRetainedEarnings && (c.reID == 0 || a.ID < c.reID) {
			c.reID = a.ID
		}
	}
	for _, a := range c.accts {
		a.Full = c.fullLabel(a, 0)
		par := c.accts[a.ParentID]
		if par != nil && par.Type == a.Type && par.ID != a.ID {
			par.Children = append(par.Children, a)
		} else {
			a.Orphan = par != nil
			c.roots = append(c.roots, a)
		}
	}
	sort.Slice(c.roots, func(i, j int) bool { return c.acctLess(c.roots[i], c.roots[j]) })
	var walk func(list []*finAcct)
	walk = func(list []*finAcct) {
		for _, a := range list {
			sort.Slice(a.Children, func(i, j int) bool { return c.acctLess(a.Children[i], a.Children[j]) })
			c.order = append(c.order, a)
			walk(a.Children)
		}
	}
	walk(c.roots)
	return nil
}

func (c *finCtx) ownLabel(a *finAcct) string {
	name := a.Name
	switch c.p.Prefs.ReportAccountDisplay {
	case "description":
		if a.Desc != "" {
			name = a.Desc
		}
	case "both":
		if a.Desc != "" {
			name = a.Name + " (" + a.Desc + ")"
		}
	}
	if c.p.Prefs.UseAccountNumbers && a.Number != "" {
		return a.Number + " · " + name
	}
	return name
}

func (c *finCtx) fullLabel(a *finAcct, depth int) string {
	par := c.accts[a.ParentID]
	if par == nil || depth > 20 {
		return a.Label
	}
	return c.fullLabel(par, depth+1) + ":" + a.Label
}

// rootLabel is the label of an account shown at the top of its section.
func (a *finAcct) rootLabel() string {
	if a.Orphan {
		return a.Full
	}
	return a.Label
}

// typeRoots returns the top-level accounts of the given types, in order.
func (c *finCtx) typeRoots(types ...string) []*finAcct {
	var out []*finAcct
	for _, a := range c.roots {
		for _, t := range types {
			if a.Type == t {
				out = append(out, a)
				break
			}
		}
	}
	return out
}

// subtreeIDs returns the account and all its same-type subaccounts.
func (a *finAcct) subtreeIDs() []int64 {
	out := []int64{a.ID}
	for _, ch := range a.Children {
		out = append(out, ch.subtreeIDs()...)
	}
	return out
}

func (c *finCtx) acctName(id int64) string {
	if a := c.accts[id]; a != nil {
		return a.Full
	}
	return ""
}

func (c *finCtx) loadTree(query string) (map[int64]*finNode, []*finNode, error) {
	rows, err := c.q.QueryContext(c.ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	m := map[int64]*finNode{}
	for rows.Next() {
		n := &finNode{}
		var active int
		if err := rows.Scan(&n.ID, &n.Kind, &n.Name, &n.ParentID, &active); err != nil {
			return nil, nil, err
		}
		n.Active = active != 0
		m[n.ID] = n
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var roots []*finNode
	for _, n := range m {
		par := m[n.ParentID]
		if par != nil && par.ID != n.ID {
			par.Children = append(par.Children, n)
		} else {
			roots = append(roots, n)
		}
	}
	less := func(list []*finNode) {
		sort.Slice(list, func(i, j int) bool {
			a, b := strings.ToLower(list[i].Name), strings.ToLower(list[j].Name)
			if a != b {
				return a < b
			}
			return list[i].ID < list[j].ID
		})
	}
	var walk func(list []*finNode, prefix string, depth int)
	walk = func(list []*finNode, prefix string, depth int) {
		less(list)
		for _, n := range list {
			n.Full = prefix + n.Name
			if depth < 20 {
				walk(n.Children, n.Full+":", depth+1)
			}
		}
	}
	walk(roots, "", 0)
	return m, roots, nil
}

// subtree returns the node and all its descendants in tree order.
func (n *finNode) subtree() []*finNode {
	out := []*finNode{n}
	for _, ch := range n.Children {
		out = append(out, ch.subtree()...)
	}
	return out
}

func (c *finCtx) loadTxns() error {
	rows, err := c.q.QueryContext(c.ctx, `SELECT id, type, ref_number, date, IFNULL(name_id,0), IFNULL(account_id,0),
		IFNULL(ar_ap_account_id,0), IFNULL(to_account_id,0), amount, memo, voided, is_pending, due_date,
		created_by, created_at, updated_at FROM txns`)
	if err != nil {
		return err
	}
	defer rows.Close()
	c.txns = map[int64]*finTxn{}
	for rows.Next() {
		t := &finTxn{}
		var voided, pending int
		if err := rows.Scan(&t.ID, &t.Type, &t.Ref, &t.Date, &t.NameID, &t.AccountID, &t.ArApID, &t.ToAcctID,
			&t.Amount, &t.Memo, &voided, &pending, &t.DueDate, &t.CreatedBy, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return err
		}
		t.Voided, t.Pending = voided != 0, pending != 0
		c.txns[t.ID] = t
	}
	return rows.Err()
}

func (c *finCtx) nameFull(id int64) string {
	if n := c.names[id]; n != nil {
		return n.Full
	}
	return ""
}

func (c *finCtx) className(id int64) string {
	if n := c.classes[id]; n != nil {
		return n.Full
	}
	return ""
}

func (c *finCtx) isKind(id int64, kind string) bool {
	n := c.names[id]
	return n != nil && n.Kind == kind
}

// customerOf attributes an entry to a customer:job (the line's name, else the transaction's).
func (c *finCtx) customerOf(e *finEntry) int64 {
	if c.isKind(e.NameID, model.NameCustomer) {
		return e.NameID
	}
	if t := c.txns[e.TxnID]; t != nil && c.isKind(t.NameID, model.NameCustomer) {
		return t.NameID
	}
	return 0
}

// vendorOf attributes an entry to a vendor (the payee of the transaction, else the line's name).
func (c *finCtx) vendorOf(e *finEntry) int64 {
	if t := c.txns[e.TxnID]; t != nil && c.isKind(t.NameID, model.NameVendor) {
		return t.NameID
	}
	if c.isKind(e.NameID, model.NameVendor) {
		return e.NameID
	}
	return 0
}

// typeLabel is the report "Type" column text of a transaction.
func (c *finCtx) typeLabel(t *finTxn) string {
	if t == nil {
		return ""
	}
	if t.Type == model.TxBillPayment {
		if a := c.accts[t.AccountID]; a != nil && a.Type == model.AcctCreditCard {
			return "Bill Pmt -CCard"
		}
	}
	if l, ok := model.TxnTypeLabels[t.Type]; ok {
		return l
	}
	return t.Type
}

// ---------------------------------------------------------------------------
// General ledger entries

const finEntrySel = `SELECT g.id, g.txn_id, IFNULL(g.line_id,0), g.seq, g.date, g.account_id, g.amount,
	IFNULL(g.name_id,0), IFNULL(g.class_id,0), IFNULL(g.item_id,0), g.memo, g.role, g.cleared FROM gl_entries g`

func finScan(rows *sql.Rows) ([]finEntry, error) {
	defer rows.Close()
	var out []finEntry
	for rows.Next() {
		var e finEntry
		if err := rows.Scan(&e.ID, &e.TxnID, &e.LineID, &e.Seq, &e.Date, &e.AccountID, &e.Amount,
			&e.NameID, &e.ClassID, &e.ItemID, &e.Memo, &e.Role, &e.Cleared); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func finSortEntries(es []finEntry) {
	sort.SliceStable(es, func(i, j int) bool {
		a, b := &es[i], &es[j]
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if a.TxnID != b.TxnID {
			return a.TxnID < b.TxnID
		}
		if a.Seq != b.Seq {
			return a.Seq < b.Seq
		}
		return a.ID < b.ID
	})
}

// entries returns the ledger entries dated in [from, to] (from "" = from the
// beginning) on the accrual or the cash basis, ordered by date, transaction, seq.
func (c *finCtx) entries(from, to string, cash bool) ([]finEntry, error) {
	lo := from
	if lo == "" {
		lo = "0000-01-01"
	}
	if !cash {
		rows, err := c.q.QueryContext(c.ctx, finEntrySel+` WHERE g.date >= ? AND g.date <= ? ORDER BY g.date, g.txn_id, g.seq, g.id`, lo, to)
		if err != nil {
			return nil, err
		}
		return finScan(rows)
	}
	rows, err := c.q.QueryContext(c.ctx, finEntrySel+` JOIN txns t ON t.id = g.txn_id
		WHERE t.type NOT IN (`+finARList+`) AND g.date >= ? AND g.date <= ?`, lo, to)
	if err != nil {
		return nil, err
	}
	out, err := finScan(rows)
	if err != nil {
		return nil, err
	}
	ev, err := c.cashEvents()
	if err != nil {
		return nil, err
	}
	for _, e := range ev {
		if e.Date >= lo && e.Date <= to {
			out = append(out, e)
		}
	}
	finSortEntries(out)
	return out, nil
}

// finShares splits amts in the proportion num/den (cumulative fraction) so the
// parts sum exactly to round(sum(amts) * num / den). num >= den gives amts.
func finShares(amts []int64, num, den int64) []int64 {
	out := make([]int64, len(amts))
	if den <= 0 || num <= 0 {
		return out
	}
	if num >= den {
		copy(out, amts)
		return out
	}
	f := float64(num) / float64(den)
	var sum, total int64
	big := 0
	for i, a := range amts {
		out[i] = int64(math.Round(float64(a) * f))
		sum += out[i]
		total += a
		if finAbs(a) > finAbs(amts[big]) {
			big = i
		}
	}
	if len(amts) > 0 {
		out[big] += int64(math.Round(float64(total)*f)) - sum
	}
	return out
}

func finAbs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// cashEvents converts the entries of A/R and A/P transactions (invoices,
// statement charges, credit memos, bills, vendor credits, item receipts) to
// the cash basis: each payment or credit applied to them (link, dated at the
// paying transaction's date) recognizes the same share of all their entries;
// payment items on an invoice recognize their share on the invoice date. The
// A/R or A/P share recognized with each link offsets the A/R or A/P side of
// the payment, so every event is balanced and A/R / A/P keep only unapplied
// amounts (and journal entries).
func (c *finCtx) cashEvents() ([]finEntry, error) {
	rows, err := c.q.QueryContext(c.ctx, finEntrySel+` JOIN txns t ON t.id = g.txn_id
		WHERE t.type IN (`+finARList+`) ORDER BY g.txn_id, g.seq, g.id`)
	if err != nil {
		return nil, err
	}
	all, err := finScan(rows)
	if err != nil {
		return nil, err
	}
	byTxn := map[int64][]finEntry{}
	var ids []int64
	for _, e := range all {
		if _, ok := byTxn[e.TxnID]; !ok {
			ids = append(ids, e.TxnID)
		}
		byTxn[e.TxnID] = append(byTxn[e.TxnID], e)
	}
	type event struct {
		date string
		numO int64
		numA int64
		pay  bool
		src  int64 // the paying (or credit) transaction
	}
	evs := map[int64][]event{}
	lrows, err := c.q.QueryContext(c.ctx, `SELECT from_txn_id, to_txn_id, amount, discount, date FROM txn_links ORDER BY date, id`)
	if err != nil {
		return nil, err
	}
	defer lrows.Close()
	for lrows.Next() {
		var from, to, amt, disc int64
		var date string
		if err := lrows.Scan(&from, &to, &amt, &disc, &date); err != nil {
			return nil, err
		}
		if t := c.txns[to]; t != nil && finARTypes[t.Type] {
			evs[to] = append(evs[to], event{date: date, numO: amt + disc, numA: amt + disc, src: from})
		}
		if t := c.txns[from]; t != nil && finARTypes[t.Type] {
			evs[from] = append(evs[from], event{date: date, numO: amt, numA: amt, src: to})
		}
	}
	if err := lrows.Err(); err != nil {
		return nil, err
	}
	var out []finEntry
	for _, id := range ids {
		es := byTxn[id]
		t := c.txns[id]
		var A, P, O []finEntry
		var sumA, sumP, sumO int64
		for _, e := range es {
			a := c.accts[e.AccountID]
			switch {
			case a != nil && (a.Type == model.AcctAR || a.Type == model.AcctAP):
				A = append(A, e)
				sumA += e.Amount
			case e.ItemID != 0 && c.items[e.ItemID] != nil && c.items[e.ItemID].Kind == model.ItemPayment:
				P = append(P, e)
				sumP += e.Amount
			default:
				O = append(O, e)
				sumO += e.Amount
			}
		}
		list := evs[id]
		if len(P) > 0 && t != nil {
			list = append([]event{{date: t.Date, numO: finAbs(sumP), pay: true, src: id}}, list...)
		}
		if len(list) == 0 {
			continue
		}
		sort.SliceStable(list, func(i, j int) bool { return list[i].date < list[j].date })
		amts := func(xs []finEntry) []int64 {
			v := make([]int64, len(xs))
			for i := range xs {
				v[i] = xs[i].Amount
			}
			return v
		}
		aO, aA := amts(O), amts(A)
		baseO, baseA := finAbs(sumO), finAbs(sumA)
		prevO, prevA := make([]int64, len(O)), make([]int64, len(A))
		var cumO, cumA int64
		emit := func(xs []finEntry, cur, prev []int64, date string, src int64) {
			for i := range xs {
				if d := cur[i] - prev[i]; d != 0 {
					e := xs[i]
					e.Amount = d
					e.Date = date
					e.Src = src
					out = append(out, e)
				}
			}
		}
		for _, ev := range list {
			cumO += ev.numO
			cumA += ev.numA
			curO := finShares(aO, cumO, baseO)
			curA := finShares(aA, cumA, baseA)
			emit(O, curO, prevO, ev.date, ev.src)
			emit(A, curA, prevA, ev.date, ev.src)
			if ev.pay {
				for _, e := range P {
					e.Date = ev.date
					e.Src = ev.src
					out = append(out, e)
				}
			}
			prevO, prevA = curO, curA
		}
	}
	return out, nil
}

// split returns the "Split" column of an entry: the other account of the
// transaction, the header account for detail lines, or "-SPLIT-".
func (c *finCtx) split(e *finEntry) string {
	if c.txnAccts == nil {
		c.txnAccts = map[int64][]finTA{}
		rows, err := c.q.QueryContext(c.ctx, `SELECT txn_id, account_id, role FROM gl_entries ORDER BY txn_id, seq, id`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var tid int64
				var ta finTA
				if rows.Scan(&tid, &ta.acct, &ta.role) == nil {
					c.txnAccts[tid] = append(c.txnAccts[tid], ta)
				}
			}
		}
	}
	list := c.txnAccts[e.TxnID]
	if e.Role == "discount" {
		// the discount's other side is the A/R or A/P account being paid
		for _, ta := range list {
			if a := c.accts[ta.acct]; a != nil && (a.Type == model.AcctAR || a.Type == model.AcctAP) {
				return a.Full
			}
		}
	}
	if e.Role != "header" {
		var hdr int64
		multi := false
		for _, ta := range list {
			if ta.role == "header" && ta.acct != e.AccountID {
				if hdr != 0 && hdr != ta.acct {
					multi = true
				}
				hdr = ta.acct
			}
		}
		if hdr != 0 && !multi {
			return c.acctName(hdr)
		}
	}
	var other int64
	for _, ta := range list {
		if ta.acct == e.AccountID {
			continue
		}
		if other != 0 && other != ta.acct {
			return "-SPLIT-"
		}
		other = ta.acct
	}
	if other == 0 {
		return ""
	}
	return c.acctName(other)
}

// ---------------------------------------------------------------------------
// Filters

type finFilter struct {
	accts      map[int64]bool
	names      map[int64]bool
	items      map[int64]bool
	classes    map[int64]bool
	types      map[string]bool
	vendors    map[int64]bool
	customers  map[int64]bool
	cleared    string
	amin, amax *int64
	memo, ref  string
	text       string // q: number, memo or name contains
	noClass    bool
	noCustomer bool
	noItem     bool // only entries without an item (Sales Tax Liability: "No Sales Tax Item")
	plOnly     bool
}

func finSet(ids []int64) map[int64]bool {
	if len(ids) == 0 {
		return nil
	}
	m := map[int64]bool{}
	for _, id := range ids {
		m[id] = true
	}
	return m
}

func (c *finCtx) withJobs(ids []int64) map[int64]bool {
	m := finSet(ids)
	if m == nil || !c.p.Filters.IncludeJobs {
		return m
	}
	for _, id := range ids {
		if n := c.names[id]; n != nil {
			for _, d := range n.subtree() {
				m[d.ID] = true
			}
		}
	}
	return m
}

// filter builds the entry filter from the report parameters. Besides the
// standard ones it understands noClass=1 (entries without class), noCustomer=1
// (entries without a customer:job), plOnly=1 (profit & loss accounts only),
// vendorIds / customerIds (attribution as in the vendor/customer reports).
func (c *finCtx) filter() *finFilter {
	pf := c.p.Filters
	if len(pf.ClassIDs) == 0 {
		pf.ClassIDs = c.p.IDs("classId")
	}
	if len(pf.NameIDs) == 0 {
		pf.NameIDs = c.p.IDs("nameId")
	}
	f := &finFilter{
		accts:      finSet(pf.AccountIDs),
		names:      c.withJobs(pf.NameIDs),
		items:      finSet(pf.ItemIDs),
		classes:    finSet(pf.ClassIDs),
		vendors:    finSet(c.p.IDs("vendorIds")),
		customers:  c.withJobs(c.p.IDs("customerIds")),
		cleared:    strings.ToLower(pf.Cleared),
		memo:       strings.ToLower(pf.Memo),
		ref:        strings.ToLower(pf.RefNumber),
		text:       strings.ToLower(pf.Text),
		noClass:    c.p.Bool("noClass"),
		noCustomer: c.p.Bool("noCustomer"),
		noItem:     c.p.Bool("noItem"),
		plOnly:     c.p.Bool("plOnly"),
	}
	if len(pf.Types) > 0 {
		f.types = map[string]bool{}
		for _, t := range pf.Types {
			f.types[t] = true
		}
	}
	if pf.AmountMin != nil {
		v := store.Cents(*pf.AmountMin)
		f.amin = &v
	}
	if pf.AmountMax != nil {
		v := store.Cents(*pf.AmountMax)
		f.amax = &v
	}
	return f
}

// txnOK applies the transaction-level filters (type, amount, number, memo).
func (c *finCtx) txnOK(f *finFilter, t *finTxn, memo string) bool {
	if f.types != nil && (t == nil || !f.types[t.Type]) {
		return false
	}
	if f.amin != nil || f.amax != nil {
		var amt int64
		if t != nil {
			amt = finAbs(t.Amount)
		}
		if f.amin != nil && amt < *f.amin {
			return false
		}
		if f.amax != nil && amt > *f.amax {
			return false
		}
	}
	if f.ref != "" && (t == nil || !strings.Contains(strings.ToLower(t.Ref), f.ref)) {
		return false
	}
	if f.memo != "" {
		tm := ""
		if t != nil {
			tm = t.Memo
		}
		if !strings.Contains(strings.ToLower(memo), f.memo) && !strings.Contains(strings.ToLower(tm), f.memo) {
			return false
		}
	}
	if f.text != "" {
		hit := strings.Contains(strings.ToLower(memo), f.text)
		if t != nil && !hit {
			hit = strings.Contains(strings.ToLower(t.Ref), f.text) ||
				strings.Contains(strings.ToLower(t.Memo), f.text) ||
				(t.NameID != 0 && strings.Contains(strings.ToLower(c.nameFull(t.NameID)), f.text))
		}
		if !hit {
			return false
		}
	}
	return true
}

func (c *finCtx) match(f *finFilter, e *finEntry) bool {
	if f.accts != nil && !f.accts[e.AccountID] {
		return false
	}
	if f.names != nil && !f.names[e.NameID] {
		return false
	}
	if f.items != nil && !f.items[e.ItemID] {
		return false
	}
	if f.classes != nil && !f.classes[e.ClassID] {
		return false
	}
	if f.noClass && e.ClassID != 0 {
		return false
	}
	if f.noItem && e.ItemID != 0 {
		return false
	}
	if f.noCustomer && c.isKind(e.NameID, model.NameCustomer) {
		return false
	}
	if f.plOnly {
		if a := c.accts[e.AccountID]; a == nil || !model.IsProfitLoss(a.Type) {
			return false
		}
	}
	switch f.cleared {
	case "cleared":
		if e.Cleared == "" {
			return false
		}
	case "uncleared":
		if e.Cleared != "" {
			return false
		}
	case "reconciled":
		if e.Cleared != "R" {
			return false
		}
	}
	if f.vendors != nil && !f.vendors[c.vendorOf(e)] {
		return false
	}
	if f.customers != nil && !f.customers[c.customerOf(e)] {
		return false
	}
	return c.txnOK(f, c.txns[e.TxnID], e.Memo)
}

func (c *finCtx) apply(f *finFilter, es []finEntry) []finEntry {
	out := es[:0:0]
	for i := range es {
		if c.match(f, &es[i]) {
			out = append(out, es[i])
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Dates and labels

func finParse(d string) (time.Time, bool) {
	t, err := time.Parse(iso, d)
	return t, err == nil
}

func finAddDays(d string, n int) string { return store.AddDays(d, n) }

// finPrevYear moves a date back one year (Feb 29 becomes Feb 28).
func finPrevYear(d string) string {
	t, ok := finParse(d)
	if !ok {
		return d
	}
	p := time.Date(t.Year()-1, t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	if p.Month() != t.Month() {
		p = time.Date(t.Year()-1, t.Month()+1, 0, 0, 0, 0, 0, time.UTC)
	}
	return p.Format(iso)
}

func finMonthEnd(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC)
}

// finRangeLabel is a short column header for a date range:
// "Oct 26", "Jan - Oct 26", "Oct 1 - 17, 26", "Jan 1 - Oct 17, 26".
func finRangeLabel(from, to string) string {
	if from == "" {
		return "TOTAL"
	}
	f, ok1 := finParse(from)
	t, ok2 := finParse(to)
	if !ok1 || !ok2 {
		return from + " - " + to
	}
	if f.Day() == 1 && finMonthEnd(t).Equal(t) {
		if f.Year() == t.Year() && f.Month() == t.Month() {
			return f.Format("Jan 06")
		}
		if f.Year() == t.Year() {
			return f.Format("Jan") + " - " + t.Format("Jan 06")
		}
		return f.Format("Jan 06") + " - " + t.Format("Jan 06")
	}
	if from == to {
		return f.Format("Jan 2, 06")
	}
	if f.Year() == t.Year() {
		if f.Month() == t.Month() {
			return f.Format("Jan 2") + " - " + t.Format("2, 06")
		}
		return f.Format("Jan 2") + " - " + t.Format("Jan 2, 06")
	}
	return f.Format("Jan 2, 06") + " - " + t.Format("Jan 2, 06")
}

func finAsOfLabel(d string) string {
	if t, ok := finParse(d); ok {
		return t.Format("Jan 2, 06")
	}
	return d
}

// firstDate is the date of the earliest ledger entry ("" when none).
func (c *finCtx) firstDate() string {
	var d sql.NullString
	c.q.QueryRowContext(c.ctx, `SELECT MIN(date) FROM gl_entries`).Scan(&d)
	return d.String
}

func (c *finCtx) group() string {
	c.gseq++
	return "g" + strconv.Itoa(c.gseq)
}

func finJoinIDs(ids []int64) string {
	s := append([]int64(nil), ids...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	parts := make([]string, 0, len(s))
	var last int64 = -1
	for _, id := range s {
		if id == last {
			continue
		}
		last = id
		parts = append(parts, strconv.FormatInt(id, 10))
	}
	return strings.Join(parts, ",")
}

// finCarry are the report parameters passed on to drill-down targets.
var finCarry = []string{"nameIds", "classIds", "itemIds", "types", "includeJobs", "noClass", "noCustomer",
	"cleared", "memo", "refNumber", "amountMin", "amountMax", "vendorIds", "customerIds"}

// drill builds a drill-down target with the report's filters carried over.
// extra values override (an empty value removes the parameter).
//
// When the report is filtered by account, the target keeps only the filtered
// accounts among the amount's accounts (the filtered accounts when the amount
// names none), so its total matches the amount; an amount whose accounts are
// all filtered out has no drill-down.
func (c *finCtx) drill(report, from, to string, accts []int64, extra map[string]string) *model.ReportDrill {
	params := map[string]string{"from": from, "to": to, "basis": c.p.Basis}
	for _, k := range finCarry {
		if v := c.p.Str(k); v != "" {
			params[k] = v
		}
	}
	if fa := c.p.Filters.AccountIDs; len(fa) > 0 && declaresFilters(c.p.Key) {
		if len(accts) == 0 {
			accts = fa
		} else {
			in := finSet(fa)
			var keep []int64
			for _, id := range accts {
				if in[id] {
					keep = append(keep, id)
				}
			}
			if len(keep) == 0 {
				return nil
			}
			accts = keep
		}
	}
	if len(accts) > 0 {
		params["accountIds"] = finJoinIDs(accts)
	}
	for k, v := range extra {
		if v == "" {
			delete(params, k)
		} else {
			params[k] = v
		}
	}
	return &model.ReportDrill{Report: report, Params: params}
}

func finSign(typ string) int64 {
	if model.IsDebitNormal(typ) {
		return 1
	}
	return -1
}

func finDate(d string) any {
	if d == "" {
		return nil
	}
	return d
}

func finClr(s string) string {
	switch s {
	case "R":
		return "√"
	case "*":
		return "*"
	}
	return ""
}

func finTxnPtr(id int64) *int64 {
	if id == 0 {
		return nil
	}
	v := id
	return &v
}
