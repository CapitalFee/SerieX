package seriexmcp

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"
)

func (s *service) reportTools() []toolDef {
	var defs []toolDef
	type listReportsIn struct {
		companyArg
		Search string `json:"search,omitempty" jsonschema:"Only reports whose key, title, category or description contains this text."`
	}
	defs = append(defs, def(s, groupBooks, readTool, "list_reports", "List reports",
		"List the reports SerieX Books can run (key, title, what it shows and which options apply), grouped by category. Use a key with run_report.",
		nil, func(ctx context.Context, in listReportsIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			var cat []reportInfo
			if err := bk.get("/reports", nil, &cat); err != nil {
				return "", err
			}
			q := strings.ToLower(strings.TrimSpace(in.Search))
			var b strings.Builder
			cur := ""
			n := 0
			for _, r := range cat {
				if q != "" && !strings.Contains(strings.ToLower(r.Key+" "+r.Title+" "+r.Category+" "+r.Description), q) {
					continue
				}
				if r.Category != cur {
					cur = r.Category
					fmt.Fprintf(&b, "\n**%s**\n", cur)
				}
				n++
				line := fmt.Sprintf("- `%s` — %s", r.Key, r.Title)
				if r.Description != "" {
					line += ": " + short(r.Description, 140)
				}
				if opts := reportOptions(r.Params); opts != "" {
					line += " [" + opts + "]"
				}
				b.WriteString(line + "\n")
			}
			if n == 0 {
				return "No report matches.", nil
			}
			return fmt.Sprintf("%s:\n%s\nDates: give a preset in \"dates\" (for example thisMonthToDate, lastFiscalYear) or \"from\"/\"to\"; balance-type reports use \"as_of\".\n", plural(n, "report", "reports"), b.String()), nil
		}))

	type runReportIn struct {
		companyArg
		Key           string   `json:"key" jsonschema:"Report key from list_reports, for example profit_loss, balance_sheet, ar_aging_summary, sales_by_customer_summary."`
		Dates         string   `json:"dates,omitempty" jsonschema:"Date preset. Ignored when from or to is given. Default: the report's own default."`
		From          string   `json:"from,omitempty" jsonschema:"First date (YYYY-MM-DD or today). With from and no to, the report runs through today."`
		To            string   `json:"to,omitempty" jsonschema:"Last date (YYYY-MM-DD or today). Default with from: today."`
		AsOf          string   `json:"as_of,omitempty" jsonschema:"For balance and aging reports: the date to report on (YYYY-MM-DD or today)."`
		Basis         string   `json:"basis,omitempty" jsonschema:"accrual or cash. Default: the company preference."`
		Columns       string   `json:"columns,omitempty" jsonschema:"For reports that offer columns: total (default) or one column per month, quarter, year, week, class, customer, vendor or item."`
		AgingInterval int      `json:"aging_interval,omitempty" jsonschema:"Aging reports: days per aging column (default 30)."`
		Account       string   `json:"account,omitempty" jsonschema:"Only this account (reports with filters or an account option)."`
		Name          string   `json:"name,omitempty" jsonschema:"Only this customer (with jobs), vendor or other name."`
		Item          string   `json:"item,omitempty" jsonschema:"Only this item."`
		Class         string   `json:"class,omitempty" jsonschema:"Only this class."`
		Budget        string   `json:"budget,omitempty" jsonschema:"Budget name, for the budget reports."`
		Types         []string `json:"types,omitempty" jsonschema:"Only these transaction types (detail reports)."`
		Text          string   `json:"text,omitempty" jsonschema:"Only transactions whose number, memo or name contains this text (detail reports)."`
		MaxRows       int      `json:"max_rows,omitempty" jsonschema:"Most rows to show (default 200, at most 500); subtotals and totals are always shown."`
	}
	defs = append(defs, def(s, groupBooks, readTool, "run_report", "Run a report",
		"Run a SerieX Books report (profit and loss, balance sheet, aging, sales, purchases, banking, tax and more) and return it as a table with its totals. Use list_reports to find the key and its options. Vendor tax ID numbers are never shown.",
		func(sc *jsonschema.Schema) {
			enum(sc, "dates", datePresets...)
			enum(sc, "basis", "accrual", "cash")
			enum(sc, "columns", "total", "month", "quarter", "year", "week", "class", "customer", "vendor", "item")
			enum(sc, "types", txnTypeKeys()...)
		},
		func(ctx context.Context, in runReportIn) (string, error) {
			bk, err := s.open(ctx, in.Company, false)
			if err != nil {
				return "", err
			}
			var cat []reportInfo
			if err := bk.get("/reports", nil, &cat); err != nil {
				return "", err
			}
			key := strings.TrimSpace(in.Key)
			var info *reportInfo
			for i := range cat {
				if strings.EqualFold(cat[i].Key, key) || strings.EqualFold(cat[i].Title, key) {
					info = &cat[i]
					break
				}
			}
			if info == nil {
				var close []string
				for _, r := range cat {
					for _, w := range strings.FieldsFunc(strings.ToLower(key), func(r rune) bool { return r == '_' || r == ' ' || r == '-' }) {
						if len(w) >= 3 && strings.Contains(strings.ToLower(r.Key+" "+r.Title), w) {
							close = append(close, fmt.Sprintf("%s (%s)", r.Key, r.Title))
							break
						}
					}
					if len(close) == 12 {
						break
					}
				}
				msg := fmt.Sprintf("There is no report %q.", key)
				if len(close) > 0 {
					msg += " Similar reports: " + strings.Join(close, "; ") + "."
				}
				return "", userErr("%s Use list_reports to see every report.", msg)
			}
			q := url.Values{}
			from, err := parseDate("from", in.From)
			if err != nil {
				return "", err
			}
			to, err := parseDate("to", in.To)
			if err != nil {
				return "", err
			}
			asOf, err := parseDate("as_of", in.AsOf)
			if err != nil {
				return "", err
			}
			has := func(params ...string) bool {
				for _, p := range params {
					if containsStr(info.Params, p) {
						return true
					}
				}
				return false
			}
			var notes []string
			ignored := func(arg string) {
				notes = append(notes, fmt.Sprintf("%s does not apply to this report and was not used.", arg))
			}
			if from != "" || to != "" {
				if to == "" {
					to = today()
				}
				q.Set("from", from)
				q.Set("to", to)
			} else if in.Dates != "" {
				q.Set("dates", in.Dates)
			}
			if asOf != "" {
				if has("asOf") {
					q.Set("asOf", asOf)
					if from == "" && to == "" && in.Dates == "" {
						q.Set("to", asOf)
					}
				} else {
					ignored("as_of")
				}
			}
			if in.Basis != "" {
				if has("basis") {
					q.Set("basis", in.Basis)
				} else {
					ignored("basis")
				}
			}
			switch {
			case in.Columns != "" && has("columns"):
				q.Set("columns", in.Columns)
			case in.Columns != "":
				ignored("columns")
			case has("budgetId") && has("columns"):
				q.Set("columns", "total") // budget reports would default to one column per month
			}
			if in.AgingInterval != 0 {
				switch {
				case !has("agingInterval"):
					ignored("aging_interval")
				case in.AgingInterval < 1 || in.AgingInterval > 365:
					return "", userErr("aging_interval is the number of days per aging column, from 1 to 365.")
				default:
					q.Set("agingInterval", fmt.Sprint(in.AgingInterval))
				}
			}
			for _, f := range []struct{ arg, val, param string }{{"account", in.Account, "accountId"}, {"name", in.Name, "nameId"}, {"item", in.Item, "itemId"}, {"class", in.Class, "classId"}} {
				if f.val != "" && !has("filters", f.param) {
					ignored(f.arg)
				}
			}
			if (len(in.Types) > 0 || strings.TrimSpace(in.Text) != "") && !has("filters") {
				ignored("types/text")
			}
			if in.Budget != "" && !has("budgetId") {
				ignored("budget")
			}
			if in.Account != "" {
				ac, err := bk.findAccount(in.Account)
				if err != nil {
					return "", err
				}
				q.Set("accountIds", fmt.Sprint(ac.ID))
				q.Set("accountId", fmt.Sprint(ac.ID))
			}
			if in.Name != "" {
				n, err := bk.findName(in.Name)
				if err != nil {
					return "", err
				}
				q.Set("nameIds", fmt.Sprint(n.ID))
				q.Set("nameId", fmt.Sprint(n.ID))
			}
			if in.Item != "" {
				it, err := bk.findItem(in.Item)
				if err != nil {
					return "", err
				}
				q.Set("itemIds", fmt.Sprint(it.ID))
				q.Set("itemId", fmt.Sprint(it.ID))
			}
			if in.Class != "" {
				c, err := bk.findEntry("class", in.Class)
				if err != nil {
					return "", err
				}
				q.Set("classIds", fmt.Sprint(c.ID))
				q.Set("classId", fmt.Sprint(c.ID))
			}
			if in.Budget != "" {
				var budgets []struct {
					ID   int64  `json:"id"`
					Name string `json:"name"`
				}
				if err := bk.get("/budgets", nil, &budgets); err != nil {
					return "", err
				}
				found := false
				var names []string
				for _, x := range budgets {
					names = append(names, x.Name)
					if strings.EqualFold(strings.TrimSpace(x.Name), strings.TrimSpace(in.Budget)) {
						q.Set("budgetId", fmt.Sprint(x.ID))
						found = true
					}
				}
				if !found {
					if len(names) == 0 {
						return "", userErr("This company file has no budgets.")
					}
					return "", userErr("No budget is named %q. Budgets: %s.", in.Budget, strings.Join(names, "; "))
				}
			}
			if len(in.Types) > 0 {
				codes, err := txnCodes(in.Types)
				if err != nil {
					return "", err
				}
				q.Set("types", codes)
			}
			if s := strings.TrimSpace(in.Text); s != "" {
				q.Set("q", s)
			}
			var res reportResult
			if err := bk.get("/reports/"+url.PathEscape(info.Key), q, &res); err != nil {
				return "", err
			}
			hideTaxIDs(&res)
			out := renderReport(&res, clamp(in.MaxRows, 200, 1, maxReportRows))
			if len(notes) > 0 {
				out += "\nNote: " + strings.Join(notes, " ") + "\n"
			}
			return out, nil
		}))
	return defs
}

// reportOptions describes which run_report arguments a report uses.
func reportOptions(params []string) string {
	words := map[string]string{"dates": "dates", "asOf": "as_of", "basis": "basis", "columns": "columns",
		"accountId": "account", "nameId": "name", "itemId": "item", "classId": "class", "filters": "account/name/item/class/types/text filters",
		"budgetId": "budget", "agingInterval": "aging_interval"}
	var out []string
	for _, p := range params {
		if w, ok := words[p]; ok {
			out = append(out, w)
		}
	}
	return strings.Join(out, ", ")
}

// taxIDLabel matches the "(Tax ID ...)" a report adds to vendor names.
var taxIDLabel = regexp.MustCompile(`\s*\(Tax ID [^)]*\)`)

// hideTaxIDs removes vendor tax ID numbers (often social security numbers
// of sole proprietors) from a report.
func hideTaxIDs(r *reportResult) {
	dropColumn(r, "taxId")
	dropSensitiveColumns(r)
	for i := range r.Rows {
		for k, v := range r.Rows[i].Cells {
			if s, ok := v.(string); ok && strings.Contains(s, "Tax ID") {
				r.Rows[i].Cells[k] = taxIDLabel.ReplaceAllString(s, "")
			}
		}
	}
}
