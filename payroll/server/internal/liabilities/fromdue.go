package liabilities

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

type dueRef struct {
	PaymentGroup string `json:"paymentGroup"`
	PeriodStart  string `json:"periodStart"`
	PeriodEnd    string `json:"periodEnd"`
}

type fromDueRequest struct {
	Rows             []dueRef `json:"rows"`
	Date             string   `json:"date"`
	BankAccountID    *int64   `json:"bankAccountId"`
	ToBePrinted      bool     `json:"toBePrinted"`
	FirstCheckNumber string   `json:"firstCheckNumber"`
	Memo             string   `json:"memo"`
}

type fromDueResult struct {
	Payments []*model.LiabilityPayment `json:"payments"`
	Problems []model.SyncProblem       `json:"problems"`
}

// planned payment: one per agency and period range.
type plannedPayment struct {
	vendor *int64
	start  string
	end    string
	method string
	rows   []*dueRow
	label  string
}

// nextCheckNumber increments the trailing digits of a check number ("1009" -> "1010", "A-99" -> "A-100").
func nextCheckNumber(s string) string {
	i := len(s)
	for i > 0 && s[i-1] >= '0' && s[i-1] <= '9' {
		i--
	}
	if i == len(s) {
		return s
	}
	n, err := strconv.ParseUint(s[i:], 10, 64)
	if err != nil {
		return s
	}
	digits := strconv.FormatUint(n+1, 10)
	if pad := len(s) - i; len(digits) < pad {
		digits = strings.Repeat("0", pad-len(digits)) + digits
	}
	return s[:i] + digits
}

// checkNumberUse names the paycheck or tax payment (other than payment
// excludePayment) that already uses a check number of a bank account ("" when none).
func checkNumberUse(ctx context.Context, q store.Q, bank int64, number string, excludePayment int64) (string, error) {
	if number == "" {
		return "", nil
	}
	var name, date string
	err := q.QueryRowContext(ctx, `SELECT 'the paycheck to ' || e.display_name, p.check_date FROM paychecks p
		JOIN employees e ON e.id = p.employee_id
		WHERE p.bank_account_id = ? AND p.check_number = ? AND p.voided = 0 AND p.kind = 'regular'
		UNION ALL SELECT 'the tax payment' || CASE WHEN agency_name <> '' THEN ' to ' || agency_name ELSE '' END, date
		FROM liability_payments WHERE bank_account_id = ? AND check_number = ? AND voided = 0 AND kind = 'payment' AND id <> ?
		LIMIT 1`, bank, number, bank, number, excludePayment).Scan(&name, &date)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return name + " dated " + mdy(date), nil
}

// confirmCheckNumber asks for a Yes when a check number the user typed is
// already used by a paycheck or tax payment of the same bank account
// (preference "warn about duplicate check numbers").
func confirmCheckNumber(c *httpx.Ctx, q store.Q, bank *int64, number string, excludePayment int64) error {
	if c.Force() || bank == nil || number == "" {
		return nil
	}
	prefs, err := store.LoadPrefs(c.Context(), q)
	if err != nil {
		return err
	}
	if !prefs.WarnDuplicateCheckNumbers {
		return nil
	}
	used, err := checkNumberUse(c.Context(), q, *bank, number, excludePayment)
	if err != nil || used == "" {
		return err
	}
	return apperr.Confirm("Check number %s is already used by %s. Do you want to use it anyway?", number, used)
}

// planFromDue checks the selected rows against the scheduled liabilities and
// groups them into payments (one per agency and period range).
func planFromDue(d *dueData, req *fromDueRequest) ([]*plannedPayment, error) {
	var plans []*plannedPayment
	seen := map[string]bool{}
	for i, ref := range req.Rows {
		field := fmt.Sprintf("rows[%d]", i)
		k := ref.PaymentGroup + "|" + ref.PeriodStart + "|" + ref.PeriodEnd
		if seen[k] {
			continue
		}
		seen[k] = true
		r := d.find(ref.PaymentGroup, ref.PeriodStart, ref.PeriodEnd)
		if r == nil {
			return nil, apperr.Validation(field, "There is no scheduled liability for %s %s - %s.", ref.PaymentGroup, mdy(ref.PeriodStart), mdy(ref.PeriodEnd))
		}
		if r.Total <= 0 {
			return nil, apperr.Validation(field, "%s for %s is already paid.", r.Label, fmtPeriod(r.Freq, r.Start, r.End))
		}
		if r.Vendor == nil {
			if r.Group == model.GroupUnassigned {
				return nil, apperr.Validation(field, "These taxes have no payee. Choose the agency of the payroll items, or the payee of %q in Tax Payment Schedule.", r.Label)
			}
			return nil, apperr.Validation(field, "%s has no payee. Choose the agency in Tax Payment Schedule.", r.Label)
		}
		var plan *plannedPayment
		for _, p := range plans {
			if *p.vendor == *r.Vendor && p.start == r.Start && p.end == r.End {
				plan = p
				break
			}
		}
		if plan == nil {
			plan = &plannedPayment{vendor: r.Vendor, start: r.Start, end: r.End, method: r.Method, label: r.Label}
			plans = append(plans, plan)
		}
		if r.Method == "check" {
			plan.method = "check"
		}
		plan.rows = append(plan.rows, r)
	}
	return plans, nil
}

// agencyMemo is the default memo of a tax payment: the number that
// identifies the company to the agency (EIN and form for federal deposits,
// the state account number for state agencies).
func agencyMemo(ctx context.Context, q store.Q, group string) string {
	switch {
	case group == model.GroupFederal941 || group == model.GroupFederal940:
		var ein string
		q.QueryRowContext(ctx, `SELECT ein FROM company WHERE id = 1`).Scan(&ein)
		form := "Form 941"
		if group == model.GroupFederal940 {
			form = "Form 940"
		}
		if len(store.Digits(ein)) == 9 {
			return "EIN " + store.FormatEIN(ein) + " " + form
		}
		return form
	case strings.HasPrefix(group, "state_wh:") || strings.HasPrefix(group, "state_ui:"):
		col := "withholding_id"
		if strings.HasPrefix(group, "state_ui:") {
			col = "ui_id"
		}
		var id string
		q.QueryRowContext(ctx, `SELECT `+col+` FROM state_settings WHERE state = ?`, group[strings.IndexByte(group, ':')+1:]).Scan(&id)
		if id = strings.TrimSpace(id); id != "" {
			return "Acct " + id
		}
	}
	return ""
}

// paymentFromPlan builds the payment record of a plan: the remaining amount of every item.
func paymentFromPlan(ctx context.Context, q store.Q, d *dueData, p *plannedPayment, req *fromDueRequest, n *namer) *paymentRecord {
	r := &paymentRecord{
		Kind: model.PaymentRegular, Date: req.Date, PeriodStart: p.start, PeriodEnd: p.end, Vendor: p.vendor,
		VendorName: n.vendor(p.vendor), Bank: req.BankAccountID, Method: p.method, Memo: strings.TrimSpace(req.Memo),
		ToBePrinted: req.ToBePrinted && p.method == "check",
	}
	if r.Memo == "" && len(p.rows) > 0 {
		r.Memo = agencyMemo(ctx, q, p.rows[0].Group)
	}
	for _, row := range p.rows {
		for _, it := range d.groups[row.Group] {
			if v := row.Remaining[it.ID]; v != 0 { // negative: a credit of the item taken with the payment
				id := it.ID
				r.Lines = append(r.Lines, payLine{Kind: "item", ItemID: &id, Amount: v})
				r.Total += v
			}
		}
	}
	return r
}

// POST /liability-payments/from-due: pays the selected scheduled liabilities.
func fromDueRoute(c *httpx.Ctx) error {
	var req fromDueRequest
	if err := c.Decode(&req); err != nil {
		return err
	}
	ctx := c.Context()
	req.Date = strings.TrimSpace(req.Date)
	if req.Date == "" {
		req.Date = store.Today()
	}
	if !store.ValidDate(req.Date) {
		return apperr.Validation("date", "Please enter a valid payment date.")
	}
	if len(req.Rows) == 0 {
		return apperr.Validation("rows", "Select the liabilities to pay.")
	}
	if req.BankAccountID == nil || *req.BankAccountID <= 0 {
		return apperr.Validation("bankAccountId", "Choose the bank account the liabilities are paid from.")
	}
	req.FirstCheckNumber = strings.TrimSpace(req.FirstCheckNumber)
	n := newNamer(c)
	d, err := computeDue(ctx, c.DB, n.vendor)
	if err != nil {
		return err
	}
	plans, err := planFromDue(d, &req)
	if err != nil {
		return err
	}
	n.lk = booksLookup(c, func(lk *posting.Lookups) bool {
		if !hasAccount(lk, req.BankAccountID) {
			return false
		}
		for _, p := range plans {
			if !hasVendors(lk, p.vendor) {
				return false
			}
		}
		return true
	})
	if n.lk.OK {
		if a, ok := n.lk.Accounts[*req.BankAccountID]; !ok || a.Type != books.AcctBank {
			return apperr.Validation("bankAccountId", "Choose a SerieX Books bank account.")
		}
	}
	if n.lk.OK {
		for _, p := range plans {
			if _, ok := n.lk.Vendors[*p.vendor]; !ok {
				return apperr.Validation("rows", "The payee of %s is not a vendor in SerieX Books. Choose the agency in Tax Payment Schedule.", p.label)
			}
		}
	}
	// check numbers: the first one given, else the next number SerieX Books
	// suggests (skipping numbers of payroll checks not in SerieX Books yet)
	number := req.FirstCheckNumber
	given := number != ""
	needNumber := false
	for _, p := range plans {
		needNumber = needNumber || (p.method == "check" && !req.ToBePrinted)
	}
	if needNumber && number == "" {
		if ref, err := books.Default.NextRef(ctx, books.S(c), books.TxCheck, *req.BankAccountID); err == nil {
			number = strings.TrimSpace(ref)
		}
	}

	var ids []int64
	err = c.Write(func(tx *sql.Tx) error {
		// the liabilities again inside the transaction: nothing paid twice by two requests
		d, err := computeDue(ctx, tx, n.vendor)
		if err != nil {
			return err
		}
		plans, err := planFromDue(d, &req)
		if err != nil {
			if ae := apperr.As(err); ae != nil {
				return apperr.Conflict("%s Refresh the list and try again.", ae.Message)
			}
			return err
		}
		num := number
		for _, p := range plans {
			r := paymentFromPlan(ctx, tx, d, p, &req, n)
			if r.Method == "check" && !r.ToBePrinted && num != "" {
				if given {
					if err := confirmCheckNumber(c, tx, req.BankAccountID, num, 0); err != nil {
						return err
					}
				} else {
					for i := 0; i < 1000; i++ {
						used, err := checkNumberUse(ctx, tx, *req.BankAccountID, num, 0)
						if err != nil {
							return err
						}
						if used == "" || nextCheckNumber(num) == num {
							break
						}
						num = nextCheckNumber(num)
					}
				}
				r.CheckNumber = num
				num = nextCheckNumber(num)
			}
			id, err := insertPayment(c, tx, r)
			if err != nil {
				return err
			}
			ids = append(ids, id)
			if err := store.Audit(ctx, tx, c.User, "add", posting.EntityPayment, id,
				paymentSummary(r.Kind, r.VendorName, r.Total, r.Date)+" (from Pay Payroll Taxes)", r); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	res := fromDueResult{Payments: []*model.LiabilityPayment{}, Problems: []model.SyncProblem{}}
	opt := books.Opts(c)
	for _, id := range ids {
		prob, err := posting.PostLiabilityPayment(c, id, opt)
		if err != nil {
			return err
		}
		if prob != nil {
			res.Problems = append(res.Problems, *prob)
		}
		p, err := loadPayment(ctx, c.DB, id)
		if err != nil {
			return err
		}
		fillPaymentNames(p, n)
		res.Payments = append(res.Payments, p)
	}
	return c.JSON(res)
}
