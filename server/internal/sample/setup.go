package sample

// Company, preferences and lists of the sample company.

import (
	"fmt"
	"strings"

	"seriex/internal/companies"
	"seriex/internal/lists"
	"seriex/internal/model"
	"seriex/internal/store"
)

func (g *gen) setupCompany() error {
	req := model.NewCompanyRequest{
		Name: CompanyName, LegalName: "Harborview Landscaping & Supply LLC", Industry: "landscaping",
		EntityType: "LLC (single member)", TaxID: "00-0000000",
		Address1: "1450 Harbor Way", City: "Harborview", State: "CA", Zip: "94950", Country: "US",
		Phone: "(555) 010-4400", Email: "office@harborview-landscaping.example.com",
		Website: "www.harborview-landscaping.example.com", FiscalYearStartMonth: 1,
		CreateDefaultAccounts: true, SalesTaxEnabled: true, InventoryEnabled: true,
	}
	if err := companies.InitCompany(g.ctx, g.tx, req); err != nil {
		return err
	}
	p, err := store.LoadPrefs(g.ctx, g.tx)
	if err != nil {
		return err
	}
	p.UseClassTracking = true
	p.SalesTaxEnabled = true
	p.SalesTaxFrequency = "quarterly"
	p.InventoryEnabled = true
	p.PurchaseOrdersEnabled = true
	p.EstimatesEnabled = true
	p.ShowRemindersOnOpen = false
	p.DefaultInvoiceTemplate = "Service Invoice"
	return store.SavePrefs(g.ctx, g.tx, p)
}

// loadIDs refreshes the name -> id maps of accounts, items, names and lists.
func (g *gen) loadIDs() error {
	for _, t := range []struct {
		table string
		m     map[string]int64
	}{{"accounts", g.acct}, {"items", g.item}, {"names", g.name}} {
		full, err := store.FullNames(g.ctx, g.tx, t.table)
		if err != nil {
			return err
		}
		for id, n := range full {
			t.m[n] = id
		}
	}
	rows, err := g.tx.QueryContext(g.ctx, `SELECT id, list, name FROM list_entries`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var l, n string
		if err := rows.Scan(&id, &l, &n); err != nil {
			return err
		}
		g.list[l+":"+n] = id
	}
	return rows.Err()
}

func (g *gen) addList(list, name string, data map[string]any) error {
	if data == nil {
		data = map[string]any{}
	}
	e := model.ListEntry{List: list, Name: name, Active: true, Data: data}
	id, err := lists.SaveListEntry(g.ctx, g.tx, &e)
	if err != nil {
		return err
	}
	g.list[list+":"+name] = id
	return nil
}

func (g *gen) setupLists() error {
	if err := g.loadIDs(); err != nil {
		return err
	}
	for _, c := range []string{"Residential", "Commercial"} {
		if err := g.addList(model.ListClass, c, nil); err != nil {
			return err
		}
	}
	for _, r := range [][2]string{{"Maria Lopez", "ML"}, {"Tom Becker", "TB"}} {
		if err := g.addList(model.ListSalesRep, r[0], map[string]any{"initials": r[1]}); err != nil {
			return err
		}
	}
	for _, j := range []string{"Design/Build", "Installation", "Maintenance Contract", "Irrigation"} {
		if err := g.addList(model.ListJobType, j, nil); err != nil {
			return err
		}
	}
	for _, c := range []string{"Residential", "Commercial", "Government / Non-profit"} {
		if err := g.addList(model.ListCustomerType, c, nil); err != nil {
			return err
		}
	}
	if err := g.addList(model.ListVendorType, "Subcontractors", nil); err != nil {
		return err
	}
	return g.addList(model.ListVendorType, "Utilities", nil)
}

// ---------------------------------------------------------------------------
// Chart of accounts

func (g *gen) newAccount(a model.Account) error {
	a.Active = true
	id, err := lists.SaveAccount(g.ctx, g.tx, &a, g.opt)
	if err != nil {
		return err
	}
	full := a.Name
	if a.ParentID != nil {
		full = store.FullName(g.ctx, g.tx, "accounts", id)
	}
	g.acct[full] = id
	return nil
}

func (g *gen) setupAccounts() error {
	// the template's generic credit card account gets the card's name
	cc, err := lists.GetAccount(g.ctx, g.tx, g.a("Credit Card"))
	if err != nil {
		return err
	}
	cc.Name = "Harbor National Visa"
	cc.Description = "Business Visa card, Harbor National Bank"
	if _, err := lists.SaveAccount(g.ctx, g.tx, cc, g.opt); err != nil {
		return err
	}
	g.acct["Harbor National Visa"] = cc.ID
	chk, err := lists.GetAccount(g.ctx, g.tx, g.a("Checking"))
	if err != nil {
		return err
	}
	chk.BankAcctNumber, chk.RoutingNumber, chk.Description = "000123456789", "000000000", "Harbor National Bank business checking"
	if _, err := lists.SaveAccount(g.ctx, g.tx, chk, g.opt); err != nil {
		return err
	}

	sub := func(parent string) *int64 { id := g.a(parent); return &id }
	opening := func(v float64) *float64 { return &v }
	defs := []model.Account{
		{Number: "4040", Name: "Materials Sales", Type: model.AcctIncome, ParentID: sub("Landscaping Services"), Description: "Plants, hardscape and irrigation materials sold"},
		{Number: "4060", Name: "Delivery Income", Type: model.AcctIncome, Description: "Delivery charges billed to customers"},
		{Number: "4090", Name: "Sales Discounts", Type: model.AcctIncome, Description: "Discounts given to customers"},
		{Number: "5050", Name: "Purchase Discounts", Type: model.AcctCOGS, Description: "Early payment discounts taken on vendor bills"},
		{Number: "5090", Name: "Inventory Adjustments", Type: model.AcctCOGS, Description: "Shrinkage and damaged inventory"},
		{Number: "6021", Name: "Fuel", Type: model.AcctExpense, ParentID: sub("Automobile Expense"), Description: "Fuel for trucks and equipment"},
		{Number: "6022", Name: "Vehicle Repairs", Type: model.AcctExpense, ParentID: sub("Automobile Expense"), Description: "Truck repairs and maintenance"},
		{Number: "6220", Name: "Vehicle Insurance", Type: model.AcctExpense, ParentID: sub("Insurance Expense"), Description: "Commercial auto insurance"},
		{Number: "6830", Name: "Small Tools and Equipment", Type: model.AcctExpense, Description: "Hand tools and small equipment"},
		{Number: "1520", Name: "Landscaping Equipment", Type: model.AcctFixedAsset, Description: "Mowers, trailers and other equipment",
			OpeningBalance: opening(24500), OpeningDate: g.open},
		{Number: "2610", Name: "Truck Loan", Type: model.AcctLTL, Description: "First Harbor Bank truck loan, 6.5%",
			OpeningBalance: opening(42000), OpeningDate: g.open},
	}
	for _, d := range defs {
		if err := g.newAccount(d); err != nil {
			return err
		}
	}
	g.loanBal = cents(42000)
	return g.loadIDs()
}

// ---------------------------------------------------------------------------
// Vendors and other names

func addr(line1, street, city string) model.Address {
	if city == "" {
		city = "Harborview"
	}
	return model.Address{Line1: line1, Line2: street, City: city, State: "CA", Zip: "94950"}
}

func addrText(a model.Address) string {
	lines := []string{}
	for _, s := range []string{a.Line1, a.Line2, a.Line3} {
		if s != "" {
			lines = append(lines, s)
		}
	}
	lines = append(lines, a.City+", "+a.State+" "+a.Zip)
	return strings.Join(lines, "\n")
}

func (g *gen) setupVendors() error {
	type vdef struct {
		name, company, street, phone, terms, vtype string
		discount, card, is1099                     bool
		prefill                                    []string
		opening                                    float64
	}
	defs := []vdef{
		{name: "Coastal Nursery Wholesale", street: "880 Greenhouse Rd", phone: "(555) 010-2201", terms: "2% 10 Net 30", vtype: "Materials", discount: true},
		{name: "Bayside Stone & Pavers", street: "42 Quarry Ln", phone: "(555) 010-2202", terms: "Net 30", vtype: "Materials", opening: 1860},
		{name: "GreenGrow Mulch & Soil", street: "7 Compost Way", phone: "(555) 010-2203", terms: "Net 15", vtype: "Materials", card: true},
		{name: "AquaFlow Irrigation Supply", street: "2210 Valve St", phone: "(555) 010-2204", terms: "Net 30", vtype: "Materials"},
		{name: "Harbor Fuel Co.", street: "1 Dockside Ave", phone: "(555) 010-2205", terms: "Due on receipt", vtype: "Supplies", prefill: []string{"Automobile Expense:Fuel"}},
		{name: "Bayview Power & Light", street: "PO Box 4100", phone: "(555) 010-2206", terms: "Net 15", vtype: "Utilities", prefill: []string{"Utilities"}},
		{name: "Harborview Water Department", street: "300 Civic Center Dr", phone: "(555) 010-2207", terms: "Net 15", vtype: "Utilities", prefill: []string{"Utilities"}},
		{name: "Seaside Telecom", street: "PO Box 9800", phone: "(555) 010-2208", terms: "Due on receipt", vtype: "Utilities", prefill: []string{"Telephone Expense"}},
		{name: "Marina Properties LLC", street: "55 Wharf St, Suite 200", phone: "(555) 010-2209", terms: "Due on receipt", vtype: "Services", prefill: []string{"Rent Expense"}},
		{name: "Anchor Mutual Insurance", street: "900 Seawall Blvd", phone: "(555) 010-2210", terms: "Net 15", vtype: "Services"},
		{name: "Ortega Hardscape Crew", street: "16 Mason Ct", phone: "(555) 010-2211", terms: "Net 15", vtype: "Subcontractors", is1099: true, opening: 2400},
		{name: "Coastline Labor Services", street: "58 Harbor Blvd", phone: "(555) 010-2220", terms: "Net 15", vtype: "Subcontractors", is1099: true,
			prefill: []string{"Job Expenses:Subcontractors"}},
		{name: "Treeline Arborists", street: "310 Canopy Rd", phone: "(555) 010-2212", terms: "Net 15", vtype: "Subcontractors", is1099: true},
		{name: "Harbor National Bank Card Services", street: "PO Box 7700", phone: "(555) 010-2213", terms: "Due on receipt", vtype: "Services"},
		{name: "State Department of Revenue", street: "PO Box 1000", phone: "(555) 010-2214", terms: "Due on receipt", vtype: "Tax agencies"},
		{name: "First Harbor Bank", street: "120 Main St", phone: "(555) 010-2215", terms: "Due on receipt", vtype: "Services"},
		{name: "Westshore Equipment Rental", street: "77 Industrial Pkwy", phone: "(555) 010-2216", terms: "Net 30", vtype: "Services"},
		{name: "Harbor Office Supply", street: "415 Market St", phone: "(555) 010-2217", terms: "Net 30", vtype: "Supplies", prefill: []string{"Office Supplies"}},
		{name: "Precision Truck Repair", street: "88 Garage Row", phone: "(555) 010-2218", terms: "Net 15", vtype: "Services", prefill: []string{"Automobile Expense:Vehicle Repairs"}},
		{name: "Harbor Hardware", street: "212 Main St", phone: "(555) 010-2219", terms: "Due on receipt", vtype: "Supplies", prefill: []string{"Small Tools and Equipment"}},
	}
	g.vendBy = map[string]*vend{}
	for _, d := range defs {
		n := model.Name{Kind: model.NameVendor, Name: d.name, CompanyName: d.name, Phone: d.phone, Active: true,
			Email:       "billing@" + slug(d.name) + ".example.com",
			BillAddress: addr(d.name, d.street, ""), TermsID: p64(g.l(model.ListTerms, d.terms)),
			TypeID: p64(g.l(model.ListVendorType, d.vtype)), Is1099: d.is1099, PrintOnCheckAs: d.name,
			AccountNumber: "HV-" + d.phone[len(d.phone)-4:]}
		if d.is1099 {
			n.TaxIdent = "00-000" + d.phone[len(d.phone)-4:]
		}
		for _, a := range d.prefill {
			n.PrefillAccountIDs = append(n.PrefillAccountIDs, g.a(a))
		}
		if d.opening != 0 {
			n.OpeningBalance, n.OpeningDate = &d.opening, g.open
		}
		id, err := lists.SaveName(g.ctx, g.tx, &n, g.opt)
		if err != nil {
			return err
		}
		v := &vend{id: id, name: d.name, terms: d.terms, discount: d.discount, card: d.card, addr: addrText(n.BillAddress)}
		g.vendors = append(g.vendors, v)
		g.vendBy[d.name] = v
		g.name[d.name] = id
	}
	owner := model.Name{Kind: model.NameOther, Name: "Dana Whitfield", FirstName: "Dana", LastName: "Whitfield",
		JobTitle: "Owner", Phone: "(555) 010-4401", Email: "dana@harborview-landscaping.example.com",
		BillAddress: addr("Dana Whitfield", "19 Lookout Ln", ""), Active: true}
	id, err := lists.SaveName(g.ctx, g.tx, &owner, g.opt)
	if err != nil {
		return err
	}
	g.owner = id
	return nil
}

func slug(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// Items

func (g *gen) newItem(it model.Item) (int64, error) {
	it.Active = true
	id, err := lists.SaveItem(g.ctx, g.tx, &it, g.opt)
	if err != nil {
		return 0, err
	}
	g.item[store.FullName(g.ctx, g.tx, "items", id)] = id
	return id, nil
}

func (g *gen) setupItems() error {
	agency := g.vendBy["State Department of Revenue"].id
	county, err := g.newItem(model.Item{Type: model.ItemSalesTax, Name: "Harbor County", Description: "Harbor County sales tax", TaxRate: 6.25, TaxAgencyID: &agency})
	if err != nil {
		return err
	}
	city, err := g.newItem(model.Item{Type: model.ItemSalesTax, Name: "Harborview City", Description: "Harborview city district tax", TaxRate: 1.5, TaxAgencyID: &agency})
	if err != nil {
		return err
	}
	group, err := g.newItem(model.Item{Type: model.ItemSalesTaxGroup, Name: "Harborview Combined", Description: "County and city sales tax",
		GroupLines: []model.ItemGroupLine{{ItemID: county, Qty: 1}, {ItemID: city, Qty: 1}}})
	if err != nil {
		return err
	}

	inc := func(n string) *int64 { id := g.a(n); return &id }
	design, install, maint, materials := inc("Landscaping Services:Design Services"), inc("Landscaping Services:Installation Services"),
		inc("Landscaping Services:Maintenance Services"), inc("Landscaping Services:Materials Sales")
	services := []model.Item{
		{Type: model.ItemService, Name: "Design", Description: "Landscape design consultation (per hour)", SalesPrice: 85, IncomeAccountID: design},
		{Type: model.ItemService, Name: "Installation", Description: "Landscape installation (per hour)", SalesPrice: 65, IncomeAccountID: install},
		{Type: model.ItemService, Name: "Labor", Description: "General labor (per hour)", SalesPrice: 45, IncomeAccountID: install},
		{Type: model.ItemService, Name: "Maintenance", Description: "Grounds maintenance (per hour)", SalesPrice: 55, IncomeAccountID: maint},
		{Type: model.ItemService, Name: "Maintenance Contract", Description: "Monthly grounds maintenance contract", SalesPrice: 0, IncomeAccountID: maint},
		{Type: model.ItemService, Name: "Hardscape Subcontract", Description: "Hardscape installation (subcontracted)", PurchaseDescription: "Hardscape crew",
			IsPurchased: true, SalesPrice: 0, IncomeAccountID: install, ExpenseAccountID: inc("Job Expenses:Subcontractors"),
			PreferredVendorID: p64(g.vendBy["Ortega Hardscape Crew"].id)},
		{Type: model.ItemService, Name: "Tree Trimming", Description: "Tree trimming and removal", PurchaseDescription: "Arborist services",
			IsPurchased: true, SalesPrice: 350, Cost: 240, IncomeAccountID: maint, ExpenseAccountID: inc("Job Expenses:Subcontractors"),
			PreferredVendorID: p64(g.vendBy["Treeline Arborists"].id)},
	}
	for _, s := range services {
		if _, err := g.newItem(s); err != nil {
			return err
		}
	}

	type part struct {
		parent, name, desc, vendor, unit string
		cost, price, rp, max             float64
	}
	parts := []part{
		{"Plants", "Boxwood 5 gal", "Boxwood shrub, 5 gallon", "Coastal Nursery Wholesale", "ea", 18, 34.95, 20, 60},
		{"Plants", "Japanese Maple 15 gal", "Japanese maple tree, 15 gallon", "Coastal Nursery Wholesale", "ea", 85, 169, 3, 10},
		{"Plants", "Lavender 1 gal", "Lavender, 1 gallon", "Coastal Nursery Wholesale", "ea", 4.5, 9.95, 30, 120},
		{"Plants", "Rose Bush 5 gal", "Rose bush, 5 gallon", "Coastal Nursery Wholesale", "ea", 14, 29.95, 10, 40},
		{"Plants", "Annual Flats", "Seasonal annuals, flat of 18", "Coastal Nursery Wholesale", "flat", 12, 24.95, 15, 50},
		{"Pavers", "Concrete Paver 12x12", "Concrete paver 12in x 12in", "Bayside Stone & Pavers", "ea", 2.1, 4.25, 200, 800},
		{"Pavers", "Flagstone", "Flagstone (per sq ft)", "Bayside Stone & Pavers", "sq ft", 3.5, 7.5, 150, 600},
		{"Mulch & Soil", "Bark Mulch", "Bark mulch (cubic yard)", "GreenGrow Mulch & Soil", "cu yd", 22, 45, 15, 60},
		{"Mulch & Soil", "Topsoil", "Screened topsoil (cubic yard)", "GreenGrow Mulch & Soil", "cu yd", 18, 38, 10, 40},
		{"Mulch & Soil", "Decorative Rock", "Decorative river rock (ton)", "GreenGrow Mulch & Soil", "ton", 55, 110, 4, 15},
		{"Sprinkler Parts", "Sprinkler Head", "Pop-up sprinkler head", "AquaFlow Irrigation Supply", "ea", 3.25, 7.95, 40, 150},
		{"Sprinkler Parts", "Drip Line 100 ft", "Drip irrigation line, 100 ft", "AquaFlow Irrigation Supply", "roll", 19, 39.95, 10, 40},
		{"Sprinkler Parts", "Irrigation Timer", "6-zone irrigation timer", "AquaFlow Irrigation Supply", "ea", 48, 99, 4, 12},
		{"Sprinkler Parts", "PVC Pipe 1 in", "PVC pipe 1 inch x 10 ft", "AquaFlow Irrigation Supply", "ea", 4.1, 8.95, 30, 100},
	}
	cogs := g.a("Cost of Goods Sold")
	asset := g.a("Inventory Asset")
	parents := map[string]int64{}
	for _, p := range parts {
		if _, ok := parents[p.parent]; !ok {
			id, err := g.newItem(model.Item{Type: model.ItemInventoryPart, Name: p.parent, Description: p.parent, IncomeAccountID: materials,
				ExpenseAccountID: &cogs, AssetAccountID: &asset, Taxable: true})
			if err != nil {
				return err
			}
			parents[p.parent] = id
		}
		parent := parents[p.parent]
		vid := g.vendBy[p.vendor].id
		openQty := float64(int(p.max*0.7 + 0.5))
		it := model.Item{Type: model.ItemInventoryPart, Name: p.name, ParentID: &parent, Description: p.desc, PurchaseDescription: p.desc,
			SalesPrice: p.price, Cost: p.cost, IncomeAccountID: materials, ExpenseAccountID: &cogs, AssetAccountID: &asset,
			PreferredVendorID: &vid, Taxable: true, ReorderPoint: pf(p.rp), MaxQty: pf(p.max), MPN: strings.ToUpper(slug(p.name))[:min(8, len(slug(p.name)))],
			OpeningQty: &openQty, OpeningDate: g.open}
		id, err := g.newItem(it)
		if err != nil {
			return err
		}
		g.invs = append(g.invs, &invItem{id: id, name: p.parent + ":" + p.name, cost: p.cost, price: p.price, reorder: p.rp, max: p.max, vendor: p.vendor, unit: p.unit})
	}

	jobMat := inc("Job Expenses:Job Materials")
	others := []model.Item{
		{Type: model.ItemNonInventory, Name: "Landscape Fabric", Description: "Weed barrier fabric, 3 ft x 100 ft roll", PurchaseDescription: "Landscape fabric roll",
			IsPurchased: true, SalesPrice: 69, Cost: 35, IncomeAccountID: materials, ExpenseAccountID: jobMat, Taxable: true,
			PreferredVendorID: p64(g.vendBy["Harbor Hardware"].id)},
		{Type: model.ItemNonInventory, Name: "Fertilizer", Description: "Slow-release fertilizer, 40 lb bag", PurchaseDescription: "Fertilizer bag",
			IsPurchased: true, SalesPrice: 29, Cost: 15, IncomeAccountID: materials, ExpenseAccountID: jobMat, Taxable: true,
			PreferredVendorID: p64(g.vendBy["GreenGrow Mulch & Soil"].id)},
		{Type: model.ItemOtherCharge, Name: "Delivery", Description: "Delivery charge", SalesPrice: 75, IncomeAccountID: inc("Delivery Income")},
		{Type: model.ItemSubtotal, Name: "Subtotal", Description: "Subtotal"},
		{Type: model.ItemDiscount, Name: "10% Discount", Description: "10% loyalty discount", SalesPrice: 10, RateIsPercent: true, IncomeAccountID: inc("Sales Discounts")},
	}
	for _, o := range others {
		if _, err := g.newItem(o); err != nil {
			return err
		}
	}
	if _, err := g.newItem(model.Item{Type: model.ItemGroup, Name: "Spring Planting Package", Description: "Lavender border with mulch, installed",
		GroupLines: []model.ItemGroupLine{{ItemID: g.it("Plants:Lavender 1 gal"), Qty: 6}, {ItemID: g.it("Mulch & Soil:Bark Mulch"), Qty: 1},
			{ItemID: g.it("Labor"), Qty: 3}}}); err != nil {
		return err
	}

	// preferences that point at the new items and accounts
	p, err := store.LoadPrefs(g.ctx, g.tx)
	if err != nil {
		return err
	}
	p.DefaultSalesTaxItemID = &group
	p.CustomerDiscountAccountID = inc("Sales Discounts")
	p.VendorDiscountAccountID = inc("Purchase Discounts")
	p.DefaultCheckAccountID = inc("Checking")
	p.DefaultBillPayAccountID = inc("Checking")
	return store.SavePrefs(g.ctx, g.tx, p)
}

// ---------------------------------------------------------------------------
// Customers and jobs

func (g *gen) setupCustomers() error {
	type jdef struct {
		name, typ, status, desc string
	}
	type cdef struct {
		name, first, last, company, street, phone, terms, ctype string
		commercial, nonTaxable, outCounty                       bool
		weight, lag                                             int
		method                                                  string
		creditLimit, opening                                    float64
		jobs                                                    []jdef
	}
	res := func(name, first, last, street, phone string, weight int, jobs ...jdef) cdef {
		return cdef{name: name, first: first, last: last, street: street, phone: phone, terms: "Due on receipt", ctype: "Residential",
			weight: weight, method: "Check", jobs: jobs}
	}
	defs := []cdef{
		res("Abbott, Rachel", "Rachel", "Abbott", "12 Bluff Rd", "(555) 010-3101", 3, jdef{"Backyard Patio", "Design/Build", "Closed", "Flagstone patio with planting beds"}, jdef{"Spring Cleanup", "Maintenance Contract", "In progress", "Seasonal cleanup"}),
		res("Bennett, Carl & Diane", "Carl", "Bennett", "48 Seagull Ln", "(555) 010-3102", 2),
		res("Chen, Lily", "Lily", "Chen", "301 Hillcrest Ave", "(555) 010-3103", 2, jdef{"Front Yard Redesign", "Design/Build", "In progress", "Drought tolerant front yard"}),
		res("Delgado, Marco", "Marco", "Delgado", "77 Tidewater Dr", "(555) 010-3104", 2),
		res("Erikson, Paul", "Paul", "Erikson", "9 Pine Cove", "(555) 010-3105", 3, jdef{"Irrigation Upgrade", "Irrigation", "Closed", "Drip conversion"}, jdef{"Weekly Maintenance", "Maintenance Contract", "In progress", "Weekly mowing and care"}),
		res("Foster, Hannah", "Hannah", "Foster", "560 Ocean View Ter", "(555) 010-3106", 1),
		res("Garcia, Elena", "Elena", "Garcia", "23 Marina Ct", "(555) 010-3107", 2),
		res("Hughes, Martin", "Martin", "Hughes", "1402 Ridge Rd", "(555) 010-3108", 2, jdef{"Retaining Wall", "Installation", "In progress", "Stone retaining wall and steps"}),
		res("Ibarra, Sofia", "Sofia", "Ibarra", "88 Lantern Way", "(555) 010-3109", 1),
		res("Jensen, Kurt", "Kurt", "Jensen", "15 Anchor St", "(555) 010-3110", 1),
		res("Kowalski, Anna", "Anna", "Kowalski", "640 Driftwood Dr", "(555) 010-3111", 2),
		res("Lambert, Grace", "Grace", "Lambert", "2 Captains Row", "(555) 010-3112", 3, jdef{"Garden Design", "Design/Build", "Closed", "Cottage garden design"}, jdef{"Patio Install", "Installation", "In progress", "Paver patio"}, jdef{"Landscape Lighting", "Installation", "Pending", "Path and accent lighting"}),
		res("Morales, Victor", "Victor", "Morales", "31 Shell Beach Rd", "(555) 010-3113", 1),
		res("Nakamura, Ken", "Ken", "Nakamura", "907 Crestline Dr", "(555) 010-3114", 2),
		res("O'Brien, Shannon", "Shannon", "O'Brien", "44 Harbor Heights", "(555) 010-3115", 1),
		res("Patel, Ravi", "Ravi", "Patel", "18 Kelp Ct", "(555) 010-3116", 2),
		res("Quinn, Megan", "Megan", "Quinn", "703 Sandpiper Ln", "(555) 010-3117", 1),
		{name: "Bayfront Medical Plaza", company: "Bayfront Medical Plaza", first: "Janet", last: "Ruiz", street: "2000 Bayfront Blvd", phone: "(555) 010-3201",
			terms: "Net 30", ctype: "Commercial", commercial: true, weight: 3, lag: 12, method: "Check", creditLimit: 15000, opening: 3250,
			jobs: []jdef{{"Grounds Maintenance", "Maintenance Contract", "In progress", "Weekly grounds care"}, {"Entrance Renovation", "Design/Build", "Closed", "New entrance planters"}}},
		{name: "Harborview Unified School District", company: "Harborview Unified School District", first: "Alan", last: "Park", street: "500 Education Way", phone: "(555) 010-3202",
			terms: "Net 30", ctype: "Government / Non-profit", commercial: true, nonTaxable: true, weight: 2, lag: 25, method: "Check",
			jobs: []jdef{{"Lincoln Elementary", "Maintenance Contract", "In progress", "School grounds"}, {"Harbor High Athletic Fields", "Installation", "Closed", "Field irrigation repair"}}},
		{name: "Seabreeze Apartments", company: "Seabreeze Apartments", first: "Owen", last: "Hart", street: "1200 Breakwater Rd", phone: "(555) 010-3203",
			terms: "Net 15", ctype: "Commercial", commercial: true, weight: 2, lag: 5, method: "E-Check",
			jobs: []jdef{{"Monthly Maintenance", "Maintenance Contract", "In progress", "Monthly contract"}, {"Courtyard Remodel", "Design/Build", "Closed", "Courtyard plantings"}}},
		{name: "Marina Bay Hotel", company: "Marina Bay Hotel", first: "Priya", last: "Shah", street: "1 Marina Plaza", phone: "(555) 010-3204",
			terms: "Net 30", ctype: "Commercial", commercial: true, weight: 2, lag: 8, method: "Check", jobs: []jdef{{"Pool Area Planters", "Installation", "Closed", "Planter boxes"}}},
		{name: "First Community Church", company: "First Community Church", first: "Ruth", last: "Ellis", street: "400 Chapel St", phone: "(555) 010-3205",
			terms: "Net 30", ctype: "Government / Non-profit", commercial: true, nonTaxable: true, weight: 1, lag: 5, method: "Check"},
		{name: "Oakridge HOA", company: "Oakridge Homeowners Association", first: "Gary", last: "Novak", street: "100 Oakridge Dr", phone: "(555) 010-3206",
			terms: "Net 30", ctype: "Commercial", commercial: true, weight: 2, lag: 10, method: "Check", opening: 1200,
			jobs: []jdef{{"Common Areas", "Maintenance Contract", "In progress", "Common area maintenance"}, {"Entrance Sign Garden", "Design/Build", "Closed", "Entrance garden"}}},
		{name: "Coastal Credit Union", company: "Coastal Credit Union", first: "Mia", last: "Torres", street: "250 Commerce St", phone: "(555) 010-3207",
			terms: "2% 10 Net 30", ctype: "Commercial", commercial: true, weight: 2, method: "E-Check"},
		{name: "Pier 9 Restaurant", company: "Pier 9 Restaurant", first: "Leo", last: "Marino", street: "9 Pier Rd", phone: "(555) 010-3208",
			terms: "Net 15", ctype: "Commercial", commercial: true, weight: 1, lag: 20, method: "Visa"},
		{name: "Westside Office Park", company: "Westside Office Park", first: "Nina", last: "Brooks", street: "3300 West Ave", phone: "(555) 010-3209",
			terms: "2% 10 Net 30", ctype: "Commercial", commercial: true, weight: 2, method: "Check", outCounty: true},
		{name: "City of Harborview Parks Dept", company: "City of Harborview", first: "Sam", last: "Okafor", street: "300 Civic Center Dr", phone: "(555) 010-3210",
			terms: "Net 30", ctype: "Government / Non-profit", commercial: true, nonTaxable: true, weight: 1, lag: 30, method: "Check"},
		{name: "Lighthouse Dental Group", company: "Lighthouse Dental Group", first: "Erin", last: "Walsh", street: "77 Beacon St", phone: "(555) 010-3211",
			terms: "Net 15", ctype: "Commercial", commercial: true, weight: 1, lag: 3, method: "MasterCard"},
		{name: "Cash Sales", first: "", last: "", street: "", phone: "", terms: "Due on receipt", ctype: "Walk-in", weight: 0, method: "Cash"},
	}
	countyTax := g.it("Harbor County")
	groupTax := g.it("Harborview Combined")
	for i, d := range defs {
		taxItem := groupTax
		if d.outCounty {
			taxItem = countyTax
		}
		a := addr(d.name, d.street, "")
		if d.company == "" && d.first != "" {
			a.Line1 = d.first + " " + d.last
		}
		if d.street == "" {
			a = model.Address{}
		}
		n := model.Name{Kind: model.NameCustomer, Name: d.name, CompanyName: d.company, FirstName: d.first, LastName: d.last,
			Phone: d.phone, BillAddress: a, ShipAddress: a, TermsID: p64(g.l(model.ListTerms, d.terms)),
			TypeID: p64(g.l(model.ListCustomerType, d.ctype)), Taxable: !d.nonTaxable, TaxItemID: &taxItem, Active: true,
			AccountNumber: fmt.Sprintf("C%04d", 1001+i)}
		if d.first != "" {
			n.Email = strings.ToLower(d.first+"."+slug(d.last)) + "@example.com"
		}
		if d.commercial {
			n.RepID = p64(g.l(model.ListSalesRep, "Tom Becker"))
		} else if d.weight > 0 {
			n.RepID = p64(g.l(model.ListSalesRep, "Maria Lopez"))
		}
		if d.nonTaxable {
			n.ResaleNumber = fmt.Sprintf("EX-%05d", 40210+i)
		}
		if d.creditLimit > 0 {
			n.CreditLimit = &d.creditLimit
		}
		if d.opening != 0 {
			n.OpeningBalance, n.OpeningDate = &d.opening, g.open
		}
		if pm, ok := g.list[model.ListPaymentMethod+":"+d.method]; ok {
			n.PaymentMethodID = &pm
		}
		id, err := lists.SaveName(g.ctx, g.tx, &n, g.opt)
		if err != nil {
			return err
		}
		c := &cust{id: id, name: d.name, commercial: d.commercial, taxable: !d.nonTaxable, taxItem: taxItem, terms: d.terms,
			weight: d.weight, lag: d.lag, method: d.method, addr: addrText(a)}
		if d.street == "" {
			c.addr = ""
		}
		for _, j := range d.jobs {
			parent := id
			jn := model.Name{Kind: model.NameCustomer, Name: j.name, ParentID: &parent, CompanyName: d.company, FirstName: d.first, LastName: d.last,
				Phone: d.phone, BillAddress: a, ShipAddress: a, TermsID: n.TermsID, TypeID: n.TypeID, Taxable: !d.nonTaxable,
				TaxItemID: &taxItem, RepID: n.RepID, JobStatus: j.status, JobDescription: j.desc, JobTypeID: p64(g.l(model.ListJobType, j.typ)),
				JobStartDate: g.start, Active: true}
			jid, err := lists.SaveName(g.ctx, g.tx, &jn, g.opt)
			if err != nil {
				return err
			}
			c.jobs = append(c.jobs, jid)
			g.name[d.name+":"+j.name] = jid
		}
		g.custs = append(g.custs, c)
		g.name[d.name] = id
	}
	return nil
}

func (g *gen) cust(name string) *cust {
	for _, c := range g.custs {
		if c.name == name {
			return c
		}
	}
	panic("sample: unknown customer " + name)
}
