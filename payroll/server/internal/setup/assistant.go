package setup

import (
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
)

// AI assistants reach payroll through the MCP endpoint of SerieX Books. They
// send a SerieX Books session token in the header X-Books-Session (never a
// password, never in the address). Payroll asks Books who the token belongs
// to, applies the usual payroll access rule (Books administrators and the
// users in the payroll access list) and gives the request a read-only
// session: only GET, and never full social security or bank account numbers.

const assistantTTL = 60 * time.Second

type assistantUser struct {
	user    string
	isAdmin bool
	at      time.Time
}

var (
	assistMu    sync.Mutex
	assistCache = map[string]assistantUser{} // company id + "\x00" + Books token -> user
)

// Routes an AI assistant may never call, even with GET: they return full
// social security numbers (the employee SSN route, the W-2 electronic file).
var assistantBlocked = regexp.MustCompile(`^/api/c/[^/]+/(employees/[^/]+/ssn|forms/w2/efw2)/?$`)

func assistantSession(r *http.Request, companyID, tok string) (*httpx.Session, error) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return nil, apperr.Forbidden("AI assistant access to SerieX Payroll is read-only.")
	}
	if assistantBlocked.MatchString(r.URL.Path) || revealAsked(r) {
		return nil, apperr.Forbidden("AI assistants cannot see full social security numbers.")
	}
	u, err := assistantUserFor(r, companyID, tok)
	if err != nil {
		return nil, err
	}
	return &httpx.Session{User: u.user, BooksToken: tok, IsAdmin: u.isAdmin, Assistant: true}, nil
}

// revealAsked: any form of the reveal parameter (?reveal=1, true, yes...).
func revealAsked(r *http.Request) bool {
	for k, v := range r.URL.Query() {
		if strings.EqualFold(k, "reveal") {
			for _, x := range v {
				if x != "" && x != "0" && !strings.EqualFold(x, "false") && !strings.EqualFold(x, "no") {
					return true
				}
			}
		}
	}
	return false
}

func assistantUserFor(r *http.Request, companyID, tok string) (assistantUser, error) {
	key := companyID + "\x00" + tok
	assistMu.Lock()
	u, ok := assistCache[key]
	if ok && time.Since(u.at) > assistantTTL {
		delete(assistCache, key)
		ok = false
	}
	assistMu.Unlock()
	if ok {
		return u, nil
	}
	ctx := r.Context()
	info, err := books.Default.SessionInfo(ctx, books.Session{CompanyID: companyID, Token: tok, Assistant: true})
	if err != nil {
		if e := books.AsError(err); e != nil && e.Code == apperr.CodeAuth {
			return u, apperr.BooksAuth("SerieX Books: the AI assistant session is no longer valid.")
		}
		return u, books.ToAppErr(err)
	}
	if strings.TrimSpace(info.User) == "" {
		return u, apperr.BooksAuth("SerieX Books did not say which user this AI assistant session belongs to.")
	}
	u = assistantUser{user: info.User, isAdmin: info.IsAdmin, at: time.Now()}
	if !u.isAdmin {
		allowed, err := hasAccess(ctx, companyID, info.User)
		if err != nil {
			return u, err
		}
		if !allowed {
			return u, apperr.Forbidden("%s does not have access to payroll. A SerieX Books administrator can give access in Payroll User Access.", info.User)
		}
	}
	assistMu.Lock()
	for k, old := range assistCache { // drop old entries
		if time.Since(old.at) > assistantTTL {
			delete(assistCache, k)
		}
	}
	assistCache[key] = u
	assistMu.Unlock()
	return u, nil
}
