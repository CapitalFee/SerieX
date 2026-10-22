package lists

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

func registerSimpleListRoutes(rt *httpx.Router) {
	listParam := func(c *httpx.Ctx) (string, error) {
		l := c.R.PathValue("list")
		for _, x := range model.AllLists {
			if x == l {
				return l, nil
			}
		}
		return "", apperr.NotFound("Unknown list %q.", l)
	}
	rt.C("GET", "/lists/{list}", func(c *httpx.Ctx) error {
		l, err := listParam(c)
		if err != nil {
			return err
		}
		mode, err := activeMode(c.Q("active"))
		if err != nil {
			return err
		}
		all, err := ListEntries(c.Context(), c.DB, l)
		if err != nil {
			return err
		}
		out := []model.ListEntry{}
		for _, e := range all {
			if keepActive(mode, e.Active) {
				out = append(out, e)
			}
		}
		return c.JSON(out)
	})
	save := func(c *httpx.Ctx, id int64) error {
		l, err := listParam(c)
		if err != nil {
			return err
		}
		var e model.ListEntry
		act, err := decodeRecord(c, &e)
		if err != nil {
			return err
		}
		e.ID = id
		e.List = l
		if e.UpdatedAt == "" {
			e.UpdatedAt = ifMatch(c)
		}
		var saved int64
		err = c.Write(func(tx *sql.Tx) error {
			if id != 0 {
				var cur string
				err := tx.QueryRowContext(c.Context(), `SELECT list FROM list_entries WHERE id = ?`, id).Scan(&cur)
				if errors.Is(err, sql.ErrNoRows) || (err == nil && cur != l) {
					return apperr.NotFound("List entry not found.")
				}
				if err != nil {
					return err
				}
				if err := store.CheckStale(c.Context(), tx, "list_entries", id, e.UpdatedAt, "entry"); err != nil {
					return err
				}
			}
			var err error
			if e.Active, err = resolveActive(c.Context(), tx, "list_entries", id, act); err != nil {
				return err
			}
			saved, err = SaveListEntry(c.Context(), tx, &e)
			return err
		})
		if err != nil {
			return err
		}
		out, err := getListEntry(c.Context(), c.DB, l, saved)
		if err != nil {
			return err
		}
		return c.JSON(out)
	}
	rt.C("POST", "/lists/{list}", func(c *httpx.Ctx) error { return save(c, 0) })
	rt.C("PUT", "/lists/{list}/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return save(c, id)
	})
	rt.C("DELETE", "/lists/{list}/{id}", func(c *httpx.Ctx) error {
		l, err := listParam(c)
		if err != nil {
			return err
		}
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		stamp := ifMatch(c)
		if err := c.Write(func(tx *sql.Tx) error {
			var cur string
			if err := tx.QueryRowContext(c.Context(), `SELECT list FROM list_entries WHERE id = ?`, id).Scan(&cur); err == nil && cur == l {
				if err := store.CheckStale(c.Context(), tx, "list_entries", id, stamp, "entry"); err != nil {
					return err
				}
			}
			return DeleteListEntry(c.Context(), tx, l, id)
		}); err != nil {
			return err
		}
		return c.NoContent()
	})
}

// ListEntries returns every entry of a simple list (active and inactive) in
// tree order, sorted by name.
func ListEntries(ctx context.Context, q store.Q, list string) ([]model.ListEntry, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, list, name, parent_id, active, data, updated_at FROM list_entries WHERE list = ?`, list)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []model.ListEntry
	for rows.Next() {
		var e model.ListEntry
		var parent sql.NullInt64
		var active int
		var data string
		if err := rows.Scan(&e.ID, &e.List, &e.Name, &parent, &active, &data, &e.UpdatedAt); err != nil {
			return nil, err
		}
		e.ParentID = store.PtrID(parent)
		e.Active = active == 1
		e.Data = map[string]any{}
		if data != "" {
			json.Unmarshal([]byte(data), &e.Data)
			if e.Data == nil {
				e.Data = map[string]any{}
			}
		}
		all = append(all, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	names := map[int64]string{}
	parents := map[int64]int64{}
	for _, e := range all {
		names[e.ID] = e.Name
		if e.ParentID != nil {
			parents[e.ID] = *e.ParentID
		}
	}
	full := fullNames(names, parents)
	order, level := treeSort(len(all),
		func(i int) int64 { return all[i].ID },
		func(i int) int64 {
			if all[i].ParentID == nil {
				return 0
			}
			return *all[i].ParentID
		},
		func(x, y int) bool { return lessFold(all[x].Name, all[y].Name) })
	out := make([]model.ListEntry, 0, len(all))
	for _, i := range order {
		e := all[i]
		e.Level = level[i]
		e.FullName = full[e.ID]
		out = append(out, e)
	}
	return out, nil
}

func getListEntry(ctx context.Context, q store.Q, list string, id int64) (*model.ListEntry, error) {
	all, err := ListEntries(ctx, q, list)
	if err != nil {
		return nil, err
	}
	for i := range all {
		if all[i].ID == id {
			return &all[i], nil
		}
	}
	return nil, apperr.NotFound("List entry not found.")
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case string:
		if strings.TrimSpace(x) == "" {
			return 0, true
		}
	case nil:
		return 0, true
	}
	return 0, false
}

func boolOf(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x == "true" || x == "1"
	}
	return false
}

var paymentMethodTypes = map[string]bool{"Cash": true, "Check": true, "American Express": true, "Discover": true, "MasterCard": true,
	"Visa": true, "Debit Card": true, "E-Check": true, "Gift Card": true, "Other": true, "Other Credit Card": true}

// normalizeListData validates and fills the data of a list entry.
func normalizeListData(ctx context.Context, q store.Q, e *model.ListEntry) error {
	d := e.Data
	if d == nil {
		d = map[string]any{}
	}
	getNum := func(key, label string, min, max float64, integer bool) (float64, error) {
		f, ok := num(d[key])
		if !ok || math.IsNaN(f) || f < min || f > max {
			return 0, apperr.Validation("data."+key, "%s must be a number between %g and %g.", label, min, max)
		}
		if integer {
			f = math.Round(f)
		}
		return f, nil
	}
	switch e.List {
	case model.ListTerms:
		out := map[string]any{}
		disc, err := getNum("discountPct", "The discount percentage", 0, 100, false)
		if err != nil {
			return err
		}
		out["discountPct"] = disc
		if boolOf(d["dateDriven"]) {
			out["dateDriven"] = true
			due, err := getNum("dueDay", "The day of the month the payment is due", 1, 31, true)
			if err != nil {
				return err
			}
			if due < 1 {
				return apperr.Validation("data.dueDay", "Enter the day of the month the payment is due (1-31).")
			}
			dd, err := getNum("discountDay", "The discount day", 0, 31, true)
			if err != nil {
				return err
			}
			nm, err := getNum("dueNextMonthDays", "The number of days before the due date", 0, 31, true)
			if err != nil {
				return err
			}
			out["dueDay"], out["discountDay"], out["dueNextMonthDays"] = due, dd, nm
		} else {
			out["dateDriven"] = false
			nd, err := getNum("netDays", "The net due days", 0, 999, true)
			if err != nil {
				return err
			}
			dd, err := getNum("discountDays", "The discount days", 0, 999, true)
			if err != nil {
				return err
			}
			out["netDays"], out["discountDays"] = nd, dd
		}
		e.Data = out
	case model.ListPaymentMethod:
		t, _ := d["type"].(string)
		t = strings.TrimSpace(t)
		if t == "" {
			t = "Other"
		}
		if !paymentMethodTypes[t] {
			return apperr.Validation("data.type", "Choose a valid payment type.")
		}
		e.Data = map[string]any{"type": t}
	case model.ListSalesRep:
		ini, _ := d["initials"].(string)
		ini = strings.TrimSpace(ini)
		if ini == "" {
			// initials default to the first letters of the words of the name
			for _, w := range strings.Fields(e.Name) {
				ini += strings.ToUpper(string([]rune(w)[0]))
			}
		}
		if len([]rune(ini)) > 5 {
			return apperr.Validation("data.initials", "Sales rep initials can have at most 5 characters.")
		}
		out := map[string]any{"initials": ini, "nameId": nil}
		if f, ok := num(d["nameId"]); ok && f > 0 {
			nid := int64(f)
			if ok, err := exists(ctx, q, `SELECT 1 FROM names WHERE id = ?`, nid); err != nil {
				return err
			} else if !ok {
				return apperr.Validation("data.nameId", "The sales rep name does not exist.")
			}
			out["nameId"] = nid
		}
		e.Data = out
	default:
		e.Data = d
	}
	return nil
}

// SaveListEntry validates and stores a simple list entry (e.ID == 0 creates
// it). e.List must be set. Returns the entry id.
func SaveListEntry(ctx context.Context, tx *sql.Tx, e *model.ListEntry) (int64, error) {
	name, err := cleanName(e.Name, "entry")
	if err != nil {
		return 0, err
	}
	if len([]rune(name)) > 31 && e.List != model.ListCustomerMessage {
		return 0, apperr.Validation("name", "The name is too long (31 characters maximum).")
	}
	e.Name = name
	e.ParentID = normID(e.ParentID)
	if e.ParentID != nil {
		pl, err := checkParent(ctx, tx, "list_entries", e.ID, *e.ParentID, "list")
		if err != nil {
			return 0, err
		}
		if pl != e.List {
			return 0, apperr.Validation("parentId", "The parent entry belongs to another list.")
		}
	}
	if dup, err := siblingExists(ctx, tx, "list_entries", e.ParentID, e.Name, e.ID, " AND list = ?", e.List); err != nil {
		return 0, err
	} else if dup {
		return 0, nameInUse(e.Name)
	}
	if err := normalizeListData(ctx, tx, e); err != nil {
		return 0, err
	}
	data, _ := json.Marshal(e.Data)
	id := e.ID
	var oldActive = true
	if id == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO list_entries(list, name, parent_id, active, data, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`,
			e.List, e.Name, store.NullID(e.ParentID), store.B(e.Active), string(data), store.Now(), store.Stamp())
		if err != nil {
			return 0, mapDBError(err, e.Name)
		}
		if id, err = res.LastInsertId(); err != nil {
			return 0, err
		}
	} else {
		var act int
		if err := tx.QueryRowContext(ctx, `SELECT active FROM list_entries WHERE id = ?`, id).Scan(&act); err != nil {
			return 0, err
		}
		oldActive = act == 1
		if _, err := tx.ExecContext(ctx, `UPDATE list_entries SET name = ?, parent_id = ?, data = ?, updated_at = ? WHERE id = ?`,
			e.Name, store.NullID(e.ParentID), string(data), store.Stamp(), id); err != nil {
			return 0, mapDBError(err, e.Name)
		}
	}
	if e.ID == 0 || oldActive != e.Active {
		if err := setActive(ctx, tx, "list_entries", id, e.Active); err != nil {
			return 0, err
		}
	}
	return id, nil
}

// DeleteListEntry removes a list entry that is not used anywhere.
func DeleteListEntry(ctx context.Context, tx *sql.Tx, list string, id int64) error {
	var name, cur string
	err := tx.QueryRowContext(ctx, `SELECT name, list FROM list_entries WHERE id = ?`, id).Scan(&name, &cur)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && cur != list) {
		return apperr.NotFound("List entry not found.")
	}
	if err != nil {
		return err
	}
	if kids, err := exists(ctx, tx, `SELECT 1 FROM list_entries WHERE parent_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if kids {
		return apperr.Conflict("\"%s\" has subentries and cannot be deleted. Make it inactive instead.", name)
	}
	used, err := exists(ctx, tx, `SELECT 1 FROM names WHERE terms_id = ?1 OR type_id = ?1 OR rep_id = ?1 OR payment_method_id = ?1 OR job_type_id = ?1
		UNION SELECT 1 FROM txns WHERE terms_id = ?1 OR class_id = ?1 OR rep_id = ?1 OR ship_via_id = ?1 OR customer_message_id = ?1 OR payment_method_id = ?1
		UNION SELECT 1 FROM txn_lines WHERE class_id = ?1 OR payment_method_id = ?1
		UNION SELECT 1 FROM gl_entries WHERE class_id = ?1
		UNION SELECT 1 FROM items WHERE payment_method_id = ?1
		UNION SELECT 1 FROM budget_lines WHERE class_id = ?1 LIMIT 1`, id)
	if err != nil {
		return err
	}
	if used {
		return apperr.Conflict("\"%s\" is used by names or transactions and cannot be deleted. Make it inactive instead.", name)
	}
	p, err := store.LoadPrefs(ctx, tx)
	if err != nil {
		return err
	}
	if p.DefaultShipViaID != nil && *p.DefaultShipViaID == id {
		p.DefaultShipViaID = nil
		if err := store.SavePrefs(ctx, tx, p); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM list_entries WHERE id = ?`, id); err != nil {
		return mapDBError(err, name)
	}
	return nil
}
