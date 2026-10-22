package taxes

import (
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"path"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

//go:embed data/*.json data/announced/*.json
var dataFS embed.FS

// built-in tables, loaded and checked once at package init.
var (
	builtin   = map[int]*model.TaxYear{}
	years     []int
	announced = map[int]*announcedYear{}
	loadErr   error
	loadOnce  sync.Once
)

// announcedYear (data/announced/<year>.json) holds the federal values already
// fixed for a year that has no full tables yet (e.g. the 2027 social security
// wage base, announced by SSA in October 2026, before the IRS publishes the
// 2027 Pub 15-T). They are merged over the older tables used for that year.
type announcedYear struct {
	Year    int            `json:"year"`
	Federal map[string]any `json:"federal"`
	Sources []string       `json:"sources"`
	Notes   string         `json:"notes"`
}

func init() {
	ensureLoaded()
	if loadErr != nil {
		if testing.Testing() {
			panic(loadErr)
		}
		log.Printf("taxes: %v", loadErr)
	}
}

func ensureLoaded() {
	loadOnce.Do(func() { loadErr = loadAll() })
}

func loadAll() error {
	entries, err := dataFS.ReadDir("data")
	if err != nil {
		return fmt.Errorf("tax tables: %w", err)
	}
	var errs []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := dataFS.ReadFile(path.Join("data", e.Name()))
		if err != nil {
			errs = append(errs, err.Error())
			continue
		}
		ty, err := parseYear(raw)
		if err != nil {
			errs = append(errs, fmt.Sprintf("data/%s: %v", e.Name(), err))
			continue
		}
		if want := strings.TrimSuffix(e.Name(), ".json"); strconv.Itoa(ty.Year) != want {
			errs = append(errs, fmt.Sprintf("data/%s: year %d does not match the file name", e.Name(), ty.Year))
			continue
		}
		builtin[ty.Year] = ty
		years = append(years, ty.Year)
	}
	sort.Ints(years)
	if len(errs) > 0 {
		return errors.New("built-in tax tables are invalid: " + strings.Join(errs, "; "))
	}
	if len(years) == 0 {
		return errors.New("no built-in tax tables found")
	}
	return loadAnnounced()
}

// loadAnnounced reads data/announced/*.json. Every key must be a FederalTax
// field (limits: a key the built-in limits know), so a typo cannot be dropped
// silently, and the merged federal table must still pass checkFederal.
func loadAnnounced() error {
	entries, err := dataFS.ReadDir("data/announced")
	if err != nil {
		return fmt.Errorf("announced tax values: %w", err)
	}
	fields, err := toMap(model.FederalTax{})
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := dataFS.ReadFile(path.Join("data/announced", e.Name()))
		if err != nil {
			return err
		}
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.DisallowUnknownFields()
		var a announcedYear
		if err := dec.Decode(&a); err != nil {
			return fmt.Errorf("data/announced/%s: %w", e.Name(), err)
		}
		if want := strings.TrimSuffix(e.Name(), ".json"); strconv.Itoa(a.Year) != want {
			return fmt.Errorf("data/announced/%s: year %d does not match the file name", e.Name(), a.Year)
		}
		if _, ok := builtin[a.Year]; ok {
			continue // the full tables of that year exist: nothing to announce
		}
		use, _ := pickYear(a.Year)
		for k, v := range a.Federal {
			if _, ok := fields[k]; !ok || k == "year" {
				return fmt.Errorf("data/announced/%s: unknown federal field %q", e.Name(), k)
			}
			if k == "limits" {
				m, _ := v.(map[string]any)
				for lk := range m {
					if _, ok := builtin[use].Federal.Limits[lk]; !ok {
						return fmt.Errorf("data/announced/%s: unknown limit %q", e.Name(), lk)
					}
				}
			}
		}
		announced[a.Year] = &a
		probe := cloneYear(builtin[use])
		if err := applyAnnounced(probe, a.Year); err != nil {
			return fmt.Errorf("data/announced/%s: %w", e.Name(), err)
		}
		if err := checkFederal(&probe.Federal); err != nil {
			return fmt.Errorf("data/announced/%s: %w", e.Name(), err)
		}
	}
	return nil
}

// applyAnnounced adapts the federal table of an older year used for `year`:
// FUTA credit reduction rates belong to one year only, so they start empty, and
// the values already announced for `year` replace the older ones.
func applyAnnounced(ty *model.TaxYear, year int) error {
	if ty.Year == year {
		return nil
	}
	ty.Federal.CreditReduction = map[string]float64{}
	a := announced[year]
	if a == nil {
		return nil
	}
	f, err := mergeInto(ty.Federal, a.Federal)
	if err != nil {
		return err
	}
	// idempotent: companyTables applies it again after the older year's overrides
	f.Year = ty.Federal.Year
	f.Sources = append([]string(nil), ty.Federal.Sources...)
	for _, s := range a.Sources {
		if !slices.Contains(f.Sources, s) {
			f.Sources = append(f.Sources, s)
		}
	}
	if !strings.Contains(f.Notes, a.Notes) {
		f.Notes = strings.TrimSpace(a.Notes + " " + f.Notes)
	}
	ty.Federal = f
	return nil
}

// parseYear decodes one data file (unknown fields are rejected so a typo in the
// data cannot silently drop a value), checks the federal tables and fills the
// cumulative bases of marginal state schedules.
func parseYear(raw []byte) (*model.TaxYear, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var ty model.TaxYear
	if err := dec.Decode(&ty); err != nil {
		return nil, err
	}
	if ty.Year < 2000 || ty.Year > 2100 {
		return nil, fmt.Errorf("invalid year %d", ty.Year)
	}
	if ty.Federal.Year != ty.Year {
		return nil, fmt.Errorf("federal year %d differs from %d", ty.Federal.Year, ty.Year)
	}
	if err := checkFederal(&ty.Federal); err != nil {
		return nil, err
	}
	for code, st := range ty.States {
		if st.State != code {
			return nil, fmt.Errorf("state %s: code %q differs", code, st.State)
		}
		if err := prepareState(&st); err != nil {
			return nil, fmt.Errorf("state %s: %w", code, err)
		}
		ty.States[code] = st
	}
	if len(ty.States) != 51 {
		return nil, fmt.Errorf("%d states (50 states + DC expected)", len(ty.States))
	}
	return &ty, nil
}

// checkFederal verifies every Pub 15-T table: rows ascending from 0, and each
// column C (Base) equal to the previous row's Base plus its rate times the
// bracket width, within 0.01. The IRS prints half-dollar thresholds of the Step 2
// checkbox tables rounded up to the whole dollar (e.g. 108,937.50 -> 108,938) and
// computes column C from the unrounded threshold, so a row also passes when the
// recomputation from the unrounded (x.50) thresholds matches within 0.01.
func checkFederal(f *model.FederalTax) error {
	need := map[string][]string{
		"standard": {"single", "mfj", "hoh"},
		"checkbox": {"single", "mfj", "hoh"},
		"pre2020":  {"single", "married"},
	}
	tables := map[string]map[string][]model.Bracket{"standard": f.Standard, "checkbox": f.Checkbox, "pre2020": f.Pre2020}
	for _, name := range []string{"standard", "checkbox", "pre2020"} {
		for _, st := range need[name] {
			rows, ok := tables[name][st]
			if !ok || len(rows) == 0 {
				return fmt.Errorf("federal %d %s table %q is missing", f.Year, name, st)
			}
			if err := checkIRSBases(rows); err != nil {
				return fmt.Errorf("federal %d %s table %q: %w", f.Year, name, st, err)
			}
		}
	}
	if f.SSRate <= 0 || f.SSWageBase <= 0 || f.MedicareRate <= 0 || f.FUTARate <= 0 || f.FUTAWageBase <= 0 {
		return fmt.Errorf("federal %d: social security, Medicare and FUTA values are required", f.Year)
	}
	if f.SupplementalRate <= 0 || f.SupplementalOver1MRate <= 0 {
		return fmt.Errorf("federal %d: supplemental rates are required", f.Year)
	}
	return nil
}

func checkIRSBases(rows []model.Bracket) error {
	if rows[0].Over != 0 || rows[0].Base != 0 {
		return fmt.Errorf("row 1 must start at 0 with column C 0")
	}
	for i := 1; i < len(rows); i++ {
		p, r := rows[i-1], rows[i]
		if r.Over <= p.Over {
			return fmt.Errorf("row %d: thresholds are not ascending", i+1)
		}
		ok := false
		for _, dp := range []float64{0, 0.5} {
			for _, dr := range []float64{0, 0.5} {
				want := p.Base + ((r.Over-dr)-(p.Over-dp))*p.Rate/100
				if math.Abs(want-r.Base) <= 0.01+1e-9 {
					ok = true
				}
			}
		}
		if !ok {
			want := p.Base + (r.Over-p.Over)*p.Rate/100
			return fmt.Errorf("row %d (over %.2f): column C %.2f differs from the recomputed %.2f", i+1, r.Over, r.Base, want)
		}
	}
	return nil
}

// prepareState checks a state table and fills the bases of marginal schedules.
func prepareState(st *model.StateTax) error {
	if st.Programs == nil {
		st.Programs = []model.StateProgram{}
	}
	if st.Sources == nil {
		st.Sources = []string{}
	}
	if st.Income.Params == nil {
		st.Income.Params = map[string]float64{}
	}
	if st.Income.Statuses == nil {
		st.Income.Statuses = map[string]model.StateStatus{}
	}
	if !st.Income.Has {
		return nil
	}
	if len(st.Income.Statuses) == 0 {
		return fmt.Errorf("income tax without filing statuses")
	}
	if _, ok := st.Income.Statuses[st.Income.DefaultStatus]; !ok {
		return fmt.Errorf("default status %q is not one of the statuses", st.Income.DefaultStatus)
	}
	if st.Income.Special != "" && specials[st.Income.Special] == nil {
		return fmt.Errorf("no handler for special formula %q", st.Income.Special)
	}
	for key, s := range st.Income.Statuses {
		if err := fillBases(s.Brackets); err != nil {
			return fmt.Errorf("status %s: %w", key, err)
		}
		st.Income.Statuses[key] = s
	}
	return nil
}

// fillBases computes cumulative bases (rounded to cents at every row, the way the
// state agencies print them) when the data gives none; published bases are kept.
func fillBases(b []model.Bracket) error {
	given := false
	for i := range b {
		if i > 0 && b[i].Over <= b[i-1].Over {
			return fmt.Errorf("bracket %d: thresholds are not ascending", i+1)
		}
		if i > 0 && b[i].Base != 0 {
			given = true
		}
	}
	if given || len(b) == 0 {
		return nil
	}
	b[0].Base = 0
	for i := 1; i < len(b); i++ {
		b[i].Base = round2(b[i-1].Base + (b[i].Over-b[i-1].Over)*b[i-1].Rate/100)
	}
	return nil
}

// Years lists the calendar years that have built-in tables, ascending.
func Years() []int {
	ensureLoaded()
	return append([]int(nil), years...)
}

// Tables returns the built-in tables of a year. When the year has no data the
// latest earlier year is returned together with a warning text (wages paid in
// a year without tables are computed with the closest older tables).
func Tables(year int) (*model.TaxYear, string, error) {
	ensureLoaded()
	if loadErr != nil {
		return nil, "", loadErr
	}
	use, warn := pickYear(year)
	ty := cloneYear(builtin[use])
	if err := applyAnnounced(ty, year); err != nil {
		return nil, warn, err
	}
	if announced[year] != nil {
		warn = fmt.Sprintf("SerieX Payroll has no %d tax tables yet; the %d tables were used with the %d values announced so far (for example the social security wage base).", year, use, year)
	}
	return ty, warn, nil
}

func pickYear(year int) (int, string) {
	if _, ok := builtin[year]; ok {
		return year, ""
	}
	use := 0
	for _, y := range years {
		if y < year {
			use = y
		}
	}
	if use == 0 {
		use = years[0]
	}
	return use, fmt.Sprintf("SerieX Payroll has no %d tax tables yet; the %d tables were used.", year, use)
}

// ForCompany returns Tables(year) merged with the company's tax_overrides rows
// (federal and per-state JSON objects merged field by field over the built-in data).
func ForCompany(ctx context.Context, q store.Q, year int) (*model.TaxYear, string, error) {
	return companyTables(ctx, q, year)
}

type override struct {
	Scope string
	State string
	Data  map[string]any
	By    string
	At    string
}

func loadOverrides(ctx context.Context, q store.Q, year int) ([]override, error) {
	rows, err := q.QueryContext(ctx, `SELECT scope, state, data, updated_by, updated_at FROM tax_overrides WHERE year = ? ORDER BY scope, state`, year)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []override
	for rows.Next() {
		var o override
		var raw string
		if err := rows.Scan(&o.Scope, &o.State, &raw, &o.By, &o.At); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &o.Data); err != nil {
			return nil, fmt.Errorf("tax table override %d %s %s: %w", year, o.Scope, o.State, err)
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func applyOverride(ty *model.TaxYear, o override) error {
	switch o.Scope {
	case "federal":
		f, err := mergeInto(ty.Federal, o.Data)
		if err != nil {
			return fmt.Errorf("federal tax table override: %w", err)
		}
		ty.Federal = f
	case "state":
		st, ok := ty.States[o.State]
		if !ok {
			return nil // a state that no longer has tables: ignore
		}
		m, err := mergeInto(st, o.Data)
		if err != nil {
			return fmt.Errorf("%s tax table override: %w", o.State, err)
		}
		m.State = o.State
		if err := prepareState(&m); err != nil {
			return fmt.Errorf("%s tax table override: %w", o.State, err)
		}
		ty.States[o.State] = m
	}
	return nil
}

// mergeInto returns base with the JSON object over merged into it: object keys
// replace the built-in keys, nested objects are merged key by key, arrays and
// scalars are replaced.
func mergeInto[T any](base T, over map[string]any) (T, error) {
	var out T
	b, err := json.Marshal(base)
	if err != nil {
		return out, err
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		return out, err
	}
	mergeMaps(m, over)
	b, err = json.Marshal(m)
	if err != nil {
		return out, err
	}
	err = json.Unmarshal(b, &out)
	return out, err
}

func mergeMaps(dst, src map[string]any) {
	for k, v := range src {
		if sm, ok := v.(map[string]any); ok {
			if dm, ok := dst[k].(map[string]any); ok {
				mergeMaps(dm, sm)
				continue
			}
		}
		dst[k] = v
	}
}

// diffObject returns the keys of next that differ from base (objects compared
// key by key, arrays and scalars as a whole). nil when nothing differs.
func diffObject(base, next map[string]any) map[string]any {
	out := map[string]any{}
	for k, nv := range next {
		bv, ok := base[k]
		if ok {
			bm, bIsMap := bv.(map[string]any)
			nm, nIsMap := nv.(map[string]any)
			if bIsMap && nIsMap {
				if d := diffObject(bm, nm); d != nil {
					out[k] = d
				}
				continue
			}
			if jsonEqual(bv, nv) {
				continue
			}
		}
		out[k] = nv
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func jsonEqual(a, b any) bool {
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return bytes.Equal(ja, jb)
}

func toMap(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	err = json.Unmarshal(b, &m)
	return m, err
}

// ---------------------------------------------------------------------------
// deep copies (callers may change what they get)

func cloneYear(t *model.TaxYear) *model.TaxYear {
	c := *t
	c.Federal = cloneFederal(t.Federal)
	c.States = make(map[string]model.StateTax, len(t.States))
	for k, v := range t.States {
		c.States[k] = cloneState(v)
	}
	return &c
}

func cloneBrackets(b []model.Bracket) []model.Bracket {
	if b == nil {
		return nil
	}
	return append([]model.Bracket(nil), b...)
}

func cloneTables(m map[string][]model.Bracket) map[string][]model.Bracket {
	if m == nil {
		return nil
	}
	out := make(map[string][]model.Bracket, len(m))
	for k, v := range m {
		out[k] = cloneBrackets(v)
	}
	return out
}

func cloneFloats(m map[string]float64) map[string]float64 {
	if m == nil {
		return nil
	}
	out := make(map[string]float64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func clonePtr(p *float64) *float64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneFederal(f model.FederalTax) model.FederalTax {
	c := f
	c.CreditReduction = cloneFloats(f.CreditReduction)
	c.Standard = cloneTables(f.Standard)
	c.Checkbox = cloneTables(f.Checkbox)
	c.Pre2020 = cloneTables(f.Pre2020)
	c.Limits = cloneFloats(f.Limits)
	c.Sources = append([]string(nil), f.Sources...)
	return c
}

func cloneState(s model.StateTax) model.StateTax {
	c := s
	c.Income.SupplementalRate = clonePtr(s.Income.SupplementalRate)
	c.Income.Params = cloneFloats(s.Income.Params)
	c.Income.Statuses = make(map[string]model.StateStatus, len(s.Income.Statuses))
	for k, v := range s.Income.Statuses {
		v.Brackets = cloneBrackets(v.Brackets)
		c.Income.Statuses[k] = v
	}
	c.SUI.EmployeeWageBase = clonePtr(s.SUI.EmployeeWageBase)
	c.Programs = make([]model.StateProgram, len(s.Programs))
	for i, p := range s.Programs {
		p.WageBase = clonePtr(p.WageBase)
		p.MaxEmployee = clonePtr(p.MaxEmployee)
		p.MaxEmployeePerWeek = clonePtr(p.MaxEmployeePerWeek)
		c.Programs[i] = p
	}
	c.Sources = append([]string(nil), s.Sources...)
	return c
}
