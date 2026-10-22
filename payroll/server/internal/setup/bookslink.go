package setup

import (
	"context"
	"sort"
	"strings"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/store"
)

func registerBooks(rt *httpx.Router) {
	rt.C("GET", "/books/status", booksStatus)
	rt.C("GET", "/books/open-url", func(c *httpx.Ctx) error {
		return c.JSON(map[string]string{"url": books.Default.BaseURL})
	})
	rt.C("GET", "/books/accounts", booksAccounts)
	rt.C("POST", "/books/accounts", booksCreateAccount)
	rt.C("GET", "/books/vendors", func(c *httpx.Ctx) error { return booksNames(c, books.NameVendor) })
	rt.C("POST", "/books/vendors", booksCreateVendor)
	rt.C("GET", "/books/classes", booksClasses)
	rt.C("GET", "/books/jobs", func(c *httpx.Ctx) error { return booksNames(c, books.NameCustomer) })
	rt.C("GET", "/books/next-check", booksNextCheck)
	rt.C("GET", "/books/sync", booksSync)
	rt.C("POST", "/books/sync/retry", booksRetry)
	rt.C("POST", "/books/verify", booksVerify)
}

func toBooksAccount(a books.Account) model.BooksAccount {
	return model.BooksAccount{ID: a.ID, Name: a.Name, FullName: a.FullName, Number: a.Number, Type: a.Type, Level: a.Level,
		Balance: a.Balance, Active: a.Active}
}

func toBooksName(n books.Name) model.BooksName {
	return model.BooksName{ID: n.ID, Kind: n.Kind, Name: n.Name, FullName: n.FullName, Level: n.Level, Active: n.Active,
		Address: books.CheckAddress(n)}
}

// Records that never go to SerieX Books and have nothing there to remove (Set Up
// year-to-date amounts, earlier tax payments, adjustments that do not affect accounts) are
// never listed as waiting, whatever status they were saved with.
const (
	syncPaycheckWhere   = ` AND NOT (p.kind = 'ytd' AND p.books_txn_id IS NULL)`
	syncPaymentWhere    = ` AND NOT (kind = 'prior' AND books_txn_id IS NULL)`
	syncAdjustmentWhere = ` AND NOT (a.affects_accounts = 0 AND a.books_txn_id IS NULL)`
)

// syncCounts returns the number of records waiting to be posted and in error.
func syncCounts(ctx context.Context, q store.Q) (pending, errs int, err error) {
	count := func(status string) string {
		return `(SELECT COUNT(*) FROM paychecks p WHERE p.sync_status = '` + status + `'` + syncPaycheckWhere + `)
			+ (SELECT COUNT(*) FROM liability_payments WHERE sync_status = '` + status + `'` + syncPaymentWhere + `)
			+ (SELECT COUNT(*) FROM liability_adjustments a WHERE a.sync_status = '` + status + `'` + syncAdjustmentWhere + `)`
	}
	err = q.QueryRowContext(ctx, `SELECT `+count("pending")+`, `+count("error")).Scan(&pending, &errs)
	return
}

// GET /books/status
func booksStatus(c *httpx.Ctx) error {
	ctx := c.Context()
	prefs, err := store.LoadPrefs(ctx, c.DB)
	if err != nil {
		return err
	}
	st := model.BooksStatus{URL: books.Default.BaseURL, PostToBooks: prefs.PostToBooks}
	if st.PendingCount, st.ErrorCount, err = syncCounts(ctx, c.DB); err != nil {
		return err
	}
	st.Reachable = books.Default.Ping(ctx)
	if !st.Reachable {
		st.Message = "SerieX Books is not running at " + books.Default.BaseURL + ". Start SerieX Books to post payroll transactions."
		return c.JSON(st)
	}
	ci, err := books.Default.CompanyInfo(ctx, books.S(c))
	switch {
	case err == nil:
		st.CompanyName, st.SessionOK = ci.Name, true
		st.Message = "Connected to SerieX Books."
	case books.IsAuth(err):
		st.Message = "Your SerieX Books session has expired. Log in again to post payroll transactions."
	case books.IsNotFound(err) || strings.Contains(err.Error(), "Company file"):
		st.Message = "This company file was not found in SerieX Books."
	default:
		st.Message = posting.ProblemMessage(err)
	}
	if st.SessionOK && !prefs.PostToBooks {
		st.Message = "Posting to SerieX Books is turned off in the payroll preferences."
	}
	return c.JSON(st)
}

// GET /books/accounts?types=Bank,Expense
func booksAccounts(c *httpx.Ctx) error {
	var types []string
	for _, t := range strings.Split(c.Q("types"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			types = append(types, t)
		}
	}
	accts, err := books.Default.Accounts(c.Context(), books.S(c), types...)
	if err != nil {
		return books.ToAppErr(err)
	}
	out := []model.BooksAccount{}
	for _, a := range accts {
		out = append(out, toBooksAccount(a))
	}
	return c.JSON(out)
}

// POST /books/accounts (NewBooksAccount)
func booksCreateAccount(c *httpx.Ctx) error {
	var in model.NewBooksAccount
	if err := c.Decode(&in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return apperr.Validation("name", "Enter a name for the account.")
	}
	if strings.TrimSpace(in.Type) == "" {
		return apperr.Validation("type", "Choose the account type.")
	}
	if in.ParentID != nil && *in.ParentID == 0 {
		in.ParentID = nil
	}
	a, err := books.Default.CreateAccount(c.Context(), books.S(c), books.Account{Name: in.Name, Type: strings.TrimSpace(in.Type),
		ParentID: in.ParentID, Number: strings.TrimSpace(in.Number), Active: true})
	if err != nil {
		return books.ToAppErr(err)
	}
	posting.Invalidate(c.CompanyID)
	return c.JSON(toBooksAccount(a))
}

func booksNames(c *httpx.Ctx, kind string) error {
	names, err := books.Default.Names(c.Context(), books.S(c), kind)
	if err != nil {
		return books.ToAppErr(err)
	}
	out := []model.BooksName{}
	for _, n := range names {
		out = append(out, toBooksName(n))
	}
	return c.JSON(out)
}

// POST /books/vendors (NewBooksVendor)
func booksCreateVendor(c *httpx.Ctx) error {
	var in model.NewBooksVendor
	if err := c.Decode(&in); err != nil {
		return err
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		return apperr.Validation("name", "Enter the vendor name.")
	}
	n := books.Name{
		Kind:          books.NameVendor,
		Name:          in.Name,
		CompanyName:   strings.TrimSpace(in.CompanyName),
		Phone:         strings.TrimSpace(in.Phone),
		AccountNumber: strings.TrimSpace(in.AccountNumber),
		Active:        true,
		BillAddress: books.Address{Line1: in.Address.Line1, Line2: in.Address.Line2, City: in.Address.City,
			State: in.Address.State, Zip: in.Address.Zip},
	}
	if n.CompanyName == "" {
		n.CompanyName = in.Name
	}
	n.PrintOnCheckAs = n.CompanyName // as SerieX Books does for a new vendor
	out, err := books.Default.CreateName(c.Context(), books.S(c), n)
	if err != nil {
		return books.ToAppErr(err)
	}
	posting.Invalidate(c.CompanyID)
	return c.JSON(toBooksName(out))
}

// GET /books/classes
func booksClasses(c *httpx.Ctx) error {
	list, err := books.Default.List(c.Context(), books.S(c), "class")
	if err != nil {
		return books.ToAppErr(err)
	}
	out := []model.BooksListEntry{}
	for _, e := range list {
		out = append(out, model.BooksListEntry{ID: e.ID, Name: e.Name, FullName: e.FullName, Level: e.Level, Active: e.Active})
	}
	return c.JSON(out)
}

// GET /books/next-check?accountId=
func booksNextCheck(c *httpx.Ctx) error {
	id := c.QInt("accountId")
	if id <= 0 {
		return apperr.Validation("accountId", "Choose a bank account.")
	}
	ref, err := books.Default.NextRef(c.Context(), books.S(c), books.TxCheck, id)
	if err != nil {
		return books.ToAppErr(err)
	}
	return c.JSON(map[string]string{"refNumber": ref})
}

// GET /books/sync?status=open|all&from=&to=
func booksSync(c *httpx.Ctx) error {
	statuses := "'pending','error'"
	switch c.Q("status") {
	case "", "open":
	case "all":
		statuses = "'pending','error','posted'"
	default:
		return apperr.Validation("status", "status must be open or all")
	}
	from, to := c.Q("from"), c.Q("to")
	if from == "" {
		from = "0000-01-01"
	} else if !store.ValidDate(from) {
		return apperr.Validation("from", "Please enter a valid From date.")
	}
	if to == "" {
		to = "9999-12-31"
	} else if !store.ValidDate(to) {
		return apperr.Validation("to", "Please enter a valid To date.")
	}
	rows, err := c.DB.QueryContext(c.Context(), `
		SELECT 'paycheck', p.id, p.check_date, 'Paycheck - ' || e.display_name, p.net, p.books_txn_id, p.sync_status, p.sync_error, p.synced_at
			FROM paychecks p JOIN employees e ON e.id = p.employee_id
			WHERE p.sync_status IN (`+statuses+`) AND p.check_date BETWEEN ?1 AND ?2`+syncPaycheckWhere+`
		UNION ALL
		SELECT 'liability_payment', id, date, 'Tax Payment' || CASE WHEN agency_name <> '' THEN ' - ' || agency_name ELSE '' END,
			amount, books_txn_id, sync_status, sync_error, synced_at
			FROM liability_payments WHERE sync_status IN (`+statuses+`) AND date BETWEEN ?1 AND ?2`+syncPaymentWhere+`
		UNION ALL
		SELECT 'adjustment', a.id, a.date, 'Tax Balance Adjustment - ' || IFNULL(e.display_name, 'Company'),
			(SELECT IFNULL(SUM(amount), 0) FROM liability_adjustment_lines WHERE adjustment_id = a.id),
			a.books_txn_id, a.sync_status, a.sync_error, a.synced_at
			FROM liability_adjustments a LEFT JOIN employees e ON e.id = a.employee_id
			WHERE a.sync_status IN (`+statuses+`) AND a.date BETWEEN ?1 AND ?2`+syncAdjustmentWhere, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	out := []model.SyncItem{}
	for rows.Next() {
		var it model.SyncItem
		var amount int64
		var txn *int64
		if err := rows.Scan(&it.Entity, &it.ID, &it.Date, &it.Label, &amount, &txn, &it.Status, &it.Error, &it.SyncedAt); err != nil {
			return err
		}
		it.Amount, it.BooksTxnID = store.Dollars(amount), txn
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	order := map[string]int{posting.EntityPaycheck: 1, posting.EntityPayment: 2, posting.EntityAdjustment: 3}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Date != out[j].Date {
			return out[i].Date > out[j].Date
		}
		if order[out[i].Entity] != order[out[j].Entity] {
			return order[out[i].Entity] < order[out[j].Entity]
		}
		return out[i].ID > out[j].ID
	})
	return c.JSON(out)
}

// POST /books/sync/retry (RetryRequest; ?force=1 and X-Closing-Password are passed to Books)
func booksRetry(c *httpx.Ctx) error {
	var in model.RetryRequest
	if c.R.ContentLength != 0 {
		if err := c.Decode(&in); err != nil {
			return err
		}
	}
	res, err := posting.Retry(c, in.Items, books.Opts(c))
	if err != nil {
		return err
	}
	return c.JSON(res)
}

// POST /books/verify {from, to}
func booksVerify(c *httpx.Ctx) error {
	var in struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if c.R.ContentLength != 0 {
		if err := c.Decode(&in); err != nil {
			return err
		}
	}
	res, err := posting.Verify(c, in.From, in.To)
	if err != nil {
		return err
	}
	return c.JSON(res)
}
