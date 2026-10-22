package qbimport

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/banking"
	"seriex/internal/ledger"
	"seriex/internal/lists"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Inputs are the uploaded files and the wizard's choices.
type Inputs struct {
	IIF      []byte
	IIFName  string
	TB       []byte // opening mode: trial balance CSV
	Invoices []byte // opening mode: open invoices CSV
	Bills    []byte // opening mode: unpaid bills CSV
	Opt      Options
}

// parsed is what the files contain.
type parsed struct {
	file     *iifFile
	src      *source
	txns     []*srcTxn
	tb       *trialBalance
	invoices []openDoc
	bills    []openDoc
	problems []Problem
}

func parseInputs(in *Inputs) (*parsed, error) {
	if len(in.IIF) == 0 {
		return nil, apperr.Validation("iif", "Choose the IIF file exported from QuickBooks® Desktop.")
	}
	ps := &parsed{}
	ps.file = parseIIF(in.IIF)
	for _, pr := range ps.file.Problems {
		pr.File = "iif"
		if pr.Level == "" {
			pr.Level = levelError
		}
		if strings.Contains(pr.Message, "ENDTRNS") && strings.Contains(pr.Message, "no ENDTRNS") {
			pr.Level = levelNote
		}
		ps.problems = append(ps.problems, pr)
	}
	if len(ps.file.Rows) == 0 && len(ps.file.Blocks) == 0 {
		return nil, apperr.Validation("iif", "This file has no lists or transactions in the IIF format. Choose an IIF file exported from QuickBooks® Desktop (File > Utilities > Export > Lists to IIF Files).")
	}
	ps.src = readSource(ps.file)
	ps.problems = append(ps.problems, ps.src.problems...)
	var tp []Problem
	ps.txns, tp = readTxns(ps.file)
	ps.problems = append(ps.problems, tp...)
	if in.Opt.Mode == "opening" {
		if len(in.TB) == 0 {
			return nil, apperr.Validation("tb", "Choose the trial balance file (the Trial Balance report of QuickBooks® Desktop as of the conversion date, saved as CSV).")
		}
		var probs []Problem
		ps.tb, probs = parseTrialBalance(in.TB)
		ps.problems = append(ps.problems, probs...)
		if strings.TrimSpace(in.Opt.ConversionDate) == "" && ps.tb != nil {
			in.Opt.ConversionDate = ps.tb.AsOf // the date printed on the trial balance
		}
		if !store.ValidDate(in.Opt.ConversionDate) {
			return nil, apperr.Validation("conversionDate", "Enter the conversion date: the date of the trial balance and of the open invoices and bills.")
		}
		if ps.tb != nil && ps.tb.AsOf != "" && ps.tb.AsOf != in.Opt.ConversionDate {
			ps.problems = append(ps.problems, Problem{File: "tb", Level: levelNote,
				Message: fmt.Sprintf("The trial balance is dated %s, but the conversion date is %s. Check that both are the same date.", fmtDate(ps.tb.AsOf), fmtDate(in.Opt.ConversionDate))})
		}
		if len(in.Invoices) > 0 {
			ps.invoices, probs = parseOpenDocs(in.Invoices, "invoices")
			ps.problems = append(ps.problems, probs...)
		}
		if len(in.Bills) > 0 {
			ps.bills, probs = parseOpenDocs(in.Bills, "bills")
			ps.problems = append(ps.problems, probs...)
		}
		// transactions up to the conversion date are summed up by the opening balances
		var after []*srcTxn
		before := 0
		for _, t := range ps.txns {
			if t.Date > in.Opt.ConversionDate {
				after = append(after, t)
			} else {
				before++
			}
		}
		if before > 0 {
			ps.problems = append(ps.problems, Problem{File: "iif", Level: levelNote,
				Message: fmt.Sprintf("%d transactions dated on or before the conversion date (%s) are not entered: the opening balances already include them.", before, fmtDate(in.Opt.ConversionDate))})
		}
		ps.txns = after
	}
	return ps, nil
}

// importer runs one import inside a database transaction.
type importer struct {
	ctx context.Context
	tx  *sql.Tx
	opt ledger.SaveOptions
	in  *Inputs
	ps  *parsed
	p   *plan
	rep *Report
	sp  int // savepoint counter

	lists     map[string]map[string]int64 // list -> normFull -> id
	reps      map[string]int64            // lower initials or name -> sales rep id
	accts     map[int64]*acctData
	items     map[int64]*itemData
	nameKind  map[int64]string
	taxAgency int64 // vendor created for sales tax items without an agency

	counts    map[string]*CountRow
	txCounts  map[string]*TxnCount
	srcTB     map[int64]int64 // account id -> source balance (cents, debit positive)
	srcTBOk   bool
	cleared   int
	applied   int
	linked    int
	ufWaiting map[int64][]waiting // payments waiting in Undeposited Funds, by amount (cents)
}

type acctData struct {
	id      int64
	typ     string
	special string
	name    string
}

type itemData struct {
	id                              int64
	typ                             string
	income, expense, asset, deposit int64
	name                            string
}

func (im *importer) problem(file string, line int, level, format string, args ...any) {
	im.rep.Problems = append(im.rep.Problems, Problem{File: file, Line: line, Level: level, Message: fmt.Sprintf(format, args...)})
}

// try runs fn inside a savepoint: on error its changes are undone and the
// error is returned for the report. Errors that are not user errors (the
// database failing) are returned as fatal.
func (im *importer) try(fn func() error) (userErr error, fatal error) {
	im.sp++
	name := "qbi" + strconv.Itoa(im.sp)
	if _, err := im.tx.ExecContext(im.ctx, "SAVEPOINT "+name); err != nil {
		return nil, err
	}
	err := fn()
	if err == nil {
		_, ferr := im.tx.ExecContext(im.ctx, "RELEASE "+name)
		return nil, ferr
	}
	if _, rerr := im.tx.ExecContext(im.ctx, "ROLLBACK TO "+name); rerr != nil {
		return nil, rerr
	}
	if _, rerr := im.tx.ExecContext(im.ctx, "RELEASE "+name); rerr != nil {
		return nil, rerr
	}
	if apperr.As(err) != nil || errors.Is(err, errSkip) {
		return err, nil
	}
	if strings.Contains(err.Error(), "constraint failed") {
		return err, nil
	}
	return nil, err
}

var errSkip = errors.New("skipped")

func (im *importer) count(what string) *CountRow {
	c := im.counts[what]
	if c == nil {
		c = &CountRow{What: what}
		im.counts[what] = c
	}
	return c
}

// errText is the message of a user error.
func errText(err error) string {
	if e := apperr.As(err); e != nil {
		return e.Message
	}
	return err.Error()
}

// ---------------------------------------------------------------------------
// Lookups of records created or matched during the import

func (im *importer) acct(id int64) *acctData {
	if id == 0 {
		return nil
	}
	if a, ok := im.accts[id]; ok {
		return a
	}
	a := &acctData{id: id}
	if err := im.tx.QueryRowContext(im.ctx, `SELECT type, special, name FROM accounts WHERE id = ?`, id).Scan(&a.typ, &a.special, &a.name); err != nil {
		return nil
	}
	a.name = store.FullName(im.ctx, im.tx, "accounts", id)
	im.accts[id] = a
	return a
}

func (im *importer) item(id int64) *itemData {
	if id == 0 {
		return nil
	}
	if it, ok := im.items[id]; ok {
		return it
	}
	it := &itemData{id: id}
	var inc, exp, asset, dep sql.NullInt64
	if err := im.tx.QueryRowContext(im.ctx, `SELECT type, income_account_id, expense_account_id, asset_account_id, deposit_account_id
		FROM items WHERE id = ?`, id).Scan(&it.typ, &inc, &exp, &asset, &dep); err != nil {
		return nil
	}
	it.income, it.expense, it.asset, it.deposit = inc.Int64, exp.Int64, asset.Int64, dep.Int64
	it.name = store.FullName(im.ctx, im.tx, "items", id)
	im.items[id] = it
	return it
}

func (im *importer) kindOf(nameID int64) string {
	if k, ok := im.nameKind[nameID]; ok {
		return k
	}
	var k string
	im.tx.QueryRowContext(im.ctx, `SELECT kind FROM names WHERE id = ?`, nameID).Scan(&k)
	im.nameKind[nameID] = k
	return k
}

func (im *importer) special(code string) (int64, error) {
	return store.SpecialAccount(im.ctx, im.tx, code)
}

// accountID returns the account a full name of the files resolves to (0 and
// a reason when it could not be created).
func (im *importer) accountID(full string) (int64, string) {
	if strings.TrimSpace(full) == "" {
		return 0, "no account is given"
	}
	a := im.p.finalAcct(im.p.accts[normFull(full)])
	if a == nil {
		return 0, fmt.Sprintf("the account %s is unknown", full)
	}
	if a.id == 0 {
		if a.row.Blocking {
			return 0, fmt.Sprintf("the account %s needs a choice in the mapping review (%s)", a.row.Source, a.row.Review)
		}
		return 0, fmt.Sprintf("the account %s could not be created", a.row.Source)
	}
	return a.id, ""
}

func (im *importer) nameID(full string) (int64, string) {
	if strings.TrimSpace(full) == "" {
		return 0, ""
	}
	n := im.p.finalName(im.p.names[normFull(full)])
	if n == nil {
		return 0, fmt.Sprintf("the name %s is unknown", full)
	}
	if n.id == 0 {
		if n.row.Blocking {
			return 0, fmt.Sprintf("the name %s needs a choice in the mapping review", n.row.Source)
		}
		return 0, fmt.Sprintf("the name %s could not be created", n.row.Source)
	}
	return n.id, ""
}

// itemID returns the item of a full name; none is true when its lines post
// without an item (groups, or the user's choice).
func (im *importer) itemID(full string) (id int64, none bool, why string) {
	if strings.TrimSpace(full) == "" {
		return 0, true, ""
	}
	it := im.p.finalItem(im.p.items[normFull(full)])
	if it == nil {
		return 0, true, ""
	}
	if it.row.Action == "none" {
		return 0, true, ""
	}
	if it.id == 0 {
		if it.row.Blocking {
			return 0, false, fmt.Sprintf("the item %s needs a choice in the mapping review", it.row.Source)
		}
		return 0, false, fmt.Sprintf("the item %s could not be created", it.row.Source)
	}
	return it.id, false, ""
}

func ptr(id int64) *int64 {
	if id == 0 {
		return nil
	}
	v := id
	return &v
}

// listID returns the entry of a simple list with this name, creating it
// when the files use one that is not listed.
func (im *importer) listID(list, full string, line int) int64 {
	full = strings.TrimSpace(full)
	if full == "" {
		return 0
	}
	hier := list == model.ListClass || list == model.ListCustomerType || list == model.ListVendorType || list == model.ListJobType
	if !hier {
		full = strings.ReplaceAll(full, ":", " -")
	}
	if id := im.lists[list][normFull(full)]; id != 0 {
		return id
	}
	if list == model.ListSalesRep {
		if id := im.reps[strings.ToLower(full)]; id != 0 {
			return id
		}
	}
	var parent int64
	name := full
	if hier {
		parts := splitFull(full)
		if len(parts) > 1 {
			parent = im.listID(list, strings.Join(parts[:len(parts)-1], ":"), line)
			if parent == 0 {
				return 0
			}
		}
		name = parts[len(parts)-1]
	}
	data := map[string]any{}
	switch list {
	case model.ListTerms:
		data = termsFromName(name)
	case model.ListPaymentMethod:
		data["type"] = paymentTypeOf(name)
	case model.ListSalesRep:
		data["initials"] = name
	}
	if list != model.ListCustomerMessage && len([]rune(name)) > 31 {
		name = string([]rune(name)[:31])
	}
	e := model.ListEntry{List: list, Name: name, ParentID: ptr(parent), Active: true, Data: data}
	var id int64
	uerr, ferr := im.try(func() error {
		var err error
		id, err = lists.SaveListEntry(im.ctx, im.tx, &e)
		return err
	})
	if ferr != nil || uerr != nil {
		msg := "the database failed"
		if uerr != nil {
			msg = errText(uerr)
		}
		im.problem("iif", line, levelNote, "The %s %q used here could not be created (%s); it is left blank.", listWord[list], full, msg)
		if im.lists[list] == nil {
			im.lists[list] = map[string]int64{}
		}
		im.lists[list][normFull(full)] = -1
		return 0
	}
	if im.lists[list] == nil {
		im.lists[list] = map[string]int64{}
	}
	im.lists[list][normFull(full)] = id
	if list == model.ListSalesRep {
		im.reps[strings.ToLower(full)] = id
	}
	im.count(listLabel[list]).Created++
	return id
}

func (im *importer) listRef(list, full string, line int) *int64 {
	id := im.listID(list, full, line)
	if id <= 0 {
		return nil
	}
	return &id
}

var listWord = map[string]string{model.ListClass: "class", model.ListTerms: "terms", model.ListPaymentMethod: "payment method",
	model.ListShipVia: "shipping method", model.ListCustomerType: "customer type", model.ListVendorType: "vendor type",
	model.ListJobType: "job type", model.ListCustomerMessage: "customer message", model.ListSalesRep: "sales rep"}

var listLabel = map[string]string{model.ListClass: "Classes", model.ListTerms: "Terms", model.ListPaymentMethod: "Payment methods",
	model.ListShipVia: "Shipping methods", model.ListCustomerType: "Customer types", model.ListVendorType: "Vendor types",
	model.ListJobType: "Job types", model.ListCustomerMessage: "Customer messages", model.ListSalesRep: "Sales reps"}

// ---------------------------------------------------------------------------
// Lists

func (im *importer) importSimpleLists(reps bool) error {
	for _, e := range im.ps.src.lists {
		if (e.List == model.ListSalesRep) != reps {
			continue
		}
		hier := e.List == model.ListClass || e.List == model.ListCustomerType || e.List == model.ListVendorType || e.List == model.ListJobType
		key := normFull(e.Full)
		if !hier {
			key = normFull(strings.ReplaceAll(e.Full, ":", " -"))
		}
		c := im.count(listLabel[e.List])
		if e.List == model.ListSalesRep {
			ini, _ := e.Data["initials"].(string)
			if id := im.reps[strings.ToLower(ini)]; id != 0 && ini != "" {
				c.Matched++
				continue
			}
		}
		if id := im.lists[e.List][key]; id > 0 {
			c.Matched++
			if e.List == model.ListSalesRep {
				if ini, _ := e.Data["initials"].(string); ini != "" {
					im.reps[strings.ToLower(ini)] = id
				}
			}
			continue
		}
		var parent int64
		name := e.Full
		if hier {
			parts := splitFull(e.Full)
			if len(parts) > 1 {
				if parent = im.listID(e.List, strings.Join(parts[:len(parts)-1], ":"), e.Line); parent == 0 {
					im.problem("iif", e.Line, levelError, "The %s %s was not imported because its parent could not be created.", listWord[e.List], e.Full)
					c.Skipped++
					continue
				}
			}
			name = parts[len(parts)-1]
		}
		data := e.Data
		if e.List == model.ListSalesRep && e.Rep != "" {
			if id, _ := im.nameID(e.Rep); id != 0 {
				data["nameId"] = id
			}
		}
		if e.List != model.ListCustomerMessage && len([]rune(name)) > 31 {
			im.problem("iif", e.Line, levelNote, "The %s name %q is longer than 31 characters and was shortened.", listWord[e.List], name)
			name = string([]rune(name)[:31])
		}
		le := model.ListEntry{List: e.List, Name: name, ParentID: ptr(parent), Active: !e.Hidden, Data: data}
		var id int64
		uerr, ferr := im.try(func() error {
			var err error
			id, err = lists.SaveListEntry(im.ctx, im.tx, &le)
			return err
		})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			im.problem("iif", e.Line, levelError, "The %s %s was not imported: %s", listWord[e.List], e.Full, errText(uerr))
			c.Skipped++
			continue
		}
		c.Created++
		if im.lists[e.List] == nil {
			im.lists[e.List] = map[string]int64{}
		}
		im.lists[e.List][key] = id
		if e.List == model.ListSalesRep {
			im.reps[strings.ToLower(name)] = id
			if ini, _ := e.Data["initials"].(string); ini != "" {
				im.reps[strings.ToLower(ini)] = id
			}
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Accounts

func (im *importer) importAccounts() error {
	p := im.p
	c := im.count("Accounts")
	for _, k := range sortedKeys(p.accts, func(a *pAcct) int { return a.depth }) {
		a := p.accts[k]
		r := a.row
		switch r.Action {
		case "use":
			continue
		case "existing", "map":
			a.id = r.TargetID
			if a.src != nil {
				c.Matched++
			}
			if a.renumber != "" {
				if err := im.renumber(a); err != nil {
					return err
				}
			}
			continue
		}
		if r.Blocking {
			a.failed = true
			if a.src != nil {
				c.Skipped++
			}
			continue
		}
		var parent int64
		if a.parentKey != "" {
			pa := p.finalAcct(p.accts[a.parentKey])
			if pa == nil || pa.id == 0 {
				a.failed = true
				im.problem("iif", r.Line, levelError, "The account %s was not created because its parent account %s could not be created.", r.Source, p.accts[a.parentKey].row.Source)
				c.Skipped++
				continue
			}
			parent = pa.id
		}
		acct := model.Account{Name: a.newName, Type: r.Type, ParentID: ptr(parent), Number: r.Number, Active: true}
		if a.src != nil {
			acct.Description, acct.BankAcctNumber, acct.Active = a.src.Desc, a.src.BankNum, !a.src.Hidden
			acct.RoutingNumber = a.src.Routing
		}
		var id int64
		uerr, ferr := im.try(func() error {
			var err error
			if id, err = lists.SaveAccount(im.ctx, im.tx, &acct, im.opt); err != nil {
				return err
			}
			if a.special != "" {
				var n int
				if err := im.tx.QueryRowContext(im.ctx, `SELECT COUNT(*) FROM accounts WHERE special = ?`, a.special).Scan(&n); err != nil {
					return err
				}
				if n == 0 {
					_, err = im.tx.ExecContext(im.ctx, `UPDATE accounts SET special = ? WHERE id = ?`, a.special, id)
				}
			}
			return err
		})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			a.failed = true
			im.problem("iif", r.Line, levelError, "The account %s was not created: %s", r.Source, errText(uerr))
			c.Skipped++
			continue
		}
		a.id = id
		c.Created++
	}
	return nil
}

// renumber gives an account matched in the company file the number (and
// description, when it has none) it has in QuickBooks.
func (im *importer) renumber(a *pAcct) error {
	acct, err := lists.GetAccount(im.ctx, im.tx, a.id)
	if err != nil {
		return err
	}
	acct.Number = a.renumber
	if acct.Description == "" {
		acct.Description = a.src.Desc
	}
	acct.OpeningBalance, acct.OpeningDate = nil, ""
	uerr, ferr := im.try(func() error {
		_, err := lists.SaveAccount(im.ctx, im.tx, acct, im.opt)
		return err
	})
	if ferr != nil {
		return ferr
	}
	if uerr != nil {
		im.problem("iif", a.row.Line, levelNote, "The account %s keeps its number: %s", acct.FullName, errText(uerr))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Names

// importNames creates the names of one group: customers (and jobs) when
// customers is true, else vendors and other names.
func (im *importer) importNames(customers bool) error {
	p := im.p
	for _, k := range sortedKeys(p.names, func(n *pName) int { return n.depth }) {
		n := p.names[k]
		r := n.row
		if (r.Kind == model.NameCustomer) != customers || r.Action == "use" {
			continue
		}
		label := map[string]string{model.NameCustomer: "Customers and jobs", model.NameVendor: "Vendors", model.NameOther: "Other names"}[r.Kind]
		c := im.count(label)
		switch r.Action {
		case "existing", "map":
			n.id = r.TargetID
			im.nameKind[n.id] = r.Kind
			if n.src != nil {
				c.Matched++
			}
			continue
		}
		if r.Blocking {
			n.failed = true
			if n.src != nil {
				c.Skipped++
			}
			continue
		}
		var parent int64
		if n.parentKey != "" {
			pn := p.finalName(p.names[n.parentKey])
			if pn == nil || pn.id == 0 {
				n.failed = true
				im.problem("iif", r.Line, levelError, "The job %s was not created because its customer %s could not be created.", r.Source, p.names[n.parentKey].row.Source)
				c.Skipped++
				continue
			}
			parent = pn.id
		}
		var m model.Name
		if n.src != nil {
			m = n.src.N
			typeList := model.ListCustomerType
			if r.Kind == model.NameVendor {
				typeList = model.ListVendorType
			}
			m.TermsID = im.listRef(model.ListTerms, n.src.Terms, r.Line)
			if r.Kind != model.NameOther {
				m.TypeID = im.listRef(typeList, n.src.Type, r.Line)
			}
			m.RepID = im.listRef(model.ListSalesRep, n.src.Rep, r.Line)
			m.JobTypeID = im.listRef(model.ListJobType, n.src.Job, r.Line)
			if n.src.Tax != "" {
				if id, _, _ := im.itemID(n.src.Tax); id != 0 {
					if it := im.item(id); it != nil && (it.typ == model.ItemSalesTax || it.typ == model.ItemSalesTaxGroup) {
						m.TaxItemID = ptr(id)
					}
				}
				if m.TaxItemID == nil {
					im.problem("iif", r.Line, levelNote, "The sales tax item %s of %s was not imported; set the customer's tax item again.", n.src.Tax, r.Source)
				}
			}
		} else {
			m.Active = true
		}
		m.ID = 0
		m.Kind = r.Kind
		m.Name = n.newName
		m.ParentID = ptr(parent)
		if r.Kind != model.NameCustomer {
			m.ShipAddress = model.Address{}
		}
		var id int64
		uerr, ferr := im.try(func() error {
			var err error
			id, err = lists.SaveName(im.ctx, im.tx, &m, im.opt)
			return err
		})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			n.failed = true
			im.problem("iif", r.Line, levelError, "The %s %s was not created: %s", kindLabels[r.Kind], r.Source, errText(uerr))
			c.Skipped++
			continue
		}
		n.id = id
		im.nameKind[id] = r.Kind
		c.Created++
	}
	return nil
}

// ---------------------------------------------------------------------------
// Items

func (im *importer) importItems() error {
	p := im.p
	c := im.count("Items")
	keys := sortedKeys(p.items, func(it *pItem) int { return it.depth })
	// sales tax items first: groups and customers use them
	sort.SliceStable(keys, func(i, j int) bool {
		ti, tj := p.items[keys[i]].row.Type == model.ItemSalesTax, p.items[keys[j]].row.Type == model.ItemSalesTax
		return ti && !tj
	})
	acctOf := func(full string) int64 {
		id, _ := im.accountID(full)
		return id
	}
	for _, k := range keys {
		it := p.items[k]
		r := it.row
		switch r.Action {
		case "use":
			continue
		case "existing", "map":
			it.id = r.TargetID
			if it.src != nil {
				c.Matched++
			}
			continue
		case "none":
			if it.src != nil {
				if r.Type == model.ItemGroup || r.Type == model.ItemSalesTaxGroup {
					im.problem("iif", r.Line, levelNote, "The group %s was not imported (the file does not list its items); re-create it in the Item List.", r.Source)
				}
			}
			continue
		}
		if r.Blocking {
			it.failed = true
			if it.src != nil {
				c.Skipped++
			}
			continue
		}
		var parent int64
		if it.parentKey != "" {
			pi := p.finalItem(p.items[it.parentKey])
			if pi == nil || pi.id == 0 {
				it.failed = true
				im.problem("iif", r.Line, levelError, "The item %s was not created because its parent item %s could not be created.", r.Source, p.items[it.parentKey].row.Source)
				c.Skipped++
				continue
			}
			parent = pi.id
		}
		m := model.Item{Type: r.Type, Name: it.newName, ParentID: ptr(parent), Active: true}
		if s := it.src; s != nil {
			m.Description, m.PurchaseDescription, m.Taxable, m.Active = s.Desc, s.PurchDesc, s.Taxable, !s.Hidden
			m.SalesPrice, m.RateIsPercent, m.Cost = s.Price, s.PricePct, s.Cost
			m.ReorderPoint = s.ReorderPoint
			if s.PrefVend != "" {
				if id, _ := im.nameID(s.PrefVend); id != 0 && im.kindOf(id) == model.NameVendor {
					m.PreferredVendorID = ptr(id)
				}
			}
			inc, cogs, asset := acctOf(s.Accnt), acctOf(s.COGSAccnt), acctOf(s.AssetAccnt)
			switch r.Type {
			case model.ItemService, model.ItemNonInventory, model.ItemOtherCharge:
				m.IncomeAccountID = ptr(inc)
				if s.Purchased && cogs != 0 {
					m.IsPurchased, m.ExpenseAccountID = true, ptr(cogs)
				}
			case model.ItemInventoryPart:
				m.IncomeAccountID, m.ExpenseAccountID = ptr(inc), ptr(cogs)
				if a := im.acct(asset); a != nil && a.typ == model.AcctOCA {
					m.AssetAccountID = ptr(asset)
				} else if asset != 0 {
					im.problem("iif", r.Line, levelNote, "The inventory asset account of %s is not an Other Current Asset account; Inventory Asset is used instead.", r.Source)
				}
				if s.RawType != "" && strings.EqualFold(typeKey(s.RawType), "ASSEMBLY") {
					im.problem("iif", r.Line, levelNote, "%s is an inventory assembly in the QuickBooks® file; it is imported as an inventory part (its components are not).", r.Source)
				}
			case model.ItemDiscount:
				m.IncomeAccountID = ptr(inc)
				if m.SalesPrice < 0 {
					m.SalesPrice = -m.SalesPrice
				}
			case model.ItemPayment:
				if a := im.acct(inc); a != nil && a.special != store.SpecialUndepositedFunds {
					m.DepositAccountID = ptr(inc)
				}
				m.PaymentMethodID = im.listRef(model.ListPaymentMethod, s.PayMeth, r.Line)
			case model.ItemSalesTax:
				m.TaxRate = s.Price
				m.SalesPrice, m.RateIsPercent = 0, false
				if s.TaxVend != "" {
					if id, _ := im.nameID(s.TaxVend); id != 0 && im.kindOf(id) == model.NameVendor {
						m.TaxAgencyID = ptr(id)
					}
				}
				if m.TaxAgencyID == nil {
					id, err := im.agency(r.Line, r.Source)
					if err != nil {
						return err
					}
					m.TaxAgencyID = ptr(id)
				}
			}
			if m.RateIsPercent && r.Type != model.ItemOtherCharge && r.Type != model.ItemDiscount {
				m.RateIsPercent = false
			}
		} else {
			acct := orStr(it.salesAcct, it.purchAcct)
			m.IncomeAccountID = ptr(acctOf(acct))
			if it.salesAcct != "" && it.purchAcct != "" && r.Type != model.ItemInventoryPart {
				m.IsPurchased, m.ExpenseAccountID = true, ptr(acctOf(it.purchAcct))
			}
		}
		needsIncome := r.Type == model.ItemService || r.Type == model.ItemNonInventory || r.Type == model.ItemOtherCharge ||
			r.Type == model.ItemInventoryPart || r.Type == model.ItemDiscount
		if needsIncome && m.IncomeAccountID == nil {
			id, err := im.special(store.SpecialUncategorizedIncome)
			if err != nil {
				return err
			}
			m.IncomeAccountID = ptr(id)
			im.problem("iif", r.Line, levelNote, "The item %s has no account in the file; it uses Uncategorized Income.", r.Source)
		}
		var id int64
		uerr, ferr := im.try(func() error {
			var err error
			id, err = lists.SaveItem(im.ctx, im.tx, &m, im.opt)
			return err
		})
		if ferr != nil {
			return ferr
		}
		if uerr != nil {
			it.failed = true
			im.problem("iif", r.Line, levelError, "The item %s was not created: %s", r.Source, errText(uerr))
			c.Skipped++
			continue
		}
		it.id = id
		c.Created++
	}
	return nil
}

// agency returns the vendor used for sales tax items whose file names no tax agency.
func (im *importer) agency(line int, item string) (int64, error) {
	if im.taxAgency != 0 {
		return im.taxAgency, nil
	}
	name := "Sales Tax Agency"
	var id int64
	err := im.tx.QueryRowContext(im.ctx, `SELECT id FROM names WHERE kind = 'vendor' AND parent_id IS NULL AND name = ?`, name).Scan(&id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if id == 0 {
		n := model.Name{Kind: model.NameVendor, Name: name, Active: true, Notes: "Created by the import of QuickBooks® Desktop files for sales tax items without a tax agency."}
		if id, err = lists.SaveName(im.ctx, im.tx, &n, im.opt); err != nil {
			return 0, err
		}
		im.count("Vendors").Created++
	}
	im.problem("iif", line, levelNote, "The sales tax item %s has no tax agency in the file; it is paid to the vendor \"%s\". Change it in the Item List if needed.", item, name)
	im.taxAgency = id
	return id, nil
}

// ---------------------------------------------------------------------------
// Preferences

// setPrefs turns on what the imported lists use: sales tax, inventory, classes, account numbers.
func (im *importer) setPrefs() error {
	pr, err := store.LoadPrefs(im.ctx, im.tx)
	if err != nil {
		return err
	}
	var n int
	q := func(query string, args ...any) bool {
		n = 0
		im.tx.QueryRowContext(im.ctx, query, args...).Scan(&n)
		return n > 0
	}
	if q(`SELECT COUNT(*) FROM items WHERE type IN (?, ?)`, model.ItemSalesTax, model.ItemSalesTaxGroup) {
		pr.SalesTaxEnabled = true
		if pr.DefaultSalesTaxItemID == nil {
			var id int64
			if im.tx.QueryRowContext(im.ctx, `SELECT id FROM items WHERE type = ? AND active = 1 ORDER BY id LIMIT 1`, model.ItemSalesTax).Scan(&id) == nil {
				pr.DefaultSalesTaxItemID = &id
			}
		}
	}
	if q(`SELECT COUNT(*) FROM items WHERE type = ?`, model.ItemInventoryPart) {
		pr.InventoryEnabled = true
	}
	if q(`SELECT COUNT(*) FROM list_entries WHERE list = ?`, model.ListClass) && len(im.lists[model.ListClass]) > 0 {
		for _, e := range im.ps.src.lists {
			if e.List == model.ListClass {
				pr.UseClassTracking = true
				break
			}
		}
	}
	for _, a := range im.ps.src.accounts {
		if a.Number != "" {
			pr.UseAccountNumbers = true
			break
		}
	}
	return store.SavePrefs(im.ctx, im.tx, pr)
}

// ---------------------------------------------------------------------------
// Bank rules

// suggestRules finds the bank rules the imported transactions suggest (QuickBooks®
// Desktop files do not carry the rules themselves) and, in a real import,
// creates those the user kept.
func (im *importer) suggestRules() error {
	sugg, err := banking.SuggestRules(im.ctx, im.tx, banking.SuggestOptions{Dismissed: true})
	if err != nil {
		return err
	}
	im.rep.RuleSuggestions = sugg
	if im.rep.DryRun || len(im.in.Opt.Rules) == 0 {
		return nil
	}
	var keep []model.BankRule
	var keys []string
	for i, s := range sugg {
		ch, ok := im.in.Opt.Rules[s.Key]
		if !ok {
			continue
		}
		r := &sugg[i].Rule // the report shows the rule as created
		if t := strings.TrimSpace(ch.MatchText); t != "" && t != r.MatchText {
			if r.Name == r.MatchText {
				r.Name = t
			}
			r.MatchText = t
		}
		keep = append(keep, *r)
		keys = append(keys, s.Key)
	}
	var n int
	uerr, ferr := im.try(func() error {
		var err error
		n, err = banking.CreateRules(im.ctx, im.tx, keep)
		return err
	})
	if ferr != nil {
		return ferr
	}
	if uerr != nil {
		im.problem("", 0, levelError, "The bank rules were not created: %s", errText(uerr))
		return nil
	}
	if n > 0 {
		im.count("Bank rules").Created = n
		im.rep.RulesCreated = keys
	}
	return nil
}

// ---------------------------------------------------------------------------

var lineRef = regexp.MustCompile(`^Line (\d+): `)

// lineOf maps an error "Line 3: ..." of the ledger to the split row it came from.
func lineOf(err error, splitLines []int, def int) int {
	if m := lineRef.FindStringSubmatch(errText(err)); m != nil {
		if n, _ := strconv.Atoi(m[1]); n >= 1 && n <= len(splitLines) && splitLines[n-1] != 0 {
			return splitLines[n-1]
		}
	}
	return def
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
