package taxes

import (
	"sort"
	"strings"
	"time"

	"seriexpayroll/internal/model"
)

// Meta returns the static lists for GET /api/meta that come from the tax tables
// (states with filing statuses and programs, tax years).
func Meta() ([]model.StateInfo, []int) {
	ty, _, err := Tables(time.Now().Year())
	if err != nil {
		return nil, Years()
	}
	out := make([]model.StateInfo, 0, len(ty.States))
	for code, st := range ty.States {
		info := model.StateInfo{
			Code:           code,
			Name:           st.Name,
			HasIncomeTax:   st.Income.Has,
			FilingStatuses: statusOptions(&st),
			StateForm:      st.Income.StateForm,
			Programs:       []model.Option{},
			HasEmployeeSUI: st.SUI.EmployeeRate > 0,
			Inputs:         append([]model.Option{}, stateInputs[st.Income.Special]...),
		}
		for _, p := range st.Programs {
			info.Programs = append(info.Programs, model.Option{Value: p.Key, Label: p.Name})
		}
		var notes []string
		if st.Income.Has {
			if st.Income.UsesFederalW4 {
				notes = append(notes, "Filing status comes from the employee's federal Form W-4 (single, married filing jointly, head of household).")
			}
			if st.Income.Allowance.Notes != "" {
				notes = append(notes, st.Income.Allowance.Notes)
			}
		} else {
			notes = append(notes, "No state income tax withholding on wages.")
		}
		info.Notes = strings.Join(notes, " ")
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, Years()
}

// statusOptions lists the filing statuses in the order given by the data
// (Params "order.<key>"), default status first when no order is given.
func statusOptions(st *model.StateTax) []model.Option {
	keys := make([]string, 0, len(st.Income.Statuses))
	for k := range st.Income.Statuses {
		keys = append(keys, k)
	}
	ord := func(k string) float64 {
		if v, ok := st.Income.Params["order."+k]; ok {
			return v
		}
		if k == st.Income.DefaultStatus {
			return -1
		}
		return 1000
	}
	sort.Slice(keys, func(i, j int) bool {
		if oi, oj := ord(keys[i]), ord(keys[j]); oi != oj {
			return oi < oj
		}
		return keys[i] < keys[j]
	})
	out := make([]model.Option, 0, len(keys))
	for _, k := range keys {
		label := st.Income.Statuses[k].Label
		if label == "" {
			label = k
		}
		out = append(out, model.Option{Value: k, Label: label})
	}
	return out
}
