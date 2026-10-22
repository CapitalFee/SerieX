// Package reports builds every report as a generic model.ReportResult.
//
// Each report file registers its reports from an init() function:
//
//	func init() {
//		register(model.ReportInfo{Key: "profit_loss", ...}, profitLoss)
//	}
//
// Extra (non report) routes are added with addRoutes(func(rt *httpx.Router){...}).
package reports

import (
	"context"
	"sort"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Func builds one report.
type Func func(ctx context.Context, q store.Q, p *Params) (*model.ReportResult, error)

type def struct {
	info model.ReportInfo
	fn   Func
	seq  int
}

var (
	registry   = map[string]*def{}
	routeHooks []func(rt *httpx.Router)
)

// CategoryOrder is the Report Center / Reports menu category order.
var CategoryOrder = []string{
	"Financial Statements",
	"Customers and Invoices",
	"Sales",
	"Jobs",
	"Vendors and Bills",
	"Purchases",
	"Inventory",
	"Banking",
	"For Your Accountant",
	"Budgets",
	"Lists",
	"Custom Reports",
}

// adminReports can be run by administrators only.
var adminReports = map[string]bool{"audit_trail": true}

func register(info model.ReportInfo, fn Func) {
	if _, dup := registry[info.Key]; dup {
		panic("duplicate report key " + info.Key)
	}
	registry[info.Key] = &def{info: info, fn: fn, seq: len(registry)}
}

func addRoutes(fn func(rt *httpx.Router)) { routeHooks = append(routeHooks, fn) }

// declaresFilters reports whether the report offers the standard filters
// ("filters" in its catalog parameters).
func declaresFilters(key string) bool {
	d := registry[key]
	if d == nil {
		return false
	}
	for _, p := range d.info.Params {
		if p == "filters" {
			return true
		}
	}
	return false
}

// Catalog lists every report in category order then registration order.
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
	}
	return out
}

// Run builds a report by key.
func Run(ctx context.Context, q store.Q, key string, p *Params) (*model.ReportResult, error) {
	d, ok := registry[key]
	if !ok {
		return nil, apperr.NotFound("Unknown report %q", key)
	}
	res, err := d.fn(ctx, q, p)
	if err != nil {
		return nil, err
	}
	if res.Rows == nil {
		res.Rows = []model.ReportRow{} // never null: the client shows "Nothing to show"
	}
	if res.Key == "" {
		res.Key = key
	}
	if res.Params == nil {
		res.Params = p.Echo()
	}
	return res, nil
}

// Register adds GET /reports (catalog), GET /reports/{key} and every extra route.
func Register(rt *httpx.Router) {
	rt.C("GET", "/reports", func(c *httpx.Ctx) error {
		return c.JSON(Catalog())
	})
	rt.C("GET", "/reports/{key}", func(c *httpx.Ctx) error {
		key := c.R.PathValue("key")
		d, ok := registry[key]
		if !ok {
			return apperr.NotFound("Unknown report %q", key)
		}
		if adminReports[key] {
			if err := store.RequireAdmin(c.Context(), c.DB, c.User, "Only an administrator can view the "+d.info.Title+" report."); err != nil {
				return err
			}
		}
		p, err := ParseParams(c.Context(), c.DB, d.info, c.R.URL.Query())
		if err != nil {
			return err
		}
		res, err := Run(c.Context(), c.DB, key, p)
		if err != nil {
			return err
		}
		return c.JSON(res)
	})
	for _, h := range routeHooks {
		h(rt)
	}
}
