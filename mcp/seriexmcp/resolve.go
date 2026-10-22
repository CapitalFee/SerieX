package seriexmcp

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

func (b *call) allAccounts() ([]account, error) {
	if b.accounts == nil {
		if err := b.get("/accounts", url.Values{"active": {"all"}}, &b.accounts); err != nil {
			return nil, err
		}
	}
	return b.accounts, nil
}

func (b *call) allNames() ([]name, error) {
	if b.names == nil {
		if err := b.get("/names", url.Values{"active": {"all"}}, &b.names); err != nil {
			return nil, err
		}
	}
	return b.names, nil
}

func (b *call) allItems() ([]item, error) {
	if b.items == nil {
		if err := b.get("/items", url.Values{"active": {"all"}}, &b.items); err != nil {
			return nil, err
		}
	}
	return b.items, nil
}

func (b *call) list(l string) ([]listEntry, error) {
	if _, ok := b.lists[l]; !ok {
		var out []listEntry
		if err := b.get("/lists/"+l, url.Values{"active": {"all"}}, &out); err != nil {
			return nil, err
		}
		b.lists[l] = out
	}
	return b.lists[l], nil
}

func (b *call) preferences() (*prefs, error) {
	if b.prefs == nil {
		var p prefs
		if err := b.get("/prefs", nil, &p); err != nil {
			return nil, err
		}
		b.prefs = &p
	}
	return b.prefs, nil
}

// ---------------------------------------------------------------------------
// Names to ids. An exact match is used; otherwise the candidates are listed
// so the assistant can ask the user.

func norm(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

// normPath also ignores spaces around ":" ("Parent : Child" = "Parent:Child").
func normPath(s string) string {
	parts := strings.Split(s, ":")
	for i, p := range parts {
		parts[i] = norm(p)
	}
	return strings.Join(parts, ":")
}

// pick chooses one candidate of a lookup or explains why it cannot.
func pick[T any](what, input string, all []T, label func(T) string, steps ...func(T) bool) (T, error) {
	var zero T
	for _, step := range steps {
		var found []T
		for _, x := range all {
			if step(x) {
				found = append(found, x)
			}
		}
		switch len(found) {
		case 0:
			continue
		case 1:
			return found[0], nil
		default:
			var opts []string
			for i, x := range found {
				if i == 10 {
					break
				}
				opts = append(opts, label(x))
			}
			return zero, userErr("%q matches several %ss: %s. Ask the user which one and pass its full name exactly.", input, what, strings.Join(opts, "; "))
		}
	}
	n := norm(input)
	var cands []string
	for _, x := range all {
		if l := label(x); n != "" && strings.Contains(strings.ToLower(l), n) {
			cands = append(cands, l)
			if len(cands) == 10 {
				break
			}
		}
	}
	if len(cands) == 0 {
		// try each word
		for _, x := range all {
			l := strings.ToLower(label(x))
			for _, w := range strings.Fields(n) {
				if len(w) >= 3 && strings.Contains(l, w) {
					cands = append(cands, label(x))
					break
				}
			}
			if len(cands) == 10 {
				break
			}
		}
	}
	if len(cands) == 0 {
		// try the first letters of each word (typing mistakes)
		for _, x := range all {
			l := strings.ToLower(label(x))
			for _, w := range strings.Fields(n) {
				if len([]rune(w)) >= 4 && strings.Contains(l, string([]rune(w)[:3])) {
					cands = append(cands, label(x))
					break
				}
			}
			if len(cands) == 10 {
				break
			}
		}
	}
	if len(cands) == 0 {
		return zero, userErr("No %s named %q was found in this company file.", what, input)
	}
	return zero, userErr("No %s is named exactly %q. Similar: %s. Ask the user which one they mean (or whether to create a new one), then pass the full name exactly.", what, input, strings.Join(cands, "; "))
}

func idOf(s string) int64 {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

func accountLabel(x account) string {
	l := x.FullName
	if x.Number != "" {
		l = x.Number + " " + l
	}
	l += " (" + x.Type
	if !x.Active {
		l += ", inactive"
	}
	return l + ")"
}

// findAccount finds an account by full name ("Parent:Child"), name, number
// ("10000"), number and name ("10000 Checking", "10000 · Checking") or id.
// types limits the account types allowed (none = any).
func (b *call) findAccount(input string, types ...string) (*account, error) {
	all, err := b.allAccounts()
	if err != nil {
		return nil, err
	}
	var pool []account
	for _, x := range all {
		if len(types) == 0 || containsStr(types, x.Type) {
			pool = append(pool, x)
		}
	}
	what := "account"
	if len(types) > 0 {
		what = strings.Join(types, " or ") + " account"
	}
	n := normPath(input)
	id := idOf(input)
	x, err := pick(what, input, pool, accountLabel,
		func(x account) bool { return normPath(x.FullName) == n },
		func(x account) bool { return x.Number != "" && norm(x.Number) == n },
		func(x account) bool {
			if x.Number == "" {
				return false
			}
			for _, sep := range []string{" · ", " - ", " "} {
				if normPath(x.Number+sep+x.FullName) == n || normPath(x.Number+sep+x.Name) == n {
					return true
				}
			}
			return false
		},
		func(x account) bool { return norm(x.Name) == n },
		func(x account) bool { return id != 0 && x.ID == id },
	)
	if err != nil {
		if len(types) > 0 {
			// say so when the account exists but has another type
			for _, y := range all {
				if normPath(y.FullName) == n || (y.Number != "" && norm(y.Number) == n) {
					return nil, userErr("%s is %s %s account; here %s %s is needed.", y.FullName, article(y.Type), y.Type, article(what), what)
				}
			}
		}
		return nil, err
	}
	return &x, nil
}

func (b *call) accountName(id *int64) string {
	if id == nil {
		return ""
	}
	all, err := b.allAccounts()
	if err != nil {
		return fmt.Sprintf("account %d", *id)
	}
	for _, x := range all {
		if x.ID == *id {
			return x.FullName
		}
	}
	return fmt.Sprintf("account %d", *id)
}

func nameLabel(x name) string {
	l := x.FullName + " (" + x.Kind
	if !x.Active {
		l += ", inactive"
	}
	return l + ")"
}

var kindWords = map[string]string{"customer": "customer or job", "vendor": "vendor", "other": "other name"}

// findName finds a customer (or job "Customer:Job"), vendor or other name.
// kinds limits the kinds allowed (none = any).
func (b *call) findName(input string, kinds ...string) (*name, error) {
	all, err := b.allNames()
	if err != nil {
		return nil, err
	}
	var pool []name
	for _, x := range all {
		if len(kinds) == 0 || containsStr(kinds, x.Kind) {
			pool = append(pool, x)
		}
	}
	what := "name"
	if len(kinds) == 1 {
		what = kindWords[kinds[0]]
	}
	n := normPath(input)
	id := idOf(input)
	x, err := pick(what, input, pool, nameLabel,
		func(x name) bool { return normPath(x.FullName) == n },
		func(x name) bool { return norm(x.Name) == n },
		func(x name) bool { return x.CompanyName != "" && norm(x.CompanyName) == n && x.ParentID == nil },
		func(x name) bool { return id != 0 && x.ID == id },
	)
	if err != nil {
		if len(kinds) > 0 {
			for _, y := range all {
				if normPath(y.FullName) == n {
					return nil, userErr("%s is %s %s, not %s %s.", y.FullName, article(kindWords[y.Kind]), kindWords[y.Kind], article(what), what)
				}
			}
		}
		return nil, err
	}
	return &x, nil
}

func (b *call) nameByID(id int64) *name {
	all, _ := b.allNames()
	for i := range all {
		if all[i].ID == id {
			return &all[i]
		}
	}
	return nil
}

// nameChain is the name and its parents (job, customer).
func (b *call) nameChain(n *name) []*name {
	chain := []*name{n}
	cur := n
	for i := 0; i < 10 && cur.ParentID != nil; i++ {
		p := b.nameByID(*cur.ParentID)
		if p == nil {
			break
		}
		chain = append(chain, p)
		cur = p
	}
	return chain
}

func itemLabel(x item) string {
	l := x.FullName + " (" + x.Type
	if !x.Active {
		l += ", inactive"
	}
	return l + ")"
}

// findItem finds an item by full name ("Parent:Sub"), name or id.
func (b *call) findItem(input string, types ...string) (*item, error) {
	all, err := b.allItems()
	if err != nil {
		return nil, err
	}
	var pool []item
	for _, x := range all {
		if len(types) == 0 || containsStr(types, x.Type) {
			pool = append(pool, x)
		}
	}
	n := normPath(input)
	id := idOf(input)
	x, err := pick("item", input, pool, itemLabel,
		func(x item) bool { return normPath(x.FullName) == n },
		func(x item) bool { return norm(x.Name) == n },
		func(x item) bool { return id != 0 && x.ID == id },
	)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func (b *call) itemByID(id *int64) *item {
	if id == nil {
		return nil
	}
	all, _ := b.allItems()
	for i := range all {
		if all[i].ID == *id {
			return &all[i]
		}
	}
	return nil
}

var listWords = map[string]string{"terms": "terms", "payment_method": "payment method", "class": "class"}

// findEntry finds an entry of a simple list (terms, payment_method, class).
func (b *call) findEntry(list, input string) (*listEntry, error) {
	all, err := b.list(list)
	if err != nil {
		return nil, err
	}
	n := normPath(input)
	x, err := pick(listWords[list], input, all, func(x listEntry) string { return x.FullName },
		func(x listEntry) bool { return normPath(x.FullName) == n },
		func(x listEntry) bool { return norm(x.Name) == n },
	)
	if err != nil {
		return nil, err
	}
	return &x, nil
}

func (b *call) entryName(list string, id *int64) string {
	if id == nil {
		return ""
	}
	all, _ := b.list(list)
	for _, x := range all {
		if x.ID == *id {
			return x.FullName
		}
	}
	return ""
}

func ptr[T any](v T) *T { return &v }

// article is "an" before a word starting with a vowel, else "a".
func article(word string) string {
	if w := strings.ToLower(strings.TrimSpace(word)); w != "" && strings.ContainsRune("aeiou", rune(w[0])) {
		return "an"
	}
	return "a"
}
