// Package sample builds the fictitious sample company "Harborview Landscaping
// & Supply (Sample)": a landscaping business with sales tax, inventory, class
// tracking and about 18 months of activity ending on the given day.
//
// Everything is posted through the real code paths (lists.Save*, ledger.Save,
// banking and company helpers), so balances, open amounts, inventory values
// and reconciliations are as consistent as data entered by hand. The output is
// deterministic for a given day (fixed random seed, no map iteration).
package sample

import (
	"container/heap"
	"context"
	"database/sql"
	"fmt"
	"math"
	"math/rand"
	"time"

	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// FileID is the company file id of the sample company.
const FileID = "sample-harborview"

// CompanyName is the name of the sample company.
const CompanyName = "Harborview Landscaping & Supply (Sample)"

// Generate fills a brand-new company file (run it as the init function of
// store.Manager.Create). today is YYYY-MM-DD; the activity covers the 18
// months before it and nothing is dated after it.
func Generate(ctx context.Context, tx *sql.Tx, today string) error {
	if !store.ValidDate(today) {
		return fmt.Errorf("sample: invalid date %q", today)
	}
	g := &gen{
		ctx: ctx, tx: tx, today: today,
		opt:   ledger.SaveOptions{User: "Admin", Force: true},
		rng:   rand.New(rand.NewSource(20240917)),
		acct:  map[string]int64{},
		item:  map[string]int64{},
		name:  map[string]int64{},
		list:  map[string]int64{},
		onPO:  map[int64]float64{},
		check: 2001,
	}
	t0 := mustDate(today)
	start := time.Date(t0.Year(), t0.Month()-18, 1, 0, 0, 0, 0, time.UTC)
	g.start = fmtDate(start)
	g.open = fmtDate(start.AddDate(0, 0, -1))

	steps := []struct {
		name string
		fn   func() error
	}{
		{"company", g.setupCompany},
		{"lists", g.setupLists},
		{"accounts", g.setupAccounts},
		{"vendors", g.setupVendors},
		{"items", g.setupItems},
		{"customers", g.setupCustomers},
		{"opening balances", g.setupOpening},
		{"activity", g.runActivity},
		{"reconciliations", g.reconcileChecking},
		{"bank feeds", g.bankFeeds},
		{"planning", g.planning},
		{"history dates", g.historyDates},
	}
	for _, s := range steps {
		if err := s.fn(); err != nil {
			return fmt.Errorf("sample company (%s): %w", s.name, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// generator state

type gen struct {
	ctx   context.Context
	tx    *sql.Tx
	opt   ledger.SaveOptions
	rng   *rand.Rand
	today string
	start string // first day of activity
	open  string // opening balance date (day before start)

	acct map[string]int64 // account full name -> id
	item map[string]int64 // item full name -> id
	name map[string]int64 // name full name -> id
	list map[string]int64 // "list:name" -> id

	custs   []*cust
	vendors []*vend
	vendBy  map[string]*vend
	invs    []*invItem // inventory parts (purchase info)
	owner   int64

	q     evq
	seq   int
	now   string // date of the event being processed
	check int    // next check number of the checking account

	ufPending  []int64 // payments / sales receipts waiting in Undeposited Funds
	onPO       map[int64]float64
	loanBal    int64 // truck loan principal (cents)
	rentMemID  int64
	cashBackOK bool
	firstRef   map[string]bool
	billables  []billable
}

type cust struct {
	id         int64
	name       string
	jobs       []int64
	commercial bool
	taxable    bool
	taxItem    int64
	terms      string
	weight     int
	lag        int // extra days this customer usually takes to pay
	method     string
	addr       string
}

type vend struct {
	id       int64
	name     string
	addr     string // address block printed on checks
	terms    string
	discount bool // 2% 10 Net 30: pay within 10 days and take the discount
	card     bool // bills paid with the credit card
}

type invItem struct {
	id      int64
	name    string
	cost    float64
	price   float64
	reorder float64
	max     float64
	vendor  string
	unit    string
}

type billable struct {
	lineID, itemID, nameID int64
	amount                 int64
	date                   string
}

// ---------------------------------------------------------------------------
// event queue: the simulation runs in date order (ties in scheduling order)

type event struct {
	date string
	seq  int
	fn   func(d string) error
}

type evq []*event

func (q evq) Len() int { return len(q) }
func (q evq) Less(i, j int) bool {
	if q[i].date != q[j].date {
		return q[i].date < q[j].date
	}
	return q[i].seq < q[j].seq
}
func (q evq) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *evq) Push(x any)   { *q = append(*q, x.(*event)) }
func (q *evq) Pop() any {
	old := *q
	n := len(old)
	x := old[n-1]
	*q = old[:n-1]
	return x
}

// at schedules fn on date (skipped when after today; never before the event
// being processed).
func (g *gen) at(date string, fn func(d string) error) {
	if date > g.today {
		return
	}
	if date < g.now {
		date = g.now
	}
	if date < g.start {
		date = g.start
	}
	g.seq++
	heap.Push(&g.q, &event{date: date, seq: g.seq, fn: fn})
}

// ---------------------------------------------------------------------------
// small helpers

func mustDate(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func fmtDate(t time.Time) string { return t.Format("2006-01-02") }

func addDays(d string, n int) string { return fmtDate(mustDate(d).AddDate(0, 0, n)) }

func monthEnd(d string) string {
	t := mustDate(d)
	return fmtDate(time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC))
}

func dayOf(d string, day int) string {
	t := mustDate(d)
	last := time.Date(t.Year(), t.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if day > last {
		day = last
	}
	return fmtDate(time.Date(t.Year(), t.Month(), day, 0, 0, 0, 0, time.UTC))
}

func p64(v int64) *int64 {
	if v == 0 {
		return nil
	}
	return &v
}

func pf(v float64) *float64 { return &v }

func r2(f float64) float64 { return math.Round(f*100) / 100 }

func cents(f float64) int64 { return store.Cents(f) }

func dollars(c int64) float64 { return store.Dollars(c) }

func (g *gen) between(a, b int) int {
	if b <= a {
		return a
	}
	return a + g.rng.Intn(b-a+1)
}

func (g *gen) chance(p float64) bool { return g.rng.Float64() < p }

func (g *gen) money(lo, hi float64) float64 { return r2(lo + g.rng.Float64()*(hi-lo)) }

func (g *gen) save(t *model.Txn) (int64, error) {
	id, err := ledger.Save(g.ctx, g.tx, t, g.opt)
	if err != nil {
		return 0, fmt.Errorf("%s %s dated %s: %w", t.Type, t.RefNumber, t.Date, err)
	}
	return id, nil
}

func (g *gen) a(name string) int64 {
	id, ok := g.acct[name]
	if !ok {
		panic("sample: unknown account " + name)
	}
	return id
}

func (g *gen) it(name string) int64 {
	id, ok := g.item[name]
	if !ok {
		panic("sample: unknown item " + name)
	}
	return id
}

func (g *gen) l(list, name string) int64 {
	id, ok := g.list[list+":"+name]
	if !ok {
		panic("sample: unknown list entry " + list + ":" + name)
	}
	return id
}

func (g *gen) nextCheck() string {
	n := g.check
	g.check++
	return fmt.Sprintf("%d", n)
}

// qtyOnHand is the item's current quantity (maintained by the ledger).
func (g *gen) qtyOnHand(itemID int64) float64 {
	var q float64
	g.tx.QueryRowContext(g.ctx, `SELECT qty_on_hand FROM items WHERE id = ?`, itemID).Scan(&q)
	return q
}

// balance is the ledger balance (debit +) of an account up to and including date.
func (g *gen) balance(acctID int64, date string) int64 {
	var b int64
	g.tx.QueryRowContext(g.ctx, `SELECT IFNULL(SUM(amount), 0) FROM gl_entries WHERE account_id = ? AND date <= ?`, acctID, date).Scan(&b)
	return b
}

// season scales the activity of a month (landscaping is busiest in spring).
func season(m time.Month) float64 {
	return [...]float64{0, 0.5, 0.6, 0.9, 1.3, 1.5, 1.4, 1.2, 1.1, 1.0, 0.9, 0.6, 0.45}[m]
}

// historyDates dates the entry timestamps of the transactions and the audit
// trail on the transaction dates (late afternoon), as if the data had been
// entered day by day, never later than now.
func (g *gen) historyDates() error {
	now := store.Now()
	for _, q := range []string{
		`UPDATE txns SET created_at = MIN(date || 'T21:00:00Z', ?), updated_at = MIN(date || 'T21:00:00Z', ?)`,
		`UPDATE audit_log SET ts = MIN(txn_date || 'T21:00:00Z', ?) WHERE txn_date <> '' AND ? <> ''`,
	} {
		if _, err := g.tx.ExecContext(g.ctx, q, now, now); err != nil {
			return err
		}
	}
	return nil
}
