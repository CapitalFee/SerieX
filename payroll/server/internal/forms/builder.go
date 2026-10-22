package forms

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// formData is form_filings.data: the values the user typed over the
// computed ones (overrides keyed "line" or "line:col"), text fields, check
// boxes, and the snapshot of the form saved when it was marked as filed.
type formData struct {
	Overrides map[string]float64 `json:"overrides"`
	Texts     map[string]string  `json:"texts"`
	Checks    map[string]bool    `json:"checks"`
	// W-2/W-3 only
	Reviewed        []int64             `json:"reviewed,omitempty"`
	OccupationCodes map[string][]string `json:"occupationCodes,omitempty"` // employee id -> box 14b Treasury Tipped Occupation Codes
	Snapshot        json.RawMessage     `json:"snapshot,omitempty"`
}

type filing struct {
	id        int64
	status    string // draft | filed
	filedAt   string
	updatedAt string
	data      formData
}

func emptyData() *formData {
	return &formData{Overrides: map[string]float64{}, Texts: map[string]string{}, Checks: map[string]bool{}}
}

// loadFiling reads the saved filing of a form period (nil when never saved).
func loadFiling(ctx context.Context, q store.Q, form string, year int, period, state string) (*filing, error) {
	f := &filing{}
	var raw string
	err := q.QueryRowContext(ctx, `SELECT id, status, filed_at, updated_at, data FROM form_filings
		WHERE form = ? AND year = ? AND period = ? AND state = ?`, form, year, period, state).Scan(&f.id, &f.status, &f.filedAt, &f.updatedAt, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &f.data); err != nil {
			return nil, fmt.Errorf("saved form %s %d %s: %w", form, year, period, err)
		}
	}
	if f.data.Overrides == nil {
		f.data.Overrides = map[string]float64{}
	}
	if f.data.Texts == nil {
		f.data.Texts = map[string]string{}
	}
	if f.data.Checks == nil {
		f.data.Checks = map[string]bool{}
	}
	return f, nil
}

// saveFiling inserts or replaces the saved filing row (inside the write tx).
// filedAt is the filing date of a filed form ("" = now).
func saveFiling(ctx context.Context, tx *sql.Tx, user, form string, year int, period, state, status, filedAt string, data *formData) (int64, error) {
	now := store.Now()
	switch {
	case status != "filed":
		filedAt = ""
	case filedAt == "":
		filedAt = now
	}
	b, err := json.Marshal(data)
	if err != nil {
		return 0, err
	}
	var id int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM form_filings WHERE form = ? AND year = ? AND period = ? AND state = ?`,
		form, year, period, state).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		res, err := tx.ExecContext(ctx, `INSERT INTO form_filings(form, year, period, state, data, status, filed_at, created_by, created_at, updated_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, form, year, period, state, string(b), status, filedAt, user, now, now)
		if err != nil {
			return 0, err
		}
		return res.LastInsertId()
	case err != nil:
		return 0, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE form_filings SET data = ?, status = ?, filed_at = ?, updated_at = ? WHERE id = ?`,
		string(b), status, filedAt, now, id)
	return id, err
}

// ---------------------------------------------------------------------------
// Line builder: every line has a computed value; editable lines take the
// user's saved value instead (Overridden). Dependent lines are computed from
// the effective (possibly overridden) values of the lines they add up.

type builder struct {
	lines   []model.FormLine
	d       *formData
	section string
}

func newBuilder(d *formData) *builder {
	if d == nil {
		d = emptyData()
	}
	return &builder{d: d}
}

func lineKey(key, col string) string {
	if col == "" {
		return key
	}
	return key + ":" + col
}

func (b *builder) add(l model.FormLine) {
	l.Section = b.section
	b.lines = append(b.lines, l)
}

// money adds a money line and returns its effective value in cents.
func (b *builder) money(key, col, label string, computed int64, editable bool) int64 {
	v, ov := computed, false
	if editable {
		if o, ok := b.d.Overrides[lineKey(key, col)]; ok {
			v, ov = store.Cents(o), true
		}
	}
	b.add(model.FormLine{Key: key, Col: col, Label: label, Kind: "money", Value: store.Dollars(v), Computed: store.Dollars(computed),
		Editable: editable, Overridden: ov})
	return v
}

// count adds a whole number line (number of employees, weeks).
func (b *builder) count(key, col, label string, computed int, editable bool) int {
	v, ov := computed, false
	if editable {
		if o, ok := b.d.Overrides[lineKey(key, col)]; ok {
			v, ov = int(math.Round(o)), true
		}
	}
	b.add(model.FormLine{Key: key, Col: col, Label: label, Kind: "count", Value: float64(v), Computed: float64(computed),
		Editable: editable, Overridden: ov})
	return v
}

// number adds a decimal number line (rates in percent).
func (b *builder) number(key, col, label string, computed float64, editable bool) float64 {
	v, ov := computed, false
	if editable {
		if o, ok := b.d.Overrides[lineKey(key, col)]; ok {
			v, ov = o, true
		}
	}
	b.add(model.FormLine{Key: key, Col: col, Label: label, Kind: "number", Value: v, Computed: computed, Editable: editable, Overridden: ov})
	return v
}

// check adds a check box line (Computed = 1 when the program would check it).
func (b *builder) check(key, col, label string, computed, editable bool) bool {
	v, ov := computed, false
	if editable {
		if o, ok := b.d.Checks[lineKey(key, col)]; ok {
			v, ov = o, true
		}
	}
	c := 0.0
	if computed {
		c = 1
	}
	b.add(model.FormLine{Key: key, Col: col, Label: label, Kind: "check", Checked: v, Computed: c, Editable: editable, Overridden: ov})
	return v
}

// text adds a text line.
func (b *builder) text(key, col, label, computed string, editable bool) string {
	v, ov := computed, false
	if editable {
		if o, ok := b.d.Texts[lineKey(key, col)]; ok {
			v, ov = o, true
		}
	}
	b.add(model.FormLine{Key: key, Col: col, Label: label, Kind: "text", Text: v, Editable: editable, Overridden: ov})
	return v
}

// ---------------------------------------------------------------------------
// Request parsing and saving

func parseYear(c *httpx.Ctx) (int, error) {
	y := int(c.QInt("year"))
	if y < 2000 || y > 2100 {
		return 0, apperr.Validation("year", "Enter the year of the form (for example 2026).")
	}
	return y, nil
}

func parseQuarter(c *httpx.Ctx) (int, error) {
	q := int(c.QInt("quarter"))
	if q < 1 || q > 4 {
		return 0, apperr.Validation("quarter", "Enter the quarter of the form (1 to 4).")
	}
	return q, nil
}

func formStatus(f *filing) (status, filedAt string) {
	if f == nil {
		return "new", ""
	}
	return f.status, f.filedAt
}

// validateSave checks that every value the user sent belongs to an editable
// line of the computed form, and returns the data to store.
func validateSave(form *model.TaxForm, req *model.SaveFormRequest) (*formData, error) {
	if req.Status != "draft" && req.Status != "filed" {
		return nil, apperr.Validation("status", "The status must be draft or filed.")
	}
	kinds := map[string]string{}
	for _, l := range form.Lines {
		if l.Editable {
			kinds[lineKey(l.Key, l.Col)] = l.Kind
		}
	}
	d := emptyData()
	bad := func(k string) error {
		return apperr.Validation("overrides", "Line %s of %s cannot be changed.", strings.ReplaceAll(k, ":", " column "), form.Title)
	}
	for k, v := range req.Overrides {
		switch kinds[k] {
		case "money", "count", "number":
			if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 1e11 {
				return nil, apperr.Validation("overrides", "Line %s: the amount is not valid.", k)
			}
			if kinds[k] == "money" {
				v = store.Round2(v)
			}
			d.Overrides[k] = v
		default:
			return nil, bad(k)
		}
	}
	for k, v := range req.Texts {
		if kinds[k] != "text" {
			return nil, bad(k)
		}
		d.Texts[k] = strings.TrimSpace(v)
	}
	for k, v := range req.Checks {
		if kinds[k] != "check" {
			return nil, bad(k)
		}
		d.Checks[k] = v
	}
	return d, nil
}

// changedSince lists the lines whose values differ from the snapshot saved
// when the form was filed (empty when nothing changed).
func changedSince(snapshot json.RawMessage, lines []model.FormLine) []string {
	if len(snapshot) == 0 {
		return nil
	}
	var old model.TaxForm
	if json.Unmarshal(snapshot, &old) != nil {
		return nil
	}
	prev := map[string]model.FormLine{}
	for _, l := range old.Lines {
		prev[lineKey(l.Key, l.Col)] = l
	}
	var out []string
	for _, l := range lines {
		p, ok := prev[lineKey(l.Key, l.Col)]
		if !ok {
			continue
		}
		if p.Value != l.Value || p.Checked != l.Checked || p.Text != l.Text {
			name := l.Key
			if l.Col != "" {
				name += " (" + l.Col + ")"
			}
			out = append(out, name)
		}
	}
	return out
}

func filedWarning(f *filing, lines []model.FormLine, amend string) []string {
	if f == nil || f.status != "filed" {
		return nil
	}
	if ch := changedSince(f.data.Snapshot, lines); len(ch) > 0 {
		date := f.filedAt
		if len(date) >= 10 {
			date = date[:10]
		}
		return []string{fmt.Sprintf("Payroll data changed after this form was filed on %s (lines %s). File %s if the filed return is wrong.",
			date, strings.Join(ch, ", "), amend)}
	}
	return nil
}
