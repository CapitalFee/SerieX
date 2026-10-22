package forms

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Tax Forms window / Payroll Center "Tax Forms" tab: every form period with
// wages (941 per quarter, 940 and W-2/W-3 per year, the state wage report per
// state with unemployment wages and quarter) plus every saved filing, with
// the status (new / draft / filed) and the due date.

var formRank = map[string]int{"941": 0, "STATE-UI": 1, "940": 2, "W-2": 3}

func filingsRoute(c *httpx.Ctx) error {
	list, err := Filings(c.Context(), c.DB)
	if err != nil {
		return err
	}
	if y := int(c.QInt("year")); y > 0 {
		out := []model.FormFiling{}
		for _, f := range list {
			if f.Year == y {
				out = append(out, f)
			}
		}
		list = out
	}
	return c.JSON(list)
}

// Filings returns the forms to file with their status and due date.
func Filings(ctx context.Context, q store.Q) ([]model.FormFiling, error) {
	type key struct {
		form   string
		year   int
		period string
		state  string
	}
	m := map[key]*model.FormFiling{}
	add := func(form string, year int, period, state string) *model.FormFiling {
		k := key{form, year, period, state}
		if f := m[k]; f != nil {
			return f
		}
		f := &model.FormFiling{Form: form, Year: year, Period: period, State: state, Status: "new"}
		m[k] = f
		return f
	}

	// quarters with paychecks
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT substr(check_date, 1, 4), (CAST(substr(check_date, 6, 2) AS INTEGER) + 2) / 3
		FROM paychecks WHERE voided = 0 AND gross <> 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ys string
		var qtr int
		if err := rows.Scan(&ys, &qtr); err != nil {
			return nil, err
		}
		y, _ := strconv.Atoi(ys)
		if y == 0 || qtr < 1 || qtr > 4 {
			continue
		}
		add("941", y, fmt.Sprintf("Q%d", qtr), "")
		add("940", y, "Y", "")
		add("W-2", y, "Y", "")
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()

	// state unemployment wages by state and quarter
	srows, err := q.QueryContext(ctx, `SELECT DISTINCT substr(p.check_date, 1, 4), (CAST(substr(p.check_date, 6, 2) AS INTEGER) + 2) / 3, upper(i.state)
		FROM paychecks p JOIN paycheck_lines l ON l.paycheck_id = p.id JOIN payroll_items i ON i.id = l.item_id
		WHERE p.voided = 0 AND i.tax_code IN ('SUI_ER', 'SUI_EE') AND i.state <> '' AND (l.subject_wages <> 0 OR l.wage_base <> 0)`)
	if err != nil {
		return nil, err
	}
	defer srows.Close()
	for srows.Next() {
		var ys, st string
		var qtr int
		if err := srows.Scan(&ys, &qtr, &st); err != nil {
			return nil, err
		}
		y, _ := strconv.Atoi(ys)
		if y == 0 || qtr < 1 || qtr > 4 {
			continue
		}
		add("STATE-UI", y, fmt.Sprintf("Q%d", qtr), st)
	}
	if err := srows.Err(); err != nil {
		return nil, err
	}
	srows.Close()

	// saved filings
	frows, err := q.QueryContext(ctx, `SELECT id, form, year, period, state, status, filed_at, updated_at FROM form_filings`)
	if err != nil {
		return nil, err
	}
	defer frows.Close()
	for frows.Next() {
		var f model.FormFiling
		if err := frows.Scan(&f.ID, &f.Form, &f.Year, &f.Period, &f.State, &f.Status, &f.FiledAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		x := add(f.Form, f.Year, f.Period, f.State)
		x.ID, x.Status, x.FiledAt, x.UpdatedAt = f.ID, f.Status, f.FiledAt, f.UpdatedAt
	}
	if err := frows.Err(); err != nil {
		return nil, err
	}

	out := make([]model.FormFiling, 0, len(m))
	for _, f := range m {
		switch f.Form {
		case "941":
			qtr := periodQuarter(f.Period)
			_, end := store.QuarterRange(f.Year, qtr)
			f.DueDate = liabilities.DueDate(model.GroupFederal940, model.PayFreqQuarterly, end)
			f.Title = fmt.Sprintf("Quarterly Form 941/Sch. B - Employer's Quarterly Federal Tax Return (Q%d %d)", qtr, f.Year)
		case "940":
			f.DueDate = liabilities.DueDate(model.GroupFederal940, model.PayFreqAnnually, fmt.Sprintf("%04d-12-31", f.Year))
			f.Title = fmt.Sprintf("Annual Form 940/Sch. A - Employer's Annual Federal Unemployment (FUTA) Tax Return (%d)", f.Year)
		case "W-2":
			f.DueDate = liabilities.DueDate(model.GroupFederal940, model.PayFreqAnnually, fmt.Sprintf("%04d-12-31", f.Year))
			f.Title = fmt.Sprintf("Annual Form W-2/W-3 - Wage and Tax Statement/Transmittal (%d)", f.Year)
		case "STATE-UI":
			qtr := periodQuarter(f.Period)
			_, end := store.QuarterRange(f.Year, qtr)
			f.DueDate = stateReportDue(f.State, end)
			f.Title = fmt.Sprintf("%s %s (Q%d %d)", f.State, reportName(f.State), qtr, f.Year)
		default:
			f.Title = fmt.Sprintf("%s %s %d", f.Form, f.Period, f.Year)
		}
		out = append(out, *f)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.DueDate != b.DueDate {
			return a.DueDate < b.DueDate
		}
		if formRank[a.Form] != formRank[b.Form] {
			return formRank[a.Form] < formRank[b.Form]
		}
		return strings.Compare(a.State, b.State) < 0
	})
	return out, nil
}

func periodQuarter(p string) int {
	if len(p) == 2 && p[0] == 'Q' {
		if n, err := strconv.Atoi(p[1:]); err == nil && n >= 1 && n <= 4 {
			return n
		}
	}
	return 4
}
