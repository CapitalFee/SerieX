package qbimport

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// Problem is something found while reading or importing the files.
type Problem struct {
	File    string `json:"file"`    // "iif", "tb", "invoices", "bills" or "" (the import as a whole)
	Line    int    `json:"line"`    // line of that file (0 when not tied to one)
	Level   string `json:"level"`   // "error": blocks the import (or the line is skipped); "note": for information
	Message string `json:"message"` // plain language
}

const (
	levelError = "error"
	levelNote  = "note"
)

// ---------------------------------------------------------------------------
// Type codes

// accountTypes maps IIF ACCNTTYPE codes (and the type names themselves) to SerieX account types.
var accountTypes = map[string]string{
	"BANK": model.AcctBank, "AR": model.AcctAR, "OCASSET": model.AcctOCA, "FIXASSET": model.AcctFixedAsset,
	"OASSET": model.AcctOtherAsset, "AP": model.AcctAP, "CCARD": model.AcctCreditCard, "OCLIAB": model.AcctOCL,
	"LTLIAB": model.AcctLTL, "EQUITY": model.AcctEquity, "INC": model.AcctIncome, "COGS": model.AcctCOGS,
	"EXP": model.AcctExpense, "EXINC": model.AcctOtherIncome, "EXEXP": model.AcctOtherExpense, "NONPOSTING": model.AcctNonPosting,
	"OTHERASSET": model.AcctOtherAsset, "OTHERCURRENTASSET": model.AcctOCA, "FIXEDASSET": model.AcctFixedAsset,
	"ACCOUNTSRECEIVABLE": model.AcctAR, "ACCOUNTSPAYABLE": model.AcctAP, "CREDITCARD": model.AcctCreditCard,
	"OTHERCURRENTLIABILITY": model.AcctOCL, "LONGTERMLIABILITY": model.AcctLTL, "INCOME": model.AcctIncome,
	"COSTOFGOODSSOLD": model.AcctCOGS, "EXPENSE": model.AcctExpense, "OTHERINCOME": model.AcctOtherIncome,
	"OTHEREXPENSE": model.AcctOtherExpense, "NONPOSTINGACCOUNT": model.AcctNonPosting,
}

var lettersOnly = regexp.MustCompile(`[^A-Z]`)

// accountTypeOf returns the SerieX type of an ACCNTTYPE code ("" when unknown).
func accountTypeOf(code string) string {
	return accountTypes[lettersOnly.ReplaceAllString(strings.ToUpper(code), "")]
}

// specialCodes maps the EXTRA column of ACCNT rows to SerieX special accounts.
var specialCodes = map[string]string{
	"UNDEPOSIT": store.SpecialUndepositedFunds, "OPENBAL": store.SpecialOpeningBalanceEquity,
	"RETEARNINGS": store.SpecialRetainedEarnings, "SALESTAX": store.SpecialSalesTaxPayable,
	"INVENTORYASSET": store.SpecialInventoryAsset, "COGS": store.SpecialCOGS,
	"UNCATINCOME": store.SpecialUncategorizedIncome, "UNCATEXPENSE": store.SpecialUncategorizedExpense,
}

// itemTypes maps IIF INVITEMTYPE codes to SerieX item types.
var itemTypes = map[string]string{
	"SERV": model.ItemService, "SERVICE": model.ItemService, "PART": model.ItemNonInventory,
	"NONINVENTORY": model.ItemNonInventory, "NONINVENTORYPART": model.ItemNonInventory,
	"INVENTORY": model.ItemInventoryPart, "INVENTORYPART": model.ItemInventoryPart, "ASSEMBLY": model.ItemInventoryPart,
	"OTHC": model.ItemOtherCharge, "OTHERCHARGE": model.ItemOtherCharge, "SUBT": model.ItemSubtotal, "SUBTOTAL": model.ItemSubtotal,
	"GRP": model.ItemGroup, "GROUP": model.ItemGroup, "DISC": model.ItemDiscount, "DISCOUNT": model.ItemDiscount,
	"PMT": model.ItemPayment, "PAYMENT": model.ItemPayment, "STAX": model.ItemSalesTax, "SALESTAXITEM": model.ItemSalesTax,
	"COMPTAX": model.ItemSalesTaxGroup, "SALESTAXGROUP": model.ItemSalesTaxGroup,
}

func itemTypeOf(code string) string {
	return itemTypes[lettersOnly.ReplaceAllString(strings.ToUpper(code), "")]
}

// listKinds maps IIF list rows to SerieX simple lists.
var listKinds = map[string]string{
	"CLASS": model.ListClass, "TERMS": model.ListTerms, "PAYMETH": model.ListPaymentMethod, "SHIPMETH": model.ListShipVia,
	"CTYPE": model.ListCustomerType, "VTYPE": model.ListVendorType, "JOBTYPE": model.ListJobType,
	"CUSTMSG": model.ListCustomerMessage, "INVMEMO": model.ListCustomerMessage, "SALESREP": model.ListSalesRep,
}

// sectionLabels names the IIF row kinds for people.
var sectionLabels = map[string]string{
	"ACCNT": "Accounts", "CUST": "Customers and jobs", "VEND": "Vendors", "OTHERNAME": "Other names", "EMP": "Employees",
	"INVITEM": "Items", "CLASS": "Classes", "TERMS": "Terms", "PAYMETH": "Payment methods", "SHIPMETH": "Shipping methods",
	"CTYPE": "Customer types", "VTYPE": "Vendor types", "JOBTYPE": "Job types", "CUSTMSG": "Customer messages", "INVMEMO": "Customer messages",
	"SALESREP": "Sales reps", "TRNS": "Transactions",
}

// paymentTypeOf guesses the payment type of a payment method from its name.
func paymentTypeOf(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "cash"):
		return "Cash"
	case strings.Contains(n, "e-check") || strings.Contains(n, "echeck") || strings.Contains(n, "ach"):
		return "E-Check"
	case strings.Contains(n, "check") || strings.Contains(n, "cheque"):
		return "Check"
	case strings.Contains(n, "american express") || strings.Contains(n, "amex"):
		return "American Express"
	case strings.Contains(n, "discover"):
		return "Discover"
	case strings.Contains(n, "master"):
		return "MasterCard"
	case strings.Contains(n, "visa"):
		return "Visa"
	case strings.Contains(n, "debit"):
		return "Debit Card"
	case strings.Contains(n, "gift"):
		return "Gift Card"
	}
	return "Other"
}

// ---------------------------------------------------------------------------
// Source lists

type srcAccount struct {
	Line                  int
	Full                  string
	RawType, Type         string
	Special               string
	Number, Desc, BankNum string
	Routing               string // from the online banking settings (QB ONLINE rows)
	Hidden                bool
	OBAmount              int64
}

type srcName struct {
	Line    int
	Kind    string // customer, vendor, other
	Full    string
	N       model.Name
	Terms   string
	Type    string // customer / vendor type
	Rep     string // sales rep initials or name
	Tax     string // sales tax item
	Job     string // job type
	Hidden  bool
	FromEmp bool
}

type srcItem struct {
	Line                         int
	Full                         string
	RawType, Type                string
	Desc, PurchDesc              string
	Accnt, AssetAccnt, COGSAccnt string
	PrefVend, TaxVend, PayMeth   string
	Price                        float64
	PricePct                     bool
	Cost                         float64
	Taxable, Hidden              bool
	Purchased                    bool
	ReorderPoint                 *float64
	Qty                          *float64 // quantity on hand (when the export has it)
}

type srcListEntry struct {
	Line   int
	List   string
	Full   string
	Hidden bool
	Data   map[string]any
	Rep    string // sales rep: associated name
}

// source is everything read from the files.
type source struct {
	file     *iifFile
	accounts []*srcAccount
	names    []*srcName
	items    []*srcItem
	lists    []*srcListEntry
	problems []Problem
}

func first(r *record, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(r.get(k)); v != "" {
			return v
		}
	}
	return ""
}

var cityStateZip = regexp.MustCompile(`^(.*?)[,\s]+([A-Za-z]{2})\.?\s+(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d)$`)

// address turns the free-form address lines of QuickBooks (BADDR1..5) into
// street lines, city, state and ZIP (when the last line reads "City, ST 12345").
func address(lines []string) model.Address {
	var ls []string
	for _, l := range lines {
		if l = strings.TrimSpace(l); l != "" {
			ls = append(ls, l)
		}
	}
	var a model.Address
	if n := len(ls); n > 0 {
		last := ls[n-1]
		if strings.EqualFold(last, "USA") || strings.EqualFold(last, "United States") || strings.EqualFold(last, "Canada") {
			a.Country = last
			ls = ls[:n-1]
		}
	}
	if n := len(ls); n > 0 {
		if m := cityStateZip.FindStringSubmatch(ls[n-1]); m != nil && strings.TrimSpace(m[1]) != "" {
			a.City, a.State, a.Zip = strings.TrimSpace(strings.TrimSuffix(m[1], ",")), strings.ToUpper(m[2]), m[3]
			ls = ls[:n-1]
		}
	}
	if len(ls) > 3 {
		ls = append(ls[:2], strings.Join(ls[2:], ", "))
	}
	for i, l := range ls {
		switch i {
		case 0:
			a.Line1 = l
		case 1:
			a.Line2 = l
		case 2:
			a.Line3 = l
		}
	}
	return a
}

func addrOf(r *record, prefix string) model.Address {
	var ls []string
	for i := 1; i <= 5; i++ {
		ls = append(ls, r.get(prefix+strconv.Itoa(i)))
	}
	return address(ls)
}

var jobStatusCodes = map[string]string{"0": "", "1": "Pending", "2": "Awarded", "3": "In progress", "4": "Closed", "5": "Not awarded",
	"NONE": "", "PENDING": "Pending", "AWARDED": "Awarded", "IN PROGRESS": "In progress", "INPROGRESS": "In progress",
	"CLOSED": "Closed", "NOT AWARDED": "Not awarded", "NOTAWARDED": "Not awarded"}

func notes(r *record) string {
	var out []string
	for _, k := range []string{"NOTEPAD", "NOTE"} {
		if v := strings.TrimSpace(r.get(k)); v != "" {
			out = append(out, v)
		}
	}
	return strings.Join(out, "\n")
}

// readSource turns the list rows of an IIF file into accounts, names, items and simple list entries.
func readSource(f *iifFile) *source {
	s := &source{file: f}
	errAt := func(line int, msg string) {
		s.problems = append(s.problems, Problem{File: "iif", Line: line, Level: levelError, Message: msg})
	}
	// custom field labels of names (CUSTNAMEDICT: INDEX 0 = CUSTFLD1)
	nameFields := map[int]string{}
	for _, r := range f.Rows {
		if r.Kind == "CUSTNAMEDICT" {
			if i, err := strconv.Atoi(strings.TrimSpace(r.get("INDEX"))); err == nil && strings.TrimSpace(r.get("LABEL")) != "" {
				nameFields[i] = strings.TrimSpace(r.get("LABEL"))
			}
		}
	}
	type online struct{ accnt, routing, number string }
	var onlines []online
	itemFieldValues := 0
	for _, r := range f.Rows {
		switch r.Kind {
		case "ACCNT":
			full := strings.Join(splitFull(r.get("NAME")), ":")
			if full == "" {
				errAt(r.Line, "This account has no name and was ignored.")
				continue
			}
			a := &srcAccount{Line: r.Line, Full: full, RawType: r.get("ACCNTTYPE"), Number: r.get("ACCNUM"),
				Desc: r.get("DESC"), BankNum: r.get("BANKNUM"), Hidden: yes(r.get("HIDDEN"))}
			a.Type = accountTypeOf(a.RawType)
			a.Special = specialCodes[strings.ToUpper(strings.TrimSpace(r.get("EXTRA")))]
			if v, ok := parseMoney(r.get("OBAMOUNT")); ok {
				a.OBAmount = v
			}
			s.accounts = append(s.accounts, a)
		case "CUST", "VEND", "OTHERNAME", "EMP":
			full := strings.Join(splitFull(r.get("NAME")), ":")
			if full == "" {
				errAt(r.Line, "This name has no name and was ignored.")
				continue
			}
			n := &srcName{Line: r.Line, Full: full, Hidden: yes(r.get("HIDDEN")), FromEmp: r.Kind == "EMP"}
			m := &n.N
			m.CompanyName = r.get("COMPANYNAME")
			m.Salutation = r.get("SALUTATION")
			m.FirstName = r.get("FIRSTNAME")
			m.MiddleName = r.get("MIDINIT")
			m.LastName = r.get("LASTNAME")
			m.Phone = first(r, "PHONE1", "PHONE")
			m.AltPhone = r.get("PHONE2")
			m.Fax = r.get("FAXNUM")
			m.Email = r.get("EMAIL")
			m.Notes = notes(r)
			if c := r.get("CONT1"); c != "" && m.FirstName == "" && m.LastName == "" {
				m.Notes = strings.TrimSpace("Contact: " + c + "\n" + m.Notes)
			}
			if c := r.get("CONT2"); c != "" {
				m.Notes = strings.TrimSpace(m.Notes + "\nAlt. contact: " + c)
			}
			m.AccountNumber = r.get("ACCNUM")
			m.Active = !n.Hidden
			for i := 1; i <= 15; i++ {
				if v := strings.TrimSpace(r.get("CUSTFLD" + strconv.Itoa(i))); v != "" {
					label := nameFields[i-1]
					if label == "" {
						label = "Custom field " + strconv.Itoa(i)
					}
					m.Notes = strings.TrimSpace(m.Notes + "\n" + label + ": " + v)
				}
			}
			switch r.Kind {
			case "CUST":
				n.Kind = model.NameCustomer
				m.BillAddress = addrOf(r, "BADDR")
				m.ShipAddress = addrOf(r, "SADDR")
				n.Type, n.Terms, n.Rep, n.Tax, n.Job = r.get("CTYPE"), r.get("TERMS"), r.get("REP"), r.get("TAXITEM"), r.get("JOBTYPE")
				m.Taxable = yes(r.get("TAXABLE"))
				m.ResaleNumber = r.get("RESALENUM")
				if v, ok := parseMoney(r.get("LIMIT")); ok && v > 0 {
					f := store.Dollars(v)
					m.CreditLimit = &f
				}
				m.JobDescription = r.get("JOBDESC")
				m.JobStatus = jobStatusCodes[strings.ToUpper(strings.TrimSpace(r.get("JOBSTATUS")))]
				m.JobStartDate, _ = parseDate(r.get("JOBSTART"))
				m.JobProjectedEnd, _ = parseDate(r.get("JOBPROJEND"))
				m.JobEndDate, _ = parseDate(r.get("JOBEND"))
			case "VEND":
				n.Kind = model.NameVendor
				m.BillAddress = addrOf(r, "ADDR")
				n.Type, n.Terms = r.get("VTYPE"), r.get("TERMS")
				m.PrintOnCheckAs = r.get("PRINTAS")
				m.TaxIdent = r.get("TAXID")
				m.Is1099 = yes(r.get("1099"))
				if v, ok := parseMoney(r.get("LIMIT")); ok && v > 0 {
					f := store.Dollars(v)
					m.CreditLimit = &f
				}
			default:
				n.Kind = model.NameOther
				m.BillAddress = addrOf(r, "BADDR")
				if r.Kind == "EMP" {
					if m.BillAddress == (model.Address{}) {
						m.BillAddress = addrOf(r, "ADDR")
					}
					m.Notes = strings.TrimSpace("Employee in the QuickBooks® Desktop file.\n" + m.Notes)
					if m.FirstName == "" && m.LastName == "" {
						m.FirstName, m.LastName = r.get("FIRSTNAME"), r.get("LASTNAME")
					}
				}
			}
			s.names = append(s.names, n)
		case "INVITEM":
			full := strings.Join(splitFull(r.get("NAME")), ":")
			if full == "" {
				errAt(r.Line, "This item has no name and was ignored.")
				continue
			}
			it := &srcItem{Line: r.Line, Full: full, RawType: r.get("INVITEMTYPE"), Desc: r.get("DESC"), PurchDesc: r.get("PURCHASEDESC"),
				Accnt: r.get("ACCNT"), AssetAccnt: r.get("ASSETACCNT"), COGSAccnt: r.get("COGSACCNT"), PrefVend: r.get("PREFVEND"),
				TaxVend: r.get("TAXVEND"), PayMeth: r.get("PAYMETH"), Taxable: yes(r.get("TAXABLE")), Hidden: yes(r.get("HIDDEN"))}
			it.Type = itemTypeOf(it.RawType)
			if v, pct, ok := parseNumber(r.get("PRICE")); ok {
				it.Price, it.PricePct = v, pct
			}
			if v, _, ok := parseNumber(r.get("COST")); ok {
				it.Cost = v
			}
			if v, _, ok := parseNumber(r.get("REORDERPOINT")); ok {
				it.ReorderPoint = &v
			}
			if v, _, ok := parseNumber(first(r, "QNTY", "QTYONHAND")); ok {
				it.Qty = &v
			}
			it.Purchased = it.COGSAccnt != "" || it.PurchDesc != "" || it.Cost != 0 || yes(r.get("ISPASSEDTHRU"))
			for i := 1; i <= 15; i++ {
				if strings.TrimSpace(r.get("CUSTFLD"+strconv.Itoa(i))) != "" {
					itemFieldValues++
					break
				}
			}
			s.items = append(s.items, it)
		case "CUSTNAMEDICT", "ENDCUSTNAMEDICT", "CUSTITEMDICT", "ENDCUSTITEMDICT":
			// custom field labels: name values go to the notes (above)
		case "SALESTAXCODE":
			// customers and items are taxable or not; only codes beyond Tax / Non lose something
			if code := strings.ToUpper(strings.TrimSpace(r.get("CODE"))); code != "" && code != "TAX" && code != "NON" {
				s.problems = append(s.problems, Problem{File: "iif", Line: r.Line, Level: levelNote,
					Message: fmt.Sprintf("The sales tax code %s (%s) is not imported: SerieX Books marks customers and items as taxable or not taxable.", r.get("CODE"), r.get("DESC"))})
			}
		case "QB ONLINE":
			// online banking settings: routing and account numbers go to the bank account
			onlines = append(onlines, online{strings.Join(splitFull(r.get("ACCNT")), ":"), r.get("ROUTNUM"), r.get("OLACCNT")})
		default:
			list, ok := listKinds[r.Kind]
			if !ok {
				s.problems = append(s.problems, Problem{File: "iif", Line: r.Line, Level: levelNote,
					Message: "SerieX Books does not import " + r.Kind + " rows; this row was skipped."})
				continue
			}
			e := &srcListEntry{Line: r.Line, List: list, Hidden: yes(r.get("HIDDEN")), Data: map[string]any{}}
			switch list {
			case model.ListSalesRep:
				ini := r.get("INITIALS")
				e.Rep = r.get("ASSOCIATEDNAME")
				e.Full = strings.TrimSpace(strings.ReplaceAll(e.Rep, ":", " "))
				if e.Full == "" {
					e.Full = ini
				}
				e.Data["initials"] = ini
			case model.ListTerms:
				e.Full = strings.TrimSpace(strings.ReplaceAll(r.get("NAME"), ":", " -"))
				due, _, _ := parseNumber(r.get("DUEDAYS"))
				disc, _, _ := parseNumber(r.get("DISCPER"))
				discDays, _, _ := parseNumber(r.get("DISCDAYS"))
				minDays, _, _ := parseNumber(r.get("MINDAYS"))
				if strings.TrimSpace(r.get("TERMSTYPE")) == "1" {
					if due < 1 {
						due = 1
					}
					e.Data = map[string]any{"dateDriven": true, "dueDay": due, "discountPct": disc, "discountDay": discDays, "dueNextMonthDays": minDays}
				} else {
					e.Data = map[string]any{"dateDriven": false, "netDays": due, "discountPct": disc, "discountDays": discDays}
				}
			case model.ListPaymentMethod:
				e.Full = strings.TrimSpace(strings.ReplaceAll(r.get("NAME"), ":", " -"))
				e.Data["type"] = paymentTypeOf(e.Full)
			case model.ListClass, model.ListCustomerType, model.ListVendorType, model.ListJobType:
				e.Full = strings.Join(splitFull(r.get("NAME")), ":") // "Parent:Child"
			default:
				e.Full = strings.TrimSpace(strings.ReplaceAll(r.get("NAME"), ":", " -"))
			}
			if e.Full == "" {
				errAt(r.Line, "This "+strings.ToLower(sectionLabels[r.Kind])+" entry has no name and was ignored.")
				continue
			}
			s.lists = append(s.lists, e)
		}
	}
	for _, o := range onlines {
		for _, a := range s.accounts {
			if normFull(a.Full) != normFull(o.accnt) {
				continue
			}
			if a.BankNum == "" {
				a.BankNum = strings.TrimSpace(o.number)
			}
			if rt := strings.TrimSpace(o.routing); strings.Trim(rt, "0") != "" {
				a.Routing = rt
			}
		}
	}
	if itemFieldValues > 0 {
		s.problems = append(s.problems, Problem{File: "iif", Level: levelNote,
			Message: fmt.Sprintf("%d items have custom field values; SerieX Books items have no custom fields, so those values are not imported.", itemFieldValues)})
	}
	return s
}
