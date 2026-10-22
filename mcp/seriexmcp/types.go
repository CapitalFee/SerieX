package seriexmcp

// JSON shapes of the SerieX Books and Payroll APIs (only the fields these
// tools use; see server/internal/model/model.go and payroll/server/internal/model).

type companyInfo struct {
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
	Website              string `json:"website"`
	Industry             string `json:"industry"`
	EntityType           string `json:"entityType"`
	FiscalYearStartMonth int    `json:"fiscalYearStartMonth"`
	TaxYearStartMonth    int    `json:"taxYearStartMonth"`
	ClosingDate          string `json:"closingDate"`
	HasClosingPassword   bool   `json:"hasClosingPassword"`
	CompanyID            string `json:"companyId"`
}

type prefs struct {
	UseAccountNumbers           bool   `json:"useAccountNumbers"`
	UseClassTracking            bool   `json:"useClassTracking"`
	BillsDueDays                int    `json:"billsDueDays"`
	DefaultCheckAccountID       *int64 `json:"defaultCheckAccountId"`
	DefaultBillPayAccountID     *int64 `json:"defaultBillPayAccountId"`
	DefaultDepositAccountID     *int64 `json:"defaultDepositAccountId"`
	InventoryEnabled            bool   `json:"inventoryEnabled"`
	PurchaseOrdersEnabled       bool   `json:"purchaseOrdersEnabled"`
	ReportBasis                 string `json:"reportBasis"`
	AgingFrom                   string `json:"agingFrom"`
	EstimatesEnabled            bool   `json:"estimatesEnabled"`
	UseUndepositedFunds         bool   `json:"useUndepositedFunds"`
	SalesTaxEnabled             bool   `json:"salesTaxEnabled"`
	DefaultSalesTaxItemID       *int64 `json:"defaultSalesTaxItemId"`
	SalesTaxBasis               string `json:"salesTaxBasis"`
	SalesTaxFrequency           string `json:"salesTaxFrequency"`
	DatePastWarnDays            int    `json:"datePastWarnDays"`
	DateFutureWarnDays          int    `json:"dateFutureWarnDays"`
	WarnDuplicateCheckNumbers   bool   `json:"warnDuplicateCheckNumbers"`
	WarnDuplicateInvoiceNumbers bool   `json:"warnDuplicateInvoiceNumbers"`
}

type account struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Number      string  `json:"number"`
	Type        string  `json:"type"`
	FullName    string  `json:"fullName"`
	Description string  `json:"description"`
	Special     string  `json:"special"`
	Active      bool    `json:"active"`
	Balance     float64 `json:"balance"`
}

type address struct {
	Line1   string `json:"line1"`
	Line2   string `json:"line2"`
	Line3   string `json:"line3"`
	City    string `json:"city"`
	State   string `json:"state"`
	Zip     string `json:"zip"`
	Country string `json:"country"`
}

type name struct {
	ID             int64    `json:"id"`
	Kind           string   `json:"kind"`
	Name           string   `json:"name"`
	ParentID       *int64   `json:"parentId"`
	FullName       string   `json:"fullName"`
	CompanyName    string   `json:"companyName"`
	Salutation     string   `json:"salutation"`
	FirstName      string   `json:"firstName"`
	MiddleName     string   `json:"middleName"`
	LastName       string   `json:"lastName"`
	Phone          string   `json:"phone"`
	Mobile         string   `json:"mobile"`
	Email          string   `json:"email"`
	BillAddress    address  `json:"billAddress"`
	ShipAddress    address  `json:"shipAddress"`
	AccountNo      string   `json:"accountNumber"`
	TermsID        *int64   `json:"termsId"`
	CreditLimit    *float64 `json:"creditLimit"`
	Taxable        bool     `json:"taxable"`
	TaxItemID      *int64   `json:"taxItemId"`
	PayMethodID    *int64   `json:"paymentMethodId"`
	RepID          *int64   `json:"repId"`
	PrintOnCheckAs string   `json:"printOnCheckAs"`
	Is1099         bool     `json:"is1099"`
	JobStatus      string   `json:"jobStatus"`
	Notes          string   `json:"notes"`
	Active         bool     `json:"active"`
	Balance        float64  `json:"balance"`
}

type item struct {
	ID               int64   `json:"id"`
	Type             string  `json:"type"`
	Name             string  `json:"name"`
	FullName         string  `json:"fullName"`
	Description      string  `json:"description"`
	PurchaseDesc     string  `json:"purchaseDescription"`
	SalesPrice       float64 `json:"salesPrice"`
	RateIsPercent    bool    `json:"rateIsPercent"`
	Cost             float64 `json:"cost"`
	IncomeAccountID  *int64  `json:"incomeAccountId"`
	ExpenseAccountID *int64  `json:"expenseAccountId"`
	AssetAccountID   *int64  `json:"assetAccountId"`
	IsPurchased      bool    `json:"isPurchased"`
	Taxable          bool    `json:"taxable"`
	QtyOnHand        float64 `json:"qtyOnHand"`
	TaxRate          float64 `json:"taxRate"`
	Active           bool    `json:"active"`
	GroupLines       []struct {
		ItemID int64   `json:"itemId"`
		Qty    float64 `json:"qty"`
	} `json:"groupLines"`
}

type listEntry struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Active   bool   `json:"active"`
}

type txnLine struct {
	ID              int64    `json:"id,omitempty"`
	Kind            string   `json:"kind,omitempty"`
	ItemID          *int64   `json:"itemId"`
	AccountID       *int64   `json:"accountId"`
	Description     string   `json:"description"`
	Qty             *float64 `json:"qty"`
	Rate            *float64 `json:"rate"`
	RateIsPercent   bool     `json:"rateIsPercent"`
	Amount          float64  `json:"amount"`
	ClassID         *int64   `json:"classId"`
	NameID          *int64   `json:"nameId"`
	Billable        bool     `json:"billable"`
	Taxable         bool     `json:"taxable"`
	PaymentMethodID *int64   `json:"paymentMethodId"`
	RefNumber       string   `json:"refNumber"`
	LinkedTxnID     *int64   `json:"linkedTxnId"`
	LinkedLineID    *int64   `json:"linkedLineId"`
}

type txnLink struct {
	FromTxnID     *int64  `json:"fromTxnId"`
	ToTxnID       int64   `json:"toTxnId"`
	Amount        float64 `json:"amount"`
	Discount      float64 `json:"discount"`
	DiscAccountID *int64  `json:"discountAccountId,omitempty"`
	FromType      string  `json:"fromType,omitempty"`
	FromRefNumber string  `json:"fromRefNumber,omitempty"`
	FromDate      string  `json:"fromDate,omitempty"`
	ToType        string  `json:"toType,omitempty"`
	ToRefNumber   string  `json:"toRefNumber,omitempty"`
	ToDate        string  `json:"toDate,omitempty"`
}

type linkedTxn struct {
	TxnID     int64   `json:"txnId"`
	TypeLabel string  `json:"typeLabel"`
	Date      string  `json:"date"`
	RefNumber string  `json:"refNumber"`
	Amount    float64 `json:"amount"`
	Relation  string  `json:"relation"`
}

// txn is a full transaction (GET /txns/{id}; also the body of POST /txns).
type txn struct {
	ID              int64          `json:"id"`
	Type            string         `json:"type"`
	RefNumber       string         `json:"refNumber"`
	Date            string         `json:"date"`
	NameID          *int64         `json:"nameId"`
	NameFull        string         `json:"nameFull,omitempty"`
	AccountID       *int64         `json:"accountId"`
	ArApAccountID   *int64         `json:"arApAccountId"`
	ToAccountID     *int64         `json:"toAccountId"`
	Amount          float64        `json:"amount"`
	OpenBalance     float64        `json:"openBalance"`
	Subtotal        float64        `json:"subtotal"`
	DueDate         string         `json:"dueDate"`
	TermsID         *int64         `json:"termsId"`
	ClassID         *int64         `json:"classId"`
	PaymentMethodID *int64         `json:"paymentMethodId"`
	RepID           *int64         `json:"repId"`
	PONumber        string         `json:"poNumber"`
	Memo            string         `json:"memo"`
	BillAddress     string         `json:"billAddress"`
	ShipAddress     string         `json:"shipAddress"`
	TaxItemID       *int64         `json:"taxItemId"`
	TaxRate         float64        `json:"taxRate"`
	TaxAmount       float64        `json:"taxAmount"`
	ToBePrinted     bool           `json:"toBePrinted"`
	IsPending       bool           `json:"isPending"`
	Status          string         `json:"status"`
	Voided          bool           `json:"voided"`
	Lines           []txnLine      `json:"lines"`
	Links           []txnLink      `json:"links"`
	Linked          []linkedTxn    `json:"linked,omitempty"`
	Extra           map[string]any `json:"extra,omitempty"`
	Cleared         string         `json:"cleared,omitempty"`
	CreatedBy       string         `json:"createdBy,omitempty"`
	CreatedAt       string         `json:"createdAt,omitempty"`
	UpdatedAt       string         `json:"updatedAt,omitempty"`
}

type txnSummary struct {
	ID          int64   `json:"id"`
	Type        string  `json:"type"`
	TypeLabel   string  `json:"typeLabel"`
	RefNumber   string  `json:"refNumber"`
	Date        string  `json:"date"`
	DueDate     string  `json:"dueDate"`
	NameFull    string  `json:"nameFull"`
	AccountName string  `json:"accountName"`
	Amount      float64 `json:"amount"`
	OpenBalance float64 `json:"openBalance"`
	Memo        string  `json:"memo"`
	Status      string  `json:"status"`
	Voided      bool    `json:"voided"`
	IsPending   bool    `json:"isPending"`
}

type txnList struct {
	Rows  []txnSummary `json:"rows"`
	Total int          `json:"total"`
}

type openDoc struct {
	TxnID         int64   `json:"txnId"`
	Type          string  `json:"type"`
	TypeLabel     string  `json:"typeLabel"`
	Date          string  `json:"date"`
	DueDate       string  `json:"dueDate"`
	RefNumber     string  `json:"refNumber"`
	NameID        int64   `json:"nameId"`
	NameFull      string  `json:"nameFull"`
	Amount        float64 `json:"amount"`
	OpenBalance   float64 `json:"openBalance"`
	Memo          string  `json:"memo"`
	ArApAccountID int64   `json:"arApAccountId"`
}

type openDocs struct {
	Charges []openDoc `json:"charges"`
	Credits []openDoc `json:"credits"`
}

type undepositedItem struct {
	TxnID             int64   `json:"txnId"`
	TypeLabel         string  `json:"typeLabel"`
	Date              string  `json:"date"`
	RefNumber         string  `json:"refNumber"`
	NameFull          string  `json:"nameFull"`
	PaymentMethodName string  `json:"paymentMethodName"`
	Amount            float64 `json:"amount"`
	Memo              string  `json:"memo"`
	LineID            *int64  `json:"lineId"`
	CheckNumber       string  `json:"checkNumber"`
}

type registerRow struct {
	TxnID        int64   `json:"txnId"`
	Date         string  `json:"date"`
	RefNumber    string  `json:"refNumber"`
	TypeAbbrev   string  `json:"typeAbbrev"`
	NameFull     string  `json:"nameFull"`
	OtherAccount string  `json:"otherAccount"`
	Memo         string  `json:"memo"`
	Increase     float64 `json:"increase"`
	Decrease     float64 `json:"decrease"`
	Cleared      string  `json:"cleared"`
	Balance      float64 `json:"balance"`
	Voided       bool    `json:"voided"`
}

type registerResult struct {
	Account       account       `json:"account"`
	IncreaseLabel string        `json:"increaseLabel"`
	DecreaseLabel string        `json:"decreaseLabel"`
	Rows          []registerRow `json:"rows"`
	EndingBalance float64       `json:"endingBalance"`
}

type nameSummary struct {
	OpenBalance   float64  `json:"openBalance"`
	Overdue       float64  `json:"overdue"`
	UnbilledCosts float64  `json:"unbilledCosts"`
	OpenEstimates int      `json:"openEstimates"`
	OpenPOs       int      `json:"openPOs"`
	CreditLimit   *float64 `json:"creditLimit"`
	LastPayment   *struct {
		Date   string  `json:"date"`
		Amount float64 `json:"amount"`
	} `json:"lastPayment"`
}

type salesTaxDue struct {
	TaxItemName string  `json:"taxItemName"`
	AgencyName  string  `json:"agencyName"`
	AmountDue   float64 `json:"amountDue"`
}

type reminderGroup struct {
	Key   string  `json:"key"`
	Label string  `json:"label"`
	Total float64 `json:"total"`
	Items []struct {
		Label  string  `json:"label"`
		Date   string  `json:"date"`
		Amount float64 `json:"amount"`
		TxnID  *int64  `json:"txnId"`
		Note   string  `json:"note"`
	} `json:"items"`
}

type reportInfo struct {
	Key          string   `json:"key"`
	Title        string   `json:"title"`
	Category     string   `json:"category"`
	Description  string   `json:"description"`
	Params       []string `json:"params"`
	DefaultDates string   `json:"defaultDates"`
}

type reportColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

type reportRow struct {
	Kind  string         `json:"kind"`
	Level int            `json:"level"`
	Cells map[string]any `json:"cells"`
	TxnID *int64         `json:"txnId"`
}

type reportResult struct {
	Key            string         `json:"key"`
	Title          string         `json:"title"`
	CompanyName    string         `json:"companyName"`
	DateRangeLabel string         `json:"dateRangeLabel"`
	Basis          string         `json:"basis"`
	Columns        []reportColumn `json:"columns"`
	Rows           []reportRow    `json:"rows"`
}

type payBillsResult struct {
	Payments []txnSummary `json:"payments"`
}

// Payroll

type employee struct {
	ID              int64   `json:"id"`
	DisplayName     string  `json:"displayName"`
	EmployeeNumber  string  `json:"employeeNumber"`
	HireDate        string  `json:"hireDate"`
	ReleaseDate     string  `json:"releaseDate"`
	EmploymentType  string  `json:"employmentType"`
	PayFrequency    string  `json:"payFrequency"`
	PayScheduleName string  `json:"payScheduleName"`
	WorkState       string  `json:"workState"`
	HourlyRate      float64 `json:"hourlyRate"`
	AnnualSalary    float64 `json:"annualSalary"`
	YTDGross        float64 `json:"ytdGross"`
	LastCheckDate   string  `json:"lastCheckDate"`
	Active          bool    `json:"active"`
}

type paycheckSummary struct {
	ID            int64   `json:"id"`
	Kind          string  `json:"kind"`
	EmployeeName  string  `json:"employeeName"`
	PeriodStart   string  `json:"periodStart"`
	PeriodEnd     string  `json:"periodEnd"`
	CheckDate     string  `json:"checkDate"`
	CheckNumber   string  `json:"checkNumber"`
	DirectDeposit bool    `json:"directDeposit"`
	Gross         float64 `json:"gross"`
	EmployeeTaxes float64 `json:"employeeTaxes"`
	Deductions    float64 `json:"deductions"`
	Net           float64 `json:"net"`
	EmployerTaxes float64 `json:"employerTaxes"`
	Contributions float64 `json:"contributions"`
	TotalHours    float64 `json:"totalHours"`
	Voided        bool    `json:"voided"`
	SyncStatus    string  `json:"syncStatus"`
}

type liabilityDue struct {
	Label       string  `json:"label"`
	AgencyName  string  `json:"agencyName"`
	PeriodStart string  `json:"periodStart"`
	PeriodEnd   string  `json:"periodEnd"`
	DueDate     string  `json:"dueDate"`
	Status      string  `json:"status"`
	Frequency   string  `json:"frequency"`
	Method      string  `json:"method"`
	AmountDue   float64 `json:"amountDue"`
}
