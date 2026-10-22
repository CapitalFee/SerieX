package lists

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// CSV column headers (export writes them, import matches them case-insensitively).
var (
	accountCSVCols = []string{"Name", "Type", "Number", "Description", "Bank Acct No", "Note", "Active"}
	nameCSVCols    = []string{"Name", "Company", "Salutation", "First", "Last", "Phone", "Mobile", "Fax", "Email",
		"Bill Line1", "Bill Line2", "Bill City", "Bill State", "Bill Zip", "Ship Line1", "Ship City", "Ship State", "Ship Zip",
		"Terms", "Account No", "Notes", "Active"}
	itemCSVCols = []string{"Name", "Type", "Description", "Purchase Description", "Price", "Cost", "Income Account",
		"Expense/COGS Account", "Asset Account", "Taxable", "Preferred Vendor", "Reorder Point", "Active"}
)

var csvEntityKind = map[string]string{"customers": model.NameCustomer, "vendors": model.NameVendor, "other": model.NameOther}

func validEntity(e string) bool { return e == "accounts" || e == "items" || csvEntityKind[e] != "" }

func registerCSVRoutes(rt *httpx.Router) {
	rt.C("GET", "/export/{entity}", func(c *httpx.Ctx) error {
		entity := c.R.PathValue("entity")
		if !validEntity(entity) {
			return apperr.NotFound("Unknown export %q (use accounts, customers, vendors, items or other).", entity)
		}
		rows, err := exportRows(c.Context(), c.DB, entity)
		if err != nil {
			return err
		}
		for i := 1; i < len(rows); i++ {
			for j := range rows[i] {
				rows[i][j] = csvSafe(rows[i][j])
			}
		}
		var buf bytes.Buffer
		w := csv.NewWriter(&buf)
		w.WriteAll(rows)
		if err := w.Error(); err != nil {
			return err
		}
		c.W.Header().Set("Content-Type", "text/csv; charset=utf-8")
		c.W.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s.csv"`, entity))
		c.W.Header().Set("Cache-Control", "no-store")
		c.W.WriteHeader(http.StatusOK)
		_, err = c.W.Write(buf.Bytes())
		return err
	})
	rt.C("POST", "/import/{entity}", func(c *httpx.Ctx) error {
		entity := c.R.PathValue("entity")
		if !validEntity(entity) {
			return apperr.NotFound("Unknown import %q (use accounts, customers, vendors, items or other).", entity)
		}
		c.R.Body = http.MaxBytesReader(c.W, c.R.Body, 32<<20)
		if err := c.R.ParseMultipartForm(8 << 20); err != nil {
			return apperr.BadRequest("Upload a CSV file in the \"file\" field (%v).", err)
		}
		f, _, err := c.R.FormFile("file")
		if err != nil {
			return apperr.BadRequest("Upload a CSV file in the \"file\" field.")
		}
		defer f.Close()
		data, err := io.ReadAll(f)
		if err != nil {
			return apperr.BadRequest("Could not read the uploaded file: %v", err)
		}
		var res ImportResult
		err = c.Write(func(tx *sql.Tx) error {
			if err := store.RequireAdmin(c.Context(), tx, c.User, "Only an administrator can import lists."); err != nil {
				return err
			}
			var err error
			res, err = ImportCSV(c.Context(), tx, entity, data, saveOpts(c))
			return err
		})
		if err != nil {
			return err
		}
		return c.JSON(res)
	})
}

// ---------------------------------------------------------------------------
// Export

// csvSafe keeps a text cell from being run as a formula by spreadsheet
// programs: text starting with = + - @ or a tab / carriage return gets a
// leading apostrophe. Numbers ("-45.00", "+1") are left as they are.
func csvSafe(v string) string {
	if v == "" {
		return v
	}
	switch v[0] {
	case '=', '+', '-', '@', '\t', '\r':
		if _, err := strconv.ParseFloat(strings.ReplaceAll(v, ",", ""), 64); err == nil && v[0] != '=' && v[0] != '@' {
			return v
		}
		return "'" + v
	}
	return v
}

func yesNo(b bool) string {
	if b {
		return "Yes"
	}
	return "No"
}

func fmtNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

func exportRows(ctx context.Context, q store.Q, entity string) ([][]string, error) {
	switch entity {
	case "accounts":
		accts, err := Accounts(ctx, q)
		if err != nil {
			return nil, err
		}
		out := [][]string{accountCSVCols}
		for _, a := range accts {
			out = append(out, []string{a.FullName, a.Type, a.Number, a.Description, a.BankAcctNumber, a.Note, yesNo(a.Active)})
		}
		return out, nil
	case "items":
		items, err := Items(ctx, q)
		if err != nil {
			return nil, err
		}
		acctNames, err := store.FullNames(ctx, q, "accounts")
		if err != nil {
			return nil, err
		}
		nameNames, err := store.FullNames(ctx, q, "names")
		if err != nil {
			return nil, err
		}
		ref := func(m map[int64]string, id *int64) string {
			if id == nil {
				return ""
			}
			return m[*id]
		}
		out := [][]string{itemCSVCols}
		for _, it := range items {
			price := fmtNum(it.SalesPrice)
			vendor := ref(nameNames, it.PreferredVendorID)
			switch {
			case it.Type == model.ItemSalesTax:
				price = fmtNum(it.TaxRate) + "%"
				vendor = ref(nameNames, it.TaxAgencyID)
			case it.Type == model.ItemSalesTaxGroup:
				price = fmtNum(it.TaxRate) + "%"
			case it.RateIsPercent:
				price += "%"
			}
			reorder := ""
			if it.ReorderPoint != nil {
				reorder = fmtNum(*it.ReorderPoint)
			}
			expense := ref(acctNames, it.ExpenseAccountID)
			if !it.IsPurchased && it.Type != model.ItemInventoryPart {
				expense = ""
			}
			out = append(out, []string{it.FullName, it.Type, it.Description, it.PurchaseDescription, price, fmtNum(it.Cost),
				ref(acctNames, it.IncomeAccountID), expense, ref(acctNames, it.AssetAccountID), yesNo(it.Taxable),
				vendor, reorder, yesNo(it.Active)})
		}
		return out, nil
	default:
		names, err := Names(ctx, q, csvEntityKind[entity])
		if err != nil {
			return nil, err
		}
		terms, err := ListEntries(ctx, q, model.ListTerms)
		if err != nil {
			return nil, err
		}
		termName := map[int64]string{}
		for _, t := range terms {
			termName[t.ID] = t.FullName
		}
		out := [][]string{nameCSVCols}
		for _, n := range names {
			t := ""
			if n.TermsID != nil {
				t = termName[*n.TermsID]
			}
			b, s := n.BillAddress, n.ShipAddress
			out = append(out, []string{n.FullName, n.CompanyName, n.Salutation, n.FirstName, n.LastName, n.Phone, n.Mobile, n.Fax, n.Email,
				b.Line1, b.Line2, b.City, b.State, b.Zip, s.Line1, s.City, s.State, s.Zip, t, n.AccountNumber, n.Notes, yesNo(n.Active)})
		}
		return out, nil
	}
}

// ---------------------------------------------------------------------------
// Import

// ImportResult is the response of POST /import/{entity}.
type ImportResult struct {
	Imported int      `json:"imported"`
	Updated  int      `json:"updated"`
	Errors   []string `json:"errors"`
}

// csvRow gives access to one data row by header name.
type csvRow struct {
	idx    map[string]int
	values []string
}

// get returns the trimmed value of a column and whether the file has that column.
func (r csvRow) get(col string) (string, bool) {
	i, ok := r.idx[strings.ToLower(col)]
	if !ok {
		return "", false
	}
	if i >= len(r.values) {
		return "", true
	}
	return strings.TrimSpace(r.values[i]), true
}

// field returns a column value to apply: on an update (existing=true) a
// blank cell keeps the current value, so only non-blank cells are applied.
func (r csvRow) field(col string, existing bool) (string, bool) {
	v, ok := r.get(col)
	if ok && v == "" && existing {
		return "", false
	}
	return v, ok
}

func parseBool(s string, blank bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "":
		return blank, nil
	case "yes", "y", "true", "1", "x", "active", "tax", "taxable", "t":
		return true, nil
	case "no", "n", "false", "0", "inactive", "non", "f":
		return false, nil
	}
	return false, fmt.Errorf("%q is not Yes or No", s)
}

// parseAmount reads "1,234.50", "$12", "(5.00)" or "10%" (pct reports the %).
func parseAmount(s string) (v float64, pct bool, err error) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, false, nil
	}
	neg := false
	if strings.HasPrefix(t, "(") && strings.HasSuffix(t, ")") {
		neg = true
		t = t[1 : len(t)-1]
	}
	if strings.HasSuffix(t, "%") {
		pct = true
		t = strings.TrimSuffix(t, "%")
	}
	t = strings.NewReplacer("$", "", ",", "", " ", "").Replace(t)
	v, err = strconv.ParseFloat(t, 64)
	if err != nil {
		return 0, false, fmt.Errorf("%q is not a number", s)
	}
	if neg {
		v = -v
	}
	return v, pct, nil
}

func splitPath(full string) ([]string, error) {
	parts := strings.Split(full, ":")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
		if parts[i] == "" {
			return nil, fmt.Errorf("the name %q has an empty part", full)
		}
	}
	return parts, nil
}

var accountTypeAliases = map[string]string{
	"bank": model.AcctBank, "ar": model.AcctAR, "accounts receivable": model.AcctAR, "ocasset": model.AcctOCA,
	"other current asset": model.AcctOCA, "fixasset": model.AcctFixedAsset, "fixed asset": model.AcctFixedAsset,
	"oasset": model.AcctOtherAsset, "other asset": model.AcctOtherAsset, "ap": model.AcctAP, "accounts payable": model.AcctAP,
	"ccard": model.AcctCreditCard, "credit card": model.AcctCreditCard, "ocliab": model.AcctOCL, "other current liability": model.AcctOCL,
	"ltliab": model.AcctLTL, "long term liability": model.AcctLTL, "equity": model.AcctEquity, "inc": model.AcctIncome,
	"income": model.AcctIncome, "cogs": model.AcctCOGS, "cost of goods sold": model.AcctCOGS, "exp": model.AcctExpense,
	"expense": model.AcctExpense, "exinc": model.AcctOtherIncome, "other income": model.AcctOtherIncome,
	"exexp": model.AcctOtherExpense, "other expense": model.AcctOtherExpense, "nonposting": model.AcctNonPosting,
	"non-posting": model.AcctNonPosting,
}

var itemTypeAliases = map[string]string{
	"service": model.ItemService, "serv": model.ItemService, "inventory part": model.ItemInventoryPart, "inventory": model.ItemInventoryPart,
	"invtpart": model.ItemInventoryPart, "non-inventory part": model.ItemNonInventory, "non-inventory": model.ItemNonInventory,
	"noninventory part": model.ItemNonInventory, "part": model.ItemNonInventory, "other charge": model.ItemOtherCharge,
	"othc": model.ItemOtherCharge, "subtotal": model.ItemSubtotal, "subt": model.ItemSubtotal, "group": model.ItemGroup,
	"discount": model.ItemDiscount, "disc": model.ItemDiscount, "payment": model.ItemPayment, "pmt": model.ItemPayment,
	"sales tax item": model.ItemSalesTax, "sales tax": model.ItemSalesTax, "comptax": model.ItemSalesTax,
	"sales tax group": model.ItemSalesTaxGroup,
}

// ImportCSV imports one CSV file (header row + data rows) of accounts,
// customers, vendors, other names or items inside tx. Each row is applied in
// its own savepoint: a bad row is reported ("Row 7: ...") and skipped.
// Missing parents of "A:B" names are created; existing records (same full
// name) are updated with the columns present in the file.
func ImportCSV(ctx context.Context, tx *sql.Tx, entity string, data []byte, opt ledger.SaveOptions) (ImportResult, error) {
	res := ImportResult{Errors: []string{}}
	// Excel files: UTF-16 ("Unicode Text") or Windows-1252 ("CSV (Comma delimited)")
	data = store.DecodeText(data)
	r := csv.NewReader(bytes.NewReader(data))
	// comma, or tab ("Unicode Text" / "Text (Tab delimited)") or semicolon
	r.Comma = store.CSVDelimiter(data)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var idx map[string]int
	im, err := newImporter(ctx, tx, entity, opt)
	if err != nil {
		return res, err
	}
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			var pe *csv.ParseError
			if errors.As(err, &pe) {
				res.Errors = append(res.Errors, fmt.Sprintf("Row %d: %v", pe.Line, pe.Err))
				continue
			}
			return res, apperr.BadRequest("Could not read the CSV file: %v", err)
		}
		line, _ := r.FieldPos(0)
		blank := true
		for _, v := range rec {
			if strings.TrimSpace(v) != "" {
				blank = false
				break
			}
		}
		if blank {
			continue
		}
		if idx == nil {
			idx = map[string]int{}
			for i, h := range rec {
				idx[strings.ToLower(strings.TrimSpace(h))] = i
			}
			if _, ok := idx["name"]; !ok {
				return res, apperr.BadRequest("The first row of the file must be a header row with a \"Name\" column.")
			}
			continue
		}
		row := csvRow{idx: idx, values: rec}
		if _, err := tx.ExecContext(ctx, `SAVEPOINT import_row`); err != nil {
			return res, err
		}
		created, err := im.row(row)
		if err != nil {
			if _, rbErr := tx.ExecContext(ctx, `ROLLBACK TO import_row`); rbErr != nil {
				return res, rbErr
			}
			im.reload()
			msg := err.Error()
			if e := apperr.As(err); e != nil {
				msg = e.Message
			}
			res.Errors = append(res.Errors, fmt.Sprintf("Row %d: %s", line, msg))
		} else if created {
			res.Imported++
		} else {
			res.Updated++
		}
		if _, err := tx.ExecContext(ctx, `RELEASE import_row`); err != nil {
			return res, err
		}
	}
	if idx == nil {
		return res, apperr.BadRequest("The file is empty.")
	}
	return res, nil
}

// importer keeps lookup maps (full name -> id) while rows are imported.
type importer struct {
	ctx    context.Context
	tx     *sql.Tx
	entity string
	opt    ledger.SaveOptions
	ids    map[string]int64 // lower-case full name -> id of the entity's table
	kinds  map[int64]string // names: id -> kind
	err    error
}

func newImporter(ctx context.Context, tx *sql.Tx, entity string, opt ledger.SaveOptions) (*importer, error) {
	im := &importer{ctx: ctx, tx: tx, entity: entity, opt: opt}
	im.reload()
	return im, im.err
}

func (im *importer) table() string {
	switch im.entity {
	case "accounts":
		return "accounts"
	case "items":
		return "items"
	}
	return "names"
}

// reload rebuilds the lookup maps (after a row was rolled back).
func (im *importer) reload() {
	full, err := store.FullNames(im.ctx, im.tx, im.table())
	if err != nil {
		im.err = err
		return
	}
	im.ids = map[string]int64{}
	for id, f := range full {
		im.ids[strings.ToLower(f)] = id
	}
	if im.table() == "names" {
		kinds, err := kindMap(im.ctx, im.tx)
		if err != nil {
			im.err = err
			return
		}
		im.kinds = kinds
	}
}

func kindMap(ctx context.Context, q store.Q) (map[int64]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, kind FROM names`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var k string
		if err := rows.Scan(&id, &k); err != nil {
			return nil, err
		}
		out[id] = k
	}
	return out, rows.Err()
}

func (im *importer) row(r csvRow) (bool, error) {
	if im.err != nil {
		return false, im.err
	}
	full, _ := r.get("name")
	if full == "" {
		return false, errors.New("the Name column is empty")
	}
	parts, err := splitPath(full)
	if err != nil {
		return false, err
	}
	switch im.entity {
	case "accounts":
		return im.account(r, parts)
	case "items":
		return im.item(r, parts)
	}
	return im.name(r, parts)
}

// parentChain returns the id of the parent of the last path part, creating
// missing parents with create(name, parentID).
func (im *importer) parentChain(parts []string, create func(name string, parent *int64) (int64, error)) (*int64, error) {
	var parent *int64
	for i := 0; i < len(parts)-1; i++ {
		key := strings.ToLower(strings.Join(parts[:i+1], ":"))
		id, ok := im.ids[key]
		if !ok {
			var err error
			id, err = create(parts[i], parent)
			if err != nil {
				return nil, fmt.Errorf("creating parent %q: %w", strings.Join(parts[:i+1], ":"), err)
			}
			im.ids[key] = id
		}
		p := id
		parent = &p
	}
	return parent, nil
}

func (im *importer) accountByRef(ref string) (*int64, error) {
	if ref == "" {
		return nil, nil
	}
	if id, ok := im.lookupAccount(ref); ok {
		return &id, nil
	}
	return nil, fmt.Errorf("account %q not found", ref)
}

func (im *importer) lookupAccount(ref string) (int64, bool) {
	full, err := store.FullNames(im.ctx, im.tx, "accounts")
	if err != nil {
		return 0, false
	}
	l := strings.ToLower(strings.TrimSpace(ref))
	for id, f := range full {
		if strings.ToLower(f) == l {
			return id, true
		}
	}
	// "number · name" or plain number
	num := strings.TrimSpace(strings.SplitN(ref, "·", 2)[0])
	var id int64
	if err := im.tx.QueryRowContext(im.ctx, `SELECT id FROM accounts WHERE number = ? AND number <> ''`, num).Scan(&id); err == nil {
		return id, true
	}
	return 0, false
}

func (im *importer) account(r csvRow, parts []string) (bool, error) {
	typ := ""
	if t, ok := r.get("type"); ok && t != "" {
		typ = accountTypeAliases[strings.ToLower(t)]
		if typ == "" {
			return false, fmt.Errorf("%q is not a valid account type", t)
		}
	}
	var a model.Account
	id, found := im.ids[strings.ToLower(strings.Join(parts, ":"))]
	if found {
		cur, err := GetAccount(im.ctx, im.tx, id)
		if err != nil {
			return false, err
		}
		a = *cur
		if typ != "" {
			a.Type = typ
		}
	} else {
		if typ == "" {
			return false, errors.New("the Type column is required for a new account")
		}
		parent, err := im.parentChain(parts, func(name string, parent *int64) (int64, error) {
			return SaveAccount(im.ctx, im.tx, &model.Account{Name: name, Type: typ, ParentID: parent, Active: true}, im.opt)
		})
		if err != nil {
			return false, err
		}
		a = model.Account{Name: parts[len(parts)-1], Type: typ, ParentID: parent, Active: true}
	}
	if v, ok := r.field("number", found); ok {
		a.Number = v
	}
	if v, ok := r.field("description", found); ok {
		a.Description = v
	}
	if v, ok := r.field("bank acct no", found); ok {
		a.BankAcctNumber = v
	}
	if v, ok := r.field("note", found); ok {
		a.Note = v
	}
	if v, ok := r.field("active", found); ok {
		b, err := parseBool(v, true)
		if err != nil {
			return false, fmt.Errorf("Active: %v", err)
		}
		a.Active = b
	}
	a.OpeningBalance = nil
	newID, err := SaveAccount(im.ctx, im.tx, &a, im.opt)
	if err != nil {
		return false, err
	}
	im.ids[strings.ToLower(strings.Join(parts, ":"))] = newID
	return !found, nil
}

func (im *importer) termsByName(name string) (*int64, error) {
	if name == "" {
		return nil, nil
	}
	var id int64
	err := im.tx.QueryRowContext(im.ctx, `SELECT id FROM list_entries WHERE list = ? AND name = ?`, model.ListTerms, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("terms %q not found in the Terms List", name)
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (im *importer) name(r csvRow, parts []string) (bool, error) {
	kind := csvEntityKind[im.entity]
	if kind != model.NameCustomer && len(parts) > 1 {
		return false, errors.New("only customers can have jobs, so the name cannot contain a colon (:)")
	}
	key := strings.ToLower(strings.Join(parts, ":"))
	var n model.Name
	id, found := im.ids[key]
	if found {
		if k := im.kinds[id]; k != kind {
			return false, fmt.Errorf("the name \"%s\" is already in use by a %s", strings.Join(parts, ":"), kindLabel(k))
		}
		cur, err := GetName(im.ctx, im.tx, id)
		if err != nil {
			return false, err
		}
		n = *cur
	} else {
		parent, err := im.parentChain(parts, func(name string, parent *int64) (int64, error) {
			id, err := SaveName(im.ctx, im.tx, &model.Name{Kind: model.NameCustomer, Name: name, ParentID: parent, Taxable: true, Active: true}, im.opt)
			if err == nil {
				im.kinds[id] = model.NameCustomer
			}
			return id, err
		})
		if err != nil {
			return false, err
		}
		n = model.Name{Kind: kind, Name: parts[len(parts)-1], ParentID: parent, Taxable: kind == model.NameCustomer, Active: true}
	}
	set := func(col string, dst *string) {
		if v, ok := r.field(col, found); ok {
			*dst = v
		}
	}
	set("company", &n.CompanyName)
	set("salutation", &n.Salutation)
	set("first", &n.FirstName)
	set("last", &n.LastName)
	set("phone", &n.Phone)
	set("mobile", &n.Mobile)
	set("fax", &n.Fax)
	set("email", &n.Email)
	set("bill line1", &n.BillAddress.Line1)
	set("bill line2", &n.BillAddress.Line2)
	set("bill city", &n.BillAddress.City)
	set("bill state", &n.BillAddress.State)
	set("bill zip", &n.BillAddress.Zip)
	set("ship line1", &n.ShipAddress.Line1)
	set("ship city", &n.ShipAddress.City)
	set("ship state", &n.ShipAddress.State)
	set("ship zip", &n.ShipAddress.Zip)
	set("account no", &n.AccountNumber)
	set("notes", &n.Notes)
	if v, ok := r.field("terms", found); ok {
		t, err := im.termsByName(v)
		if err != nil {
			return false, err
		}
		n.TermsID = t
	}
	if v, ok := r.field("active", found); ok {
		b, err := parseBool(v, true)
		if err != nil {
			return false, fmt.Errorf("Active: %v", err)
		}
		n.Active = b
	}
	n.OpeningBalance = nil
	newID, err := SaveName(im.ctx, im.tx, &n, im.opt)
	if err != nil {
		return false, err
	}
	im.ids[key] = newID
	im.kinds[newID] = kind
	return !found, nil
}

func kindLabel(k string) string {
	switch k {
	case model.NameCustomer:
		return "customer"
	case model.NameVendor:
		return "vendor"
	}
	return "other name"
}

func (im *importer) vendorByName(name string) (*int64, error) {
	if name == "" {
		return nil, nil
	}
	var id int64
	err := im.tx.QueryRowContext(im.ctx, `SELECT id FROM names WHERE kind = ? AND parent_id IS NULL AND name = ?`, model.NameVendor, name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("vendor %q not found", name)
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func (im *importer) item(r csvRow, parts []string) (bool, error) {
	typ := ""
	if t, ok := r.get("type"); ok && t != "" {
		typ = itemTypeAliases[strings.ToLower(t)]
		if typ == "" {
			return false, fmt.Errorf("%q is not a valid item type", t)
		}
	}
	key := strings.ToLower(strings.Join(parts, ":"))
	var it model.Item
	id, found := im.ids[key]
	if found {
		cur, err := GetItem(im.ctx, im.tx, id)
		if err != nil {
			return false, err
		}
		it = *cur
		if typ != "" {
			it.Type = typ
		}
	} else {
		if typ == "" {
			return false, errors.New("the Type column is required for a new item")
		}
		if typ == model.ItemGroup || typ == model.ItemSalesTaxGroup {
			return false, errors.New("group items cannot be imported; create them in the Item List")
		}
		it = model.Item{Name: parts[len(parts)-1], Type: typ, Active: true}
	}
	if !found || typ != "" {
		prefs, err := store.LoadPrefs(im.ctx, im.tx)
		if err != nil {
			return false, err
		}
		switch it.Type {
		case model.ItemInventoryPart:
			if !prefs.InventoryEnabled {
				return false, errors.New("inventory is turned off: turn on inventory in Preferences (Items & Inventory) to import inventory parts")
			}
		case model.ItemSalesTax, model.ItemSalesTaxGroup:
			if !prefs.SalesTaxEnabled {
				return false, errors.New("sales tax is turned off: turn on sales tax in Preferences (Sales Tax) to import sales tax items")
			}
		}
	}
	set := func(col string, dst *string) {
		if v, ok := r.field(col, found); ok {
			*dst = v
		}
	}
	set("description", &it.Description)
	set("purchase description", &it.PurchaseDescription)
	if v, ok := r.field("price", found); ok {
		f, pct, err := parseAmount(v)
		if err != nil {
			return false, fmt.Errorf("Price: %v", err)
		}
		switch it.Type {
		case model.ItemSalesTax:
			it.TaxRate = f
		case model.ItemSalesTaxGroup:
		default:
			it.SalesPrice = f
			it.RateIsPercent = pct && (it.Type == model.ItemDiscount || it.Type == model.ItemOtherCharge)
		}
	}
	if v, ok := r.field("cost", found); ok {
		f, _, err := parseAmount(v)
		if err != nil {
			return false, fmt.Errorf("Cost: %v", err)
		}
		it.Cost = f
	}
	expenseGiven := false
	for _, f := range []struct {
		col string
		dst **int64
	}{{"income account", &it.IncomeAccountID}, {"expense/cogs account", &it.ExpenseAccountID}, {"asset account", &it.AssetAccountID}} {
		if v, ok := r.field(f.col, found); ok {
			id, err := im.accountByRef(v)
			if err != nil {
				return false, err
			}
			*f.dst = id
			if f.col == "expense/cogs account" && v != "" {
				expenseGiven = true
			}
		}
	}
	if v, ok := r.field("taxable", found); ok {
		b, err := parseBool(v, false)
		if err != nil {
			return false, fmt.Errorf("Taxable: %v", err)
		}
		it.Taxable = b
	}
	if v, ok := r.field("preferred vendor", found); ok {
		vid, err := im.vendorByName(v)
		if err != nil {
			return false, err
		}
		if it.Type == model.ItemSalesTax {
			it.TaxAgencyID = vid
		} else {
			it.PreferredVendorID = vid
		}
	}
	if v, ok := r.field("reorder point", found); ok {
		if v == "" {
			it.ReorderPoint = nil
		} else {
			f, _, err := parseAmount(v)
			if err != nil {
				return false, fmt.Errorf("Reorder Point: %v", err)
			}
			it.ReorderPoint = &f
		}
	}
	if v, ok := r.field("active", found); ok {
		b, err := parseBool(v, true)
		if err != nil {
			return false, fmt.Errorf("Active: %v", err)
		}
		it.Active = b
	}
	switch it.Type {
	case model.ItemService, model.ItemNonInventory, model.ItemOtherCharge:
		// The item has purchase information when the file gives an expense
		// account different from the sales account, a cost or a purchase
		// description. Without an expense column an existing item keeps its setting.
		_, hasExpenseCol := r.field("expense/cogs account", found)
		differs := expenseGiven && (it.IncomeAccountID == nil || *it.ExpenseAccountID != *it.IncomeAccountID)
		switch {
		case differs || it.Cost != 0 || it.PurchaseDescription != "":
			it.IsPurchased = true
		case hasExpenseCol || !found:
			it.IsPurchased = false
		}
		if it.IsPurchased && it.ExpenseAccountID == nil {
			it.ExpenseAccountID = it.IncomeAccountID
		}
	}
	if !found {
		tmpl := it
		parent, err := im.parentChain(parts, func(name string, parent *int64) (int64, error) {
			p := tmpl
			p.ID, p.Name, p.ParentID, p.Description, p.PurchaseDescription, p.Active = 0, name, parent, "", "", true
			p.SalesPrice, p.Cost, p.ReorderPoint, p.PreferredVendorID, p.MPN = 0, 0, nil, nil, ""
			p.IsPurchased = p.Type == model.ItemInventoryPart || (p.IsPurchased && p.ExpenseAccountID != nil && (p.IncomeAccountID == nil || *p.ExpenseAccountID != *p.IncomeAccountID))
			p.OpeningQty, p.OpeningValue = nil, nil
			return SaveItem(im.ctx, im.tx, &p, im.opt)
		})
		if err != nil {
			return false, err
		}
		it.ParentID = parent
	}
	it.OpeningQty, it.OpeningValue = nil, nil
	newID, err := SaveItem(im.ctx, im.tx, &it, im.opt)
	if err != nil {
		return false, err
	}
	im.ids[key] = newID
	return !found, nil
}
