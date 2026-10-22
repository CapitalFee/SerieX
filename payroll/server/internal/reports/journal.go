package reports

import (
	"sort"
	"strings"

	"seriexpayroll/internal/model"
)

// Payroll Journal (SerieX Books postings): the debits and credits of every
// payroll record that is posted to SerieX Books (sync status "posted"),
// dated by its SerieX Books date, built with the posting rules (postings.go):
// paychecks and tax payments credit the bank account; adjustments are
// journal entries. Voided records are listed with zero amounts (SerieX Books
// keeps voided checks without amounts). The account totals at the end are the
// net change of each SerieX Books account in the range; they tie to the
// SerieX Books trial balance of a company file whose only transactions in
// those accounts are payroll's.

func payrollJournal(e *env) (*model.ReportResult, error) {
	p := e.p
	txns, err := e.postings(p.From, p.To, p.EmployeeID, true)
	if err != nil {
		return nil, err
	}
	lk := e.lookups()
	acctName := func(id *int64) string {
		if id == nil {
			return "(no account)"
		}
		if n := lk.AccountName(id); n != "" {
			return n
		}
		return "SerieX Books account #" + itoa(*id)
	}
	res := e.newResult("Payroll Journal (SerieX Books postings)", false, labelCol(), col("trans", "Trans #", "text"),
		col("type", "Type", "text"), col("date", "Date", "date"), col("num", "Num", "text"), col("name", "Name", "text"),
		col("memo", "Memo", "text"), col("account", "Account", "text"), col("debit", "Debit", "money"),
		col("credit", "Credit", "money"))
	type acctTot struct {
		id     *int64
		name   string
		dr, cr int64
	}
	accts := map[string]*acctTot{}
	acctKey := func(id *int64) string {
		if id == nil {
			return "-"
		}
		return itoa(*id)
	}
	var dr, cr int64
	notPosted := 0
	for _, t := range txns {
		if !t.Posted {
			if !t.NoPost && !(t.Voided && t.TxnID == nil) {
				notPosted++
			}
			continue
		}
		g := e.group()
		var tdr, tcr int64
		first := true
		emit := func(l postLine, amount int64, zero bool) {
			c := map[string]any{"label": "", "trans": itoa(*t.TxnID), "type": t.Type, "date": t.Date, "num": t.Num,
				"name": t.Name, "memo": t.Memo, "account": acctName(l.AccountID)}
			if l.Side != sideBank && l.Desc != "" {
				c["memo"] = l.Desc
			}
			if !first {
				c["trans"], c["type"], c["date"], c["num"] = "", "", nil, ""
			}
			switch {
			case zero:
				c["debit"] = 0.0
			case amount > 0:
				c["debit"] = dollars(amount)
				tdr += amount
			case amount < 0:
				c["credit"] = dollars(-amount)
				tcr -= amount
			}
			r := addRow(res, "data", 0, g, c)
			r.Target = t.Target
			first = false
			if !zero && amount != 0 {
				k := acctKey(l.AccountID)
				a := accts[k]
				if a == nil {
					a = &acctTot{id: l.AccountID, name: acctName(l.AccountID)}
					accts[k] = a
				}
				if amount > 0 {
					a.dr += amount
				} else {
					a.cr -= amount
				}
			}
		}
		if t.Voided {
			// SerieX Books keeps the voided transaction without amounts
			acct := t.Bank
			if t.Entity == "adjustment" && len(t.Lines) > 0 {
				acct = t.Lines[0].AccountID
			}
			emit(postLine{AccountID: acct, Side: sideBank}, 0, true)
		} else {
			for _, l := range t.Lines {
				if l.Amount == 0 {
					continue
				}
				emit(l, l.Amount, false)
			}
			if first {
				emit(postLine{AccountID: t.Bank, Side: sideBank}, 0, true)
			}
		}
		addRow(res, "subtotal", 0, g, map[string]any{"label": "", "debit": dollars(tdr), "credit": dollars(tcr)})
		dr += tdr
		cr += tcr
	}
	addRow(res, "grandtotal", 0, "", map[string]any{"label": "TOTAL", "debit": dollars(dr), "credit": dollars(cr)})

	// account totals (net debit or credit of each account)
	list := make([]*acctTot, 0, len(accts))
	for _, a := range accts {
		list = append(list, a)
	}
	sort.Slice(list, func(i, j int) bool {
		a, b := strings.ToLower(list[i].name), strings.ToLower(list[j].name)
		if a != b {
			return a < b
		}
		return acctKey(list[i].id) < acctKey(list[j].id)
	})
	if len(list) > 0 {
		addRow(res, "blank", 0, "", nil)
		g := e.group()
		addRow(res, "section", 0, g, map[string]any{"label": "Account Totals"})
		var tdr, tcr int64
		for _, a := range list {
			net := a.dr - a.cr
			c := map[string]any{"label": a.name}
			if net >= 0 {
				c["debit"] = dollars(net)
				tdr += net
			} else {
				c["credit"] = dollars(-net)
				tcr -= net
			}
			r := addRow(res, "data", 1, g, c)
			if a.id != nil {
				r.Drill = drill("payroll_transaction_detail", "from", p.From, "to", p.To)
			}
		}
		addRow(res, "subtotal", 0, g, map[string]any{"label": "Total Account Totals", "debit": dollars(tdr), "credit": dollars(tcr)})
	}
	if notPosted > 0 {
		addRow(res, "blank", 0, "", nil)
		msg := "1 payroll record dated in this period is not posted to SerieX Books yet (see SerieX Books Sync)."
		if notPosted > 1 {
			msg = itoa(int64(notPosted)) + " payroll records dated in this period are not posted to SerieX Books yet (see SerieX Books Sync)."
		}
		addRow(res, "data", 0, "", map[string]any{"label": msg})
	}
	return res, nil
}
