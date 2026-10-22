package setup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/books"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/model"
	"seriexpayroll/internal/store"
)

// Payroll sessions live in memory: token (header X-Session) -> the SerieX
// Books user signed in through payroll and the Books session token used to
// post to Books. Restarting the payroll server logs everybody out.
type session struct {
	companyID  string
	user       string
	booksToken string // "" when the Books company has no passwords
	isAdmin    bool
	lastUsed   time.Time
}

const sessionIdle = 12 * time.Hour

var (
	sessMu   sync.Mutex
	sessions = map[string]*session{}
)

func newToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func getSession(tok string) *session {
	sessMu.Lock()
	defer sessMu.Unlock()
	s := sessions[tok]
	if s == nil {
		return nil
	}
	if time.Since(s.lastUsed) > sessionIdle {
		delete(sessions, tok)
		return nil
	}
	s.lastUsed = time.Now()
	cp := *s
	return &cp
}

func addSession(s *session) string {
	tok := newToken()
	s.lastUsed = time.Now()
	sessMu.Lock()
	for t, old := range sessions { // sessions nobody used for 12 hours
		if time.Since(old.lastUsed) > sessionIdle {
			delete(sessions, t)
		}
	}
	sessions[tok] = s
	sessMu.Unlock()
	return tok
}

func dropSession(tok string) *session {
	sessMu.Lock()
	defer sessMu.Unlock()
	s := sessions[tok]
	delete(sessions, tok)
	return s
}

// dropUsersWithout logs out the non-administrators of a company that are not in keep.
func dropUsersWithout(companyID string, keep map[string]bool) []*session {
	sessMu.Lock()
	defer sessMu.Unlock()
	var out []*session
	for tok, s := range sessions {
		if s.companyID == companyID && !s.isAdmin && !keep[strings.ToLower(s.user)] {
			out = append(out, s)
			delete(sessions, tok)
		}
	}
	return out
}

// Whether a Books company requires a login. Only the safe answer ("a login is
// required") is cached briefly; "no login required" lets a request in as Admin,
// so it is asked again every time (SerieX Books is local): right after a Books
// password is set, a request without a session is refused. The last known
// answer is used while Books is unreachable.
type authState struct {
	required bool
	at       time.Time
}

const authTTL = 15 * time.Second

var (
	authMu    sync.Mutex
	authCache = map[string]authState{}
)

func setAuthRequired(companyID string, required bool) {
	authMu.Lock()
	authCache[companyID] = authState{required: required, at: time.Now()}
	authMu.Unlock()
}

func booksAuthRequired(ctx context.Context, companyID string) (bool, error) {
	authMu.Lock()
	st, ok := authCache[companyID]
	authMu.Unlock()
	if ok && st.required && time.Since(st.at) < authTTL {
		return st.required, nil
	}
	info, err := books.Default.Auth(ctx, companyID)
	if err != nil {
		if books.IsUnavailable(err) && ok {
			return st.required, nil
		}
		return false, books.ToAppErr(err)
	}
	setAuthRequired(companyID, info.Required)
	return info.Required, nil
}

// sessionFor resolves the payroll session of a request for a company: a valid
// X-Session token of that company, a read-only AI assistant session (header
// X-Books-Session), or "Admin" when the Books company has no passwords.
func sessionFor(r *http.Request, companyID string) (*httpx.Session, error) {
	ctx := r.Context()
	if tok := strings.TrimSpace(r.Header.Get("X-Session")); tok != "" {
		if s := getSession(tok); s != nil && s.companyID == companyID {
			if s.booksToken != "" {
				return &httpx.Session{User: s.user, BooksToken: s.booksToken, IsAdmin: s.isAdmin}, nil
			}
			// signed in while Books had no passwords: valid as long as that is still true
			req, err := booksAuthRequired(ctx, companyID)
			if err != nil {
				return nil, err
			}
			if !req {
				return &httpx.Session{User: s.user, IsAdmin: true}, nil
			}
			dropSession(tok)
		}
	}
	// an AI assistant (SerieX Books MCP): read-only, see assistant.go
	if tok := strings.TrimSpace(r.Header.Get("X-Books-Session")); tok != "" {
		return assistantSession(r, companyID, tok)
	}
	req, err := booksAuthRequired(ctx, companyID)
	if err != nil {
		return nil, err
	}
	if !req {
		return &httpx.Session{User: "Admin", IsAdmin: true}, nil
	}
	return nil, apperr.Auth("Please log in.")
}

func authenticate(r *http.Request, companyID string, db *sql.DB) (*httpx.Session, error) {
	return sessionFor(r, companyID)
}

func forbidden(format string, args ...any) error {
	return apperr.Forbidden(format, args...)
}

func requireAdmin(c *httpx.Ctx, what string) error {
	if !c.IsAdmin {
		return forbidden("Only a SerieX Books administrator can %s.", what)
	}
	return nil
}

// hasAccess reports whether a non-administrator is listed in the payroll access table.
func hasAccess(ctx context.Context, companyID, user string) (bool, error) {
	if !mgr.Exists(companyID) {
		return false, nil
	}
	db, err := mgr.Open(companyID)
	if err != nil {
		return false, err
	}
	var n int
	err = db.QueryRowContext(ctx, `SELECT COUNT(*) FROM access WHERE user = ?`, user).Scan(&n)
	return n > 0, err
}

// POST /api/companies/{id}/login {user, password} -> LoginResult
func handleLogin(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return apperr.NotFound("Company file not found.")
	}
	var body model.LoginRequest
	if err := httpx.DecodeJSON(r, &body); err != nil {
		return err
	}
	ctx := r.Context()
	info, err := books.Default.Auth(ctx, id)
	if err != nil {
		return books.ToAppErr(err)
	}
	setAuthRequired(id, info.Required)
	s := &session{companyID: id}
	if !info.Required {
		s.user, s.isAdmin = "Admin", true
	} else {
		res, err := books.Default.Login(ctx, id, strings.TrimSpace(body.User), body.Password)
		if err != nil {
			if e := books.AsError(err); e != nil && e.Code == apperr.CodeValidation {
				field := e.Field
				if field == "" {
					field = "password"
				}
				return apperr.Validation(field, "%s", e.Message)
			}
			return books.ToAppErr(err)
		}
		s.user, s.booksToken = res.User, res.Token
		bs := books.Session{CompanyID: id, Token: res.Token}
		users, err := books.Default.Users(ctx, bs)
		if err != nil {
			return books.ToAppErr(err)
		}
		for _, u := range users {
			if strings.EqualFold(u.Name, res.User) {
				s.isAdmin = u.IsAdmin && u.Active
			}
		}
		if !s.isAdmin {
			ok, err := hasAccess(ctx, id, res.User)
			if err != nil {
				return err
			}
			if !ok {
				books.Default.Logout(ctx, bs)
				if !mgr.Exists(id) {
					return apperr.Auth("Payroll is not set up for this company yet. A SerieX Books administrator must log in to set up payroll.")
				}
				return apperr.Auth("%s does not have access to payroll. Ask a SerieX Books administrator to give you access (Payroll User Access).", res.User)
			}
		}
	}
	tok := addSession(s)
	return httpx.WriteJSON(w, http.StatusOK, model.LoginResult{Token: tok, User: s.user, IsAdmin: s.isAdmin})
}

// POST /api/c/{cid}/logout (works without a valid session)
func handleLogout(w http.ResponseWriter, r *http.Request) error {
	if tok := strings.TrimSpace(r.Header.Get("X-Session")); tok != "" {
		if s := dropSession(tok); s != nil && s.booksToken != "" {
			books.Default.Logout(r.Context(), books.Session{CompanyID: s.companyID, Token: s.booksToken})
		}
	}
	return httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// GET /api/companies/{id}/auth -> AuthInfo (from SerieX Books)
func handleAuthInfo(w http.ResponseWriter, r *http.Request) error {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return apperr.NotFound("Company file not found.")
	}
	info, err := books.Default.Auth(r.Context(), id)
	if err != nil {
		return books.ToAppErr(err)
	}
	setAuthRequired(id, info.Required)
	users := info.Users
	if users == nil {
		users = []string{}
	}
	return httpx.WriteJSON(w, http.StatusOK, model.AuthInfo{Required: info.Required, Users: users})
}
