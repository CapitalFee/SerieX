package ledger

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// stxn is a transaction in storage form: money in cents, optional ids as 0.
type stxn struct {
	ID                                  int64
	Type, Ref, Date                     string
	NameID, AccountID, ArApID, ToAcctID int64
	Amount, OpenBalance, Subtotal       int64
	DueDate, ShipDate                   string
	TermsID, ClassID, RepID, ShipViaID  int64
	CustMsgID, PayMethodID              int64
	FOB, PONumber, Memo                 string
	BillAddress, ShipAddress            string
	TaxItemID                           int64
	TaxRate                             float64
	TaxSplit                            string // JSON []taxMember: the rates used when the tax was computed
	TaxAmount                           int64
	ToBePrinted, ToBeEmailed, IsPending bool
	Status                              string
	Voided                              bool
	CashBackAcctID, CashBackAmount      int64
	CashBackMemo, Template              string
	Extra                               map[string]any
	CreatedBy, CreatedAt, UpdatedAt     string
	Lines                               []sline
	Links                               []slink // links owned by this transaction
}

type sline struct {
	ID                        int64
	Seq                       int
	Kind                      string
	ItemID, AccountID         int64
	Description               string
	Qty, Rate                 *float64
	RateIsPercent             bool
	Amount                    int64
	ClassID, NameID           int64
	Billable                  bool
	BilledTxnID               int64
	Taxable                   bool
	ServiceDate               string
	PayMethodID               int64
	RefNumber                 string
	LinkedTxnID, LinkedLineID int64
	ReceivedQty               float64
	Closed                    bool
	Cogs                      int64
}

// slink is a txn_links row. From == 0 means "the owning transaction" while a
// transaction is being saved.
type slink struct {
	ID, From, To, Owner int64
	Amount, Discount    int64
	DiscAcctID          int64
	Date                string
}

// openingBalance: an opening balance document created by the lists module
// (extra.openingBalance = true). It is never numbered automatically.
func (s *stxn) openingBalance() bool {
	if s.Extra == nil {
		return false
	}
	v, _ := s.Extra["openingBalance"].(bool)
	return v
}

func (s *stxn) valueAdjust() bool {
	if s.Extra == nil {
		return false
	}
	v, _ := s.Extra["valueAdjustment"].(bool)
	return v
}

// ---------------------------------------------------------------------------
// Transaction type groups

func typeIn(t string, types ...string) bool {
	for _, x := range types {
		if x == t {
			return true
		}
	}
	return false
}

// sales-side forms (item lines priced to customers)
func isSalesForm(t string) bool {
	return typeIn(t, model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxEstimate, model.TxStatementCharge)
}

// forms that carry a sales tax item
func isTaxForm(t string) bool {
	return typeIn(t, model.TxInvoice, model.TxSalesReceipt, model.TxCreditMemo, model.TxEstimate)
}

// purchase forms with the Expenses/Items tabs
func isPurchaseForm(t string) bool {
	return typeIn(t, model.TxCheck, model.TxBill, model.TxItemReceipt, model.TxCCCharge, model.TxVendorCredit, model.TxCCCredit)
}

// LineKind returns the kind a line of a txnType transaction has when saved:
// journal and deposit lines by type, on purchase forms an item line when it
// names an item (else an expense line), item lines on every other form.
func LineKind(txnType string, l *model.TxnLine) string {
	switch {
	case txnType == model.TxJournal:
		return model.LineJournal
	case txnType == model.TxDeposit:
		return model.LineDeposit
	case isPurchaseForm(txnType) && (l.ItemID == nil || *l.ItemID == 0):
		return model.LineExpense
	}
	return model.LineItem
}

// purchase forms whose lines can be billable costs / receive purchase orders
func isCostSource(t string) bool {
	return typeIn(t, model.TxCheck, model.TxBill, model.TxItemReceipt, model.TxCCCharge)
}

var knownTypes = map[string]bool{}

func init() {
	for k := range model.TxnTypeLabels {
		knownTypes[k] = true
	}
}

// ---------------------------------------------------------------------------
// Small helpers

func idOf(p *int64) int64 {
	if p == nil || *p < 0 {
		return 0
	}
	return *p
}

func ptrOf(id int64) *int64 {
	if id == 0 {
		return nil
	}
	v := id
	return &v
}

// nz turns 0 into SQL NULL.
func nz(id int64) any {
	if id == 0 {
		return nil
	}
	return id
}

func nf(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func ni(n sql.NullInt64) int64 {
	if n.Valid {
		return n.Int64
	}
	return 0
}

func nfp(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	v := n.Float64
	return &v
}

func or64(a, b int64) int64 {
	if a != 0 {
		return a
	}
	return b
}

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// rnd rounds a cents value half away from zero, absorbing binary float noise
// (e.g. 1000 * 7.35 / 100 = 73.4999999 must round to 74).
func rnd(x float64) int64 {
	return int64(math.Round(x * (1 + 1e-12)))
}

const qtyEps = 1e-9

func nearZero(q float64) bool { return math.Abs(q) < qtyEps }

// fmtMoney formats cents as 1,234.56 (minus sign for negatives).
func fmtMoney(c int64) string {
	neg := c < 0
	if neg {
		c = -c
	}
	whole := strconv.FormatInt(c/100, 10)
	var b strings.Builder
	for i, r := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(r)
	}
	s := fmt.Sprintf("%s.%02d", b.String(), c%100)
	if neg {
		return "-" + s
	}
	return s
}

func fmtQty(q float64) string {
	return strconv.FormatFloat(q, 'f', -1, 64)
}

// placeholders returns "(?,?,?)" and the args for an IN list.
func placeholders(ids []int64) (string, []any) {
	if len(ids) == 0 {
		return "(NULL)", nil
	}
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	return "(" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")", args
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k, v := range m {
		if v && k != 0 {
			out = append(out, k)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// env: one save/delete/void/rebuild run with small caches of list records.

type env struct {
	ctx     context.Context
	q       store.Q
	opt     SaveOptions
	prefs   store.Prefs
	quiet   bool // rebuild: no warnings
	dryRun  bool // remove-check: no closing date checks (the real call asks for the password)
	accts   map[int64]*acctInfo
	items   map[int64]*itemInfo
	names   map[int64]*nameInfo
	lists   map[int64]bool
	briefs  map[int64]*brief
	special map[string]int64
}

func newEnv(ctx context.Context, q store.Q, opt SaveOptions) (*env, error) {
	p, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	return &env{ctx: ctx, q: q, opt: opt, prefs: p,
		accts: map[int64]*acctInfo{}, items: map[int64]*itemInfo{}, names: map[int64]*nameInfo{},
		lists: map[int64]bool{}, briefs: map[int64]*brief{}, special: map[string]int64{}}, nil
}

type acctInfo struct {
	ID       int64
	Name     string
	Type     string
	Special  string
	ParentID int64
	Active   bool
}

func (e *env) acct(id int64) (*acctInfo, error) {
	if id == 0 {
		return nil, nil
	}
	if a, ok := e.accts[id]; ok {
		return a, nil
	}
	var a acctInfo
	var parent sql.NullInt64
	var active int
	err := e.q.QueryRowContext(e.ctx, `SELECT id, name, type, special, parent_id, active FROM accounts WHERE id = ?`, id).
		Scan(&a.ID, &a.Name, &a.Type, &a.Special, &parent, &active)
	if errors.Is(err, sql.ErrNoRows) {
		e.accts[id] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.ParentID = ni(parent)
	a.Active = active == 1
	e.accts[id] = &a
	return &a, nil
}

func (e *env) acctType(id int64) string {
	a, _ := e.acct(id)
	if a == nil {
		return ""
	}
	return a.Type
}

func (e *env) acctFull(id int64) string {
	return store.FullName(e.ctx, e.q, "accounts", id)
}

func (e *env) specialAcct(code string) (int64, error) {
	if id, ok := e.special[code]; ok {
		return id, nil
	}
	id, err := store.SpecialAccount(e.ctx, e.q, code)
	if err != nil {
		return 0, err
	}
	e.special[code] = id
	return id, nil
}

type groupMember struct {
	ItemID int64
	Qty    float64
}

type itemInfo struct {
	ID                                      int64
	Type, Name                              string
	Description, PurchaseDescription        string
	Active, RateIsPercent, Taxable          bool
	SalesPrice, Cost, TaxRate               float64
	Income, Expense, Asset, Deposit, Agency int64
	members                                 []groupMember
	membersLoaded                           bool
}

func (e *env) item(id int64) (*itemInfo, error) {
	if id == 0 {
		return nil, nil
	}
	if it, ok := e.items[id]; ok {
		return it, nil
	}
	var it itemInfo
	var inc, exp, asset, dep, agency sql.NullInt64
	var active, pct, taxable int
	err := e.q.QueryRowContext(e.ctx, `SELECT id, type, name, description, purchase_description, active, rate_is_percent,
		taxable, sales_price, cost, tax_rate, income_account_id, expense_account_id, asset_account_id,
		deposit_account_id, tax_agency_id FROM items WHERE id = ?`, id).
		Scan(&it.ID, &it.Type, &it.Name, &it.Description, &it.PurchaseDescription, &active, &pct, &taxable,
			&it.SalesPrice, &it.Cost, &it.TaxRate, &inc, &exp, &asset, &dep, &agency)
	if errors.Is(err, sql.ErrNoRows) {
		e.items[id] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	it.Active, it.RateIsPercent, it.Taxable = active == 1, pct == 1, taxable == 1
	it.Income, it.Expense, it.Asset, it.Deposit, it.Agency = ni(inc), ni(exp), ni(asset), ni(dep), ni(agency)
	e.items[id] = &it
	return &it, nil
}

func (e *env) itemType(id int64) string {
	it, _ := e.item(id)
	if it == nil {
		return ""
	}
	return it.Type
}

func (e *env) itemFull(id int64) string {
	return store.FullName(e.ctx, e.q, "items", id)
}

// members returns the members of a Group / Sales Tax Group item.
func (e *env) members(it *itemInfo) ([]groupMember, error) {
	if it.membersLoaded {
		return it.members, nil
	}
	rows, err := e.q.QueryContext(e.ctx, `SELECT item_id, qty FROM item_group_lines WHERE group_id = ? ORDER BY seq, id`, it.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []groupMember
	for rows.Next() {
		var m groupMember
		if err := rows.Scan(&m.ItemID, &m.Qty); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	it.members, it.membersLoaded = out, true
	return out, nil
}

// taxRateOf returns the percent rate of a Sales Tax Item or Group (sum of members).
func (e *env) taxRateOf(it *itemInfo) (float64, error) {
	if it == nil {
		return 0, nil
	}
	switch it.Type {
	case model.ItemSalesTax:
		return it.TaxRate, nil
	case model.ItemSalesTaxGroup:
		ms, err := e.members(it)
		if err != nil {
			return 0, err
		}
		var r float64
		for _, m := range ms {
			mi, err := e.item(m.ItemID)
			if err != nil {
				return 0, err
			}
			if mi != nil {
				r += mi.TaxRate
			}
		}
		return r, nil
	}
	return 0, nil
}

type nameInfo struct {
	ID          int64
	Kind, Name  string
	ParentID    int64
	Active      bool
	CreditLimit sql.NullInt64
}

func (e *env) name(id int64) (*nameInfo, error) {
	if id == 0 {
		return nil, nil
	}
	if n, ok := e.names[id]; ok {
		return n, nil
	}
	var n nameInfo
	var parent sql.NullInt64
	var active int
	err := e.q.QueryRowContext(e.ctx, `SELECT id, kind, name, parent_id, active, credit_limit FROM names WHERE id = ?`, id).
		Scan(&n.ID, &n.Kind, &n.Name, &parent, &active, &n.CreditLimit)
	if errors.Is(err, sql.ErrNoRows) {
		e.names[id] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n.ParentID = ni(parent)
	n.Active = active == 1
	e.names[id] = &n
	return &n, nil
}

func (e *env) nameFull(id int64) string {
	if id == 0 {
		return ""
	}
	return store.FullName(e.ctx, e.q, "names", id)
}

// rootName returns the top-level customer of a job (the id itself for top-level names).
func (e *env) rootName(id int64) (int64, error) {
	for i := 0; i < 64 && id != 0; i++ {
		n, err := e.name(id)
		if err != nil {
			return 0, err
		}
		if n == nil || n.ParentID == 0 {
			return id, nil
		}
		id = n.ParentID
	}
	return id, nil
}

func (e *env) listExists(id int64) (bool, error) {
	if id == 0 {
		return true, nil
	}
	if ok, found := e.lists[id]; found {
		return ok, nil
	}
	var n int
	if err := e.q.QueryRowContext(e.ctx, `SELECT COUNT(*) FROM list_entries WHERE id = ?`, id).Scan(&n); err != nil {
		return false, err
	}
	e.lists[id] = n > 0
	return n > 0, nil
}

// brief is a short view of another transaction (link targets, deposited payments).
// A journal entry with one A/R or A/P line is an open document of that line's
// name: ArAp is the line's account type and ArApAmt its signed ledger amount;
// NameID and Amount (absolute) describe that line.
type brief struct {
	ID              int64
	Type, Ref, Date string
	NameID          int64
	AccountID       int64
	Amount          int64
	Voided, Pending bool
	ArAp            string
	ArApAmt         int64
	ArApAcct        int64 // the A/R or A/P account of the document (0 when none)
}

// jeCharge: a journal entry that customers / vendors pay like an invoice / bill
// (A/R debit, A/P credit).
func (b *brief) jeCharge() bool {
	return b != nil && b.Type == model.TxJournal &&
		((b.ArAp == model.AcctAR && b.ArApAmt > 0) || (b.ArAp == model.AcctAP && b.ArApAmt < 0))
}

// jeCredit: a journal entry usable like a credit memo / vendor credit
// (A/R credit, A/P debit).
func (b *brief) jeCredit() bool {
	return b != nil && b.Type == model.TxJournal &&
		((b.ArAp == model.AcctAR && b.ArApAmt < 0) || (b.ArAp == model.AcctAP && b.ArApAmt > 0))
}

// jeArApLine returns the A/R or A/P entry of a journal entry when it has
// exactly one (account type, signed amount, name), else "".
func jeArApLine(ctx context.Context, q store.Q, txnID int64) (string, int64, int64, error) {
	typ, amt, name, _, err := jeArApEntry(ctx, q, txnID)
	return typ, amt, name, err
}

// jeArApEntry is jeArApLine plus the account of the entry.
func jeArApEntry(ctx context.Context, q store.Q, txnID int64) (string, int64, int64, int64, error) {
	rows, err := q.QueryContext(ctx, `SELECT a.type, g.amount, IFNULL(g.name_id, 0), g.account_id FROM gl_entries g
		JOIN accounts a ON a.id = g.account_id WHERE g.txn_id = ? AND a.type IN (?, ?)`, txnID, model.AcctAR, model.AcctAP)
	if err != nil {
		return "", 0, 0, 0, err
	}
	defer rows.Close()
	var typ string
	var amt, name, acct int64
	n := 0
	for rows.Next() {
		if err := rows.Scan(&typ, &amt, &name, &acct); err != nil {
			return "", 0, 0, 0, err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return "", 0, 0, 0, err
	}
	if n != 1 {
		return "", 0, 0, 0, nil
	}
	return typ, amt, name, acct, nil
}

func (e *env) brief(id int64) (*brief, error) {
	if id == 0 {
		return nil, nil
	}
	if b, ok := e.briefs[id]; ok {
		return b, nil
	}
	var b brief
	var name, acct, arap sql.NullInt64
	var voided, pending int
	err := e.q.QueryRowContext(e.ctx, `SELECT id, type, ref_number, date, name_id, account_id, amount, voided, is_pending, ar_ap_account_id
		FROM txns WHERE id = ?`, id).Scan(&b.ID, &b.Type, &b.Ref, &b.Date, &name, &acct, &b.Amount, &voided, &pending, &arap)
	if errors.Is(err, sql.ErrNoRows) {
		e.briefs[id] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.NameID, b.AccountID = ni(name), ni(acct)
	b.Voided, b.Pending = voided == 1, pending == 1
	switch b.Type {
	case model.TxPayment, model.TxRefund, model.TxBillPayment:
		b.ArApAcct = ni(arap)
	case model.TxInvoice, model.TxStatementCharge, model.TxCreditMemo, model.TxBill, model.TxItemReceipt, model.TxVendorCredit:
		b.ArApAcct = b.AccountID
	}
	if b.Type == model.TxJournal && !b.Voided {
		var nm int64
		if b.ArAp, b.ArApAmt, nm, b.ArApAcct, err = jeArApEntry(e.ctx, e.q, id); err != nil {
			return nil, err
		}
		if b.ArAp != "" {
			b.NameID, b.Amount = nm, abs64(b.ArApAmt)
		}
	}
	e.briefs[id] = &b
	return &b, nil
}

// msgTypeLabels: names of transaction types inside messages.
var msgTypeLabels = map[string]string{
	model.TxBillPayment:     "bill payment",
	model.TxVendorCredit:    "vendor credit",
	model.TxJournal:         "journal entry",
	model.TxInventoryAdjust: "inventory adjustment",
	model.TxCCCharge:        "credit card charge",
	model.TxCCCredit:        "credit card credit",
}

// typeWord is the lower-case name of a transaction type for messages.
func typeWord(t string) string {
	if l, ok := msgTypeLabels[t]; ok {
		return l
	}
	return strings.ToLower(TypeLabel(t, ""))
}

// docLabel describes a transaction for messages: "invoice #1001",
// "refund dated 10/19/2026".
func docLabel(b *brief) string {
	l := typeWord(b.Type)
	if b.Ref != "" {
		if b.Type == model.TxCheck {
			return "check " + b.Ref
		}
		if typeIn(b.Type, model.TxRefund, model.TxBillPayment, model.TxSalesTaxPayment) {
			return l + " (check " + b.Ref + ")"
		}
		return l + " #" + b.Ref
	}
	return l + " dated " + store.FmtDate(b.Date)
}
