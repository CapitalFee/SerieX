package reports

import (
	"database/sql"
	"fmt"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

// The SerieX Books postings of payroll records, built with exactly the rules
// of package posting: a paycheck is a check
// (bank -net; earnings/additions +amount to the item expense account;
// deductions/employee taxes -amount to the item liability account; employer
// taxes/contributions +amount expense and -amount liability; zero amounts and
// not-paid items skipped), a liability payment is a check (item lines +amount
// to the liability account, expense lines +amount to their account, bank
// -amount), and a liability adjustment that affects accounts is a journal
// entry (+A expense side, -A liability). Positive amounts are debits.

// sides of a posting line
const (
	sideBank      = "bank"
	sideExpense   = "expense"
	sideLiability = "liability"
)

// postLine is one SerieX Books line.
type postLine struct {
	AccountID *int64
	Amount    int64 // debit +, credit -
	ItemID    int64 // 0 for bank and expense lines of tax payments
	Desc      string
	WageBase  int64
	Side      string // bank | expense | liability
}

// postTxn is one payroll record as it is (or would be) posted to SerieX Books.
type postTxn struct {
	Entity  string // paycheck | liability_payment | adjustment
	ID      int64
	Type    string // Paycheck | Year-to-Date Entry | Tax Payment | Earlier Tax Payment | Tax Adjustment
	Date    string // SerieX Books transaction date
	Num     string
	Name    string // payee / source name
	NameKey string // grouping key of the payee ("e<id>", "v<id>", "c")
	EmpID   int64  // employee of a paycheck / employee adjustment
	Memo    string
	Bank    *int64
	Total   int64 // check amount (net pay, payment amount) or journal debits
	Lines   []postLine
	Posted  bool   // in SerieX Books now (sync_status posted with a Books transaction)
	NoPost  bool   // never posted by design (year-to-date entries, earlier tax payments, adjustments not affecting accounts)
	Status  string // sync_status
	Voided  bool
	TxnID   *int64
	Problem string // why the transaction cannot be built (missing accounts)
	Target  *model.ReportTarget
}

func withMemo(base, memo string) string {
	if memo == "" {
		return base
	}
	return base + " " + memo
}

// paycheckPosting builds the Books check of a paycheck.
func paycheckPosting(p *paycheck, its itemSet) *postTxn {
	t := &postTxn{Entity: posting.EntityPaycheck, ID: p.ID, Type: pcType(p), Date: p.CheckDate, Num: checkNum(p),
		Name: p.EmployeeName, NameKey: "e" + itoa(p.EmployeeID), EmpID: p.EmployeeID, Bank: p.BankAccountID, Total: p.Net, Voided: p.Voided,
		TxnID: p.BooksTxnID, Status: p.SyncStatus, Target: target("paycheck", p.ID),
		Memo: withMemo(fmt.Sprintf("Pay Period: %s - %s", mdy(p.PeriodStart), mdy(p.PeriodEnd)), p.Memo)}
	t.NoPost = p.Kind == model.PaycheckYTD
	t.Posted = !t.NoPost && p.SyncStatus == "posted" && p.BooksTxnID != nil
	t.Lines = append(t.Lines, postLine{AccountID: p.BankAccountID, Amount: -p.Net, Side: sideBank})
	var sum int64
	for _, l := range p.Lines {
		it := its.get(l.ItemID)
		if l.Amount == 0 || it.NotPaid {
			continue
		}
		switch l.Category {
		case model.CatEarning, model.CatAddition:
			t.Lines = append(t.Lines, postLine{AccountID: it.ExpenseAccountID, Amount: l.Amount, ItemID: it.ID, Desc: it.Name, WageBase: l.WageBase, Side: sideExpense})
			sum += l.Amount
			if it.ExpenseAccountID == nil {
				t.Problem = "Payroll item " + it.Name + " has no expense account."
			}
		case model.CatDeduction, model.CatEmployeeTax:
			t.Lines = append(t.Lines, postLine{AccountID: it.LiabilityAccountID, Amount: -l.Amount, ItemID: it.ID, Desc: it.Name, WageBase: l.WageBase, Side: sideLiability})
			sum -= l.Amount
			if it.LiabilityAccountID == nil {
				t.Problem = "Payroll item " + it.Name + " has no liability account."
			}
		case model.CatEmployerTax, model.CatContribution:
			t.Lines = append(t.Lines,
				postLine{AccountID: it.ExpenseAccountID, Amount: l.Amount, ItemID: it.ID, Desc: it.Name, WageBase: l.WageBase, Side: sideExpense},
				postLine{AccountID: it.LiabilityAccountID, Amount: -l.Amount, ItemID: it.ID, Desc: it.Name, WageBase: l.WageBase, Side: sideLiability})
			if it.ExpenseAccountID == nil || it.LiabilityAccountID == nil {
				t.Problem = "Payroll item " + it.Name + " has no expense/liability account."
			}
		}
	}
	if t.Problem == "" && sum != p.Net {
		t.Problem = fmt.Sprintf("The paycheck lines (%s) do not add up to the net pay (%s).", fmtMoney(sum), fmtMoney(p.Net))
	}
	return t
}

// paymentPosting builds the Books check of a liability payment.
func paymentPosting(p *payment, its itemSet, vendorName func(*int64) string) *postTxn {
	name := vendorName(p.AgencyVendorID)
	if name == "" {
		name = p.AgencyName
	}
	key := "p" // earlier tax payments entered without an agency
	if p.AgencyVendorID != nil {
		key = "v" + itoa(*p.AgencyVendorID)
	} else if name == "" {
		name = "(no payee)"
	}
	t := &postTxn{Entity: posting.EntityPayment, ID: p.ID, Type: payType(p), Date: p.Date, Num: payNum(p), Name: name, NameKey: key,
		Bank: p.BankAccountID, Total: p.Amount, Voided: p.Voided, TxnID: p.BooksTxnID, Status: p.SyncStatus,
		Target: target("liability_payment", p.ID),
		Memo:   withMemo(fmt.Sprintf("Payroll Liabilities %s - %s", mdy(p.PeriodStart), mdy(p.PeriodEnd)), p.Memo)}
	t.NoPost = p.Kind == model.PaymentPrior
	t.Posted = !t.NoPost && p.SyncStatus == "posted" && p.BooksTxnID != nil
	t.Lines = append(t.Lines, postLine{AccountID: p.BankAccountID, Amount: -p.Amount, Side: sideBank})
	for _, l := range p.Lines {
		if l.Amount == 0 {
			continue
		}
		if l.Kind == "expense" {
			desc := l.Memo
			if desc == "" {
				desc = "Payroll liability penalty/interest"
			}
			t.Lines = append(t.Lines, postLine{AccountID: l.AccountID, Amount: l.Amount, Desc: desc, Side: sideExpense})
			continue
		}
		it := its.get(l.ItemID)
		desc := it.Name
		if l.Memo != "" {
			desc += ": " + l.Memo
		}
		t.Lines = append(t.Lines, postLine{AccountID: it.LiabilityAccountID, Amount: l.Amount, ItemID: it.ID, Desc: desc, Side: sideLiability})
		if it.LiabilityAccountID == nil {
			t.Problem = "Payroll item " + it.Name + " has no liability account."
		}
	}
	return t
}

// adjustmentPosting builds the Books journal entry of a liability adjustment.
// fallback is the expense account of employee-paid items without one.
func adjustmentPosting(a *adjustment, its itemSet, fallback func(employeeID int64) *int64, vendorName func(*int64) string) *postTxn {
	t := &postTxn{Entity: posting.EntityAdjustment, ID: a.ID, Type: "Tax Adjustment", Date: a.Date, Name: a.EmployeeName,
		NameKey: "e" + itoa(a.EmployeeID), EmpID: a.EmployeeID, TxnID: a.BooksTxnID, Status: a.SyncStatus, Target: target("adjustment", a.ID),
		Memo: withMemo("Payroll Liability Adjustment", a.Memo)}
	if a.EmployeeID == 0 {
		t.Name, t.NameKey = "Company Adjustments", "c"
		// a company adjustment of one agency's items is shown under that agency
		var agency *int64
		same := true
		for i, l := range a.Lines {
			it := its.get(l.ItemID)
			switch {
			case i == 0:
				agency = it.AgencyVendorID
			case agency == nil || it.AgencyVendorID == nil || *it.AgencyVendorID != *agency:
				same = false
			}
		}
		if same && agency != nil {
			if n := vendorName(agency); n != "" {
				t.Name, t.NameKey = n, "v"+itoa(*agency)
			}
		}
	}
	has := false
	for _, l := range a.Lines {
		it := its.get(l.ItemID)
		if l.Amount == 0 {
			// wage-base-only line: nothing is posted, the detail still shows it
			if l.WageBase != 0 {
				t.Lines = append(t.Lines, postLine{AccountID: it.LiabilityAccountID, ItemID: it.ID, Desc: it.Name, WageBase: l.WageBase, Side: sideLiability})
			}
			continue
		}
		has = true
		expense := it.ExpenseAccountID
		cat := model.ItemCategory(it.Type, it.TaxCode)
		if expense == nil && (cat == model.CatDeduction || cat == model.CatEmployeeTax) {
			expense = fallback(a.EmployeeID)
		}
		desc := it.Name
		if l.Memo != "" {
			desc += ": " + l.Memo
		}
		t.Lines = append(t.Lines,
			postLine{AccountID: expense, Amount: l.Amount, ItemID: it.ID, Desc: desc, WageBase: l.WageBase, Side: sideExpense},
			postLine{AccountID: it.LiabilityAccountID, Amount: -l.Amount, ItemID: it.ID, Desc: desc, WageBase: l.WageBase, Side: sideLiability})
		if l.Amount > 0 {
			t.Total += l.Amount
		} else {
			t.Total -= l.Amount
		}
		if expense == nil || it.LiabilityAccountID == nil {
			t.Problem = "Payroll item " + it.Name + " has no expense/liability account."
		}
	}
	t.NoPost = !a.AffectsAccounts || !has
	t.Posted = !t.NoPost && a.SyncStatus == "posted" && a.BooksTxnID != nil
	return t
}

// fallbackExpense mirrors posting's choice of an expense account for
// employee-paid items without one: the employee's first earnings item, else
// the first salary/hourly item of the company.
func (e *env) fallbackExpense() func(employeeID int64) *int64 {
	cache := map[int64]*int64{}
	done := map[int64]bool{}
	return func(employeeID int64) *int64 {
		if done[employeeID] {
			return cache[employeeID]
		}
		done[employeeID] = true
		var id sql.NullInt64
		if employeeID != 0 {
			err := e.q.QueryRowContext(e.ctx, `SELECT pi.expense_account_id FROM employee_items ei JOIN payroll_items pi ON pi.id = ei.item_id
				WHERE ei.employee_id = ? AND pi.type IN ('salary','hourly','overtime','bonus','commission','tips','reported_tips')
				AND pi.expense_account_id IS NOT NULL ORDER BY ei.seq, ei.id LIMIT 1`, employeeID).Scan(&id)
			if err == nil && id.Valid {
				cache[employeeID] = store.PtrID(id)
				return cache[employeeID]
			}
		}
		err := e.q.QueryRowContext(e.ctx, `SELECT expense_account_id FROM payroll_items WHERE type IN ('salary','hourly')
			AND expense_account_id IS NOT NULL ORDER BY active DESC, CASE type WHEN 'salary' THEN 0 ELSE 1 END, id LIMIT 1`).Scan(&id)
		if err == nil && id.Valid {
			cache[employeeID] = store.PtrID(id)
		}
		return cache[employeeID]
	}
}

// postings returns the postings of the paychecks (by check date), liability
// payments (by payment date) and adjustments (by adjustment date) dated
// from..to, ordered by date then type (paychecks, adjustments, payments).
func (e *env) postings(from, to string, employeeID int64, includeVoided bool) ([]*postTxn, error) {
	its, err := e.items()
	if err != nil {
		return nil, err
	}
	vendorName := e.vendorName
	pcs, err := e.paychecks(pcFilter{from: from, to: to, employeeID: employeeID, includeVoided: includeVoided})
	if err != nil {
		return nil, err
	}
	adjs, err := e.adjustments(from, to, false, employeeID)
	if err != nil {
		return nil, err
	}
	var pays []*payment
	if employeeID == 0 {
		if pays, err = e.payments(from, to, false, includeVoided); err != nil {
			return nil, err
		}
	}
	fb := e.fallbackExpense()
	var out []*postTxn
	for _, p := range pcs {
		out = append(out, paycheckPosting(p, its))
	}
	for _, a := range adjs {
		out = append(out, adjustmentPosting(a, its, fb, vendorName))
	}
	for _, p := range pays {
		out = append(out, paymentPosting(p, its, vendorName))
	}
	rank := map[string]int{posting.EntityPaycheck: 0, posting.EntityAdjustment: 1, posting.EntityPayment: 2}
	sortStable(out, func(a, b *postTxn) bool {
		if a.Date != b.Date {
			return a.Date < b.Date
		}
		if rank[a.Entity] != rank[b.Entity] {
			return rank[a.Entity] < rank[b.Entity]
		}
		return a.ID < b.ID
	})
	return out, nil
}
