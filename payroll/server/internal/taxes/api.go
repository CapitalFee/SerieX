// Package taxes holds the built-in tax tables (data/<year>.json, embedded) and
// the tax engine: federal income tax withholding (IRS Pub 15-T percentage
// method for automated payroll systems), social security, Medicare,
// additional Medicare, FUTA, state income tax withholding, state unemployment
// and other wage-based taxes. Every function is pure (no database) except
// ForCompany, SUIRate and ProgramRate. Amounts are int64 cents; rates in the
// tables are percents.
//
// The payroll, forms and reports packages call these exported functions:
//
//	load.go     Years, Tables, ForCompany (built-in tables + company overrides)
//	federal.go  FederalWithholding, CappedTax, SocialSecurity, Medicare, AdditionalMedicare, FUTA
//	state.go    StateWithholding (generic model) + special.go (state formulas)
//	rates.go    SUIRate, ProgramRate
//	meta.go     Meta
//	routes.go   Register (/tax-tables routes)
package taxes

import "seriexpayroll/internal/model"

// FITInput is everything federal withholding depends on for one paycheck.
type FITInput struct {
	W4              model.W4
	PayPeriods      int   // model.PayPeriods[frequency]
	Wages           int64 // FIT-taxable wages of this check paid as regular wages (cents)
	Supplemental    int64 // FIT-taxable supplemental wages of this check (items with Supplemental=true), withheld at the flat rate
	YTDSupplemental int64 // supplemental wages paid earlier this calendar year (for the $1,000,000 mandatory rate)

	// NoRegularWithholding: no federal income tax was withheld from the
	// employee's regular wages in the current or the previous calendar year.
	// Pub 15 section 7 then requires the aggregate method for supplemental
	// wages: they are added to the regular wages of the period and withheld
	// with the regular method instead of the flat rate (the part of the year's
	// supplemental wages above $1,000,000 stays at the mandatory rate).
	NoRegularWithholding bool
}

// SITInput is everything state withholding depends on for one paycheck.
type SITInput struct {
	PayPeriods     int
	Wages          int64 // SIT-taxable regular wages of this check (cents)
	Supplemental   int64 // SIT-taxable supplemental wages (state SupplementalRate when the state has one, else added to Wages)
	YTDWages       int64 // SIT wages paid earlier this year
	W4             model.StateW4
	FedW4          model.W4 // for states that use the federal W-4
	FedWithholding int64    // this check's federal withholding on the regular wages (AL and OR subtract it; exclude the flat-rate supplemental part)

	// Massachusetts only (Circular M deducts employee social security and
	// Medicare up to $2,000 a year): this check's SS_EE + MED_EE (+ ADDL_MED)
	// and the same total paid earlier this year. When both are 0 the engine
	// estimates them at 7.65% of the SIT wages and returns a warning.
	FICA    int64
	YTDFICA int64
}

// State specific W-4 inputs read from model.StateW4.Data (numbers):
//
//	CA additionalAllowances          DE 4 additional allowances for estimated deductions ($1,000 each)
//	CO annualAllowance               DR 0004 line 2 annual withholding allowance (replaces the default, even 0)
//	IL additionalAllowances          IL-W-4 line 2 allowances ($1,000 each)
//	IN dependentExemptions           WH-4 line 6 ($1,500 each)
//	IN firstTimeDependentExemptions  WH-4 line 7 ($1,500 each)
//	IN adoptedDependentExemptions    WH-4 line 8 ($3,000 each)
//	MA blind                         number of blind persons (employee and/or spouse)
//	MD localRate                     county (local) income tax rate in percent (nonresidents 2.25)
//	VA ageBlindExemptions            VA-4 line 1(b) exemptions ($800 each)
//
// StateW4.ExtraWithholding may be negative where the state allows a reduction
// (CT-W4 line 3, L-4 line 7); the total is never below 0.
var stateInputs = map[string][]model.Option{
	"CA": {{Value: "additionalAllowances", Label: "Additional allowances for estimated deductions (DE 4 line 1b)"}},
	"CO": {{Value: "annualAllowance", Label: "Annual withholding allowance from DR 0004 line 2 (leave blank if no DR 0004)"}},
	"IL": {{Value: "additionalAllowances", Label: "Additional allowances (IL-W-4 line 2)"}},
	"IN": {
		{Value: "dependentExemptions", Label: "Additional dependent exemptions (WH-4 line 6)"},
		{Value: "firstTimeDependentExemptions", Label: "First-time additional dependent exemptions (WH-4 line 7)"},
		{Value: "adoptedDependentExemptions", Label: "Adopted dependent exemptions (WH-4 line 8)"},
	},
	"MA": {{Value: "blind", Label: "Blind employee and/or spouse (number, 0-2)"}},
	"MD": {{Value: "localRate", Label: "County (local) tax rate % (e.g. 3.20; nonresidents 2.25)"}},
	"VA": {{Value: "ageBlindExemptions", Label: "Age 65 and over / blind exemptions (VA-4 line 1b)"}},
}
