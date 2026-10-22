// Package reports serves the payroll reports in the same
// ReportResult format as SerieX Books (row kinds section / data / subtotal /
// total / grandtotal / blank, levels, groups, "January 1 through October 17,
// 2026" labels), plus the Form 941 / 940 worksheets.
//
//	api.go         Register, the catalog and the report environment
//	params.go      query parameters, date presets (calendar based), labels, period columns
//	data.go        paychecks, adjustments, payments, items and employees loaded for a report
//	postings.go    the SerieX Books postings of payroll records (same rules as package posting)
//	summary.go     Payroll Summary, Employee Earnings Summary
//	detail.go      item detail, detail review, register, transactions by payee, transaction detail, state taxes
//	liab.go        Payroll Liability Balances
//	journal.go     Payroll Journal (SerieX Books postings)
//	lists.go       Employee Withholding, Paid Time Off List, Employee Contact List, Payroll Item Settings
//	worksheets.go  Form 941 and Form 940 worksheets
package reports

import (
	"context"
	"database/sql"
	"sort"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

// Report categories (Report Center / Reports menu order).
const (
	CatPayroll  = "Payroll and Employees"
	CatTaxForms = "Tax Forms"
)

// CategoryOrder is the Report Center category order.
var CategoryOrder = []string{CatPayroll, CatTaxForms}

// env is everything a report function needs.
type env struct {
	ctx  context.Context
	q    store.Q
	c    *httpx.Ctx // request (SerieX Books lookups, signed-in user); nil outside a request
	p    *Params
	lk   *posting.Lookups
	gseq int
	// revealed is set when a report printed full social security numbers (audited by the route).
	revealed    bool
	vendorCache map[int64]string
}

// Func builds one report.
type Func func(e *env) (*model.ReportResult, error)

type def struct {
	info model.ReportInfo
	fn   Func
	seq  int
}

var registry = map[string]*def{}

func register(info model.ReportInfo, fn Func) {
	if _, dup := registry[info.Key]; dup {
		panic("duplicate report key " + info.Key)
	}
	registry[info.Key] = &def{info: info, fn: fn, seq: len(registry)}
}

// Catalog lists every report in category order then catalog order.
func Catalog() []model.ReportInfo {
	rank := map[string]int{}
	for i, c := range CategoryOrder {
		rank[c] = i
	}
	defs := make([]*def, 0, len(registry))
	for _, d := range registry {
		defs = append(defs, d)
	}
	sort.Slice(defs, func(i, j int) bool {
		ri, ok := rank[defs[i].info.Category]
		if !ok {
			ri = 99
		}
		rj, ok := rank[defs[j].info.Category]
		if !ok {
			rj = 99
		}
		if ri != rj {
			return ri < rj
		}
		return defs[i].seq < defs[j].seq
	})
	out := make([]model.ReportInfo, len(defs))
	for i, d := range defs {
		out[i] = d.info
		if out[i].Params == nil {
			out[i].Params = []string{}
		}
	}
	return out
}

// Register adds GET /reports (catalog) and GET /reports/{key}.
func Register(rt *httpx.Router) {
	registerCatalog()
	rt.C("GET", "/reports", func(c *httpx.Ctx) error {
		return c.JSON(Catalog())
	})
	rt.C("GET", "/reports/{key}", func(c *httpx.Ctx) error {
		key := c.R.PathValue("key")
		d, ok := registry[key]
		if !ok {
			return apperr.NotFound("Unknown report %q", key)
		}
		p, err := ParseParams(c.Context(), c.DB, d.info, c.R.URL.Query())
		if err != nil {
			return err
		}
		e := &env{ctx: c.Context(), q: c.DB, c: c, p: p}
		res, err := run(e, d)
		if err != nil {
			return err
		}
		if e.revealed {
			// full social security numbers were printed (prefs.showSsnOnReports): audit trail
			if err := c.Write(func(tx *sql.Tx) error {
				return store.Audit(c.Context(), tx, c.User, "view_ssn", "report", 0,
					"Viewed social security numbers on the "+res.Title+" report", map[string]any{"report": key})
			}); err != nil {
				return err
			}
		}
		return c.JSON(res)
	})
}

func run(e *env, d *def) (*model.ReportResult, error) {
	res, err := d.fn(e)
	if err != nil {
		return nil, err
	}
	if res.Key == "" {
		res.Key = d.info.Key
	}
	if res.Params == nil {
		res.Params = e.p.Echo()
	}
	if res.Rows == nil {
		res.Rows = []model.ReportRow{}
	}
	return res, nil
}

// lookups returns the SerieX Books names (accounts, vendors, other names);
// empty maps when Books is unreachable or outside a request.
func (e *env) lookups() *posting.Lookups {
	if e.lk == nil {
		if e.c != nil {
			e.lk = posting.Lookup(e.c)
		}
		if e.lk == nil {
			e.lk = &posting.Lookups{}
		}
	}
	return e.lk
}

// vendorName is the SerieX Books name of an agency vendor; while Books is
// unreachable the name cached on the company's liability payments is used.
func (e *env) vendorName(id *int64) string {
	if id == nil {
		return ""
	}
	if n := e.lookups().VendorName(id); n != "" {
		return n
	}
	if e.vendorCache == nil {
		e.vendorCache = map[int64]string{}
		rows, err := e.q.QueryContext(e.ctx, `SELECT agency_vendor_id, agency_name FROM liability_payments
			WHERE agency_vendor_id IS NOT NULL AND agency_name != '' ORDER BY id`)
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var vid int64
				var name string
				if rows.Scan(&vid, &name) == nil {
					e.vendorCache[vid] = name
				}
			}
		}
	}
	return e.vendorCache[*id]
}

// group returns a new row group id ("g1", "g2"...) like SerieX Books.
func (e *env) group() string {
	e.gseq++
	return "g" + itoa(int64(e.gseq))
}
