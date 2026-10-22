package banking

// Rule suggestions: bank rules proposed from how transactions were
// classified. When the same kind of bank or credit card transaction (same
// payee, or the same bank text) was classified the same way several times and
// no rule covers it yet, a rule that does the same is suggested. Used by Bank
// Rules (GET /bank-rules/suggestions) and by the import of QuickBooks®
// Desktop files.
//
// The text a rule matches is taken, in order, from the descriptions of the
// downloaded bank transactions behind the pattern, from their memos, or from
// the payee's name (the bank may print that differently, so those are only
// medium confidence). A text is used only when it covers the pattern and does
// not also match many transactions classified another way.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// RuleSuggestion is a bank rule suggested by a pattern of classified transactions.
type RuleSuggestion struct {
	Key         string         `json:"key"`         // stable id: direction|match text
	Rule        model.BankRule `json:"rule"`        // the rule to create (id 0)
	Payee       string         `json:"payee"`       // full name of Rule.NameID
	Category    string         `json:"category"`    // full name of Rule.TargetAccountID
	AccountName string         `json:"accountName"` // bank or credit card account of Rule.AccountID ("" = all)
	MatchFrom   string         `json:"matchFrom"`   // where the text comes from: "bank" | "memo" | "name"
	Count       int            `json:"count"`       // transactions in the pattern
	Matching    int            `json:"matching"`    // of them, classified as Category
	Total       float64        `json:"total"`       // their amount
	First       string         `json:"first"`       // date of the first one
	Last        string         `json:"last"`        // date of the last one
	Confidence  string         `json:"confidence"`  // "high" | "medium"
	Reason      string         `json:"reason"`      // plain explanation
	Others      []RuleOther    `json:"others"`      // other categories used in the pattern
	Examples    []RuleExample  `json:"examples"`    // the latest transactions of the pattern
}

// RuleOther is another category used in a pattern.
type RuleOther struct {
	Category string `json:"category"`
	Count    int    `json:"count"`
}

// RuleExample is one transaction of a pattern.
type RuleExample struct {
	TxnID  int64   `json:"txnId"`
	Date   string  `json:"date"`
	Amount float64 `json:"amount"`
	Text   string  `json:"text"` // bank description, memo or payee
}

// SuggestOptions tune SuggestRules (zero values use the defaults).
type SuggestOptions struct {
	MinCount  int     // transactions a pattern needs (default 3)
	MinShare  float64 // share of them classified the same way (default 0.8)
	Limit     int     // suggestions returned at most (default 50)
	Dismissed bool    // include suggestions the user dismissed
}

const dismissedMeta = "bank_rule_suggestions_dismissed"

// evidence is one bank or credit card transaction and how it was classified.
type evidence struct {
	id               int64
	date, memo, desc string // desc: description of the downloaded item that became it or was matched to it
	nameID           int64
	bank             int64
	dir              string // "in" | "out"
	amount           int64
	acct             int64  // the account it went to (0: split over several)
	ndesc, nmemo     string // desc and memo, lower case with single spaces
}

// genericWords are bank description words that say nothing about who was paid.
var genericWords = map[string]bool{}

func init() {
	for _, w := range strings.Fields(`pos purchase purchases debit credit card checkcard check chk ach online payment payments pmt pymt
		transfer xfer withdrawal withdrawl deposit recurring visa mastercard dbt preauthorized authorized external electronic web
		ppd ccd dda the inc llc llp pllc co corp corporation ltd company from for and of on in at www com net org bill billpay
		autopay auto pay ref trn txn transaction mobile id memo des indn web-pmts paypal* sq* tst*`) {
		genericWords[w] = true
	}
}

// legalSuffixes are left out of the text of a rule made from a payee name.
var legalSuffixes = map[string]bool{"llc": true, "inc": true, "co": true, "corp": true, "corporation": true, "ltd": true,
	"company": true, "llp": true, "pllc": true, "pc": true, "lp": true}

func cleanToken(t string) string {
	return strings.TrimFunc(strings.ToLower(t), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}

// meaningful: a word that can identify a payee (letters, no digits, not generic).
func meaningful(t string) bool {
	c := cleanToken(t)
	if len([]rune(c)) < 3 || genericWords[c] {
		return false
	}
	hasLetter := false
	for _, r := range c {
		if unicode.IsDigit(r) {
			return false
		}
		if unicode.IsLetter(r) {
			hasLetter = true
		}
	}
	return hasLetter
}

func norm(s string) string { return strings.ToLower(collapseSpaces(s)) }

// commonText returns the text most of texts share (the words found in at
// least 80% of them, as they read in the first text that has them all), or "".
func commonText(texts []string) string {
	if len(texts) < 2 {
		return ""
	}
	in := map[string]int{}
	for _, t := range texts {
		seen := map[string]bool{}
		for _, w := range strings.Fields(t) {
			if c := cleanToken(w); meaningful(w) && !seen[c] {
				seen[c] = true
				in[c]++
			}
		}
	}
	shared := map[string]bool{}
	for w, n := range in {
		if float64(n) >= 0.8*float64(len(texts)) {
			shared[w] = true
		}
	}
	if len(shared) == 0 {
		return ""
	}
	cover := func(cand string) bool {
		n := 0
		for _, t := range texts {
			if strings.Contains(norm(t), norm(cand)) {
				n++
			}
		}
		return float64(n) >= 0.8*float64(len(texts))
	}
	trim := func(s string) string {
		return strings.TrimFunc(s, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '&' })
	}
	// runs of consecutive shared words in the first text that has one; the
	// longest run (then the first) that every text has wins: "SHELL OIL" in
	// "CHECKCARD 0310 SHELL OIL 57444 AUSTIN TX", not the town
	for _, t := range texts {
		words := strings.Fields(t)
		var runs [][2]int
		for i := 0; i < len(words); {
			if !shared[cleanToken(words[i])] {
				i++
				continue
			}
			j := i
			for j+1 < len(words) && shared[cleanToken(words[j+1])] {
				j++
			}
			runs = append(runs, [2]int{i, j})
			i = j + 1
		}
		if len(runs) == 0 {
			continue
		}
		sort.SliceStable(runs, func(a, b int) bool { return runs[a][1]-runs[a][0] > runs[b][1]-runs[b][0] })
		for _, r := range runs {
			lo, hi := r[0], r[1]
			cand := trim(strings.Join(words[lo:hi+1], " "))
			if len([]rune(cand)) > 40 || !cover(cand) {
				continue
			}
			// take in the generic words that follow while every text has them ("PGE" -> "PGE WEB ONLINE")
			for hi+1 < len(words) && genericWords[cleanToken(words[hi+1])] && !strings.ContainsAny(words[hi+1], "0123456789") {
				next := trim(strings.Join(words[lo:hi+2], " "))
				if len([]rune(next)) > 40 || !coverAll(texts, next) {
					break
				}
				cand, hi = next, hi+1
			}
			return cand
		}
		break
	}
	// else the longest shared word
	var best string
	for w := range shared {
		if len(w) > len(best) || (len(w) == len(best) && w < best) {
			best = w
		}
	}
	if len(best) >= 4 && cover(best) {
		return strings.ToUpper(best)
	}
	return ""
}

// coverAll: every text contains cand.
func coverAll(texts []string, cand string) bool {
	for _, t := range texts {
		if !strings.Contains(norm(t), norm(cand)) {
			return false
		}
	}
	return true
}

// bankLike: a memo that reads like a bank description (mostly capital
// letters, as banks print them) rather than a note someone typed.
func bankLike(s string) bool {
	up, letters := 0, 0
	for _, r := range s {
		if unicode.IsLetter(r) {
			letters++
			if unicode.IsUpper(r) {
				up++
			}
		}
	}
	return letters >= 3 && float64(up) >= 0.8*float64(letters)
}

// nameText is the text of a rule made from a payee name: the customer of a
// job, without legal suffixes ("Pacific Gas & Electric Co." -> "Pacific Gas & Electric").
func nameText(full string) string {
	name := strings.TrimSpace(strings.Split(full, ":")[0])
	words := strings.Fields(strings.ReplaceAll(name, ",", " "))
	for len(words) > 1 && legalSuffixes[cleanToken(words[len(words)-1])] {
		words = words[:len(words)-1]
	}
	if len(words) > 1 && strings.EqualFold(words[0], "the") {
		words = words[1:]
	}
	out := strings.TrimRight(strings.Join(words, " "), ".,")
	if len([]rune(out)) < 3 {
		return ""
	}
	return out
}

// loadEvidence reads the bank and credit card transactions (checks, credit
// card charges and credits, deposits) and the account each went to.
func loadEvidence(ctx context.Context, q store.Q) ([]*evidence, map[int64]acctInfo, error) {
	accts := map[int64]acctInfo{}
	full, err := store.FullNames(ctx, q, "accounts")
	if err != nil {
		return nil, nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT id, type, special FROM accounts`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var a acctInfo
		if err := rows.Scan(&a.id, &a.typ, &a.special); err != nil {
			rows.Close()
			return nil, nil, err
		}
		a.name = full[a.id]
		accts[a.id] = a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT t.id, t.type, t.date, t.memo, IFNULL(t.name_id, 0), t.account_id, t.amount,
			IFNULL((SELECT f.description FROM bank_feed_items f WHERE f.txn_id = t.id AND f.status IN ('added', 'matched') ORDER BY f.id DESC LIMIT 1), '')
		FROM txns t JOIN accounts a ON a.id = t.account_id
		WHERE t.voided = 0 AND t.is_pending = 0 AND t.type IN ('CHK', 'CCCHARGE', 'CCCREDIT', 'DEP')
		  AND a.type IN ('Bank', 'Credit Card') AND t.amount <> 0
		  AND IFNULL(json_extract(t.extra, '$.openingBalance'), 0) = 0
		ORDER BY t.date, t.id`)
	if err != nil {
		return nil, nil, err
	}
	byID := map[int64]*evidence{}
	var out []*evidence
	for rows.Next() {
		e := &evidence{}
		var typ string
		if err := rows.Scan(&e.id, &typ, &e.date, &e.memo, &e.nameID, &e.bank, &e.amount, &e.desc); err != nil {
			rows.Close()
			return nil, nil, err
		}
		e.ndesc, e.nmemo = norm(e.desc), norm(e.memo)
		e.dir = "out"
		if typ == model.TxDeposit || typ == model.TxCCCredit {
			e.dir = "in"
		}
		byID[e.id] = e
		out = append(out, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	// what each one went to: its ledger entries other than the bank side and cash back
	type split struct {
		total int64
		by    map[int64]int64
		names map[int64]bool
	}
	splits := map[int64]*split{}
	rows, err = q.QueryContext(ctx, `SELECT g.txn_id, g.account_id, IFNULL(g.name_id, 0), ABS(g.amount) FROM gl_entries g JOIN txns t ON t.id = g.txn_id
		WHERE t.voided = 0 AND t.type IN ('CHK', 'CCCHARGE', 'CCCREDIT', 'DEP') AND g.role NOT IN ('header', 'cashback')`)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var txn, acct, name, amt int64
		if err := rows.Scan(&txn, &acct, &name, &amt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		if byID[txn] == nil {
			continue
		}
		s := splits[txn]
		if s == nil {
			s = &split{by: map[int64]int64{}, names: map[int64]bool{}}
			splits[txn] = s
		}
		s.total += amt
		s.by[acct] += amt
		s.names[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var kept []*evidence
	for _, e := range out {
		s := splits[e.id]
		if s == nil || s.total == 0 {
			continue
		}
		var best, bestAmt int64
		for a, amt := range s.by {
			if amt > bestAmt || (amt == bestAmt && a < best) {
				best, bestAmt = a, amt
			}
		}
		a := accts[best]
		// payments waiting in Undeposited Funds, invoices and bills are matched in
		// Bank Imports another way: they are not rule patterns
		if a.typ == model.AcctAR || a.typ == model.AcctAP || a.typ == model.AcctNonPosting || a.special == store.SpecialUndepositedFunds || best == e.bank {
			continue
		}
		if float64(bestAmt) >= 0.9*float64(s.total) {
			e.acct = best
		}
		if e.nameID == 0 && len(s.names) == 1 {
			for n := range s.names {
				e.nameID = n // a deposit's received-from name
			}
		}
		kept = append(kept, e)
	}
	return kept, accts, nil
}

type acctInfo struct {
	id                 int64
	typ, special, name string
}

// SuggestRules returns the bank rules suggested by the transactions of the
// company file, most convincing first.
func SuggestRules(ctx context.Context, q store.Q, opt SuggestOptions) ([]RuleSuggestion, error) {
	if opt.MinCount <= 0 {
		opt.MinCount = 3
	}
	if opt.MinShare <= 0 {
		opt.MinShare = 0.8
	}
	if opt.Limit <= 0 {
		opt.Limit = 50
	}
	ev, accts, err := loadEvidence(ctx, q)
	if err != nil {
		return nil, err
	}
	rules, err := loadRules(ctx, q, "")
	if err != nil {
		return nil, err
	}
	dismissed := map[string]bool{}
	if !opt.Dismissed {
		for _, k := range loadDismissed(ctx, q) {
			dismissed[k] = true
		}
	}
	names, err := store.FullNames(ctx, q, "names")
	if err != nil {
		return nil, err
	}

	// patterns: the same payee, else the same bank text, else the same memo
	groups := map[string][]*evidence{}
	var order []string
	add := func(k string, e *evidence) {
		if _, ok := groups[k]; !ok {
			order = append(order, k)
		}
		groups[k] = append(groups[k], e)
	}
	for _, e := range ev {
		switch {
		case e.nameID != 0:
			add(fmt.Sprintf("n|%s|%d", e.dir, e.nameID), e)
		case stem(e.desc) != "":
			add("d|"+e.dir+"|"+stem(e.desc), e)
		case stem(e.memo) != "":
			add("m|"+e.dir+"|"+stem(e.memo), e)
		}
	}

	byKey := map[string]RuleSuggestion{}
	for _, gk := range order {
		g := groups[gk]
		if len(g) < opt.MinCount {
			continue
		}
		dates := map[string]bool{}
		months := map[string]bool{}
		count := map[int64]int{}
		banks := map[int64]bool{}
		payees := map[int64]int{}
		var total int64
		for _, e := range g {
			dates[e.date] = true
			months[e.date[:7]] = true
			count[e.acct]++
			banks[e.bank] = true
			payees[e.nameID]++
			total += e.amount
		}
		if len(dates) < 2 {
			continue
		}
		var target int64
		for a, n := range count {
			if a != 0 && (n > count[target] || target == 0 || (n == count[target] && a < target)) {
				target = a
			}
		}
		matching := count[target]
		share := float64(matching) / float64(len(g))
		if target == 0 || share < opt.MinShare {
			continue
		}
		var payee int64
		for n, c := range payees {
			if n != 0 && float64(c) >= 0.8*float64(len(g)) {
				payee = n
			}
		}
		// the text: bank descriptions, else memos, else the payee name
		var descs, memos []string
		for _, e := range g {
			if e.desc != "" {
				descs = append(descs, e.desc)
			}
			if bankLike(e.memo) {
				memos = append(memos, e.memo)
			}
		}
		text, from := "", ""
		if t := commonText(descs); t != "" && len(descs) >= 2 && precise(ev, t, true, g[0].dir, target, opt.MinShare) {
			text, from = t, "bank"
		} else if t := commonText(memos); t != "" && float64(len(memos)) >= 0.8*float64(len(g)) && precise(ev, t, false, g[0].dir, target, opt.MinShare) {
			text, from = t, "memo"
		} else if payee != 0 {
			if t := nameText(names[payee]); t != "" {
				text, from = t, "name"
			}
		}
		if text == "" {
			continue
		}
		var bank int64
		if len(banks) == 1 {
			for b := range banks {
				bank = b
			}
		}
		if covered(rules, g, text, payee, bank) {
			continue
		}
		key := g[0].dir + "|" + norm(text)
		if dismissed[key] {
			continue
		}
		s := RuleSuggestion{Key: key, MatchFrom: from, Count: len(g), Matching: matching, Total: store.Dollars(total),
			First: g[0].date, Last: g[len(g)-1].date, Payee: names[payee], Category: accts[target].name}
		s.Rule = model.BankRule{Name: orText(names[payee], text), MatchText: text, Direction: g[0].dir,
			NameID: store.PtrID(sql.NullInt64{Int64: payee, Valid: payee != 0}), TargetAccountID: &target}
		if bank != 0 {
			b := bank
			s.Rule.AccountID = &b
			s.AccountName = accts[bank].name
		}
		s.Confidence = "medium"
		if (from != "name" && len(g) >= 4 && share >= 0.95) || (from == "name" && len(g) >= 6 && share == 1 && len(months) >= 3) {
			s.Confidence = "high"
		}
		what := map[string]string{"out": "payments", "in": "deposits"}[g[0].dir]
		switch from {
		case "bank":
			s.Reason = fmt.Sprintf("%d of %d downloaded %s whose bank text contains \"%s\" were classified as %s.", matching, len(g), what, text, s.Category)
		case "memo":
			s.Reason = fmt.Sprintf("%d of %d %s with \"%s\" in the memo were classified as %s.", matching, len(g), what, text, s.Category)
		default:
			s.Reason = fmt.Sprintf("%d of %d %s %s %s were classified as %s.",
				matching, len(g), what, map[string]string{"out": "to", "in": "from"}[g[0].dir], s.Payee, s.Category)
		}
		for a, n := range count {
			if a != target {
				name := accts[a].name
				if a == 0 {
					name = "Split over several accounts"
				}
				s.Others = append(s.Others, RuleOther{Category: name, Count: n})
			}
		}
		sort.Slice(s.Others, func(i, j int) bool { return s.Others[i].Count > s.Others[j].Count })
		for i := len(g) - 1; i >= 0 && len(s.Examples) < 3; i-- {
			e := g[i]
			s.Examples = append(s.Examples, RuleExample{TxnID: e.id, Date: e.date, Amount: store.Dollars(e.amount), Text: orText(e.desc, orText(e.memo, names[e.nameID]))})
		}
		if old, ok := byKey[key]; !ok || s.Count > old.Count {
			byKey[key] = s
		}
	}
	out := make([]RuleSuggestion, 0, len(byKey))
	for _, s := range byKey {
		if s.Others == nil {
			s.Others = []RuleOther{}
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Confidence == "high") != (b.Confidence == "high") {
			return a.Confidence == "high"
		}
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Key < b.Key
	})
	if len(out) > opt.Limit {
		out = out[:opt.Limit]
	}
	return out, nil
}

func orText(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

// stem groups payee-less transactions: the first two words that can
// identify who was paid ("" when there are none).
func stem(s string) string {
	var ws []string
	for _, w := range strings.Fields(s) {
		if meaningful(w) {
			ws = append(ws, cleanToken(w))
			if len(ws) == 2 {
				break
			}
		}
	}
	return strings.Join(ws, " ")
}

// precise: among the transactions (same direction) whose bank text (desc) or
// memo contains text, enough went to target, so the rule would not mislead.
func precise(ev []*evidence, text string, desc bool, dir string, target int64, minShare float64) bool {
	t := norm(text)
	hits, good := 0, 0
	for _, e := range ev {
		if e.dir != dir {
			continue
		}
		src := e.nmemo
		if desc {
			src = e.ndesc
		}
		if src == "" || !strings.Contains(src, t) {
			continue
		}
		hits++
		if e.acct == target {
			good++
		}
	}
	return hits == 0 || float64(good) >= minShare*float64(hits)
}

// covered: an existing rule already handles the pattern.
func covered(rules []model.BankRule, g []*evidence, text string, payee, bank int64) bool {
	dir := g[0].dir
	for _, r := range rules {
		if r.Direction != "any" && r.Direction != dir {
			continue
		}
		if r.AccountID != nil && bank != 0 && *r.AccountID != bank {
			continue
		}
		if norm(r.MatchText) == norm(text) || (payee != 0 && r.NameID != nil && *r.NameID == payee) {
			return true
		}
		mt := norm(r.MatchText)
		if mt == "" {
			continue
		}
		n := 0
		for _, e := range g {
			if strings.Contains(e.ndesc, mt) || strings.Contains(e.nmemo, mt) {
				n++
			}
		}
		if n*2 >= len(g) {
			return true
		}
	}
	return false
}

func loadDismissed(ctx context.Context, q store.Q) []string {
	var raw string
	q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, dismissedMeta).Scan(&raw)
	var keys []string
	_ = json.Unmarshal([]byte(raw), &keys)
	return keys
}

// CreateRules validates and stores rules (an import creating the suggested
// rules the user kept). A rule without a priority comes after the others.
func CreateRules(ctx context.Context, tx *sql.Tx, rules []model.BankRule) (int, error) {
	var maxPrio int
	if err := tx.QueryRowContext(ctx, `SELECT IFNULL(MAX(priority), 0) FROM bank_rules`).Scan(&maxPrio); err != nil {
		return 0, err
	}
	n := 0
	for i := range rules {
		r := rules[i]
		if r.Priority == 0 {
			maxPrio++
			r.Priority = maxPrio
		}
		if err := validateRule(ctx, tx, &r); err != nil {
			return n, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO bank_rules(name, account_id, match_text, direction, rename_to, name_id, target_account_id, priority, created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, r.Name, store.NullID(r.AccountID), r.MatchText, r.Direction, r.RenameTo,
			store.NullID(r.NameID), store.NullID(r.TargetAccountID), r.Priority, store.Now()); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// RegisterRuleSuggestions adds:
//
//	GET  /bank-rules/suggestions          -> {suggestions: RuleSuggestion[]}
//	POST /bank-rules/suggestions/dismiss  {key} -> 204 (not suggested again)
func RegisterRuleSuggestions(rt *httpx.Router) {
	rt.C("GET", "/bank-rules/suggestions", func(c *httpx.Ctx) error {
		out, err := SuggestRules(c.Context(), c.DB, SuggestOptions{})
		if err != nil {
			return err
		}
		return c.JSON(map[string]any{"suggestions": out})
	})
	rt.C("POST", "/bank-rules/suggestions/dismiss", func(c *httpx.Ctx) error {
		var body struct {
			Key string `json:"key"`
		}
		if err := c.Decode(&body); err != nil {
			return err
		}
		body.Key = strings.TrimSpace(body.Key)
		if body.Key == "" {
			return apperr.Validation("key", "Choose the suggestion to dismiss.")
		}
		err := c.Write(func(tx *sql.Tx) error {
			keys := loadDismissed(c.Context(), tx)
			for _, k := range keys {
				if k == body.Key {
					return nil
				}
			}
			raw, _ := json.Marshal(append(keys, body.Key))
			_, err := tx.ExecContext(c.Context(), `INSERT INTO meta(key, value) VALUES(?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`, dismissedMeta, string(raw))
			return err
		})
		if err != nil {
			return err
		}
		return c.NoContent()
	})
}
