package qbimport

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"seriex/internal/model"
	"seriex/internal/store"
)

// ---------------------------------------------------------------------------
// Choices sent back by the mapping review

// Options are the choices of the wizard.
type Options struct {
	Mode           string                   `json:"mode"`           // "transactions" (default) | "opening"
	ConversionDate string                   `json:"conversionDate"` // opening mode: date of the trial balance
	SkipProblems   bool                     `json:"skipProblems"`   // import what can be imported, skip the lines with problems
	Accounts       map[string]AccountMap    `json:"accounts"`       // by source full name
	Items          map[string]ItemMap       `json:"items"`
	Names          map[string]NameMap       `json:"names"`
	Company        *model.NewCompanyRequest `json:"company"` // target "new": the company to create
	// Rules: the suggested bank rules to create, by RuleSuggestion.Key; a
	// match text replaces the suggested one.
	Rules map[string]RuleChoice `json:"rules"`
}

// RuleChoice keeps one suggested bank rule.
type RuleChoice struct {
	MatchText string `json:"matchText"`
}

// AccountMap: "create" (Type, optional Name), "map" (TargetID, an account of
// the company) or "use" (Source: the same as that account of the files).
type AccountMap struct {
	Action   string `json:"action"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	TargetID int64  `json:"targetId"`
	Source   string `json:"source"`
}

// ItemMap: "create" (Type), "map" (TargetID), "use" (Source: the same as that
// item of the files) or "none" (lines post to their account without an item).
type ItemMap struct {
	Action   string `json:"action"`
	Type     string `json:"type"`
	TargetID int64  `json:"targetId"`
	Source   string `json:"source"`
}

// NameMap: "create" (Kind, optional Name), "map" (TargetID) or "use" (Source:
// the same as that name of the files).
type NameMap struct {
	Action   string `json:"action"`
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	TargetID int64  `json:"targetId"`
	Source   string `json:"source"`
}

// ---------------------------------------------------------------------------
// Mapping review rows (preview)

// AccountRow is one account of the mapping review.
type AccountRow struct {
	Source     string `json:"source"`     // full name in the files
	Line       int    `json:"line"`       // ACCNT row (0: only used by transactions, items or the trial balance)
	SourceType string `json:"sourceType"` // ACCNTTYPE as written
	Number     string `json:"number"`
	Action     string `json:"action"`     // "create" | "existing" | "map"
	Type       string `json:"type"`       // SerieX type
	TargetID   int64  `json:"targetId"`   // existing / map
	TargetName string `json:"targetName"` // full name of the account used or created
	Review     string `json:"review"`     // what to check ("" = nothing)
	Blocking   bool   `json:"blocking"`   // a choice is needed before importing
	UseSource  string `json:"useSource"`  // "use": the entry of the files this one is the same as
	Uses       int    `json:"uses"`       // transaction lines that use it
}

// ItemRow is one item of the mapping review.
type ItemRow struct {
	Source     string `json:"source"`
	Line       int    `json:"line"`
	SourceType string `json:"sourceType"`
	Action     string `json:"action"` // "create" | "existing" | "map" | "none"
	Type       string `json:"type"`
	TargetID   int64  `json:"targetId"`
	TargetName string `json:"targetName"`
	Review     string `json:"review"`
	Blocking   bool   `json:"blocking"`
	UseSource  string `json:"useSource"` // "use": the entry of the files this one is the same as
	Uses       int    `json:"uses"`
}

// NameRow is one customer, job, vendor or other name of the mapping review.
type NameRow struct {
	Source     string `json:"source"`
	Line       int    `json:"line"`
	Kind       string `json:"kind"`
	Action     string `json:"action"` // "create" | "existing" | "map"
	TargetID   int64  `json:"targetId"`
	TargetName string `json:"targetName"`
	Review     string `json:"review"`
	Blocking   bool   `json:"blocking"`
	UseSource  string `json:"useSource"` // "use": the entry of the files this one is the same as
	Uses       int    `json:"uses"`
}

// ---------------------------------------------------------------------------
// The company file as it is before the import

type tAcct struct {
	ID              int64
	Full, Type      string
	Special, Number string
}

type tName struct {
	ID         int64
	Full, Kind string
}

type tItem struct {
	ID         int64
	Full, Type string
}

type target struct {
	accts     map[string]*tAcct // normFull ->
	acctByID  map[int64]*tAcct
	acctByNum map[string]*tAcct
	special   map[string]*tAcct
	names     map[string]*tName
	nameByID  map[int64]*tName
	items     map[string]*tItem
	itemByID  map[int64]*tItem
	lists     map[string]map[string]int64 // list -> normFull -> id
	reps      map[string]int64            // lower initials -> sales rep id
	txns      int
}

func loadTarget(ctx context.Context, q store.Q) (*target, error) {
	t := &target{accts: map[string]*tAcct{}, acctByID: map[int64]*tAcct{}, acctByNum: map[string]*tAcct{}, special: map[string]*tAcct{},
		names: map[string]*tName{}, nameByID: map[int64]*tName{}, items: map[string]*tItem{}, itemByID: map[int64]*tItem{},
		lists: map[string]map[string]int64{}, reps: map[string]int64{}}
	if err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM txns`).Scan(&t.txns); err != nil {
		return nil, err
	}
	full, err := store.FullNames(ctx, q, "accounts")
	if err != nil {
		return nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, type, special, number FROM accounts`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		a := &tAcct{}
		if err := rows.Scan(&a.ID, &a.Type, &a.Special, &a.Number); err != nil {
			rows.Close()
			return nil, err
		}
		a.Full = full[a.ID]
		t.addAcct(a)
	}
	rows.Close()
	full, err = store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT id, kind FROM names`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		n := &tName{}
		if err := rows.Scan(&n.ID, &n.Kind); err != nil {
			rows.Close()
			return nil, err
		}
		n.Full = full[n.ID]
		t.addName(n)
	}
	rows.Close()
	full, err = store.FullNames(ctx, q, "items")
	if err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT id, type FROM items`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		it := &tItem{}
		if err := rows.Scan(&it.ID, &it.Type); err != nil {
			rows.Close()
			return nil, err
		}
		it.Full = full[it.ID]
		t.addItem(it)
	}
	rows.Close()
	full, err = store.FullNames(ctx, q, "list_entries")
	if err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT id, list, data FROM list_entries`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var list, data string
		if err := rows.Scan(&id, &list, &data); err != nil {
			return nil, err
		}
		t.addList(list, full[id], id)
		if list == model.ListSalesRep {
			var d map[string]any
			_ = json.Unmarshal([]byte(data), &d)
			if ini, _ := d["initials"].(string); ini != "" {
				t.reps[strings.ToLower(ini)] = id
			}
		}
	}
	return t, rows.Err()
}

func (t *target) addAcct(a *tAcct) {
	t.accts[normFull(a.Full)] = a
	t.acctByID[a.ID] = a
	if a.Number != "" {
		t.acctByNum[strings.ToLower(a.Number)] = a
	}
	if a.Special != "" {
		if _, ok := t.special[a.Special]; !ok || a.ID < t.special[a.Special].ID {
			t.special[a.Special] = a
		}
	}
}

func (t *target) addName(n *tName)  { t.names[normFull(n.Full)] = n; t.nameByID[n.ID] = n }
func (t *target) addItem(it *tItem) { t.items[normFull(it.Full)] = it; t.itemByID[it.ID] = it }
func (t *target) addList(list, full string, id int64) {
	if t.lists[list] == nil {
		t.lists[list] = map[string]int64{}
	}
	t.lists[list][normFull(full)] = id
}

// ---------------------------------------------------------------------------
// The plan

type pAcct struct {
	key       string
	row       AccountRow
	src       *srcAccount
	special   string // flag the created account with this special code
	parentKey string
	newName   string // last part of the name to create
	depth     int
	guessType string // type guessed from how the files use it
	id        int64  // after creation / mapping
	failed    bool
	renumber  string // an account matched in the company gets the number it has in QuickBooks
	alias     string // "use": key of the account of the files this one is
}

type pName struct {
	key       string
	row       NameRow
	src       *srcName
	parentKey string
	newName   string
	depth     int
	guess     map[string]int // kind -> evidence weight
	id        int64
	failed    bool
	alias     string
}

type pItem struct {
	key       string
	row       ItemRow
	src       *srcItem
	parentKey string
	newName   string
	depth     int
	salesAcct string // first account seen on sales lines (items created from transactions)
	purchAcct string // first account seen on purchase lines
	id        int64
	failed    bool
	alias     string
}

type plan struct {
	opt      Options
	src      *source
	txns     []*srcTxn
	tb       *trialBalance
	invoices []openDoc
	bills    []openDoc
	tgt      *target
	accts    map[string]*pAcct
	names    map[string]*pName
	items    map[string]*pItem
	problems []Problem
}

// specialNames: QuickBooks names of the accounts SerieX Books keeps for special purposes.
var specialNames = map[string][2]string{
	"opening bal equity":     {store.SpecialOpeningBalanceEquity, model.AcctEquity},
	"opening balance equity": {store.SpecialOpeningBalanceEquity, model.AcctEquity},
	"retained earnings":      {store.SpecialRetainedEarnings, model.AcctEquity},
	"undeposited funds":      {store.SpecialUndepositedFunds, model.AcctOCA},
	"sales tax payable":      {store.SpecialSalesTaxPayable, model.AcctOCL},
	"inventory asset":        {store.SpecialInventoryAsset, model.AcctOCA},
	"cost of goods sold":     {store.SpecialCOGS, model.AcctCOGS},
	"uncategorized income":   {store.SpecialUncategorizedIncome, model.AcctIncome},
	"uncategorized expenses": {store.SpecialUncategorizedExpense, model.AcctExpense},
	"accounts receivable":    {store.SpecialAR, model.AcctAR},
	"accounts payable":       {store.SpecialAP, model.AcctAP},
}

func (p *plan) acct(full string) *pAcct {
	k := normFull(full)
	if k == "" {
		return nil
	}
	if a, ok := p.accts[k]; ok {
		return a
	}
	parts := splitFull(full)
	a := &pAcct{key: k, depth: len(parts) - 1}
	a.row.Source = strings.Join(parts, ":")
	if len(parts) > 1 {
		a.parentKey = normFull(strings.Join(parts[:len(parts)-1], ":"))
		p.acct(strings.Join(parts[:len(parts)-1], ":"))
	}
	p.accts[k] = a
	return a
}

func (p *plan) name(full string) *pName {
	k := normFull(full)
	if k == "" {
		return nil
	}
	if n, ok := p.names[k]; ok {
		return n
	}
	parts := splitFull(full)
	n := &pName{key: k, depth: len(parts) - 1, guess: map[string]int{}}
	n.row.Source = strings.Join(parts, ":")
	if len(parts) > 1 {
		n.parentKey = normFull(strings.Join(parts[:len(parts)-1], ":"))
		parent := p.name(strings.Join(parts[:len(parts)-1], ":"))
		parent.guess[model.NameCustomer] += 100 // only customers have jobs
		n.guess[model.NameCustomer] += 100
	}
	p.names[k] = n
	return n
}

func (p *plan) item(full string) *pItem {
	k := normFull(full)
	if k == "" {
		return nil
	}
	if it, ok := p.items[k]; ok {
		return it
	}
	parts := splitFull(full)
	it := &pItem{key: k, depth: len(parts) - 1}
	it.row.Source = strings.Join(parts, ":")
	if len(parts) > 1 {
		it.parentKey = normFull(strings.Join(parts[:len(parts)-1], ":"))
		p.item(strings.Join(parts[:len(parts)-1], ":"))
	}
	p.items[k] = it
	return it
}

// tbAccount finds the account of a trial balance row: by full name, by
// number, or by its last name part when that is unique.
func (p *plan) tbAccount(r tbRow) string {
	if _, ok := p.accts[normFull(r.Full)]; ok {
		return r.Full
	}
	if r.Number != "" {
		for _, a := range p.src.accounts {
			if strings.EqualFold(a.Number, r.Number) {
				return a.Full
			}
		}
		if a := p.tgt.acctByNum[strings.ToLower(r.Number)]; a != nil {
			return a.Full
		}
	}
	if a, ok := p.tgt.accts[normFull(r.Full)]; ok {
		return a.Full
	}
	last := strings.ToLower(splitFull(r.Full)[len(splitFull(r.Full))-1])
	found := ""
	for _, a := range p.src.accounts {
		ps := splitFull(a.Full)
		if strings.ToLower(ps[len(ps)-1]) == last {
			if found != "" {
				return r.Full
			}
			found = a.Full
		}
	}
	if found != "" {
		return found
	}
	return r.Full
}

// buildPlan collects every account, name and item the files define or use,
// and decides for each whether it is created, matched to one of the target
// company or mapped by the user.
func buildPlan(src *source, txns []*srcTxn, tb *trialBalance, invoices, bills []openDoc, tgt *target, opt Options) *plan {
	p := &plan{opt: opt, src: src, txns: txns, tb: tb, invoices: invoices, bills: bills, tgt: tgt,
		accts: map[string]*pAcct{}, names: map[string]*pName{}, items: map[string]*pItem{}}

	// definitions
	for _, a := range src.accounts {
		pa := p.acct(a.Full)
		if pa.src != nil {
			p.problems = append(p.problems, Problem{File: "iif", Line: a.Line, Level: levelNote,
				Message: fmt.Sprintf("The account %s is listed twice; the row on line %d is used.", a.Full, pa.src.Line)})
			continue
		}
		pa.src = a
	}
	for _, n := range src.names {
		pn := p.name(n.Full)
		if pn.src != nil {
			p.problems = append(p.problems, Problem{File: "iif", Line: n.Line, Level: levelError,
				Message: fmt.Sprintf("The name %s is listed twice (also on line %d). Names in QuickBooks® Desktop files are unique across customers, vendors, employees and other names; this row was ignored.", n.Full, pn.src.Line)})
			continue
		}
		pn.src = n
	}
	for _, it := range src.items {
		pi := p.item(it.Full)
		if pi.src != nil {
			p.problems = append(p.problems, Problem{File: "iif", Line: it.Line, Level: levelNote,
				Message: fmt.Sprintf("The item %s is listed twice; the row on line %d is used.", it.Full, pi.src.Line)})
			continue
		}
		pi.src = it
		for _, a := range []string{it.Accnt, it.AssetAccnt, it.COGSAccnt} {
			p.acct(a)
		}
		if it.PrefVend != "" {
			p.name(it.PrefVend).guess[model.NameVendor] += 50
		}
		if it.TaxVend != "" {
			p.name(it.TaxVend).guess[model.NameVendor] += 50
		}
	}
	for _, e := range src.lists {
		if e.List == model.ListSalesRep && e.Rep != "" {
			p.name(e.Rep).guess[model.NameOther] += 1
		}
	}

	// uses in transactions
	acctType := func(full string) string {
		pa := p.accts[normFull(full)]
		if pa == nil {
			return ""
		}
		if pa.src != nil && pa.src.Type != "" {
			return pa.src.Type
		}
		if a := tgt.accts[pa.key]; a != nil {
			return a.Type
		}
		return pa.guessType
	}
	for _, t := range txns {
		all := append([]srcSplit{t.Head}, t.Splits...)
		for i, s := range all {
			if s.Accnt != "" {
				a := p.acct(s.Accnt)
				a.row.Uses++
				if a.guessType == "" {
					a.guessType = guessAccountType(t.Kind, i == 0, s)
				}
			}
			if s.Item != "" {
				it := p.item(s.Item)
				it.row.Uses++
				if isSalesKind(t.Kind) && it.salesAcct == "" {
					it.salesAcct = s.Accnt
				} else if !isSalesKind(t.Kind) && it.purchAcct == "" {
					it.purchAcct = s.Accnt
				}
			}
			if s.Name != "" {
				n := p.name(s.Name)
				n.row.Uses++
				if i > 0 && strings.EqualFold(s.Name, t.Head.Name) {
					continue
				}
				switch at := acctType(s.Accnt); {
				case at == model.AcctAR:
					n.guess[model.NameCustomer] += 10
				case at == model.AcctAP:
					n.guess[model.NameVendor] += 10
				case i == 0 && isSalesKind(t.Kind), i == 0 && t.Kind == model.TxPayment:
					n.guess[model.NameCustomer] += 5
				case i == 0 && (t.Kind == model.TxBill || t.Kind == model.TxVendorCredit || t.Kind == model.TxBillPayment ||
					t.Kind == model.TxItemReceipt || t.Kind == model.TxCheck || t.Kind == model.TxCCCharge || t.Kind == model.TxCCCredit):
					n.guess[model.NameVendor] += 3
				case i > 0 && isPurchaseKind(t.Kind):
					n.guess[model.NameCustomer] += 2 // job costing: the customer:job of a cost
				default:
					n.guess[model.NameOther]++
				}
			}
			if s.Class != "" {
				// classes are created automatically when missing
			}
		}
	}
	if tb != nil {
		for i := range tb.Rows {
			tb.Rows[i].Full = p.tbAccount(tb.Rows[i])
			a := p.acct(tb.Rows[i].Full)
			a.row.Uses++
		}
	}
	for _, d := range invoices {
		p.name(d.Name).guess[model.NameCustomer] += 20
	}
	for _, d := range bills {
		p.name(d.Name).guess[model.NameVendor] += 20
	}

	p.resolveAccounts()
	p.resolveNames()
	p.resolveItems()
	p.resolveAliases()
	return p
}

// finalAcct follows "use" choices to the account an entry really is (nil on a loop).
func (p *plan) finalAcct(a *pAcct) *pAcct {
	for i := 0; i < 20 && a != nil && a.alias != ""; i++ {
		a = p.accts[a.alias]
	}
	if a != nil && a.alias != "" {
		return nil
	}
	return a
}

func (p *plan) finalName(n *pName) *pName {
	for i := 0; i < 20 && n != nil && n.alias != ""; i++ {
		n = p.names[n.alias]
	}
	if n != nil && n.alias != "" {
		return nil
	}
	return n
}

func (p *plan) finalItem(it *pItem) *pItem {
	for i := 0; i < 20 && it != nil && it.alias != ""; i++ {
		it = p.items[it.alias]
	}
	if it != nil && it.alias != "" {
		return nil
	}
	return it
}

// resolveAliases shows, for entries the user said are the same as another
// entry of the files, what that entry becomes.
func (p *plan) resolveAliases() {
	cycle := "This choice goes round in a circle. Choose another."
	for _, a := range p.accts {
		if a.alias == "" {
			continue
		}
		t := a
		for i := 0; i < 20 && t != nil && t.alias != ""; i++ {
			t = p.accts[t.alias]
		}
		if t == nil || t.alias != "" {
			a.row.Review, a.row.Blocking = cycle, true
			continue
		}
		a.row.Type, a.row.TargetID, a.row.TargetName = t.row.Type, t.row.TargetID, orStr(t.row.TargetName, t.row.Source)
	}
	for _, n := range p.names {
		if n.alias == "" {
			continue
		}
		t := n
		for i := 0; i < 20 && t != nil && t.alias != ""; i++ {
			t = p.names[t.alias]
		}
		if t == nil || t.alias != "" {
			n.row.Review, n.row.Blocking = cycle, true
			continue
		}
		n.row.Kind, n.row.TargetID, n.row.TargetName = t.row.Kind, t.row.TargetID, orStr(t.row.TargetName, t.row.Source)
	}
	for _, it := range p.items {
		if it.alias == "" {
			continue
		}
		t := it
		for i := 0; i < 20 && t != nil && t.alias != ""; i++ {
			t = p.items[t.alias]
		}
		if t == nil || t.alias != "" {
			it.row.Review, it.row.Blocking = cycle, true
			continue
		}
		it.row.Type, it.row.TargetID, it.row.TargetName = t.row.Type, t.row.TargetID, orStr(t.row.TargetName, t.row.Source)
		if t.row.Action == "none" {
			it.row.Review = "Lines with this item post to their account without an item, like " + t.row.Source + "."
		}
	}
}

func isSalesKind(k string) bool {
	switch k {
	case model.TxInvoice, model.TxCreditMemo, model.TxSalesReceipt, model.TxStatementCharge:
		return true
	}
	return false
}

func isPurchaseKind(k string) bool {
	switch k {
	case model.TxCheck, model.TxBill, model.TxVendorCredit, model.TxItemReceipt, model.TxCCCharge, model.TxCCCredit:
		return true
	}
	return false
}

// guessAccountType guesses the type of an account the files use but do not list.
func guessAccountType(kind string, head bool, s srcSplit) string {
	if head {
		switch kind {
		case model.TxInvoice, model.TxCreditMemo, model.TxStatementCharge:
			return model.AcctAR
		case model.TxBill, model.TxVendorCredit, model.TxItemReceipt:
			return model.AcctAP
		case model.TxCheck, model.TxDeposit, model.TxBillPayment:
			return model.AcctBank
		case model.TxCCCharge, model.TxCCCredit:
			return model.AcctCreditCard
		case model.TxSalesReceipt, model.TxPayment:
			return model.AcctOCA
		}
		return ""
	}
	switch kind {
	case model.TxInvoice, model.TxCreditMemo, model.TxSalesReceipt, model.TxStatementCharge:
		return model.AcctIncome
	case model.TxPayment:
		return model.AcctAR
	case model.TxBillPayment:
		return model.AcctAP
	case model.TxCheck, model.TxBill, model.TxVendorCredit, model.TxCCCharge, model.TxCCCredit, model.TxItemReceipt:
		return model.AcctExpense
	case model.TxDeposit:
		if s.Amount < 0 {
			return model.AcctIncome
		}
	}
	return ""
}

func validType(t string) bool { return model.AccountTypeRank(t) < 99 }

// sortedKeys returns the keys of m, parents first (by depth, then name).
func sortedKeys[T any](m map[string]T, depth func(T) int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		di, dj := depth(m[keys[i]]), depth(m[keys[j]])
		if di != dj {
			return di < dj
		}
		return keys[i] < keys[j]
	})
	return keys
}

func (p *plan) resolveAccounts() {
	tgt := p.tgt
	usedNums := map[string]bool{}
	for _, a := range tgt.acctByID {
		if a.Number != "" {
			usedNums[strings.ToLower(a.Number)] = true
		}
	}
	for _, k := range sortedKeys(p.accts, func(a *pAcct) int { return a.depth }) {
		a := p.accts[k]
		r := &a.row
		parts := splitFull(r.Source)
		last := parts[len(parts)-1]
		a.newName = last
		if a.src != nil {
			r.Line, r.SourceType, r.Number = a.src.Line, a.src.RawType, a.src.Number
		}
		ch, hasChoice := p.opt.Accounts[r.Source]
		if hasChoice && ch.Action == "map" {
			if ta := tgt.acctByID[ch.TargetID]; ta != nil {
				r.Action, r.TargetID, r.TargetName, r.Type = "map", ta.ID, ta.Full, ta.Type
				continue
			}
			r.Action, r.Review, r.Blocking = "map", "Choose the account of this company to use.", true
			continue
		}
		if hasChoice && ch.Action == "use" {
			if t := p.accts[normFull(ch.Source)]; t != nil && t != a {
				a.alias, r.Action, r.UseSource = t.key, "use", t.row.Source
				continue
			}
			r.Action, r.Review, r.Blocking = "use", sameAsMissing("account", ch.Source), true
			continue
		}
		srcType := ""
		if a.src != nil {
			srcType = a.src.Type
		}
		if hasChoice && ch.Action == "create" && validType(ch.Type) {
			srcType = ch.Type
		}
		// QuickBooks special accounts -> the matching SerieX special account
		special := ""
		if a.src != nil && a.src.Special != "" {
			special = a.src.Special
		} else if a.depth == 0 {
			if sp, ok := specialNames[strings.ToLower(last)]; ok && (srcType == "" || srcType == sp[1]) {
				special = sp[0]
			}
		}
		if special == store.SpecialAR || special == store.SpecialAP {
			// several A/R or A/P accounts are allowed: only the same name matches
			special = ""
			if ta := tgt.accts[k]; ta != nil && (srcType == "" || ta.Type == srcType) {
				r.Action, r.TargetID, r.TargetName, r.Type = "existing", ta.ID, ta.Full, ta.Type
				continue
			}
		}
		if special != "" && !(hasChoice && ch.Action == "create") {
			if ta := tgt.special[special]; ta != nil && (srcType == "" || ta.Type == srcType) {
				r.Action, r.TargetID, r.TargetName, r.Type = "existing", ta.ID, ta.Full, ta.Type
				if !strings.EqualFold(ta.Full, r.Source) {
					r.Review = fmt.Sprintf("%s in the QuickBooks® file is %s in SerieX Books.", r.Source, ta.Full)
				}
				continue
			}
			a.special = special
		}
		if ta := tgt.accts[k]; ta != nil && !(hasChoice && ch.Action == "create") {
			if srcType == "" || ta.Type == srcType {
				r.Action, r.TargetID, r.TargetName, r.Type = "existing", ta.ID, ta.Full, ta.Type
				continue
			}
		}
		// create
		r.Action = "create"
		r.Type = srcType
		if r.Type == "" {
			switch {
			case a.src != nil:
				r.Review = fmt.Sprintf("The account type %q of the QuickBooks® file is not known. Choose the type it gets.", a.src.RawType)
				r.Blocking = true
			case a.guessType != "":
				r.Type = a.guessType
				r.Review = fmt.Sprintf("This account is not in the account list of the file. It will be created as %s; check the type.", a.guessType)
			default:
				r.Review = "This account is not in the account list of the file. Choose its type or an existing account."
				r.Blocking = true
			}
		}
		if hasChoice && ch.Action == "create" && strings.TrimSpace(ch.Name) != "" && !strings.Contains(ch.Name, ":") {
			a.newName = strings.TrimSpace(ch.Name)
		}
		// parent: same type, created or existing
		if a.parentKey != "" {
			pa := p.accts[a.parentKey]
			if pa.row.Type != "" && r.Type != "" && pa.row.Type != r.Type {
				if a.src == nil && pa.row.Action == "create" {
					r.Type = pa.row.Type
				} else {
					r.Review = fmt.Sprintf("Its parent account %s is %s, but a subaccount must have the same type as its parent (this one is %s). Choose another type, or map it to an existing account.", pa.row.Source, pa.row.Type, r.Type)
					r.Blocking = true
				}
			}
			if pa.row.Type == "" && pa.row.Action == "create" && pa.src == nil && r.Type != "" {
				pa.row.Type = r.Type // a parent created only to hold its subaccounts takes their type
				if pa.row.Blocking && pa.src == nil {
					pa.row.Blocking, pa.row.Review = false, ""
				}
			}
		}
		// a different account of the target company has this name
		if ta := tgt.accts[normFull(p.parentFull(a)+":"+a.newName)]; ta != nil && a.newName == last {
			a.newName = fmt.Sprintf("%s (%s)", last, r.Type)
			r.Review = fmt.Sprintf("An account named %s already exists as %s; this one is created as \"%s\".", ta.Full, ta.Type, a.newName)
		}
		r.TargetName = strings.TrimPrefix(p.parentFull(a)+":"+a.newName, ":")
		if r.Number != "" {
			if usedNums[strings.ToLower(r.Number)] {
				p.problems = append(p.problems, Problem{File: "iif", Line: r.Line, Level: levelNote,
					Message: fmt.Sprintf("The account number %s of %s is already used; the account is created without a number.", r.Number, r.Source)})
				r.Number = ""
			} else {
				usedNums[strings.ToLower(r.Number)] = true
			}
		}
	}
	// a parent type set from its subaccounts after the parent was resolved
	for _, a := range p.accts {
		if a.parentKey == "" {
			continue
		}
		pa := p.accts[a.parentKey]
		if a.row.Type != "" && pa.row.Type != "" && a.row.Type != pa.row.Type && !a.row.Blocking && a.row.Action == "create" {
			a.row.Review = fmt.Sprintf("Its parent account %s is %s, but a subaccount must have the same type as its parent (this one is %s). Choose another type, or map it to an existing account.", pa.row.Source, pa.row.Type, a.row.Type)
			a.row.Blocking = true
		}
	}
	// accounts matched in the company file take the QuickBooks number when it is free
	for _, k := range sortedKeys(p.accts, func(a *pAcct) int { return a.depth }) {
		a := p.accts[k]
		if a.row.Action != "existing" || a.src == nil || a.src.Number == "" {
			continue
		}
		ta := tgt.acctByID[a.row.TargetID]
		if ta == nil || strings.EqualFold(ta.Number, a.src.Number) {
			continue
		}
		if usedNums[strings.ToLower(a.src.Number)] {
			a.row.Number = ta.Number
			continue
		}
		usedNums[strings.ToLower(a.src.Number)] = true
		a.renumber = a.src.Number
	}
}

// parentFull is the full name of the account a planned account is created under.
func (p *plan) parentFull(a *pAcct) string {
	if a.parentKey == "" {
		return ""
	}
	pa := p.accts[a.parentKey]
	if pa.row.TargetName != "" {
		return pa.row.TargetName
	}
	return pa.row.Source
}

var kindLabels = map[string]string{model.NameCustomer: "customer", model.NameVendor: "vendor", model.NameOther: "other name"}

func (p *plan) resolveNames() {
	tgt := p.tgt
	for _, k := range sortedKeys(p.names, func(n *pName) int { return n.depth }) {
		n := p.names[k]
		r := &n.row
		parts := splitFull(r.Source)
		last := parts[len(parts)-1]
		n.newName = last
		kind := ""
		if n.src != nil {
			r.Line = n.src.Line
			kind = n.src.Kind
			if n.depth > 0 && kind != model.NameCustomer {
				kind = model.NameCustomer
			}
		} else {
			best := 0
			for _, kk := range []string{model.NameCustomer, model.NameVendor, model.NameOther} {
				if n.guess[kk] > best {
					kind, best = kk, n.guess[kk]
				}
			}
			if kind == "" {
				kind = model.NameOther
			}
		}
		ch, hasChoice := p.opt.Names[r.Source]
		if hasChoice && ch.Action == "map" {
			if tn := tgt.nameByID[ch.TargetID]; tn != nil {
				r.Action, r.TargetID, r.TargetName, r.Kind = "map", tn.ID, tn.Full, tn.Kind
				continue
			}
			r.Action, r.Review, r.Blocking = "map", "Choose the name of this company to use.", true
			continue
		}
		if hasChoice && ch.Action == "use" {
			if t := p.names[normFull(ch.Source)]; t != nil && t != n {
				n.alias, r.Action, r.UseSource = t.key, "use", t.row.Source
				continue
			}
			r.Action, r.Review, r.Blocking = "use", sameAsMissing("name", ch.Source), true
			continue
		}
		if hasChoice && ch.Action == "create" && kindLabels[ch.Kind] != "" && n.depth == 0 {
			kind = ch.Kind
		}
		r.Kind = kind
		if tn := tgt.names[k]; tn != nil && !(hasChoice && ch.Action == "create") && tn.Kind == kind {
			r.Action, r.TargetID, r.TargetName = "existing", tn.ID, tn.Full
			continue
		}
		r.Action = "create"
		if hasChoice && ch.Action == "create" && strings.TrimSpace(ch.Name) != "" && !strings.Contains(ch.Name, ":") {
			n.newName = strings.TrimSpace(ch.Name)
		}
		parentFull := ""
		if n.parentKey != "" {
			pn := p.names[n.parentKey]
			parentFull = orStr(pn.row.TargetName, pn.row.Source)
			if pn.row.Kind != model.NameCustomer {
				r.Review = fmt.Sprintf("%s is a job, but %s is a %s; only customers have jobs.", r.Source, pn.row.Source, kindLabels[pn.row.Kind])
				r.Blocking = true
			}
		}
		if tn := tgt.names[normFull(strings.TrimPrefix(parentFull+":"+n.newName, ":"))]; tn != nil && n.newName == last {
			n.newName = fmt.Sprintf("%s (%s)", last, kindLabels[kind])
			r.Review = fmt.Sprintf("The %s %s already uses this name; this %s is created as \"%s\".", kindLabels[tn.Kind], tn.Full, kindLabels[kind], n.newName)
		}
		r.TargetName = strings.TrimPrefix(parentFull+":"+n.newName, ":")
		if n.src == nil && r.Review == "" {
			r.Review = fmt.Sprintf("This name is not in the name lists of the file. It will be created as a %s.", kindLabels[kind])
		}
	}
}

func (p *plan) resolveItems() {
	tgt := p.tgt
	for _, k := range sortedKeys(p.items, func(it *pItem) int { return it.depth }) {
		it := p.items[k]
		r := &it.row
		parts := splitFull(r.Source)
		last := parts[len(parts)-1]
		it.newName = last
		typ := ""
		if it.src != nil {
			r.Line, r.SourceType = it.src.Line, it.src.RawType
			typ = it.src.Type
		}
		ch, hasChoice := p.opt.Items[r.Source]
		if hasChoice {
			switch ch.Action {
			case "map":
				if ti := tgt.itemByID[ch.TargetID]; ti != nil {
					r.Action, r.TargetID, r.TargetName, r.Type = "map", ti.ID, ti.Full, ti.Type
					continue
				}
				r.Action, r.Review, r.Blocking = "map", "Choose the item of this company to use.", true
				continue
			case "none":
				r.Action, r.Type = "none", ""
				r.Review = "Not created: lines with this item post to their account without an item."
				continue
			case "use":
				if t := p.items[normFull(ch.Source)]; t != nil && t != it {
					it.alias, r.Action, r.UseSource = t.key, "use", t.row.Source
					continue
				}
				r.Action, r.Review, r.Blocking = "use", sameAsMissing("item", ch.Source), true
				continue
			case "create":
				if itemTypeRank(ch.Type) {
					typ = ch.Type
				}
			}
		}
		if typ == model.ItemGroup || typ == model.ItemSalesTaxGroup {
			r.Action, r.Type = "none", typ
			r.Review = "Groups are not imported because the file does not list their member items. Lines that use this group post to their account; re-create the group in the Item List."
			continue
		}
		if ti := tgt.items[k]; ti != nil && !(hasChoice && ch.Action == "create") && (typ == "" || ti.Type == typ) {
			r.Action, r.TargetID, r.TargetName, r.Type = "existing", ti.ID, ti.Full, ti.Type
			continue
		}
		r.Action = "create"
		r.Type = typ
		if typ == "" {
			if it.src != nil {
				r.Review = fmt.Sprintf("The item type %q of the QuickBooks® file is not known. Choose the type it gets, or import its lines without an item.", it.src.RawType)
				r.Blocking = true
			} else {
				r.Type = model.ItemService
				if it.salesAcct == "" {
					r.Type = model.ItemNonInventory
				}
				r.Review = fmt.Sprintf("This item is not in the item list of the file. It will be created as a %s item.", r.Type)
			}
		}
		parentFull := ""
		if it.parentKey != "" {
			pi := p.items[it.parentKey]
			parentFull = orStr(pi.row.TargetName, pi.row.Source)
			if pi.row.Type != "" && r.Type != "" && pi.row.Type != r.Type {
				if pi.src == nil && pi.row.Action == "create" {
					pi.row.Type = r.Type
				} else {
					r.Review = fmt.Sprintf("Its parent item %s is a %s item, but a subitem must have the same type as its parent.", pi.row.Source, pi.row.Type)
					r.Blocking = true
				}
			}
		}
		if ti := tgt.items[normFull(strings.TrimPrefix(parentFull+":"+it.newName, ":"))]; ti != nil {
			it.newName = fmt.Sprintf("%s (%s)", last, r.Type)
			r.Review = fmt.Sprintf("An item named %s already exists as %s; this one is created as \"%s\".", ti.Full, ti.Type, it.newName)
		}
		r.TargetName = strings.TrimPrefix(parentFull+":"+it.newName, ":")
	}
}

func itemTypeRank(t string) bool {
	for _, x := range model.ItemTypeOrder {
		if x == t {
			return true
		}
	}
	return false
}

// blocking returns the review rows that need a choice before importing.
func (p *plan) blocking() []Problem {
	var out []Problem
	for _, a := range p.accts {
		if a.row.Blocking {
			out = append(out, Problem{File: "iif", Line: a.row.Line, Level: levelError, Message: fmt.Sprintf("Account %s: %s", a.row.Source, a.row.Review)})
		}
	}
	for _, n := range p.names {
		if n.row.Blocking {
			out = append(out, Problem{File: "iif", Line: n.row.Line, Level: levelError, Message: fmt.Sprintf("Name %s: %s", n.row.Source, n.row.Review)})
		}
	}
	for _, it := range p.items {
		if it.row.Blocking {
			out = append(out, Problem{File: "iif", Line: it.row.Line, Level: levelError, Message: fmt.Sprintf("Item %s: %s", it.row.Source, it.row.Review)})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Line < out[j].Line })
	return out
}

// rows returns the mapping review rows, sorted by name.
func (p *plan) rows() ([]AccountRow, []NameRow, []ItemRow) {
	var as []AccountRow
	for _, a := range p.accts {
		as = append(as, a.row)
	}
	sort.Slice(as, func(i, j int) bool { return strings.ToLower(as[i].Source) < strings.ToLower(as[j].Source) })
	var ns []NameRow
	for _, n := range p.names {
		ns = append(ns, n.row)
	}
	sort.Slice(ns, func(i, j int) bool { return strings.ToLower(ns[i].Source) < strings.ToLower(ns[j].Source) })
	var is []ItemRow
	for _, it := range p.items {
		is = append(is, it.row)
	}
	sort.Slice(is, func(i, j int) bool { return strings.ToLower(is[i].Source) < strings.ToLower(is[j].Source) })
	return as, ns, is
}

// ---------------------------------------------------------------------------
// Terms named but not listed: "Net 30", "2% 10 Net 30", "Due on receipt"

var (
	termsDisc = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)\s*%\s*(\d+)\D+net\s*(\d+)`)
	termsNet  = regexp.MustCompile(`(?i)net\s*(\d+)`)
)

func termsFromName(name string) map[string]any {
	if m := termsDisc.FindStringSubmatch(name); m != nil {
		pct, _ := strconv.ParseFloat(m[1], 64)
		dd, _ := strconv.Atoi(m[2])
		nd, _ := strconv.Atoi(m[3])
		return map[string]any{"dateDriven": false, "netDays": nd, "discountPct": pct, "discountDays": dd}
	}
	if m := termsNet.FindStringSubmatch(name); m != nil {
		nd, _ := strconv.Atoi(m[1])
		return map[string]any{"dateDriven": false, "netDays": nd, "discountPct": 0, "discountDays": 0}
	}
	return map[string]any{"dateDriven": false, "netDays": 0, "discountPct": 0, "discountDays": 0}
}

var _ = sql.ErrNoRows

// sameAsMissing explains a "same as" choice that names no other entry of the files.
func sameAsMissing(what, source string) string {
	if strings.TrimSpace(source) == "" {
		return "Type the name of the " + what + " in the files this one is the same as."
	}
	return fmt.Sprintf("There is no other %s named \"%s\" in the files. Type the name as it is in the QuickBooks® file.", what, strings.TrimSpace(source))
}
