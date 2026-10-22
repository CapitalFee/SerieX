// Package lists serves the chart of accounts, customers/vendors/other names,
// items, the simple lists (terms, classes, ...) and CSV import/export.
//
// Exported helpers other packages may use (all take the *sql.Tx inside a
// write transaction, or c.DB / a store.Q for reads):
//   - Accounts / GetAccount, Names / GetName, Items / GetItem, ListEntries:
//     list rows with every computed (ro) field filled.
//   - SaveAccount / SaveName / SaveItem / SaveListEntry: validate and store
//     one record (ID 0 creates it, opening balances are posted on create).
package lists

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Register adds the list routes.
func Register(rt *httpx.Router) {
	registerAccountRoutes(rt)
	registerNameRoutes(rt)
	registerItemRoutes(rt)
	registerSimpleListRoutes(rt)
	registerCSVRoutes(rt)
}

// saveOpts builds the ledger options for opening balance transactions.
func saveOpts(c *httpx.Ctx) ledger.SaveOptions {
	return ledger.Options(c)
}

// decodeRecord reads a JSON record body into v and also reports whether the
// body contained "active" (nil when absent: new records default to active,
// updates keep the current flag).
func decodeRecord(c *httpx.Ctx, v any) (*bool, error) {
	body, err := io.ReadAll(io.LimitReader(c.R.Body, 16<<20))
	if err != nil {
		return nil, httpx.BodyError(err)
	}
	if err := json.Unmarshal(body, v); err != nil {
		return nil, httpx.BodyError(err)
	}
	var a struct {
		Active *bool `json:"active"`
	}
	json.Unmarshal(body, &a)
	return a.Active, nil
}

// ifMatch is the updatedAt of the client's copy sent as the If-Match header
// or ?updatedAt= (DELETE has no body); "" when not sent.
func ifMatch(c *httpx.Ctx) string {
	if v := strings.Trim(strings.TrimSpace(c.R.Header.Get("If-Match")), `"`); v != "" {
		return v
	}
	return strings.TrimSpace(c.Q("updatedAt"))
}

// resolveActive returns the active flag to store for a record.
func resolveActive(ctx context.Context, q store.Q, table string, id int64, given *bool) (bool, error) {
	if given != nil {
		return *given, nil
	}
	if id == 0 {
		return true, nil
	}
	var act int
	err := q.QueryRowContext(ctx, `SELECT active FROM `+table+` WHERE id = ?`, id).Scan(&act)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	return act == 1, err
}

// ---------------------------------------------------------------------------
// Query helpers

// activeMode parses ?active=all|active|inactive (default active).
func activeMode(s string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "active", "1", "true":
		return "active", nil
	case "all":
		return "all", nil
	case "inactive", "0", "false":
		return "inactive", nil
	}
	return "", apperr.Validation("active", "active must be all, active or inactive")
}

func keepActive(mode string, active bool) bool {
	switch mode {
	case "all":
		return true
	case "inactive":
		return !active
	}
	return active
}

// splitList parses a comma separated query value ("Bank,Credit Card").
func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

// idSet runs a query returning one id column and collects the ids.
func idSet(ctx context.Context, q store.Q, query string, args ...any) (map[int64]bool, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id sql.NullInt64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		if id.Valid {
			out[id.Int64] = true
		}
	}
	return out, rows.Err()
}

// sumByID runs a query returning (id, sum) pairs.
func sumByID(ctx context.Context, q store.Q, query string, args ...any) (map[int64]int64, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]int64{}
	for rows.Next() {
		var id int64
		var s sql.NullInt64
		if err := rows.Scan(&id, &s); err != nil {
			return nil, err
		}
		out[id] = s.Int64
	}
	return out, rows.Err()
}

func exists(ctx context.Context, q store.Q, query string, args ...any) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, query, args...).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ---------------------------------------------------------------------------
// Tree ordering

// treeSort orders n rows so that parents are immediately followed by their
// children (depth first), siblings ordered by less. Rows whose parent is
// missing are treated as top level. Returns row indexes in order and the
// level of each row (indexed like the input).
func treeSort(n int, id func(i int) int64, parent func(i int) int64, less func(a, b int) bool) ([]int, []int) {
	idx := make(map[int64]int, n)
	for i := 0; i < n; i++ {
		idx[id(i)] = i
	}
	children := map[int64][]int{}
	var roots []int
	for i := 0; i < n; i++ {
		p := parent(i)
		if _, ok := idx[p]; p == 0 || !ok || p == id(i) {
			roots = append(roots, i)
			continue
		}
		children[p] = append(children[p], i)
	}
	sortIdx := func(s []int) { sort.SliceStable(s, func(a, b int) bool { return less(s[a], s[b]) }) }
	sortIdx(roots)
	for k := range children {
		sortIdx(children[k])
	}
	order := make([]int, 0, n)
	level := make([]int, n)
	seen := make([]bool, n)
	var walk func(i, lv int)
	walk = func(i, lv int) {
		if seen[i] {
			return
		}
		seen[i] = true
		level[i] = lv
		order = append(order, i)
		for _, c := range children[id(i)] {
			walk(c, lv+1)
		}
	}
	for _, r := range roots {
		walk(r, 0)
	}
	// rows caught in a parent cycle (corrupt data) still appear, at top level
	for i := 0; i < n; i++ {
		if !seen[i] {
			walk(i, 0)
		}
	}
	return order, level
}

// fullNames builds "A:B:C" names from id -> (name, parent) data.
func fullNames(names map[int64]string, parents map[int64]int64) map[int64]string {
	out := make(map[int64]string, len(names))
	var get func(id int64, depth int) string
	get = func(id int64, depth int) string {
		if f, ok := out[id]; ok {
			return f
		}
		p := parents[id]
		f := names[id]
		if _, ok := names[p]; p != 0 && ok && depth < 64 {
			f = get(p, depth+1) + ":" + f
		}
		out[id] = f
		return f
	}
	for id := range names {
		get(id, 0)
	}
	return out
}

func lessFold(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}
	return a < b
}

// ---------------------------------------------------------------------------
// Validation helpers

// cleanName trims a list record name and applies the common rules.
func cleanName(name, what string) (string, error) {
	n, err := store.CleanText(name, "name", "The name", 0)
	if err != nil {
		return "", err
	}
	if n == "" {
		return "", apperr.Validation("name", "You must enter a name for this %s.", what)
	}
	if strings.Contains(n, ":") {
		return "", apperr.Validation("name", "The name cannot contain a colon (:).")
	}
	if len([]rune(n)) > 100 {
		return "", apperr.Validation("name", "The name is too long (100 characters maximum).")
	}
	return n, nil
}

func nameInUse(name string) error {
	return apperr.Conflict("The name \"%s\" is already in use. Please use a different name.", name)
}

// nameTaken explains which customer, job, vendor or other name already uses
// a name (names must be unique across all of them), and whether it is
// inactive. The error data carries existingId, existingKind and existingActive
// so the client can offer to open or reactivate it.
func nameTaken(ctx context.Context, q store.Q, parentID *int64, name string, exceptID int64) error {
	var p int64
	if parentID != nil {
		p = *parentID
	}
	var id int64
	var kind, stored string
	var parent sql.NullInt64
	var active int
	err := q.QueryRowContext(ctx, `SELECT id, kind, name, parent_id, active FROM names WHERE IFNULL(parent_id, 0) = ? AND name = ? AND id <> ? LIMIT 1`,
		p, name, exceptID).Scan(&id, &kind, &stored, &parent, &active)
	if err != nil {
		return nameInUse(name)
	}
	label := map[string]string{model.NameCustomer: "customer", model.NameVendor: "vendor", model.NameOther: "other name"}[kind]
	if kind == model.NameCustomer && parent.Valid {
		label = "job"
	}
	var e *apperr.Error
	if active == 0 {
		art := "A"
		if label == "other name" {
			art = "An"
		}
		e = apperr.Conflict("%s %s named \"%s\" already exists but is inactive. Make it active instead, or use a different name.", art, label, stored)
	} else if parent.Valid {
		e = apperr.Conflict("The name \"%s\" is already used by another job of this customer.", stored)
	} else {
		e = apperr.Conflict("The name \"%s\" is already used by a %s. Names must be unique across customers, vendors and other names.", stored, label)
	}
	e.Field = "name"
	e.Data = map[string]any{"existingId": id, "existingKind": kind, "existingActive": active == 1}
	return e
}

// checkParent verifies that parentID exists in table and is not id itself or
// one of its descendants. Returns the parent's type column value (when the
// table has one: accounts/items) or kind (names).
func checkParent(ctx context.Context, tx store.Q, table string, id, parentID int64, typeCol string) (string, error) {
	var t string
	err := tx.QueryRowContext(ctx, `SELECT `+typeCol+` FROM `+table+` WHERE id = ?`, parentID).Scan(&t)
	if errors.Is(err, sql.ErrNoRows) {
		return "", apperr.Validation("parentId", "The parent record does not exist.")
	}
	if err != nil {
		return "", err
	}
	if id != 0 {
		desc, err := store.Descendants(ctx, tx, table, id)
		if err != nil {
			return "", err
		}
		for _, d := range desc {
			if d == parentID {
				return "", apperr.Validation("parentId", "A record cannot be placed under itself or one of its own subrecords.")
			}
		}
	}
	return t, nil
}

// siblingExists reports whether another row of table with the same parent has name.
func siblingExists(ctx context.Context, q store.Q, table string, parentID *int64, name string, id int64, extra string, extraArgs ...any) (bool, error) {
	var p int64
	if parentID != nil {
		p = *parentID
	}
	args := append([]any{p, name, id}, extraArgs...)
	return exists(ctx, q, `SELECT 1 FROM `+table+` WHERE IFNULL(parent_id, 0) = ? AND name = ? AND id <> ?`+extra+` LIMIT 1`, args...)
}

// setActive changes the active flag of a record. Making it inactive also makes
// every descendant inactive; making it active also re-activates its ancestors.
// Every record whose flag changes gets a new updated_at, so a copy of it
// opened before (such as a job of a customer made inactive) can no longer be
// saved over the change (store.CheckStale).
func setActive(ctx context.Context, tx *sql.Tx, table string, id int64, active bool) error {
	now := store.Stamp()
	if active {
		_, err := tx.ExecContext(ctx, `WITH RECURSIVE up(id, parent_id) AS (
			SELECT id, parent_id FROM `+table+` WHERE id = ?
			UNION ALL SELECT p.id, p.parent_id FROM `+table+` p JOIN up ON p.id = up.parent_id
		) UPDATE `+table+` SET active = 1, updated_at = ? WHERE active <> 1 AND id IN (SELECT id FROM up)`, id, now)
		return err
	}
	ids, err := store.Descendants(ctx, tx, table, id)
	if err != nil {
		return err
	}
	for _, d := range ids {
		if _, err := tx.ExecContext(ctx, `UPDATE `+table+` SET active = 0, updated_at = ? WHERE id = ? AND active <> 0`, now, d); err != nil {
			return err
		}
	}
	return nil
}

func touch(ctx context.Context, tx *sql.Tx, table string, id int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE `+table+` SET updated_at = ? WHERE id = ?`, store.Stamp(), id)
	return err
}

// cols collects column/value pairs for INSERT and UPDATE statements.
type cols struct {
	names []string
	vals  []any
}

func (c *cols) add(name string, v any) { c.names = append(c.names, name); c.vals = append(c.vals, v) }

func (c *cols) insert(ctx context.Context, tx *sql.Tx, table string) (int64, error) {
	ph := strings.TrimSuffix(strings.Repeat("?,", len(c.names)), ",")
	res, err := tx.ExecContext(ctx, fmt.Sprintf(`INSERT INTO %s(%s) VALUES(%s)`, table, strings.Join(c.names, ","), ph), c.vals...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (c *cols) update(ctx context.Context, tx *sql.Tx, table string, id int64) error {
	sets := make([]string, len(c.names))
	for i, n := range c.names {
		sets[i] = n + " = ?"
	}
	_, err := tx.ExecContext(ctx, fmt.Sprintf(`UPDATE %s SET %s WHERE id = ?`, table, strings.Join(sets, ", ")), append(c.vals, id)...)
	return err
}

// mapDBError turns constraint failures into plain messages for the user.
func mapDBError(err error, name string) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") {
		return nameInUse(name)
	}
	if strings.Contains(msg, "FOREIGN KEY constraint failed") {
		return apperr.Conflict("This record refers to (or is used by) another record that does not allow this change.")
	}
	return err
}

// nullF converts an optional float for SQL.
func nullF(p *float64) any {
	if p == nil {
		return nil
	}
	return *p
}

func ptrF(n sql.NullFloat64) *float64 {
	if !n.Valid {
		return nil
	}
	v := n.Float64
	return &v
}

func normID(p *int64) *int64 {
	if p == nil || *p == 0 {
		return nil
	}
	return p
}
