package taxes

import (
	"math"

	"seriexpayroll/internal/model"
)

// ---------------------------------------------------------------------------
// rounding helpers. Formulas run in float64 dollars; every result is rounded
// half away from zero, with a tiny epsilon so that decimal halves such as
// 549.90 / 52 = 10.575 (10.57499999... in binary) round like on paper.

func roundCents(dollars float64) int64 {
	v := dollars * 100
	if v >= 0 {
		v += 1e-6
	} else {
		v -= 1e-6
	}
	return int64(math.Round(v))
}

func round2(dollars float64) float64 { return float64(roundCents(dollars)) / 100 }

func roundDollar(dollars float64) float64 {
	if dollars >= 0 {
		return math.Round(dollars + 1e-8)
	}
	return math.Round(dollars - 1e-8)
}

func dollars(c int64) float64 { return float64(c) / 100 }

// pctOf returns round(cents x rate%) exactly: the rate is turned into an integer
// number of millionths of a percent so no binary fraction can flip a half cent.
func pctOf(cents int64, rate float64) int64 {
	r := int64(math.Round(rate * 1e6)) // 6.2% -> 6,200,000
	num := cents * r                   // cents x rate x 1e6
	const den = 100 * 1_000_000
	if num >= 0 {
		return (num + den/2) / den
	}
	return -((-num + den/2) / den)
}

// bracketTax applies a schedule: the last row whose Over <= x gives Base + (x - Over) x Rate.
func bracketTax(rows []model.Bracket, x float64) float64 {
	if len(rows) == 0 || x <= 0 {
		return 0
	}
	i := 0
	for j := range rows {
		if rows[j].Over <= x+1e-9 {
			i = j
		}
	}
	return rows[i].Base + (x-rows[i].Over)*rows[i].Rate/100
}

// ---------------------------------------------------------------------------
// Federal income tax withholding (Pub 15-T Worksheet 1A)

// FederalWithholding computes federal income tax withholding for one paycheck
// (Worksheet 1A / 1B of Pub 15-T, annual percentage method tables), rounded to cents.
// Exempt employees get 0. Supplemental wages: flat SupplementalRate (and
// SupplementalOver1MRate for the part of YTD supplemental wages over $1,000,000);
// with NoRegularWithholding the aggregate method (regular method on regular +
// supplemental wages of the period).
func FederalWithholding(fed *model.FederalTax, in FITInput) int64 {
	if fed == nil {
		return 0
	}
	if in.NoRegularWithholding && in.Supplemental > 0 {
		under, over := splitSupplemental(in)
		agg := in
		agg.Wages = in.Wages + roundCents(under)
		total := regularFIT(fed, agg) + over*fed.SupplementalOver1MRate/100
		return roundCents(total)
	}
	total := regularFIT(fed, in) + supplementalFIT(fed, in)
	return roundCents(total)
}

// regularFIT is lines 1a-4b of Worksheet 1A in dollars (0 when there are no
// regular wages on the check or the employee is exempt).
func regularFIT(fed *model.FederalTax, in FITInput) float64 {
	w := in.W4
	if w.Exempt || in.Wages <= 0 {
		return 0
	}
	periods := float64(in.PayPeriods)
	if periods <= 0 {
		periods = 1
	}
	wages := dollars(in.Wages)
	if w.Version == "pre2020" {
		if w.NonresidentAlien {
			wages += nraPerPeriod(fed.NRAPre2020, periods)
		}
		annual := wages * periods                                                    // 1c
		adj := math.Max(0, annual-float64(max(0, w.Allowances))*fed.AllowanceAmount) // 1j-1l
		table := fed.Pre2020["single"]
		if w.FilingStatus == "married" {
			table = fed.Pre2020["married"]
		}
		tent := bracketTax(table, adj) / periods // 2h
		return math.Max(0, tent) + w.ExtraWithholding
	}
	status := w.FilingStatus
	if status != "mfj" && status != "hoh" {
		status = "single"
	}
	if w.NonresidentAlien {
		wages += nraPerPeriod(fed.NRA2020, periods)
	}
	annual := wages * periods   // 1c
	e := annual + w.OtherIncome // 1e
	g := 0.0                    // 1g
	if !w.Step2 {
		if status == "mfj" {
			g = fed.Line1gMFJ
		} else {
			g = fed.Line1gOther
		}
	}
	adj := math.Max(0, e-(w.Deductions+g)) // 1i
	table := fed.Standard[status]
	if w.Step2 {
		table = fed.Checkbox[status]
	}
	tent := bracketTax(table, adj) / periods    // 2h
	c := math.Max(0, tent-w.Dependents/periods) // 3c
	return c + w.ExtraWithholding               // 4b
}

// nraPerPeriod is the Pub 15-T Table 1/2 amount for the payroll period: the
// annual amount divided by the periods, to one decimal as printed (weekly 2026
// Table 2: 16,100 / 52 = 309.6).
func nraPerPeriod(annual, periods float64) float64 {
	if annual <= 0 {
		return 0
	}
	return math.Round(annual/periods*10+1e-9) / 10
}

// supplementalFIT: flat rate on supplemental wages; the part of the calendar
// year's supplemental wages above $1,000,000 at the mandatory rate (also for
// employees who claim exemption).
func supplementalFIT(fed *model.FederalTax, in FITInput) float64 {
	if in.Supplemental == 0 {
		return 0
	}
	under, over := splitSupplemental(in)
	t := over * fed.SupplementalOver1MRate / 100
	if !in.W4.Exempt {
		t += under * fed.SupplementalRate / 100
	}
	return t
}

// splitSupplemental splits this check's supplemental wages (dollars) into the
// part up to and the part above $1,000,000 of the calendar year's supplemental wages.
func splitSupplemental(in FITInput) (under, over float64) {
	s := dollars(in.Supplemental)
	ytd := dollars(in.YTDSupplemental)
	const million = 1_000_000.0
	over = math.Max(0, ytd+s-million) - math.Max(0, ytd-million)
	return s - over, over
}

// ---------------------------------------------------------------------------
// Capped taxes, FICA, FUTA

// CappedTax computes rate% on the part of wages below an annual wage base:
// taxable = min(wages, max(0, wageBase - ytdWages)) (no cap when wageBase is
// nil); tax = round(taxable * rate / 100). Used for SS, FUTA, SUI, SDI...
// Negative wages (corrections) mirror the logic: the taxable part is the
// change of the capped year-to-date amount.
func CappedTax(rate float64, wageBase *float64, wages, ytdWages int64) (taxable, tax int64) {
	if wageBase == nil {
		taxable = wages
	} else {
		cap := roundCents(*wageBase)
		clamp := func(x int64) int64 {
			if x < 0 {
				return 0
			}
			if x > cap {
				return cap
			}
			return x
		}
		taxable = clamp(ytdWages+wages) - clamp(ytdWages)
	}
	return taxable, pctOf(taxable, rate)
}

// SocialSecurity: one side (employee or company) of social security tax.
func SocialSecurity(fed *model.FederalTax, wages, ytdWages int64) (taxable, tax int64) {
	base := fed.SSWageBase
	return CappedTax(fed.SSRate, &base, wages, ytdWages)
}

// Medicare: one side of the regular Medicare tax (no wage base).
func Medicare(fed *model.FederalTax, wages int64) (taxable, tax int64) {
	return wages, pctOf(wages, fed.MedicareRate)
}

// AdditionalMedicare: employee-only tax on the part of calendar-year Medicare
// wages above the threshold (ytdWages = Medicare wages paid before this check).
func AdditionalMedicare(fed *model.FederalTax, wages, ytdWages int64) (taxable, tax int64) {
	thr := roundCents(fed.AddlMedicareThreshold)
	over := func(x int64) int64 {
		if x > thr {
			return x - thr
		}
		return 0
	}
	taxable = over(ytdWages+wages) - over(ytdWages)
	return taxable, pctOf(taxable, fed.AddlMedicareRate)
}

// FUTA: federal unemployment at the net rate (credit reduction is handled on Form 940).
func FUTA(fed *model.FederalTax, wages, ytdWages int64) (taxable, tax int64) {
	base := fed.FUTAWageBase
	return CappedTax(fed.FUTARate, &base, wages, ytdWages)
}
