package payroll

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// GET /paystubs?ids=1,2: pay stub data (the full SSN and bank account number
// are read server side; only the last four digits are returned).
func payStubsRoute(c *httpx.Ctx) error {
	ctx := c.Context()
	ids := c.QIDs("ids")
	if len(ids) == 0 {
		return apperr.Validation("ids", "Select the paychecks whose pay stubs you want.")
	}
	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return err
	}
	company, err := formCompany(ctx, c.DB, prefs.PayStubShowCompanyAddress)
	if err != nil {
		return err
	}
	out := make([]model.PayStub, 0, len(ids))
	for _, id := range ids {
		pc, err := get(ctx, c.DB, id)
		if err != nil {
			return err
		}
		if pc.Kind == model.PaycheckYTD {
			return apperr.Validation("ids", "Year-to-date amounts have no pay stub.")
		}
		e, err := employees.Load(ctx, c.DB, pc.EmployeeID, true)
		if errors.Is(err, sql.ErrNoRows) {
			return apperr.NotFound("Employee not found.")
		}
		if err != nil {
			return err
		}
		ytd, err := loadYTD(ctx, c.DB, map[int64]*model.PayrollItem{}, pc.EmployeeID, pc.CheckDate, id)
		if err != nil {
			return err
		}
		out = append(out, buildStub(pc, e, company, prefs, ytd))
	}
	return c.JSON(out)
}

func formCompany(ctx context.Context, q store.Q, withAddress bool) (model.FormCompany, error) {
	var fc model.FormCompany
	var legal, ein string
	err := q.QueryRowContext(ctx, `SELECT name, legal_name, trade_name, address1, address2, city, state, zip, ein, contact_name, contact_phone, email
		FROM company WHERE id = 1`).Scan(&fc.Name, &legal, &fc.TradeName, &fc.Address.Line1, &fc.Address.Line2, &fc.Address.City,
		&fc.Address.State, &fc.Address.Zip, &ein, &fc.ContactName, &fc.ContactPhone, &fc.Email)
	if err != nil {
		return fc, err
	}
	if strings.TrimSpace(legal) != "" && fc.Name == "" {
		fc.Name = legal
	}
	fc.EIN = store.FormatEIN(ein)
	if !withAddress {
		fc.Address = model.Address{}
	}
	return fc, nil
}

func buildStub(pc *model.Paycheck, e *model.Employee, company model.FormCompany, prefs model.PayrollPrefs, y *ytdData) model.PayStub {
	st := model.PayStub{
		PaycheckID: pc.ID, Company: company, EmployeeName: e.DisplayName, EmployeeAddress: e.Address,
		EmployeeNumber: e.EmployeeNumber, PeriodStart: pc.PeriodStart, PeriodEnd: pc.PeriodEnd, CheckDate: pc.CheckDate,
		CheckNumber: pc.CheckNumber, DirectDeposit: pc.DirectDeposit, Memo: pc.Memo, PrintAs: e.PrintAs,
		Earnings: []model.StubLine{}, Taxes: []model.StubLine{}, Deductions: []model.StubLine{}, Additions: []model.StubLine{},
		Contributions: []model.StubLine{},
		Gross:         pc.Gross, Net: pc.Net, TotalTaxes: pc.EmployeeTaxes, TotalDeductions: pc.Deductions,
	}
	if st.PrintAs == "" {
		st.PrintAs = e.DisplayName
	}
	if prefs.PayStubShowSSNLast4 {
		if d := store.Digits(e.SSN); len(d) >= 4 {
			st.SSNLast4 = d[len(d)-4:]
		}
	}
	if pc.DirectDeposit {
		st.DepositAccount = store.MaskAccount(e.DirectDeposit.Account)
	}
	st.GrossYTD = store.Dollars(y.gross + store.Cents(pc.Gross))
	st.NetYTD = store.Dollars(y.net + store.Cents(pc.Net))
	if prefs.PayStubShowPTO {
		sick, vac := pc.Sick, pc.Vacation
		st.Sick, st.Vacation = &sick, &vac
	}
	st.NetInWords = netInWords(store.Cents(pc.Net))

	// one stub line per payroll item (hours added up; the rate when it is the same on every line)
	type agg struct {
		line     model.StubLine
		cat      string
		hours    bool
		rateSame bool
	}
	var order []int64
	byItem := map[int64]*agg{}
	for _, l := range pc.Lines {
		a := byItem[l.ItemID]
		if a == nil {
			a = &agg{line: model.StubLine{Name: l.ItemName, YTD: l.YTD}, cat: l.Category, hours: hourBased(l.ItemType), rateSame: true}
			if l.Rate != nil && (l.ItemType == model.ItemHourly || l.ItemType == model.ItemOvertime) {
				a.line.Rate = fptr(*l.Rate)
			}
			byItem[l.ItemID] = a
			order = append(order, l.ItemID)
		} else if a.line.Rate != nil && (l.Rate == nil || *l.Rate != *a.line.Rate) {
			a.rateSame = false
		}
		a.line.Amount = store.Dollars(store.Cents(a.line.Amount) + store.Cents(l.Amount))
		if a.hours && l.Qty != nil {
			h := 0.0
			if a.line.Hours != nil {
				h = *a.line.Hours
			}
			a.line.Hours = fptr(round4(h + *l.Qty))
		}
	}
	// items with year-to-date amounts that are not on this check
	for _, rows := range [][]model.SummaryRow{pc.EmployeeSummary, pc.CompanySummary} {
		for _, r := range rows {
			if byItem[r.ItemID] != nil || r.YTD == 0 {
				continue
			}
			byItem[r.ItemID] = &agg{line: model.StubLine{Name: r.ItemName, YTD: r.YTD}, cat: r.Category, rateSame: true}
			order = append(order, r.ItemID)
		}
	}
	for _, id := range order {
		a := byItem[id]
		if !a.rateSame {
			a.line.Rate = nil
		}
		if a.line.Amount == 0 && a.line.YTD == 0 && (a.line.Hours == nil || *a.line.Hours == 0) {
			continue
		}
		switch a.cat {
		case model.CatEarning:
			st.Earnings = append(st.Earnings, a.line)
		case model.CatAddition:
			st.Additions = append(st.Additions, a.line)
		case model.CatDeduction:
			st.Deductions = append(st.Deductions, a.line)
		case model.CatEmployeeTax:
			st.Taxes = append(st.Taxes, a.line)
		case model.CatContribution:
			st.Contributions = append(st.Contributions, a.line)
		}
	}
	return st
}

// ---------------------------------------------------------------------------
// Amount in words, as printed on checks: "One thousand two hundred thirty-four and 56/100".

var smallWords = []string{"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
	"eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"}
var tensWords = []string{"", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"}

func under1000(n int64) string {
	var parts []string
	if n >= 100 {
		parts = append(parts, smallWords[n/100]+" hundred")
		n %= 100
	}
	switch {
	case n >= 20:
		w := tensWords[n/10]
		if n%10 != 0 {
			w += "-" + smallWords[n%10]
		}
		parts = append(parts, w)
	case n > 0:
		parts = append(parts, smallWords[n])
	}
	return strings.Join(parts, " ")
}

func numberWords(n int64) string {
	if n == 0 {
		return "zero"
	}
	scales := []struct {
		v    int64
		name string
	}{{1_000_000_000_000, "trillion"}, {1_000_000_000, "billion"}, {1_000_000, "million"}, {1_000, "thousand"}}
	var parts []string
	for _, s := range scales {
		if n >= s.v {
			parts = append(parts, under1000(n/s.v)+" "+s.name)
			n %= s.v
		}
	}
	if n > 0 {
		parts = append(parts, under1000(n))
	}
	return strings.Join(parts, " ")
}

// netInWords spells an amount of cents the way checks print it.
func netInWords(cents int64) string {
	neg := cents < 0
	if neg {
		cents = -cents
	}
	w := numberWords(cents / 100)
	w = strings.ToUpper(w[:1]) + w[1:]
	if neg {
		w = "Minus " + strings.ToLower(w[:1]) + w[1:]
	}
	return fmt.Sprintf("%s and %02d/100", w, cents%100)
}
