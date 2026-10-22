package model

// Tax tables (built-in data in server/internal/taxes/data/<year>.json, merged
// with company overrides from the Tax Tables window). Amounts are dollars,
// rates are percents (6.2 = 6.2%).

// Bracket is one row of a percentage method table: annual wages over Over
// (and up to the next row's Over) pay Base plus Rate % of the excess over Over.
// For marginal rate schedules (state tables) Base may be 0 in the data file;
// the engine computes it from the previous rows when BaseComputed is false.
type Bracket struct {
	Over float64 `json:"over"`
	Base float64 `json:"base"`
	Rate float64 `json:"rate"`
}

type FederalTax struct {
	Year int `json:"year"`

	SSRate                float64            `json:"ssRate"`                // 6.2 (each side)
	SSWageBase            float64            `json:"ssWageBase"`            // 184500 for 2026
	MedicareRate          float64            `json:"medicareRate"`          // 1.45 (each side)
	AddlMedicareRate      float64            `json:"addlMedicareRate"`      // 0.9 (employee only)
	AddlMedicareThreshold float64            `json:"addlMedicareThreshold"` // 200000 (calendar-year wages paid by this employer)
	FUTAGrossRate         float64            `json:"futaGrossRate"`         // 6.0
	FUTARate              float64            `json:"futaRate"`              // 0.6 (net of the 5.4 credit)
	FUTAWageBase          float64            `json:"futaWageBase"`          // 7000
	CreditReduction       map[string]float64 `json:"creditReduction"`       // state -> extra percent (Form 940 Schedule A) for this year

	// Pub 15-T Worksheet 1A, 2020-or-later W-4.
	Line1gMFJ   float64              `json:"line1gMfj"`   // 12900
	Line1gOther float64              `json:"line1gOther"` // 8600
	Standard    map[string][]Bracket `json:"standard"`    // "mfj" | "single" | "hoh": STANDARD withholding rate schedules (annual)
	Checkbox    map[string][]Bracket `json:"checkbox"`    // Step 2 checkbox withholding rate schedules (annual)

	// 2019-or-earlier W-4.
	AllowanceAmount float64              `json:"allowanceAmount"` // annual amount per withholding allowance
	Pre2020         map[string][]Bracket `json:"pre2020"`         // "married" | "single" (annual)

	// Nonresident alien additional annual amounts added to wages (Pub 15-T Table 1, annualized).
	NRA2020    float64 `json:"nra2020"`
	NRAPre2020 float64 `json:"nraPre2020"`

	SupplementalRate       float64 `json:"supplementalRate"`       // 22
	SupplementalOver1MRate float64 `json:"supplementalOver1MRate"` // 37 (supplemental wages over $1,000,000 in the year)

	// Annual limits used as defaults for payroll items (dollars).
	Limits map[string]float64 `json:"limits"` // keys: elective401k, catchUp50, catchUp6063, simple, simpleCatchUp, hsaSelf, hsaFamily, hsaCatchUp, healthFsa, dependentCare, transit, parking

	Sources  []string `json:"sources"`
	Verified string   `json:"verified"` // how/when the numbers were verified
	Notes    string   `json:"notes"`
}

// StateStatus is one filing status of a state withholding formula.
type StateStatus struct {
	Label              string    `json:"label"`
	StandardDeduction  float64   `json:"standardDeduction"`  // annual
	Brackets           []Bracket `json:"brackets"`           // annual taxable wages, marginal rates (Base filled by the engine when 0)
	LowIncomeExemption float64   `json:"lowIncomeExemption"` // annual wages at or below this: no withholding (0 = none)
}

type StateAllowance struct {
	Kind                  string  `json:"kind"` // none | deduction | credit | both
	DeductionPerAllowance float64 `json:"deductionPerAllowance"`
	CreditPerAllowance    float64 `json:"creditPerAllowance"`
	Notes                 string  `json:"notes"`
}

type StateIncomeTax struct {
	Has              bool                   `json:"has"`
	Method           string                 `json:"method"` // none | flat | brackets | special
	FlatRate         float64                `json:"flatRate"`
	SupplementalRate *float64               `json:"supplementalRate"`
	DefaultStatus    string                 `json:"defaultStatus"`
	Statuses         map[string]StateStatus `json:"statuses"`
	Allowance        StateAllowance         `json:"allowance"`
	UsesFederalW4    bool                   `json:"usesFederalW4"`
	StateForm        string                 `json:"stateForm"`
	Special          string                 `json:"special"` // key of a code handler for a formula the generic model cannot express ("" = generic)
	Formula          string                 `json:"formula"`
	Deviations       string                 `json:"deviations"`
	LocalTaxes       string                 `json:"localTaxes"`
	Params           map[string]float64     `json:"params"` // extra constants used by Special handlers
}

type StateSUI struct {
	WageBase         float64  `json:"wageBase"`
	NewEmployerRate  float64  `json:"newEmployerRate"`
	MinRate          float64  `json:"minRate"`
	MaxRate          float64  `json:"maxRate"`
	EmployeeRate     float64  `json:"employeeRate"`
	EmployeeWageBase *float64 `json:"employeeWageBase"` // nil = same as WageBase
	Agency           string   `json:"agency"`
	Notes            string   `json:"notes"`
}

// StateProgram is another state payroll tax (disability, paid leave, training tax...).
type StateProgram struct {
	Key          string   `json:"key"` // "SDI", "FLI", "PFML", "ETT", "WF"...
	Name         string   `json:"name"`
	EmployeeRate float64  `json:"employeeRate"`
	EmployerRate float64  `json:"employerRate"`
	WageBase     *float64 `json:"wageBase"`    // nil = no cap
	MaxEmployee  *float64 `json:"maxEmployee"` // annual cap on the employee amount (e.g. NY PFL), nil = none
	Notes        string   `json:"notes"`
	// weekly cap on the employee amount (NY DBL $0.60, HI TDI), nil = none; a
	// paycheck may withhold it times the weeks of its pay period
	MaxEmployeePerWeek *float64 `json:"maxEmployeePerWeek"`
}

type StateTax struct {
	State                string         `json:"state"`
	Name                 string         `json:"name"`
	Year                 int            `json:"year"`
	Income               StateIncomeTax `json:"income"`
	SUI                  StateSUI       `json:"sui"`
	Programs             []StateProgram `json:"programs"`
	AgencyWithholding    string         `json:"agencyWithholding"`
	AgencyUnemployment   string         `json:"agencyUnemployment"`
	Deposit              string         `json:"deposit"`
	QuarterlyReport      string         `json:"quarterlyReport"`
	AnnualReconciliation string         `json:"annualReconciliation"`
	Sources              []string       `json:"sources"`
	Confidence           string         `json:"confidence"`
	Notes                string         `json:"notes"`
}

// TaxYear is the complete table set of one calendar year.
type TaxYear struct {
	Year    int                 `json:"year"`
	Version string              `json:"version"` // data version, e.g. "2026.1"
	Federal FederalTax          `json:"federal"`
	States  map[string]StateTax `json:"states"`
}

// TaxTableInfo is the Tax Tables window summary.
type TaxTableInfo struct {
	Year      int               `json:"year"`
	Version   string            `json:"version"`
	Federal   FederalTax        `json:"federal"`
	States    []StateTaxSummary `json:"states"`
	Overrides []string          `json:"overrides"` // "federal", "CA"... that the company changed
}

type StateTaxSummary struct {
	State       string  `json:"state"`
	Name        string  `json:"name"`
	Method      string  `json:"method"`
	FlatRate    float64 `json:"flatRate"`
	SUIWageBase float64 `json:"suiWageBase"`
	SUINewRate  float64 `json:"suiNewRate"`
	Programs    int     `json:"programs"`
	Confidence  string  `json:"confidence"`
	Overridden  bool    `json:"overridden"`
}
