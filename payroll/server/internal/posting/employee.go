package posting

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/store"
)

// employeeSuffix is appended to an employee's Books name when the display
// name is already used by a SerieX Books customer or vendor.
const employeeSuffix = " (Employee)"

func ensureEmployeeName(c *httpx.Ctx, employeeID int64) (int64, error) {
	c = detached(c)
	unlock := lockRecord(c.Context(), c.CompanyID, EntityEmployee, employeeID)
	defer unlock()
	id, err := syncEmployeeName(c, employeeID)
	if serr := storeEmployeeSyncError(c, employeeID, err); serr != nil && err == nil {
		return 0, serr
	}
	return id, err
}

// storeEmployeeSyncError keeps the employee's last SerieX Books name problem
// (employees.books_sync_error, shown in the Employee Center) and clears it once
// the name was created or updated.
func storeEmployeeSyncError(c *httpx.Ctx, employeeID int64, syncErr error) error {
	ctx := c.Context()
	msg := ""
	if syncErr != nil {
		if ae := apperr.As(syncErr); ae != nil && ae.Code == apperr.CodeNotFound && ae.Message == "Employee not found." {
			return nil // nothing to store it on
		}
		msg = ProblemMessage(syncErr)
	}
	var cur string
	err := c.DB.QueryRowContext(ctx, `SELECT books_sync_error FROM employees WHERE id = ?`, employeeID).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil || cur == msg {
		return err
	}
	return c.Write(func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE employees SET books_sync_error = ? WHERE id = ?`, msg, employeeID)
		return err
	})
}

// syncEmployeeName creates or updates the employee's Books "other" name (the
// caller holds the employee's posting lock).
func syncEmployeeName(c *httpx.Ctx, employeeID int64) (int64, error) {
	ctx := c.Context()

	var first, middle, last, display, printAs, a1, a2, city, state, zip, phone, mobile, email string
	var active bool
	var cur sql.NullInt64
	err := c.DB.QueryRowContext(ctx, `SELECT first_name, middle_name, last_name, display_name, print_as, address1, address2,
		city, state, zip, phone, mobile, email, active, books_name_id FROM employees WHERE id = ?`, employeeID).Scan(
		&first, &middle, &last, &display, &printAs, &a1, &a2, &city, &state, &zip, &phone, &mobile, &email, &active, &cur)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, apperr.NotFound("Employee not found.")
	}
	if err != nil {
		return 0, err
	}
	display = booksEmployeeName(display)
	if display == "" {
		return 0, apperr.Validation("displayName", "The employee has no name.")
	}

	cl, s := books.Default, books.S(c)
	names, err := cl.Names(ctx, s, "")
	if err != nil {
		return 0, books.ToAppErr(err)
	}
	usedByOther := func(nameID int64) (bool, error) {
		var n int
		err := c.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM employees WHERE books_name_id = ? AND id <> ?`, nameID, employeeID).Scan(&n)
		return n > 0, err
	}
	// The employee's current Books name: an "other" name that is still this
	// employee's (same name, same first and last name, or a name the employee
	// had before: renaming an employee renames its Books name too).
	// Books reuses the id of a deleted name, so the id alone is not enough.
	var linked *books.Name
	if cur.Valid {
		for i := range names {
			n := &names[i]
			if n.ID != cur.Int64 || n.Kind != books.NameOther {
				continue
			}
			same := strings.EqualFold(n.Name, display) || strings.EqualFold(n.Name, display+employeeSuffix) ||
				(strings.EqualFold(n.FirstName, first) && strings.EqualFold(n.LastName, last) && first+last != "")
			if !same && n.ParentID == nil {
				prev, err := previousNames(ctx, c.DB, employeeID, display)
				if err != nil {
					return 0, err
				}
				for _, p := range prev {
					if strings.EqualFold(n.Name, p) || strings.EqualFold(n.Name, p+employeeSuffix) {
						same = true
						break
					}
				}
				if same {
					used, err := usedByOther(n.ID)
					if err != nil {
						return 0, err
					}
					same = !used
				}
			}
			if same {
				linked = n
			}
			break
		}
	}
	taken := func(name string) *books.Name {
		for i := range names {
			n := &names[i]
			if n.ParentID == nil && strings.EqualFold(n.Name, name) && (linked == nil || n.ID != linked.ID) {
				return n
			}
		}
		return nil
	}
	chosen := ""
	for _, cand := range []string{display, display + employeeSuffix} {
		o := taken(cand)
		if o == nil {
			chosen = cand
			break
		}
		if o.Kind == books.NameOther && linked == nil {
			used, err := usedByOther(o.ID)
			if err != nil {
				return 0, err
			}
			if !used { // an unlinked Books "other" name with this name: adopt it instead of duplicating
				linked = o
				chosen = cand
				break
			}
		}
	}
	if chosen == "" {
		return 0, apperr.Conflict("The names %q and %q are already used in SerieX Books. Change the employee's display name.", display, display+employeeSuffix)
	}

	want := books.Name{}
	if linked != nil {
		want = *linked
	}
	want.Kind = books.NameOther
	want.Name = chosen
	want.ParentID = nil
	want.FirstName, want.MiddleName, want.LastName = first, middle, last
	want.BillAddress.Line1, want.BillAddress.Line2 = a1, a2
	want.BillAddress.City, want.BillAddress.State, want.BillAddress.Zip = city, state, zip
	want.Phone, want.Mobile, want.Email = phone, mobile, email
	want.Active = active
	// the check shows the employee's name, never the " (Employee)" suffix
	want.PrintOnCheckAs = strings.TrimSpace(printAs)
	if want.PrintOnCheckAs == "" {
		want.PrintOnCheckAs = display
	}

	var id int64
	switch {
	case linked == nil:
		out, err := cl.CreateName(ctx, s, want)
		if err != nil {
			return 0, books.ToAppErr(err)
		}
		id = out.ID
		invalidate(c.CompanyID)
	case nameChanged(*linked, want):
		out, err := cl.UpdateName(ctx, s, want)
		if err != nil {
			return 0, books.ToAppErr(err)
		}
		id = out.ID
		invalidate(c.CompanyID)
	default:
		id = linked.ID
	}
	if !cur.Valid || cur.Int64 != id {
		err := c.Write(func(tx *sql.Tx) error {
			_, err := tx.ExecContext(ctx, `UPDATE employees SET books_name_id = ? WHERE id = ?`, id, employeeID)
			return err
		})
		if err != nil {
			return 0, err
		}
	}
	return id, nil
}

// previousNames returns the Books names of the display names an employee had
// before (from the audit trail of its adds and changes), without the current one.
func previousNames(ctx context.Context, q store.Q, employeeID int64, current string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT details FROM audit_log WHERE entity = 'employee' AND entity_id = ? AND action IN ('add', 'modify')
		ORDER BY id DESC`, employeeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	seen := map[string]bool{strings.ToLower(current): true}
	add := func(v any) {
		name, _ := v.(string)
		name = booksEmployeeName(name)
		if name != "" && !seen[strings.ToLower(name)] {
			seen[strings.ToLower(name)] = true
			out = append(out, name)
		}
	}
	for rows.Next() {
		var details string
		if err := rows.Scan(&details); err != nil {
			return nil, err
		}
		var d map[string]any
		if json.Unmarshal([]byte(details), &d) != nil {
			continue
		}
		switch v := d["displayName"].(type) {
		case string: // add: the employee as created
			add(v)
		case map[string]any: // modify: {before, after}
			add(v["before"])
			add(v["after"])
		}
	}
	return out, rows.Err()
}

// booksEmployeeName is the Books name of an employee display name (Books
// names cannot contain a colon and are at most 100 characters).
func booksEmployeeName(display string) string {
	display = strings.TrimSpace(strings.ReplaceAll(display, ":", "-"))
	if r := []rune(display); len(r) > 100-len([]rune(employeeSuffix)) {
		display = strings.TrimSpace(string(r[:100-len([]rune(employeeSuffix))]))
	}
	return display
}

// linkedNameOK reports whether the Books name an employee is linked to is
// still that employee's "other" name. Books reuses the id of a deleted record,
// so a stale link could otherwise name another payee: the name is read from
// Books now (not from the 30-second lookup cache).
func linkedNameOK(ctx context.Context, s books.Session, id *int64, display string) (bool, error) {
	if id == nil {
		return false, nil
	}
	n, err := books.Default.GetName(ctx, s, *id)
	if books.IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if n.Kind != books.NameOther {
		return false, nil
	}
	want := booksEmployeeName(display)
	return strings.EqualFold(n.Name, want) || strings.EqualFold(n.Name, want+employeeSuffix), nil
}

func nameChanged(a, b books.Name) bool {
	return a.Name != b.Name || a.FirstName != b.FirstName || a.MiddleName != b.MiddleName || a.LastName != b.LastName ||
		a.BillAddress != b.BillAddress || a.Phone != b.Phone || a.Mobile != b.Mobile || a.Email != b.Email ||
		a.Active != b.Active || a.PrintOnCheckAs != b.PrintOnCheckAs || a.Kind != b.Kind
}
