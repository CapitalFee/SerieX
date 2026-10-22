package reports

// Customer statements: GET /statements.

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/url"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

func init() {
	addRoutes(func(rt *httpx.Router) {
		// GET /statements?customerIds=1,2&from=&to=&statementDate=&mode=range|open&includeZero=0
		rt.C("GET", "/statements", func(c *httpx.Ctx) error {
			res, err := opsStatements(c.Context(), c.DB, c.R.URL.Query())
			if err != nil {
				return err
			}
			return c.JSON(res)
		})
	})
}

// opsLoadModelName reads one name as the model.Name contract type.
func opsLoadModelName(ctx context.Context, q store.Q, id int64) (model.Name, error) {
	var n model.Name
	var parent, terms, typ, rep, pm, taxItem, jobType, credit sql.NullInt64
	var prefill string
	err := q.QueryRowContext(ctx, `SELECT id, kind, name, parent_id, company_name, salutation, first_name, middle_name, last_name,
		job_title, phone, alt_phone, mobile, fax, email, cc_email, website,
		bill_line1, bill_line2, bill_line3, bill_city, bill_state, bill_zip, bill_country,
		ship_line1, ship_line2, ship_line3, ship_city, ship_state, ship_zip, ship_country,
		account_number, terms_id, credit_limit, type_id, rep_id, payment_method_id, taxable, tax_item_id, resale_number,
		print_on_check_as, tax_ident, is_1099, prefill_account_ids, job_status, job_start_date, job_projected_end, job_end_date,
		job_description, job_type_id, notes, active FROM names WHERE id = ?`, id).Scan(
		&n.ID, &n.Kind, &n.Name, &parent, &n.CompanyName, &n.Salutation, &n.FirstName, &n.MiddleName, &n.LastName,
		&n.JobTitle, &n.Phone, &n.AltPhone, &n.Mobile, &n.Fax, &n.Email, &n.CcEmail, &n.Website,
		&n.BillAddress.Line1, &n.BillAddress.Line2, &n.BillAddress.Line3, &n.BillAddress.City, &n.BillAddress.State, &n.BillAddress.Zip, &n.BillAddress.Country,
		&n.ShipAddress.Line1, &n.ShipAddress.Line2, &n.ShipAddress.Line3, &n.ShipAddress.City, &n.ShipAddress.State, &n.ShipAddress.Zip, &n.ShipAddress.Country,
		&n.AccountNumber, &terms, &credit, &typ, &rep, &pm, &n.Taxable, &taxItem, &n.ResaleNumber,
		&n.PrintOnCheckAs, &n.TaxIdent, &n.Is1099, &prefill, &n.JobStatus, &n.JobStartDate, &n.JobProjectedEnd, &n.JobEndDate,
		&n.JobDescription, &jobType, &n.Notes, &n.Active)
	if err != nil {
		return n, err
	}
	n.ParentID, n.TermsID, n.TypeID, n.RepID = store.PtrID(parent), store.PtrID(terms), store.PtrID(typ), store.PtrID(rep)
	n.PaymentMethodID, n.TaxItemID, n.JobTypeID = store.PtrID(pm), store.PtrID(taxItem), store.PtrID(jobType)
	if credit.Valid {
		v := store.Dollars(credit.Int64)
		n.CreditLimit = &v
	}
	n.PrefillAccountIDs = []int64{}
	if prefill != "" {
		json.Unmarshal([]byte(prefill), &n.PrefillAccountIDs)
	}
	return n, nil
}

type opsARTxn struct {
	TxnID, NameID        int64
	Type, Date, Ref, Due string
	Memo, LineDesc       string
	TxnAmount, Amount    int64 // Amount: natural-sign A/R effect
}

// opsStatementDesc is the "Transaction" column text of a statement line.
func opsStatementDesc(x *opsARTxn) string {
	abbrev := model.TxnTypeAbbrev[x.Type]
	if abbrev == "" {
		abbrev = x.Type
	}
	switch x.Type {
	case model.TxStatementCharge:
		if x.LineDesc != "" {
			return x.LineDesc
		}
		if x.Memo != "" {
			return x.Memo
		}
		return "Statement Charge"
	case model.TxInvoice:
		s := abbrev
		if x.Ref != "" {
			s += " #" + x.Ref
		}
		s += "."
		if x.Due != "" {
			s += " Due " + opsUSDate(x.Due) + "."
		}
		s += " Orig. Amount $" + opsMoneyText(x.TxnAmount) + "."
		return s
	}
	s := abbrev
	if x.Ref != "" {
		s += " #" + x.Ref
	}
	return s + "."
}

func opsStatements(ctx context.Context, q store.Q, v url.Values) ([]model.Statement, error) {
	prefs, err := store.LoadPrefs(ctx, q)
	if err != nil {
		return nil, err
	}
	stmtDate := v.Get("statementDate")
	if stmtDate == "" {
		stmtDate = store.Today()
	}
	if !store.ValidDate(stmtDate) {
		return nil, apperr.Validation("statementDate", "Invalid statement date %q", stmtDate)
	}
	mode := v.Get("mode")
	if mode == "" {
		mode = "range"
	}
	if mode != "range" && mode != "open" {
		return nil, apperr.Validation("mode", "Invalid statement mode %q", mode)
	}
	from, to := v.Get("from"), v.Get("to")
	if to == "" {
		to = stmtDate
	}
	if from != "" && !store.ValidDate(from) {
		return nil, apperr.Validation("from", "Invalid From date %q", from)
	}
	if !store.ValidDate(to) {
		return nil, apperr.Validation("to", "Invalid To date %q", to)
	}
	if from != "" && from > to {
		return nil, apperr.Validation("from", "The From date must be on or before the To date.")
	}
	includeZero := v.Get("includeZero") == "1" || v.Get("includeZero") == "true"

	names, err := opsLoadNames(ctx, q)
	if err != nil {
		return nil, err
	}
	var custIDs []int64
	explicit := false
	for _, part := range strings.Split(v.Get("customerIds"), ",") {
		if id := parseIDs(part); len(id) > 0 {
			if n, ok := names[id[0]]; ok && n.Kind == model.NameCustomer {
				custIDs = append(custIDs, id[0])
				explicit = true
			}
		}
	}
	if !explicit {
		for _, n := range names {
			if n.Kind == model.NameCustomer && n.ParentID == 0 {
				custIDs = append(custIDs, n.ID)
			}
		}
		sort.Slice(custIDs, func(i, j int) bool {
			return strings.ToLower(names[custIDs[i]].Full) < strings.ToLower(names[custIDs[j]].Full)
		})
	}
	children := map[int64][]int64{}
	for _, n := range names {
		children[n.ParentID] = append(children[n.ParentID], n.ID)
	}
	subtree := func(id int64) map[int64]bool {
		set := map[int64]bool{id: true}
		stack := []int64{id}
		for len(stack) > 0 {
			x := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, c := range children[x] {
				if !set[c] {
					set[c] = true
					stack = append(stack, c)
				}
			}
		}
		return set
	}

	// Open documents as of the statement date (aging, amount due, open-item mode).
	docs, err := opsOpenDocs(ctx, q, "ar", stmtDate)
	if err != nil {
		return nil, err
	}
	// A/R activity through the end of the period (range mode).
	var activity []*opsARTxn
	if mode == "range" {
		rows, err := q.QueryContext(ctx, `SELECT g.txn_id, IFNULL(g.name_id, 0), SUM(g.amount), t.type, t.date, t.ref_number, t.due_date,
			t.memo, t.amount, IFNULL((SELECT l.description FROM txn_lines l WHERE l.txn_id = t.id ORDER BY l.seq LIMIT 1), '')
			FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN txns t ON t.id = g.txn_id
			WHERE a.type = ? AND g.date <= ?
			GROUP BY g.txn_id, IFNULL(g.name_id, 0) ORDER BY t.date, t.id`, model.AcctAR, to)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			x := &opsARTxn{}
			if err := rows.Scan(&x.TxnID, &x.NameID, &x.Amount, &x.Type, &x.Date, &x.Ref, &x.Due, &x.Memo, &x.TxnAmount, &x.LineDesc); err != nil {
				rows.Close()
				return nil, err
			}
			activity = append(activity, x)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	lineDesc := map[int64]string{}
	if mode == "open" {
		rows, err := q.QueryContext(ctx, `SELECT t.id, IFNULL((SELECT l.description FROM txn_lines l WHERE l.txn_id = t.id ORDER BY l.seq LIMIT 1), '')
			FROM txns t WHERE t.type = 'STMTCHG' AND t.date <= ?`, stmtDate)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var d string
			if err := rows.Scan(&id, &d); err != nil {
				rows.Close()
				return nil, err
			}
			lineDesc[id] = d
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	allBal, err := opsBalancesByName(ctx, q, "ar", "9999-12-31")
	if err != nil {
		return nil, err
	}

	out := []model.Statement{}
	for _, cid := range custIDs {
		set := subtree(cid)
		st := model.Statement{StatementDate: stmtDate, From: from, To: to, Rows: []model.StatementRow{}}
		desc := func(x *opsARTxn) string {
			d := opsStatementDesc(x)
			if x.NameID != cid {
				if n, ok := names[x.NameID]; ok {
					d = n.Name + ": " + d
				}
			}
			return d
		}
		// One row per transaction: a payment split over several jobs is one line.
		var items []*opsARTxn
		byTxn := map[int64]*opsARTxn{}
		merge := func(x *opsARTxn) {
			if cur, ok := byTxn[x.TxnID]; ok {
				cur.Amount += x.Amount
				if cur.NameID != x.NameID {
					cur.NameID = cid
				}
				return
			}
			c := *x
			byTxn[x.TxnID] = &c
			items = append(items, &c)
		}
		var opening, ending int64
		switch mode {
		case "range":
			for _, x := range activity {
				if !set[x.NameID] {
					continue
				}
				if from != "" && x.Date < from {
					opening += x.Amount
					continue
				}
				merge(x)
			}
		case "open":
			for _, d := range docs {
				if d.Open == 0 || !set[d.NameID] {
					continue
				}
				merge(&opsARTxn{TxnID: d.TxnID, NameID: d.NameID, Type: d.Type, Date: d.Date, Ref: d.Ref, Due: d.DueDate,
					Memo: d.Memo, LineDesc: lineDesc[d.TxnID], TxnAmount: d.TxnAmount, Amount: d.Open})
			}
		}
		run := opening
		for _, x := range items {
			if x.Amount == 0 && mode == "open" {
				continue
			}
			run += x.Amount
			row := model.StatementRow{TxnID: x.TxnID, Date: x.Date, Type: x.Type, RefNumber: x.Ref, Description: desc(x),
				Amount: store.Dollars(x.Amount), Balance: store.Dollars(run)}
			if x.Type == model.TxInvoice || x.Type == model.TxStatementCharge {
				row.DueDate = x.Due
			}
			st.Rows = append(st.Rows, row)
		}
		ending = run
		// Aging and amount due as of the statement date.
		var buckets [5]int64
		var due int64
		for _, d := range docs {
			if d.Open == 0 || !set[d.NameID] {
				continue
			}
			due += d.Open
			days := opsDays(d.ageDate(prefs), stmtDate)
			i := 0
			switch {
			case days <= 0:
				i = 0
			case days <= 30:
				i = 1
			case days <= 60:
				i = 2
			case days <= 90:
				i = 3
			default:
				i = 4
			}
			buckets[i] += d.Open
		}
		if !includeZero && ending == 0 && due == 0 {
			continue
		}
		st.OpeningBalance = store.Dollars(opening)
		st.EndingBalance = store.Dollars(ending)
		st.AmountDue = store.Dollars(due)
		st.Aging = model.StatementAging{Current: store.Dollars(buckets[0]), D1_30: store.Dollars(buckets[1]),
			D31_60: store.Dollars(buckets[2]), D61_90: store.Dollars(buckets[3]), Over90: store.Dollars(buckets[4])}
		cust, err := opsLoadModelName(ctx, q, cid)
		if err != nil {
			return nil, err
		}
		cust.FullName = names[cid].Full
		cust.Level = names[cid].Level
		var bal, own int64
		for id := range set {
			bal += allBal[id]
		}
		own = allBal[cid]
		cust.Balance, cust.OwnBalance = store.Dollars(bal), store.Dollars(own)
		cust.HasTxns = bal != 0 || len(st.Rows) > 0
		st.Customer = cust
		st.BillAddress = names[cid].billTo()
		out = append(out, st)
	}
	return out, nil
}
