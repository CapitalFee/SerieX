package taxes

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// SUIRate returns the company's state unemployment rate for a year: the rate
// saved in state_settings.ui_rates, else the state's new employer rate.
func SUIRate(ctx context.Context, q store.Q, st *model.StateTax, year int) float64 {
	if st == nil {
		return 0
	}
	var raw string
	if err := q.QueryRowContext(ctx, `SELECT ui_rates FROM state_settings WHERE state = ?`, st.State).Scan(&raw); err == nil {
		var m map[string]float64
		if json.Unmarshal([]byte(raw), &m) == nil {
			if v, ok := m[strconv.Itoa(year)]; ok {
				return v
			}
		}
	}
	return st.SUI.NewEmployerRate
}

// ProgramRate returns the employee or employer rate of a state program for the
// company: state_settings.other_rates[year][key] when set, else the table rate.
//
// other_rates keys: "<KEY>:EE" / "<KEY>:ER" set one side; a plain "<KEY>" sets
// the side the program has a rate for (the employer side when it has both).
// A program the table defines as a percent of the UI tax (Income.Params
// "programPctOfSui.<KEY>", e.g. the MN UI additional assessment) follows the
// company's UI rate when no rate is saved.
func ProgramRate(ctx context.Context, q store.Q, st *model.StateTax, year int, key string, employer bool) float64 {
	if st == nil {
		return 0
	}
	var prog *model.StateProgram
	for i := range st.Programs {
		if strings.EqualFold(st.Programs[i].Key, key) {
			prog = &st.Programs[i]
			break
		}
	}
	var raw string
	if err := q.QueryRowContext(ctx, `SELECT other_rates FROM state_settings WHERE state = ?`, st.State).Scan(&raw); err == nil {
		var m map[string]map[string]float64
		if json.Unmarshal([]byte(raw), &m) == nil {
			if rates, ok := m[strconv.Itoa(year)]; ok {
				side := ":EE"
				if employer {
					side = ":ER"
				}
				for k, v := range rates {
					if strings.EqualFold(k, key+side) {
						return v
					}
				}
				for k, v := range rates {
					if strings.EqualFold(k, key) {
						plainSide := employer
						if prog != nil {
							plainSide = prog.EmployerRate > 0 || prog.EmployeeRate == 0
						}
						if plainSide == employer {
							return v
						}
					}
				}
			}
		}
	}
	if prog == nil {
		return 0
	}
	if employer {
		if pct, ok := st.Income.Params["programPctOfSui."+prog.Key]; ok {
			return round6(SUIRate(ctx, q, st, year) * pct / 100)
		}
		return prog.EmployerRate
	}
	return prog.EmployeeRate
}

func round6(v float64) float64 {
	f, _ := strconv.ParseFloat(strconv.FormatFloat(v, 'f', 6, 64), 64)
	return f
}
