package lists

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

func registerNameRoutes(rt *httpx.Router) {
	rt.C("GET", "/names", func(c *httpx.Ctx) error {
		mode, err := activeMode(c.Q("active"))
		if err != nil {
			return err
		}
		kind := strings.TrimSpace(c.Q("kind"))
		if kind != "" && !validKind(kind) {
			return apperr.Validation("kind", "kind must be customer, vendor or other")
		}
		all, err := Names(c.Context(), c.DB, kind)
		if err != nil {
			return err
		}
		q := strings.ToLower(strings.TrimSpace(c.Q("q")))
		out := []model.Name{}
		for _, n := range all {
			if !keepActive(mode, n.Active) {
				continue
			}
			if q != "" && !nameMatches(n, q) {
				continue
			}
			out = append(out, n)
		}
		return c.JSON(out)
	})
	rt.C("GET", "/names/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		n, err := GetName(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(n)
	})
	save := func(c *httpx.Ctx, id int64) error {
		var n model.Name
		act, err := decodeRecord(c, &n)
		if err != nil {
			return err
		}
		n.ID = id
		if id != 0 {
			n.OpeningBalance = nil
		}
		var saved int64
		err = c.Write(func(tx *sql.Tx) error {
			var err error
			if n.Active, err = resolveActive(c.Context(), tx, "names", id, act); err != nil {
				return err
			}
			saved, err = SaveName(c.Context(), tx, &n, saveOpts(c))
			return err
		})
		if err != nil {
			return err
		}
		out, err := GetName(c.Context(), c.DB, saved)
		if err != nil {
			return err
		}
		return c.JSON(out)
	}
	rt.C("POST", "/names", func(c *httpx.Ctx) error { return save(c, 0) })
	rt.C("PUT", "/names/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		return save(c, id)
	})
	rt.C("PUT", "/names/{id}/active", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		var body struct {
			Active bool `json:"active"`
		}
		if err := c.Decode(&body); err != nil {
			return err
		}
		err = c.Write(func(tx *sql.Tx) error {
			if ok, err := exists(c.Context(), tx, `SELECT 1 FROM names WHERE id = ?`, id); err != nil || !ok {
				if err == nil {
					err = apperr.NotFound("Name not found.")
				}
				return err
			}
			if err := setActive(c.Context(), tx, "names", id, body.Active); err != nil {
				return err
			}
			return touch(c.Context(), tx, "names", id)
		})
		if err != nil {
			return err
		}
		out, err := GetName(c.Context(), c.DB, id)
		if err != nil {
			return err
		}
		return c.JSON(out)
	})
	rt.C("DELETE", "/names/{id}", func(c *httpx.Ctx) error {
		id, err := c.ID("id")
		if err != nil {
			return err
		}
		if err := c.Write(func(tx *sql.Tx) error { return DeleteName(c.Context(), tx, id) }); err != nil {
			return err
		}
		return c.NoContent()
	})
}

func validKind(k string) bool {
	return k == model.NameCustomer || k == model.NameVendor || k == model.NameOther
}

func nameMatches(n model.Name, q string) bool {
	for _, s := range []string{n.FullName, n.CompanyName, n.FirstName, n.LastName, n.Email, n.Phone, n.Mobile, n.AccountNumber} {
		if strings.Contains(strings.ToLower(s), q) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Reading

const nameCols = `id, kind, name, parent_id, company_name, salutation, first_name, middle_name, last_name, job_title,
	phone, alt_phone, mobile, fax, email, cc_email, website,
	bill_line1, bill_line2, bill_line3, bill_city, bill_state, bill_zip, bill_country,
	ship_line1, ship_line2, ship_line3, ship_city, ship_state, ship_zip, ship_country,
	account_number, terms_id, credit_limit, type_id, rep_id, payment_method_id, taxable, tax_item_id, resale_number,
	print_on_check_as, tax_ident, is_1099, prefill_account_ids,
	job_status, job_start_date, job_projected_end, job_end_date, job_description, job_type_id, notes, active, updated_at`

func scanName(rows *sql.Rows) (model.Name, error) {
	var n model.Name
	var parent, terms, credit, typ, rep, pm, taxItem, jobType sql.NullInt64
	var taxable, is1099, active int
	var prefill string
	b, s := &n.BillAddress, &n.ShipAddress
	err := rows.Scan(&n.ID, &n.Kind, &n.Name, &parent, &n.CompanyName, &n.Salutation, &n.FirstName, &n.MiddleName, &n.LastName, &n.JobTitle,
		&n.Phone, &n.AltPhone, &n.Mobile, &n.Fax, &n.Email, &n.CcEmail, &n.Website,
		&b.Line1, &b.Line2, &b.Line3, &b.City, &b.State, &b.Zip, &b.Country,
		&s.Line1, &s.Line2, &s.Line3, &s.City, &s.State, &s.Zip, &s.Country,
		&n.AccountNumber, &terms, &credit, &typ, &rep, &pm, &taxable, &taxItem, &n.ResaleNumber,
		&n.PrintOnCheckAs, &n.TaxIdent, &is1099, &prefill,
		&n.JobStatus, &n.JobStartDate, &n.JobProjectedEnd, &n.JobEndDate, &n.JobDescription, &jobType, &n.Notes, &active, &n.UpdatedAt)
	if err != nil {
		return n, err
	}
	n.ParentID = store.PtrID(parent)
	n.TermsID = store.PtrID(terms)
	if credit.Valid {
		v := store.Dollars(credit.Int64)
		n.CreditLimit = &v
	}
	n.TypeID = store.PtrID(typ)
	n.RepID = store.PtrID(rep)
	n.PaymentMethodID = store.PtrID(pm)
	n.Taxable = taxable == 1
	n.TaxItemID = store.PtrID(taxItem)
	n.Is1099 = is1099 == 1
	n.PrefillAccountIDs = []int64{}
	if prefill != "" {
		json.Unmarshal([]byte(prefill), &n.PrefillAccountIDs)
		if n.PrefillAccountIDs == nil {
			n.PrefillAccountIDs = []int64{}
		}
	}
	n.JobTypeID = store.PtrID(jobType)
	n.Active = active == 1
	return n, nil
}

// Names returns names of one kind ("" = all kinds) in list order (customers
// followed by their jobs, siblings by name) with fullName, level, balances
// (customers: A/R incl. jobs, debit positive; vendors: A/P, credit positive)
// and hasTxns filled in.
func Names(ctx context.Context, q store.Q, kind string) ([]model.Name, error) {
	query := `SELECT ` + nameCols + ` FROM names`
	var args []any
	if kind != "" {
		query += ` WHERE kind = ?`
		args = append(args, kind)
	}
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []model.Name
	for rows.Next() {
		n, err := scanName(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := fillNames(ctx, q, list); err != nil {
		return nil, err
	}
	order, level := treeSort(len(list),
		func(i int) int64 { return list[i].ID },
		func(i int) int64 {
			if list[i].ParentID == nil {
				return 0
			}
			return *list[i].ParentID
		},
		func(x, y int) bool { return lessFold(list[x].Name, list[y].Name) })
	out := make([]model.Name, 0, len(list))
	for _, i := range order {
		n := list[i]
		n.Level = level[i]
		out = append(out, n)
	}
	return out, nil
}

// fillNames computes fullName, level, balances and hasTxns. Hierarchy data is
// read for all names so that a subset (one kind) still gets correct values.
func fillNames(ctx context.Context, q store.Q, list []model.Name) error {
	rows, err := q.QueryContext(ctx, `SELECT id, name, parent_id FROM names`)
	if err != nil {
		return err
	}
	defer rows.Close()
	names := map[int64]string{}
	parents := map[int64]int64{}
	for rows.Next() {
		var id int64
		var name string
		var p sql.NullInt64
		if err := rows.Scan(&id, &name, &p); err != nil {
			return err
		}
		names[id] = name
		if p.Valid {
			parents[id] = p.Int64
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()
	full := fullNames(names, parents)

	ar, err := sumByID(ctx, q, `SELECT g.name_id, SUM(g.amount) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE a.type = ? AND g.name_id IS NOT NULL GROUP BY g.name_id`, model.AcctAR)
	if err != nil {
		return err
	}
	ap, err := sumByID(ctx, q, `SELECT g.name_id, SUM(g.amount) FROM gl_entries g JOIN accounts a ON a.id = g.account_id
		WHERE a.type = ? AND g.name_id IS NOT NULL GROUP BY g.name_id`, model.AcctAP)
	if err != nil {
		return err
	}
	used, err := idSet(ctx, q, `SELECT name_id FROM txns WHERE name_id IS NOT NULL
		UNION SELECT name_id FROM txn_lines WHERE name_id IS NOT NULL
		UNION SELECT DISTINCT name_id FROM gl_entries WHERE name_id IS NOT NULL`)
	if err != nil {
		return err
	}
	// A/R balances roll up from jobs to their customer
	arTotal := map[int64]int64{}
	for id, s := range ar {
		p, depth := id, 0
		for p != 0 && depth < 64 {
			arTotal[p] += s
			p = parents[p]
			depth++
		}
	}
	level := func(id int64) int {
		lv := 0
		for p := parents[id]; p != 0 && lv < 64; p = parents[p] {
			lv++
		}
		return lv
	}
	for i := range list {
		n := &list[i]
		n.FullName = full[n.ID]
		n.Level = level(n.ID)
		n.HasTxns = used[n.ID]
		switch n.Kind {
		case model.NameCustomer:
			n.OwnBalance = store.Dollars(ar[n.ID])
			n.Balance = store.Dollars(arTotal[n.ID])
		case model.NameVendor:
			n.OwnBalance = store.Dollars(-ap[n.ID])
			n.Balance = n.OwnBalance
		}
	}
	return nil
}

// GetName returns one name with its computed fields.
func GetName(ctx context.Context, q store.Q, id int64) (*model.Name, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+nameCols+` FROM names WHERE id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return nil, apperr.NotFound("Name not found.")
	}
	n, err := scanName(rows)
	if err != nil {
		return nil, err
	}
	rows.Close()
	list := []model.Name{n}
	if err := fillNames(ctx, q, list); err != nil {
		return nil, err
	}
	return &list[0], nil
}

// ---------------------------------------------------------------------------
// Writing

// checkListRef verifies that id (when set) is an entry of one of the lists.
func checkListRef(ctx context.Context, q store.Q, id *int64, field string, lists ...string) error {
	if id == nil {
		return nil
	}
	var l string
	err := q.QueryRowContext(ctx, `SELECT list FROM list_entries WHERE id = ?`, *id).Scan(&l)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.Validation(field, "The selected list entry does not exist.")
	}
	if err != nil {
		return err
	}
	for _, x := range lists {
		if x == l {
			return nil
		}
	}
	return apperr.Validation(field, "The selected entry belongs to the wrong list (%s).", l)
}

// checkAccountRef verifies that an account id (when set) exists.
func checkAccountRef(ctx context.Context, q store.Q, id *int64, field string) (string, error) {
	if id == nil {
		return "", nil
	}
	var t string
	err := q.QueryRowContext(ctx, `SELECT type FROM accounts WHERE id = ?`, *id).Scan(&t)
	if errors.Is(err, sql.ErrNoRows) {
		return "", apperr.Validation(field, "The selected account does not exist.")
	}
	return t, err
}

var jobStatuses = map[string]bool{"": true, "Pending": true, "Awarded": true, "In progress": true, "Closed": true, "Not awarded": true}

// SaveName validates and stores a customer, job, vendor or other name
// (n.ID == 0 creates it). On create, a non-zero n.OpeningBalance posts an
// invoice (customer/job) or bill (vendor) via ledger.Save; a negative amount
// posts a credit memo / vendor credit instead. Returns the name id.
func SaveName(ctx context.Context, tx *sql.Tx, n *model.Name, opt ledger.SaveOptions) (int64, error) {
	name, err := cleanName(n.Name, "name")
	if err != nil {
		return 0, err
	}
	n.Name = name
	n.Kind = strings.TrimSpace(n.Kind)
	n.ParentID = normID(n.ParentID)
	for _, p := range []**int64{&n.TermsID, &n.TypeID, &n.RepID, &n.PaymentMethodID, &n.TaxItemID, &n.JobTypeID} {
		*p = normID(*p)
	}

	var oldKind string
	if n.ID != 0 {
		if err := store.CheckStale(ctx, tx, "names", n.ID, n.UpdatedAt, "name"); err != nil {
			return 0, err
		}
		err := tx.QueryRowContext(ctx, `SELECT kind FROM names WHERE id = ?`, n.ID).Scan(&oldKind)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, apperr.NotFound("Name not found.")
		}
		if err != nil {
			return 0, err
		}
		if n.Kind == "" {
			n.Kind = oldKind
		}
	}
	if n.Kind == "" && n.ParentID != nil {
		n.Kind = model.NameCustomer
	}
	if !validKind(n.Kind) {
		return 0, apperr.Validation("kind", "Choose whether this is a customer, vendor or other name.")
	}
	if n.ParentID != nil {
		if n.Kind != model.NameCustomer {
			return 0, apperr.Validation("parentId", "Only customers can have jobs.")
		}
		pk, err := checkParent(ctx, tx, "names", n.ID, *n.ParentID, "kind")
		if err != nil {
			return 0, err
		}
		if pk != model.NameCustomer {
			return 0, apperr.Validation("parentId", "A job must belong to a customer.")
		}
	}
	if oldKind != "" && oldKind != n.Kind {
		if kids, err := exists(ctx, tx, `SELECT 1 FROM names WHERE parent_id = ? LIMIT 1`, n.ID); err != nil {
			return 0, err
		} else if kids {
			return 0, apperr.Conflict("A customer that has jobs cannot be changed to another type of name.")
		}
		if oldKind != model.NameOther {
			used, err := nameUsed(ctx, tx, n.ID)
			if err != nil {
				return 0, err
			}
			if used {
				return 0, apperr.Conflict("This name has transactions and cannot be changed to another type of name.")
			}
		}
	}
	if dup, err := siblingExists(ctx, tx, "names", n.ParentID, n.Name, n.ID, ""); err != nil {
		return 0, err
	} else if dup {
		return 0, nameTaken(ctx, tx, n.ParentID, n.Name, n.ID)
	}

	typeList := model.ListCustomerType
	if n.Kind == model.NameVendor {
		typeList = model.ListVendorType
	}
	if n.Kind == model.NameOther {
		n.TypeID = nil
	}
	if err := checkListRef(ctx, tx, n.TermsID, "termsId", model.ListTerms); err != nil {
		return 0, err
	}
	if err := checkListRef(ctx, tx, n.TypeID, "typeId", typeList); err != nil {
		return 0, err
	}
	if err := checkListRef(ctx, tx, n.RepID, "repId", model.ListSalesRep); err != nil {
		return 0, err
	}
	if err := checkListRef(ctx, tx, n.PaymentMethodID, "paymentMethodId", model.ListPaymentMethod); err != nil {
		return 0, err
	}
	if err := checkListRef(ctx, tx, n.JobTypeID, "jobTypeId", model.ListJobType); err != nil {
		return 0, err
	}
	if n.TaxItemID != nil {
		var t string
		err := tx.QueryRowContext(ctx, `SELECT type FROM items WHERE id = ?`, *n.TaxItemID).Scan(&t)
		if err != nil || (t != model.ItemSalesTax && t != model.ItemSalesTaxGroup) {
			return 0, apperr.Validation("taxItemId", "The tax item must be a sales tax item or a sales tax group.")
		}
	}
	if n.CreditLimit != nil && *n.CreditLimit < 0 {
		return 0, apperr.Validation("creditLimit", "The credit limit cannot be negative.")
	}
	if !jobStatuses[n.JobStatus] {
		return 0, apperr.Validation("jobStatus", "Choose a valid job status.")
	}
	for _, f := range []struct{ v, field string }{{n.JobStartDate, "jobStartDate"}, {n.JobProjectedEnd, "jobProjectedEnd"}, {n.JobEndDate, "jobEndDate"}} {
		if f.v != "" && !store.ValidDate(f.v) {
			return 0, apperr.Validation(f.field, "Enter a valid date.")
		}
	}
	prefill := []int64{}
	for _, a := range n.PrefillAccountIDs {
		if a == 0 {
			continue
		}
		id := a
		if _, err := checkAccountRef(ctx, tx, &id, "prefillAccountIds"); err != nil {
			return 0, err
		}
		prefill = append(prefill, a)
	}
	if len(prefill) > 3 {
		return 0, apperr.Validation("prefillAccountIds", "You can choose up to three prefill accounts.")
	}
	n.PrefillAccountIDs = prefill
	prefillJSON, _ := json.Marshal(prefill)
	var credit any
	if n.CreditLimit != nil {
		if err := store.MoneyErr("creditLimit", "The credit limit", *n.CreditLimit); err != nil {
			return 0, err
		}
		credit = store.Cents(*n.CreditLimit)
	}
	if n.OpeningBalance != nil {
		if err := store.MoneyErr("openingBalance", "The opening balance", *n.OpeningBalance); err != nil {
			return 0, err
		}
	}

	now := store.Now()
	var cv cols
	b, s := n.BillAddress, n.ShipAddress
	for _, kv := range []struct {
		col string
		v   any
	}{
		{"kind", n.Kind}, {"name", n.Name}, {"parent_id", store.NullID(n.ParentID)},
		{"company_name", n.CompanyName}, {"salutation", n.Salutation}, {"first_name", n.FirstName}, {"middle_name", n.MiddleName},
		{"last_name", n.LastName}, {"job_title", n.JobTitle}, {"phone", n.Phone}, {"alt_phone", n.AltPhone}, {"mobile", n.Mobile},
		{"fax", n.Fax}, {"email", strings.TrimSpace(n.Email)}, {"cc_email", strings.TrimSpace(n.CcEmail)}, {"website", n.Website},
		{"bill_line1", b.Line1}, {"bill_line2", b.Line2}, {"bill_line3", b.Line3}, {"bill_city", b.City}, {"bill_state", b.State},
		{"bill_zip", b.Zip}, {"bill_country", b.Country},
		{"ship_line1", s.Line1}, {"ship_line2", s.Line2}, {"ship_line3", s.Line3}, {"ship_city", s.City}, {"ship_state", s.State},
		{"ship_zip", s.Zip}, {"ship_country", s.Country},
		{"account_number", n.AccountNumber}, {"terms_id", store.NullID(n.TermsID)}, {"credit_limit", credit},
		{"type_id", store.NullID(n.TypeID)}, {"rep_id", store.NullID(n.RepID)}, {"payment_method_id", store.NullID(n.PaymentMethodID)},
		{"taxable", store.B(n.Taxable)}, {"tax_item_id", store.NullID(n.TaxItemID)}, {"resale_number", n.ResaleNumber},
		{"print_on_check_as", n.PrintOnCheckAs}, {"tax_ident", n.TaxIdent}, {"is_1099", store.B(n.Is1099)},
		{"prefill_account_ids", string(prefillJSON)},
		{"job_status", n.JobStatus}, {"job_start_date", n.JobStartDate}, {"job_projected_end", n.JobProjectedEnd},
		{"job_end_date", n.JobEndDate}, {"job_description", n.JobDescription}, {"job_type_id", store.NullID(n.JobTypeID)},
		{"notes", n.Notes}, {"updated_at", store.Stamp()},
	} {
		cv.add(kv.col, kv.v)
	}
	id := n.ID
	if id == 0 {
		cv.add("active", store.B(n.Active))
		cv.add("created_at", now)
		if id, err = cv.insert(ctx, tx, "names"); err != nil {
			return 0, mapDBError(err, n.Name)
		}
	} else if err := cv.update(ctx, tx, "names", id); err != nil {
		return 0, mapDBError(err, n.Name)
	}
	var curActive int
	if err := tx.QueryRowContext(ctx, `SELECT active FROM names WHERE id = ?`, id).Scan(&curActive); err != nil {
		return 0, err
	}
	if n.ID == 0 || (curActive == 1) != n.Active {
		if err := setActive(ctx, tx, "names", id, n.Active); err != nil {
			return 0, err
		}
	}

	if n.ID == 0 && n.OpeningBalance != nil && store.Cents(*n.OpeningBalance) != 0 {
		if err := nameOpeningBalance(ctx, tx, id, n, opt); err != nil {
			return 0, err
		}
	}
	return id, nil
}

// nameOpeningBalance posts a customer/job opening balance as an invoice (or a
// credit memo when negative) and a vendor opening balance as a bill (or a
// vendor credit when negative).
func nameOpeningBalance(ctx context.Context, tx *sql.Tx, id int64, n *model.Name, opt ledger.SaveOptions) error {
	date := strings.TrimSpace(n.OpeningDate)
	if date == "" {
		date = store.Today()
	}
	if !store.ValidDate(date) {
		return apperr.Validation("openingDate", "Enter a valid opening balance date.")
	}
	amt := store.Round2(*n.OpeningBalance)
	nameID := id
	t := model.Txn{Date: date, NameID: &nameID, Memo: "Opening balance", TermsID: n.TermsID,
		Extra: map[string]any{"openingBalance": true}}
	switch n.Kind {
	case model.NameCustomer:
		inc, err := store.SpecialAccount(ctx, tx, store.SpecialUncategorizedIncome)
		if err != nil {
			return err
		}
		t.Type = model.TxInvoice
		if amt < 0 {
			t.Type = model.TxCreditMemo
			t.TermsID = nil
			amt = -amt
		}
		t.Lines = []model.TxnLine{{Kind: model.LineItem, AccountID: &inc, Description: "Opening balance", Amount: amt}}
	case model.NameVendor:
		exp, err := store.SpecialAccount(ctx, tx, store.SpecialUncategorizedExpense)
		if err != nil {
			return err
		}
		t.Type = model.TxBill
		if amt < 0 {
			t.Type = model.TxVendorCredit
			t.TermsID = nil
			amt = -amt
		}
		t.Lines = []model.TxnLine{{Kind: model.LineExpense, AccountID: &exp, Description: "Opening balance", Amount: amt}}
	default:
		return apperr.Validation("openingBalance", "Other names do not have an opening balance.")
	}
	_, err := ledger.Save(ctx, tx, &t, opt)
	return err
}

// nameUsed reports whether a name appears on any transaction.
func nameUsed(ctx context.Context, q store.Q, id int64) (bool, error) {
	return exists(ctx, q, `SELECT 1 FROM txns WHERE name_id = ?1
		UNION SELECT 1 FROM txn_lines WHERE name_id = ?1
		UNION SELECT 1 FROM gl_entries WHERE name_id = ?1 LIMIT 1`, id)
}

// DeleteName removes a name that has no transactions and no jobs.
func DeleteName(ctx context.Context, tx *sql.Tx, id int64) error {
	var name string
	err := tx.QueryRowContext(ctx, `SELECT name FROM names WHERE id = ?`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.NotFound("Name not found.")
	}
	if err != nil {
		return err
	}
	if kids, err := exists(ctx, tx, `SELECT 1 FROM names WHERE parent_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if kids {
		return apperr.Conflict("This name has jobs or transactions and cannot be deleted. Make it inactive instead.")
	}
	if used, err := nameUsed(ctx, tx, id); err != nil {
		return err
	} else if used {
		return apperr.Conflict("This name has jobs or transactions and cannot be deleted. Make it inactive instead.")
	}
	if inItems, err := exists(ctx, tx, `SELECT 1 FROM items WHERE preferred_vendor_id = ?1 OR tax_agency_id = ?1 LIMIT 1`, id); err != nil {
		return err
	} else if inItems {
		return apperr.Conflict("This name is used by one or more items (preferred vendor or sales tax agency). Change those items or make the name inactive instead.")
	}
	if inBudgets, err := exists(ctx, tx, `SELECT 1 FROM budget_lines WHERE name_id = ? LIMIT 1`, id); err != nil {
		return err
	} else if inBudgets {
		return apperr.Conflict("This name is used in a budget. Make it inactive instead.")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE bank_rules SET name_id = NULL WHERE name_id = ?`, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM names WHERE id = ?`, id); err != nil {
		return mapDBError(err, name)
	}
	return nil
}
