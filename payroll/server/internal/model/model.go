// Package model holds the JSON types shared by the payroll server and its
// web client (web/src/api/types.ts mirrors it field for field).
//
// Same conventions as SerieX Books: money is sent as dollars (float64, 2
// decimals) and stored as integer cents (store.Cents / store.Dollars); dates
// are "YYYY-MM-DD"; optional ids are *int64 (JSON null when absent); fields
// marked (ro) are computed by the server and ignored on input. Ids named
// *AccountID, *VendorID, ClassID, JobNameID and BooksNameID refer to records
// of the linked SerieX Books company file.
package model

// ---------------------------------------------------------------------------
// Pay frequencies

const (
	FreqDaily        = "daily"
	FreqWeekly       = "weekly"
	FreqBiweekly     = "biweekly"
	FreqSemimonthly  = "semimonthly"
	FreqMonthly      = "monthly"
	FreqQuarterly    = "quarterly"
	FreqSemiannually = "semiannually"
	FreqAnnually     = "annually"
)

// PayPeriods is the number of pay periods per year (IRS Pub 15-T Table 3).
var PayPeriods = map[string]int{
	FreqDaily: 260, FreqWeekly: 52, FreqBiweekly: 26, FreqSemimonthly: 24,
	FreqMonthly: 12, FreqQuarterly: 4, FreqSemiannually: 2, FreqAnnually: 1,
}

var FrequencyLabels = map[string]string{
	FreqDaily: "Daily", FreqWeekly: "Weekly", FreqBiweekly: "Biweekly", FreqSemimonthly: "Semimonthly",
	FreqMonthly: "Monthly", FreqQuarterly: "Quarterly", FreqSemiannually: "Semiannually", FreqAnnually: "Annually",
}

// ---------------------------------------------------------------------------
// Payroll item types

const (
	ItemHourly       = "hourly"        // Hourly wage: rate per hour (employee rate)
	ItemOvertime     = "overtime"      // Hourly overtime: Rate is the multiplier (1.5, 2) of the employee's regular hourly rate
	ItemSalary       = "salary"        // Salary: annual amount spread over the pay periods
	ItemBonus        = "bonus"         // Bonus: amount per paycheck
	ItemCommission   = "commission"    // Commission: Calc quantity (Rate % x sales entered as quantity) or fixed amount
	ItemTips         = "tips"          // Paid tips: paid through payroll
	ItemReportedTips = "reported_tips" // Tips received directly: taxed, not paid in the check (not_paid)
	ItemAddition     = "addition"      // Additions to net pay (reimbursements, allowances); taxability per item
	ItemDeduction    = "deduction"     // Deductions; pre-tax for the wage bases marked in Taxability
	ItemContribution = "contribution"  // Company contributions (expense + liability, not in net pay)
	ItemFederalTax   = "federal_tax"
	ItemStateTax     = "state_tax"
	ItemOtherTax     = "other_tax" // local taxes: percent of LOCAL wages, employee or employer
)

// ItemTypeOrder is the sort order of the Payroll Items window.
var ItemTypeOrder = []string{
	ItemSalary, ItemHourly, ItemOvertime, ItemBonus, ItemCommission, ItemTips, ItemReportedTips,
	ItemAddition, ItemDeduction, ItemContribution, ItemFederalTax, ItemStateTax, ItemOtherTax,
}

var ItemTypeLabels = map[string]string{
	ItemHourly: "Hourly Wage", ItemOvertime: "Hourly Overtime", ItemSalary: "Yearly Salary", ItemBonus: "Bonus",
	ItemCommission: "Commission", ItemTips: "Paid Tips", ItemReportedTips: "Reported Tips", ItemAddition: "Addition",
	ItemDeduction: "Deduction", ItemContribution: "Company Contribution", ItemFederalTax: "Federal Tax",
	ItemStateTax: "State Tax", ItemOtherTax: "Other Tax",
}

// IsWageType: items that are earnings (wages) on the paycheck.
func IsWageType(t string) bool {
	switch t {
	case ItemHourly, ItemOvertime, ItemSalary, ItemBonus, ItemCommission, ItemTips, ItemReportedTips:
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Tax codes (tax items) and wage bases

const (
	TaxFIT     = "FIT"      // Federal Withholding
	TaxSSEE    = "SS_EE"    // Social Security, employee share
	TaxSSER    = "SS_ER"    // Social Security, company share
	TaxMedEE   = "MED_EE"   // Medicare, employee share
	TaxMedER   = "MED_ER"   // Medicare, company share
	TaxAddlMed = "ADDL_MED" // Additional Medicare (employee, wages over the threshold)
	TaxFUTA    = "FUTA"     // Federal Unemployment
	TaxSIT     = "SIT"      // State Withholding
	TaxSUIER   = "SUI_ER"   // State Unemployment, company
	TaxSUIEE   = "SUI_EE"   // State Unemployment, employee (AK, NJ, PA)
	TaxStateEE = "ST_EE"    // other state employee tax (SDI, paid family leave...); program = TaxKey
	TaxStateER = "ST_ER"    // other state employer tax (training tax, workforce fund...); program = TaxKey
	TaxLocalEE = "LOCAL_EE" // local income tax, employee
	TaxLocalER = "LOCAL_ER" // local tax, employer
)

// TaxCodeLabels are the default payroll item names.
var TaxCodeLabels = map[string]string{
	TaxFIT: "Federal Withholding", TaxSSEE: "Social Security (employee)", TaxSSER: "Social Security (company)",
	TaxMedEE: "Medicare (employee)", TaxMedER: "Medicare (company)", TaxAddlMed: "Additional Medicare (employee)",
	TaxFUTA: "Federal Unemployment", TaxSIT: "State Withholding", TaxSUIER: "State Unemployment (company)",
	TaxSUIEE: "State Unemployment (employee)", TaxStateEE: "State Employee Tax", TaxStateER: "State Employer Tax",
	TaxLocalEE: "Local Income Tax", TaxLocalER: "Local Employer Tax",
}

// IsEmployerTax: taxes paid by the company (expense + liability) rather than withheld.
func IsEmployerTax(code string) bool {
	switch code {
	case TaxSSER, TaxMedER, TaxFUTA, TaxSUIER, TaxStateER, TaxLocalER:
		return true
	}
	return false
}

// Wage base keys (taxability). An earning/addition/contribution item with
// Taxability[key] = true counts as wages for that base; a deduction item with
// Taxability[key] = true is pre-tax for that base (reduces it).
const (
	BaseFIT   = "FIT"
	BaseSS    = "SS"
	BaseMED   = "MED"
	BaseFUTA  = "FUTA"
	BaseSIT   = "SIT"
	BaseSUI   = "SUI"
	BaseSDI   = "SDI" // other state employee/employer programs
	BaseLOCAL = "LOCAL"
)

var WageBases = []string{BaseFIT, BaseSS, BaseMED, BaseFUTA, BaseSIT, BaseSUI, BaseSDI, BaseLOCAL}

// TaxBase returns the wage base a tax code is computed on.
func TaxBase(code string) string {
	switch code {
	case TaxFIT:
		return BaseFIT
	case TaxSSEE, TaxSSER:
		return BaseSS
	case TaxMedEE, TaxMedER, TaxAddlMed:
		return BaseMED
	case TaxFUTA:
		return BaseFUTA
	case TaxSIT:
		return BaseSIT
	case TaxSUIER, TaxSUIEE:
		return BaseSUI
	case TaxStateEE, TaxStateER:
		return BaseSDI
	case TaxLocalEE, TaxLocalER:
		return BaseLOCAL
	}
	return ""
}

// AllTaxable is the taxability of an ordinary wage item.
func AllTaxable() map[string]bool {
	m := map[string]bool{}
	for _, b := range WageBases {
		m[b] = true
	}
	return m
}

// ---------------------------------------------------------------------------
// Paycheck line categories

const (
	CatEarning      = "earning"
	CatAddition     = "addition"
	CatDeduction    = "deduction"
	CatContribution = "contribution"
	CatEmployeeTax  = "employee_tax"
	CatEmployerTax  = "employer_tax"
)

// ItemCategory returns the paycheck line category of a payroll item.
func ItemCategory(itemType, taxCode string) string {
	switch {
	case IsWageType(itemType):
		return CatEarning
	case itemType == ItemAddition:
		return CatAddition
	case itemType == ItemDeduction:
		return CatDeduction
	case itemType == ItemContribution:
		return CatContribution
	case itemType == ItemFederalTax || itemType == ItemStateTax || itemType == ItemOtherTax:
		if IsEmployerTax(taxCode) {
			return CatEmployerTax
		}
		return CatEmployeeTax
	}
	return ""
}

// ---------------------------------------------------------------------------
// Calculation methods (additions, deductions, contributions, other taxes)

const (
	CalcFixed    = "fixed"    // Rate is dollars per paycheck
	CalcPercent  = "percent"  // Rate is a percent of gross pay
	CalcPerHour  = "per_hour" // Rate x hours worked on the paycheck
	CalcQuantity = "quantity" // Rate x a quantity entered on the paycheck (commission %, miles...)
	CalcMatch    = "match"    // contribution: Rate % of the MatchItemID deduction, up to MatchCapPct % of gross pay
	CalcTax      = "tax"      // tax items: computed by the tax engine (Rate > 0 overrides the table rate for ST_*/LOCAL_*/SUI_ER)
)

// ---------------------------------------------------------------------------
// Tax tracking types (W-2 reporting). The defaults are applied by the item wizard.

const (
	TrackCompensation   = "compensation"
	TrackNone           = "none"               // not reported on W-2 (e.g. mileage reimbursement)
	TrackReportedTips   = "reported_tips"      // W-2 box 7 (and 1, 5)
	TrackPaidTips       = "paid_tips"          // W-2 box 7 (and 1, 5)
	TrackOvertime       = "qualified_overtime" // OBBBA qualified overtime premium (box 12 code TT)
	Track401k           = "401k"               // box 12 D
	Track403b           = "403b"               // box 12 E
	Track457b           = "457b"               // box 12 G
	TrackRoth401k       = "roth_401k"          // box 12 AA
	TrackRoth403b       = "roth_403b"          // box 12 BB
	TrackSimpleIRA      = "simple_ira"         // box 12 S
	Track125            = "section_125"        // pre-tax health premium (cafeteria plan); box 12 DD when health coverage
	TrackHSA            = "hsa"                // box 12 W
	TrackDependentCare  = "dependent_care"     // box 10
	TrackGroupTermLife  = "group_term_life"    // box 12 C
	TrackHealthCoverage = "health_coverage"    // employer-sponsored health coverage cost, box 12 DD (informational)
	TrackFringe         = "fringe"             // taxable fringe benefit (in box 1, 3, 5, 14 optional)
	TrackOther          = "other"
)

// ---------------------------------------------------------------------------
// Payroll items

type PayrollItem struct {
	ID                 int64           `json:"id"`
	Name               string          `json:"name"`
	Type               string          `json:"type"`
	TaxCode            string          `json:"taxCode"` // tax items only
	State              string          `json:"state"`   // state tax items (and state-specific deductions)
	TaxKey             string          `json:"taxKey"`  // ST_EE / ST_ER: state program key from the tax tables ("SDI", "FLI")
	Pto                string          `json:"pto"`     // wage items: "" | "sick" | "vacation" (hours reduce that balance)
	Calc               string          `json:"calc"`
	Rate               float64         `json:"rate"`
	AnnualLimit        *float64        `json:"annualLimit"`
	LimitKind          string          `json:"limitKind"` // "annual" | "one_time"
	MatchItemID        *int64          `json:"matchItemId"`
	MatchCapPct        float64         `json:"matchCapPct"`
	TaxTracking        string          `json:"taxTracking"`
	W2Box12            string          `json:"w2Box12"`
	W2Box14            string          `json:"w2Box14"`
	Taxability         map[string]bool `json:"taxability"`
	Supplemental       bool            `json:"supplemental"` // bonus/commission: federal withholding at the supplemental flat rate
	NotPaid            bool            `json:"notPaid"`      // reported tips
	ExpenseAccountID   *int64          `json:"expenseAccountId"`
	LiabilityAccountID *int64          `json:"liabilityAccountId"`
	AgencyVendorID     *int64          `json:"agencyVendorId"`
	PaymentGroup       string          `json:"paymentGroup"` // "" = DefaultPaymentGroup
	Active             bool            `json:"active"`

	Category             string `json:"category"`             // (ro)
	EffectiveGroup       string `json:"effectiveGroup"`       // (ro) PaymentGroup or the default
	ExpenseAccountName   string `json:"expenseAccountName"`   // (ro) from SerieX Books ("" when Books is unreachable)
	LiabilityAccountName string `json:"liabilityAccountName"` // (ro)
	AgencyName           string `json:"agencyName"`           // (ro)
	HasPaychecks         bool   `json:"hasPaychecks"`         // (ro)
}

// Payment groups: liabilities of the items of one group are paid together and
// share a due date schedule.
//
//	federal_941      FIT, SS_EE, SS_ER, MED_EE, MED_ER, ADDL_MED
//	federal_940      FUTA
//	state_wh:XX      SIT of state XX
//	state_ui:XX      SUI_ER, SUI_EE, ST_EE, ST_ER of state XX
//	vendor:<id>      deductions, contributions, local taxes paid to a Books vendor
//	unassigned       items without an agency
const (
	GroupFederal941 = "federal_941"
	GroupFederal940 = "federal_940"
	GroupUnassigned = "unassigned"
)

// ---------------------------------------------------------------------------
// Pay schedules

type PaySchedule struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	Frequency     string `json:"frequency"`
	NextPeriodEnd string `json:"nextPeriodEnd"`
	NextCheckDate string `json:"nextCheckDate"`
	SemiFirstDay  int    `json:"semiFirstDay"`
	Active        bool   `json:"active"`

	NextPeriodStart string `json:"nextPeriodStart"` // (ro)
	EmployeeCount   int    `json:"employeeCount"`   // (ro) active employees on this schedule
}

// ---------------------------------------------------------------------------
// Employees

type Address struct {
	Line1 string `json:"line1"`
	Line2 string `json:"line2"`
	City  string `json:"city"`
	State string `json:"state"`
	Zip   string `json:"zip"`
}

// W4 is the employee's federal Form W-4.
type W4 struct {
	Version          string  `json:"version"`          // "2020" (2020 or later) | "pre2020" (2019 or earlier)
	FilingStatus     string  `json:"filingStatus"`     // 2020: single | mfj | hoh ; pre2020: single | married | married_single
	Step2            bool    `json:"step2"`            // Step 2(c) checkbox (two jobs)
	Dependents       float64 `json:"dependents"`       // Step 3 total, dollars per year
	OtherIncome      float64 `json:"otherIncome"`      // Step 4(a), per year
	Deductions       float64 `json:"deductions"`       // Step 4(b), per year
	ExtraWithholding float64 `json:"extraWithholding"` // Step 4(c), per pay period (also pre2020 additional withholding)
	Allowances       int     `json:"allowances"`       // pre2020 only
	Exempt           bool    `json:"exempt"`
	NonresidentAlien bool    `json:"nonresidentAlien"`
	ExemptYear       int     `json:"exemptYear"` // year the exemption was claimed (set on save when Exempt turns on; expires Feb 15 of the next year); 0 = unknown
}

// StateW4 is the employee's state withholding certificate.
type StateW4 struct {
	FilingStatus     string         `json:"filingStatus"` // key of the state's statuses in the tax tables
	Allowances       int            `json:"allowances"`
	ExtraWithholding float64        `json:"extraWithholding"` // per pay period
	Exempt           bool           `json:"exempt"`
	Data             map[string]any `json:"data"` // state specific inputs (e.g. {"additionalAllowances": 1})
}

type DirectDeposit struct {
	Enabled     bool   `json:"enabled"`
	BankName    string `json:"bankName"`
	Routing     string `json:"routing"`     // input: full number; output: masked
	Account     string `json:"account"`     // input: full number ("" keeps the stored one); output: masked
	AccountType string `json:"accountType"` // checking | savings
	Clear       bool   `json:"clear"`       // input: true erases the stored bank name and numbers and turns direct deposit off (always false on output)
}

const (
	AccrueNone            = "none"
	AccruePerPaycheck     = "per_paycheck"
	AccruePerHour         = "per_hour"
	AccrueBeginningOfYear = "beginning_of_year"
)

// PTOSettings is the sick or vacation setup of an employee.
type PTOSettings struct {
	Accrual           string   `json:"accrual"`           // none | per_paycheck | per_hour | beginning_of_year
	Hours             float64  `json:"hours"`             // hours accrued per paycheck / per year (beginning_of_year) / per PerHoursWorked
	PerHoursWorked    float64  `json:"perHoursWorked"`    // per_hour: accrue Hours for every PerHoursWorked hours paid
	MaxHours          *float64 `json:"maxHours"`          // cap on available hours (nil = none)
	ResetEachYear     bool     `json:"resetEachYear"`     // unused hours do not carry over
	YearBeginsMonth   int      `json:"yearBeginsMonth"`   // 1-12
	BeginAccruingDate string   `json:"beginAccruingDate"` // "" = hire date

	Available  float64 `json:"available"`  // (ro) hours available today
	AccruedYTD float64 `json:"accruedYtd"` // (ro)
	UsedYTD    float64 `json:"usedYtd"`    // (ro)
}

// EmployeeItem is one default payroll item of an employee.
type EmployeeItem struct {
	ItemID      int64    `json:"itemId"`
	Rate        float64  `json:"rate"`        // hourly rate / annual salary / amount / percent (0 = item default for non-wages)
	AnnualLimit *float64 `json:"annualLimit"` // nil = item limit
	Qty         *float64 `json:"qty"`         // default hours / quantity per paycheck

	ItemName string `json:"itemName"` // (ro)
	ItemType string `json:"itemType"` // (ro)
	Calc     string `json:"calc"`     // (ro)
}

type Employee struct {
	ID             int64   `json:"id"`
	BooksNameID    *int64  `json:"booksNameId"` // (ro) SerieX Books "other" name
	FirstName      string  `json:"firstName"`
	MiddleName     string  `json:"middleName"`
	LastName       string  `json:"lastName"`
	Suffix         string  `json:"suffix"`
	DisplayName    string  `json:"displayName"` // "" on input = "First Last" (or "Last, First" per prefs)
	PrintAs        string  `json:"printAs"`
	SSN            string  `json:"ssn"` // input: digits ("" keeps the stored value); output: masked "XXX-XX-1234"
	BirthDate      string  `json:"birthDate"`
	Gender         string  `json:"gender"`
	Address        Address `json:"address"`
	Phone          string  `json:"phone"`
	Mobile         string  `json:"mobile"`
	Email          string  `json:"email"`
	EmployeeNumber string  `json:"employeeNumber"`

	HireDate         string `json:"hireDate"`
	OriginalHireDate string `json:"originalHireDate"`
	ReleaseDate      string `json:"releaseDate"`
	EmploymentType   string `json:"employmentType"` // regular | officer | statutory | owner

	PayScheduleID *int64         `json:"payScheduleId"`
	PayFrequency  string         `json:"payFrequency"`
	ClassID       *int64         `json:"classId"`
	WorkState     string         `json:"workState"`
	Earnings      []EmployeeItem `json:"earnings"` // wage items
	Items         []EmployeeItem `json:"items"`    // additions, deductions, company contributions, other (local) taxes

	W4              W4      `json:"w4"`
	SubjectSS       bool    `json:"subjectSs"`
	SubjectMedicare bool    `json:"subjectMedicare"`
	SubjectFUTA     bool    `json:"subjectFuta"`
	StateW4         StateW4 `json:"stateW4"`
	SubjectSUI      bool    `json:"subjectSui"`
	SubjectSDI      bool    `json:"subjectSdi"`

	DirectDeposit DirectDeposit `json:"directDeposit"`
	Sick          PTOSettings   `json:"sick"`
	Vacation      PTOSettings   `json:"vacation"`
	Notes         string        `json:"notes"`
	Active        bool          `json:"active"`

	SSNOnFile       bool    `json:"ssnOnFile"`       // (ro)
	PayScheduleName string  `json:"payScheduleName"` // (ro)
	HourlyRate      float64 `json:"hourlyRate"`      // (ro) first hourly wage rate (or salary / 2080)
	AnnualSalary    float64 `json:"annualSalary"`    // (ro) first salary rate
	YTDGross        float64 `json:"ytdGross"`        // (ro) current calendar year
	LastCheckDate   string  `json:"lastCheckDate"`   // (ro)
	HasPaychecks    bool    `json:"hasPaychecks"`    // (ro)
	BooksSyncError  string  `json:"booksSyncError"`  // (ro) problem creating/updating the Books name
}

// PTOAdjustment changes an employee's available sick or vacation hours
// (opening balance "hours available as of", manual corrections).
type PTOAdjustment struct {
	ID         int64   `json:"id"`
	EmployeeID int64   `json:"employeeId"`
	Kind       string  `json:"kind"` // sick | vacation
	Date       string  `json:"date"`
	Hours      float64 `json:"hours"` // + adds available hours, - removes
	Memo       string  `json:"memo"`
	CreatedAt  string  `json:"createdAt"` // (ro)
}

// EmployeeDefaults are used for new employees (Employee Defaults window).
type EmployeeDefaults struct {
	PayScheduleID *int64         `json:"payScheduleId"`
	PayFrequency  string         `json:"payFrequency"`
	ClassID       *int64         `json:"classId"`
	WorkState     string         `json:"workState"`
	Earnings      []EmployeeItem `json:"earnings"`
	Items         []EmployeeItem `json:"items"`
	Sick          PTOSettings    `json:"sick"`
	Vacation      PTOSettings    `json:"vacation"`
	SubjectSUI    bool           `json:"subjectSui"`
	SubjectSDI    bool           `json:"subjectSdi"`
}

// EmployeeSummary is the Employee Center information pane / paycheck history panel.
type EmployeeSummary struct {
	EmployeeID    int64            `json:"employeeId"`
	Year          int              `json:"year"`
	YTDGross      float64          `json:"ytdGross"`
	YTDNet        float64          `json:"ytdNet"`
	YTDTaxes      float64          `json:"ytdTaxes"`
	YTDDeductions float64          `json:"ytdDeductions"`
	LastPaycheck  *PaycheckSummary `json:"lastPaycheck"`
	Sick          PTOSettings      `json:"sick"`
	Vacation      PTOSettings      `json:"vacation"`
	YTDByItem     []SummaryRow     `json:"ytdByItem"`
}

// ---------------------------------------------------------------------------
// Paychecks

// PaycheckLine: Amount is positive; Category says how it affects the check.
type PaycheckLine struct {
	ID           int64    `json:"id"`
	ItemID       int64    `json:"itemId"`
	Rate         *float64 `json:"rate"` // earnings: hourly rate / salary per period / amount; others: amount or percent
	Qty          *float64 `json:"qty"`  // earnings: hours; quantity-based items: quantity
	Amount       float64  `json:"amount"`
	WageBase     float64  `json:"wageBase"`     // (ro for computed lines) taxes: taxable wages this check (after the wage base cap)
	SubjectWages float64  `json:"subjectWages"` // (ro) taxes: wages subject to the tax this check before the wage base cap
	Computed     float64  `json:"computed"`     // (ro) amount the program calculated (differs from Amount when Manual)
	JobNameID    *int64   `json:"jobNameId"`
	ClassID      *int64   `json:"classId"`
	Manual       bool     `json:"manual"` // the user typed the amount; keep it on recalculation

	ItemName string  `json:"itemName"` // (ro)
	ItemType string  `json:"itemType"` // (ro)
	Category string  `json:"category"` // (ro)
	TaxCode  string  `json:"taxCode"`  // (ro)
	Pto      string  `json:"pto"`      // (ro)
	JobName  string  `json:"jobName"`  // (ro)
	YTD      float64 `json:"ytd"`      // (ro) year-to-date amount of this item including this paycheck
}

const (
	PaycheckRegular = "regular"
	PaycheckYTD     = "ytd" // Enter Year-to-Date Amounts: history only, no check, never posted
)

// PaycheckInput creates, previews or edits one paycheck.
//
// Calculation rules (server): earnings lines are given by
// the client (item, rate, hours). Every other line is computed from the
// employee setup unless it is sent with Manual = true (its Amount is kept).
// Extra one-time items may be sent as additional lines (Manual false = computed
// by the item's calculation method). Recalculate = false (editing an existing
// paycheck without changes to earnings) keeps every amount as sent.
type PaycheckInput struct {
	ID            int64          `json:"id"`
	EmployeeID    int64          `json:"employeeId"`
	Kind          string         `json:"kind"` // regular | ytd
	PeriodStart   string         `json:"periodStart"`
	PeriodEnd     string         `json:"periodEnd"`
	CheckDate     string         `json:"checkDate"`
	BankAccountID *int64         `json:"bankAccountId"`
	CheckNumber   string         `json:"checkNumber"`
	ToBePrinted   bool           `json:"toBePrinted"`
	DirectDeposit bool           `json:"directDeposit"`
	Memo          string         `json:"memo"`
	ClassID       *int64         `json:"classId"`
	NoAccrual     bool           `json:"noAccrual"` // do not accrue sick/vacation on this paycheck
	Lines         []PaycheckLine `json:"lines"`
	Recalculate   bool           `json:"recalculate"`
}

// SummaryRow is one row of the Employee Summary / Company Summary panes.
type SummaryRow struct {
	ItemID   int64   `json:"itemId"`
	ItemName string  `json:"itemName"`
	Category string  `json:"category"`
	Amount   float64 `json:"amount"`
	YTD      float64 `json:"ytd"`
}

// PTOSnapshot is the sick or vacation status shown on a paycheck.
type PTOSnapshot struct {
	AvailableBefore float64 `json:"availableBefore"`
	Accrued         float64 `json:"accrued"`
	Used            float64 `json:"used"`
	AvailableAfter  float64 `json:"availableAfter"`
}

type Paycheck struct {
	PaycheckInput
	RunID           *int64       `json:"runId"`           // (ro)
	EmployeeName    string       `json:"employeeName"`    // (ro)
	Gross           float64      `json:"gross"`           // (ro) earnings + additions
	NotPaid         float64      `json:"notPaid"`         // (ro) reported tips inside Gross
	Deductions      float64      `json:"deductions"`      // (ro)
	EmployeeTaxes   float64      `json:"employeeTaxes"`   // (ro)
	Net             float64      `json:"net"`             // (ro) check amount
	EmployerTaxes   float64      `json:"employerTaxes"`   // (ro)
	Contributions   float64      `json:"contributions"`   // (ro)
	TotalHours      float64      `json:"totalHours"`      // (ro)
	EmployeeSummary []SummaryRow `json:"employeeSummary"` // (ro) earnings, additions, deductions, employee taxes, with YTD
	CompanySummary  []SummaryRow `json:"companySummary"`  // (ro) employer taxes and contributions, with YTD
	Sick            PTOSnapshot  `json:"sick"`            // (ro)
	Vacation        PTOSnapshot  `json:"vacation"`        // (ro)
	Voided          bool         `json:"voided"`          // (ro)
	BooksTxnID      *int64       `json:"booksTxnId"`      // (ro)
	SyncStatus      string       `json:"syncStatus"`      // (ro) none | pending | posted | error
	SyncError       string       `json:"syncError"`       // (ro)
	BankAccountName string       `json:"bankAccountName"` // (ro)
	Warnings        []string     `json:"warnings"`        // (ro) e.g. "Federal Withholding: employee is exempt"
	CreatedBy       string       `json:"createdBy"`       // (ro)
	CreatedAt       string       `json:"createdAt"`       // (ro)
	UpdatedAt       string       `json:"updatedAt"`       // (ro)
}

type PaycheckSummary struct {
	ID            int64   `json:"id"`
	RunID         *int64  `json:"runId"`
	Kind          string  `json:"kind"`
	EmployeeID    int64   `json:"employeeId"`
	EmployeeName  string  `json:"employeeName"`
	PeriodStart   string  `json:"periodStart"`
	PeriodEnd     string  `json:"periodEnd"`
	CheckDate     string  `json:"checkDate"`
	CheckNumber   string  `json:"checkNumber"`
	ToBePrinted   bool    `json:"toBePrinted"`
	DirectDeposit bool    `json:"directDeposit"`
	BankAccountID *int64  `json:"bankAccountId"`
	Gross         float64 `json:"gross"`
	EmployeeTaxes float64 `json:"employeeTaxes"`
	Deductions    float64 `json:"deductions"`
	Net           float64 `json:"net"`
	EmployerTaxes float64 `json:"employerTaxes"`
	Contributions float64 `json:"contributions"`
	TotalHours    float64 `json:"totalHours"`
	Memo          string  `json:"memo"`
	Voided        bool    `json:"voided"`
	BooksTxnID    *int64  `json:"booksTxnId"`
	SyncStatus    string  `json:"syncStatus"`
	SyncError     string  `json:"syncError"`
}

// ---------------------------------------------------------------------------
// Payroll runs (Pay Employees)

const (
	RunScheduled   = "scheduled"
	RunUnscheduled = "unscheduled"
	RunTermination = "termination"
)

// ScheduledPayroll is a row of the Payroll Center "Pay Employees" list.
type ScheduledPayroll struct {
	PayScheduleID int64  `json:"payScheduleId"`
	Name          string `json:"name"`
	Frequency     string `json:"frequency"`
	PeriodStart   string `json:"periodStart"`
	PeriodEnd     string `json:"periodEnd"`
	CheckDate     string `json:"checkDate"`
	Status        string `json:"status"` // "Upcoming" | "Due" | "Overdue"
	EmployeeCount int    `json:"employeeCount"`
}

// StartPayrollRequest asks for the defaults of the Hours and Pay step.
type StartPayrollRequest struct {
	Kind          string  `json:"kind"`          // scheduled | unscheduled | termination
	PayScheduleID *int64  `json:"payScheduleId"` // scheduled
	EmployeeIDs   []int64 `json:"employeeIds"`   // unscheduled/termination (empty = all active employees for unscheduled)
	PeriodEnd     string  `json:"periodEnd"`     // "" = schedule default / today
	CheckDate     string  `json:"checkDate"`     // "" = schedule default / today
	ReleaseDate   string  `json:"releaseDate"`   // termination
}

type PayrollDraftEmployee struct {
	EmployeeID    int64          `json:"employeeId"`
	EmployeeName  string         `json:"employeeName"`
	Selected      bool           `json:"selected"`
	Lines         []PaycheckLine `json:"lines"` // default earnings lines (from the employee setup, or copied from the last paycheck per prefs)
	TotalHours    float64        `json:"totalHours"`
	DirectDeposit bool           `json:"directDeposit"`
	PayFrequency  string         `json:"payFrequency"`
	LastCheckDate string         `json:"lastCheckDate"`
	Warnings      []string       `json:"warnings"`
}

type PayrollDraft struct {
	Kind            string                 `json:"kind"`
	PayScheduleID   *int64                 `json:"payScheduleId"`
	ScheduleName    string                 `json:"scheduleName"`
	PeriodStart     string                 `json:"periodStart"`
	PeriodEnd       string                 `json:"periodEnd"`
	CheckDate       string                 `json:"checkDate"`
	BankAccountID   *int64                 `json:"bankAccountId"`   // prefs default
	NextCheckNumber string                 `json:"nextCheckNumber"` // from SerieX Books next-ref for the bank account
	EarningColumns  []PayrollItem          `json:"earningColumns"`  // wage items used by the listed employees (grid columns)
	Employees       []PayrollDraftEmployee `json:"employees"`
}

// CreatePayrollRequest creates the paychecks of one payroll (Create Paychecks).
type CreatePayrollRequest struct {
	Kind             string          `json:"kind"`
	PayScheduleID    *int64          `json:"payScheduleId"`
	PeriodStart      string          `json:"periodStart"`
	PeriodEnd        string          `json:"periodEnd"`
	CheckDate        string          `json:"checkDate"`
	BankAccountID    int64           `json:"bankAccountId"`
	PrintMode        string          `json:"printMode"`        // "print" (to be printed) | "handwritten" (assign numbers from FirstCheckNumber)
	FirstCheckNumber string          `json:"firstCheckNumber"` // handwritten
	Paychecks        []PaycheckInput `json:"paychecks"`        // full inputs as returned by /paychecks/calculate (lines may carry Manual overrides)
	ReleaseDate      string          `json:"releaseDate"`      // termination: written to the employees' release date ("" = the check date)
}

// SyncProblem is a record that could not be posted to SerieX Books.
type SyncProblem struct {
	Entity  string `json:"entity"` // paycheck | liability_payment | adjustment | employee
	ID      int64  `json:"id"`
	Label   string `json:"label"`
	Code    string `json:"code"` // Books error code (confirm, closing_date, validation, books_unavailable...)
	Message string `json:"message"`
}

type CreatePayrollResult struct {
	RunID     int64             `json:"runId"`
	Paychecks []PaycheckSummary `json:"paychecks"`
	Posted    int               `json:"posted"`
	Problems  []SyncProblem     `json:"problems"`
}

// ---------------------------------------------------------------------------
// Liabilities

type LiabilityItemAmount struct {
	ItemID   int64   `json:"itemId"`
	ItemName string  `json:"itemName"`
	Amount   float64 `json:"amount"`
}

// LiabilityDue is a row of Pay Payroll Taxes (one payment group and period).
type LiabilityDue struct {
	PaymentGroup   string                `json:"paymentGroup"`
	Label          string                `json:"label"` // e.g. "Federal 941/944/943", "CA Withholding"
	AgencyVendorID *int64                `json:"agencyVendorId"`
	AgencyName     string                `json:"agencyName"`
	PeriodStart    string                `json:"periodStart"`
	PeriodEnd      string                `json:"periodEnd"`
	DueDate        string                `json:"dueDate"`
	Status         string                `json:"status"` // "Overdue" | "Due" | "Upcoming" | "Paid"
	Frequency      string                `json:"frequency"`
	Method         string                `json:"method"` // check | e-pay
	AmountDue      float64               `json:"amountDue"`
	Items          []LiabilityItemAmount `json:"items"`
}

type LiabilityBalance struct {
	ItemID       int64   `json:"itemId"`
	ItemName     string  `json:"itemName"`
	ItemType     string  `json:"itemType"`
	PaymentGroup string  `json:"paymentGroup"`
	AgencyName   string  `json:"agencyName"`
	Accrued      float64 `json:"accrued"`  // from paychecks
	Adjusted     float64 `json:"adjusted"` // liability adjustments
	Paid         float64 `json:"paid"`     // liability payments
	Balance      float64 `json:"balance"`  // accrued + adjusted - paid
}

type LiabilityPaymentLine struct {
	Kind      string  `json:"kind"`      // "item" | "expense"
	ItemID    *int64  `json:"itemId"`    // item lines
	AccountID *int64  `json:"accountId"` // expense lines (penalties, interest)
	Amount    float64 `json:"amount"`
	Memo      string  `json:"memo"`

	ItemName    string `json:"itemName"`    // (ro)
	AccountName string `json:"accountName"` // (ro)
}

const (
	PaymentRegular = "payment"
	PaymentPrior   = "prior" // Record Earlier Tax Payments: history only, never posted
)

type LiabilityPayment struct {
	ID             int64                  `json:"id"`
	Kind           string                 `json:"kind"`
	Date           string                 `json:"date"`
	PeriodStart    string                 `json:"periodStart"`
	PeriodEnd      string                 `json:"periodEnd"`
	AgencyVendorID *int64                 `json:"agencyVendorId"`
	BankAccountID  *int64                 `json:"bankAccountId"`
	CheckNumber    string                 `json:"checkNumber"`
	ToBePrinted    bool                   `json:"toBePrinted"`
	Method         string                 `json:"method"`
	Memo           string                 `json:"memo"`
	Lines          []LiabilityPaymentLine `json:"lines"`

	Amount          float64 `json:"amount"`          // (ro)
	AgencyName      string  `json:"agencyName"`      // (ro)
	BankAccountName string  `json:"bankAccountName"` // (ro)
	Voided          bool    `json:"voided"`          // (ro)
	BooksTxnID      *int64  `json:"booksTxnId"`      // (ro)
	SyncStatus      string  `json:"syncStatus"`      // (ro)
	SyncError       string  `json:"syncError"`       // (ro)
	CreatedBy       string  `json:"createdBy"`       // (ro)
	CreatedAt       string  `json:"createdAt"`       // (ro)
}

type LiabilityAdjustmentLine struct {
	ItemID   int64   `json:"itemId"`
	Amount   float64 `json:"amount"`   // + increases the liability, - decreases it
	WageBase float64 `json:"wageBase"` // change of the item's taxable wages
	Memo     string  `json:"memo"`

	ItemName string `json:"itemName"` // (ro)
}

type LiabilityAdjustment struct {
	ID              int64                     `json:"id"`
	Date            string                    `json:"date"`
	EffectiveDate   string                    `json:"effectiveDate"`
	EmployeeID      *int64                    `json:"employeeId"` // nil = company adjustment
	Memo            string                    `json:"memo"`
	AffectsAccounts bool                      `json:"affectsAccounts"` // post a journal entry to SerieX Books
	ClassID         *int64                    `json:"classId"`
	Lines           []LiabilityAdjustmentLine `json:"lines"`

	EmployeeName string `json:"employeeName"` // (ro)
	BooksTxnID   *int64 `json:"booksTxnId"`   // (ro)
	SyncStatus   string `json:"syncStatus"`   // (ro)
	SyncError    string `json:"syncError"`    // (ro)
	CreatedBy    string `json:"createdBy"`    // (ro)
	CreatedAt    string `json:"createdAt"`    // (ro)
}

const (
	PayFreqSemiweekly   = "semiweekly"
	PayFreqMonthly      = "monthly"
	PayFreqQuarterly    = "quarterly"
	PayFreqAnnually     = "annually"
	PayFreqAfterPayroll = "after_payroll"
)

// PaymentSchedule is the payment frequency/method of one payment group.
type PaymentSchedule struct {
	PaymentGroup   string   `json:"paymentGroup"`
	Label          string   `json:"label"` // (ro)
	AgencyVendorID *int64   `json:"agencyVendorId"`
	AgencyName     string   `json:"agencyName"` // (ro)
	Frequency      string   `json:"frequency"`
	Method         string   `json:"method"`
	ItemNames      []string `json:"itemNames"` // (ro) items in the group
}

// ---------------------------------------------------------------------------
// Tax forms

// FormLine is one line/box of a tax form. Value is what prints; Computed is
// what the program calculated (they differ when the user overrode the line).
type FormLine struct {
	Key        string  `json:"key"` // as printed: "1", "5a", "5a(i)", "13a", "16a"
	Col        string  `json:"col"` // "" or the column of a multi-column line ("1", "2")
	Label      string  `json:"label"`
	Section    string  `json:"section"` // "Part 1", "Part 2"...
	Kind       string  `json:"kind"`    // money | number | count | check | text
	Value      float64 `json:"value"`
	Text       string  `json:"text"`
	Checked    bool    `json:"checked"`
	Computed   float64 `json:"computed"`
	Editable   bool    `json:"editable"`
	Overridden bool    `json:"overridden"`
}

type FormCompany struct {
	EIN          string  `json:"ein"` // formatted 12-3456789
	Name         string  `json:"name"`
	TradeName    string  `json:"tradeName"`
	Address      Address `json:"address"`
	StateID      string  `json:"stateId"` // state forms
	ContactName  string  `json:"contactName"`
	ContactPhone string  `json:"contactPhone"`
	Email        string  `json:"email"` // company e-mail
}

// TaxForm is a quarterly/annual form (941, 940, state UI wage report summary).
type TaxForm struct {
	Form     string         `json:"form"` // "941" | "940" | "STATE-UI"
	Year     int            `json:"year"`
	Period   string         `json:"period"` // "Q1".."Q4" | "Y"
	State    string         `json:"state"`
	Title    string         `json:"title"`
	Company  FormCompany    `json:"company"`
	Lines    []FormLine     `json:"lines"`
	Status   string         `json:"status"` // new | draft | filed
	FiledAt  string         `json:"filedAt"`
	DueDate  string         `json:"dueDate"`
	Warnings []string       `json:"warnings"`
	Extra    map[string]any `json:"extra"` // 941: {"scheduleB": [{date, amount}]}; STATE-UI: {"employees": [StateWageRow]}
}

// SaveFormRequest stores user-entered values (keyed by FormLine key+col, e.g. "11a" or "5a:1") and the status.
type SaveFormRequest struct {
	Overrides map[string]float64 `json:"overrides"`
	Texts     map[string]string  `json:"texts"`
	Checks    map[string]bool    `json:"checks"`
	Status    string             `json:"status"` // draft | filed
}

type StateWageRow struct {
	EmployeeID     int64   `json:"employeeId"`
	Name           string  `json:"name"`
	SSN            string  `json:"ssn"` // masked unless revealed
	Gross          float64 `json:"gross"`
	SUIWages       float64 `json:"suiWages"`    // taxable for SUI
	ExcessWages    float64 `json:"excessWages"` // gross subject to SUI minus SUI taxable
	SITWages       float64 `json:"sitWages"`
	SITWithheld    float64 `json:"sitWithheld"`
	WeeksWorked    int     `json:"weeksWorked"`
	MonthsEmployed [3]bool `json:"monthsEmployed"` // employed in the pay period including the 12th of each month
}

type Box12 struct {
	Code   string  `json:"code"`
	Amount float64 `json:"amount"`
}

type Box14 struct {
	Label  string  `json:"label"`
	Amount float64 `json:"amount"`
}

type W2State struct {
	State   string  `json:"state"`
	StateID string  `json:"stateId"` // employer's state ID number
	Wages   float64 `json:"wages"`   // box 16
	Tax     float64 `json:"tax"`     // box 17
}

type W2Local struct {
	Name  string  `json:"name"`  // box 20
	Wages float64 `json:"wages"` // box 18
	Tax   float64 `json:"tax"`   // box 19
}

type W2 struct {
	EmployeeID     int64     `json:"employeeId"`
	Year           int       `json:"year"`
	SSN            string    `json:"ssn"`          // box a (masked unless revealed)
	EmployeeName   string    `json:"employeeName"` // box e
	FirstName      string    `json:"firstName"`
	MiddleInitial  string    `json:"middleInitial"`
	LastName       string    `json:"lastName"`
	Suffix         string    `json:"suffix"`
	Address        Address   `json:"address"`       // box f
	ControlNumber  string    `json:"controlNumber"` // box d
	Box1           float64   `json:"box1"`          // wages, tips, other compensation
	Box2           float64   `json:"box2"`          // federal income tax withheld
	Box3           float64   `json:"box3"`          // social security wages
	Box4           float64   `json:"box4"`          // social security tax withheld
	Box5           float64   `json:"box5"`          // Medicare wages and tips
	Box6           float64   `json:"box6"`          // Medicare tax withheld (incl. additional)
	Box7           float64   `json:"box7"`          // social security tips
	Box8           float64   `json:"box8"`          // allocated tips
	Box10          float64   `json:"box10"`         // dependent care benefits
	Box11          float64   `json:"box11"`         // nonqualified plans
	Box12          []Box12   `json:"box12"`
	Statutory      bool      `json:"statutory"`      // box 13
	RetirementPlan bool      `json:"retirementPlan"` // box 13
	ThirdPartySick bool      `json:"thirdPartySick"` // box 13
	Box14          []Box14   `json:"box14"`
	States         []W2State `json:"states"`
	Locals         []W2Local `json:"locals"`
	Reviewed       bool      `json:"reviewed"`
	Warnings       []string  `json:"warnings"`
	Box14b         []string  `json:"box14b"` // Treasury Tipped Occupation Codes (2026 box 14b; required with box 12 code TP)
}

type W3 struct {
	Year           int       `json:"year"`
	Count          int       `json:"count"` // c: total number of Forms W-2
	Box1           float64   `json:"box1"`
	Box2           float64   `json:"box2"`
	Box3           float64   `json:"box3"`
	Box4           float64   `json:"box4"`
	Box5           float64   `json:"box5"`
	Box6           float64   `json:"box6"`
	Box7           float64   `json:"box7"`
	Box8           float64   `json:"box8"`
	Box10          float64   `json:"box10"`
	Box11          float64   `json:"box11"`
	Box12a         float64   `json:"box12a"` // deferred compensation total (codes D, E, F, G, H, S, Y, AA, BB, EE)
	Box14          float64   `json:"box14"`  // income tax withheld by payer of third-party sick pay
	States         []W2State `json:"states"` // 15-17 totals per state
	Locals         []W2Local `json:"locals"`
	KindOfPayer    string    `json:"kindOfPayer"`    // "941"
	KindOfEmployer string    `json:"kindOfEmployer"` // "none" (none apply)
}

type W2Result struct {
	Year      int         `json:"year"`
	Company   FormCompany `json:"company"`
	Employees []W2        `json:"employees"`
	W3        W3          `json:"w3"`
	Status    string      `json:"status"`
	FiledAt   string      `json:"filedAt"`
}

type FormFiling struct {
	ID        int64  `json:"id"`
	Form      string `json:"form"`
	Year      int    `json:"year"`
	Period    string `json:"period"`
	State     string `json:"state"`
	Status    string `json:"status"`
	FiledAt   string `json:"filedAt"`
	UpdatedAt string `json:"updatedAt"`
	DueDate   string `json:"dueDate"` // (ro)
	Title     string `json:"title"`   // (ro)
}

// ---------------------------------------------------------------------------
// Company, preferences, setup

type PayrollCompany struct {
	BooksCompanyID         string         `json:"booksCompanyId"` // (ro)
	Name                   string         `json:"name"`
	LegalName              string         `json:"legalName"`
	TradeName              string         `json:"tradeName"`
	Address                Address        `json:"address"`
	Phone                  string         `json:"phone"`
	Email                  string         `json:"email"`
	EIN                    string         `json:"ein"` // digits on input; "12-3456789" on output
	ContactName            string         `json:"contactName"`
	ContactTitle           string         `json:"contactTitle"`
	ContactPhone           string         `json:"contactPhone"`
	PrimaryState           string         `json:"primaryState"`
	FederalDepositSchedule string         `json:"federalDepositSchedule"` // monthly | semiweekly
	FirstPayrollYear       int            `json:"firstPayrollYear"`
	SetupDone              bool           `json:"setupDone"`
	SetupState             map[string]any `json:"setupState"` // wizard progress (frontend owned)
	BooksURL               string         `json:"booksUrl"`   // (ro) address of SerieX Books used by this server
}

type StateSettings struct {
	State         string                        `json:"state"`
	WithholdingID string                        `json:"withholdingId"`
	UIID          string                        `json:"uiId"`
	UIRates       map[string]float64            `json:"uiRates"`    // year -> percent
	OtherRates    map[string]map[string]float64 `json:"otherRates"` // year -> program key -> percent
	StateName     string                        `json:"stateName"`  // (ro)
}

// PayrollPrefs: Edit > Preferences > Payroll & Employees.
type PayrollPrefs struct {
	DefaultBankAccountID      *int64 `json:"defaultBankAccountId"`
	DisplayNameOrder          string `json:"displayNameOrder"` // "first" ("First Last") | "last" ("Last, First")
	CopyEarningsFromPrevious  bool   `json:"copyEarningsFromPrevious"`
	RecallHours               bool   `json:"recallHours"`
	JobCosting                bool   `json:"jobCosting"`    // customer:job column on earnings lines
	ClassTracking             string `json:"classTracking"` // "none" | "paycheck" | "earnings"
	ShowSSNOnReports          bool   `json:"showSsnOnReports"`
	PostToBooks               bool   `json:"postToBooks"` // post paychecks/tax payments/adjustments to SerieX Books
	PayStubShowCompanyAddress bool   `json:"payStubShowCompanyAddress"`
	PayStubShowPTO            bool   `json:"payStubShowPto"`
	PayStubShowYTD            bool   `json:"payStubShowYtd"`
	PayStubShowSSNLast4       bool   `json:"payStubShowSsnLast4"`
	WarnDuplicateCheckNumbers bool   `json:"warnDuplicateCheckNumbers"`
	DueSoonDays               int    `json:"dueSoonDays"` // liabilities "Due" status window (days)
}

// DefaultPrefs are the preferences of a new payroll company.
func DefaultPrefs() PayrollPrefs {
	return PayrollPrefs{
		DisplayNameOrder:          "first",
		CopyEarningsFromPrevious:  true,
		RecallHours:               true,
		ClassTracking:             "none",
		PostToBooks:               true,
		PayStubShowCompanyAddress: true,
		PayStubShowPTO:            true,
		PayStubShowYTD:            true,
		PayStubShowSSNLast4:       true,
		WarnDuplicateCheckNumbers: true,
		DueSoonDays:               14,
	}
}

// SetupRequest creates the payroll file of a SerieX Books company (first step of Payroll Setup).
type SetupRequest struct {
	PrimaryState           string   `json:"primaryState"`
	EIN                    string   `json:"ein"`
	FederalDepositSchedule string   `json:"federalDepositSchedule"`
	FirstPayrollYear       int      `json:"firstPayrollYear"`
	DefaultBankAccountID   *int64   `json:"defaultBankAccountId"`
	CreateAccounts         bool     `json:"createAccounts"` // create the payroll accounts in SerieX Books (reusing existing ones by name)
	CreateAgencies         bool     `json:"createAgencies"` // create the tax agency vendors in SerieX Books
	PayFrequency           string   `json:"payFrequency"`   // first pay schedule
	NextPeriodEnd          string   `json:"nextPeriodEnd"`
	NextCheckDate          string   `json:"nextCheckDate"`
	UIRate                 *float64 `json:"uiRate"` // company SUI rate for FirstPayrollYear (nil = new employer rate)
}

// PayrollCompanyFile is one SerieX Books company and its payroll status (Open Company list).
type PayrollCompanyFile struct {
	ID            string `json:"id"` // Books company file id
	Name          string `json:"name"`
	PayrollSetUp  bool   `json:"payrollSetUp"` // a payroll file exists
	SetupDone     bool   `json:"setupDone"`
	BooksModified string `json:"booksModified"`
}

type AuthInfo struct {
	Required bool     `json:"required"`
	Users    []string `json:"users"`
}

type LoginRequest struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

type LoginResult struct {
	Token   string `json:"token"`
	User    string `json:"user"`
	IsAdmin bool   `json:"isAdmin"`
}

type AppInfo struct {
	App            string `json:"app"` // "SerieX Payroll"
	Version        string `json:"version"`
	BooksURL       string `json:"booksUrl"`
	BooksReachable bool   `json:"booksReachable"`
	TaxYears       []int  `json:"taxYears"` // years with built-in tax tables
}

// ---------------------------------------------------------------------------
// SerieX Books link

type BooksStatus struct {
	URL          string `json:"url"`
	Reachable    bool   `json:"reachable"`
	CompanyName  string `json:"companyName"`
	SessionOK    bool   `json:"sessionOk"`
	PostToBooks  bool   `json:"postToBooks"`
	PendingCount int    `json:"pendingCount"`
	ErrorCount   int    `json:"errorCount"`
	Message      string `json:"message"`
}

// SyncItem is a payroll record and its SerieX Books posting state.
type SyncItem struct {
	Entity     string  `json:"entity"` // paycheck | liability_payment | adjustment
	ID         int64   `json:"id"`
	Date       string  `json:"date"`
	Label      string  `json:"label"` // "Paycheck - Jane Doe", "Tax Payment - United States Treasury"
	Amount     float64 `json:"amount"`
	BooksTxnID *int64  `json:"booksTxnId"`
	Status     string  `json:"status"` // pending | error | posted
	Error      string  `json:"error"`
	SyncedAt   string  `json:"syncedAt"`
}

type RetryRequest struct {
	Items []SyncRef `json:"items"` // empty = every pending/error record
}

type SyncRef struct {
	Entity string `json:"entity"`
	ID     int64  `json:"id"`
}

type RetryResult struct {
	Posted   int           `json:"posted"`
	Problems []SyncProblem `json:"problems"`
}

// VerifyProblem is a difference between payroll and SerieX Books found by Verify.
type VerifyProblem struct {
	Entity     string `json:"entity"`
	ID         int64  `json:"id"`
	Label      string `json:"label"`
	BooksTxnID *int64 `json:"booksTxnId"`
	Problem    string `json:"problem"` // "missing in SerieX Books", "amount differs: payroll 1,234.56, Books 1,200.00", ...
}

type VerifyResult struct {
	Checked  int             `json:"checked"`
	Problems []VerifyProblem `json:"problems"`
	// liability account balances: payroll balance vs SerieX Books balance per account
	Accounts []AccountTieOut `json:"accounts"`
}

type AccountTieOut struct {
	AccountID      int64   `json:"accountId"`
	AccountName    string  `json:"accountName"`
	PayrollBalance float64 `json:"payrollBalance"`
	BooksBalance   float64 `json:"booksBalance"`
	Difference     float64 `json:"difference"` // payrollBalance - notInBooks - notPosted - booksBalance (0 for a healthy file)
	NotInBooks     float64 `json:"notInBooks"` // part of payrollBalance never posted by design: year-to-date entries, earlier tax payments, adjustments that do not affect accounts, records saved while posting was off
	NotPosted      float64 `json:"notPosted"`  // part of payrollBalance waiting to be posted (Books Sync: pending or error)
}

// Books records as shown in payroll pickers (subset of the SerieX Books model).
type BooksAccount struct {
	ID       int64   `json:"id"`
	Name     string  `json:"name"`
	FullName string  `json:"fullName"`
	Number   string  `json:"number"`
	Type     string  `json:"type"`
	Level    int     `json:"level"`
	Balance  float64 `json:"balance"`
	Active   bool    `json:"active"`
}

type BooksName struct {
	ID       int64  `json:"id"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Level    int    `json:"level"`
	Active   bool   `json:"active"`
	Address  string `json:"address"` // (ro) address block printed on checks to this name: print-as name, address lines, "City, ST ZIP" ("\n" separated)
}

type BooksListEntry struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	FullName string `json:"fullName"`
	Level    int    `json:"level"`
	Active   bool   `json:"active"`
}

// NewBooksAccount creates an account in SerieX Books from payroll (Add New in an account picker).
type NewBooksAccount struct {
	Name     string `json:"name"`
	Type     string `json:"type"` // "Expense" | "Other Current Liability" | "Bank"
	ParentID *int64 `json:"parentId"`
	Number   string `json:"number"`
}

// NewBooksVendor creates a vendor in SerieX Books (tax agency, benefit provider).
type NewBooksVendor struct {
	Name          string  `json:"name"`
	CompanyName   string  `json:"companyName"`
	Address       Address `json:"address"`
	Phone         string  `json:"phone"`
	AccountNumber string  `json:"accountNumber"`
}

// ---------------------------------------------------------------------------
// Pay stubs

type PayStub struct {
	PaycheckID      int64        `json:"paycheckId"`
	Company         FormCompany  `json:"company"`
	EmployeeName    string       `json:"employeeName"`
	EmployeeAddress Address      `json:"employeeAddress"`
	SSNLast4        string       `json:"ssnLast4"`
	EmployeeNumber  string       `json:"employeeNumber"`
	PeriodStart     string       `json:"periodStart"`
	PeriodEnd       string       `json:"periodEnd"`
	CheckDate       string       `json:"checkDate"`
	CheckNumber     string       `json:"checkNumber"`
	DirectDeposit   bool         `json:"directDeposit"`
	DepositAccount  string       `json:"depositAccount"` // masked
	Earnings        []StubLine   `json:"earnings"`
	Taxes           []StubLine   `json:"taxes"`
	Deductions      []StubLine   `json:"deductions"`
	Additions       []StubLine   `json:"additions"`
	Contributions   []StubLine   `json:"contributions"` // company contributions (informational)
	Gross           float64      `json:"gross"`
	GrossYTD        float64      `json:"grossYtd"`
	Net             float64      `json:"net"`
	NetYTD          float64      `json:"netYtd"`
	TotalTaxes      float64      `json:"totalTaxes"`
	TotalDeductions float64      `json:"totalDeductions"`
	Sick            *PTOSnapshot `json:"sick"`
	Vacation        *PTOSnapshot `json:"vacation"`
	Memo            string       `json:"memo"`
	NetInWords      string       `json:"netInWords"` // "One thousand two hundred thirty-four and 56/100"
	PrintAs         string       `json:"printAs"`
}

type StubLine struct {
	Name   string   `json:"name"`
	Rate   *float64 `json:"rate"`
	Hours  *float64 `json:"hours"`
	Amount float64  `json:"amount"`
	YTD    float64  `json:"ytd"`
}

// ---------------------------------------------------------------------------
// Reports (same shapes as SerieX Books so both apps render reports alike)

type ReportColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Type  string `json:"type"` // "text" | "money" | "number" | "date" | "percent" | "hours"
}

type ReportDrill struct {
	Report string            `json:"report"`
	Params map[string]string `json:"params"`
}

// ReportTarget opens a payroll record on double-click (drill-down).
type ReportTarget struct {
	Kind string `json:"kind"` // paycheck | liability_payment | adjustment | employee | item
	ID   int64  `json:"id"`
}

type ReportRow struct {
	Kind   string         `json:"kind"` // section | data | subtotal | total | grandtotal | blank
	Level  int            `json:"level"`
	Cells  map[string]any `json:"cells"`
	Target *ReportTarget  `json:"target,omitempty"`
	Drill  *ReportDrill   `json:"drill,omitempty"`
	Group  string         `json:"group,omitempty"`
}

type ReportResult struct {
	Key            string            `json:"key"`
	Title          string            `json:"title"`
	CompanyName    string            `json:"companyName"`
	DateRangeLabel string            `json:"dateRangeLabel"`
	Basis          string            `json:"basis"`
	Columns        []ReportColumn    `json:"columns"`
	Rows           []ReportRow       `json:"rows"`
	Params         map[string]string `json:"params"`
	GeneratedAt    string            `json:"generatedAt"`
}

type ReportInfo struct {
	Key          string   `json:"key"`
	Title        string   `json:"title"`
	Category     string   `json:"category"`
	Description  string   `json:"description"`
	Params       []string `json:"params"` // "dates", "asOf", "employeeId", "itemId", "columns", "year", "quarter", "state"
	DefaultDates string   `json:"defaultDates"`
}

// ---------------------------------------------------------------------------
// Audit

type AuditRow struct {
	ID       int64          `json:"id"`
	Ts       string         `json:"ts"`
	User     string         `json:"user"`
	Action   string         `json:"action"`
	Entity   string         `json:"entity"`
	EntityID *int64         `json:"entityId"`
	Summary  string         `json:"summary"`
	Details  map[string]any `json:"details"`
}

// ---------------------------------------------------------------------------
// Static lists for the client (GET /api/meta)

type Option struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type TaxTrackingType struct {
	Key        string          `json:"key"`
	Label      string          `json:"label"`
	ItemTypes  []string        `json:"itemTypes"` // item types it applies to
	W2Box12    string          `json:"w2Box12"`
	Taxability map[string]bool `json:"taxability"` // default taxability (see Base* comments)
}

type StateInfo struct {
	Code           string   `json:"code"`
	Name           string   `json:"name"`
	HasIncomeTax   bool     `json:"hasIncomeTax"`
	FilingStatuses []Option `json:"filingStatuses"`
	StateForm      string   `json:"stateForm"`
	Programs       []Option `json:"programs"` // other state taxes (key, name)
	HasEmployeeSUI bool     `json:"hasEmployeeSui"`
	Notes          string   `json:"notes"`
	Inputs         []Option `json:"inputs"` // state specific W-4 inputs: Value = StateW4.Data key (number), Label = prompt
}

type Meta struct {
	ItemTypes        []Option          `json:"itemTypes"`
	TaxCodes         []Option          `json:"taxCodes"`
	Frequencies      []Option          `json:"frequencies"`
	TaxTracking      []TaxTrackingType `json:"taxTracking"`
	Box12Codes       []Option          `json:"box12Codes"`
	States           []StateInfo       `json:"states"`
	FedStatus2020    []Option          `json:"fedStatus2020"`
	FedStatusPre2020 []Option          `json:"fedStatusPre2020"`
	TaxYears         []int             `json:"taxYears"`
}

// DefaultPaymentGroup is the payment group of an item when PaymentGroup is "".
// Earnings and additions have no liability ("").
func DefaultPaymentGroup(it *PayrollItem) string {
	switch it.TaxCode {
	case TaxFIT, TaxSSEE, TaxSSER, TaxMedEE, TaxMedER, TaxAddlMed:
		return GroupFederal941
	case TaxFUTA:
		return GroupFederal940
	case TaxSIT:
		return "state_wh:" + it.State
	case TaxSUIER, TaxSUIEE, TaxStateEE, TaxStateER:
		return "state_ui:" + it.State
	}
	switch it.Type {
	case ItemDeduction, ItemContribution, ItemOtherTax:
		if it.AgencyVendorID != nil && *it.AgencyVendorID > 0 {
			return "vendor:" + itoa(*it.AgencyVendorID)
		}
		return GroupUnassigned
	}
	return ""
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
