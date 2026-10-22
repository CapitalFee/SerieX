// Package model holds the JSON contract shared by the server and the web
// client (web/src/api/types.ts mirrors it field for field).
//
// Money is sent as dollars (float64, 2 decimals) and stored as integer cents
// (see store.Cents / store.Dollars). Dates are "YYYY-MM-DD". Optional ids are
// *int64 (JSON null when absent). Fields marked (ro) are computed by the server
// and ignored on input.
package model

// ---------------------------------------------------------------------------
// Account types (the display string is the code).

const (
	AcctBank         = "Bank"
	AcctAR           = "Accounts Receivable"
	AcctOCA          = "Other Current Asset"
	AcctFixedAsset   = "Fixed Asset"
	AcctOtherAsset   = "Other Asset"
	AcctAP           = "Accounts Payable"
	AcctCreditCard   = "Credit Card"
	AcctOCL          = "Other Current Liability"
	AcctLTL          = "Long Term Liability"
	AcctEquity       = "Equity"
	AcctIncome       = "Income"
	AcctCOGS         = "Cost of Goods Sold"
	AcctExpense      = "Expense"
	AcctOtherIncome  = "Other Income"
	AcctOtherExpense = "Other Expense"
	AcctNonPosting   = "Non-Posting"
)

// AccountTypeOrder is the chart of accounts sort order.
var AccountTypeOrder = []string{
	AcctBank, AcctAR, AcctOCA, AcctFixedAsset, AcctOtherAsset,
	AcctAP, AcctCreditCard, AcctOCL, AcctLTL, AcctEquity,
	AcctIncome, AcctCOGS, AcctExpense, AcctOtherIncome, AcctOtherExpense, AcctNonPosting,
}

// AccountTypeRank returns the position of t in AccountTypeOrder (99 if unknown).
func AccountTypeRank(t string) int {
	for i, x := range AccountTypeOrder {
		if x == t {
			return i
		}
	}
	return 99
}

// IsDebitNormal: the natural balance is a debit (assets, cost of goods sold, expenses).
func IsDebitNormal(t string) bool {
	switch t {
	case AcctBank, AcctAR, AcctOCA, AcctFixedAsset, AcctOtherAsset, AcctCOGS, AcctExpense, AcctOtherExpense:
		return true
	}
	return false
}

// IsBalanceSheet: asset, liability and equity accounts.
func IsBalanceSheet(t string) bool {
	switch t {
	case AcctBank, AcctAR, AcctOCA, AcctFixedAsset, AcctOtherAsset, AcctAP, AcctCreditCard, AcctOCL, AcctLTL, AcctEquity:
		return true
	}
	return false
}

// IsProfitLoss: income, cost of goods sold and expense accounts.
func IsProfitLoss(t string) bool {
	switch t {
	case AcctIncome, AcctCOGS, AcctExpense, AcctOtherIncome, AcctOtherExpense:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Transaction types

const (
	TxInvoice         = "INV"
	TxSalesReceipt    = "SALESRCPT"
	TxPayment         = "PMT"
	TxCreditMemo      = "CREDMEM"
	TxStatementCharge = "STMTCHG"
	TxEstimate        = "EST"
	TxDeposit         = "DEP"
	TxCheck           = "CHK"
	TxRefund          = "REFUND"
	TxBill            = "BILL"
	TxVendorCredit    = "BILLCRED"
	TxBillPayment     = "BILLPMT"
	TxItemReceipt     = "ITEMRCPT"
	TxPurchaseOrder   = "PURCHORD"
	TxCCCharge        = "CCCHARGE"
	TxCCCredit        = "CCCREDIT"
	TxTransfer        = "TRANSFER"
	TxJournal         = "GENJRNL"
	TxInventoryAdjust = "INVADJ"
	TxSalesTaxPayment = "TAXPMT"
)

// TxnTypeLabels are the names shown in reports and lists.
var TxnTypeLabels = map[string]string{
	TxInvoice:         "Invoice",
	TxSalesReceipt:    "Sales Receipt",
	TxPayment:         "Payment",
	TxCreditMemo:      "Credit Memo",
	TxStatementCharge: "Statement Charge",
	TxEstimate:        "Estimate",
	TxDeposit:         "Deposit",
	TxCheck:           "Check",
	TxRefund:          "Refund",
	TxBill:            "Bill",
	TxVendorCredit:    "Credit",
	TxBillPayment:     "Bill Pmt -Check", // "Bill Pmt -CCard" when paid from a credit card account
	TxItemReceipt:     "Item Receipt",
	TxPurchaseOrder:   "Purchase Order",
	TxCCCharge:        "Credit Card Charge",
	TxCCCredit:        "Credit Card Credit",
	TxTransfer:        "Transfer",
	TxJournal:         "General Journal",
	TxInventoryAdjust: "Inventory Adjust",
	TxSalesTaxPayment: "Sales Tax Payment",
}

// TxnTypeAbbrev are the short codes shown in the register TYPE column.
var TxnTypeAbbrev = map[string]string{
	TxInvoice:         "INV",
	TxSalesReceipt:    "RCPT",
	TxPayment:         "PMT",
	TxCreditMemo:      "CREDMEM",
	TxStatementCharge: "STMTCHG",
	TxEstimate:        "EST",
	TxDeposit:         "DEP",
	TxCheck:           "CHK",
	TxRefund:          "REFUND",
	TxBill:            "BILL",
	TxVendorCredit:    "BILLCRED",
	TxBillPayment:     "BILLPMT",
	TxItemReceipt:     "ITEM RCPT",
	TxPurchaseOrder:   "PURCHORD",
	TxCCCharge:        "CC",
	TxCCCredit:        "CC CRED",
	TxTransfer:        "TRANSFR",
	TxJournal:         "GENJRNL",
	TxInventoryAdjust: "INV ADJ",
	TxSalesTaxPayment: "TAXPMT",
}

// IsNonPosting: estimates and purchase orders never touch the general ledger.
func IsNonPosting(t string) bool { return t == TxEstimate || t == TxPurchaseOrder }

// ---------------------------------------------------------------------------
// Item types

const (
	ItemService       = "Service"
	ItemInventoryPart = "Inventory Part"
	ItemNonInventory  = "Non-inventory Part"
	ItemOtherCharge   = "Other Charge"
	ItemSubtotal      = "Subtotal"
	ItemGroup         = "Group"
	ItemDiscount      = "Discount"
	ItemPayment       = "Payment"
	ItemSalesTax      = "Sales Tax Item"
	ItemSalesTaxGroup = "Sales Tax Group"
)

var ItemTypeOrder = []string{
	ItemService, ItemInventoryPart, ItemNonInventory, ItemOtherCharge, ItemSubtotal,
	ItemGroup, ItemDiscount, ItemPayment, ItemSalesTax, ItemSalesTaxGroup,
}

// ---------------------------------------------------------------------------
// Simple lists (list_entries.list)

const (
	ListClass           = "class"
	ListCustomerType    = "customer_type"
	ListVendorType      = "vendor_type"
	ListJobType         = "job_type"
	ListTerms           = "terms"
	ListPaymentMethod   = "payment_method"
	ListShipVia         = "ship_via"
	ListCustomerMessage = "customer_message"
	ListSalesRep        = "sales_rep"
)

var AllLists = []string{ListClass, ListCustomerType, ListVendorType, ListJobType, ListTerms, ListPaymentMethod, ListShipVia, ListCustomerMessage, ListSalesRep}

// ListEntry is one entry of a simple list.
//
// Data by list:
//
//	terms:          {"dateDriven":false,"netDays":30,"discountPct":2,"discountDays":10}
//	                {"dateDriven":true,"dueDay":15,"discountPct":0,"discountDay":0,"dueNextMonthDays":0}
//	payment_method: {"type":"Cash"|"Check"|"American Express"|"Discover"|"MasterCard"|"Visa"|"Debit Card"|"E-Check"|"Gift Card"|"Other"}
//	sales_rep:      {"initials":"JS","nameId":12}
type ListEntry struct {
	ID       int64          `json:"id"`
	List     string         `json:"list"`
	Name     string         `json:"name"`
	ParentID *int64         `json:"parentId"`
	FullName string         `json:"fullName"` // (ro) "Parent:Child"
	Level    int            `json:"level"`    // (ro) 0 = top level
	Active   bool           `json:"active"`
	Data     map[string]any `json:"data"`
	// (ro) sent back on save (or as If-Match on delete): a save based on an
	// older copy is refused (409 conflict)
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// ---------------------------------------------------------------------------
// Accounts

type Account struct {
	ID             int64    `json:"id"`
	Name           string   `json:"name"`
	Number         string   `json:"number"`
	Type           string   `json:"type"`
	ParentID       *int64   `json:"parentId"`
	FullName       string   `json:"fullName"` // (ro) "Parent:Child"
	Level          int      `json:"level"`    // (ro)
	Description    string   `json:"description"`
	Note           string   `json:"note"`
	BankAcctNumber string   `json:"bankAcctNumber"`
	RoutingNumber  string   `json:"routingNumber"`
	TaxLine        string   `json:"taxLine"`
	Special        string   `json:"special"` // (ro) store.Special* or ""
	Active         bool     `json:"active"`
	Balance        float64  `json:"balance"`                  // (ro) natural sign (positive = normal balance), includes subaccounts
	OwnBalance     float64  `json:"ownBalance"`               // (ro) natural sign, this account only
	HasTxns        bool     `json:"hasTxns"`                  // (ro)
	OpeningBalance *float64 `json:"openingBalance,omitempty"` // create only (balance sheet accounts)
	OpeningDate    string   `json:"openingDate,omitempty"`    // create only
	UpdatedAt      string   `json:"updatedAt,omitempty"`      // (ro) sent back on save: a save based on an older copy is refused
}

// ---------------------------------------------------------------------------
// Names: customers (and jobs), vendors, other names

const (
	NameCustomer = "customer"
	NameVendor   = "vendor"
	NameOther    = "other"
)

type Address struct {
	Line1   string `json:"line1"`
	Line2   string `json:"line2"`
	Line3   string `json:"line3"`
	City    string `json:"city"`
	State   string `json:"state"`
	Zip     string `json:"zip"`
	Country string `json:"country"`
}

type Name struct {
	ID       int64  `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	ParentID *int64 `json:"parentId"` // jobs: the customer (or parent job)
	FullName string `json:"fullName"` // (ro) "Customer:Job"
	Level    int    `json:"level"`    // (ro)

	CompanyName string `json:"companyName"`
	Salutation  string `json:"salutation"`
	FirstName   string `json:"firstName"`
	MiddleName  string `json:"middleName"`
	LastName    string `json:"lastName"`
	JobTitle    string `json:"jobTitle"`
	Phone       string `json:"phone"`
	AltPhone    string `json:"altPhone"`
	Mobile      string `json:"mobile"`
	Fax         string `json:"fax"`
	Email       string `json:"email"`
	CcEmail     string `json:"ccEmail"`
	Website     string `json:"website"`

	BillAddress Address `json:"billAddress"`
	ShipAddress Address `json:"shipAddress"`

	AccountNumber   string   `json:"accountNumber"`
	TermsID         *int64   `json:"termsId"`
	CreditLimit     *float64 `json:"creditLimit"`
	TypeID          *int64   `json:"typeId"` // customer_type / vendor_type
	RepID           *int64   `json:"repId"`
	PaymentMethodID *int64   `json:"paymentMethodId"`

	Taxable      bool   `json:"taxable"`   // customer sales tax code: true = "Tax", false = "Non"
	TaxItemID    *int64 `json:"taxItemId"` // customer's sales tax item or group
	ResaleNumber string `json:"resaleNumber"`

	PrintOnCheckAs    string  `json:"printOnCheckAs"` // vendor
	TaxIdent          string  `json:"taxIdent"`       // vendor tax id
	Is1099            bool    `json:"is1099"`
	PrefillAccountIDs []int64 `json:"prefillAccountIds"` // vendor: up to 3 expense accounts

	JobStatus       string `json:"jobStatus"` // "", "Pending", "Awarded", "In progress", "Closed", "Not awarded"
	JobStartDate    string `json:"jobStartDate"`
	JobProjectedEnd string `json:"jobProjectedEnd"`
	JobEndDate      string `json:"jobEndDate"`
	JobDescription  string `json:"jobDescription"`
	JobTypeID       *int64 `json:"jobTypeId"`

	Notes  string `json:"notes"`
	Active bool   `json:"active"`

	Balance    float64 `json:"balance"`    // (ro) customers: A/R balance incl. jobs; vendors: A/P balance
	OwnBalance float64 `json:"ownBalance"` // (ro) this name only (excluding sub-jobs)
	HasTxns    bool    `json:"hasTxns"`    // (ro)

	OpeningBalance *float64 `json:"openingBalance,omitempty"` // create only
	OpeningDate    string   `json:"openingDate,omitempty"`    // create only
	UpdatedAt      string   `json:"updatedAt,omitempty"`      // (ro) sent back on save: a save based on an older copy is refused
}

// ---------------------------------------------------------------------------
// Items

type ItemGroupLine struct {
	ItemID   int64   `json:"itemId"`
	ItemName string  `json:"itemName"` // (ro)
	Qty      float64 `json:"qty"`
}

type Item struct {
	ID       int64  `json:"id"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	ParentID *int64 `json:"parentId"`
	FullName string `json:"fullName"` // (ro)
	Level    int    `json:"level"`    // (ro)
	MPN      string `json:"mpn"`

	Description         string  `json:"description"`         // sales description
	PurchaseDescription string  `json:"purchaseDescription"` // purchase description
	IsPurchased         bool    `json:"isPurchased"`         // service/non-inventory/other charge: has both purchase and sales info
	SalesPrice          float64 `json:"salesPrice"`          // rate; percent when RateIsPercent (discount / other charge)
	RateIsPercent       bool    `json:"rateIsPercent"`
	Cost                float64 `json:"cost"` // purchase cost per unit

	IncomeAccountID   *int64 `json:"incomeAccountId"`  // income (service/parts/charges), discount account (Discount)
	ExpenseAccountID  *int64 `json:"expenseAccountId"` // expense, or COGS account for inventory parts
	AssetAccountID    *int64 `json:"assetAccountId"`   // inventory asset account
	PreferredVendorID *int64 `json:"preferredVendorId"`
	Taxable           bool   `json:"taxable"`

	ReorderPoint *float64 `json:"reorderPoint"`
	MaxQty       *float64 `json:"maxQty"`
	QtyOnHand    float64  `json:"qtyOnHand"`  // (ro)
	AvgCost      float64  `json:"avgCost"`    // (ro)
	AssetValue   float64  `json:"assetValue"` // (ro)
	QtyOnPO      float64  `json:"qtyOnPo"`    // (ro) open purchase order quantity

	TaxRate     float64 `json:"taxRate"`     // Sales Tax Item: percent (e.g. 7.25); Sales Tax Group: (ro) sum of members
	TaxAgencyID *int64  `json:"taxAgencyId"` // Sales Tax Item: vendor the tax is paid to

	PaymentMethodID  *int64 `json:"paymentMethodId"`  // Payment item
	DepositAccountID *int64 `json:"depositAccountId"` // Payment item: null = Undeposited Funds

	GroupLines []ItemGroupLine `json:"groupLines"` // Group / Sales Tax Group members
	Active     bool            `json:"active"`
	HasTxns    bool            `json:"hasTxns"` // (ro)

	OpeningQty   *float64 `json:"openingQty,omitempty"`   // create only, inventory parts
	OpeningValue *float64 `json:"openingValue,omitempty"` // create only
	OpeningDate  string   `json:"openingDate,omitempty"`  // create only
	UpdatedAt    string   `json:"updatedAt,omitempty"`    // (ro) sent back on save: a save based on an older copy is refused
}

// ---------------------------------------------------------------------------
// Transactions

// Line kinds
const (
	LineItem    = "item"    // item based line (sales forms, items tab of purchase forms, inventory adjustment, tax payment)
	LineExpense = "expense" // account based line (expenses tab of checks/bills/credit card)
	LineJournal = "je"      // journal entry line (Amount: + debit, - credit)
	LineDeposit = "deposit" // deposit line
)

type TxnLine struct {
	ID              int64    `json:"id"`
	Seq             int      `json:"seq"`
	Kind            string   `json:"kind"`
	ItemID          *int64   `json:"itemId"`
	AccountID       *int64   `json:"accountId"`
	Description     string   `json:"description"` // description / memo
	Qty             *float64 `json:"qty"`
	Rate            *float64 `json:"rate"` // price or cost per unit (percent when RateIsPercent)
	RateIsPercent   bool     `json:"rateIsPercent"`
	Amount          float64  `json:"amount"`
	ClassID         *int64   `json:"classId"`
	NameID          *int64   `json:"nameId"` // customer:job (purchase lines), name (journal), received from (deposit)
	Billable        bool     `json:"billable"`
	BilledTxnID     *int64   `json:"billedTxnId"` // (ro) invoice that billed this cost
	Taxable         bool     `json:"taxable"`
	ServiceDate     string   `json:"serviceDate"`
	PaymentMethodID *int64   `json:"paymentMethodId"` // deposit lines
	RefNumber       string   `json:"refNumber"`       // deposit lines: check number
	LinkedTxnID     *int64   `json:"linkedTxnId"`     // deposit line -> payment/sales receipt; bill line -> PO; invoice line -> estimate / billable cost source
	LinkedLineID    *int64   `json:"linkedLineId"`    // bill/receipt line -> PO line; invoice line -> estimate line / billable expense line
	ReceivedQty     float64  `json:"receivedQty"`     // (ro) PO lines: quantity received so far
	Closed          bool     `json:"closed"`          // PO lines: manually closed
	Cogs            float64  `json:"cogs"`            // (ro) cost of goods sold of inventory sales lines
}

// TxnLink applies a payment or credit to an open transaction.
// On input inside Txn.Links, FromTxnID null/0 means "this transaction".
type TxnLink struct {
	ID                int64   `json:"id"`
	FromTxnID         *int64  `json:"fromTxnId"`
	ToTxnID           int64   `json:"toTxnId"`
	Amount            float64 `json:"amount"`
	Discount          float64 `json:"discount"`
	DiscountAccountID *int64  `json:"discountAccountId"`
	// (ro) descriptions of the other side
	FromType      string  `json:"fromType"`
	FromRefNumber string  `json:"fromRefNumber"`
	FromDate      string  `json:"fromDate"`
	ToType        string  `json:"toType"`
	ToRefNumber   string  `json:"toRefNumber"`
	ToDate        string  `json:"toDate"`
	ToAmount      float64 `json:"toAmount"`
}

// LinkedTxn is a related transaction shown in "Transaction History".
type LinkedTxn struct {
	TxnID     int64   `json:"txnId"`
	Type      string  `json:"type"`
	TypeLabel string  `json:"typeLabel"`
	Date      string  `json:"date"`
	RefNumber string  `json:"refNumber"`
	Amount    float64 `json:"amount"`
	Relation  string  `json:"relation"` // "payment", "credit", "deposit", "bill", "purchase order", "estimate", "invoice", "refund", "item receipt"
}

type Txn struct {
	ID            int64   `json:"id"`
	Type          string  `json:"type"`
	RefNumber     string  `json:"refNumber"`
	Date          string  `json:"date"`
	NameID        *int64  `json:"nameId"`
	NameFull      string  `json:"nameFull"`      // (ro)
	AccountID     *int64  `json:"accountId"`     // header account, see posting rules
	ArApAccountID *int64  `json:"arApAccountId"` // A/R or A/P account for PMT, BILLPMT, REFUND
	ToAccountID   *int64  `json:"toAccountId"`   // TRANSFER destination
	Amount        float64 `json:"amount"`        // total; input only for PMT, BILLPMT, TRANSFER, REFUND, TAXPMT (others computed)
	OpenBalance   float64 `json:"openBalance"`   // (ro)
	Subtotal      float64 `json:"subtotal"`      // (ro) sales forms: sum of lines before tax

	DueDate           string `json:"dueDate"`
	ShipDate          string `json:"shipDate"`
	TermsID           *int64 `json:"termsId"`
	ClassID           *int64 `json:"classId"`
	RepID             *int64 `json:"repId"`
	ShipViaID         *int64 `json:"shipViaId"`
	CustomerMessageID *int64 `json:"customerMessageId"`
	PaymentMethodID   *int64 `json:"paymentMethodId"`
	FOB               string `json:"fob"`
	PONumber          string `json:"poNumber"`
	Memo              string `json:"memo"`
	BillAddress       string `json:"billAddress"` // multi-line snapshot
	ShipAddress       string `json:"shipAddress"`

	TaxItemID *int64  `json:"taxItemId"`
	TaxRate   float64 `json:"taxRate"`   // (ro) percent
	TaxAmount float64 `json:"taxAmount"` // (ro)

	ToBePrinted bool   `json:"toBePrinted"`
	ToBeEmailed bool   `json:"toBeEmailed"`
	IsPending   bool   `json:"isPending"`
	Status      string `json:"status"` // EST: "Pending"|"Accepted"|"Closed"|"Rejected"; PURCHORD: "Open"|"Closed"; INV/BILL/STMTCHG: (ro) "Open"|"Paid"; INV/SALESRCPT marked pending: (ro) "Pending"
	Voided      bool   `json:"voided"` // (ro)

	CashBackAccountID *int64  `json:"cashBackAccountId"`
	CashBackAmount    float64 `json:"cashBackAmount"`
	CashBackMemo      string  `json:"cashBackMemo"`

	Template string         `json:"template"`
	Extra    map[string]any `json:"extra"`

	Lines  []TxnLine   `json:"lines"`
	Links  []TxnLink   `json:"links"`
	Linked []LinkedTxn `json:"linked"` // (ro) related transactions

	Cleared   string `json:"cleared"`   // (ro) cleared state of the header account entry: "", "*", "R"
	CreatedBy string `json:"createdBy"` // (ro)
	CreatedAt string `json:"createdAt"` // (ro)
	UpdatedAt string `json:"updatedAt"` // (ro)
}

// TxnSummary is a row of transaction lists (centers, find, lists).
type TxnSummary struct {
	ID          int64   `json:"id"`
	Type        string  `json:"type"`
	TypeLabel   string  `json:"typeLabel"`
	RefNumber   string  `json:"refNumber"`
	Date        string  `json:"date"`
	DueDate     string  `json:"dueDate"`
	NameID      *int64  `json:"nameId"`
	NameFull    string  `json:"nameFull"`
	AccountID   *int64  `json:"accountId"`
	AccountName string  `json:"accountName"`
	Amount      float64 `json:"amount"`
	OpenBalance float64 `json:"openBalance"`
	Memo        string  `json:"memo"`
	Status      string  `json:"status"`
	Voided      bool    `json:"voided"`
	IsPending   bool    `json:"isPending"`
	ToBePrinted bool    `json:"toBePrinted"`
}

type TxnListResult struct {
	Rows  []TxnSummary `json:"rows"`
	Total int          `json:"total"`
}

// OpenDoc is an open invoice/bill/charge or an available credit (Receive Payments, Pay Bills).
type OpenDoc struct {
	TxnID             int64   `json:"txnId"`
	Type              string  `json:"type"`
	TypeLabel         string  `json:"typeLabel"`
	Date              string  `json:"date"`
	DueDate           string  `json:"dueDate"`
	RefNumber         string  `json:"refNumber"`
	NameID            int64   `json:"nameId"`
	NameFull          string  `json:"nameFull"`
	Amount            float64 `json:"amount"`
	OpenBalance       float64 `json:"openBalance"`
	TermsID           *int64  `json:"termsId"`
	DiscountDate      string  `json:"discountDate"`      // last day the terms discount applies ("" if none)
	SuggestedDiscount float64 `json:"suggestedDiscount"` // terms discount available on the open balance
	Memo              string  `json:"memo"`
	PONumber          string  `json:"poNumber"`
	ArApAccountID     int64   `json:"arApAccountId"`
}

type OpenDocsResult struct {
	Charges []OpenDoc `json:"charges"` // invoices / statement charges / bills
	Credits []OpenDoc `json:"credits"` // credit memos / unapplied payments / vendor credits
}

// UndepositedItem is a payment or sales receipt waiting in Undeposited Funds.
type UndepositedItem struct {
	TxnID             int64   `json:"txnId"`
	Type              string  `json:"type"`
	TypeLabel         string  `json:"typeLabel"`
	Date              string  `json:"date"`
	RefNumber         string  `json:"refNumber"`
	NameID            *int64  `json:"nameId"`
	NameFull          string  `json:"nameFull"`
	PaymentMethodID   *int64  `json:"paymentMethodId"`
	PaymentMethodName string  `json:"paymentMethodName"`
	Amount            float64 `json:"amount"`
	Memo              string  `json:"memo"`
	ClassID           *int64  `json:"classId"`
	// LineID is set for a payment-item line of an invoice or sales receipt that
	// went to Undeposited Funds: deposit it with linkedTxnId = TxnID and
	// linkedLineId = LineID (amount = Amount). Null for whole payments.
	LineID      *int64 `json:"lineId"`
	CheckNumber string `json:"checkNumber"` // check number of the payment ("" when none)
}

// BillableCost is an uninvoiced billable expense or item line for a customer.
type BillableCost struct {
	LineID      int64    `json:"lineId"`
	TxnID       int64    `json:"txnId"`
	TxnType     string   `json:"txnType"`
	Date        string   `json:"date"`
	RefNumber   string   `json:"refNumber"`
	VendorName  string   `json:"vendorName"`
	ItemID      *int64   `json:"itemId"`
	AccountID   *int64   `json:"accountId"`
	Description string   `json:"description"`
	Qty         *float64 `json:"qty"`
	Rate        *float64 `json:"rate"`
	Amount      float64  `json:"amount"`
	ClassID     *int64   `json:"classId"`
	NameID      *int64   `json:"nameId"`   // customer:job the cost is billable to
	NameFull    string   `json:"nameFull"` // "Customer:Job"
}

// RegisterRow is one transaction in an account register (two display lines).
type RegisterRow struct {
	TxnID        int64   `json:"txnId"`
	GLID         int64   `json:"glId"` // entry for this account (first one when several)
	Date         string  `json:"date"`
	RefNumber    string  `json:"refNumber"`
	Type         string  `json:"type"`
	TypeAbbrev   string  `json:"typeAbbrev"`
	NameID       *int64  `json:"nameId"`
	NameFull     string  `json:"nameFull"`
	OtherAccount string  `json:"otherAccount"` // other side account name or "-split-"
	Memo         string  `json:"memo"`
	Increase     float64 `json:"increase"` // natural-sign increase (deposit / charge / debit for assets)
	Decrease     float64 `json:"decrease"` // natural-sign decrease (payment / check)
	Cleared      string  `json:"cleared"`
	Balance      float64 `json:"balance"` // running balance, natural sign
	DueDate      string  `json:"dueDate"`
	OpenBalance  float64 `json:"openBalance"` // A/R, A/P registers
	Voided       bool    `json:"voided"`
}

type RegisterResult struct {
	Account       Account       `json:"account"`
	IncreaseLabel string        `json:"increaseLabel"` // e.g. "Deposit", "Charge", "Increase"
	DecreaseLabel string        `json:"decreaseLabel"` // e.g. "Payment", "Decrease"
	Rows          []RegisterRow `json:"rows"`
	EndingBalance float64       `json:"endingBalance"`
}

// PayBillsRequest pays several bills at once; one bill payment per vendor is created.
type PayBillsRequest struct {
	Date             string        `json:"date"`
	AccountID        int64         `json:"accountId"` // bank or credit card account
	ToBePrinted      bool          `json:"toBePrinted"`
	FirstCheckNumber string        `json:"firstCheckNumber"` // used when not to be printed
	Bills            []PayBillItem `json:"bills"`
}

type PayBillItem struct {
	BillID            int64           `json:"billId"`
	Amount            float64         `json:"amount"`
	Discount          float64         `json:"discount"`
	DiscountAccountID *int64          `json:"discountAccountId"`
	Credits           []PayBillCredit `json:"credits"`
}

type PayBillCredit struct {
	CreditID int64   `json:"creditId"`
	Amount   float64 `json:"amount"`
}

type PayBillsResult struct {
	Payments []TxnSummary `json:"payments"`
}

// SalesTaxDue is one sales tax item's liability for Pay Sales Tax.
type SalesTaxDue struct {
	TaxItemID   int64   `json:"taxItemId"`
	TaxItemName string  `json:"taxItemName"`
	AgencyID    *int64  `json:"agencyId"`
	AgencyName  string  `json:"agencyName"`
	AmountDue   float64 `json:"amountDue"`
}

// ---------------------------------------------------------------------------
// Company

type CompanyInfo struct {
	Name                 string `json:"name"`
	LegalName            string `json:"legalName"`
	Address1             string `json:"address1"`
	Address2             string `json:"address2"`
	City                 string `json:"city"`
	State                string `json:"state"`
	Zip                  string `json:"zip"`
	Country              string `json:"country"`
	Phone                string `json:"phone"`
	Fax                  string `json:"fax"`
	Email                string `json:"email"`
	Website              string `json:"website"`
	TaxID                string `json:"taxId"`
	Industry             string `json:"industry"`
	EntityType           string `json:"entityType"`
	FiscalYearStartMonth int    `json:"fiscalYearStartMonth"`
	TaxYearStartMonth    int    `json:"taxYearStartMonth"`
	ClosingDate          string `json:"closingDate"`        // (ro here; use the closing date endpoint)
	HasClosingPassword   bool   `json:"hasClosingPassword"` // (ro)
	CreatedAt            string `json:"createdAt"`          // (ro)
	CompanyID            string `json:"companyId"`          // (ro) file id
}

// NewCompanyRequest creates a company file (File > New Company).
type NewCompanyRequest struct {
	Name                  string `json:"name"`
	LegalName             string `json:"legalName"`
	Industry              string `json:"industry"` // template key from GET /api/companies/templates
	EntityType            string `json:"entityType"`
	TaxID                 string `json:"taxId"`
	Address1              string `json:"address1"`
	Address2              string `json:"address2"`
	City                  string `json:"city"`
	State                 string `json:"state"`
	Zip                   string `json:"zip"`
	Country               string `json:"country"`
	Phone                 string `json:"phone"`
	Email                 string `json:"email"`
	Website               string `json:"website"`
	FiscalYearStartMonth  int    `json:"fiscalYearStartMonth"`
	AdminPassword         string `json:"adminPassword"`
	CreateDefaultAccounts bool   `json:"createDefaultAccounts"`
	SalesTaxEnabled       bool   `json:"salesTaxEnabled"`
	InventoryEnabled      bool   `json:"inventoryEnabled"`
}

type IndustryTemplate struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type User struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	IsAdmin     bool   `json:"isAdmin"`
	Active      bool   `json:"active"`
	HasPassword bool   `json:"hasPassword"`        // (ro)
	Password    string `json:"password,omitempty"` // input only; "" keeps the current password on update
}

type AuditRow struct {
	ID        int64          `json:"id"`
	Ts        string         `json:"ts"`
	User      string         `json:"user"`
	Action    string         `json:"action"`
	TxnID     *int64         `json:"txnId"`
	TxnType   string         `json:"txnType"`
	RefNumber string         `json:"refNumber"`
	TxnDate   string         `json:"txnDate"`
	Name      string         `json:"name"`
	Amount    float64        `json:"amount"`
	Details   map[string]any `json:"details"`
}

// ---------------------------------------------------------------------------
// Reports

type ReportColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"` // "text" | "money" | "number" | "date" | "percent"
}

type ReportDrill struct {
	Report string            `json:"report"`
	Params map[string]string `json:"params"`
}

// ReportRow kinds: "section" (group header), "data", "subtotal" (closes a
// section), "total" (major total such as Net Income), "grandtotal", "blank".
type ReportRow struct {
	Kind  string         `json:"kind"`
	Level int            `json:"level"`           // indent level of the first column
	Cells map[string]any `json:"cells"`           // keyed by column key; money as float dollars
	TxnID *int64         `json:"txnId,omitempty"` // drill-down opens this transaction
	Drill *ReportDrill   `json:"drill,omitempty"` // drill-down opens this report
	Group string         `json:"group,omitempty"` // id shared by a section row, its children and its subtotal (collapse)
	// CellDrills: per-column drill-down targets keyed by column key (multi-column
	// reports, e.g. one drill per period/class/customer column). The client uses
	// CellDrills[colKey] when present, else Drill.
	CellDrills map[string]*ReportDrill `json:"cellDrills,omitempty"`
}

type ReportResult struct {
	Key            string            `json:"key"`
	Title          string            `json:"title"`
	CompanyName    string            `json:"companyName"`
	DateRangeLabel string            `json:"dateRangeLabel"` // "January 1 through October 17, 2026" or "As of October 17, 2026"
	Basis          string            `json:"basis"`          // "Accrual Basis" | "Cash Basis" | ""
	Columns        []ReportColumn    `json:"columns"`
	Rows           []ReportRow       `json:"rows"`
	Params         map[string]string `json:"params"` // resolved parameters (from, to, basis, ...)
	GeneratedAt    string            `json:"generatedAt"`
}

type ReportInfo struct {
	Key          string   `json:"key"`
	Title        string   `json:"title"`
	Category     string   `json:"category"`
	Description  string   `json:"description"`
	Params       []string `json:"params"`       // which parameters apply: "dates", "asOf", "basis", "columns", "accountId", "nameId", "itemId", "classId", "filters", "budgetId", "agingInterval"
	DefaultDates string   `json:"defaultDates"` // date preset key (for example "thisMonthToDate")
}

// Statement is the data of one customer statement.
type Statement struct {
	Customer       Name           `json:"customer"`
	BillAddress    string         `json:"billAddress"`
	StatementDate  string         `json:"statementDate"`
	From           string         `json:"from"`
	To             string         `json:"to"`
	OpeningBalance float64        `json:"openingBalance"`
	Rows           []StatementRow `json:"rows"`
	EndingBalance  float64        `json:"endingBalance"`
	Aging          StatementAging `json:"aging"`
	AmountDue      float64        `json:"amountDue"`
}

type StatementRow struct {
	TxnID       int64   `json:"txnId"`
	Date        string  `json:"date"`
	Type        string  `json:"type"`
	RefNumber   string  `json:"refNumber"`
	Description string  `json:"description"`
	DueDate     string  `json:"dueDate"`
	Amount      float64 `json:"amount"`
	Balance     float64 `json:"balance"`
}

type StatementAging struct {
	Current float64 `json:"current"`
	D1_30   float64 `json:"d1_30"`
	D31_60  float64 `json:"d31_60"`
	D61_90  float64 `json:"d61_90"`
	Over90  float64 `json:"over90"`
}

// ---------------------------------------------------------------------------
// Banking: reconcile and bank feeds

type ReconcileEntry struct {
	GLID      int64   `json:"glId"`
	TxnID     int64   `json:"txnId"`
	Type      string  `json:"type"`
	TypeLabel string  `json:"typeLabel"`
	Date      string  `json:"date"`
	RefNumber string  `json:"refNumber"`
	NameFull  string  `json:"nameFull"`
	Memo      string  `json:"memo"`
	Amount    float64 `json:"amount"`  // natural sign for the account: + increases balance (deposit / CC charge), - decreases
	Cleared   string  `json:"cleared"` // "" or "*" (marked, in progress)
}

type ReconcileAdj struct {
	Amount    float64 `json:"amount"`
	Date      string  `json:"date"`
	AccountID *int64  `json:"accountId"`
	ClassID   *int64  `json:"classId"`
}

type ReconcileDraft struct {
	StatementDate string        `json:"statementDate"`
	EndingBalance float64       `json:"endingBalance"`
	ServiceCharge *ReconcileAdj `json:"serviceCharge"`
	Interest      *ReconcileAdj `json:"interest"`
	MarkedGLIDs   []int64       `json:"markedGlIds"`
}

type ReconcileStart struct {
	Account           Account          `json:"account"`
	LastStatementDate string           `json:"lastStatementDate"`
	BeginningBalance  float64          `json:"beginningBalance"`
	Draft             *ReconcileDraft  `json:"draft"`
	Entries           []ReconcileEntry `json:"entries"` // every uncleared entry of the account
	// LastEndingBalance is the ending balance of the last statement (null when
	// never reconciled). When it differs from BeginningBalance, reconciled
	// transactions were changed, unmarked or deleted since (see
	// GET /reconcile/{accountId}/discrepancies).
	LastEndingBalance *float64 `json:"lastEndingBalance"`
}

type ReconcileFinish struct {
	StatementDate string        `json:"statementDate"`
	EndingBalance float64       `json:"endingBalance"`
	ClearedGLIDs  []int64       `json:"clearedGlIds"`
	ServiceCharge *ReconcileAdj `json:"serviceCharge"`
	Interest      *ReconcileAdj `json:"interest"`
	// When the difference is not zero the server refuses unless EnterAdjustment
	// is true, in which case a balance adjustment journal entry (to the Expense
	// account "Reconciliation Discrepancies", created when missing) is entered.
	EnterAdjustment bool `json:"enterAdjustment"`
}

type Reconciliation struct {
	ID               int64   `json:"id"`
	AccountID        int64   `json:"accountId"`
	AccountName      string  `json:"accountName"`
	StatementDate    string  `json:"statementDate"`
	BeginningBalance float64 `json:"beginningBalance"`
	EndingBalance    float64 `json:"endingBalance"`
	ClearedBalance   float64 `json:"clearedBalance"`
	CompletedAt      string  `json:"completedAt"`
	CompletedBy      string  `json:"completedBy"`
}

type ReconcileReport struct {
	Reconciliation  Reconciliation   `json:"reconciliation"`
	Cleared         []ReconcileEntry `json:"cleared"`   // with the amounts as reconciled
	Uncleared       []ReconcileEntry `json:"uncleared"` // dated on/before statement date, not cleared at that reconciliation
	ClearedIncrease float64          `json:"clearedIncrease"`
	ClearedDecrease float64          `json:"clearedDecrease"`
	RegisterBalance float64          `json:"registerBalance"` // as of statement date
	// Changes since reconciliation: reconciled transactions changed, unmarked,
	// voided or deleted after this reconciliation was finished.
	Changes []ReconcileChange `json:"changes"`
}

// ReconcileChange is one reconciled transaction changed after its reconciliation.
type ReconcileChange struct {
	ReconciliationID int64   `json:"reconciliationId"`
	StatementDate    string  `json:"statementDate"`
	TxnID            int64   `json:"txnId"`
	Type             string  `json:"type"`
	TypeLabel        string  `json:"typeLabel"`
	Date             string  `json:"date"`
	RefNumber        string  `json:"refNumber"`
	NameFull         string  `json:"nameFull"`
	ReconciledAmount float64 `json:"reconciledAmount"` // natural sign, as reconciled
	CurrentAmount    float64 `json:"currentAmount"`    // natural sign, still cleared by that reconciliation (0 when unmarked/deleted)
	Change           string  `json:"change"`           // "Amount changed" | "Uncleared" | "Voided" | "Deleted"
	Effect           float64 `json:"effect"`           // CurrentAmount - ReconciledAmount: change of the reconciled balance
}

// ReconcileDiscrepancies is the Previous Reconciliation Discrepancy report of an account.
type ReconcileDiscrepancies struct {
	AccountID         int64             `json:"accountId"`
	AccountName       string            `json:"accountName"`
	LastStatementDate string            `json:"lastStatementDate"`
	LastEndingBalance float64           `json:"lastEndingBalance"`
	BeginningBalance  float64           `json:"beginningBalance"` // what the next reconciliation starts from
	Difference        float64           `json:"difference"`       // BeginningBalance - LastEndingBalance
	Changes           []ReconcileChange `json:"changes"`
}

type BankFeedMatch struct {
	TxnID     int64   `json:"txnId"`
	Type      string  `json:"type"`
	TypeLabel string  `json:"typeLabel"`
	Date      string  `json:"date"`
	RefNumber string  `json:"refNumber"`
	NameFull  string  `json:"nameFull"`
	Amount    float64 `json:"amount"`
}

type BankFeedItem struct {
	ID          int64   `json:"id"`
	AccountID   int64   `json:"accountId"`
	Date        string  `json:"date"`
	Description string  `json:"description"`
	Amount      float64 `json:"amount"` // + money in (deposit / CC payment), - money out
	CheckNumber string  `json:"checkNumber"`
	Status      string  `json:"status"` // "new" | "added" | "matched" | "ignored"
	TxnID       *int64  `json:"txnId"`
	// (ro) suggestions
	Matches            []BankFeedMatch `json:"matches"`
	SuggestedNameID    *int64          `json:"suggestedNameId"`
	SuggestedAccountID *int64          `json:"suggestedAccountId"`
	SuggestedPayee     string          `json:"suggestedPayee"`
}

type BankFeedAdd struct {
	NameID    *int64 `json:"nameId"`
	AccountID int64  `json:"accountId"` // expense / income / other account for the other side
	Memo      string `json:"memo"`
	ClassID   *int64 `json:"classId"`
	RefNumber string `json:"refNumber"`
}

type BankFeedImportResult struct {
	Imported int    `json:"imported"`
	Skipped  int    `json:"skipped"` // duplicates
	BatchID  string `json:"batchId"`
	Format   string `json:"format"` // "ofx" | "csv"
	// Invalid rows (date or amount could not be read) were not imported;
	// Problems lists the first 20 with the reason.
	Invalid   int               `json:"invalid"`
	Problems  []BankFeedProblem `json:"problems"`
	DateOrder string            `json:"dateOrder,omitempty"` // CSV: "mdy" | "dmy", how dates were read
	FlipSigns bool              `json:"flipSigns"`           // CSV amounts were imported with the sign reversed
}

// BankFeedProblem is one unreadable row of an imported bank file.
type BankFeedProblem struct {
	Row    int    `json:"row"` // CSV line number, or OFX transaction number
	Reason string `json:"reason"`
}

type BankRule struct {
	ID              int64  `json:"id"`
	Name            string `json:"name"`
	AccountID       *int64 `json:"accountId"` // bank/CC account the rule applies to (null = all)
	MatchText       string `json:"matchText"` // description contains (case-insensitive)
	Direction       string `json:"direction"` // "any" | "in" | "out"
	RenameTo        string `json:"renameTo"`
	NameID          *int64 `json:"nameId"`
	TargetAccountID *int64 `json:"targetAccountId"`
	Priority        int    `json:"priority"`
}

// ---------------------------------------------------------------------------
// Memorized transactions / reports, budgets, to dos, reminders

type MemorizedTxn struct {
	ID            int64   `json:"id"`
	Name          string  `json:"name"`
	TxnType       string  `json:"txnType"`
	Template      Txn     `json:"template"`  // id/ref/date are ignored when used
	Schedule      string  `json:"schedule"`  // "none" | "remind" | "auto"
	Frequency     string  `json:"frequency"` // "never" | "daily" | "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "semiannually" | "annually"
	NextDate      string  `json:"nextDate"`
	DaysInAdvance int     `json:"daysInAdvance"`
	Remaining     *int    `json:"remaining"`
	GroupName     string  `json:"groupName"`
	Amount        float64 `json:"amount"` // (ro) template total
}

type MemorizedReport struct {
	ID        int64             `json:"id"`
	Name      string            `json:"name"`
	ReportKey string            `json:"reportKey"`
	Params    map[string]string `json:"params"`
	GroupName string            `json:"groupName"`
}

type BudgetLine struct {
	AccountID int64       `json:"accountId"`
	ClassID   *int64      `json:"classId"`
	NameID    *int64      `json:"nameId"`
	Amounts   [12]float64 `json:"amounts"` // fiscal months 1..12
}

type Budget struct {
	ID         int64        `json:"id"`
	Name       string       `json:"name"`
	FiscalYear int          `json:"fiscalYear"` // year the fiscal year starts in
	Kind       string       `json:"kind"`       // "pl" | "bs"
	Criteria   string       `json:"criteria"`   // "none" | "class" | "customer"
	Lines      []BudgetLine `json:"lines"`
}

type Todo struct {
	ID      int64  `json:"id"`
	Title   string `json:"title"`
	Notes   string `json:"notes"`
	DueDate string `json:"dueDate"`
	NameID  *int64 `json:"nameId"`
	Done    bool   `json:"done"`
}

type ReminderItem struct {
	Label       string  `json:"label"`
	Date        string  `json:"date"`
	Amount      float64 `json:"amount"`
	TxnID       *int64  `json:"txnId"`
	ItemID      *int64  `json:"itemId"`
	MemorizedID *int64  `json:"memorizedId"`
	Note        string  `json:"note,omitempty"` // e.g. an automatic memorized transaction that could not be entered
}

type ReminderGroup struct {
	Key   string         `json:"key"` // "overdue_invoices" | "bills_to_pay" | "checks_to_print" | "invoices_to_print" | "money_to_deposit" | "inventory_to_reorder" | "memorized_due" | "purchase_orders" | "todos" | "sales_tax_due"
	Label string         `json:"label"`
	Total float64        `json:"total"`
	Items []ReminderItem `json:"items"`
}
