package qbimport

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/model"
	"seriex/internal/store"
)

// Preview is what the files contain and how they map onto the company.
type Preview struct {
	FileName     string       `json:"fileName"`
	Product      string       `json:"product"`
	Version      string       `json:"version"`
	Lines        int          `json:"lines"`
	Sections     []Section    `json:"sections"`
	Transactions []TxnCount   `json:"transactions"`
	DateFrom     string       `json:"dateFrom"`
	DateTo       string       `json:"dateTo"`
	Accounts     []AccountRow `json:"accounts"`
	Names        []NameRow    `json:"names"`
	Items        []ItemRow    `json:"items"`
	Balances     []BalanceRow `json:"balances"` // balances of the files by account (debit positive)
	TrialBalance *TBInfo      `json:"trialBalance,omitempty"`
	OpenInvoices *DocsInfo    `json:"openInvoices,omitempty"`
	OpenBills    *DocsInfo    `json:"openBills,omitempty"`
	Target       TargetInfo   `json:"target"`
	Problems     []Problem    `json:"problems"`
	Errors       int          `json:"errors"`
	Notes        int          `json:"notes"`
	Blocking     int          `json:"blocking"` // mapping rows that need a choice
}

// Section counts the rows of one kind of the IIF file.
type Section struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// TBInfo summarizes the trial balance file.
type TBInfo struct {
	Rows    int     `json:"rows"`
	Debits  float64 `json:"debits"`
	Credits float64 `json:"credits"`
	AsOf    string  `json:"asOf"`
}

// DocsInfo summarizes an open invoices or unpaid bills file.
type DocsInfo struct {
	Count   int     `json:"count"`
	Total   float64 `json:"total"`
	Credits int     `json:"credits"`
}

// TargetInfo describes the company file the books go into.
type TargetInfo struct {
	Transactions int  `json:"transactions"`
	Empty        bool `json:"empty"`
}

var sectionOrder = []string{"ACCNT", "CUST", "VEND", "OTHERNAME", "EMP", "INVITEM", "CLASS", "TERMS", "PAYMETH", "SHIPMETH",
	"CTYPE", "VTYPE", "JOBTYPE", "CUSTMSG", "SALESREP", "TRNS"}

func previewOf(ctx context.Context, q store.Q, in *Inputs) (*Preview, error) {
	ps, err := parseInputs(in)
	if err != nil {
		return nil, err
	}
	tgt, err := loadTarget(ctx, q)
	if err != nil {
		return nil, err
	}
	p := buildPlan(ps.src, ps.txns, ps.tb, ps.invoices, ps.bills, tgt, in.Opt)
	pv := &Preview{FileName: in.IIFName, Product: ps.file.Product, Version: ps.file.Version, Lines: ps.file.Lines,
		Target: TargetInfo{Transactions: tgt.txns, Empty: tgt.txns == 0}}
	seen := map[string]bool{}
	for _, k := range sectionOrder {
		if n := ps.file.Kinds[k]; n > 0 {
			pv.Sections = append(pv.Sections, Section{Key: k, Label: sectionLabels[k], Count: n})
			seen[k] = true
		}
	}
	var other []string
	for k := range ps.file.Kinds {
		if !seen[k] {
			other = append(other, k)
		}
	}
	sort.Strings(other)
	for _, k := range other {
		pv.Sections = append(pv.Sections, Section{Key: k, Label: k + " (not imported)", Count: ps.file.Kinds[k]})
	}
	byType := map[string]*TxnCount{}
	var types []string
	for _, t := range ps.txns {
		k := strings.ToUpper(strings.TrimSpace(t.RawType))
		c := byType[k]
		if c == nil {
			c = &TxnCount{Source: orStr(t.RawType, "(no type)"), Label: ledger.TypeLabel(t.Kind, "")}
			byType[k] = c
			types = append(types, k)
		}
		c.Count++
		if pv.DateFrom == "" || t.Date < pv.DateFrom {
			pv.DateFrom = t.Date
		}
		if t.Date > pv.DateTo {
			pv.DateTo = t.Date
		}
	}
	sort.Strings(types)
	for _, k := range types {
		pv.Transactions = append(pv.Transactions, *byType[k])
	}
	pv.Accounts, pv.Names, pv.Items = p.rows()
	// balances of the files
	bal := map[string]int64{}
	if ps.tb != nil {
		for _, r := range ps.tb.Rows {
			bal[normFull(r.Full)] += r.Amount
		}
		pv.TrialBalance = &TBInfo{Rows: len(ps.tb.Rows), Debits: dollars(ps.tb.Debits), Credits: dollars(ps.tb.Credits), AsOf: ps.tb.AsOf}
	}
	for _, t := range ps.txns {
		for _, s := range append([]srcSplit{t.Head}, t.Splits...) {
			bal[normFull(s.Accnt)] += s.Amount
		}
	}
	for k, amt := range bal {
		a := p.accts[k]
		if a == nil || amt == 0 {
			continue
		}
		pv.Balances = append(pv.Balances, BalanceRow{Account: a.row.Source, Number: a.row.Number, Type: a.row.Type, Source: dollars(amt)})
	}
	sort.Slice(pv.Balances, func(i, j int) bool {
		a, b := pv.Balances[i], pv.Balances[j]
		if ra, rb := model.AccountTypeRank(a.Type), model.AccountTypeRank(b.Type); ra != rb {
			return ra < rb
		}
		return strings.ToLower(a.Account) < strings.ToLower(b.Account)
	})
	docs := func(ds []openDoc) *DocsInfo {
		d := &DocsInfo{Count: len(ds)}
		var total int64
		for _, x := range ds {
			total += x.Open
			if x.Open < 0 {
				d.Credits++
			}
		}
		d.Total = dollars(total)
		return d
	}
	if in.Opt.Mode == "opening" {
		pv.OpenInvoices, pv.OpenBills = docs(ps.invoices), docs(ps.bills)
	}
	probs := append(append([]Problem{}, ps.problems...), p.problems...)
	block := p.blocking()
	pv.Blocking = len(block)
	probs = append(probs, block...)
	if tgt.txns > 0 {
		probs = append(probs, Problem{Level: levelError, Message: "This company file already has transactions. Books from QuickBooks® Desktop files can only be imported into a new company file or into one without transactions."})
	}
	sort.SliceStable(probs, func(i, j int) bool {
		a, b := probs[i], probs[j]
		if (a.Level == levelError) != (b.Level == levelError) {
			return a.Level == levelError
		}
		if a.File != b.File {
			return fileRank(a.File) < fileRank(b.File)
		}
		return a.Line < b.Line
	})
	for _, pr := range probs {
		if pr.Level == levelError {
			pv.Errors++
		} else {
			pv.Notes++
		}
	}
	if len(probs) > maxProblems {
		probs = probs[:maxProblems]
	}
	pv.Problems = probs
	if pv.Problems == nil {
		pv.Problems = []Problem{}
	}
	for _, s := range []*[]BalanceRow{&pv.Balances} {
		if *s == nil {
			*s = []BalanceRow{}
		}
	}
	if pv.Sections == nil {
		pv.Sections = []Section{}
	}
	if pv.Transactions == nil {
		pv.Transactions = []TxnCount{}
	}
	if pv.Accounts == nil {
		pv.Accounts = []AccountRow{}
	}
	if pv.Names == nil {
		pv.Names = []NameRow{}
	}
	if pv.Items == nil {
		pv.Items = []ItemRow{}
	}
	return pv, nil
}

// run imports the files into the company of tx. The caller commits only
// when the report says Imported (never for a dry run).
func run(ctx context.Context, tx *sql.Tx, in *Inputs, user string, dryRun bool) (*Report, error) {
	ps, err := parseInputs(in)
	if err != nil {
		return nil, err
	}
	tgt, err := loadTarget(ctx, tx)
	if err != nil {
		return nil, err
	}
	if tgt.txns > 0 {
		return nil, apperr.Conflict("This company file already has %d transactions. Books from QuickBooks® Desktop files can only be imported into a new company file or into one without transactions.", tgt.txns)
	}
	mode := in.Opt.Mode
	if mode != "opening" {
		mode = "transactions"
		in.Opt.Mode = mode
	}
	p := buildPlan(ps.src, ps.txns, ps.tb, ps.invoices, ps.bills, tgt, in.Opt)
	im := &importer{ctx: ctx, tx: tx, opt: ledger.SaveOptions{User: user, Force: true}, in: in, ps: ps, p: p,
		rep:   &Report{DryRun: dryRun, Mode: mode},
		lists: map[string]map[string]int64{}, reps: map[string]int64{}, accts: map[int64]*acctData{}, items: map[int64]*itemData{},
		nameKind: map[int64]string{}, counts: map[string]*CountRow{}, txCounts: map[string]*TxnCount{}, ufWaiting: map[int64][]waiting{}}
	for l, m := range tgt.lists {
		im.lists[l] = map[string]int64{}
		for k, v := range m {
			im.lists[l][k] = v
		}
	}
	for k, v := range tgt.reps {
		im.reps[k] = v
	}
	im.rep.Problems = append(append(append([]Problem{}, ps.problems...), p.problems...), p.blocking()...)

	steps := []func() error{
		func() error { return im.importSimpleLists(false) },
		im.importAccounts,
		func() error { return im.importNames(false) },
		func() error { return im.importSimpleLists(true) },
		im.importItems,
		func() error { return im.importNames(true) },
		im.setPrefs,
	}
	if mode == "opening" {
		steps = append(steps, im.importOpening)
	}
	steps = append(steps, im.importTxns, im.suggestRules, im.finish)
	for _, step := range steps {
		if err := step(); err != nil {
			return nil, err
		}
	}
	im.finalize()
	im.rep.Imported = !dryRun && (im.rep.Errors == 0 || in.Opt.SkipProblems)
	return im.rep, nil
}

// ---------------------------------------------------------------------------
// HTTP

// CreateFunc creates a new company file and fills it inside the same
// transaction (companies.CreateCompanyWith); an error from fill removes it.
type CreateFunc func(ctx context.Context, req model.NewCompanyRequest, fill func(tx *sql.Tx, id string) error) (store.CompanyFile, error)

// errRollback ends a write transaction without keeping its changes.
var errRollback = errors.New("rollback")

// maxUpload is the largest upload accepted (all files together).
const maxUpload = 128 << 20

func readInputs(w http.ResponseWriter, r *http.Request) (*Inputs, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, apperr.Validation("iif", "The files are too large (%d MB together at most).", maxUpload>>20)
		}
		return nil, apperr.BadRequest("Upload the files as a form (field \"iif\" for the IIF file).")
	}
	in := &Inputs{}
	read := func(field string) ([]byte, string, error) {
		f, h, err := r.FormFile(field)
		if err != nil {
			return nil, "", nil
		}
		defer f.Close()
		b, err := io.ReadAll(f)
		if err != nil {
			return nil, "", apperr.BadRequest("Could not read the uploaded file %s.", h.Filename)
		}
		return b, h.Filename, nil
	}
	var err error
	if in.IIF, in.IIFName, err = read("iif"); err != nil {
		return nil, err
	}
	if in.TB, _, err = read("tb"); err != nil {
		return nil, err
	}
	if in.Invoices, _, err = read("invoices"); err != nil {
		return nil, err
	}
	if in.Bills, _, err = read("bills"); err != nil {
		return nil, err
	}
	if s := r.FormValue("options"); s != "" {
		if err := json.Unmarshal([]byte(s), &in.Opt); err != nil {
			return nil, apperr.BadRequest("The import options could not be read.")
		}
	}
	return in, nil
}

// Register adds the QuickBooks Desktop import routes:
//
//	POST /api/c/{cid}/qbimport/preview          files + options -> Preview
//	POST /api/c/{cid}/qbimport/run[?dryRun=1]   files + options -> Report (into this company, which must have no transactions)
//	POST /api/qbimport/preview                  same, for a new company file
//	POST /api/qbimport/run[?dryRun=1]           creates the company file options.company and imports into it
//
// The files are multipart fields "iif", "tb", "invoices" and "bills"; the
// options a JSON field "options" (see Options).
func Register(rt *httpx.Router, create CreateFunc) {
	rt.C("POST", "/qbimport/preview", func(c *httpx.Ctx) error {
		if err := store.RequireAdmin(c.Context(), c.DB, c.User, "Only an administrator can import QuickBooks® Desktop files."); err != nil {
			return err
		}
		in, err := readInputs(c.W, c.R)
		if err != nil {
			return err
		}
		pv, err := previewOf(c.Context(), c.DB, in)
		if err != nil {
			return err
		}
		return c.JSON(pv)
	})
	rt.C("POST", "/qbimport/run", func(c *httpx.Ctx) error {
		in, err := readInputs(c.W, c.R)
		if err != nil {
			return err
		}
		dry := c.QBool("dryRun")
		var rep *Report
		err = c.Write(func(tx *sql.Tx) error {
			if err := store.RequireAdmin(c.Context(), tx, c.User, "Only an administrator can import QuickBooks® Desktop files."); err != nil {
				return err
			}
			var err error
			if rep, err = run(c.Context(), tx, in, c.User, dry); err != nil {
				return err
			}
			if !rep.Imported {
				return errRollback
			}
			return nil
		})
		if err != nil && !errors.Is(err, errRollback) {
			return err
		}
		return c.JSON(rep)
	})
	newCompany := func(in *Inputs) (model.NewCompanyRequest, error) {
		if in.Opt.Company == nil || strings.TrimSpace(in.Opt.Company.Name) == "" {
			return model.NewCompanyRequest{}, apperr.Validation("company.name", "Enter the name of the new company.")
		}
		req := *in.Opt.Company
		req.CreateDefaultAccounts = false
		if req.Industry == "" {
			req.Industry = "none"
		}
		return req, nil
	}
	rt.Handle("POST", "/api/qbimport/preview", func(w http.ResponseWriter, r *http.Request) error {
		in, err := readInputs(w, r)
		if err != nil {
			return err
		}
		req, err := newCompany(in)
		if err != nil {
			return err
		}
		var pv *Preview
		_, err = create(r.Context(), req, func(tx *sql.Tx, id string) error {
			var err error
			if pv, err = previewOf(r.Context(), tx, in); err != nil {
				return err
			}
			return errRollback
		})
		if err != nil && !errors.Is(err, errRollback) {
			return err
		}
		return httpx.WriteJSON(w, http.StatusOK, pv)
	})
	rt.Handle("POST", "/api/qbimport/run", func(w http.ResponseWriter, r *http.Request) error {
		in, err := readInputs(w, r)
		if err != nil {
			return err
		}
		req, err := newCompany(in)
		if err != nil {
			return err
		}
		dry := r.URL.Query().Get("dryRun") == "1"
		var rep *Report
		cf, err := create(r.Context(), req, func(tx *sql.Tx, id string) error {
			var err error
			if rep, err = run(r.Context(), tx, in, "Admin", dry); err != nil {
				return err
			}
			rep.Company = &CompanyRef{ID: id, Name: req.Name}
			if !rep.Imported {
				return errRollback
			}
			return nil
		})
		if err != nil && !errors.Is(err, errRollback) {
			return err
		}
		if rep != nil && rep.Imported {
			rep.Company = &CompanyRef{ID: cf.ID, Name: cf.Name}
		} else if rep != nil {
			rep.Company = nil
		}
		return httpx.WriteJSON(w, http.StatusOK, rep)
	})
}
