package sample

// The simulated activity: ~18 months of sales, purchases, banking and
// month-end entries, run as dated events in chronological order.

import (
	"container/heap"
	"fmt"
	"math"
	"time"

	"seriex/internal/company"
	"seriex/internal/ledger"
	"seriex/internal/model"
)

// openDoc is an invoice / statement charge / bill the generator may still pay.
type openDoc struct {
	id     int64
	nameID int64
	date   string
	due    string
	total  int64
	open   int64
	c      *cust
	v      *vend
}

func (g *gen) setupOpening() error {
	chk, sav, petty := g.a("Checking"), g.a("Savings"), g.a("Petty Cash")
	veh, accum, obe := g.a("Vehicles"), g.a("Accumulated Depreciation"), g.a("Opening Balance Equity")
	je := model.Txn{Type: model.TxJournal, Date: g.open, RefNumber: "OB-1", Memo: "Opening balances",
		Extra: map[string]any{"openingBalance": true},
		Lines: []model.TxnLine{
			{Kind: model.LineJournal, AccountID: &chk, Amount: 38500, Description: "Opening balance"},
			{Kind: model.LineJournal, AccountID: &sav, Amount: 25000, Description: "Opening balance"},
			{Kind: model.LineJournal, AccountID: &petty, Amount: 300, Description: "Opening balance"},
			{Kind: model.LineJournal, AccountID: &veh, Amount: 68000, Description: "Two landscaping trucks"},
			{Kind: model.LineJournal, AccountID: &accum, Amount: -12000, Description: "Depreciation to date"},
			{Kind: model.LineJournal, AccountID: &obe, Amount: -119800, Description: "Opening balance"},
		}}
	if _, err := g.save(&je); err != nil {
		return err
	}
	// Opening Balance Equity is closed to the owner's equity once setup is done.
	bal := -g.balance(obe, g.open)
	if bal != 0 {
		eq := g.a("Owners Equity")
		amt := dollars(bal)
		close := model.Txn{Type: model.TxJournal, Date: g.open, RefNumber: "OB-2", Memo: "Close Opening Balance Equity to Owners Equity",
			Lines: []model.TxnLine{
				{Kind: model.LineJournal, AccountID: &obe, Amount: amt, Description: "Close Opening Balance Equity"},
				{Kind: model.LineJournal, AccountID: &eq, Amount: -amt, Description: "Owner's investment"},
			}}
		if _, err := g.save(&close); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------

func (g *gen) runActivity() error {
	// memorized monthly rent, entered automatically on the 1st
	chk := g.a("Checking")
	landlord := g.vendBy["Marina Properties LLC"].id
	rent := g.a("Rent Expense")
	m := model.MemorizedTxn{Name: "Monthly Rent - Marina Properties", TxnType: model.TxCheck, Schedule: "auto", Frequency: "monthly",
		NextDate: g.start, GroupName: "Monthly bills",
		Template: model.Txn{Type: model.TxCheck, AccountID: &chk, NameID: &landlord, Memo: "Yard and office rent (autopay)",
			Lines: []model.TxnLine{{Kind: model.LineExpense, AccountID: &rent, Amount: 3200, Description: "Monthly rent"}}}}
	id, err := company.CreateMemorized(g.ctx, g.tx, &m)
	if err != nil {
		return err
	}
	g.rentMemID = id

	// documents with opening balances are paid in the first weeks
	rows, err := g.tx.QueryContext(g.ctx, `SELECT id, type, name_id, amount FROM txns WHERE type IN ('INV','BILL') AND date = ? ORDER BY id`, g.open)
	if err != nil {
		return err
	}
	type ob struct {
		id, name, amt int64
		typ           string
	}
	var obs []ob
	for rows.Next() {
		var o ob
		if err := rows.Scan(&o.id, &o.typ, &o.name, &o.amt); err != nil {
			rows.Close()
			return err
		}
		obs = append(obs, o)
	}
	rows.Close()
	for _, o := range obs {
		d := &openDoc{id: o.id, nameID: o.name, date: g.open, total: o.amt, open: o.amt}
		if o.typ == model.TxInvoice {
			for _, c := range g.custs {
				if c.id == o.name {
					d.c = c
				}
			}
			g.at(addDays(g.start, g.between(5, 20)), func(day string) error { return g.receivePayment(day, d, d.open, false) })
		} else {
			for _, v := range g.vendors {
				if v.id == o.name {
					d.v = v
				}
			}
			g.at(addDays(g.start, g.between(3, 14)), func(day string) error { return g.payBill(day, d) })
		}
	}

	// month drivers
	for t := mustDate(g.start); fmtDate(t) <= g.today; t = t.AddDate(0, 1, 0) {
		first := fmtDate(t)
		idx := (t.Year()-mustDate(g.start).Year())*12 + int(t.Month()) - int(mustDate(g.start).Month())
		g.at(first, func(d string) error { return g.month(d, idx) })
	}
	for g.q.Len() > 0 {
		ev := heap.Pop(&g.q).(*event)
		g.now = ev.date
		if err := ev.fn(ev.date); err != nil {
			return fmt.Errorf("%s: %w", ev.date, err)
		}
	}
	return nil
}

// month schedules everything that happens in the month starting on first.
func (g *gen) month(first string, idx int) error {
	t := mustDate(first)
	f := season(t.Month())
	last := monthEnd(first)
	day := func(n int) string { return dayOf(first, n) }
	rnd := func() string { return dayOf(first, g.between(1, mustDate(last).Day())) }

	// fixed monthly items
	g.at(day(1), func(d string) error { _, err := company.EnterMemorized(g.ctx, g.tx, g.rentMemID, d, g.opt); return err })
	g.at(day(1), g.statementCharges)
	g.at(day(8), func(d string) error {
		amt := g.money(210, 330) + 60*f
		return g.expenseBill(d, "Bayview Power & Light", "", []expLine{{"Utilities", r2(amt), "Electric service"}})
	})
	g.at(day(10), func(d string) error {
		amt := g.money(90, 140) + 260*f*f
		return g.expenseBill(d, "Harborview Water Department", "", []expLine{{"Utilities", r2(amt), "Water and irrigation meter"}})
	})
	if t.Month()%3 == 1 { // Jan, Apr, Jul, Oct
		g.at(day(5), func(d string) error {
			return g.expenseBill(d, "Anchor Mutual Insurance", "", []expLine{
				{"Insurance Expense:Liability Insurance", 1200, "General liability, quarterly"},
				{"Insurance Expense:Vehicle Insurance", 650, "Commercial auto, quarterly"}})
		})
		if first > g.start {
			g.at(day(20), g.salesTaxPayment)
		}
	}
	if idx > 0 {
		g.at(day(12), g.cardPayment)
	}
	g.at(day(15), g.loanPayment)
	g.at(day(18), func(d string) error {
		return g.cardCharge(d, "Seaside Telecom", []expLine{{"Telephone Expense", 189.99, "Phone and internet"}}, false)
	})
	g.at(day(25), func(d string) error { return g.ownerDraw(d, 3000) })
	g.at(last, g.monthEnd)
	if t.Month()%3 == 0 {
		g.at(day(28), g.savingsTransfer)
	}

	// fuel, meals, supplies and repairs
	for i, n := 0, g.between(3, 5); i < n; i++ {
		g.at(rnd(), func(d string) error {
			return g.cardCharge(d, "Harbor Fuel Co.", []expLine{{"Automobile Expense:Fuel", g.money(95, 240), "Truck fuel"}}, false)
		})
	}
	if g.chance(0.6) {
		g.at(rnd(), func(d string) error {
			return g.cardCharge(d, "Harbor Hardware", []expLine{{"Small Tools and Equipment", g.money(25, 210), "Hand tools and hardware"}}, false)
		})
	}
	g.at(rnd(), func(d string) error {
		return g.writeCheck(d, "Harbor Office Supply", []expLine{{"Office Supplies", g.money(35, 160), "Office supplies"}})
	})
	if g.chance(0.35) {
		g.at(rnd(), func(d string) error {
			return g.expenseBill(d, "Precision Truck Repair", "", []expLine{{"Automobile Expense:Vehicle Repairs", g.money(180, 950), "Truck service"}})
		})
	}
	if g.chance(0.4) {
		g.at(rnd(), func(d string) error {
			return g.expenseBill(d, "Westshore Equipment Rental", "", []expLine{{"Job Expenses:Equipment Rental", g.money(240, 780), "Mini excavator rental"}})
		})
	}

	// sales
	for i, n := 0, int(math.Round(10*f))+g.between(-1, 2); i < n; i++ {
		g.at(rnd(), func(d string) error { return g.invoice(d, nil) })
	}
	for i, n := 0, int(math.Round(3*f)); i < n; i++ {
		g.at(rnd(), g.estimate)
	}
	for i, n := 0, int(math.Round(5*f))+g.between(0, 2); i < n; i++ {
		g.at(rnd(), g.salesReceipt)
	}
	for i, n := 0, g.between(1, 2); i < n; i++ {
		g.at(rnd(), g.treeWork)
	}

	// weekly deposits (Fridays) and inventory reorders (Mondays)
	for d := first; d <= last; d = addDays(d, 1) {
		switch mustDate(d).Weekday() {
		case time.Friday:
			g.at(d, g.deposit)
		case time.Monday:
			g.at(d, g.reorder)
			g.at(d, func(day string) error { return g.crewLabor(day, f) })
		}
	}

	// one-off events of the sample story
	switch idx {
	case 1:
		g.cashBackOK = true
	case 2, 8:
		g.at(day(9), g.billableWork)
	case 3:
		g.at(day(14), g.returnCredit)
	case 5:
		g.at(day(6), g.serviceCreditRefund)
		g.at(last, g.shrinkage)
	case 7:
		g.at(day(16), func(d string) error {
			return g.cardCharge(d, "Harbor Hardware", []expLine{{"Small Tools and Equipment", 64.80, "Returned hedge trimmer"}}, true)
		})
	case 14:
		g.at(day(11), g.unappliedCredit)
		g.at(last, g.shrinkage)
	case 18:
		g.at(day(2), g.billableWork)
		g.at(addDays(g.today, -5), g.receiptPending)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Customers

func (g *gen) pickCustomer() *cust {
	total := 0
	for _, c := range g.custs {
		total += c.weight
	}
	n := g.rng.Intn(total)
	for _, c := range g.custs {
		if n < c.weight {
			return c
		}
		n -= c.weight
	}
	return g.custs[0]
}

// target returns the customer or one of its jobs.
func (g *gen) target(c *cust) int64 {
	if len(c.jobs) > 0 && g.chance(0.8) {
		return c.jobs[g.rng.Intn(len(c.jobs))]
	}
	return c.id
}

func (g *gen) classOf(c *cust) *int64 {
	if c.commercial {
		return p64(g.l(model.ListClass, "Commercial"))
	}
	return p64(g.l(model.ListClass, "Residential"))
}

// invLine is an inventory line capped to the quantity on hand.
func (g *gen) invLine(c *cust, name string, want float64) *model.TxnLine {
	var ii *invItem
	for _, x := range g.invs {
		if x.name == name {
			ii = x
		}
	}
	have := math.Floor(g.qtyOnHand(ii.id))
	q := math.Min(want, have)
	if q <= 0 {
		return nil
	}
	return &model.TxnLine{ItemID: p64(ii.id), Qty: pf(q), Rate: pf(ii.price), Amount: r2(q * ii.price), Taxable: c.taxable}
}

func (g *gen) svcLine(name string, hours float64) model.TxnLine {
	rates := map[string]float64{"Design": 85, "Installation": 65, "Labor": 45, "Maintenance": 55}
	return model.TxnLine{ItemID: p64(g.it(name)), Qty: pf(hours), Rate: pf(rates[name]), Amount: r2(hours * rates[name])}
}

// salesLines builds a realistic set of lines for a job.
func (g *gen) salesLines(c *cust) []model.TxnLine {
	var lines []model.TxnLine
	add := func(l *model.TxnLine) {
		if l != nil {
			lines = append(lines, *l)
		}
	}
	switch k := g.rng.Intn(10); {
	case k < 3: // maintenance visit
		lines = append(lines, g.svcLine("Maintenance", float64(g.between(4, 14))))
		if g.chance(0.5) {
			add(g.invLine(c, "Mulch & Soil:Bark Mulch", float64(g.between(1, 4))))
		}
		if g.chance(0.4) {
			lines = append(lines, model.TxnLine{ItemID: p64(g.it("Fertilizer")), Qty: pf(2), Rate: pf(29), Amount: 58, Taxable: c.taxable})
		}
	case k < 4: // design work
		lines = append(lines, g.svcLine("Design", float64(g.between(3, 12))))
	case k < 5 && g.qtyOnHand(g.it("Plants:Lavender 1 gal")) > 20: // planting package
		lines = append(lines, model.TxnLine{ItemID: p64(g.it("Spring Planting Package")), Qty: pf(float64(g.between(1, 2))), Taxable: c.taxable})
		lines = append(lines, g.svcLine("Installation", float64(g.between(2, 6))))
	case k < 7: // planting installation
		lines = append(lines, g.svcLine("Installation", float64(g.between(8, 24))), g.svcLine("Labor", float64(g.between(4, 16))))
		add(g.invLine(c, "Plants:Boxwood 5 gal", float64(g.between(2, 10))))
		if g.chance(0.4) {
			add(g.invLine(c, "Plants:Japanese Maple 15 gal", float64(g.between(1, 2))))
		}
		add(g.invLine(c, "Plants:Lavender 1 gal", float64(g.between(6, 24))))
		if g.chance(0.5) {
			add(g.invLine(c, "Plants:Rose Bush 5 gal", float64(g.between(2, 8))))
		}
		if g.chance(0.5) {
			add(g.invLine(c, "Plants:Annual Flats", float64(g.between(2, 8))))
		}
		add(g.invLine(c, "Mulch & Soil:Bark Mulch", float64(g.between(2, 6))))
		if g.chance(0.3) {
			lines = append(lines, model.TxnLine{ItemID: p64(g.it("Landscape Fabric")), Qty: pf(float64(g.between(1, 3))), Rate: pf(69),
				Taxable: c.taxable})
			l := &lines[len(lines)-1]
			l.Amount = r2(*l.Qty * 69)
		}
	case k < 9: // hardscape
		lines = append(lines, g.svcLine("Installation", float64(g.between(16, 40))), g.svcLine("Labor", float64(g.between(16, 32))))
		if g.chance(0.5) {
			add(g.invLine(c, "Pavers:Concrete Paver 12x12", float64(g.between(60, 220))))
		} else {
			add(g.invLine(c, "Pavers:Flagstone", float64(g.between(50, 180))))
		}
		add(g.invLine(c, "Mulch & Soil:Decorative Rock", float64(g.between(1, 3))))
		add(g.invLine(c, "Mulch & Soil:Topsoil", float64(g.between(2, 6))))
	default: // irrigation
		lines = append(lines, g.svcLine("Installation", float64(g.between(6, 18))))
		add(g.invLine(c, "Sprinkler Parts:Sprinkler Head", float64(g.between(6, 24))))
		add(g.invLine(c, "Sprinkler Parts:Drip Line 100 ft", float64(g.between(1, 4))))
		add(g.invLine(c, "Sprinkler Parts:PVC Pipe 1 in", float64(g.between(4, 16))))
		if g.chance(0.5) {
			add(g.invLine(c, "Sprinkler Parts:Irrigation Timer", 1))
		}
	}
	if len(lines) > 2 && g.chance(0.35) {
		lines = append(lines, model.TxnLine{ItemID: p64(g.it("Delivery")), Qty: pf(1), Rate: pf(75), Amount: 75})
	}
	if len(lines) > 2 && g.chance(0.08) {
		lines = append(lines, model.TxnLine{ItemID: p64(g.it("Subtotal"))},
			model.TxnLine{ItemID: p64(g.it("10% Discount")), RateIsPercent: true, Rate: pf(10)})
	}
	return lines
}

func lineTotal(lines []model.TxnLine) float64 {
	var s float64
	for _, l := range lines {
		s += l.Amount
	}
	return s
}

func (g *gen) firstRefOf(typ, ref string) string {
	if g.firstRef == nil {
		g.firstRef = map[string]bool{}
	}
	if g.firstRef[typ] {
		return ""
	}
	g.firstRef[typ] = true
	return ref
}

// invoice creates an invoice (from an estimate when est != nil) and schedules its payment.
func (g *gen) invoice(d string, est *model.Txn) error {
	var c *cust
	var nameID int64
	var lines []model.TxnLine
	if est != nil {
		nameID = *est.NameID
		for _, x := range g.custs {
			if x.id == nameID {
				c = x
			}
			for _, j := range x.jobs {
				if j == nameID {
					c = x
				}
			}
		}
		for _, el := range est.Lines {
			l := model.TxnLine{ItemID: el.ItemID, Description: el.Description, Qty: el.Qty, Rate: el.Rate, Amount: el.Amount,
				Taxable: el.Taxable, RateIsPercent: el.RateIsPercent, LinkedTxnID: p64(est.ID), LinkedLineID: p64(el.ID)}
			for _, ii := range g.invs {
				if el.ItemID != nil && *el.ItemID == ii.id && el.Qty != nil {
					have := math.Floor(g.qtyOnHand(ii.id))
					if *el.Qty > have {
						q := math.Max(have, 0)
						l.Qty, l.Amount = pf(q), r2(q**el.Rate)
					}
				}
			}
			if l.Qty != nil && *l.Qty == 0 {
				continue
			}
			lines = append(lines, l)
		}
	} else {
		c = g.pickCustomer()
		nameID = g.target(c)
		lines = g.salesLines(c)
	}
	if len(lines) == 0 {
		return nil
	}
	g.describe(lines, false)
	t := model.Txn{Type: model.TxInvoice, Date: d, NameID: &nameID, RefNumber: g.firstRefOf("INV", "1001"),
		ClassID: g.classOf(c), TermsID: p64(g.l(model.ListTerms, c.terms)), TaxItemID: &c.taxItem, BillAddress: c.addr, ShipAddress: c.addr,
		Template: "Service Invoice", Lines: lines}
	if rep, ok := g.repOf(nameID); ok {
		t.RepID = &rep
	}
	if g.chance(0.5) {
		t.CustomerMessageID = p64(g.l(model.ListCustomerMessage, "Thank you for your business."))
	}
	if c.commercial && g.chance(0.4) {
		t.PONumber = fmt.Sprintf("PO-%d", 4400+g.rng.Intn(500))
	}
	id, err := g.save(&t)
	if err != nil {
		return err
	}
	doc := &openDoc{id: id, nameID: nameID, date: d, due: t.DueDate, total: cents(t.Amount), open: cents(t.Amount), c: c}
	g.schedulePayment(doc)
	return nil
}

func (g *gen) repOf(nameID int64) (int64, bool) {
	var rep int64
	err := g.tx.QueryRowContext(g.ctx, `SELECT IFNULL(rep_id, 0) FROM names WHERE id = ?`, nameID).Scan(&rep)
	return rep, err == nil && rep != 0
}

// schedulePayment decides when (and how much of) an invoice gets paid.
func (g *gen) schedulePayment(doc *openDoc) {
	c := doc.c
	if doc.total <= 0 {
		return
	}
	var lag int
	switch c.terms {
	case "Due on receipt":
		lag = g.between(0, 10)
	case "Net 15":
		lag = g.between(10, 20)
	case "2% 10 Net 30":
		if g.chance(0.6) {
			g.at(addDays(doc.date, g.between(5, 10)), func(d string) error { return g.receivePayment(d, doc, doc.open, true) })
			return
		}
		lag = g.between(22, 34)
	default:
		lag = g.between(20, 38)
	}
	lag += c.lag
	switch k := g.rng.Float64(); {
	case k < 0.008:
		return // never paid: stays open and becomes overdue
	case k < 0.03:
		lag += g.between(110, 200) // paid after collection calls
	}
	if g.chance(0.12) {
		lag += g.between(30, 70) // slow this time
	}
	if g.chance(0.08) {
		// partial payment now, the rest later
		part := doc.total * int64(g.between(40, 60)) / 100
		g.at(addDays(doc.date, lag), func(d string) error { return g.receivePayment(d, doc, part, false) })
		g.at(addDays(doc.date, lag+g.between(20, 45)), func(d string) error { return g.receivePayment(d, doc, doc.open, false) })
		return
	}
	g.at(addDays(doc.date, lag), func(d string) error { return g.receivePayment(d, doc, doc.open, false) })
}

// receivePayment records a customer payment into Undeposited Funds.
func (g *gen) receivePayment(d string, doc *openDoc, amount int64, discount bool) error {
	if amount > doc.open {
		amount = doc.open
	}
	if amount <= 0 {
		return nil
	}
	var disc int64
	if discount && amount == doc.open {
		disc = int64(math.Round(float64(doc.open) * 0.02))
		amount -= disc
	}
	method := "Check"
	if doc.c != nil {
		method = doc.c.method
	}
	t := model.Txn{Type: model.TxPayment, Date: d, NameID: &doc.nameID, Amount: dollars(amount),
		PaymentMethodID: p64(g.l(model.ListPaymentMethod, method)),
		Links:           []model.TxnLink{{ToTxnID: doc.id, Amount: dollars(amount), Discount: dollars(disc)}}}
	if method == "Check" {
		t.RefNumber = fmt.Sprintf("%d", 1000+g.rng.Intn(8999))
	}
	if disc != 0 {
		t.Memo = "2% early payment discount taken"
		t.Links[0].DiscountAccountID = p64(g.a("Sales Discounts"))
	}
	id, err := g.save(&t)
	if err != nil {
		return err
	}
	doc.open -= amount + disc
	g.ufPending = append(g.ufPending, id)
	return nil
}

// statementCharges posts the monthly maintenance contracts and schedules their payments.
func (g *gen) statementCharges(d string) error {
	for _, sc := range []struct {
		job    string
		amount float64
	}{{"Seabreeze Apartments:Monthly Maintenance", 950}, {"Oakridge HOA:Common Areas", 1200}} {
		nameID := g.name[sc.job]
		c := g.cust(sc.job[:indexColon(sc.job)])
		t := model.Txn{Type: model.TxStatementCharge, Date: d, NameID: &nameID, ClassID: g.classOf(c), TermsID: p64(g.l(model.ListTerms, c.terms)),
			Lines: []model.TxnLine{{ItemID: p64(g.it("Maintenance Contract")), Description: "Monthly grounds maintenance - " + mustDate(d).Format("January 2006"),
				Qty: pf(1), Rate: pf(sc.amount), Amount: sc.amount}}}
		id, err := g.save(&t)
		if err != nil {
			return err
		}
		doc := &openDoc{id: id, nameID: nameID, date: d, due: t.DueDate, total: cents(t.Amount), open: cents(t.Amount), c: c}
		g.at(addDays(d, g.between(12, 24)+c.lag), func(day string) error { return g.receivePayment(day, doc, doc.open, false) })
	}
	return nil
}

func indexColon(s string) int {
	for i := range s {
		if s[i] == ':' {
			return i
		}
	}
	return len(s)
}

func (g *gen) estimate(d string) error {
	c := g.pickCustomer()
	nameID := g.target(c)
	lines := g.salesLines(c)
	if len(lines) == 0 {
		return nil
	}
	g.describe(lines, false)
	t := model.Txn{Type: model.TxEstimate, Date: d, NameID: &nameID, RefNumber: g.firstRefOf("EST", "501"), ClassID: g.classOf(c),
		TaxItemID: &c.taxItem, BillAddress: c.addr, Status: "Pending", Lines: lines, Memo: "Proposal"}
	if _, err := g.save(&t); err != nil {
		return err
	}
	est := t
	switch k := g.rng.Intn(20); {
	case k < 12: // accepted and invoiced when the work is done
		g.at(addDays(d, g.between(7, 25)), func(day string) error { return g.invoice(day, &est) })
	case k < 15: // rejected
		g.at(addDays(d, g.between(10, 30)), func(day string) error {
			cur, err := ledger.Get(g.ctx, g.tx, est.ID)
			if err != nil {
				return err
			}
			cur.Status = "Rejected"
			_, err = g.save(cur)
			return err
		})
	case k < 17:
		g.at(addDays(d, g.between(3, 12)), func(day string) error {
			cur, err := ledger.Get(g.ctx, g.tx, est.ID)
			if err != nil {
				return err
			}
			cur.Status = "Accepted"
			_, err = g.save(cur)
			return err
		})
	}
	return nil
}

func (g *gen) salesReceipt(d string) error {
	c := g.cust("Cash Sales")
	var lines []model.TxnLine
	add := func(l *model.TxnLine) {
		if l != nil {
			lines = append(lines, *l)
		}
	}
	picks := []struct {
		name   string
		lo, hi int
	}{{"Plants:Lavender 1 gal", 2, 8}, {"Plants:Annual Flats", 1, 4}, {"Plants:Rose Bush 5 gal", 1, 3}, {"Mulch & Soil:Bark Mulch", 1, 2},
		{"Sprinkler Parts:Sprinkler Head", 2, 6}, {"Plants:Boxwood 5 gal", 1, 4}}
	for i, n := 0, g.between(1, 3); i < n; i++ {
		p := picks[g.rng.Intn(len(picks))]
		add(g.invLine(c, p.name, float64(g.between(p.lo, p.hi))))
	}
	if len(lines) == 0 {
		return nil
	}
	g.describe(lines, false)
	method := []string{"Cash", "Visa", "MasterCard", "Visa", "Check"}[g.rng.Intn(5)]
	t := model.Txn{Type: model.TxSalesReceipt, Date: d, NameID: &c.id, RefNumber: g.firstRefOf("SALESRCPT", "3001"),
		ClassID: g.classOf(c), TaxItemID: &c.taxItem, PaymentMethodID: p64(g.l(model.ListPaymentMethod, method)), Lines: lines,
		Memo: "Retail sale"}
	if method == "Check" {
		t.RefNumber = fmt.Sprintf("%d", 100+g.rng.Intn(900))
		t.Memo = "Retail sale (check)"
	}
	id, err := g.save(&t)
	if err != nil {
		return err
	}
	g.ufPending = append(g.ufPending, id)
	return nil
}

// deposit moves the waiting payments to the checking account.
func (g *gen) deposit(d string) error {
	// the payments of the last few days are still waiting to be deposited
	if len(g.ufPending) == 0 || d > addDays(g.today, -3) {
		return nil
	}
	t := model.Txn{Type: model.TxDeposit, Date: d, AccountID: p64(g.a("Checking")), Memo: "Deposit"}
	for _, id := range g.ufPending {
		t.Lines = append(t.Lines, model.TxnLine{Kind: model.LineDeposit, LinkedTxnID: p64(id), Amount: g.amountOf(id)})
	}
	if g.cashBackOK {
		g.cashBackOK = false
		t.CashBackAccountID = p64(g.a("Petty Cash"))
		t.CashBackAmount = 200
		t.CashBackMemo = "Cash for petty cash box"
	}
	if lineTotal(t.Lines)-t.CashBackAmount < 0 {
		t.CashBackAmount, t.CashBackAccountID, t.CashBackMemo = 0, nil, ""
	}
	if _, err := g.save(&t); err != nil {
		return err
	}
	g.ufPending = nil
	return nil
}

func (g *gen) amountOf(id int64) float64 {
	var a int64
	g.tx.QueryRowContext(g.ctx, `SELECT amount FROM txns WHERE id = ?`, id).Scan(&a)
	return dollars(a)
}

// returnCredit: a customer returns plants; the credit memo is applied to an open invoice.
func (g *gen) returnCredit(d string) error {
	c := g.cust("Chen, Lily")
	job := c.jobs[0]
	inv := model.Txn{Type: model.TxInvoice, Date: d, NameID: &job, ClassID: g.classOf(c), TermsID: p64(g.l(model.ListTerms, c.terms)),
		TaxItemID: &c.taxItem, BillAddress: c.addr, Template: "Service Invoice"}
	inv.Lines = append(inv.Lines, g.svcLine("Installation", 12))
	if l := g.invLine(c, "Plants:Rose Bush 5 gal", 8); l != nil {
		inv.Lines = append(inv.Lines, *l)
	}
	g.describe(inv.Lines, false)
	if _, err := g.save(&inv); err != nil {
		return err
	}
	doc := &openDoc{id: inv.ID, nameID: job, date: d, total: cents(inv.Amount), open: cents(inv.Amount), c: c}
	cmDate := addDays(d, 4)
	g.at(cmDate, func(day string) error {
		rose := g.it("Plants:Rose Bush 5 gal")
		cm := model.Txn{Type: model.TxCreditMemo, Date: day, NameID: &job, RefNumber: g.firstRefOf("CREDMEM", "4001"), ClassID: g.classOf(c),
			TaxItemID: &c.taxItem, Memo: "Returned 2 rose bushes (wrong color)",
			Lines: []model.TxnLine{{ItemID: &rose, Description: "Rose bush, 5 gallon (returned)", Qty: pf(2), Rate: pf(29.95), Amount: 59.90, Taxable: c.taxable}}}
		if _, err := g.save(&cm); err != nil {
			return err
		}
		// apply the credit to the invoice
		cm.Links = []model.TxnLink{{ToTxnID: doc.id, Amount: cm.Amount}}
		if _, err := g.save(&cm); err != nil {
			return err
		}
		doc.open -= cents(cm.Amount)
		g.at(addDays(day, g.between(5, 12)), func(d2 string) error { return g.receivePayment(d2, doc, doc.open, false) })
		return nil
	})
	return nil
}

// serviceCreditRefund: a credit for a missed visit, refunded by check.
func (g *gen) serviceCreditRefund(d string) error {
	c := g.cust("Garcia, Elena")
	cm := model.Txn{Type: model.TxCreditMemo, Date: d, NameID: &c.id, ClassID: g.classOf(c), TaxItemID: &c.taxItem,
		Memo: "Credit for missed maintenance visit", Lines: []model.TxnLine{{ItemID: p64(g.it("Maintenance")), Description: "Missed visit credit",
			Qty: pf(3), Rate: pf(55), Amount: 165}}}
	if _, err := g.save(&cm); err != nil {
		return err
	}
	g.at(addDays(d, 5), func(day string) error {
		t := model.Txn{Type: model.TxRefund, Date: day, NameID: &c.id, AccountID: p64(g.a("Checking")), RefNumber: g.nextCheck(),
			Amount: cm.Amount, PaymentMethodID: p64(g.l(model.ListPaymentMethod, "Check")), Memo: "Refund of credit memo " + cm.RefNumber,
			BillAddress: c.addr, Links: []model.TxnLink{{ToTxnID: cm.ID, Amount: cm.Amount}}}
		_, err := g.save(&t)
		return err
	})
	return nil
}

// unappliedCredit leaves an available credit on a customer.
func (g *gen) unappliedCredit(d string) error {
	c := g.cust("Lighthouse Dental Group")
	cm := model.Txn{Type: model.TxCreditMemo, Date: d, NameID: &c.id, ClassID: g.classOf(c), TaxItemID: &c.taxItem,
		Memo: "Goodwill credit - plant replacement", Lines: []model.TxnLine{{ItemID: p64(g.it("Maintenance")), Description: "Goodwill credit",
			Qty: pf(2), Rate: pf(55), Amount: 110}}}
	_, err := g.save(&cm)
	return err
}

// describe fills blank line descriptions from the items (sales or purchase
// description), as the forms do when an item is picked.
func (g *gen) describe(lines []model.TxnLine, purchase bool) {
	for i := range lines {
		l := &lines[i]
		if l.Description != "" || l.ItemID == nil {
			continue
		}
		var d, pd string
		g.tx.QueryRowContext(g.ctx, `SELECT description, purchase_description FROM items WHERE id = ?`, *l.ItemID).Scan(&d, &pd)
		if purchase && pd != "" {
			d = pd
		}
		l.Description = d
	}
}

// ---------------------------------------------------------------------------
// Vendors, purchases and inventory

type expLine struct {
	account string
	amount  float64
	memo    string
}

func (g *gen) expenseLines(ls []expLine) []model.TxnLine {
	var out []model.TxnLine
	for _, e := range ls {
		out = append(out, model.TxnLine{Kind: model.LineExpense, AccountID: p64(g.a(e.account)), Amount: r2(e.amount), Description: e.memo})
	}
	return out
}

func (g *gen) vendorRef() string { return fmt.Sprintf("%d-%04d", 10+g.rng.Intn(80), g.rng.Intn(10000)) }

// expenseBill enters a bill and schedules its payment.
func (g *gen) expenseBill(d, vendor, memo string, ls []expLine) error {
	v := g.vendBy[vendor]
	t := model.Txn{Type: model.TxBill, Date: d, NameID: &v.id, RefNumber: g.vendorRef(), TermsID: p64(g.l(model.ListTerms, v.terms)),
		Memo: memo, Lines: g.expenseLines(ls)}
	return g.enterBill(&t, v)
}

func (g *gen) enterBill(t *model.Txn, v *vend) error {
	if t.BillAddress == "" {
		t.BillAddress = v.addr
	}
	if _, err := g.save(t); err != nil {
		return err
	}
	doc := &openDoc{id: t.ID, nameID: v.id, date: t.Date, due: t.DueDate, total: cents(t.Amount), open: cents(t.Amount), v: v}
	g.scheduleBillPayment(doc)
	return nil
}

func (g *gen) scheduleBillPayment(doc *openDoc) {
	v := doc.v
	if v.discount {
		g.at(addDays(doc.date, g.between(6, 9)), func(d string) error { return g.payBill(d, doc) })
		return
	}
	due := doc.due
	if due == "" {
		due = addDays(doc.date, 10)
	}
	pay := addDays(due, -g.between(0, 4))
	if pay < doc.date {
		pay = doc.date
	}
	if g.chance(0.06) && doc.date > addDays(g.today, -75) {
		pay = addDays(due, 45) // left unpaid: overdue
	}
	g.at(pay, func(d string) error { return g.payBill(d, doc) })
}

// payBill pays a bill in full by check (or credit card), with the terms discount when due.
func (g *gen) payBill(d string, doc *openDoc) error {
	if doc.open <= 0 {
		return nil
	}
	v := doc.v
	var disc int64
	if v != nil && v.discount && d <= addDays(doc.date, 10) {
		disc = int64(math.Round(float64(doc.open) * 0.02))
	}
	amount := doc.open - disc
	t := model.Txn{Type: model.TxBillPayment, Date: d, NameID: &doc.nameID, Amount: dollars(amount),
		Links: []model.TxnLink{{ToTxnID: doc.id, Amount: dollars(amount), Discount: dollars(disc)}}}
	if disc != 0 {
		t.Links[0].DiscountAccountID = p64(g.a("Purchase Discounts"))
	}
	if v != nil && v.card {
		t.AccountID = p64(g.a("Harbor National Visa"))
	} else {
		t.AccountID = p64(g.a("Checking"))
		t.RefNumber = g.nextCheck()
		if v != nil {
			t.BillAddress = v.addr
		}
	}
	if _, err := g.save(&t); err != nil {
		return err
	}
	doc.open = 0
	return nil
}

func (g *gen) writeCheck(d, payee string, ls []expLine) error {
	v := g.vendBy[payee]
	t := model.Txn{Type: model.TxCheck, Date: d, AccountID: p64(g.a("Checking")), NameID: &v.id, RefNumber: g.nextCheck(),
		BillAddress: v.addr, Lines: g.expenseLines(ls)}
	_, err := g.save(&t)
	return err
}

func (g *gen) cardCharge(d, payee string, ls []expLine, credit bool) error {
	v := g.vendBy[payee]
	typ := model.TxCCCharge
	if credit {
		typ = model.TxCCCredit
	}
	t := model.Txn{Type: typ, Date: d, AccountID: p64(g.a("Harbor National Visa")), NameID: &v.id, Lines: g.expenseLines(ls)}
	_, err := g.save(&t)
	return err
}

// cardPayment pays the card balance as of the previous month's statement (the 25th).
func (g *gen) cardPayment(d string) error {
	cc := g.a("Harbor National Visa")
	stmt := dayOf(fmtDate(mustDate(d).AddDate(0, -1, 0)), 25)
	bal := -g.balance(cc, stmt)
	if bal <= 0 {
		return nil
	}
	v := g.vendBy["Harbor National Bank Card Services"]
	t := model.Txn{Type: model.TxCheck, Date: d, AccountID: p64(g.a("Checking")), NameID: &v.id, RefNumber: g.nextCheck(),
		BillAddress: v.addr, Memo: "Visa statement " + mustDate(stmt).Format("01/02/2006"),
		Lines: []model.TxnLine{{Kind: model.LineExpense, AccountID: &cc, Amount: dollars(bal), Description: "Credit card payment"}}}
	_, err := g.save(&t)
	return err
}

func (g *gen) loanPayment(d string) error {
	if g.loanBal <= 0 {
		return nil
	}
	interest := int64(math.Round(float64(g.loanBal) * 0.065 / 12))
	pay := int64(125000)
	principal := pay - interest
	if principal > g.loanBal {
		principal = g.loanBal
	}
	v := g.vendBy["First Harbor Bank"]
	t := model.Txn{Type: model.TxCheck, Date: d, AccountID: p64(g.a("Checking")), NameID: &v.id, RefNumber: g.nextCheck(),
		BillAddress: v.addr, Memo: "Truck loan payment", Lines: []model.TxnLine{
			{Kind: model.LineExpense, AccountID: p64(g.a("Truck Loan")), Amount: dollars(principal), Description: "Principal"},
			{Kind: model.LineExpense, AccountID: p64(g.a("Interest Expense")), Amount: dollars(interest), Description: "Interest"}}}
	if _, err := g.save(&t); err != nil {
		return err
	}
	g.loanBal -= principal
	return nil
}

func (g *gen) ownerDraw(d string, amount float64) error {
	t := model.Txn{Type: model.TxCheck, Date: d, AccountID: p64(g.a("Checking")), NameID: &g.owner, RefNumber: g.nextCheck(),
		BillAddress: "Dana Whitfield\n19 Lookout Ln\nHarborview, CA 94950", Memo: "Owner draw", Lines: []model.TxnLine{{Kind: model.LineExpense, AccountID: p64(g.a("Owners Draw")), Amount: amount, Description: "Owner draw"}}}
	_, err := g.save(&t)
	return err
}

func (g *gen) savingsTransfer(d string) error {
	if g.balance(g.a("Checking"), d) < cents(30000) {
		return nil
	}
	t := model.Txn{Type: model.TxTransfer, Date: d, AccountID: p64(g.a("Checking")), ToAccountID: p64(g.a("Savings")), Amount: 5000,
		Memo: "Quarterly transfer to savings"}
	_, err := g.save(&t)
	return err
}

// monthEnd: depreciation and savings interest.
func (g *gen) monthEnd(d string) error {
	dep, accum := g.a("Depreciation Expense"), g.a("Accumulated Depreciation")
	je := model.Txn{Type: model.TxJournal, Date: d, RefNumber: "DEP-" + mustDate(d).Format("0601"), Memo: "Monthly depreciation",
		Lines: []model.TxnLine{
			{Kind: model.LineJournal, AccountID: &dep, Amount: 1425, Description: "Vehicles 1,133.33 + equipment 291.67"},
			{Kind: model.LineJournal, AccountID: &accum, Amount: -1425, Description: "Monthly depreciation"}}}
	if _, err := g.save(&je); err != nil {
		return err
	}
	sav := g.a("Savings")
	interest := r2(dollars(g.balance(sav, d)) * 0.012 / 12)
	if interest > 0 {
		t := model.Txn{Type: model.TxDeposit, Date: d, AccountID: &sav, Memo: "Interest earned",
			Lines: []model.TxnLine{{Kind: model.LineDeposit, AccountID: p64(g.a("Interest Income")), Amount: interest, Description: "Savings interest"}}}
		if _, err := g.save(&t); err != nil {
			return err
		}
	}
	return nil
}

// salesTaxPayment pays the sales tax owed as of the end of the previous quarter.
func (g *gen) salesTaxPayment(d string) error {
	t := mustDate(d)
	qEnd := fmtDate(time.Date(t.Year(), t.Month(), 0, 0, 0, 0, 0, time.UTC))
	dues, err := ledger.SalesTaxDue(g.ctx, g.tx, qEnd)
	if err != nil {
		return err
	}
	agency := g.vendBy["State Department of Revenue"]
	pay := model.Txn{Type: model.TxSalesTaxPayment, Date: d, AccountID: p64(g.a("Checking")), NameID: &agency.id, RefNumber: g.nextCheck(),
		BillAddress: agency.addr,
		Memo:        "Sales tax through " + mustDate(qEnd).Format("01/02/2006"),
		Extra:       map[string]any{"salesTaxThrough": qEnd}}
	for _, du := range dues {
		if du.AmountDue <= 0 {
			continue
		}
		id := du.TaxItemID
		pay.Lines = append(pay.Lines, model.TxnLine{Kind: model.LineItem, ItemID: &id, Amount: du.AmountDue, Description: du.TaxItemName})
	}
	if len(pay.Lines) == 0 {
		g.check--
		return nil
	}
	_, err = g.save(&pay)
	return err
}

// reorder buys inventory that fell to its reorder point: purchase orders to
// the nursery, stone and irrigation suppliers, a direct bill for mulch and soil.
func (g *gen) reorder(d string) error {
	byVendor := map[string][]*invItem{}
	var order []string
	for _, ii := range g.invs {
		q := g.qtyOnHand(ii.id) + g.onPO[ii.id]
		if q > ii.reorder {
			continue
		}
		if _, ok := byVendor[ii.vendor]; !ok {
			order = append(order, ii.vendor)
		}
		byVendor[ii.vendor] = append(byVendor[ii.vendor], ii)
	}
	for _, vn := range order {
		v := g.vendBy[vn]
		var lines []model.TxnLine
		for _, ii := range byVendor[vn] {
			q := math.Round(ii.max - g.qtyOnHand(ii.id) - g.onPO[ii.id])
			if q <= 0 {
				continue
			}
			cost := r2(ii.cost * (0.97 + 0.06*g.rng.Float64()))
			lines = append(lines, model.TxnLine{ItemID: p64(ii.id), Qty: pf(q), Rate: pf(cost), Amount: r2(q * cost)})
		}
		if len(lines) == 0 {
			continue
		}
		g.describe(lines, true)
		if vn == "GreenGrow Mulch & Soil" {
			t := model.Txn{Type: model.TxBill, Date: d, NameID: &v.id, RefNumber: g.vendorRef(), TermsID: p64(g.l(model.ListTerms, v.terms)),
				Memo: "Bulk materials delivery", Lines: lines}
			if err := g.enterBill(&t, v); err != nil {
				return err
			}
			continue
		}
		po := model.Txn{Type: model.TxPurchaseOrder, Date: d, NameID: &v.id, RefNumber: g.firstRefOf("PURCHORD", "6001"),
			Memo: "Restock", ShipAddress: "Harborview Landscaping & Supply\n1450 Harbor Way\nHarborview, CA 94950", Lines: lines}
		if _, err := g.save(&po); err != nil {
			return err
		}
		for _, l := range po.Lines {
			g.onPO[*l.ItemID] += *l.Qty
		}
		poCopy := po
		partial := g.chance(0.15)
		g.at(addDays(d, g.between(4, 9)), func(day string) error { return g.receiveItems(day, v, &poCopy, partial) })
	}
	return nil
}

// crewLabor: the weekly bill of the subcontracted field crews, split by class.
func (g *gen) crewLabor(d string, f float64) error {
	v := g.vendBy["Coastline Labor Services"]
	total := float64(int((800+950*f)*(0.85+0.3*g.rng.Float64()))/10) * 10
	res := r2(total * 0.65)
	sub := g.a("Job Expenses:Subcontractors")
	t := model.Txn{Type: model.TxBill, Date: d, NameID: &v.id, RefNumber: "CLS-" + mustDate(d).Format("060102"),
		TermsID: p64(g.l(model.ListTerms, v.terms)), Memo: "Field crew labor, week of " + mustDate(d).Format("01/02/2006"),
		Lines: []model.TxnLine{
			{Kind: model.LineExpense, AccountID: &sub, Amount: res, Description: "Crew labor - residential jobs", ClassID: p64(g.l(model.ListClass, "Residential"))},
			{Kind: model.LineExpense, AccountID: &sub, Amount: r2(total - res), Description: "Crew labor - commercial jobs", ClassID: p64(g.l(model.ListClass, "Commercial"))},
		}}
	return g.enterBill(&t, v)
}

// receiptPending: irrigation parts received a few days ago, bill to follow.
func (g *gen) receiptPending(d string) error {
	v := g.vendBy["AquaFlow Irrigation Supply"]
	head, timer := g.it("Sprinkler Parts:Sprinkler Head"), g.it("Sprinkler Parts:Irrigation Timer")
	po := model.Txn{Type: model.TxPurchaseOrder, Date: d, NameID: &v.id, Memo: "Fall irrigation jobs",
		ShipAddress: "Harborview Landscaping & Supply\n1450 Harbor Way\nHarborview, CA 94950",
		Lines: []model.TxnLine{{ItemID: &head, Description: "Pop-up sprinkler head", Qty: pf(48), Rate: pf(3.3), Amount: 158.40},
			{ItemID: &timer, Description: "6-zone irrigation timer", Qty: pf(4), Rate: pf(48.5), Amount: 194}}}
	if _, err := g.save(&po); err != nil {
		return err
	}
	g.at(addDays(d, 2), func(day string) error {
		t := model.Txn{Type: model.TxItemReceipt, Date: day, NameID: &v.id, Lines: []model.TxnLine{
			{ItemID: &head, Description: "Pop-up sprinkler head", Qty: pf(48), Rate: pf(3.3), Amount: 158.40, LinkedLineID: p64(po.Lines[0].ID)},
			{ItemID: &timer, Description: "6-zone irrigation timer", Qty: pf(4), Rate: pf(48.5), Amount: 194, LinkedLineID: p64(po.Lines[1].ID)}}}
		_, err := g.save(&t)
		return err
	})
	return nil
}

// receiveItems receives a purchase order (in full, or 60% now and the rest a week later).
func (g *gen) receiveItems(d string, v *vend, po *model.Txn, partial bool) error {
	cur, err := ledger.Get(g.ctx, g.tx, po.ID)
	if err != nil {
		return err
	}
	var lines []model.TxnLine
	for _, l := range cur.Lines {
		if l.Qty == nil || l.ItemID == nil {
			continue
		}
		q := *l.Qty - l.ReceivedQty
		if partial {
			q = math.Floor(q * 0.6)
		}
		if q <= 0 {
			continue
		}
		lines = append(lines, model.TxnLine{ItemID: l.ItemID, Description: l.Description, Qty: pf(q), Rate: l.Rate,
			Amount: r2(q * *l.Rate), LinkedLineID: p64(l.ID)})
		g.onPO[*l.ItemID] -= q
	}
	if len(lines) == 0 {
		return nil
	}
	t := model.Txn{Type: model.TxItemReceipt, Date: d, NameID: &v.id, Lines: lines}
	if _, err := g.save(&t); err != nil {
		return err
	}
	if partial {
		g.at(addDays(d, g.between(6, 10)), func(day string) error { return g.receiveItems(day, v, po, false) })
	}
	rcpt := t.ID
	g.at(addDays(d, g.between(2, 6)), func(day string) error {
		bill, err := ledger.Get(g.ctx, g.tx, rcpt)
		if err != nil {
			return err
		}
		bill.Type = model.TxBill
		bill.Date = day
		bill.DueDate = ""
		bill.RefNumber = g.vendorRef()
		bill.TermsID = p64(g.l(model.ListTerms, v.terms))
		if _, err := g.save(bill); err != nil {
			return err
		}
		doc := &openDoc{id: bill.ID, nameID: v.id, date: day, due: bill.DueDate, total: cents(bill.Amount), open: cents(bill.Amount), v: v}
		g.scheduleBillPayment(doc)
		return nil
	})
	return nil
}

// treeWork: an arborist bill for a customer's job (job cost, not billable).
func (g *gen) treeWork(d string) error {
	c := g.pickCustomer()
	if !c.commercial && len(c.jobs) == 0 {
		return nil
	}
	job := g.target(c)
	v := g.vendBy["Treeline Arborists"]
	n := float64(g.between(1, 3))
	t := model.Txn{Type: model.TxBill, Date: d, NameID: &v.id, RefNumber: g.vendorRef(), TermsID: p64(g.l(model.ListTerms, v.terms)),
		Lines: []model.TxnLine{{ItemID: p64(g.it("Tree Trimming")), Description: "Tree trimming", Qty: pf(n), Rate: pf(240), Amount: r2(240 * n),
			NameID: &job, ClassID: g.classOf(c)}}}
	if err := g.enterBill(&t, v); err != nil {
		return err
	}
	// the work is billed to the customer the same week
	g.at(addDays(d, g.between(1, 5)), func(day string) error {
		inv := model.Txn{Type: model.TxInvoice, Date: day, NameID: &job, ClassID: g.classOf(c), TermsID: p64(g.l(model.ListTerms, c.terms)),
			TaxItemID: &c.taxItem, BillAddress: c.addr, Template: "Service Invoice",
			Lines: []model.TxnLine{{ItemID: p64(g.it("Tree Trimming")), Description: "Tree trimming and cleanup", Qty: pf(n), Rate: pf(350), Amount: r2(350 * n)}}}
		if _, err := g.save(&inv); err != nil {
			return err
		}
		doc := &openDoc{id: inv.ID, nameID: job, date: day, due: inv.DueDate, total: cents(inv.Amount), open: cents(inv.Amount), c: c}
		g.schedulePayment(doc)
		return nil
	})
	return nil
}

// billableWork: a hardscape subcontractor bill marked billable to a job and
// later invoiced to the customer with a markup (Add Time/Costs).
func (g *gen) billableWork(d string) error {
	// the 1st and 3rd for the Hughes retaining wall, the 2nd for the Lambert patio;
	// the 3rd (this month) is not invoiced yet, so it shows as an unbilled cost
	n := len(g.billables)
	c := g.cust("Hughes, Martin")
	job := c.jobs[0]
	if n == 1 {
		c = g.cust("Lambert, Grace")
		job = c.jobs[1]
	}
	v := g.vendBy["Ortega Hardscape Crew"]
	cost := float64(g.between(18, 34)) * 100
	t := model.Txn{Type: model.TxBill, Date: d, NameID: &v.id, RefNumber: g.vendorRef(), TermsID: p64(g.l(model.ListTerms, v.terms)),
		Memo: "Hardscape crew", Lines: []model.TxnLine{{ItemID: p64(g.it("Hardscape Subcontract")), Description: "Stone wall and steps - crew of 3",
			Qty: pf(1), Rate: pf(cost), Amount: cost, NameID: &job, Billable: true, ClassID: g.classOf(c)}}}
	if err := g.enterBill(&t, v); err != nil {
		return err
	}
	b := billable{lineID: t.Lines[0].ID, itemID: g.it("Hardscape Subcontract"), nameID: job, amount: cents(cost), date: d}
	g.billables = append(g.billables, b)
	if n >= 2 {
		return nil
	}
	g.at(addDays(d, g.between(6, 12)), func(day string) error {
		price := r2(dollars(b.amount) * 1.2)
		inv := model.Txn{Type: model.TxInvoice, Date: day, NameID: &job, ClassID: g.classOf(c), TermsID: p64(g.l(model.ListTerms, c.terms)),
			TaxItemID: &c.taxItem, BillAddress: c.addr, Template: "Service Invoice", Memo: "Hardscape work",
			Lines: []model.TxnLine{
				{ItemID: p64(b.itemID), Description: "Stone wall and steps (subcontracted crew)", Qty: pf(1), Rate: pf(price), Amount: price,
					LinkedTxnID: p64(t.ID), LinkedLineID: p64(b.lineID)},
				g.svcLine("Design", 4)}}
		g.describe(inv.Lines, false)
		if _, err := g.save(&inv); err != nil {
			return err
		}
		doc := &openDoc{id: inv.ID, nameID: job, date: day, due: inv.DueDate, total: cents(inv.Amount), open: cents(inv.Amount), c: c}
		g.schedulePayment(doc)
		return nil
	})
	return nil
}

// shrinkage: plants lost to frost and damage (quantity adjustment).
func (g *gen) shrinkage(d string) error {
	var lines []model.TxnLine
	for _, x := range []struct {
		name string
		q    float64
	}{{"Plants:Japanese Maple 15 gal", -1}, {"Plants:Lavender 1 gal", -6}, {"Plants:Annual Flats", -2}} {
		id := g.it(x.name)
		if g.qtyOnHand(id) >= -x.q {
			lines = append(lines, model.TxnLine{ItemID: &id, Qty: pf(x.q), Description: "Dead / damaged plants"})
		}
	}
	if len(lines) == 0 {
		return nil
	}
	t := model.Txn{Type: model.TxInventoryAdjust, Date: d, AccountID: p64(g.a("Inventory Adjustments")), RefNumber: "ADJ-" + mustDate(d).Format("0601"),
		Memo: "Physical count - plant shrinkage", Lines: lines}
	_, err := g.save(&t)
	return err
}
