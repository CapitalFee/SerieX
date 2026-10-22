package posting

import (
	"context"
	"sync"
	"time"

	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
)

const (
	lookupTTL     = 30 * time.Second
	lookupFailTTL = 5 * time.Second // retry an unreachable Books server sooner
	lookupTimeout = 15 * time.Second
)

type lookupEntry struct {
	lk      *Lookups
	expires time.Time
}

var (
	lookupMu    sync.Mutex
	lookupCache = map[string]map[string]*lookupEntry{} // company id -> Books token -> entry
	loadLocks   sync.Map                               // company id -> *sync.Mutex (one load at a time)
)

func emptyLookups() *Lookups {
	return &Lookups{
		Accounts: map[int64]books.Account{},
		Vendors:  map[int64]books.Name{},
		Others:   map[int64]books.Name{},
		Jobs:     map[int64]books.Name{},
		Classes:  map[int64]books.ListEntry{},
	}
}

func cachedLookup(companyID, token string) *Lookups {
	lookupMu.Lock()
	defer lookupMu.Unlock()
	if m := lookupCache[companyID]; m != nil {
		if e := m[token]; e != nil && time.Now().Before(e.expires) {
			return e.lk
		}
	}
	return nil
}

func lookup(c *httpx.Ctx) *Lookups {
	if lk := cachedLookup(c.CompanyID, c.BooksToken); lk != nil {
		return lk
	}
	l, _ := loadLocks.LoadOrStore(c.CompanyID, &sync.Mutex{})
	mu := l.(*sync.Mutex)
	mu.Lock()
	defer mu.Unlock()
	if lk := cachedLookup(c.CompanyID, c.BooksToken); lk != nil {
		return lk
	}
	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()
	lk := loadLookups(ctx, books.S(c))
	ttl := lookupTTL
	if !lk.OK {
		ttl = lookupFailTTL
	}
	lookupMu.Lock()
	m := lookupCache[c.CompanyID]
	if m == nil {
		m = map[string]*lookupEntry{}
		lookupCache[c.CompanyID] = m
	}
	now := time.Now()
	for tok, e := range m { // entries of old Books sessions are never read again
		if now.After(e.expires) {
			delete(m, tok)
		}
	}
	m[c.BooksToken] = &lookupEntry{lk: lk, expires: now.Add(ttl)}
	lookupMu.Unlock()
	return lk
}

func loadLookups(ctx context.Context, s books.Session) *Lookups {
	cl := books.Default
	lk := emptyLookups()
	accts, err := cl.Accounts(ctx, s)
	if err != nil {
		return lk
	}
	names, err := cl.Names(ctx, s, "")
	if err != nil {
		return lk
	}
	classes, err := cl.List(ctx, s, "class")
	if err != nil {
		return lk
	}
	for _, a := range accts {
		lk.Accounts[a.ID] = a
	}
	for _, n := range names {
		switch n.Kind {
		case books.NameVendor:
			lk.Vendors[n.ID] = n
		case books.NameOther:
			lk.Others[n.ID] = n
		case books.NameCustomer:
			lk.Jobs[n.ID] = n
		}
	}
	for _, e := range classes {
		lk.Classes[e.ID] = e
	}
	lk.OK = true
	return lk
}

func invalidate(companyID string) {
	lookupMu.Lock()
	delete(lookupCache, companyID)
	lookupMu.Unlock()
}

// AccountName returns the Books full name of an account ("" when unknown).
func (l *Lookups) AccountName(id *int64) string {
	if l == nil || id == nil {
		return ""
	}
	return l.Accounts[*id].FullName
}

// VendorName returns the Books full name of a vendor ("" when unknown).
func (l *Lookups) VendorName(id *int64) string {
	if l == nil || id == nil {
		return ""
	}
	return l.Vendors[*id].FullName
}

// JobName returns the Books "Customer:Job" full name ("" when unknown).
func (l *Lookups) JobName(id *int64) string {
	if l == nil || id == nil {
		return ""
	}
	return l.Jobs[*id].FullName
}

// ClassName returns the Books full class name ("" when unknown).
func (l *Lookups) ClassName(id *int64) string {
	if l == nil || id == nil {
		return ""
	}
	return l.Classes[*id].FullName
}
