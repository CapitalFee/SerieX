package ledger

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/model"
	"seriex/internal/store"
)

// qryBillInfo is what Pay Bills needs to know about a bill or a vendor credit.
type qryBillInfo struct {
	ID       int64
	Type     string
	Ref      string
	VendorID int64
	APID     int64
	Open     int64
	Voided   bool
	// journal entries with one A/P line: a credit to A/P is paid like a bill,
	// a debit is used like a vendor credit
	JECharge, JECredit bool
}

func qryLoadBillInfo(ctx context.Context, q store.Q, id int64) (*qryBillInfo, error) {
	var b qryBillInfo
	var vendor, ap sql.NullInt64
	var voided int
	err := q.QueryRowContext(ctx, `SELECT id, type, ref_number, name_id, account_id, open_balance, voided FROM txns WHERE id = ?`, id).
		Scan(&b.ID, &b.Type, &b.Ref, &vendor, &ap, &b.Open, &voided)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	b.VendorID = vendor.Int64
	b.APID = ap.Int64
	b.Voided = voided != 0
	if b.Type == model.TxJournal && !b.Voided {
		rows, err := q.QueryContext(ctx, `SELECT a.type, g.amount, IFNULL(g.name_id, 0), g.account_id FROM gl_entries g
			JOIN accounts a ON a.id = g.account_id WHERE g.txn_id = ? AND a.type IN (?, ?)`, id, model.AcctAR, model.AcctAP)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		n := 0
		var typ string
		var amt, name, acct int64
		for rows.Next() {
			if err := rows.Scan(&typ, &amt, &name, &acct); err != nil {
				return nil, err
			}
			n++
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if n == 1 && typ == model.AcctAP {
			b.VendorID, b.APID = name, acct
			b.JECharge, b.JECredit = amt < 0, amt > 0
		}
	}
	return &b, nil
}

// qryBillLabel names a bill in messages ("bill 1234" / "the bill"; capitalized at a sentence start).
func qryBillLabel(b *qryBillInfo, capital bool) string {
	switch {
	case b.Ref != "" && capital:
		return "Bill " + b.Ref
	case b.Ref != "":
		return "bill " + b.Ref
	case capital:
		return "The bill"
	}
	return "the bill"
}

// qryPayBills validates the request and creates one bill payment per vendor
// (and A/P account) through Save, inside tx.
func qryPayBills(ctx context.Context, tx *sql.Tx, req model.PayBillsRequest, opt SaveOptions) (*model.PayBillsResult, error) {
	if !store.ValidDate(req.Date) {
		return nil, apperr.Validation("date", "Enter a valid payment date.")
	}
	var acctType string
	err := tx.QueryRowContext(ctx, `SELECT type FROM accounts WHERE id = ?`, req.AccountID).Scan(&acctType)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && acctType != model.AcctBank && acctType != model.AcctCreditCard) {
		return nil, apperr.Validation("accountId", "Select a bank or credit card account to pay the bills from.")
	}
	if err != nil {
		return nil, err
	}
	if len(req.Bills) == 0 {
		return nil, apperr.Validation("bills", "Select at least one bill to pay.")
	}
	prefs, err := store.LoadPrefs(ctx, tx)
	if err != nil {
		return nil, err
	}

	type group struct {
		vendorID, apID int64
		links          []model.TxnLink
		amount         int64
	}
	groups := map[[2]int64]*group{}
	var keys [][2]int64
	seenBill := map[int64]bool{}
	creditUse := map[int64]int64{}
	credits := map[int64]*qryBillInfo{}

	for _, item := range req.Bills {
		bill, err := qryLoadBillInfo(ctx, tx, item.BillID)
		if err != nil {
			return nil, err
		}
		if bill == nil || (bill.Type != model.TxBill && !bill.JECharge) {
			return nil, apperr.Validation("bills", "Bill %d was not found.", item.BillID)
		}
		if bill.Voided || bill.Open <= 0 {
			return nil, apperr.Validation("bills", "%s is already paid.", qryBillLabel(bill, true))
		}
		if seenBill[bill.ID] {
			return nil, apperr.Validation("bills", "%s is listed more than once.", qryBillLabel(bill, true))
		}
		seenBill[bill.ID] = true
		amount, discount := store.Cents(item.Amount), store.Cents(item.Discount)
		if amount < 0 || discount < 0 {
			return nil, apperr.Validation("bills", "Amounts to pay and discounts cannot be negative.")
		}
		var creditTotal int64
		var creditLinks []model.TxnLink
		for _, c := range item.Credits {
			camt := store.Cents(c.Amount)
			if camt == 0 {
				continue
			}
			if camt < 0 {
				return nil, apperr.Validation("bills", "Credit amounts cannot be negative.")
			}
			cr := credits[c.CreditID]
			if cr == nil {
				if cr, err = qryLoadBillInfo(ctx, tx, c.CreditID); err != nil {
					return nil, err
				}
				if cr == nil || (cr.Type != model.TxVendorCredit && cr.Type != model.TxBillPayment && !cr.JECredit) || cr.Voided {
					return nil, apperr.Validation("bills", "Vendor credit %d was not found.", c.CreditID)
				}
				credits[c.CreditID] = cr
			}
			if cr.VendorID != bill.VendorID {
				return nil, apperr.Validation("bills", "A credit can only be applied to bills of the same vendor.")
			}
			creditUse[cr.ID] += camt
			if creditUse[cr.ID] > cr.Open {
				return nil, apperr.Validation("bills", "The credits applied exceed the available credit of %s.",
					strings.TrimSpace("credit "+cr.Ref))
			}
			creditTotal += camt
			cid := cr.ID
			creditLinks = append(creditLinks, model.TxnLink{FromTxnID: &cid, ToTxnID: bill.ID, Amount: store.Dollars(camt)})
		}
		applied := amount + discount + creditTotal
		if applied <= 0 {
			return nil, apperr.Validation("bills", "Enter an amount to pay for %s.", qryBillLabel(bill, false))
		}
		if applied > bill.Open {
			return nil, apperr.Validation("bills", "The amount paid, discount and credits for %s (%.2f) exceed its open balance of %.2f.",
				qryBillLabel(bill, false), store.Dollars(applied), store.Dollars(bill.Open))
		}
		var discAcct *int64
		if discount > 0 {
			switch {
			case item.DiscountAccountID != nil && *item.DiscountAccountID > 0:
				discAcct = item.DiscountAccountID
			case prefs.VendorDiscountAccountID != nil && *prefs.VendorDiscountAccountID > 0:
				discAcct = prefs.VendorDiscountAccountID
			default:
				return nil, apperr.Validation("discountAccountId", "Select the account to post the discount for %s to.", qryBillLabel(bill, false))
			}
		}
		key := [2]int64{bill.VendorID, bill.APID}
		g := groups[key]
		if g == nil {
			g = &group{vendorID: bill.VendorID, apID: bill.APID}
			groups[key] = g
			keys = append(keys, key)
		}
		if amount > 0 || discount > 0 {
			g.links = append(g.links, model.TxnLink{ToTxnID: bill.ID, Amount: store.Dollars(amount), Discount: store.Dollars(discount), DiscountAccountID: discAcct})
		}
		g.links = append(g.links, creditLinks...)
		g.amount += amount
	}

	// vendors in name order (checks print in that order), then A/P account
	names, err := store.FullNames(ctx, tx, "names")
	if err != nil {
		return nil, err
	}
	sort.SliceStable(keys, func(i, j int) bool {
		ni, nj := strings.ToLower(names[keys[i][0]]), strings.ToLower(names[keys[j][0]])
		if ni != nj {
			return ni < nj
		}
		return keys[i][1] < keys[j][1]
	})

	isBank := acctType == model.AcctBank
	nextNumber := strings.TrimSpace(req.FirstCheckNumber)
	if isBank && !req.ToBePrinted && nextNumber == "" {
		if nextNumber, err = qryNextRef(ctx, tx, model.TxCheck, req.AccountID); err != nil {
			return nil, err
		}
	}
	var ids []int64
	for _, key := range keys {
		g := groups[key]
		vendor := g.vendorID
		acct := req.AccountID
		t := &model.Txn{
			Type:      model.TxBillPayment,
			Date:      req.Date,
			NameID:    &vendor,
			AccountID: &acct,
			Amount:    store.Dollars(g.amount),
			Links:     g.links,
			Lines:     []model.TxnLine{},
		}
		if g.apID > 0 {
			ap := g.apID
			t.ArApAccountID = &ap
		}
		// the vendor's account number goes in the memo, as on a printed check
		var acctNo string
		tx.QueryRowContext(ctx, `SELECT account_number FROM names WHERE id = ?`, vendor).Scan(&acctNo)
		t.Memo = acctNo
		if t.BillAddress, err = qryVendorAddress(ctx, tx, vendor); err != nil {
			return nil, err
		}
		if isBank && g.amount > 0 {
			if req.ToBePrinted {
				t.ToBePrinted = true
			} else {
				t.RefNumber = nextNumber
				nextNumber = qryIncRef(nextNumber)
			}
		}
		id, err := Save(ctx, tx, t, opt)
		if err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	pays, err := qrySummariesByID(ctx, tx, ids)
	if err != nil {
		return nil, err
	}
	return &model.PayBillsResult{Payments: pays}, nil
}

// qryVendorAddress is the address block of a vendor on checks and bill
// payments (the same text as the Pay Bills / bill payment form): the name to
// print (print-on-check name, company name or name) unless the first address
// line repeats it, the address lines, "City, State Zip" and the country.
func qryVendorAddress(ctx context.Context, q store.Q, id int64) (string, error) {
	var name, company, printAs, l1, l2, l3, city, state, zip, country string
	err := q.QueryRowContext(ctx, `SELECT name, company_name, print_on_check_as, bill_line1, bill_line2, bill_line3,
		bill_city, bill_state, bill_zip, bill_country FROM names WHERE id = ?`, id).
		Scan(&name, &company, &printAs, &l1, &l2, &l3, &city, &state, &zip, &country)
	if err != nil {
		return "", err
	}
	top := strings.TrimSpace(printAs)
	if top == "" {
		top = strings.TrimSpace(company)
	}
	if top == "" {
		top = name
	}
	first := strings.ToLower(strings.TrimSpace(l1))
	if first != "" && (first == strings.ToLower(strings.TrimSpace(top)) || first == strings.ToLower(strings.TrimSpace(name)) ||
		first == strings.ToLower(strings.TrimSpace(company))) {
		top = ""
	}
	var sz []string
	for _, v := range []string{state, zip} {
		if v = strings.TrimSpace(v); v != "" {
			sz = append(sz, v)
		}
	}
	var cityLine []string
	if c := strings.TrimSpace(city); c != "" {
		cityLine = append(cityLine, c)
	}
	if len(sz) > 0 {
		cityLine = append(cityLine, strings.Join(sz, " "))
	}
	var out []string
	for _, v := range []string{top, l1, l2, l3, strings.Join(cityLine, ", "), country} {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, "\n"), nil
}
