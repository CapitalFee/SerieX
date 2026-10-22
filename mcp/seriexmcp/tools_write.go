package seriexmcp

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

// Tools that record changes. They are listed while at least one company file
// allows changes, and each call checks the company file it works on.

const changesNote = " Only for company files where AI assistants may record changes (see list_companies)."

type addressIn struct {
	Line1   string `json:"line1,omitempty" jsonschema:"Street."`
	Line2   string `json:"line2,omitempty" jsonschema:"Second street line."`
	City    string `json:"city,omitempty"`
	State   string `json:"state,omitempty"`
	Zip     string `json:"zip,omitempty"`
	Country string `json:"country,omitempty"`
}

func (a *addressIn) toAddress() map[string]string {
	out := map[string]string{"line1": "", "line2": "", "line3": "", "city": "", "state": "", "zip": "", "country": ""}
	if a != nil {
		out["line1"], out["line2"] = strings.TrimSpace(a.Line1), strings.TrimSpace(a.Line2)
		out["city"], out["state"] = strings.TrimSpace(a.City), strings.TrimSpace(a.State)
		out["zip"], out["country"] = strings.TrimSpace(a.Zip), strings.TrimSpace(a.Country)
	}
	return out
}

// dateOr parses a date argument, today when empty.
func dateOr(fieldName, s string) (string, error) {
	d, err := parseDate(fieldName, s)
	if err != nil || d != "" {
		return d, err
	}
	return today(), nil
}

// checkDate asks before saving a transaction dated far in the past or the
// future (the limits of the company preferences), as the SerieX forms do.
func (b *call) checkDate(date string, accepted []string) error {
	kinds := normKinds(accepted)
	if containsStr(kinds, "date") {
		return nil
	}
	p, err := b.preferences()
	if err != nil {
		return err
	}
	diff := daysBetween(today(), date)
	var q string
	switch {
	case p.DatePastWarnDays > 0 && -diff > p.DatePastWarnDays:
		q = fmt.Sprintf("The date %s is more than %d days in the past. Are you sure you want to use this date?", date, p.DatePastWarnDays)
	case p.DateFutureWarnDays > 0 && diff > p.DateFutureWarnDays:
		q = fmt.Sprintf("The date %s is more than %d days in the future. Are you sure you want to use this date?", date, p.DateFutureWarnDays)
	default:
		return nil
	}
	return &confirmNeeded{question: q, kind: "date", accepted: kinds, company: b.co.Name}
}

// cents compares money.
func cents(v float64) int64 { return int64(math.Round(v * 100)) }

// saveTxn creates a transaction with the warnings the user agreed to.
func (b *call) saveTxn(t *txn, accepted []string) (*txn, error) {
	var out txn
	err := b.save(accepted, func(q url.Values) error { return b.post("/txns", q, t, &out) })
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// classID resolves an optional class.
func (b *call) classID(input string) (*int64, error) {
	if strings.TrimSpace(input) == "" {
		return nil, nil
	}
	e, err := b.findEntry("class", input)
	if err != nil {
		return nil, err
	}
	return &e.ID, nil
}

// entryID resolves an optional entry of a simple list.
func (b *call) entryID(list, input string) (*int64, error) {
	if strings.TrimSpace(input) == "" {
		return nil, nil
	}
	e, err := b.findEntry(list, input)
	if err != nil {
		return nil, err
	}
	return &e.ID, nil
}

// inherited is the first value set on a name or its parents (jobs inherit
// from their customer).
func (b *call) inherited(n *name, get func(*name) *int64) *int64 {
	for _, x := range b.nameChain(n) {
		if v := get(x); v != nil {
			return v
		}
	}
	return nil
}

func addresseeOf(n *name) string {
	person := joinNonEmpty(" ", n.Salutation, n.FirstName, n.MiddleName, n.LastName)
	return orStr(n.CompanyName, orStr(person, n.Name))
}

func sameText(a, b string) bool {
	return strings.EqualFold(strings.Join(strings.Fields(a), " "), strings.Join(strings.Fields(b), " "))
}

// addressBlock is the address printed on a form: addressee then the address.
func addressBlock(addressee string, a address) string {
	if sameText(a.Line1, addressee) {
		return formatAddress("", a)
	}
	return formatAddress(addressee, a)
}

// customerAddresses are the bill-to and ship-to blocks of a customer or job,
// as the sales forms of SerieX fill them in.
func (b *call) customerAddresses(n *name) (bill, ship string) {
	chain := b.nameChain(n)
	billOwner := n
	for _, c := range chain {
		if hasAddress(c.BillAddress) {
			billOwner = c
			break
		}
	}
	var shipOwner *name
	for _, c := range chain {
		if hasAddress(c.ShipAddress) {
			shipOwner = c
			break
		}
	}
	addressee := addresseeOf(n)
	if n.ParentID != nil {
		addressee = addresseeOf(chain[len(chain)-1])
	}
	bill = addressBlock(addressee, billOwner.BillAddress)
	ship = bill
	if shipOwner != nil {
		ship = addressBlock(addressee, shipOwner.ShipAddress)
	}
	return bill, ship
}

// payeeAddress is the address block of a vendor or payee on bills and checks.
func payeeAddress(n *name) string {
	return addressBlock(orStr(n.PrintOnCheckAs, addresseeOf(n)), n.BillAddress)
}

// defaultAccount picks the account of a preference, else the only active
// account of the given types; otherwise it asks for one.
func (b *call) defaultAccount(input, what string, pref *int64, types ...string) (*account, error) {
	if strings.TrimSpace(input) != "" {
		return b.findAccount(input, types...)
	}
	all, err := b.allAccounts()
	if err != nil {
		return nil, err
	}
	if pref != nil {
		for i := range all {
			if all[i].ID == *pref && containsStr(types, all[i].Type) {
				return &all[i], nil
			}
		}
	}
	var pool []account
	for _, a := range all {
		if a.Active && containsStr(types, a.Type) && a.Special != "UndepositedFunds" {
			pool = append(pool, a)
		}
	}
	switch len(pool) {
	case 0:
		return nil, userErr("This company file has no %s account yet.", strings.Join(types, " or "))
	case 1:
		return &pool[0], nil
	}
	var names []string
	for i, a := range pool {
		if i == 10 {
			break
		}
		names = append(names, accountLabelShort(a))
	}
	return nil, userErr("Which %s? Ask the user and pass it: %s.", what, strings.Join(names, "; "))
}

// nextCheckNumber is the next check number of a bank account ("" when none).
func (b *call) nextCheckNumber(accountID int64) string {
	var r struct {
		RefNumber string `json:"refNumber"`
	}
	if err := b.get("/next-ref", url.Values{"type": {"CHK"}, "accountId": {fmt.Sprint(accountID)}}, &r); err != nil {
		return ""
	}
	return r.RefNumber
}

// ---------------------------------------------------------------------------
// Lines

type salesLineIn struct {
	Item        string   `json:"item" jsonschema:"Item exactly as listed (Parent:Sub for a subitem), or its id."`
	Description string   `json:"description,omitempty" jsonschema:"Line description (default: the item's description)."`
	Quantity    *float64 `json:"quantity,omitempty" jsonschema:"Quantity (default 1)."`
	Rate        *float64 `json:"rate,omitempty" jsonschema:"Price per unit in dollars (default: the item's price). For a percent discount or charge, the percent."`
	Amount      *float64 `json:"amount,omitempty" jsonschema:"Line amount in dollars, instead of quantity and rate."`
	Taxable     *bool    `json:"taxable,omitempty" jsonschema:"Whether the line is taxable (default: from the item and the customer)."`
	Class       string   `json:"class,omitempty" jsonschema:"Class of the line."`
}

// lineTaxable: the item is taxable and the customer is taxable (as the
// SerieX sales forms set the TAX column).
func lineTaxable(it *item, customerTaxable bool) bool {
	switch it.Type {
	case "Subtotal", "Payment", "Sales Tax Item", "Sales Tax Group", "Group":
		return false
	}
	return it.Taxable && customerTaxable
}

// salesLines turns invoice lines into transaction lines. A group item
// becomes a description line with the group's name, then its items (their
// quantities multiplied by the group's quantity), each taxed on its own, as
// the SerieX sales forms do.
func (b *call) salesLines(in []salesLineIn, customerTaxable bool) ([]txnLine, error) {
	var out []txnLine
	for i, l := range in {
		lineErr := func(format string, args ...any) error {
			return userErr("Line %d (%s): %s", i+1, l.Item, fmt.Sprintf(format, args...))
		}
		it, err := b.findItem(l.Item)
		if err != nil {
			return nil, userErr("Line %d: %v", i+1, err)
		}
		switch it.Type {
		case "Sales Tax Item", "Sales Tax Group":
			return nil, lineErr("sales tax is not entered as a line; pass the tax item as \"tax_item\".")
		case "Payment":
			return nil, lineErr("a payment is not entered on an invoice; record it with receive_payment.")
		}
		classID, err := b.classID(l.Class)
		if err != nil {
			return nil, userErr("Line %d: %v", i+1, err)
		}
		taxable := func(x *item) bool {
			switch {
			case l.Taxable == nil:
				return lineTaxable(x, customerTaxable)
			case *l.Taxable:
				return lineTaxable(x, true)
			}
			return false
		}
		if it.Type == "Group" {
			if l.Rate != nil || l.Amount != nil {
				return nil, lineErr("a group is sold at the prices of its items: give only the quantity, or list the items one by one.")
			}
			mul := 1.0
			if l.Quantity != nil {
				mul = *l.Quantity
			}
			if mul <= 0 {
				return nil, lineErr("the quantity of a group must be more than 0.")
			}
			desc := orStr(l.Description, groupLineText(it, mul))
			out = append(out, txnLine{Description: desc, ClassID: classID})
			n := 0
			for _, m := range it.GroupLines {
				mi := b.itemByID(&m.ItemID)
				if mi == nil || mi.Type == "Group" {
					continue
				}
				q := m.Qty
				if q == 0 {
					q = 1
				}
				ln := memberLine(mi, math.Round(q*mul*100000)/100000, taxable(mi))
				ln.ClassID = classID
				out = append(out, ln)
				n++
			}
			if n == 0 {
				return nil, lineErr("this group has no items.")
			}
			continue
		}
		ln := txnLine{ItemID: &it.ID, Description: orStr(l.Description, it.Description), Taxable: taxable(it), ClassID: classID}
		switch {
		case it.Type == "Subtotal":
			ln.Taxable = false
		case it.RateIsPercent:
			if l.Amount != nil {
				return nil, lineErr("this item is a percentage of the line above; give \"rate\" (the percent) instead of an amount.")
			}
			r := it.SalesPrice
			if l.Rate != nil {
				r = *l.Rate
			}
			ln.Rate, ln.RateIsPercent = &r, true
		case it.Type == "Discount":
			a := it.SalesPrice
			switch {
			case l.Amount != nil:
				a = *l.Amount
			case l.Rate != nil:
				a = *l.Rate
			}
			if a == 0 {
				return nil, lineErr("give the discount amount.")
			}
			ln.Amount = -math.Abs(round2(a))
		default:
			amt, q, r, err := lineAmount(l.Quantity, l.Rate, l.Amount, it.SalesPrice, "price", "rate")
			if err != nil {
				return nil, lineErr("%v", err)
			}
			ln.Qty, ln.Rate, ln.Amount = q, r, amt
		}
		out = append(out, ln)
	}
	return out, nil
}

// groupLineText is the description line put above a group's items:
// "Spring Planting Package (2): Lavender border...".
func groupLineText(g *item, qn float64) string {
	name := g.FullName
	if qn != 1 {
		name = fmt.Sprintf("%s (%s)", name, qty(qn))
	}
	if g.Description != "" {
		return name + ": " + g.Description
	}
	return name
}

// memberLine is the line of one item of a group, at the item's own price.
func memberLine(it *item, qn float64, taxable bool) txnLine {
	ln := txnLine{ItemID: &it.ID, Description: it.Description, Taxable: taxable}
	switch {
	case it.Type == "Subtotal":
		ln.Taxable = false
	case it.RateIsPercent:
		r := it.SalesPrice
		ln.Rate, ln.RateIsPercent = &r, true
	case it.Type == "Discount":
		r := -math.Abs(it.SalesPrice)
		ln.Rate, ln.Amount = &r, r
	default:
		q, r := qn, it.SalesPrice
		ln.Qty, ln.Rate, ln.Amount = &q, &r, round2(q*r)
	}
	return ln
}

// lineAmount works out quantity, rate and amount of a line. price is the
// default rate (the item's price or cost); noun names it ("price", "cost")
// and arg is the argument that gives it ("rate", "cost").
func lineAmount(qn, rate, amount *float64, price float64, noun, arg string) (float64, *float64, *float64, error) {
	switch {
	case qn != nil && rate != nil:
		a := round2(*qn * *rate)
		if amount != nil && cents(*amount) != cents(a) {
			return 0, nil, nil, fmt.Errorf("the amount %s does not equal quantity × %s (%s × %s = %s)", money(*amount), arg, qty(*qn), money(*rate), money(a))
		}
		return a, qn, rate, nil
	case amount != nil && qn != nil:
		if *qn == 0 {
			return 0, nil, nil, fmt.Errorf("the quantity cannot be 0 with an amount")
		}
		r := math.Round(*amount / *qn * 100000) / 100000
		return round2(*amount), qn, &r, nil
	case amount != nil && rate != nil:
		if *rate == 0 {
			return round2(*amount), nil, nil, nil
		}
		q := math.Round(*amount / *rate * 100000) / 100000
		return round2(*amount), &q, rate, nil
	case amount != nil:
		return round2(*amount), nil, nil, nil
	case rate != nil:
		q := 1.0
		return round2(*rate), &q, rate, nil
	}
	if price == 0 {
		return 0, nil, nil, fmt.Errorf("the item has no %s: give the %s or the amount", noun, arg)
	}
	q := 1.0
	if qn != nil {
		q = *qn
	}
	r := price
	return round2(q * r), &q, &r, nil
}

type purchaseLineIn struct {
	Account  string   `json:"account,omitempty" jsonschema:"Expense (or other) account of the line. Give an account or an item."`
	Item     string   `json:"item,omitempty" jsonschema:"Item bought. Give an account or an item."`
	Amount   *float64 `json:"amount,omitempty" jsonschema:"Line amount in dollars (required on account lines)."`
	Quantity *float64 `json:"quantity,omitempty" jsonschema:"Item lines: quantity (default 1)."`
	Cost     *float64 `json:"cost,omitempty" jsonschema:"Item lines: cost per unit in dollars (default: the item's cost)."`
	Memo     string   `json:"memo,omitempty" jsonschema:"Line description."`
	Customer string   `json:"customer,omitempty" jsonschema:"Customer or Customer:Job this cost is for."`
	Billable bool     `json:"billable,omitempty" jsonschema:"With customer: the cost can be billed to the customer later."`
	Class    string   `json:"class,omitempty" jsonschema:"Class of the line."`
}

// purchaseLines turns bill or check lines into transaction lines.
func (b *call) purchaseLines(in []purchaseLineIn) ([]txnLine, error) {
	var out []txnLine
	for i, l := range in {
		hasAcct, hasItem := strings.TrimSpace(l.Account) != "", strings.TrimSpace(l.Item) != ""
		if hasAcct == hasItem {
			return nil, userErr("Line %d: give either an account or an item.", i+1)
		}
		ln := txnLine{Description: l.Memo}
		var err error
		if ln.ClassID, err = b.classID(l.Class); err != nil {
			return nil, userErr("Line %d: %v", i+1, err)
		}
		if l.Customer != "" {
			c, err := b.findName(l.Customer, "customer")
			if err != nil {
				return nil, userErr("Line %d: %v", i+1, err)
			}
			ln.NameID = &c.ID
			ln.Billable = l.Billable
		} else if l.Billable {
			return nil, userErr("Line %d: a billable cost needs the customer it is billed to.", i+1)
		}
		if hasAcct {
			a, err := b.findAccount(l.Account)
			if err != nil {
				return nil, userErr("Line %d: %v", i+1, err)
			}
			if l.Amount == nil || *l.Amount == 0 {
				return nil, userErr("Line %d (%s): give the amount.", i+1, a.FullName)
			}
			ln.AccountID, ln.Amount = &a.ID, round2(*l.Amount)
			out = append(out, ln)
			continue
		}
		it, err := b.findItem(l.Item)
		if err != nil {
			return nil, userErr("Line %d: %v", i+1, err)
		}
		ln.ItemID = &it.ID
		ln.Description = orStr(l.Memo, orStr(it.PurchaseDesc, it.Description))
		amt, q, r, err := lineAmount(l.Quantity, l.Cost, l.Amount, it.Cost, "cost", "cost")
		if err != nil {
			return nil, userErr("Line %d (%s): %v", i+1, it.FullName, err)
		}
		ln.Qty, ln.Rate, ln.Amount = q, r, amt
		out = append(out, ln)
	}
	return out, nil
}

// ---------------------------------------------------------------------------

func (s *service) writeTools() []toolDef {
	var defs []toolDef
	// ------------------------------------------------------------------ customers / vendors
	type createCustomerIn struct {
		companyArg
		Name          string     `json:"name" jsonschema:"Name shown in lists (must not be used by another customer, vendor or other name). For a job: the job name only, with job_of."`
		JobOf         string     `json:"job_of,omitempty" jsonschema:"Create a job of this existing customer (it copies the customer's contact, terms and tax settings)."`
		CompanyName   string     `json:"company_name,omitempty"`
		FirstName     string     `json:"first_name,omitempty"`
		LastName      string     `json:"last_name,omitempty"`
		Email         string     `json:"email,omitempty"`
		Phone         string     `json:"phone,omitempty"`
		Address       *addressIn `json:"address,omitempty" jsonschema:"Billing address (also used for shipping)."`
		Terms         string     `json:"terms,omitempty" jsonschema:"Payment terms, for example Net 30 (see company_info)."`
		CreditLimit   *float64   `json:"credit_limit,omitempty" jsonschema:"Credit limit in dollars."`
		Taxable       *bool      `json:"taxable,omitempty" jsonschema:"Whether sales to this customer are taxable (default yes)."`
		AccountNumber string     `json:"account_number,omitempty" jsonschema:"Account number of the customer."`
		Notes         string     `json:"notes,omitempty"`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "create_customer", "Create a customer",
		"Add a customer (or a job of a customer) with contact details, address, terms and tax setting."+changesNote,
		fixConfirm, func(ctx context.Context, in createCustomerIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			nm := strings.TrimSpace(in.Name)
			if nm == "" {
				return "", userErr("Give the customer name.")
			}
			body := map[string]any{"kind": "customer", "name": nm, "active": true, "taxable": true,
				"billAddress": in.Address.toAddress(), "shipAddress": in.Address.toAddress()}
			if in.JobOf != "" {
				parent, err := bk.findName(in.JobOf, "customer")
				if err != nil {
					return "", err
				}
				body["parentId"] = parent.ID
				body["companyName"], body["firstName"], body["lastName"] = parent.CompanyName, parent.FirstName, parent.LastName
				body["email"], body["phone"], body["termsId"], body["taxable"] = parent.Email, parent.Phone, parent.TermsID, parent.Taxable
				body["taxItemId"], body["repId"], body["paymentMethodId"] = parent.TaxItemID, parent.RepID, parent.PayMethodID
				body["jobStatus"] = "Pending"
				if in.Address == nil {
					body["billAddress"], body["shipAddress"] = parent.BillAddress, parent.ShipAddress
				}
			}
			for k, v := range map[string]string{"companyName": in.CompanyName, "firstName": in.FirstName, "lastName": in.LastName,
				"email": in.Email, "phone": in.Phone, "accountNumber": in.AccountNumber, "notes": in.Notes} {
				if strings.TrimSpace(v) != "" {
					body[k] = strings.TrimSpace(v)
				}
			}
			if in.Terms != "" {
				if body["termsId"], err = bk.entryID("terms", in.Terms); err != nil {
					return "", err
				}
			}
			if in.CreditLimit != nil {
				body["creditLimit"] = round2(*in.CreditLimit)
			}
			if in.Taxable != nil {
				body["taxable"] = *in.Taxable
			}
			var out name
			if err := bk.save(in.ConfirmWarnings, func(q url.Values) error { return bk.post("/names", q, body, &out) }); err != nil {
				return "", err
			}
			what := "customer"
			if out.ParentID != nil {
				what = "job"
			}
			return fmt.Sprintf("Created the %s %s (id %d) in %s.", what, out.FullName, out.ID, bk.where()), nil
		}))

	type createVendorIn struct {
		companyArg
		Name           string     `json:"name" jsonschema:"Name shown in lists (must not be used by another customer, vendor or other name)."`
		CompanyName    string     `json:"company_name,omitempty"`
		FirstName      string     `json:"first_name,omitempty"`
		LastName       string     `json:"last_name,omitempty"`
		Email          string     `json:"email,omitempty"`
		Phone          string     `json:"phone,omitempty"`
		Address        *addressIn `json:"address,omitempty" jsonschema:"Address printed on checks."`
		Terms          string     `json:"terms,omitempty" jsonschema:"Payment terms, for example Net 30 (see company_info)."`
		AccountNumber  string     `json:"account_number,omitempty" jsonschema:"The account number this vendor gave the company."`
		Is1099         bool       `json:"is_1099,omitempty" jsonschema:"The vendor gets a Form 1099."`
		ExpenseAccount string     `json:"expense_account,omitempty" jsonschema:"Account usually used for this vendor's bills."`
		Notes          string     `json:"notes,omitempty"`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "create_vendor", "Create a vendor",
		"Add a vendor with contact details, address, terms and the account usually used for its bills."+changesNote,
		fixConfirm, func(ctx context.Context, in createVendorIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			nm := strings.TrimSpace(in.Name)
			if nm == "" {
				return "", userErr("Give the vendor name.")
			}
			body := map[string]any{"kind": "vendor", "name": nm, "active": true, "is1099": in.Is1099,
				"printOnCheckAs": orStr(strings.TrimSpace(in.CompanyName), nm),
				"billAddress":    in.Address.toAddress(), "shipAddress": (*addressIn)(nil).toAddress()}
			for k, v := range map[string]string{"companyName": in.CompanyName, "firstName": in.FirstName, "lastName": in.LastName,
				"email": in.Email, "phone": in.Phone, "accountNumber": in.AccountNumber, "notes": in.Notes} {
				if strings.TrimSpace(v) != "" {
					body[k] = strings.TrimSpace(v)
				}
			}
			if in.Terms != "" {
				if body["termsId"], err = bk.entryID("terms", in.Terms); err != nil {
					return "", err
				}
			}
			if in.ExpenseAccount != "" {
				a, err := bk.findAccount(in.ExpenseAccount)
				if err != nil {
					return "", err
				}
				body["prefillAccountIds"] = []int64{a.ID}
			}
			var out name
			if err := bk.save(in.ConfirmWarnings, func(q url.Values) error { return bk.post("/names", q, body, &out) }); err != nil {
				return "", err
			}
			return fmt.Sprintf("Created the vendor %s (id %d) in %s.", out.FullName, out.ID, bk.where()), nil
		}))

	// ------------------------------------------------------------------ items
	type createItemIn struct {
		companyArg
		Name                string   `json:"name" jsonschema:"Item name."`
		Type                string   `json:"type" jsonschema:"service (work and fees) or non_inventory (goods not tracked in inventory)."`
		SubitemOf           string   `json:"subitem_of,omitempty" jsonschema:"Make it a subitem of this item (same type)."`
		Description         string   `json:"description,omitempty" jsonschema:"Description printed on sales forms."`
		Price               *float64 `json:"price,omitempty" jsonschema:"Sales price per unit in dollars."`
		IncomeAccount       string   `json:"income_account,omitempty" jsonschema:"Income account sales of the item go to. May be left out when the company has a single income account."`
		Taxable             *bool    `json:"taxable,omitempty" jsonschema:"Whether the item is taxable (default: no for services, yes for non-inventory items)."`
		PurchaseCost        *float64 `json:"purchase_cost,omitempty" jsonschema:"Cost per unit when the item is also bought (needs expense_account)."`
		ExpenseAccount      string   `json:"expense_account,omitempty" jsonschema:"Expense account purchases of the item go to (when it is also bought)."`
		PurchaseDescription string   `json:"purchase_description,omitempty" jsonschema:"Description printed on purchase forms."`
		PreferredVendor     string   `json:"preferred_vendor,omitempty" jsonschema:"Vendor the item is usually bought from."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "create_item", "Create an item",
		"Add a service or non-inventory item (something the company sells, and possibly buys) with its price and accounts."+changesNote,
		func(sc *jsonschema.Schema) {
			fixConfirm(sc)
			enum(sc, "type", "service", "non_inventory")
		},
		func(ctx context.Context, in createItemIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			typ := map[string]string{"service": "Service", "non_inventory": "Non-inventory Part"}[in.Type]
			if typ == "" {
				return "", userErr("type must be service or non_inventory.")
			}
			nm := strings.TrimSpace(in.Name)
			if nm == "" {
				return "", userErr("Give the item name.")
			}
			income, err := bk.defaultAccount(in.IncomeAccount, "income account", nil, "Income", "Other Income")
			if err != nil {
				return "", err
			}
			body := map[string]any{"type": typ, "name": nm, "description": strings.TrimSpace(in.Description), "active": true,
				"incomeAccountId": income.ID, "taxable": typ == "Non-inventory Part", "groupLines": []any{}}
			if in.Price != nil {
				body["salesPrice"] = *in.Price
			}
			if in.Taxable != nil {
				body["taxable"] = *in.Taxable
			}
			if in.SubitemOf != "" {
				parent, err := bk.findItem(in.SubitemOf, typ)
				if err != nil {
					return "", err
				}
				body["parentId"] = parent.ID
			}
			if in.PurchaseCost != nil || in.ExpenseAccount != "" || in.PurchaseDescription != "" || in.PreferredVendor != "" {
				if in.ExpenseAccount == "" {
					return "", userErr("An item that is also bought needs expense_account (the account its purchases go to).")
				}
				exp, err := bk.findAccount(in.ExpenseAccount)
				if err != nil {
					return "", err
				}
				body["isPurchased"], body["expenseAccountId"] = true, exp.ID
				body["purchaseDescription"] = strings.TrimSpace(in.PurchaseDescription)
				if in.PurchaseCost != nil {
					body["cost"] = *in.PurchaseCost
				}
				if in.PreferredVendor != "" {
					v, err := bk.findName(in.PreferredVendor, "vendor")
					if err != nil {
						return "", err
					}
					body["preferredVendorId"] = v.ID
				}
			}
			var out item
			if err := bk.save(in.ConfirmWarnings, func(q url.Values) error { return bk.post("/items", q, body, &out) }); err != nil {
				return "", err
			}
			return fmt.Sprintf("Created the %s item %s (id %d) in %s: price %s, sales go to %s%s.", strings.ToLower(out.Type), out.FullName, out.ID, bk.where(),
				money(out.SalesPrice), income.FullName, map[bool]string{true: ", taxable", false: ", not taxable"}[out.Taxable]), nil
		}))

	// ------------------------------------------------------------------ invoices
	type createInvoiceIn struct {
		companyArg
		Customer    string        `json:"customer" jsonschema:"Customer or Customer:Job billed, exactly as listed."`
		Date        string        `json:"date,omitempty" jsonschema:"Invoice date (YYYY-MM-DD or today; default today)."`
		DueDate     string        `json:"due_date,omitempty" jsonschema:"Due date (default: from the terms)."`
		Number      string        `json:"number,omitempty" jsonschema:"Invoice number (default: the next number)."`
		Terms       string        `json:"terms,omitempty" jsonschema:"Payment terms (default: the customer's)."`
		PONumber    string        `json:"po_number,omitempty" jsonschema:"The customer's purchase order number."`
		TaxItem     string        `json:"tax_item,omitempty" jsonschema:"Sales tax item or group (default: the customer's, else the company's). Use \"none\" for no sales tax."`
		Class       string        `json:"class,omitempty" jsonschema:"Class of the invoice."`
		Memo        string        `json:"memo,omitempty" jsonschema:"Internal memo (not printed)."`
		ToBePrinted bool          `json:"to_be_printed,omitempty" jsonschema:"Add it to the invoices to print."`
		Lines       []salesLineIn `json:"lines" jsonschema:"What is billed, one entry per line."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "create_invoice", "Create an invoice",
		"Record an invoice to a customer: the items sold with quantity and rate (prices default to the item's), sales tax computed by SerieX, terms and due date from the customer. A group item is entered as its items, each taxed on its own."+changesNote,
		func(sc *jsonschema.Schema) { fixConfirm(sc); minItems(sc, "lines", 1) },
		func(ctx context.Context, in createInvoiceIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			cust, err := bk.findName(in.Customer, "customer")
			if err != nil {
				return "", err
			}
			p, err := bk.preferences()
			if err != nil {
				return "", err
			}
			t := &txn{Type: "INV", NameID: &cust.ID, RefNumber: strings.TrimSpace(in.Number), PONumber: strings.TrimSpace(in.PONumber),
				Memo: in.Memo, ToBePrinted: in.ToBePrinted}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if t.DueDate, err = parseDate("due_date", in.DueDate); err != nil {
				return "", err
			}
			if in.Terms != "" {
				if t.TermsID, err = bk.entryID("terms", in.Terms); err != nil {
					return "", err
				}
			} else {
				t.TermsID = bk.inherited(cust, func(n *name) *int64 { return n.TermsID })
			}
			t.RepID = bk.inherited(cust, func(n *name) *int64 { return n.RepID })
			if t.TaxItemID, err = bk.taxItem(in.TaxItem, cust, p); err != nil {
				return "", err
			}
			if t.ClassID, err = bk.classID(in.Class); err != nil {
				return "", err
			}
			t.BillAddress, t.ShipAddress = bk.customerAddresses(cust)
			if t.Lines, err = bk.salesLines(in.Lines, cust.Taxable); err != nil {
				return "", err
			}
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			return "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved), nil
		}))

	// ------------------------------------------------------------------ customer payments
	type applyIn struct {
		TxnID  int64    `json:"txn_id,omitempty" jsonschema:"Txn id of the invoice or charge (see open_invoices)."`
		Number string   `json:"number,omitempty" jsonschema:"Invoice number, when the txn id is not known."`
		Amount *float64 `json:"amount,omitempty" jsonschema:"Amount applied in dollars (default: as much of the open balance as the payment covers)."`
	}
	type receivePaymentIn struct {
		companyArg
		Customer      string    `json:"customer" jsonschema:"Customer or Customer:Job who paid."`
		Amount        float64   `json:"amount" jsonschema:"Amount received in dollars."`
		Date          string    `json:"date,omitempty" jsonschema:"Date received (YYYY-MM-DD or today; default today)."`
		PaymentMethod string    `json:"payment_method,omitempty" jsonschema:"Payment method, for example Check or Visa (default: the customer's)."`
		Reference     string    `json:"reference,omitempty" jsonschema:"Check number or other reference of the payment."`
		DepositTo     string    `json:"deposit_to,omitempty" jsonschema:"Account the money goes to. Default: Undeposited Funds (deposit it later with record_deposit), or the company's default deposit account."`
		Memo          string    `json:"memo,omitempty"`
		ApplyTo       []applyIn `json:"apply_to,omitempty" jsonschema:"Invoices this payment pays. Default: the customer's oldest open invoices first."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "receive_payment", "Receive a payment",
		"Record a payment from a customer and apply it to open invoices (the oldest first unless apply_to says which). Money not applied stays as a credit for the customer."+changesNote,
		fixConfirm, func(ctx context.Context, in receivePaymentIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			cust, err := bk.findName(in.Customer, "customer")
			if err != nil {
				return "", err
			}
			if cents(in.Amount) <= 0 {
				return "", userErr("Give the amount received (more than 0).")
			}
			t := &txn{Type: "PMT", NameID: &cust.ID, Amount: round2(in.Amount), RefNumber: strings.TrimSpace(in.Reference), Memo: in.Memo}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if in.PaymentMethod != "" {
				if t.PaymentMethodID, err = bk.entryID("payment_method", in.PaymentMethod); err != nil {
					return "", err
				}
			} else {
				t.PaymentMethodID = bk.inherited(cust, func(n *name) *int64 { return n.PayMethodID })
			}
			if in.DepositTo != "" {
				a, err := bk.findAccount(in.DepositTo, "Bank", "Other Current Asset")
				if err != nil {
					return "", err
				}
				t.AccountID = &a.ID
			}
			var docs openDocs
			if err := bk.get("/open-docs", url.Values{"kind": {"receivable"}, "nameId": {fmt.Sprint(cust.ID)}, "includeJobs": {"1"}}, &docs); err != nil {
				return "", err
			}
			charges := docs.Charges
			sort.SliceStable(charges, func(i, j int) bool {
				a, b := orStr(charges[i].DueDate, charges[i].Date), orStr(charges[j].DueDate, charges[j].Date)
				if a != b {
					return a < b
				}
				return charges[i].TxnID < charges[j].TxnID
			})
			remaining := cents(in.Amount)
			used := map[int64]int64{}
			var links []txnLink
			apply := func(d openDoc, want *float64) error {
				open := cents(d.OpenBalance) - used[d.TxnID]
				amt := min(open, remaining)
				if want != nil {
					amt = cents(*want)
					if amt <= 0 {
						return userErr("The amount applied to %s #%s must be more than 0.", d.TypeLabel, d.RefNumber)
					}
					if amt > open {
						return userErr("%s #%s has an open balance of %s; %s cannot be applied to it.", d.TypeLabel, d.RefNumber, money(float64(open)/100), money(*want))
					}
					if amt > remaining {
						return userErr("The amounts to apply add up to more than the payment of %s.", money(in.Amount))
					}
				}
				if amt <= 0 {
					return nil
				}
				used[d.TxnID] += amt
				remaining -= amt
				links = append(links, txnLink{ToTxnID: d.TxnID, Amount: float64(amt) / 100})
				return nil
			}
			if len(in.ApplyTo) == 0 {
				for _, d := range charges {
					if remaining <= 0 {
						break
					}
					if err := apply(d, nil); err != nil {
						return "", err
					}
				}
			}
			for _, a := range in.ApplyTo {
				var found []openDoc
				for _, d := range charges {
					if (a.TxnID != 0 && d.TxnID == a.TxnID) || (a.TxnID == 0 && a.Number != "" && strings.EqualFold(strings.TrimSpace(a.Number), d.RefNumber)) {
						found = append(found, d)
					}
				}
				what := fmt.Sprintf("txn id %d", a.TxnID)
				if a.TxnID == 0 {
					what = "number " + a.Number
				}
				switch {
				case a.TxnID == 0 && a.Number == "":
					return "", userErr("Each entry of apply_to needs txn_id or number.")
				case len(found) == 0:
					var open []string
					for i, d := range charges {
						if i == 10 {
							break
						}
						open = append(open, fmt.Sprintf("%s #%s (txn id %d, open %s)", d.TypeLabel, d.RefNumber, d.TxnID, money(d.OpenBalance)))
					}
					if len(open) == 0 {
						return "", userErr("%s has no open invoices.", cust.FullName)
					}
					return "", userErr("No open invoice of %s has %s. Open: %s.", cust.FullName, what, strings.Join(open, "; "))
				case len(found) > 1:
					return "", userErr("Several open invoices have %s; pass the txn id instead.", what)
				}
				if err := apply(found[0], a.Amount); err != nil {
					return "", err
				}
			}
			ar := map[int64]bool{}
			for _, l := range links {
				for _, d := range charges {
					if d.TxnID == l.ToTxnID {
						ar[d.ArApAccountID] = true
					}
				}
			}
			if len(ar) > 1 {
				return "", userErr("These invoices are in different Accounts Receivable accounts; record one payment for each account.")
			}
			for id := range ar {
				t.ArApAccountID = ptr(id)
			}
			t.Links = links
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			out := "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved)
			if remaining > 0 {
				out += fmt.Sprintf("\n%s was not applied to an invoice: it stays as a credit for %s.\n", money(float64(remaining)/100), cust.FullName)
			}
			return out, nil
		}))

	// ------------------------------------------------------------------ bills
	type enterBillIn struct {
		companyArg
		Vendor    string           `json:"vendor" jsonschema:"Vendor billed by, exactly as listed."`
		Date      string           `json:"date,omitempty" jsonschema:"Bill date (YYYY-MM-DD or today; default today)."`
		DueDate   string           `json:"due_date,omitempty" jsonschema:"Due date (default: from the terms, or the company's default for bills)."`
		Reference string           `json:"reference,omitempty" jsonschema:"The vendor's bill or invoice number."`
		Terms     string           `json:"terms,omitempty" jsonschema:"Payment terms (default: the vendor's)."`
		Memo      string           `json:"memo,omitempty"`
		Lines     []purchaseLineIn `json:"lines" jsonschema:"What the bill is for: expense account lines, item lines, or both."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "enter_bill", "Enter a bill",
		"Record a bill from a vendor (money owed, to pay later with pay_bills), with expense account lines or item lines."+changesNote,
		func(sc *jsonschema.Schema) { fixConfirm(sc); minItems(sc, "lines", 1) },
		func(ctx context.Context, in enterBillIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			v, err := bk.findName(in.Vendor, "vendor")
			if err != nil {
				return "", err
			}
			t := &txn{Type: "BILL", NameID: &v.ID, RefNumber: strings.TrimSpace(in.Reference), Memo: in.Memo, BillAddress: payeeAddress(v)}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if t.DueDate, err = parseDate("due_date", in.DueDate); err != nil {
				return "", err
			}
			if in.Terms != "" {
				if t.TermsID, err = bk.entryID("terms", in.Terms); err != nil {
					return "", err
				}
			} else {
				t.TermsID = v.TermsID
			}
			if t.Lines, err = bk.purchaseLines(in.Lines); err != nil {
				return "", err
			}
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			return "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved), nil
		}))

	type payBillIn struct {
		BillID int64    `json:"bill_id" jsonschema:"Txn id of the bill (see unpaid_bills)."`
		Amount *float64 `json:"amount,omitempty" jsonschema:"Amount to pay in dollars (default: the open balance)."`
	}
	type payBillsIn struct {
		companyArg
		Bills            []payBillIn `json:"bills,omitempty" jsonschema:"Bills to pay. Give bills or vendor."`
		Vendor           string      `json:"vendor,omitempty" jsonschema:"Pay every open bill of this vendor (when bills is not given)."`
		PayFrom          string      `json:"pay_from,omitempty" jsonschema:"Bank or credit card account to pay from (default: the company's account for paying bills)."`
		Date             string      `json:"date,omitempty" jsonschema:"Payment date (YYYY-MM-DD or today; default today)."`
		ToBePrinted      bool        `json:"to_be_printed,omitempty" jsonschema:"The checks will be printed later from SerieX."`
		FirstCheckNumber string      `json:"first_check_number,omitempty" jsonschema:"Number of the first check (one check per vendor). Default: the next number of the account."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "pay_bills", "Pay bills",
		"Pay open bills from a bank or credit card account: one bill payment per vendor, for the open balance unless an amount is given. Vendor credits are not applied (use the SerieX app for that)."+changesNote,
		fixConfirm, func(ctx context.Context, in payBillsIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			if len(in.Bills) == 0 && in.Vendor == "" {
				return "", userErr("Give the bills to pay (bill_id from unpaid_bills) or the vendor.")
			}
			p, err := bk.preferences()
			if err != nil {
				return "", err
			}
			pref := p.DefaultBillPayAccountID
			if pref == nil {
				pref = p.DefaultCheckAccountID
			}
			from, err := bk.defaultAccount(in.PayFrom, "account to pay from", pref, "Bank", "Credit Card")
			if err != nil {
				return "", err
			}
			date, err := dateOr("date", in.Date)
			if err != nil {
				return "", err
			}
			q := url.Values{"kind": {"payable"}}
			if in.Vendor != "" {
				v, err := bk.findName(in.Vendor, "vendor")
				if err != nil {
					return "", err
				}
				q.Set("nameId", fmt.Sprint(v.ID))
			}
			var docs openDocs
			if err := bk.get("/open-docs", q, &docs); err != nil {
				return "", err
			}
			type payItem struct {
				BillID   int64   `json:"billId"`
				Amount   float64 `json:"amount"`
				Discount float64 `json:"discount"`
				Credits  []any   `json:"credits"`
			}
			var items []payItem
			if len(in.Bills) == 0 {
				for _, d := range docs.Charges {
					if d.OpenBalance > 0 {
						items = append(items, payItem{BillID: d.TxnID, Amount: d.OpenBalance, Credits: []any{}})
					}
				}
				if len(items) == 0 {
					return "", userErr("%s has no unpaid bills.", in.Vendor)
				}
			}
			for _, b := range in.Bills {
				var doc *openDoc
				for i := range docs.Charges {
					if docs.Charges[i].TxnID == b.BillID {
						doc = &docs.Charges[i]
					}
				}
				if doc == nil {
					return "", userErr("Txn id %d is not an unpaid bill%s. Use unpaid_bills to find the bills.", b.BillID, map[bool]string{true: " of " + in.Vendor, false: ""}[in.Vendor != ""])
				}
				amt := doc.OpenBalance
				if b.Amount != nil {
					amt = round2(*b.Amount)
					if cents(amt) <= 0 || cents(amt) > cents(doc.OpenBalance) {
						return "", userErr("Bill %s of %s has an open balance of %s; pay more than 0 and at most that.", orStr(doc.RefNumber, fmt.Sprint(doc.TxnID)), doc.NameFull, money(doc.OpenBalance))
					}
				}
				items = append(items, payItem{BillID: doc.TxnID, Amount: amt, Credits: []any{}})
			}
			first := strings.TrimSpace(in.FirstCheckNumber)
			if first == "" && !in.ToBePrinted && from.Type == "Bank" {
				first = bk.nextCheckNumber(from.ID)
			}
			body := map[string]any{"date": date, "accountId": from.ID, "toBePrinted": in.ToBePrinted && from.Type == "Bank", "firstCheckNumber": first, "bills": items}
			if err := bk.checkDate(date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			var res payBillsResult
			if err := bk.save(in.ConfirmWarnings, func(q url.Values) error { return bk.post("/pay-bills", q, body, &res) }); err != nil {
				return "", err
			}
			var total float64
			for _, r := range res.Payments {
				total += r.Amount
			}
			return fmt.Sprintf("Saved %s from %s in %s, total %s.\n\n%s", plural(len(res.Payments), "bill payment", "bill payments"), from.FullName, bk.where(), money(total), txnTable(res.Payments)), nil
		}))

	// ------------------------------------------------------------------ checks
	type writeCheckIn struct {
		companyArg
		BankAccount string           `json:"bank_account,omitempty" jsonschema:"Bank account the check is drawn on (default: the company's checking account)."`
		Payee       string           `json:"payee,omitempty" jsonschema:"Who is paid: a vendor, customer or other name exactly as listed."`
		Date        string           `json:"date,omitempty" jsonschema:"Check date (YYYY-MM-DD or today; default today)."`
		CheckNumber string           `json:"check_number,omitempty" jsonschema:"Check number (default: the next number of the account, unless to_be_printed)."`
		ToBePrinted bool             `json:"to_be_printed,omitempty" jsonschema:"The check will be printed later from SerieX (it gets its number then)."`
		Memo        string           `json:"memo,omitempty" jsonschema:"Memo printed on the check."`
		Lines       []purchaseLineIn `json:"lines" jsonschema:"What the check pays for: expense account lines, item lines, or both."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "write_check", "Write a check",
		"Record a check (or another payment made straight from a bank account, such as a debit) for expenses or items. To pay bills already entered, use pay_bills."+changesNote,
		func(sc *jsonschema.Schema) { fixConfirm(sc); minItems(sc, "lines", 1) },
		func(ctx context.Context, in writeCheckIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			p, err := bk.preferences()
			if err != nil {
				return "", err
			}
			bank, err := bk.defaultAccount(in.BankAccount, "bank account", p.DefaultCheckAccountID, "Bank")
			if err != nil {
				return "", err
			}
			t := &txn{Type: "CHK", AccountID: &bank.ID, Memo: in.Memo, ToBePrinted: in.ToBePrinted}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if in.Payee != "" {
				n, err := bk.findName(in.Payee)
				if err != nil {
					return "", err
				}
				t.NameID, t.BillAddress = &n.ID, payeeAddress(n)
			}
			switch {
			case in.ToBePrinted:
			case strings.TrimSpace(in.CheckNumber) != "":
				t.RefNumber = strings.TrimSpace(in.CheckNumber)
			default:
				t.RefNumber = bk.nextCheckNumber(bank.ID)
			}
			if t.Lines, err = bk.purchaseLines(in.Lines); err != nil {
				return "", err
			}
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			return "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved), nil
		}))

	// ------------------------------------------------------------------ deposits
	type depositLineIn struct {
		Account       string  `json:"account" jsonschema:"Account the money comes from (for example an income account, a loan or owner's equity)."`
		Amount        float64 `json:"amount" jsonschema:"Amount in dollars."`
		ReceivedFrom  string  `json:"received_from,omitempty" jsonschema:"Customer, vendor or other name the money came from."`
		Memo          string  `json:"memo,omitempty"`
		CheckNumber   string  `json:"check_number,omitempty"`
		PaymentMethod string  `json:"payment_method,omitempty"`
		Class         string  `json:"class,omitempty"`
	}
	type recordDepositIn struct {
		companyArg
		DepositTo      string          `json:"deposit_to,omitempty" jsonschema:"Bank account the money goes to (default: the company's deposit account, or the only bank account)."`
		Date           string          `json:"date,omitempty" jsonschema:"Deposit date (YYYY-MM-DD or today; default today)."`
		Memo           string          `json:"memo,omitempty"`
		PaymentIDs     []int64         `json:"payment_ids,omitempty" jsonschema:"Txn ids of payments waiting in Undeposited Funds to include (see undeposited_funds)."`
		AllUndeposited bool            `json:"all_undeposited,omitempty" jsonschema:"Include every payment waiting in Undeposited Funds."`
		OtherLines     []depositLineIn `json:"other_lines,omitempty" jsonschema:"Other money deposited that is not a customer payment."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "record_deposit", "Record a deposit",
		"Record a bank deposit of customer payments waiting in Undeposited Funds, of other money received (interest, a loan, an owner's contribution), or of both."+changesNote,
		fixConfirm, func(ctx context.Context, in recordDepositIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			p, err := bk.preferences()
			if err != nil {
				return "", err
			}
			t := &txn{Type: "DEP", Memo: in.Memo}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if in.AllUndeposited || len(in.PaymentIDs) > 0 {
				var waiting []undepositedItem
				if err := bk.get("/undeposited", nil, &waiting); err != nil {
					return "", err
				}
				want := map[int64]bool{}
				for _, id := range in.PaymentIDs {
					want[id] = true
				}
				found := map[int64]bool{}
				for _, u := range waiting {
					if !in.AllUndeposited && !want[u.TxnID] {
						continue
					}
					found[u.TxnID] = true
					tid := u.TxnID
					t.Lines = append(t.Lines, txnLine{LinkedTxnID: &tid, LinkedLineID: u.LineID, Amount: u.Amount})
				}
				for _, id := range in.PaymentIDs {
					if !found[id] {
						return "", userErr("Txn id %d is not waiting in Undeposited Funds. Use undeposited_funds to see what can be deposited.", id)
					}
				}
				if in.AllUndeposited && len(waiting) == 0 && len(in.OtherLines) == 0 {
					return "", userErr("Nothing is waiting in Undeposited Funds.")
				}
			}
			for i, l := range in.OtherLines {
				a, err := bk.findAccount(l.Account)
				if err != nil {
					return "", userErr("Other line %d: %v", i+1, err)
				}
				ln := txnLine{AccountID: &a.ID, Amount: round2(l.Amount), Description: l.Memo, RefNumber: strings.TrimSpace(l.CheckNumber)}
				if l.ReceivedFrom != "" {
					n, err := bk.findName(l.ReceivedFrom)
					if err != nil {
						return "", userErr("Other line %d: %v", i+1, err)
					}
					ln.NameID = &n.ID
				}
				if ln.PaymentMethodID, err = bk.entryID("payment_method", l.PaymentMethod); err != nil {
					return "", userErr("Other line %d: %v", i+1, err)
				}
				if ln.ClassID, err = bk.classID(l.Class); err != nil {
					return "", userErr("Other line %d: %v", i+1, err)
				}
				t.Lines = append(t.Lines, ln)
			}
			if len(t.Lines) == 0 {
				return "", userErr("Give the payments to deposit (payment_ids or all_undeposited), other_lines, or both.")
			}
			bank, err := bk.defaultAccount(in.DepositTo, "bank account to deposit to", p.DefaultDepositAccountID, "Bank")
			if err != nil {
				return "", err
			}
			t.AccountID = &bank.ID
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			return "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved), nil
		}))

	// ------------------------------------------------------------------ journal entries
	type journalLineIn struct {
		Account string   `json:"account" jsonschema:"Account of the line."`
		Debit   *float64 `json:"debit,omitempty" jsonschema:"Debit amount in dollars (give debit or credit)."`
		Credit  *float64 `json:"credit,omitempty" jsonschema:"Credit amount in dollars (give debit or credit)."`
		Memo    string   `json:"memo,omitempty"`
		Name    string   `json:"name,omitempty" jsonschema:"Customer, vendor or other name of the line (required on Accounts Receivable and Accounts Payable lines)."`
		Class   string   `json:"class,omitempty"`
	}
	type journalIn struct {
		companyArg
		Date   string          `json:"date,omitempty" jsonschema:"Entry date (YYYY-MM-DD or today; default today)."`
		Number string          `json:"number,omitempty" jsonschema:"Entry number (default: automatic when the company numbers journal entries)."`
		Memo   string          `json:"memo,omitempty" jsonschema:"Memo of the entry."`
		Lines  []journalLineIn `json:"lines" jsonschema:"Debit and credit lines; total debits must equal total credits."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, createTool, "create_journal_entry", "Create a journal entry",
		"Record a general journal entry (debits and credits that must balance), for adjustments such as depreciation or corrections between accounts."+changesNote,
		func(sc *jsonschema.Schema) { fixConfirm(sc); minItems(sc, "lines", 2) },
		func(ctx context.Context, in journalIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			t := &txn{Type: "GENJRNL", RefNumber: strings.TrimSpace(in.Number), Memo: in.Memo}
			if t.Date, err = dateOr("date", in.Date); err != nil {
				return "", err
			}
			if len(in.Lines) < 2 {
				return "", userErr("A journal entry needs at least two lines: one debit and one credit.")
			}
			var debits, credits int64
			for i, l := range in.Lines {
				d, c := int64(0), int64(0)
				if l.Debit != nil {
					d = cents(*l.Debit)
				}
				if l.Credit != nil {
					c = cents(*l.Credit)
				}
				if d < 0 || c < 0 || (d == 0) == (c == 0) {
					return "", userErr("Line %d: give either a debit or a credit (a positive amount), not both.", i+1)
				}
				a, err := bk.findAccount(l.Account)
				if err != nil {
					return "", userErr("Line %d: %v", i+1, err)
				}
				ln := txnLine{AccountID: &a.ID, Amount: float64(d-c) / 100, Description: l.Memo}
				if l.Name != "" {
					n, err := bk.findName(l.Name)
					if err != nil {
						return "", userErr("Line %d: %v", i+1, err)
					}
					ln.NameID = &n.ID
				}
				if ln.ClassID, err = bk.classID(l.Class); err != nil {
					return "", userErr("Line %d: %v", i+1, err)
				}
				debits += d
				credits += c
				t.Lines = append(t.Lines, ln)
			}
			if debits != credits {
				return "", userErr("Not in balance: debits total %s and credits total %s. Nothing was saved.", money(float64(debits)/100), money(float64(credits)/100))
			}
			if err := bk.checkDate(t.Date, in.ConfirmWarnings); err != nil {
				return "", err
			}
			saved, err := bk.saveTxn(t, in.ConfirmWarnings)
			if err != nil {
				return "", err
			}
			return "Saved in " + bk.where() + ".\n\n" + describeTxn(bk, saved), nil
		}))

	// ------------------------------------------------------------------ void
	type voidIn struct {
		companyArg
		ID int64 `json:"id" jsonschema:"Txn id of the transaction to void."`
		confirmArg
	}
	defs = append(defs, def(s, groupWrite, destroyTool, "void_transaction", "Void a transaction",
		"Void a transaction: it stays in the books for the record but its amounts become 0 (payments applied to it are removed). Confirm with the user which transaction (number, name, amount) before voiding. Paychecks and other transactions created by SerieX Payroll are voided in SerieX Payroll, not here."+changesNote,
		fixConfirm, func(ctx context.Context, in voidIn) (string, error) {
			bk, err := s.open(ctx, in.Company, true)
			if err != nil {
				return "", err
			}
			if in.ID <= 0 {
				return "", userErr("Give the txn id of the transaction to void.")
			}
			var cur txn
			if err := bk.get(fmt.Sprintf("/txns/%d", in.ID), nil, &cur); err != nil {
				return "", err
			}
			label := joinNonEmpty(" ", txnLabel(cur.Type), refWord(cur.RefNumber))
			if cur.Voided {
				return "", userErr("%s (txn id %d) is already voided.", label, cur.ID)
			}
			if kind, ok := payrollOrigin(&cur); ok {
				return "", userErr("Nothing was voided. %s (txn id %d) was created by SerieX Payroll (%s). Void it in SerieX Payroll so payroll and the books stay in step.", label, cur.ID, kind)
			}
			before := cur.Amount
			var out txn
			if err := bk.save(in.ConfirmWarnings, func(q url.Values) error {
				return bk.post(fmt.Sprintf("/txns/%d/void", in.ID), q, nil, &out)
			}); err != nil {
				return "", err
			}
			who := ""
			if cur.NameFull != "" {
				who = " of " + cur.NameFull
			}
			return fmt.Sprintf("Voided %s%s dated %s (was %s) in %s.\n\n%s", label, who, cur.Date, money(before), bk.where(), describeTxn(bk, &out)), nil
		}))

	return defs
}

// taxItem picks the sales tax item of a sales form: the argument ("none" for
// no tax), else the customer's (or its parent's), else the company default.
func (b *call) taxItem(input string, cust *name, p *prefs) (*int64, error) {
	input = strings.TrimSpace(input)
	if strings.EqualFold(input, "none") {
		return nil, nil
	}
	if !p.SalesTaxEnabled {
		if input != "" {
			return nil, userErr("Sales tax is turned off in this company file.")
		}
		return nil, nil
	}
	if input != "" {
		it, err := b.findItem(input, "Sales Tax Item", "Sales Tax Group")
		if err != nil {
			return nil, err
		}
		return &it.ID, nil
	}
	if id := b.inherited(cust, func(n *name) *int64 { return n.TaxItemID }); id != nil {
		return id, nil
	}
	return p.DefaultSalesTaxItemID, nil
}
