package taxes

import (
	"fmt"
	"math"

	"seriexpayroll/internal/model"
)

// specials maps model.StateIncomeTax.Special to the code of a state formula the
// generic model cannot express. Each returns the per-period withholding before
// the employee's extra withholding (regular part + supplemental part). The
// constants live in the state's Income.Params (data/<year>.json, overridable in
// the Tax Tables window); the formulas follow each state's 2026 publication.
var specials = map[string]func(c *sitCalc) float64{
	"AL": alabama,
	"AR": arkansas,
	"AZ": arizona,
	"CA": california,
	"CO": colorado,
	"CT": connecticut,
	"IL": illinois,
	"IN": indiana,
	"KS": kansas,
	"MA": massachusetts,
	"MD": maryland,
	"ME": maine,
	"NJ": newJersey,
	"NY": newYork,
	"OR": oregon,
	"RI": rhodeIsland,
	"SC": southCarolina,
	"UT": utah,
	"VA": virginia,
	"WI": wisconsin,
}

// ceilDiv is ceil(x / step) for the "each $500 increment or part thereof" rules.
func ceilDiv(x, step float64) float64 {
	if step <= 0 {
		return 0
	}
	return math.Ceil(x/step - 1e-9)
}

// withSupp adds the flat-rate supplemental part to a regular per-period amount.
func (c *sitCalc) withSupp(regular float64) float64 {
	_, supp, rate, flat := c.split()
	if flat {
		regular += c.suppTax(supp, rate)
	}
	return regular
}

// ---------------------------------------------------------------------------
// Alabama: income-dependent standard deduction, annualized federal withholding,
// personal exemption by A-4 status, dependents by gross income.

func alabama(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	k := c.status
	gi := wages * c.periods
	var sd float64
	switch full, upTo, floorFrom := c.param("sd."+k+".full", 0), c.param("sd."+k+".fullUpTo", 0), c.param("sd."+k+".floorFrom", 0); {
	case gi <= upTo:
		sd = full
	case gi >= floorFrom:
		sd = c.param("sd."+k+".floor", 0)
	default:
		sd = full - c.param("sd."+k+".step", 0)*ceilDiv(gi-upTo, c.param("sd."+k+".stepSize", 1))
	}
	fed := dollars(c.in.FedWithholding) * c.periods
	pe := c.param("persExempt."+k, 0)
	perDep := 0.0
	for i := 0; i < 10; i++ {
		amt, ok := c.params[fmt.Sprintf("dep.%d.amount", i)]
		if !ok {
			break
		}
		perDep = amt
		if upTo, ok := c.params[fmt.Sprintf("dep.%d.upTo", i)]; !ok || gi <= upTo {
			break
		}
	}
	taxable := math.Max(0, gi-(sd+fed+pe+c.allowances()*perDep))
	return c.withSupp(c.finishRegular(bracketTax(c.stat.Brackets, taxable) / c.periods))
}

// ---------------------------------------------------------------------------
// Arkansas: formula method (DFA, revised May 29, 2026): NTI looked up at the $50
// midrange below $100,001, rate x NTI minus the bracket adjustment rounded to a
// dollar, optional low-income credit, $29 personal credits.

func arkansas(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	annual := wages * c.periods
	nti := annual - c.param("std", 0)
	if nti <= 0 {
		return c.withSupp(0)
	}
	used := nti
	if nti < c.param("midrangeBelow", 100001) {
		used = math.Floor(nti/100+1e-9)*100 + 50
	}
	var rate, adj float64
	switch {
	case used >= c.param("top.from", math.Inf(1)):
		rate, adj = c.param("top.rate", 0), c.param("top.adj", 0)
	case used >= c.param("slide.from", math.Inf(1)) && used <= c.param("slide.to", 0)+0.99:
		last := -1
		for i := 0; ; i++ {
			if _, ok := c.params[fmt.Sprintf("b.%d.from", i)]; !ok {
				break
			}
			last = i
		}
		rate = c.param(fmt.Sprintf("b.%d.rate", last), 0)
		steps := math.Floor((used-c.param("slide.from", 0))/c.param("slide.step", 100) + 1e-9)
		adj = c.param("slide.adj", 0) - c.param("slide.stepAdj", 0)*steps
	default:
		for i := 0; ; i++ {
			from, ok := c.params[fmt.Sprintf("b.%d.from", i)]
			if !ok || used < from {
				break
			}
			rate, adj = c.param(fmt.Sprintf("b.%d.rate", i), 0), c.param(fmt.Sprintf("b.%d.adj", i), 0)
		}
	}
	gross := math.Max(0, roundDollar(used*rate/100-adj))
	n := c.allowances()
	if key := map[string]string{"low_single": "single", "low_married": "married", "low_hoh": "hoh"}[c.status]; key != "" {
		if key != "single" {
			if n >= 2 {
				key += "2"
			} else {
				key += "01"
			}
		}
		l, u, cr := c.param("li."+key+".L", 0), c.param("li."+key+".U", 0), c.param("li."+key+".C", 0)
		switch {
		case annual < l:
			gross = 0 // the credit equals the computed tax
		case annual < u && u > l:
			gross = math.Max(0, gross-(1-(annual-l)/(u-l))*cr)
		}
	}
	net := math.Max(0, gross-n*c.st.Income.Allowance.CreditPerAllowance)
	return c.withSupp(c.finishRegular(net / c.periods))
}

// ---------------------------------------------------------------------------
// Arizona: the employee's elected percentage (the status) of gross taxable
// wages, supplemental wages included; no annualization.

func arizona(c *sitCalc) float64 {
	rate := 0.0
	if len(c.stat.Brackets) > 0 {
		rate = c.stat.Brackets[0].Rate
	}
	wages := dollars(c.in.Wages) + dollars(c.in.Supplemental)
	if r := c.st.Income.SupplementalRate; r != nil {
		return dollars(c.in.Wages)*rate/100 + dollars(c.in.Supplemental)**r/100
	}
	return wages * rate / 100
}

// ---------------------------------------------------------------------------
// California Method B (annual method allowed by EDD): low income exemption on
// gross wages, estimated-deduction allowances ($1,000 each), standard deduction
// (married: 0-1 allowances single amount), tax rate table, exemption allowance
// credit per regular allowance. Supplemental (bonus) wages: bonus rate.

func california(c *sitCalc) float64 {
	wages := dollars(c.in.Wages)
	supp := dollars(c.in.Supplemental)
	rate := c.param("bonusRate", 0)
	if rate == 0 && c.st.Income.SupplementalRate != nil {
		rate = *c.st.Income.SupplementalRate
	}
	if rate == 0 { // no flat rate: aggregate with the regular wages
		wages, supp = wages+supp, 0
	}
	n := c.allowances()
	high := c.status == "head_of_household" || (c.status == "married" && n >= 2)
	tax := 0.0
	if wages > 0 {
		lieKey, lieAnnual := "lie.low", c.stat.LowIncomeExemption
		if high {
			lieKey = "lie.high"
		} else if c.status == "married" {
			lieAnnual = c.param("lieMarried01", lieAnnual)
		}
		var exempt bool
		if v, ok := c.params[fmt.Sprintf("%s.%d", lieKey, c.p)]; ok {
			exempt = wages <= v+1e-9
		} else {
			exempt = wages*c.periods <= lieAnnual+1e-9
		}
		if !exempt {
			est, _ := c.data("additionalAllowances")
			std := c.stat.StandardDeduction
			if c.status == "married" && n < 2 {
				std = c.param("stdMarried01", std)
			}
			taxable := math.Max(0, wages*c.periods-math.Max(0, est)*c.param("estDed", 1000)-std)
			t := bracketTax(c.stat.Brackets, taxable) - n*c.st.Income.Allowance.CreditPerAllowance
			tax = c.finishRegular(math.Max(0, t) / c.periods)
		}
	}
	return tax + supp*rate/100
}

// ---------------------------------------------------------------------------
// Colorado DR 1098: the generic model, except that a DR 0004 line 2 amount
// (StateW4.data.annualAllowance, even 0) replaces the default allowance.

func colorado(c *sitCalc) float64 {
	if v, ok := c.data("annualAllowance"); ok {
		return c.generic(genericOpts{stdOverride: &v})
	}
	return c.generic(genericOpts{})
}

// ---------------------------------------------------------------------------
// Connecticut TPG-211: Tables A-E driven by the annualized salary and the CT-W4
// withholding code. Code E: no withholding. No CT-W4: flat 6.99%.

func connecticut(c *sitCalc) float64 {
	wages := dollars(c.in.Wages) + dollars(c.in.Supplemental) // no supplemental rate: combined
	code := c.status
	switch code {
	case "E":
		return 0
	case "none":
		return wages * c.param("noFormRate", 6.99) / 100
	}
	s := wages * c.periods
	// Table A - personal exemption
	ex := 0.0
	if max := c.param("exA."+code+".max", 0); max > 0 {
		full, zero := c.param("exA."+code+".fullUpTo", 0), c.param("exA."+code+".zeroAbove", 0)
		switch {
		case s > zero:
			ex = 0
		case s <= full:
			ex = max
		default:
			ex = math.Max(0, max-1000*ceilDiv(s-full, 1000))
		}
	}
	ti := s - ex
	if ti <= 0 {
		return 0
	}
	tax := bracketTax(c.stat.Brackets, ti) // Table B
	// Table C - 2% phase-out add-back
	if start := c.param("pc."+code+".startAbove", math.Inf(1)); s > start {
		tax += math.Min(c.param("pc."+code+".max", 0), c.param("pc."+code+".addPerStep", 0)*ceilDiv(s-start, c.param("pc."+code+".step", 1)))
	}
	// Table D - recapture
	for i := 0; ; i++ {
		above, ok := c.params[fmt.Sprintf("rc.%s.%d.above", code, i)]
		if !ok {
			break
		}
		to, bounded := c.params[fmt.Sprintf("rc.%s.%d.to", code, i)]
		if s <= above || (bounded && s > to) {
			continue
		}
		first := c.param(fmt.Sprintf("rc.%s.%d.first", code, i), 0)
		if step := c.param(fmt.Sprintf("rc.%s.%d.step", code, i), 0); step > 0 {
			tax += first + c.param(fmt.Sprintf("rc.%s.%d.add", code, i), 0)*(ceilDiv(s-above, step)-1)
		} else {
			tax += first
		}
		break
	}
	// Table E - personal tax credit
	dec := 0.0
	for i := 0; ; i++ {
		over, ok := c.params[fmt.Sprintf("pcd.%s.%d.over", code, i)]
		if !ok {
			break
		}
		upTo, bounded := c.params[fmt.Sprintf("pcd.%s.%d.upTo", code, i)]
		if s > over && (!bounded || s <= upTo) {
			dec = c.param(fmt.Sprintf("pcd.%s.%d.dec", code, i), 0)
			break
		}
	}
	tax *= 1 - dec
	return c.finishRegular(tax / c.periods)
}

// ---------------------------------------------------------------------------
// Illinois IL-700-T automated payroll method: Line 1 allowances x $2,925 and
// Line 2 allowances (StateW4.data.additionalAllowances) x $1,000.

func illinois(c *sitCalc) float64 {
	n2, _ := c.data("additionalAllowances")
	return c.generic(genericOpts{extraDeduction: math.Max(0, n2) * c.param("additionalAllowance", 1000)})
}

// Indiana Departmental Notice #1: personal exemptions (allowances) $1,000,
// dependents and first-time dependents $1,500, adopted children $3,000.
func indiana(c *sitCalc) float64 {
	d1, _ := c.data("dependentExemptions")
	d2, _ := c.data("firstTimeDependentExemptions")
	d3, _ := c.data("adoptedDependentExemptions")
	extra := math.Max(0, d1)*c.param("dependent", 1500) + math.Max(0, d2)*c.param("firstTimeDependent", 1500) +
		math.Max(0, d3)*c.param("adopted", 3000)
	return c.generic(genericOpts{extraDeduction: extra})
}

// Virginia: E1 personal/dependent exemptions (allowances) x $930 and E2 age 65
// and blind exemptions (StateW4.data.ageBlindExemptions) x $800.
func virginia(c *sitCalc) float64 {
	e2, _ := c.data("ageBlindExemptions")
	return c.generic(genericOpts{extraDeduction: math.Max(0, e2) * c.param("ageBlind", 800)})
}

// ---------------------------------------------------------------------------
// Kansas KW-100 percentage formula: allowance amount per period (first one
// (single) or two (joint) allowances $9,160, others $2,320), then the
// period rate table (annual table / periods, thresholds to whole dollars).

func kansas(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	n := c.allowances()
	firstN := math.Min(n, c.param("firstCount."+c.status, 1))
	addN := math.Max(0, n-firstN)
	allow := round2(c.param("firstAllowance", 0)*firstN/c.periods) + addN*round2(c.param("additionalAllowance", 0)/c.periods)
	net := math.Max(0, wages-allow)
	sched := periodTable(shiftByStd(c.stat.Brackets, c.stat.StandardDeduction), c.periods)
	return c.withSupp(c.finishRegular(bracketTax(sched, net)))
}

// ---------------------------------------------------------------------------
// Massachusetts Circular M percentage method.

func massachusetts(c *sitCalc) float64 {
	wages := dollars(c.in.Wages)
	n := c.allowances()
	tax := 0.0
	if wages > 0 && !(n >= 1 && wages < c.perPeriod("lie", c.param("lie", 0))-1e-9) {
		// FICA / retirement deduction, cumulative maximum $2,000 a year
		fica, ytd := dollars(c.in.FICA), dollars(c.in.YTDFICA)
		if c.in.FICA == 0 && c.in.YTDFICA == 0 {
			fica = wages * 7.65 / 100
			ytd = dollars(c.in.YTDWages) * 7.65 / 100
			c.warn("Massachusetts: social security and Medicare withheld were not supplied; estimated at 7.65%% of wages for the $2,000 deduction.")
		}
		ded := math.Max(0, math.Min(fica, c.param("ficaCap", 2000)-ytd))
		var exf float64
		switch {
		case n == 1:
			exf = c.perPeriod("ex1", c.param("exFirst", 0))
		case n > 1:
			each := c.perPeriod("exEach", c.param("exEach", 0))
			base := c.perPeriod("exBase", c.param("exBase", 0))
			exf = each*n + base
		}
		annual := math.Max(0, wages-ded-exf) * c.periods
		t := bracketTax(c.stat.Brackets, annual) / c.periods
		if c.status == "head_of_household" {
			t -= c.perPeriod("hoh", c.param("hoh", 0))
		}
		if b, _ := c.data("blind"); b > 0 {
			t -= b * c.perPeriod("blind", c.param("blind", 0))
		}
		tax = c.finishRegular(t)
	}
	// supplemental: flat 5%, or the surtax rate on the part that brings annualized
	// regular + supplemental wages over the surtax threshold (Circular M section G)
	if supp := dollars(c.in.Supplemental); supp != 0 && c.st.Income.SupplementalRate != nil {
		rate := *c.st.Income.SupplementalRate
		if b := c.stat.Brackets; len(b) > 1 {
			thr, annual := b[len(b)-1].Over, wages*c.periods
			over := math.Max(0, annual+supp-thr) - math.Max(0, annual-thr)
			tax += over*b[len(b)-1].Rate/100 + (supp-over)*rate/100
		} else {
			tax += supp * rate / 100
		}
	}
	return tax
}

// ---------------------------------------------------------------------------
// Maryland percentage method: per-period standard deduction and exemptions,
// combined state + county table (the Comptroller table rate that equals or
// slightly exceeds the county rate), no withholding under the minimum.

func maryland(c *sitCalc) float64 {
	wages := dollars(c.in.Wages)
	supp := dollars(c.in.Supplemental)
	local, ok := c.data("localRate")
	if !ok || local <= 0 {
		local = c.param("localDefault", 3.3)
		c.warn("Maryland: the employee's county tax rate (state W-4 localRate) is not set; withheld with the %.2f%% local rate.", local)
	}
	tableRate := local
	best := math.Inf(1)
	for i := 0; ; i++ {
		r, ok := c.params[fmt.Sprintf("localTable.%d", i)]
		if !ok {
			break
		}
		if r >= local-1e-9 && r < best {
			best = r
		}
	}
	if !math.IsInf(best, 1) {
		tableRate = best
	}
	tax := 0.0
	if wages > 0 && wages >= c.perPeriod("lie", c.stat.LowIncomeExemption)-1e-9 {
		taxable := wages - c.perPeriod("std", c.stat.StandardDeduction) - c.allowances()*c.perPeriod("ex", c.st.Income.Allowance.DeductionPerAllowance)
		if taxable > 0 {
			rows := make([]model.Bracket, len(c.stat.Brackets))
			for i, r := range c.stat.Brackets {
				rows[i] = model.Bracket{Over: r.Over, Rate: r.Rate + tableRate}
			}
			_ = fillBases(rows)
			tax = c.finishRegular(bracketTax(periodTable(rows, c.periods), taxable))
		}
	}
	if supp != 0 && c.st.Income.SupplementalRate != nil {
		tax += supp * (*c.st.Income.SupplementalRate + tableRate) / 100
	}
	return tax
}

// ---------------------------------------------------------------------------
// Maine percentage method: standard deduction phased out between the
// thresholds (fraction rounded to 4 decimals), allowances, schedule, 2%
// surcharge over the threshold, result rounded to the dollar.

func maine(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	sk := "single"
	if c.status == "married" {
		sk = "married"
	}
	annual := wages * c.periods
	std := c.stat.StandardDeduction
	start, end, div := c.param("po."+sk+".start", math.Inf(1)), c.param("po."+sk+".end", math.Inf(1)), c.param("po."+sk+".divisor", 1)
	switch {
	case annual <= start:
	case annual >= end:
		std = 0
	default:
		f := math.Round((end-annual)/div*10000+1e-9) / 10000
		std = std * f
	}
	taxable := math.Max(0, annual-c.allowances()*c.st.Income.Allowance.DeductionPerAllowance-std)
	t := bracketTax(c.stat.Brackets, taxable)
	if rate, ok := c.params["surcharge"]; ok {
		if thr := c.param("surcharge."+sk, math.Inf(1)); taxable > thr {
			t += (taxable - thr) * rate / 100
		}
	}
	return c.withSupp(c.finishRegular(t / c.periods))
}

// ---------------------------------------------------------------------------
// New Jersey percentage method (NJ-WT + "Tables for Percentage Method of
// Withholding"): period wages minus the period allowance value (weekly $19.20,
// biweekly $38.40, ...) x NJ-W4 allowances, then the published table of that
// payroll period and rate (Params pt.<rate>.<periods>.<row>.over/base/rate; the
// period tables round their bases, so they are not the annual table divided).
// A period without a published table falls back to the annual table.

func newJersey(c *sitCalc) float64 {
	rows := c.periodRows()
	if rows == nil {
		return c.generic(genericOpts{})
	}
	wages, _, _, _ := c.split() // no supplemental flat rate: paid with regular wages, taxed together
	if wages <= 0 {
		return 0
	}
	n := c.allowances()
	if c.in.Wages <= 0 {
		n = 0 // supplemental wages paid at a different time: no exemption allowances (NJ-WT)
	}
	allow := c.perPeriod("allow", c.st.Income.Allowance.DeductionPerAllowance)
	return c.finishRegular(bracketTax(rows, wages-n*allow))
}

// periodRows returns the published table of the status for this payroll period
// (Params pt.<status>.<periods>.<i>.over/base/rate), nil when there is none.
func (c *sitCalc) periodRows() []model.Bracket {
	var rows []model.Bracket
	for i := 0; ; i++ {
		k := fmt.Sprintf("pt.%s.%d.%d.", c.status, c.p, i)
		rate, ok := c.params[k+"rate"]
		if !ok {
			break
		}
		rows = append(rows, model.Bracket{Over: c.params[k+"over"], Base: c.params[k+"base"], Rate: rate})
	}
	return rows
}

// ---------------------------------------------------------------------------
// New York NYS-50-T-NYS Method II (exact calculation) with the period tables
// (annual schedule / periods as printed), Table A deduction and exemption
// allowances, Method III for very high annualized net wages; quarterly and
// semiannual payrolls use the monthly table (conversion of tables).

func newYork(c *sitCalc) float64 {
	wages := dollars(c.in.Wages)
	tax := 0.0
	if wages > 0 {
		switch c.p {
		case 260, 52, 26, 24, 12, 1:
			tax = nyPeriod(c, wages, c.periods)
		default:
			m := 12 / c.periods // monthly amount (to the cent, as the table gives it) x factor
			tax = round2(nyPeriod(c, wages/m, 12)) * m
		}
		tax = c.finishRegular(tax)
	}
	return c.withSupp(tax)
}

func nyPeriod(c *sitCalc, wages, periods float64) float64 {
	p := int(periods)
	ded := c.params[fmt.Sprintf("ded.%s.%d", c.status, p)]
	ex := c.params[fmt.Sprintf("ex.%d", p)]
	net := wages - ded - c.allowances()*ex
	if net <= 0 {
		return 0
	}
	annual := net * periods
	if annual >= c.param("m3."+c.status, math.Inf(1))-1e-9 {
		rate := c.param("m3.rate1", 0)
		if annual >= c.param("m3.limit3", math.Inf(1)) {
			rate = c.param("m3.rate3", rate)
		} else if annual >= c.param("m3.limit2", math.Inf(1)) {
			rate = c.param("m3.rate2", rate)
		}
		return annual * rate / 100 / periods
	}
	return bracketTax(periodTable(c.stat.Brackets, periods), net)
}

// ---------------------------------------------------------------------------
// Oregon withholding tax formulas (150-206-436): BASE = wages - federal tax
// withheld (capped, phased out) - standard deduction; table below/above
// $50,000 of annual wages; $263 per allowance; allowances 0 above $100,000
// (single) / $200,000 (married).

func oregon(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	n := c.allowances()
	married := c.status == "married"
	table := "S"
	if married || ((c.status == "single" || c.status == "married_single") && n >= c.param("marriedTableAllowances", 3)) {
		table = "M"
	}
	po := "S"
	if married {
		po = "M"
	}
	annual := wages * c.periods
	fedCap := c.param("fedCap", 0)
	if annual >= c.param("highWage", 50000) {
		for i := 0; ; i++ {
			from, ok := c.params[fmt.Sprintf("po.%s.%d.from", po, i)]
			if !ok || annual < from {
				break
			}
			fedCap = c.param(fmt.Sprintf("po.%s.%d.cap", po, i), fedCap)
		}
	}
	fed := math.Min(dollars(c.in.FedWithholding)*c.periods, fedCap)
	std := c.st.Income.Statuses["single"].StandardDeduction
	if table == "M" {
		std = c.st.Income.Statuses["married"].StandardDeduction
	}
	base := math.Max(0, annual-fed-std)
	zeroAbove := c.param("allowZero.single", math.Inf(1))
	if married {
		zeroAbove = c.param("allowZero.married", math.Inf(1))
	}
	if annual > zeroAbove {
		n = 0
	}
	set := "low"
	if annual >= c.param("highWage", 50000) {
		set = "high"
	}
	wh := 0.0
	for i := 0; ; i++ {
		over, ok := c.params[fmt.Sprintf("%s.%s.%d.over", set, table, i)]
		if !ok {
			break
		}
		if i == 0 || base >= over {
			wh = c.param(fmt.Sprintf("%s.%s.%d.base", set, table, i), 0) + (base-over)*c.param(fmt.Sprintf("%s.%s.%d.rate", set, table, i), 0)/100
		}
	}
	wh -= n * c.st.Income.Allowance.CreditPerAllowance
	return c.withSupp(c.finishRegular(math.Max(0, wh) / c.periods))
}

// ---------------------------------------------------------------------------
// Rhode Island: generic, but the exemption amount is 0 when annual wages
// exceed the cliff ($290,800 for 2026).

func rhodeIsland(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	annual := wages * c.periods
	n := c.allowances()
	// the booklet compares the period wages with the cliff per period
	// (weekly wages more than $5,592.31 -> exemption $0)
	if cliff := c.param("exemptionCliff", math.Inf(1)); wages > round2(cliff/c.periods)+1e-9 {
		n = 0
	}
	taxable := math.Max(0, annual-n*c.st.Income.Allowance.DeductionPerAllowance)
	return c.withSupp(c.finishRegular(bracketTax(c.stat.Brackets, taxable) / c.periods))
}

// South Carolina WH-1603F: with 1+ allowances subtract $5,000 each and a
// standard deduction of 10% of annual wages (max $7,500); 0 allowances: none.
func southCarolina(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	annual := wages * c.periods
	n := c.allowances()
	ded := 0.0
	if n >= 1 {
		ded = n*c.st.Income.Allowance.DeductionPerAllowance + math.Min(annual*c.param("stdPct", 0)/100, c.param("stdMax", 0))
	}
	taxable := math.Max(0, annual-ded)
	return c.withSupp(c.finishRegular(bracketTax(c.stat.Brackets, taxable) / c.periods))
}

// ---------------------------------------------------------------------------
// Utah Pub 14 schedules: per-period constants (annual / periods to whole
// dollars), every line rounded to whole dollars as in the Pub 14 examples.

func utah(c *sitCalc) float64 {
	wages := dollars(c.in.Wages) + dollars(c.in.Supplemental)
	if wages <= 0 {
		return 0
	}
	k := "single"
	if c.status == "married" {
		k = "married"
	}
	rate := 0.0
	if len(c.stat.Brackets) > 0 {
		rate = c.stat.Brackets[0].Rate
	}
	baseAllow := roundDollar(c.param("base."+k, 0) / c.periods)
	thr := roundDollar(c.param("thr."+k, 0) / c.periods)
	line2 := roundDollar(wages * rate / 100)
	line4 := math.Max(0, roundDollar(wages-thr))
	line5 := roundDollar(line4 * c.param("reduction", 0) / 100)
	line6 := math.Max(0, baseAllow-line5)
	return math.Max(0, line2-line6)
}

// ---------------------------------------------------------------------------
// Wisconsin W-166 alternate method: deduction sliding down with annual gross
// earnings, $400 per exemption, rate schedule.

func wisconsin(c *sitCalc) float64 {
	wages, _, _, _ := c.split()
	if wages <= 0 {
		return c.withSupp(0)
	}
	k := "single"
	if c.status == "married" {
		k = "married"
	}
	annual := wages * c.periods
	max, start, zero := c.param("sd."+k+".max", 0), c.param("sd."+k+".start", 0), c.param("sd."+k+".zeroAt", 0)
	ded := 0.0
	switch {
	case annual < start:
		ded = max
	case annual >= zero:
		ded = 0
	default:
		ded = math.Max(0, max-c.param("sd."+k+".rate", 0)/100*(annual-start))
	}
	net := math.Max(0, annual-ded-c.allowances()*c.st.Income.Allowance.DeductionPerAllowance)
	return c.withSupp(c.finishRegular(bracketTax(c.stat.Brackets, net) / c.periods))
}
