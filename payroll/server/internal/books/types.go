package books

// JSON types of the SerieX Books API (copied from SerieX Books
// server/internal/model/model.go; only the fields payroll uses are relied on,
// unknown fields are ignored when decoding).

// Account types and transaction types used by payroll.
const (
	AcctBank         = "Bank"
	AcctOCA          = "Other Current Asset"
	AcctCC           = "Credit Card"
	AcctOCL          = "Other Current Liability"
	AcctExpense      = "Expense"
	AcctOtherExpense = "Other Expense"
	AcctEquity       = "Equity"

	TxCheck   = "CHK"
	TxJournal = "GENJRNL"

	LineExpense = "expense"
	LineJournal = "je"

	NameCustomer = "customer"
	NameVendor   = "vendor"
	NameOther    = "other"
)

type CompanyFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	FileName string `json:"fileName"`
	Modified string `json:"modified"`
}

type AuthInfo struct {
	Required bool     `json:"required"`
	Users    []string `json:"users"`
}

type LoginResult struct {
	Token string `json:"token"`
	User  string `json:"user"`
}

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
	Email                string `json:"email"`
	TaxID                string `json:"taxId"`
	FiscalYearStartMonth int    `json:"fiscalYearStartMonth"`
	ClosingDate          string `json:"closingDate"`
	CompanyID            string `json:"companyId"`
}

type User struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	IsAdmin     bool   `json:"isAdmin"`
	Active      bool   `json:"active"`
	HasPassword bool   `json:"hasPassword"`
}

type Account struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Number      string  `json:"number"`
	Type        string  `json:"type"`
	ParentID    *int64  `json:"parentId"`
	FullName    string  `json:"fullName"`
	Level       int     `json:"level"`
	Description string  `json:"description"`
	Special     string  `json:"special"`
	Active      bool    `json:"active"`
	Balance     float64 `json:"balance"`
	OwnBalance  float64 `json:"ownBalance"`
}

type Address struct {
	Line1   string `json:"line1"`
	Line2   string `json:"line2"`
	Line3   string `json:"line3"`
	City    string `json:"city"`
	State   string `json:"state"`
	Zip     string `json:"zip"`
	Country string `json:"country"`
}

// Name is a SerieX Books customer/job, vendor or other name. Fields payroll
// does not manage are kept as received (UpdateName sends back the full record
// it read, so Books fields the payroll app does not know are preserved).
type Name struct {
	ID                int64    `json:"id"`
	Kind              string   `json:"kind"`
	Name              string   `json:"name"`
	ParentID          *int64   `json:"parentId"`
	FullName          string   `json:"fullName"`
	Level             int      `json:"level"`
	CompanyName       string   `json:"companyName"`
	Salutation        string   `json:"salutation"`
	FirstName         string   `json:"firstName"`
	MiddleName        string   `json:"middleName"`
	LastName          string   `json:"lastName"`
	JobTitle          string   `json:"jobTitle"`
	Phone             string   `json:"phone"`
	AltPhone          string   `json:"altPhone"`
	Mobile            string   `json:"mobile"`
	Fax               string   `json:"fax"`
	Email             string   `json:"email"`
	CcEmail           string   `json:"ccEmail"`
	Website           string   `json:"website"`
	BillAddress       Address  `json:"billAddress"`
	ShipAddress       Address  `json:"shipAddress"`
	AccountNumber     string   `json:"accountNumber"`
	TermsID           *int64   `json:"termsId"`
	CreditLimit       *float64 `json:"creditLimit"`
	TypeID            *int64   `json:"typeId"`
	RepID             *int64   `json:"repId"`
	PaymentMethodID   *int64   `json:"paymentMethodId"`
	Taxable           bool     `json:"taxable"`
	TaxItemID         *int64   `json:"taxItemId"`
	ResaleNumber      string   `json:"resaleNumber"`
	PrintOnCheckAs    string   `json:"printOnCheckAs"`
	TaxIdent          string   `json:"taxIdent"`
	Is1099            bool     `json:"is1099"`
	PrefillAccountIDs []int64  `json:"prefillAccountIds"`
	JobStatus         string   `json:"jobStatus"`
	JobStartDate      string   `json:"jobStartDate"`
	JobProjectedEnd   string   `json:"jobProjectedEnd"`
	JobEndDate        string   `json:"jobEndDate"`
	JobDescription    string   `json:"jobDescription"`
	JobTypeID         *int64   `json:"jobTypeId"`
	Notes             string   `json:"notes"`
	Active            bool     `json:"active"`
	Balance           float64  `json:"balance"`
	HasTxns           bool     `json:"hasTxns"`
}

type ListEntry struct {
	ID       int64  `json:"id"`
	List     string `json:"list"`
	Name     string `json:"name"`
	ParentID *int64 `json:"parentId"`
	FullName string `json:"fullName"`
	Level    int    `json:"level"`
	Active   bool   `json:"active"`
}

type TxnLine struct {
	ID          int64    `json:"id,omitempty"`
	Seq         int      `json:"seq"`
	Kind        string   `json:"kind"`
	ItemID      *int64   `json:"itemId"`
	AccountID   *int64   `json:"accountId"`
	Description string   `json:"description"`
	Qty         *float64 `json:"qty"`
	Rate        *float64 `json:"rate"`
	Amount      float64  `json:"amount"`
	ClassID     *int64   `json:"classId"`
	NameID      *int64   `json:"nameId"`
	Billable    bool     `json:"billable"`
}

type Txn struct {
	ID          int64          `json:"id"`
	Type        string         `json:"type"`
	RefNumber   string         `json:"refNumber"`
	Date        string         `json:"date"`
	NameID      *int64         `json:"nameId"`
	NameFull    string         `json:"nameFull"`
	AccountID   *int64         `json:"accountId"`
	Amount      float64        `json:"amount"`
	ClassID     *int64         `json:"classId"`
	Memo        string         `json:"memo"`
	BillAddress string         `json:"billAddress"` // multi-line snapshot (a check's ADDRESS box)
	ToBePrinted bool           `json:"toBePrinted"`
	Voided      bool           `json:"voided"`
	Extra       map[string]any `json:"extra"`
	Lines       []TxnLine      `json:"lines"`
	Links       []any          `json:"links"`
	Cleared     string         `json:"cleared"`
	CreatedBy   string         `json:"createdBy"`
	UpdatedAt   string         `json:"updatedAt"`
}
