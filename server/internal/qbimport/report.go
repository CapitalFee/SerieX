package qbimport

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"sort"
	"strings"

	"seriex/internal/banking"
	"seriex/internal/company"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/reports"
	"seriex/internal/store"
)

// CountRow: what happened to one kind of list record.
type CountRow struct {
	What    string `json:"what"`
	Created int    `json:"created"`
	Matched int    `json:"matched"` // already in the company file, used as is
	Skipped int    `json:"skipped"`
}

// TxnCount: what happened to the transactions of one QuickBooks type.
type TxnCount struct {
	Source    string `json:"source"` // TRNSTYPE
	Label     string `json:"label"`  // SerieX Books form
	Count     int    `json:"count"`  // in the file (preview)
	Imported  int    `json:"imported"`
	AsJournal int    `json:"asJournal"` // entered as general journal entries
	Skipped   int    `json:"skipped"`
}

// BalanceRow is one account of the trial balance comparison. Amounts are
// debit positive, credit negative.
type BalanceRow struct {
	AccountID  int64   `json:"accountId"`
	Account    string  `json:"account"`
	Number     string  `json:"number"`
	Type       string  `json:"type"`
	Source     float64 `json:"source"`     // QuickBooks (the files)
	Books      float64 `json:"books"`      // SerieX Books after the import
	Difference float64 `json:"difference"` // Books - Source
}

// Check is one test of the books after the import.
type Check struct {
	Key    string `json:"key"`
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

// CompanyRef names the company file the import went into.
type CompanyRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Report is the result of a dry run or an import.
type Report struct {
	DryRun          bool            `json:"dryRun"`
	Imported        bool            `json:"imported"` // the changes were saved
	Mode            string          `json:"mode"`
	AsOf            string          `json:"asOf"` // date of the balances below
	Company         *CompanyRef     `json:"company,omitempty"`
	Counts          []CountRow      `json:"counts"`
	Transactions    []TxnCount      `json:"transactions"`
	Opening         *OpeningSummary `json:"opening,omitempty"`
	PaymentsApplied int             `json:"paymentsApplied"`
	DepositsLinked  int             `json:"depositsLinked"`
	ClearedEntries  int             `json:"clearedEntries"`
	TrialBalance    []BalanceRow    `json:"trialBalance"`
	TotalDebits     float64         `json:"totalDebits"`
	TotalCredits    float64         `json:"totalCredits"`
	Checks          []Check         `json:"checks"`
	Errors          int             `json:"errors"`
	Notes           int             `json:"notes"`
	Problems        []Problem       `json:"problems"`
	Truncated       bool            `json:"truncated"` // only the first problems are listed
	// RuleSuggestions: bank rules suggested by how the imported transactions
	// were classified; RulesCreated: the keys of those created.
	RuleSuggestions []banking.RuleSuggestion `json:"ruleSuggestions"`
	RulesCreated    []string                 `json:"rulesCreated"`
}

const maxProblems = 2000

// finish computes the trial balance comparison and the checks.
func (im *importer) finish() error {
	ctx, q := im.ctx, im.tx
	rep := im.rep
	rep.PaymentsApplied, rep.DepositsLinked, rep.ClearedEntries = im.applied, im.linked, im.cleared

	// what QuickBooks had: the trial balance and the transactions of the files
	src := map[int64]int64{}
	unmapped := map[string]int64{}
	add := func(full string, amt int64) {
		if id, _ := im.accountID(full); id != 0 {
			src[id] += amt
		} else {
			unmapped[full] += amt
		}
	}
	if im.ps.tb != nil {
		for _, r := range im.ps.tb.Rows {
			if a := im.p.accts[normFull(r.Full)]; a != nil && a.row.Type == model.AcctNonPosting {
				continue
			}
			add(r.Full, r.Amount)
		}
	}
	asOf := ""
	if im.in.Opt.Mode == "opening" {
		asOf = im.in.Opt.ConversionDate
	}
	for _, t := range im.ps.txns {
		for _, s := range append([]srcSplit{t.Head}, t.Splits...) {
			add(s.Accnt, s.Amount)
		}
		if t.Date > asOf {
			asOf = t.Date
		}
	}
	books := map[int64]int64{}
	rows, err := q.QueryContext(ctx, `SELECT account_id, SUM(amount) FROM gl_entries GROUP BY account_id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, amt int64
		if err := rows.Scan(&id, &amt); err != nil {
			rows.Close()
			return err
		}
		books[id] = amt
	}
	rows.Close()
	var maxDate sql.NullString
	q.QueryRowContext(ctx, `SELECT MAX(date) FROM gl_entries`).Scan(&maxDate)
	if maxDate.Valid && maxDate.String > asOf {
		asOf = maxDate.String
	}
	if asOf == "" {
		asOf = store.Today()
	}
	rep.AsOf = asOf
	ids := map[int64]bool{}
	for id := range src {
		ids[id] = true
	}
	for id := range books {
		ids[id] = true
	}
	var debits, credits, sum int64
	var assets, liabEq, pl int64
	var diffAccts []string
	onlyInventory := true
	for id := range ids {
		a := im.acct(id)
		if a == nil || (src[id] == 0 && books[id] == 0) {
			continue
		}
		var num string
		q.QueryRowContext(ctx, `SELECT number FROM accounts WHERE id = ?`, id).Scan(&num)
		r := BalanceRow{AccountID: id, Account: a.name, Number: num, Type: a.typ, Source: dollars(src[id]), Books: dollars(books[id]),
			Difference: dollars(books[id] - src[id])}
		rep.TrialBalance = append(rep.TrialBalance, r)
		b := books[id]
		sum += b
		if b > 0 {
			debits += b
		} else {
			credits -= b
		}
		switch {
		case model.IsBalanceSheet(a.typ) && model.IsDebitNormal(a.typ):
			assets += b
		case model.IsBalanceSheet(a.typ):
			liabEq -= b
		case model.IsProfitLoss(a.typ):
			pl -= b
		}
		if books[id] != src[id] {
			diffAccts = append(diffAccts, a.name)
			if a.typ != model.AcctCOGS && !im.isInventoryAccount(id) {
				onlyInventory = false
			}
		}
	}
	for full, amt := range unmapped {
		if amt == 0 {
			continue
		}
		rep.TrialBalance = append(rep.TrialBalance, BalanceRow{Account: full + " (not imported)", Source: dollars(amt), Difference: dollars(-amt)})
		diffAccts = append(diffAccts, full)
		onlyInventory = false
	}
	sort.Slice(rep.TrialBalance, func(i, j int) bool {
		a, b := rep.TrialBalance[i], rep.TrialBalance[j]
		if ra, rb := model.AccountTypeRank(a.Type), model.AccountTypeRank(b.Type); ra != rb {
			return ra < rb
		}
		return strings.ToLower(a.Account) < strings.ToLower(b.Account)
	})
	rep.TotalDebits, rep.TotalCredits = dollars(debits), dollars(credits)

	check := func(key, label string, ok bool, detail string, args ...any) {
		rep.Checks = append(rep.Checks, Check{Key: key, Label: label, OK: ok, Detail: fmt.Sprintf(detail, args...)})
	}
	check("debitsCredits", "Total debits equal total credits", sum == 0, "Debits %s, credits %s.", fmtCents(debits), fmtCents(credits))
	check("balanceSheet", "The balance sheet balances", assets == liabEq+pl,
		"Assets %s; liabilities and equity %s (including net income of %s).", fmtCents(assets), fmtCents(liabEq+pl), fmtCents(pl))
	sort.Strings(diffAccts)
	switch {
	case len(diffAccts) == 0:
		check("trialBalance", "The trial balance matches the QuickBooks® files", true, "Every account has the balance it has in the files.")
	case onlyInventory:
		check("trialBalance", "The trial balance matches the QuickBooks® files", false,
			"Only cost of goods sold and inventory accounts differ (%s): SerieX Books computes the cost of items sold from their average cost, and the files did not carry the same amounts.", strings.Join(diffAccts, ", "))
	default:
		if len(diffAccts) > 8 {
			diffAccts = append(diffAccts[:8], fmt.Sprintf("and %d more", len(diffAccts)-8))
		}
		check("trialBalance", "The trial balance matches the QuickBooks® files", false, "These accounts differ: %s. See the problems listed for transactions that were not imported.", strings.Join(diffAccts, ", "))
	}
	for _, side := range []struct{ key, report, acctType, label string }{
		{"arAging", "ar_aging_summary", model.AcctAR, "A/R aging equals Accounts Receivable"},
		{"apAging", "ap_aging_summary", model.AcctAP, "A/P aging equals Accounts Payable"},
	} {
		aging, err := agingTotal(ctx, q, side.report, asOf)
		if err != nil {
			return err
		}
		var gl int64
		if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(g.amount), 0) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
			WHERE a.type = ? AND g.date <= ?`, side.acctType, asOf).Scan(&gl); err != nil {
			return err
		}
		if side.acctType == model.AcctAP {
			gl = -gl
		}
		check(side.key, side.label, aging == gl, "Aging total %s; account balance %s (as of %s).", fmtCents(aging), fmtCents(gl), fmtDate(asOf))
	}
	probs, err := company.Verify(ctx, q)
	if err != nil {
		return err
	}
	if len(probs) == 0 {
		check("verify", "Verify Data finds no problems", true, "Ledger entries, open balances, A/R and A/P by name, and inventory all agree.")
	} else {
		detail := strings.Join(probs, " ")
		if len(probs) > 5 {
			detail = strings.Join(probs[:5], " ") + fmt.Sprintf(" (and %d more)", len(probs)-5)
		}
		check("verify", "Verify Data finds no problems", false, "%s", detail)
	}
	// items sold below zero
	var neg []string
	nrows, err := q.QueryContext(ctx, `SELECT id FROM items WHERE type = ? AND qty_on_hand < 0 ORDER BY name`, model.ItemInventoryPart)
	if err != nil {
		return err
	}
	for nrows.Next() {
		var id int64
		if err := nrows.Scan(&id); err != nil {
			nrows.Close()
			return err
		}
		neg = append(neg, store.FullName(ctx, q, "items", id))
	}
	nrows.Close()
	if len(neg) > 0 {
		im.problem("", 0, levelNote, "These inventory items have a negative quantity on hand after the import: %s.", strings.Join(neg, ", "))
	}
	return nil
}

// agingTotal returns the TOTAL of an aging summary report as of a date, in cents.
func agingTotal(ctx context.Context, q store.Q, key, asOf string) (int64, error) {
	var info model.ReportInfo
	for _, r := range reports.Catalog() {
		if r.Key == key {
			info = r
		}
	}
	p, err := reports.ParseParams(ctx, q, info, url.Values{"asOf": {asOf}, "to": {asOf}})
	if err != nil {
		return 0, err
	}
	res, err := reports.Run(ctx, q, key, p)
	if err != nil {
		return 0, err
	}
	for _, r := range res.Rows {
		if r.Kind == "grandtotal" {
			if v, ok := r.Cells["total"].(float64); ok {
				return store.Cents(v), nil
			}
		}
	}
	return 0, nil
}

// finalize sorts the counts and problems of the report.
func (im *importer) finalize() {
	rep := im.rep
	order := []string{"Accounts", "Customers and jobs", "Vendors", "Other names", "Items", "Classes", "Terms", "Payment methods",
		"Shipping methods", "Customer types", "Vendor types", "Job types", "Customer messages", "Sales reps",
		"Opening inventory", "Open invoices and credits", "Unpaid bills and credits", "Opening balance journal entry", "Bank rules"}
	for _, k := range order {
		if c := im.counts[k]; c != nil {
			rep.Counts = append(rep.Counts, *c)
		}
	}
	keys := make([]string, 0, len(im.txCounts))
	for k := range im.txCounts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		rep.Transactions = append(rep.Transactions, *im.txCounts[k])
	}
	sort.SliceStable(rep.Problems, func(i, j int) bool {
		a, b := rep.Problems[i], rep.Problems[j]
		if (a.Level == levelError) != (b.Level == levelError) {
			return a.Level == levelError
		}
		if a.File != b.File {
			return fileRank(a.File) < fileRank(b.File)
		}
		return a.Line < b.Line
	})
	rep.Errors, rep.Notes = 0, 0
	for _, pr := range rep.Problems {
		if pr.Level == levelError {
			rep.Errors++
		} else {
			rep.Notes++
		}
	}
	if len(rep.Problems) > maxProblems {
		rep.Problems = rep.Problems[:maxProblems]
		rep.Truncated = true
	}
	if rep.Problems == nil {
		rep.Problems = []Problem{}
	}
	if rep.TrialBalance == nil {
		rep.TrialBalance = []BalanceRow{}
	}
	if rep.Counts == nil {
		rep.Counts = []CountRow{}
	}
	if rep.Transactions == nil {
		rep.Transactions = []TxnCount{}
	}
	if rep.Checks == nil {
		rep.Checks = []Check{}
	}
	if rep.RuleSuggestions == nil {
		rep.RuleSuggestions = []banking.RuleSuggestion{}
	}
	if rep.RulesCreated == nil {
		rep.RulesCreated = []string{}
	}
}

func fileRank(f string) int {
	switch f {
	case "iif":
		return 1
	case "tb":
		return 2
	case "invoices":
		return 3
	case "bills":
		return 4
	}
	return 0
}

var _ = ledger.TypeLabel
