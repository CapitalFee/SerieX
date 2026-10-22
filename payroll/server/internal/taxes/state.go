package taxes

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"seriexpayroll/internal/model"
)

// sitCalc carries one state withholding computation.
type sitCalc struct {
	st       *model.StateTax
	in       SITInput
	periods  float64
	p        int // periods as an integer (key of per-period constants)
	status   string
	stat     model.StateStatus
	params   map[string]float64
	warnings []string
}

// StateWithholding computes state income tax withholding for one paycheck
// with the state's tables (generic model or the Special handler), rounded to
// cents. warnings explain approximations (e.g. local taxes not computed).
func StateWithholding(st *model.StateTax, in SITInput) (tax int64, warnings []string) {
	if st == nil || !st.Income.Has || in.W4.Exempt {
		return 0, nil
	}
	if in.Wages <= 0 && in.Supplemental <= 0 {
		return 0, nil
	}
	// States that use the federal W-4 follow its exempt claim (CO DR 1098 rule 3:
	// zero unless the employee also filed a DR 0004, which replaces the W-4 amounts).
	if st.Income.UsesFederalW4 && in.FedW4.Exempt {
		if _, dr0004 := in.W4.Data["annualAllowance"]; !dr0004 {
			return 0, nil
		}
	}
	c := newCalc(st, in)
	var amt float64
	if h := specials[st.Income.Special]; st.Income.Special != "" && h != nil {
		amt = h(c)
	} else {
		if st.Income.Special != "" {
			c.warn("%s: no handler for the %q formula; the generic model was used.", st.State, st.Income.Special)
		}
		amt = c.generic(genericOpts{})
	}
	if in.Wages > 0 {
		amt += in.W4.ExtraWithholding // negative = CT-W4 line 3 / L-4 line 7 reduction
	}
	if amt < 0 {
		amt = 0
	}
	return roundCents(amt), c.warnings
}

func newCalc(st *model.StateTax, in SITInput) *sitCalc {
	c := &sitCalc{st: st, in: in, params: st.Income.Params}
	if c.params == nil {
		c.params = map[string]float64{}
	}
	c.p = in.PayPeriods
	if c.p <= 0 {
		c.p = 1
	}
	c.periods = float64(c.p)
	// daily/miscellaneous payrolls (260): some states annualize with their own
	// day count (VA and DE 300, MN 360, MD 364, LA 365); per-period constants
	// keep the ".260" key.
	if v := c.params["dailyPeriods"]; c.p == 260 && v > 0 {
		c.periods = v
	}
	c.status = c.resolveStatus()
	c.stat = st.Income.Statuses[c.status]
	return c
}

func (c *sitCalc) warn(format string, args ...any) {
	c.warnings = append(c.warnings, fmt.Sprintf(format, args...))
}

// resolveStatus: states that use the federal W-4 map its filing status
// (single / mfj / hoh); the others take the state W-4 status when it is one of
// the state's statuses, else the default status (the state's rule when no
// certificate is on file).
func (c *sitCalc) resolveStatus() string {
	inc := &c.st.Income
	if inc.UsesFederalW4 {
		fs := c.in.FedW4.FilingStatus
		var cands []string
		switch {
		case fs == "mfj" || (c.in.FedW4.Version == "pre2020" && fs == "married"):
			cands = []string{"mfj", "married_filing_jointly", "married", "joint"}
		case fs == "hoh":
			cands = []string{"hoh", "head_of_household", "head_of_family", "single"}
		default:
			cands = []string{"single"}
		}
		for _, k := range cands {
			if _, ok := inc.Statuses[k]; ok {
				return k
			}
		}
		return inc.DefaultStatus
	}
	key := strings.TrimSpace(c.in.W4.FilingStatus)
	if _, ok := inc.Statuses[key]; ok {
		return key
	}
	if key != "" {
		c.warn("%s filing status %q is not valid; %q was used.", c.st.Name, key, inc.DefaultStatus)
	}
	return inc.DefaultStatus
}

// allowances: the state W-4 count; states that use the federal W-4 take the
// allowances of a 2019-or-earlier federal W-4.
func (c *sitCalc) allowances() float64 {
	n := c.in.W4.Allowances
	if c.st.Income.UsesFederalW4 && c.in.FedW4.Version == "pre2020" {
		n = c.in.FedW4.Allowances
	}
	if n < 0 {
		n = 0
	}
	return float64(n)
}

// data returns a number entered in StateW4.Data (state specific inputs).
func (c *sitCalc) data(key string) (float64, bool) {
	v, ok := c.in.W4.Data[key]
	if !ok || v == nil {
		return 0, false
	}
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		s := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(t), "%"))
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

func (c *sitCalc) param(key string, def float64) float64 {
	if v, ok := c.params[key]; ok {
		return v
	}
	return def
}

// perPeriod returns params[key.<periods>] when the state publishes a value for
// this payroll period, else annual / periods.
func (c *sitCalc) perPeriod(key string, annual float64) float64 {
	if v, ok := c.params[fmt.Sprintf("%s.%d", key, c.p)]; ok {
		return v
	}
	return annual / c.periods
}

// split returns the regular wages taxed by the formula and the supplemental
// part withheld at a flat rate (dollars). States without a supplemental rate
// tax supplemental wages together with the regular wages.
func (c *sitCalc) split() (regular, supp float64, rate float64, flat bool) {
	regular = dollars(c.in.Wages)
	supp = dollars(c.in.Supplemental)
	if r := c.st.Income.SupplementalRate; r != nil {
		return regular, supp, *r, true
	}
	return regular + supp, 0, 0, false
}

func (c *sitCalc) suppTax(supp, rate float64) float64 { return supp * rate / 100 }

// finishRegular applies the per-period rounding rules of the generic model.
func (c *sitCalc) finishRegular(t float64) float64 {
	if t < 0 {
		t = 0
	}
	if c.param("roundDollar", 0) != 0 {
		t = roundDollar(t)
	}
	if m := c.param("minPeriodTax", 0); m > 0 && t < m-1e-9 {
		t = 0
	}
	return t
}

type genericOpts struct {
	stdOverride    *float64 // replaces the status standard deduction (CO DR 0004 line 2)
	extraDeduction float64  // annual deduction besides allowances (IL line 2, IN dependents, VA age/blind)
}

// generic is the general state withholding model: annualize, low income
// exemption, standard deduction, allowances, marginal brackets, credits,
// de-annualize, + supplemental at the state flat rate.
func (c *sitCalc) generic(o genericOpts) float64 {
	inc := &c.st.Income
	regular, supp, srate, flat := c.split()
	tax := 0.0
	if regular > 0 {
		annual := regular * c.periods
		if lie := c.stat.LowIncomeExemption; lie > 0 && annual <= lie+1e-9 {
			tax = 0
		} else {
			n := c.allowances()
			ded, cred := 0.0, 0.0
			if inc.Allowance.Kind != "none" {
				ded = n * inc.Allowance.DeductionPerAllowance
				cred = n * inc.Allowance.CreditPerAllowance
			}
			std := c.stat.StandardDeduction
			if o.stdOverride != nil {
				std = *o.stdOverride
			}
			taxable := math.Max(0, annual-std-ded-o.extraDeduction)
			t := bracketTax(c.stat.Brackets, taxable) - cred
			tax = math.Max(0, t) / c.periods
		}
		tax = c.finishRegular(tax)
	}
	if flat {
		tax += c.suppTax(supp, srate)
	}
	return tax
}

// ---------------------------------------------------------------------------
// schedules

// shiftByStd turns "standard deduction + brackets" into one schedule on gross
// annual wages with a 0% band for the deduction (bases recomputed).
func shiftByStd(rows []model.Bracket, std float64) []model.Bracket {
	var out []model.Bracket
	if std > 0 {
		out = append(out, model.Bracket{Over: 0, Rate: 0})
	}
	for _, r := range rows {
		out = append(out, model.Bracket{Over: r.Over + std, Rate: r.Rate})
	}
	for i := 1; i < len(out); i++ {
		out[i].Base = round2(out[i-1].Base + (out[i].Over-out[i-1].Over)*out[i-1].Rate/100)
	}
	return out
}

// periodTable derives a payroll-period table from an annual schedule the way
// NY (NYS-50-T), Kansas (KW-100) and Maryland print theirs: thresholds =
// annual / periods rounded to whole dollars, amounts = annual base / periods
// rounded to cents, same rates.
func periodTable(rows []model.Bracket, periods float64) []model.Bracket {
	if periods == 1 {
		return rows
	}
	out := make([]model.Bracket, len(rows))
	for i, r := range rows {
		out[i] = model.Bracket{Over: roundDollar(r.Over / periods), Base: round2(r.Base / periods), Rate: r.Rate}
	}
	return out
}
