package setup

import (
	"sort"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/taxes"
)

// AppVersion is reported by GET /api/info.
const AppVersion = "2026.10.3"

// stateNames are the 50 states and DC (payroll work states).
var stateNames = map[string]string{
	"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
	"CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia",
	"HI": "Hawaii", "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
	"KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts",
	"MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
	"NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico",
	"NY": "New York", "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
	"OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
	"TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
	"WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

func stateName(code string) string { return stateNames[code] }

var frequencyOrder = []string{
	model.FreqDaily, model.FreqWeekly, model.FreqBiweekly, model.FreqSemimonthly,
	model.FreqMonthly, model.FreqQuarterly, model.FreqSemiannually, model.FreqAnnually,
}

var taxCodeOrder = []string{
	model.TaxFIT, model.TaxSSEE, model.TaxSSER, model.TaxMedEE, model.TaxMedER, model.TaxAddlMed, model.TaxFUTA,
	model.TaxSIT, model.TaxSUIER, model.TaxSUIEE, model.TaxStateEE, model.TaxStateER, model.TaxLocalEE, model.TaxLocalER,
}

// taxab builds a taxability map: the listed wage bases true, the others false.
func taxab(bases ...string) map[string]bool {
	m := map[string]bool{}
	for _, b := range model.WageBases {
		m[b] = false
	}
	for _, b := range bases {
		m[b] = true
	}
	return m
}

var allBases = model.WageBases

// taxTracking is the default taxability of each tax treatment. For
// deductions true means "pre-tax for that wage base"; for
// earnings, additions and contributions it means "counts as wages".
func taxTracking() []model.TaxTrackingType {
	wages := []string{model.ItemSalary, model.ItemHourly, model.ItemOvertime, model.ItemBonus, model.ItemCommission}
	compTypes := append(append([]string{}, wages...), model.ItemAddition, model.ItemContribution)
	deferral := taxab(model.BaseFIT, model.BaseSIT, model.BaseLOCAL)
	d := []string{model.ItemDeduction}
	return []model.TaxTrackingType{
		{Key: model.TrackCompensation, Label: "Wages (taxed as pay)", ItemTypes: compTypes, Taxability: taxab(allBases...)},
		{Key: model.TrackNone, Label: "Not wages (not on the W-2)", ItemTypes: []string{model.ItemAddition}, Taxability: taxab()},
		{Key: model.TrackReportedTips, Label: "Cash tips the employee reported", ItemTypes: []string{model.ItemReportedTips}, Taxability: taxab(allBases...)},
		{Key: model.TrackPaidTips, Label: "Tips paid on the paycheck", ItemTypes: []string{model.ItemTips}, Taxability: taxab(allBases...)},
		{Key: model.TrackOvertime, Label: "Qualified overtime (W-2 code TT)", ItemTypes: []string{model.ItemOvertime}, W2Box12: "TT", Taxability: taxab(allBases...)},
		{Key: model.Track401k, Label: "401(k)", ItemTypes: d, W2Box12: "D", Taxability: copyMap(deferral)},
		{Key: model.Track403b, Label: "403(b)", ItemTypes: d, W2Box12: "E", Taxability: copyMap(deferral)},
		{Key: model.Track457b, Label: "457(b)", ItemTypes: d, W2Box12: "G", Taxability: copyMap(deferral)},
		{Key: model.TrackSimpleIRA, Label: "SIMPLE IRA", ItemTypes: d, W2Box12: "S", Taxability: copyMap(deferral)},
		{Key: model.TrackRoth401k, Label: "Roth 401(k)", ItemTypes: d, W2Box12: "AA", Taxability: taxab()},
		// Company retirement contributions: not wages, no box 12 code; they mark W-2 box 13 "Retirement plan".
		{Key: model.Track401k, Label: "401(k) company contribution", ItemTypes: []string{model.ItemContribution}, Taxability: taxab()},
		{Key: model.Track403b, Label: "403(b) company contribution", ItemTypes: []string{model.ItemContribution}, Taxability: taxab()},
		{Key: model.Track457b, Label: "457(b) company contribution", ItemTypes: []string{model.ItemContribution}, Taxability: taxab()},
		{Key: model.TrackSimpleIRA, Label: "SIMPLE IRA company contribution", ItemTypes: []string{model.ItemContribution}, Taxability: taxab()},
		{Key: model.TrackRoth403b, Label: "Roth 403(b)", ItemTypes: d, W2Box12: "BB", Taxability: taxab()},
		{Key: model.Track125, Label: "Section 125 health premium (pre-tax)", ItemTypes: d, Taxability: taxab(allBases...)},
		{Key: model.TrackHSA, Label: "HSA, employee pre-tax (section 125)", ItemTypes: d, W2Box12: "W", Taxability: taxab(allBases...)},
		{Key: model.TrackHSA, Label: "HSA, company contribution", ItemTypes: []string{model.ItemContribution}, W2Box12: "W", Taxability: taxab()},
		{Key: model.TrackDependentCare, Label: "Dependent care FSA (W-2 box 10)", ItemTypes: d, Taxability: taxab(allBases...)},
		{Key: model.TrackHealthCoverage, Label: "Cost of health coverage (W-2 code DD)", ItemTypes: []string{model.ItemContribution}, W2Box12: "DD", Taxability: taxab()},
		{Key: model.TrackGroupTermLife, Label: "Group-term life insurance", ItemTypes: []string{model.ItemContribution}, W2Box12: "C", Taxability: taxab(model.BaseSS, model.BaseMED)},
		{Key: model.TrackFringe, Label: "Taxable fringe benefit", ItemTypes: []string{model.ItemAddition, model.ItemContribution}, Taxability: taxab(allBases...)},
		{Key: model.TrackOther, Label: "Other (after tax)", ItemTypes: d, Taxability: taxab()},
	}
}

func copyMap(m map[string]bool) map[string]bool {
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// box12Codes: Form W-2 box 12 codes (2026 instructions, incl. the new TA, TP, TT codes).
var box12Codes = []model.Option{
	{Value: "A", Label: "A - Uncollected social security or RRTA tax on tips"},
	{Value: "B", Label: "B - Uncollected Medicare tax on tips"},
	{Value: "C", Label: "C - Taxable cost of group-term life insurance over $50,000"},
	{Value: "D", Label: "D - Elective deferrals to a section 401(k) plan"},
	{Value: "E", Label: "E - Elective deferrals under a section 403(b) plan"},
	{Value: "F", Label: "F - Elective deferrals under a section 408(k)(6) SEP"},
	{Value: "G", Label: "G - Elective deferrals and employer contributions to a section 457(b) plan"},
	{Value: "H", Label: "H - Elective deferrals to a section 501(c)(18)(D) plan"},
	{Value: "J", Label: "J - Nontaxable sick pay"},
	{Value: "K", Label: "K - 20% excise tax on excess golden parachute payments"},
	{Value: "L", Label: "L - Substantiated employee business expense reimbursements"},
	{Value: "M", Label: "M - Uncollected social security or RRTA tax on group-term life over $50,000"},
	{Value: "N", Label: "N - Uncollected Medicare tax on group-term life over $50,000"},
	{Value: "P", Label: "P - Excludable moving expense reimbursements (Armed Forces)"},
	{Value: "Q", Label: "Q - Nontaxable combat pay"},
	{Value: "R", Label: "R - Employer contributions to an Archer MSA"},
	{Value: "S", Label: "S - Employee salary reduction contributions to a SIMPLE plan"},
	{Value: "T", Label: "T - Adoption benefits"},
	{Value: "V", Label: "V - Income from exercise of nonstatutory stock options"},
	{Value: "W", Label: "W - Employer contributions to a health savings account (HSA)"},
	{Value: "Y", Label: "Y - Deferrals under a section 409A nonqualified deferred compensation plan"},
	{Value: "Z", Label: "Z - Income under a nonqualified deferred compensation plan that fails section 409A"},
	{Value: "AA", Label: "AA - Designated Roth contributions to a section 401(k) plan"},
	{Value: "BB", Label: "BB - Designated Roth contributions to a section 403(b) plan"},
	{Value: "DD", Label: "DD - Cost of employer-sponsored health coverage"},
	{Value: "EE", Label: "EE - Designated Roth contributions to a governmental section 457(b) plan"},
	{Value: "FF", Label: "FF - Permitted benefits under a QSEHRA"},
	{Value: "GG", Label: "GG - Income from qualified equity grants under section 83(i)"},
	{Value: "HH", Label: "HH - Aggregate deferrals under section 83(i) elections"},
	{Value: "II", Label: "II - Medicaid waiver payments excluded from gross income"},
	{Value: "TA", Label: "TA - Employer contributions to a Trump account (section 128)"},
	{Value: "TP", Label: "TP - Total cash tips reported to the employer"},
	{Value: "TT", Label: "TT - Total qualified overtime compensation"},
}

func buildMeta() model.Meta {
	m := model.Meta{
		ItemTypes:   []model.Option{},
		TaxCodes:    []model.Option{},
		Frequencies: []model.Option{},
		TaxTracking: taxTracking(),
		Box12Codes:  box12Codes,
		FedStatus2020: []model.Option{
			{Value: "single", Label: "Single or Married filing separately"},
			{Value: "mfj", Label: "Married filing jointly or Qualifying surviving spouse"},
			{Value: "hoh", Label: "Head of household"},
		},
		FedStatusPre2020: []model.Option{
			{Value: "single", Label: "Single"},
			{Value: "married", Label: "Married"},
			{Value: "married_single", Label: "Married, but withhold at higher Single rate"},
		},
	}
	for _, t := range model.ItemTypeOrder {
		m.ItemTypes = append(m.ItemTypes, model.Option{Value: t, Label: model.ItemTypeLabels[t]})
	}
	for _, c := range taxCodeOrder {
		m.TaxCodes = append(m.TaxCodes, model.Option{Value: c, Label: model.TaxCodeLabels[c]})
	}
	for _, f := range frequencyOrder {
		m.Frequencies = append(m.Frequencies, model.Option{Value: f, Label: model.FrequencyLabels[f]})
	}
	states, years := taxes.Meta()
	if len(states) == 0 {
		// tax tables not available: still offer the state list
		for code, name := range stateNames {
			states = append(states, model.StateInfo{Code: code, Name: name, FilingStatuses: []model.Option{}, Programs: []model.Option{}})
		}
		sort.Slice(states, func(i, j int) bool { return states[i].Name < states[j].Name })
	}
	if years == nil {
		years = taxes.Years()
	}
	if years == nil {
		years = []int{}
	}
	m.States, m.TaxYears = states, years
	return m
}
