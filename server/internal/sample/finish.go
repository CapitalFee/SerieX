package sample

// Month-end reconciliations of the checking account, recent bank feed
// downloads, and the planning data (memorized transactions, budget, to dos,
// bank rules).

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"seriex/internal/banking"
	"seriex/internal/company"
	"seriex/internal/model"
)

// reconcileChecking reconciles the checking account for every statement
// (month end) up to two months ago. A statement clears the deposits and
// transfers dated on or before its date and the checks dated at least four
// days before it (later checks are still outstanding); the bank charges a
// $12.00 monthly service fee entered with the reconciliation.
func (g *gen) reconcileChecking() error {
	chk := g.a("Checking")
	t0 := mustDate(g.today)
	lastStmt := fmtDate(time.Date(t0.Year(), t0.Month()-1, 0, 0, 0, 0, 0, time.UTC))
	fee := g.a("Bank Service Charges")
	for t := mustDate(g.start); ; t = t.AddDate(0, 1, 0) {
		stmt := monthEnd(fmtDate(t))
		if stmt > lastStmt {
			break
		}
		checkCut := addDays(stmt, -4)
		rows, err := g.tx.QueryContext(g.ctx, `SELECT g.id, g.amount, g.date, t.type FROM gl_entries g JOIN txns t ON t.id = g.txn_id
			WHERE g.account_id = ? AND g.cleared <> 'R' AND g.date <= ? ORDER BY g.date, g.id`, chk, stmt)
		if err != nil {
			return err
		}
		var ids []int64
		var cleared int64
		for rows.Next() {
			var id, amt int64
			var date, typ string
			if err := rows.Scan(&id, &amt, &date, &typ); err != nil {
				rows.Close()
				return err
			}
			isCheck := amt < 0 && (typ == model.TxCheck || typ == model.TxBillPayment || typ == model.TxSalesTaxPayment || typ == model.TxRefund)
			if isCheck && date > checkCut {
				continue
			}
			ids = append(ids, id)
			cleared += amt
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		var begin int64
		if err := g.tx.QueryRowContext(g.ctx, `SELECT IFNULL(SUM(amount), 0) FROM gl_entries WHERE account_id = ? AND cleared = 'R'`, chk).Scan(&begin); err != nil {
			return err
		}
		ending := begin + cleared - 1200
		f := model.ReconcileFinish{StatementDate: stmt, EndingBalance: dollars(ending), ClearedGLIDs: ids,
			ServiceCharge: &model.ReconcileAdj{Amount: 12, Date: stmt, AccountID: &fee}}
		if _, err := banking.FinishReconcile(g.ctx, g.tx, chk, f, g.opt); err != nil {
			return fmt.Errorf("reconcile %s: %w", stmt, err)
		}
	}
	return nil
}

// bankFeeds imports the last three weeks of the checking and credit card
// downloads: most lines match transactions already entered, a few are new.
func (g *gen) bankFeeds() error {
	from := addDays(g.today, -21)
	cutoff := addDays(g.today, -2) // the newest checks have not reached the bank yet
	type feedLine struct {
		date, desc, check string
		amount            int64
	}
	collect := func(acct int64, card bool) ([]feedLine, error) {
		rows, err := g.tx.QueryContext(g.ctx, `SELECT t.date, t.type, t.ref_number, IFNULL(n.name, ''), SUM(g.amount)
			FROM gl_entries g JOIN txns t ON t.id = g.txn_id LEFT JOIN names n ON n.id = t.name_id
			WHERE g.account_id = ? AND t.date >= ? AND t.date <= ? GROUP BY t.id ORDER BY t.date, t.id`, acct, from, cutoff)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var out []feedLine
		for rows.Next() {
			var date, typ, ref, name string
			var amt int64
			if err := rows.Scan(&date, &typ, &ref, &name, &amt); err != nil {
				return nil, err
			}
			if amt == 0 {
				continue
			}
			// feed sign = ledger sign: deposits and card payments are money in (+),
			// checks and card charges money out (-)
			fl := feedLine{date: addDays(date, 1), amount: amt}
			if fl.date > g.today {
				fl.date = g.today
			}
			up := strings.ToUpper(name)
			switch {
			case card:
				fl.desc = up
				if amt > 0 {
					fl.desc = "PAYMENT THANK YOU"
				}
			case typ == model.TxDeposit:
				fl.desc = "DEPOSIT"
				fl.date = date
			case typ == model.TxTransfer:
				fl.desc = "ONLINE TRANSFER TO SAVINGS"
				fl.date = date
			case ref != "" && (typ == model.TxCheck || typ == model.TxBillPayment || typ == model.TxSalesTaxPayment || typ == model.TxRefund):
				fl.desc, fl.check = "CHECK "+ref, ref
			default:
				fl.desc = "ACH DEBIT " + up
			}
			out = append(out, fl)
		}
		return out, rows.Err()
	}
	csv := func(lines []feedLine) []byte {
		sort.SliceStable(lines, func(i, j int) bool { return lines[i].date < lines[j].date })
		var b strings.Builder
		b.WriteString("Date,Description,Amount,Check Number\n")
		for _, l := range lines {
			fmt.Fprintf(&b, "%s,\"%s\",%.2f,%s\n", mustDate(l.date).Format("01/02/2006"), l.desc, dollars(l.amount), l.check)
		}
		return []byte(b.String())
	}
	chk, cc := g.a("Checking"), g.a("Harbor National Visa")
	lines, err := collect(chk, false)
	if err != nil {
		return err
	}
	d := func(n int) string { return addDays(g.today, -n) }
	lines = append(lines,
		feedLine{date: d(9), desc: "HARBOR FUEL CO 0042", amount: -7210},
		feedLine{date: d(6), desc: "HARBOR HARDWARE #12 PURCHASE", amount: -8643},
		feedLine{date: d(4), desc: "COASTAL COFFEE ROASTERS", amount: -1875},
		feedLine{date: d(3), desc: "WIRE TRANSFER FEE", amount: -1500},
		feedLine{date: d(1), desc: "MOBILE DEPOSIT", amount: 48500})
	if _, err := banking.ImportFeed(g.ctx, g.tx, chk, csv(lines)); err != nil {
		return fmt.Errorf("checking feed: %w", err)
	}
	lines, err = collect(cc, true)
	if err != nil {
		return err
	}
	lines = append(lines,
		feedLine{date: d(8), desc: "BAYSIDE DELI", amount: -2740},
		feedLine{date: d(5), desc: "HARBOR HARDWARE #12", amount: -4218},
		feedLine{date: d(2), desc: "HARBOR FUEL CO 0042", amount: -11235})
	if _, err := banking.ImportFeed(g.ctx, g.tx, cc, csv(lines)); err != nil {
		return fmt.Errorf("card feed: %w", err)
	}

	fuel := g.a("Automobile Expense:Fuel")
	fuelVendor := g.vendBy["Harbor Fuel Co."].id
	meals := g.a("Meals and Entertainment")
	tools := g.a("Small Tools and Equipment")
	hw := g.vendBy["Harbor Hardware"].id
	for _, r := range []model.BankRule{
		{Name: "Truck fuel", MatchText: "HARBOR FUEL", Direction: "out", RenameTo: "Harbor Fuel Co.", NameID: &fuelVendor, TargetAccountID: &fuel, Priority: 1},
		{Name: "Hardware store", MatchText: "HARBOR HARDWARE", Direction: "out", RenameTo: "Harbor Hardware", NameID: &hw, TargetAccountID: &tools, Priority: 2},
		{Name: "Coffee and meals", MatchText: "COFFEE", Direction: "out", TargetAccountID: &meals, Priority: 3},
	} {
		rule := r
		if _, err := banking.CreateRule(g.ctx, g.tx, &rule); err != nil {
			return err
		}
	}
	return nil
}

// planning: utilities reminder, budget for the current fiscal year, to dos.
func (g *gen) planning() error {
	water := g.vendBy["Harborview Water Department"].id
	power := g.vendBy["Bayview Power & Light"].id
	util := g.a("Utilities")
	t0 := mustDate(g.today)
	nextMonth := time.Date(t0.Year(), t0.Month()+1, 1, 0, 0, 0, 0, time.UTC)
	for _, m := range []model.MemorizedTxn{
		{Name: "Electric - Bayview Power & Light", TxnType: model.TxBill, Schedule: "remind", Frequency: "monthly",
			NextDate: fmtDate(nextMonth.AddDate(0, 0, 7)), DaysInAdvance: 30, GroupName: "Monthly bills",
			Template: model.Txn{Type: model.TxBill, NameID: &power, TermsID: p64(g.l(model.ListTerms, "Net 15")),
				Lines: []model.TxnLine{{Kind: model.LineExpense, AccountID: &util, Amount: 300, Description: "Electric service"}}}},
		{Name: "Water - Harborview Water Department", TxnType: model.TxBill, Schedule: "remind", Frequency: "monthly",
			NextDate: fmtDate(nextMonth.AddDate(0, 0, 9)), DaysInAdvance: 30, GroupName: "Monthly bills",
			Template: model.Txn{Type: model.TxBill, NameID: &water, TermsID: p64(g.l(model.ListTerms, "Net 15")),
				Lines: []model.TxnLine{{Kind: model.LineExpense, AccountID: &util, Amount: 250, Description: "Water and irrigation meter"}}}},
		{Name: "Seabreeze maintenance invoice", TxnType: model.TxInvoice, Schedule: "none", Frequency: "never",
			Template: model.Txn{Type: model.TxInvoice, NameID: p64(g.name["Seabreeze Apartments:Courtyard Remodel"]),
				ClassID: p64(g.l(model.ListClass, "Commercial")), TaxItemID: p64(g.it("Harborview Combined")),
				Lines: []model.TxnLine{{Kind: model.LineItem, ItemID: p64(g.it("Maintenance")), Qty: pf(8), Rate: pf(55), Amount: 440}}}},
	} {
		mm := m
		if _, err := company.CreateMemorized(g.ctx, g.tx, &mm); err != nil {
			return err
		}
	}

	// budget: last year's monthly actuals (or this year's where last year has none) + 8%, rounded to $10
	fy := t0.Year()
	rows, err := g.tx.QueryContext(g.ctx, `SELECT g.account_id, CAST(substr(g.date, 6, 2) AS INTEGER), CAST(substr(g.date, 1, 4) AS INTEGER), SUM(g.amount)
		FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE a.type IN ('Income','Cost of Goods Sold','Expense','Other Income','Other Expense') AND g.date >= ? AND g.date <= ?
		GROUP BY g.account_id, substr(g.date, 1, 7)`, fmt.Sprintf("%d-01-01", fy-1), g.today)
	if err != nil {
		return err
	}
	type key struct {
		acct int64
		year int
	}
	sums := map[key]*[13]int64{}
	var accts []int64
	seen := map[int64]bool{}
	for rows.Next() {
		var acct, amt int64
		var mon, year int
		if err := rows.Scan(&acct, &mon, &year, &amt); err != nil {
			rows.Close()
			return err
		}
		k := key{acct, year}
		if sums[k] == nil {
			sums[k] = &[13]int64{}
		}
		sums[k][mon] += amt
		if !seen[acct] {
			seen[acct] = true
			accts = append(accts, acct)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	sort.Slice(accts, func(i, j int) bool { return accts[i] < accts[j] })
	b := model.Budget{Name: fmt.Sprintf("FY%d Operating Budget", fy), FiscalYear: fy, Kind: "pl", Criteria: "none"}
	for _, acct := range accts {
		var typ string
		g.tx.QueryRowContext(g.ctx, `SELECT type FROM accounts WHERE id = ?`, acct).Scan(&typ)
		sign := int64(1)
		if !model.IsDebitNormal(typ) {
			sign = -1
		}
		line := model.BudgetLine{AccountID: acct}
		any := false
		for mon := 1; mon <= 12; mon++ {
			var v int64
			if prev := sums[key{acct, fy - 1}]; prev != nil && prev[mon] != 0 {
				v = prev[mon]
			} else if cur := sums[key{acct, fy}]; cur != nil {
				v = cur[mon]
			}
			amt := float64(sign*v) * 1.08 / 100
			amt = float64(int64(amt/10+0.5)) * 10
			if amt != 0 {
				any = true
			}
			line.Amounts[mon-1] = amt
		}
		if any {
			b.Lines = append(b.Lines, line)
		}
	}
	if _, err := company.CreateBudget(g.ctx, g.tx, &b); err != nil {
		return err
	}

	lambert := g.name["Lambert, Grace:Landscape Lighting"]
	bayfront := g.name["Bayfront Medical Plaza"]
	hoa := g.name["Oakridge HOA"]
	for _, td := range []model.Todo{
		{Title: "Call Grace Lambert about the lighting estimate", Notes: "She asked for low-voltage path lights and two uplights.", DueDate: addDays(g.today, 2), NameID: &lambert},
		{Title: "Follow up on overdue invoices", Notes: "Send statements to customers more than 30 days past due.", DueDate: addDays(g.today, -1), NameID: &bayfront},
		{Title: "Renew city business license", Notes: "License expires at the end of next month.", DueDate: addDays(g.today, 12)},
		{Title: "Order spring bulbs", Notes: "Tulips and daffodils for the HOA entrance beds.", DueDate: addDays(g.today, -20), NameID: &hoa, Done: true},
	} {
		x := td
		if _, err := company.CreateTodo(g.ctx, g.tx, &x); err != nil {
			return err
		}
	}
	return nil
}
