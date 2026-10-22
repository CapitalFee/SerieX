package companies

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// acctDef is one account of a default chart of accounts.
type acctDef struct {
	Num, Name, Type, Parent, Special, Desc string
}

type industry struct {
	model.IndustryTemplate
	cogs      bool      // the business sells products or job materials (Cost of Goods Sold section)
	income    []acctDef // 4xxxx
	cogsList  []acctDef // 5xxxx besides Cost of Goods Sold
	fixed     []acctDef // extra fixed assets
	expense   []acctDef // extra 6xxxx expenses
	other     []acctDef // extra other income / other expense
	nonprofit bool
}

func a(num, name, typ string) acctDef { return acctDef{Num: num, Name: name, Type: typ} }

func sub(num, name, typ, parent string) acctDef {
	return acctDef{Num: num, Name: name, Type: typ, Parent: parent}
}

const (
	tBank   = model.AcctBank
	tAR     = model.AcctAR
	tOCA    = model.AcctOCA
	tFA     = model.AcctFixedAsset
	tAP     = model.AcctAP
	tCC     = model.AcctCreditCard
	tOCL    = model.AcctOCL
	tLTL    = model.AcctLTL
	tEquity = model.AcctEquity
	tInc    = model.AcctIncome
	tCOGS   = model.AcctCOGS
	tExp    = model.AcctExpense
	tOInc   = model.AcctOtherIncome
	tOExp   = model.AcctOtherExpense
)

// industries is the list shown by GET /api/companies/templates (in this order).
// Accounts are numbered with four digits: 1xxx assets, 2xxx liabilities,
// 3xxx equity, 4xxx income, 5xxx cost of sales, 6xxx expenses, 7xxx other
// income and expense. An account keeps its number in every template.
var industries = []industry{
	{
		IndustryTemplate: model.IndustryTemplate{Key: "general_product", Label: "Product sales",
			Description: "You sell goods that you buy or make, and ship them to customers. Starts with product sales, shipping charges, cost of goods sold and freight."},
		cogs: true,
		income: []acctDef{
			a("4000", "Merchandise Sales", tInc),
			a("4050", "Shipping and Delivery Income", tInc),
			a("4090", "Sales Discounts", tInc),
		},
		cogsList: []acctDef{a("5100", "Freight and Shipping Costs", tCOGS)},
		expense: []acctDef{
			a("6730", "Merchant Account Fees", tExp),
			a("6720", "Postage and Delivery", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "general_service", Label: "Services",
			Description: "You are paid for work you do for customers. Starts with service income, costs you bill back to customers and everyday running costs."},
		income: []acctDef{
			a("4000", "Service Income", tInc),
			a("4050", "Reimbursement Income", tInc),
		},
		expense: []acctDef{
			a("6700", "Business Licenses and Permits", tExp),
			a("6710", "Dues and Subscriptions", tExp),
			a("6720", "Postage and Delivery", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "construction", Label: "Construction and trades",
			Description: "Builders, remodelers and trades such as electricians or plumbers. Keeps labor, materials and subcontracted work apart, with job costs."},
		cogs: true,
		income: []acctDef{
			a("4000", "Construction Income", tInc),
			sub("4010", "Labor Income", tInc, "Construction Income"),
			sub("4020", "Materials Income", tInc, "Construction Income"),
			sub("4030", "Subcontracted Labor Income", tInc, "Construction Income"),
		},
		cogsList: []acctDef{
			a("5400", "Job Expenses", tCOGS),
			sub("5410", "Equipment Rental", tCOGS, "Job Expenses"),
			sub("5420", "Job Materials", tCOGS, "Job Expenses"),
			sub("5430", "Permits and Licenses", tCOGS, "Job Expenses"),
			sub("5440", "Subcontractors", tCOGS, "Job Expenses"),
		},
		fixed: []acctDef{a("1510", "Vehicles", tFA)},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "retail", Label: "Shop or online store",
			Description: "You sell goods to the public in a store, online or both. Starts with sales, discounts, shipping, card fees and store supplies."},
		cogs: true,
		income: []acctDef{
			a("4000", "Merchandise Sales", tInc),
			a("4050", "Shipping and Delivery Income", tInc),
			a("4090", "Sales Discounts", tInc),
		},
		cogsList: []acctDef{a("5100", "Freight and Shipping Costs", tCOGS)},
		expense: []acctDef{
			a("6730", "Merchant Account Fees", tExp),
			a("6760", "Store Supplies", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "consulting", Label: "Consulting and professional services",
			Description: "Consultants, designers, agencies and other professionals who bill for their time and for costs they pass on."},
		income: []acctDef{
			a("4000", "Consulting Income", tInc),
			a("4050", "Reimbursement Income", tInc),
		},
		expense: []acctDef{
			a("6700", "Business Licenses and Permits", tExp),
			a("6740", "Continuing Education", tExp),
			a("6710", "Dues and Subscriptions", tExp),
			a("6750", "Outside Services", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "restaurant", Label: "Food and drink",
			Description: "Restaurants, cafes, food trucks, caterers and bars. Keeps food and drink sales and purchases apart."},
		cogs: true,
		income: []acctDef{
			a("4000", "Food Sales", tInc),
			a("4010", "Beverage Sales", tInc),
			a("4020", "Catering Income", tInc),
		},
		cogsList: []acctDef{
			a("5010", "Food Purchases", tCOGS),
			a("5020", "Beverage Purchases", tCOGS),
		},
		expense: []acctDef{
			a("6700", "Business Licenses and Permits", tExp),
			a("6730", "Merchant Account Fees", tExp),
			a("6770", "Linen and Laundry", tExp),
			a("6780", "Restaurant Supplies", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "nonprofit", Label: "Nonprofit organization",
			Description: "Charities, associations and other nonprofits. Starts with donations, grants, program income and the two kinds of net assets."},
		nonprofit: true,
		income: []acctDef{
			a("4300", "Direct Public Support", tInc),
			sub("4310", "Corporate Contributions", tInc, "Direct Public Support"),
			sub("4320", "Foundation and Trust Grants", tInc, "Direct Public Support"),
			sub("4330", "Individual Contributions", tInc, "Direct Public Support"),
			a("4400", "Government Grants", tInc),
			a("4500", "Program Income", tInc),
			a("4600", "Membership Dues", tInc),
			a("4700", "Special Events Income", tInc),
		},
		expense: []acctDef{
			a("6790", "Contract Services", tExp),
			a("6800", "Conferences and Meetings", tExp),
			a("6810", "Printing and Copying", tExp),
			a("6720", "Postage and Delivery", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "manufacturing", Label: "Manufacturing",
			Description: "You make the products you sell. Starts with product sales, production costs, machinery and freight."},
		cogs: true,
		income: []acctDef{
			a("4000", "Product Sales", tInc),
			a("4050", "Shipping and Delivery Income", tInc),
			a("4090", "Sales Discounts", tInc),
		},
		cogsList: []acctDef{
			a("5100", "Freight and Shipping Costs", tCOGS),
			a("5150", "Subcontracted Services", tCOGS),
			a("5200", "Production Supplies", tCOGS),
		},
		fixed: []acctDef{a("1520", "Machinery and Equipment", tFA)},
		expense: []acctDef{
			a("6820", "Equipment Rental", tExp),
			a("6830", "Small Tools and Equipment", tExp),
		},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "landscaping", Label: "Landscaping and garden care",
			Description: "Garden design, planting, lawn and garden upkeep. Keeps design, installation and maintenance work apart, with job costs."},
		cogs: true,
		income: []acctDef{
			a("4000", "Landscaping Services", tInc),
			sub("4010", "Design Services", tInc, "Landscaping Services"),
			sub("4020", "Installation Services", tInc, "Landscaping Services"),
			sub("4030", "Maintenance Services", tInc, "Landscaping Services"),
		},
		cogsList: []acctDef{
			a("5400", "Job Expenses", tCOGS),
			sub("5410", "Equipment Rental", tCOGS, "Job Expenses"),
			sub("5420", "Job Materials", tCOGS, "Job Expenses"),
			sub("5430", "Plants and Soil", tCOGS, "Job Expenses"),
			sub("5440", "Subcontractors", tCOGS, "Job Expenses"),
		},
		fixed: []acctDef{a("1510", "Vehicles", tFA)},
	},
	{
		IndustryTemplate: model.IndustryTemplate{Key: "none", Label: "Other (basic accounts only)",
			Description: "Starts with only the accounts SerieX Books needs (Accounts Receivable, Accounts Payable, Undeposited Funds, equity and uncategorized accounts). Add your own accounts later."},
	},
}

// Templates returns the industry templates for GET /api/companies/templates.
func Templates() []model.IndustryTemplate {
	out := make([]model.IndustryTemplate, len(industries))
	for i, ind := range industries {
		out[i] = ind.IndustryTemplate
	}
	return out
}

func findIndustry(key string) (industry, bool) {
	for _, ind := range industries {
		if ind.Key == key {
			return ind, true
		}
	}
	return industry{}, false
}

// isNonprofit: a non-profit template or entity type (501(c)...).
func isNonprofit(entityType string, nonprofit bool) bool {
	e := strings.ToLower(entityType)
	return nonprofit || strings.Contains(e, "profit") || strings.Contains(e, "501")
}

// serviceIndustries start with the services invoice layout (stored as
// "Service Invoice": no ship-to, ship date, shipping method or F.O.B.); the
// others with the standard layout (stored as "Product Invoice").
var serviceIndustries = map[string]bool{
	"general_service": true, "consulting": true, "landscaping": true, "construction": true, "nonprofit": true,
}

// ownerEquity returns the equity accounts used for the owners by entity type.
// Non-profits use the current net asset classes (ASU 2016-14): net assets with
// and without donor restrictions (the latter is the retained earnings account).
func ownerEquity(entityType string, nonprofit bool) []acctDef {
	e := strings.ToLower(entityType)
	switch {
	case isNonprofit(entityType, nonprofit):
		return []acctDef{
			{Num: "3200", Name: "Net Assets With Donor Restrictions", Type: tEquity,
				Desc: "Gifts that donors limited to a purpose or a period, or that must be kept forever"},
		}
	case strings.Contains(e, "s corp") || strings.Contains(e, "s-corp") || strings.Contains(e, "scorp"):
		return []acctDef{
			a("3100", "Capital Stock", tEquity),
			a("3110", "Shareholder Distributions", tEquity),
		}
	case strings.Contains(e, "corp") || strings.Contains(e, "inc"):
		return []acctDef{
			a("3100", "Capital Stock", tEquity),
			a("3110", "Dividends Paid", tEquity),
		}
	case strings.Contains(e, "partner") || strings.Contains(e, "llp") || (strings.Contains(e, "llc") && strings.Contains(e, "multi")):
		return []acctDef{
			a("3100", "Partner Contributions", tEquity),
			a("3110", "Partner Distributions", tEquity),
		}
	}
	// sole proprietorship, single member LLC, other
	return []acctDef{
		a("3100", "Owners Equity", tEquity),
		a("3110", "Owners Draw", tEquity),
	}
}

// specialDefs are the numbers, names and descriptions of the accounts the
// program itself relies on.
var specialDefs = map[string]acctDef{
	store.SpecialAR:                   {Num: "1100", Name: "Accounts Receivable", Type: tAR, Desc: "What customers owe you for invoices and charges not paid yet"},
	store.SpecialUndepositedFunds:     {Num: "1150", Name: "Undeposited Funds", Type: tOCA, Desc: "Payments you received that are not in a bank deposit yet"},
	store.SpecialInventoryAsset:       {Num: "1300", Name: "Inventory Asset", Type: tOCA, Desc: "What the products you have in stock cost you"},
	store.SpecialAP:                   {Num: "2000", Name: "Accounts Payable", Type: tAP, Desc: "Bills you received and have not paid yet"},
	store.SpecialSalesTaxPayable:      {Num: "2200", Name: "Sales Tax Payable", Type: tOCL, Desc: "Sales tax you collected and still have to pay"},
	store.SpecialOpeningBalanceEquity: {Num: "3000", Name: "Opening Balance Equity", Type: tEquity, Desc: "Holds starting balances while you set up the books; move what is left to owner's equity when setup is done"},
	store.SpecialRetainedEarnings:     {Num: "3900", Name: "Retained Earnings", Type: tEquity, Desc: "Profits of earlier years that stay in the business"},
	store.SpecialUncategorizedIncome:  {Num: "4990", Name: "Uncategorized Income", Type: tInc, Desc: "Money in that does not have an income account yet"},
	store.SpecialCOGS:                 {Num: "5000", Name: "Cost of Goods Sold", Type: tCOGS, Desc: "What the products you sold cost you"},
	store.SpecialUncategorizedExpense: {Num: "6980", Name: "Uncategorized Expenses", Type: tExp, Desc: "Money out that does not have an expense account yet"},
	store.SpecialAskMyAccountant:      {Num: "6990", Name: store.SpecialAccountDefaults[store.SpecialAskMyAccountant][0], Type: tExp, Desc: "Transactions you want to go over with your accountant"},
}

func special(key string) acctDef {
	d := specialDefs[key]
	d.Special = key
	return d
}

// chartOfAccounts builds the default chart for an industry. Every special
// account the program needs is included and flagged.
func chartOfAccounts(ind industry, entityType string, salesTax, inventory bool) []acctDef {
	var out []acctDef
	add := func(d ...acctDef) { out = append(out, d...) }
	if ind.Key == "none" {
		add(special(store.SpecialAR), special(store.SpecialUndepositedFunds))
		if inventory {
			add(special(store.SpecialInventoryAsset))
		}
		add(special(store.SpecialAP))
		if salesTax {
			add(special(store.SpecialSalesTaxPayable))
		}
		re := special(store.SpecialRetainedEarnings)
		if isNonprofit(entityType, ind.nonprofit) {
			re.Name = "Net Assets Without Donor Restrictions"
		}
		add(special(store.SpecialOpeningBalanceEquity), re, special(store.SpecialUncategorizedIncome))
		if inventory {
			add(special(store.SpecialCOGS))
		}
		add(special(store.SpecialUncategorizedExpense), special(store.SpecialAskMyAccountant))
		return out
	}

	// Assets
	add(acctDef{Num: "1000", Name: "Checking", Type: tBank, Desc: "Main business bank account"},
		acctDef{Num: "1010", Name: "Savings", Type: tBank, Desc: "Business savings account"},
		acctDef{Num: "1050", Name: "Petty Cash", Type: tBank, Desc: "Cash kept at the business for small purchases"},
		special(store.SpecialAR), special(store.SpecialUndepositedFunds))
	if inventory {
		add(special(store.SpecialInventoryAsset))
	}
	add(acctDef{Num: "1500", Name: "Furniture and Equipment", Type: tFA, Desc: "Furniture and equipment you will use for more than a year"})
	add(ind.fixed...)
	add(acctDef{Num: "1590", Name: "Accumulated Depreciation", Type: tFA, Desc: "Depreciation recorded so far on your equipment, vehicles and buildings"})

	// Liabilities
	add(special(store.SpecialAP),
		acctDef{Num: "2100", Name: "Credit Card", Type: tCC, Desc: "Business credit card"})
	if salesTax {
		add(special(store.SpecialSalesTaxPayable))
	}
	add(acctDef{Num: "2600", Name: "Loan Payable", Type: tLTL, Desc: "Loans you repay over more than a year"})

	// Equity
	add(special(store.SpecialOpeningBalanceEquity))
	add(ownerEquity(entityType, ind.nonprofit)...)
	re := special(store.SpecialRetainedEarnings)
	if isNonprofit(entityType, ind.nonprofit) {
		re.Name = "Net Assets Without Donor Restrictions"
		re.Desc = "Net assets donors did not limit; each year's change in net assets ends up here"
	}
	add(re)

	// Income
	add(ind.income...)
	add(special(store.SpecialUncategorizedIncome))

	// Cost of goods sold
	if ind.cogs || inventory || len(ind.cogsList) > 0 {
		add(special(store.SpecialCOGS))
	}
	add(ind.cogsList...)

	// Expenses
	add(acctDef{Num: "6000", Name: "Advertising and Promotion", Type: tExp, Desc: "Ads, marketing, website and other promotion"},
		acctDef{Num: "6020", Name: "Automobile Expense", Type: tExp, Desc: "Fuel, repairs and upkeep of the vehicles you use for the business"},
		acctDef{Num: "6040", Name: "Bank Service Charges", Type: tExp, Desc: "Fees your bank charges"},
		acctDef{Num: "6100", Name: "Computer and Internet Expenses", Type: tExp, Desc: "Software, online services, internet access and computer supplies"},
		acctDef{Num: "6150", Name: "Depreciation Expense", Type: tExp, Desc: "The part of the cost of equipment, vehicles and buildings used up in the period"},
		acctDef{Num: "6200", Name: "Insurance Expense", Type: tExp, Desc: "Business insurance"},
		acctDef{Num: "6210", Name: "Liability Insurance", Type: tExp, Parent: "Insurance Expense", Desc: "Insurance against claims from customers and others"},
		acctDef{Num: "6250", Name: "Interest Expense", Type: tExp, Desc: "Interest you pay on loans and credit cards"},
		acctDef{Num: "6300", Name: "Meals and Entertainment", Type: tExp, Desc: "Meals with customers, staff or partners for the business"},
		acctDef{Num: "6350", Name: "Office Supplies", Type: tExp, Desc: "Paper, ink, stationery and other office supplies"},
		acctDef{Num: "6400", Name: "Professional Fees", Type: tExp, Desc: "Accountants, lawyers and other advisers"},
		acctDef{Num: "6450", Name: "Rent Expense", Type: tExp, Desc: "Rent for offices, shops, workshops or storage"},
		acctDef{Num: "6500", Name: "Repairs and Maintenance", Type: tExp, Desc: "Repairs and upkeep of equipment and premises"},
		acctDef{Num: "6550", Name: "Telephone Expense", Type: tExp, Desc: "Phone and mobile plans"},
		acctDef{Num: "6600", Name: "Travel Expense", Type: tExp, Desc: "Business trips: tickets, car hire, lodging and other travel costs"},
		acctDef{Num: "6650", Name: "Utilities", Type: tExp, Desc: "Electricity, water, heating and trash collection"})
	add(ind.expense...)
	add(special(store.SpecialUncategorizedExpense), special(store.SpecialAskMyAccountant))

	// Other income / expense
	add(acctDef{Num: "7000", Name: "Interest Income", Type: tOInc, Desc: "Interest paid to you by your bank or on investments"})
	add(ind.other...)
	return out
}

// insertChart stores the accounts of a chart (parents before children) and
// makes sure every required special account exists and is flagged.
func insertChart(ctx context.Context, tx *sql.Tx, chart []acctDef, salesTax, inventory bool) error {
	now := store.Now()
	ids := map[string]int64{}
	for _, d := range chart {
		var parent any
		if d.Parent != "" {
			if p, ok := ids[d.Parent]; ok {
				parent = p
			}
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO accounts(name, number, type, parent_id, description, special, active, created_at, updated_at)
			VALUES(?,?,?,?,?,?,1,?,?)`, d.Name, d.Num, d.Type, parent, d.Desc, d.Special, now, now)
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		if d.Parent == "" {
			ids[d.Name] = id
		}
	}
	required := []string{store.SpecialAR, store.SpecialAP, store.SpecialUndepositedFunds, store.SpecialOpeningBalanceEquity,
		store.SpecialRetainedEarnings, store.SpecialUncategorizedIncome, store.SpecialUncategorizedExpense, store.SpecialAskMyAccountant}
	if inventory {
		required = append(required, store.SpecialInventoryAsset, store.SpecialCOGS)
	}
	if salesTax {
		required = append(required, store.SpecialSalesTaxPayable)
	}
	for _, s := range required {
		if _, err := store.SpecialAccount(ctx, tx, s); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Default simple lists

type listDef struct {
	list, name string
	data       map[string]any
}

func terms(name string, net, discPct, discDays int) listDef {
	return listDef{model.ListTerms, name, map[string]any{"dateDriven": false, "netDays": net, "discountPct": discPct, "discountDays": discDays}}
}

func pm(name, typ string) listDef {
	return listDef{model.ListPaymentMethod, name, map[string]any{"type": typ}}
}

func simple(list string, names ...string) []listDef {
	out := make([]listDef, len(names))
	for i, n := range names {
		out[i] = listDef{list, n, map[string]any{}}
	}
	return out
}

func defaultLists() []listDef {
	out := []listDef{
		terms("1% 10 Net 30", 30, 1, 10),
		terms("2% 10 Net 30", 30, 2, 10),
		terms("Due on receipt", 0, 0, 0),
		terms("Net 15", 15, 0, 0),
		terms("Net 30", 30, 0, 0),
		terms("Net 60", 60, 0, 0),
		pm("American Express", "American Express"),
		pm("Cash", "Cash"),
		pm("Check", "Check"),
		pm("Debit Card", "Debit Card"),
		pm("Discover", "Discover"),
		pm("E-Check", "E-Check"),
		pm("Gift Card", "Gift Card"),
		pm("MasterCard", "MasterCard"),
		pm("Visa", "Visa"),
	}
	out = append(out, simple(model.ListCustomerMessage, "Thank you for your business.", "Please pay by the due date shown above.",
		"Questions about this invoice? Contact us at the phone number or email above.", "We appreciate your prompt payment.")...)
	out = append(out, simple(model.ListShipVia, "Courier", "FedEx", "Local delivery", "UPS", "USPS")...)
	out = append(out, simple(model.ListCustomerType, "Online", "Referral", "Repeat customer", "Walk-in")...)
	out = append(out, simple(model.ListVendorType, "Contractors", "Materials", "Services", "Supplies", "Tax agencies")...)
	return out
}

func insertLists(ctx context.Context, tx *sql.Tx) error {
	now := store.Now()
	for _, l := range defaultLists() {
		data, _ := json.Marshal(l.data)
		if _, err := tx.ExecContext(ctx, `INSERT INTO list_entries(list, name, active, data, created_at, updated_at) VALUES(?,?,1,?,?,?)`,
			l.list, l.name, string(data), now, store.Stamp()); err != nil {
			return err
		}
	}
	return nil
}
