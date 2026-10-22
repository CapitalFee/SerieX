// Package httpx is the small HTTP layer every module registers its routes on.
//
// Company-scoped routes live under /api/c/{cid}/... and get a *Ctx with the
// company database already opened. Handlers return an error; *apperr.Error
// values become JSON error responses with the right status.
package httpx

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"

	"seriex/internal/apperr"
)

// DBProvider opens company databases (implemented by *store.Manager).
type DBProvider interface {
	Open(id string) (*sql.DB, error)
	WriteLock(id string) *sync.Mutex
}

// Router wraps http.ServeMux (Go 1.22 method+pattern routing).
type Router struct {
	Mux *http.ServeMux
	DBs DBProvider
	// Auth, when set, is called for every company-scoped request. It returns
	// the user name, or an error (usually apperr.Auth) to reject the request.
	Auth func(r *http.Request, companyID string, db *sql.DB) (string, error)
	// Session, when set, tells global routes that act on a whole company file
	// (backup, copy, delete...) who is logged in to it (set by the company package).
	Session func(r *http.Request, companyID string, db *sql.DB) (SessionInfo, error)
	// Login, when set, checks a user name and password of a company file
	// (wrong passwords are counted like the login dialog's).
	Login func(ctx context.Context, companyID string, db *sql.DB, user, password string) (SessionInfo, error)
	// FileReplaced, when set, is called after a company file was deleted or
	// (re)created under an id, so logins to the old file end.
	FileReplaced func(companyID string)
	// Context, when set, is called for every company-scoped request that
	// Auth accepted; a context it returns replaces the request's (the
	// company package marks the requests of AI assistants this way, so the
	// audit trail names them).
	Context func(r *http.Request, companyID string) context.Context
	// Changed, when set, is called inside every write transaction (Ctx.Write)
	// that changed rows, just before it commits (the automatic backups count
	// changes there to skip files that did not change).
	Changed func(ctx context.Context, tx *sql.Tx, companyID string) error
}

// SessionInfo describes the login of a request to one company file.
type SessionInfo struct {
	Required bool   // at least one active user has a password
	User     string // user of a valid X-Session token of this file ("" when none)
	Admin    bool   // that user is an administrator
}

func NewRouter(dbs DBProvider) *Router {
	return &Router{Mux: http.NewServeMux(), DBs: dbs}
}

// HandlerFunc is a plain handler that may return an error.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle registers a non-company route, e.g. rt.Handle("GET", "/api/companies", h).
func (rt *Router) Handle(method, pattern string, h HandlerFunc) {
	rt.Mux.HandleFunc(method+" "+pattern, func(w http.ResponseWriter, r *http.Request) {
		defer recoverPanic(w)
		if err := h(w, r); err != nil {
			WriteError(w, err)
		}
	})
}

// Ctx is passed to company-scoped handlers.
type Ctx struct {
	W         http.ResponseWriter
	R         *http.Request
	CompanyID string
	DB        *sql.DB
	User      string
	lock      *sync.Mutex
	changed   func(ctx context.Context, tx *sql.Tx, companyID string) error
}

// C registers a company-scoped route. path is relative to /api/c/{cid}, e.g.
// rt.C("GET", "/accounts/{id}", h). Never use "cid" as a path wildcard name.
func (rt *Router) C(method, path string, h func(c *Ctx) error) {
	rt.Mux.HandleFunc(method+" /api/c/{cid}"+path, func(w http.ResponseWriter, r *http.Request) {
		defer recoverPanic(w)
		cid := r.PathValue("cid")
		db, err := rt.DBs.Open(cid)
		if err != nil {
			WriteError(w, apperr.NotFound("Company file not found or could not be opened: %v", err))
			return
		}
		c := &Ctx{W: w, R: r, CompanyID: cid, DB: db, User: "Admin", lock: rt.DBs.WriteLock(cid), changed: rt.Changed}
		if rt.Auth != nil {
			user, err := rt.Auth(r, cid, db)
			if err != nil {
				WriteError(w, err)
				return
			}
			c.User = user
		}
		if rt.Context != nil {
			if ctx := rt.Context(r, cid); ctx != nil {
				c.R = r.WithContext(ctx)
			}
		}
		if err := h(c); err != nil {
			WriteError(w, err)
		}
	})
}

func (c *Ctx) Context() context.Context { return c.R.Context() }

// JSON writes v with status 200.
func (c *Ctx) JSON(v any) error { return WriteJSON(c.W, http.StatusOK, v) }

// JSONStatus writes v with the given status.
func (c *Ctx) JSONStatus(status int, v any) error { return WriteJSON(c.W, status, v) }

// NoContent writes 204.
func (c *Ctx) NoContent() error {
	c.W.WriteHeader(http.StatusNoContent)
	return nil
}

// Decode reads the JSON request body into v (unknown fields are ignored).
func (c *Ctx) Decode(v any) error { return DecodeJSON(c.R, v) }

// ID returns an integer path value ({id}, {accountId}, ...).
func (c *Ctx) ID(name string) (int64, error) {
	s := c.R.PathValue(name)
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, apperr.BadRequest("invalid %s %q", name, s)
	}
	return n, nil
}

// Q returns a query string value.
func (c *Ctx) Q(name string) string { return c.R.URL.Query().Get(name) }

// QInt returns an integer query value (0 when missing or invalid).
func (c *Ctx) QInt(name string) int64 {
	n, _ := strconv.ParseInt(c.R.URL.Query().Get(name), 10, 64)
	return n
}

// QFloat returns a float query value and whether it was present and valid.
func (c *Ctx) QFloat(name string) (float64, bool) {
	s := c.R.URL.Query().Get(name)
	if s == "" {
		return 0, false
	}
	f, err := strconv.ParseFloat(s, 64)
	return f, err == nil
}

// QBool is true for "1", "true", "yes".
func (c *Ctx) QBool(name string) bool {
	switch strings.ToLower(c.R.URL.Query().Get(name)) {
	case "1", "true", "yes":
		return true
	}
	return false
}

// QIDs parses a comma separated id list (?ids=1,2,3).
func (c *Ctx) QIDs(name string) []int64 {
	var out []int64
	for _, p := range strings.Split(c.R.URL.Query().Get(name), ",") {
		if n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 64); err == nil && n > 0 {
			out = append(out, n)
		}
	}
	return out
}

// Force is true when the client confirmed every Yes/No question (?force=1).
func (c *Ctx) Force() bool { return c.QBool("force") }

// Accepted returns the warning kinds the user answered Yes to (?accept=a,b or
// header X-Accept: a,b). See apperr.ConfirmKind.
func (c *Ctx) Accepted() map[string]bool {
	out := map[string]bool{}
	for _, src := range []string{c.R.URL.Query().Get("accept"), c.R.Header.Get("X-Accept")} {
		for _, p := range strings.Split(src, ",") {
			if p = strings.ToLower(strings.TrimSpace(p)); p != "" {
				out[p] = true
			}
		}
	}
	return out
}

// Accepts reports whether the user answered Yes to questions of this kind
// (?force=1 answers Yes to all).
func (c *Ctx) Accepts(kind string) bool { return c.Force() || c.Accepted()[kind] }

// ClosingPassword is the closing date password sent by the client (header X-Closing-Password).
func (c *Ctx) ClosingPassword() string { return c.R.Header.Get("X-Closing-Password") }

// Write runs fn in a write transaction (BEGIN IMMEDIATE), serialized per company.
// Inside fn use only tx for database access.
func (c *Ctx) Write(fn func(tx *sql.Tx) error) error {
	c.lock.Lock()
	defer c.lock.Unlock()
	tx, err := c.DB.BeginTx(c.Context(), nil)
	if err != nil {
		return err
	}
	var before, after int64
	if c.changed != nil {
		if err := tx.QueryRowContext(c.Context(), `SELECT total_changes()`).Scan(&before); err != nil {
			tx.Rollback()
			return err
		}
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	if c.changed != nil {
		err := tx.QueryRowContext(c.Context(), `SELECT total_changes()`).Scan(&after)
		if err == nil && after != before {
			err = c.changed(c.Context(), tx, c.CompanyID)
		}
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

// ---------------------------------------------------------------------------

func WriteJSON(w http.ResponseWriter, status int, v any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if v == nil {
		return nil
	}
	return json.NewEncoder(w).Encode(v)
}

func DecodeJSON(r *http.Request, v any) error {
	if r.Body == nil {
		return apperr.BadRequest("The request has no content.")
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		return BodyError(err)
	}
	return nil
}

// MaxJSONBody is the largest JSON request body accepted (see Guard).
const MaxJSONBody = 8 << 20

// BodyError turns an error from reading or decoding a JSON request body into
// a plain message.
func BodyError(err error) error {
	var mbe *http.MaxBytesError
	var se *json.SyntaxError
	var te *json.UnmarshalTypeError
	switch {
	case errors.As(err, &mbe):
		return apperr.New(http.StatusRequestEntityTooLarge, apperr.CodeValidation, "The request is too large (%d MB maximum).", mbe.Limit>>20)
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return apperr.BadRequest("The request has no content or is incomplete.")
	case errors.As(err, &se):
		return apperr.BadRequest("The request is not valid JSON.")
	case errors.As(err, &te):
		field := te.Field
		if field == "" {
			return apperr.BadRequest("The request contains a value of the wrong kind.")
		}
		return apperr.Validation(field, "The value of %s has the wrong kind (expected %s).", field, te.Type.String())
	}
	return apperr.BadRequest("The request could not be read.")
}

// WriteError converts err into a JSON error response.
func WriteError(w http.ResponseWriter, err error) {
	if e := apperr.As(err); e != nil {
		status := e.Status
		if status == 0 {
			status = http.StatusBadRequest
		}
		WriteJSON(w, status, e)
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		WriteJSON(w, http.StatusNotFound, &apperr.Error{Code: apperr.CodeNotFound, Message: "Record not found."})
		return
	}
	msg := err.Error()
	if strings.Contains(msg, "UNIQUE constraint failed") {
		WriteJSON(w, http.StatusConflict, &apperr.Error{Code: apperr.CodeConflict, Message: "This name is already in use. Please choose a different name."})
		return
	}
	if strings.Contains(msg, "FOREIGN KEY constraint failed") {
		WriteJSON(w, http.StatusConflict, &apperr.Error{Code: apperr.CodeConflict, Message: "This record is used elsewhere and cannot be changed this way."})
		return
	}
	var mbe *http.MaxBytesError
	if errors.As(err, &mbe) {
		WriteError(w, BodyError(err))
		return
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		// The browser gave up on the request (window closed while loading): nobody reads
		// the answer, so do not log it as an internal error.
		WriteJSON(w, 499, &apperr.Error{Code: "canceled", Message: "The request was canceled."})
		return
	}
	writeInternal(w, msg)
}

// writeInternal logs an unexpected error with a short reference and sends a
// plain message (never the raw database or Go error) to the client.
func writeInternal(w http.ResponseWriter, detail string) {
	b := make([]byte, 3)
	rand.Read(b)
	ref := strings.ToUpper(hex.EncodeToString(b))
	log.Printf("internal error [ref %s]: %s", ref, detail)
	low := strings.ToLower(detail)
	var msg string
	switch {
	case strings.Contains(low, "integer overflow"):
		msg = fmt.Sprintf("A number is too large to be stored (ref %s). Check the amounts and quantities you entered.", ref)
	case strings.Contains(low, "no such table"), strings.Contains(low, "no such column"),
		strings.Contains(low, "malformed"), strings.Contains(low, "not a database"):
		msg = fmt.Sprintf("The company file is damaged or incomplete (ref %s). Restore it from a backup.", ref)
	case strings.Contains(low, "database is locked"), strings.Contains(low, "busy"):
		msg = fmt.Sprintf("The company file is busy (ref %s). Wait a moment and try again.", ref)
	default:
		msg = fmt.Sprintf("Something went wrong (ref %s). Try again; if it keeps happening, run File > Utilities > Check Company File.", ref)
	}
	WriteJSON(w, http.StatusInternalServerError, &apperr.Error{Code: apperr.CodeInternal, Message: msg})
}

func recoverPanic(w http.ResponseWriter) {
	if p := recover(); p != nil {
		writeInternal(w, fmt.Sprintf("panic: %v", p))
	}
}

// ---------------------------------------------------------------------------
// Request guard (cross-site requests, DNS rebinding, framing, body size)

// HostAllowed reports whether a Host header names this server: an IP address
// (any port), "localhost" or a name ending in ".localhost", or one of extra.
// Other names are refused so that a web page whose domain is re-pointed to
// this computer (DNS rebinding) cannot read or change the books.
func HostAllowed(host string, extra []string) bool {
	h := host
	if hh, _, err := net.SplitHostPort(host); err == nil {
		h = hh
	}
	h = strings.ToLower(strings.TrimSuffix(strings.Trim(h, "[]"), "."))
	if h == "" {
		return false
	}
	if h == "localhost" || strings.HasSuffix(h, ".localhost") || net.ParseIP(h) != nil {
		return true
	}
	for _, x := range extra {
		if strings.EqualFold(strings.TrimSpace(x), h) {
			return true
		}
	}
	return false
}

// FromThisComputer reports whether a request comes from this computer (a
// loopback address). It is false only when the server was started with -host
// to listen on the network and another computer sends the request.
func FromThisComputer(r *http.Request) bool {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		h = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(h, "[]"))
	return ip != nil && ip.IsLoopback()
}

// IsLoopbackHost reports whether a -host value listens only on this computer
// ("127.0.0.1", "::1", "localhost").
func IsLoopbackHost(host string) bool {
	h := strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]"))
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// sameOrigin reports whether an Origin header names the host the request was sent to.
func sameOrigin(origin string, r *http.Request) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

func refuse(w http.ResponseWriter, status int, msg string) {
	WriteJSON(w, status, &apperr.Error{Code: apperr.CodeForbidden, Message: msg})
}

// Guard protects the API from other web pages: it refuses unknown Host names
// (DNS rebinding), any /api/ request a browser sends on behalf of another
// page (cross-site request forgery, including reads with side effects),
// request bodies that are not JSON or a file upload, and JSON bodies larger
// than MaxJSONBody; it also forbids showing the app inside another page's
// frame. Programs calling the API directly (no Origin / Sec-Fetch-Site
// headers) are not affected.
func Guard(h http.Handler, extraHosts []string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hd := w.Header()
		hd.Set("X-Frame-Options", "DENY")
		hd.Set("Content-Security-Policy", "frame-ancestors 'none'")
		hd.Set("X-Content-Type-Options", "nosniff")
		hd.Set("Referrer-Policy", "same-origin")
		if !HostAllowed(r.Host, extraHosts) {
			refuse(w, http.StatusForbidden, "This address is not allowed. Open SerieX Books at http://127.0.0.1 or http://localhost.")
			return
		}
		origin := r.Header.Get("Origin")
		site := strings.ToLower(r.Header.Get("Sec-Fetch-Site"))
		if strings.HasPrefix(r.URL.Path, "/api/") &&
			((origin != "" && !sameOrigin(origin, r)) || (site != "" && site != "same-origin" && site != "none")) {
			refuse(w, http.StatusForbidden, "Requests from other web pages are not allowed.")
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			h.ServeHTTP(w, r)
			return
		}
		if origin != "" && !sameOrigin(origin, r) {
			refuse(w, http.StatusForbidden, "Requests from other web pages are not allowed.")
			return
		}
		if site != "" && site != "same-origin" && site != "none" {
			refuse(w, http.StatusForbidden, "Requests from other web pages are not allowed.")
			return
		}
		if r.ContentLength != 0 && r.Body != nil && r.Body != http.NoBody {
			ct := r.Header.Get("Content-Type")
			mt, _, _ := mime.ParseMediaType(ct)
			switch {
			case mt == "application/json":
				r.Body = http.MaxBytesReader(w, r.Body, MaxJSONBody)
			case mt == "multipart/form-data":
				// file uploads: each route applies its own size limit
			case ct == "" && origin == "" && site == "":
				// a program without a browser (e.g. the payroll app) that did not set a type
				r.Body = http.MaxBytesReader(w, r.Body, MaxJSONBody)
			default:
				WriteJSON(w, http.StatusUnsupportedMediaType, &apperr.Error{Code: apperr.CodeValidation,
					Message: "Send the request as JSON (Content-Type: application/json) or as a file upload."})
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}
