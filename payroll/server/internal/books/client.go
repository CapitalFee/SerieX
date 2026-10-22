// Package books is the HTTP client of the SerieX Books API. Payroll reads the
// Books company file list, users, accounts, vendors, classes and customer:jobs
// from it and posts paychecks, tax payments and tax balance adjustments as
// Books transactions.
package books

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"seriexpayroll/internal/apperr"
)

// Client talks to one SerieX Books server.
type Client struct {
	BaseURL string // e.g. http://127.0.0.1:8080 (no trailing slash)
	HTTP    *http.Client
}

// New returns a client for the Books server at baseURL.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 60 * time.Second},
	}
}

// Session identifies the Books company file and the Books session token
// ("" when the Books company has no passwords).
type Session struct {
	CompanyID string
	Token     string
	// Assistant: Token is a SerieX Books session of AI assistants. Requests
	// then carry X-SerieX-Assistant: 1, so SerieX Books answers 401 when that
	// session has ended, never as the "Admin" of a file without passwords.
	Assistant bool
}

// Options answer the Books server's questions in advance.
type Options struct {
	Force           bool   // answer Yes to a Books "confirm" question (?force=1)
	ClosingPassword string // Books closing date password (header X-Closing-Password)
}

// Error is an error response from SerieX Books, or Code "unavailable" when the
// server could not be reached.
type Error struct {
	Status  int
	Code    string
	Message string
	Field   string
}

func (e *Error) Error() string { return "SerieX Books: " + e.Message }

// CodeUnavailable is used when the Books server did not answer.
const CodeUnavailable = "unavailable"

// AsError extracts a *Error from err (nil when err is not a Books error).
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}

// ToAppErr converts a Books error into the payroll API error the web client
// understands: confirm -> confirm (the client re-sends with ?force=1, which
// handlers pass on as Options.Force), closing_date -> closing_date (re-sent
// with X-Closing-Password), auth -> books_auth, unreachable -> books_unavailable,
// validation/conflict/not_found keep their code. Messages are prefixed with
// "SerieX Books: ". Non-Books errors are returned unchanged.
func ToAppErr(err error) error {
	e := AsError(err)
	if e == nil {
		return err
	}
	msg := "SerieX Books: " + e.Message
	switch e.Code {
	case CodeUnavailable:
		return apperr.BooksUnavailable("%s", msg)
	case apperr.CodeAuth:
		return apperr.BooksAuth("%s", msg)
	case apperr.CodeConfirm:
		return apperr.Confirm("%s", msg)
	case apperr.CodeClosingDate:
		return apperr.ClosingDate("%s", msg)
	case apperr.CodeNotFound:
		return apperr.NotFound("%s", msg)
	case apperr.CodeConflict:
		return apperr.Conflict("%s", msg)
	case apperr.CodeValidation:
		return apperr.Validation(e.Field, "%s", msg)
	}
	return apperr.New(http.StatusBadGateway, apperr.CodeInternal, "%s", msg)
}

// Do sends one request. path is relative to /api (e.g. "/companies" or
// CPath(id, "/accounts")). body is JSON-encoded when not nil; the JSON
// response is decoded into out when not nil.
func (c *Client) Do(ctx context.Context, method, path string, s *Session, body, out any, opt Options) error {
	u := c.BaseURL + "/api" + path
	if opt.Force {
		if strings.Contains(u, "?") {
			u += "&force=1"
		} else {
			u += "?force=1"
		}
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s != nil && s.Token != "" {
		req.Header.Set("X-Session", s.Token)
	}
	if s != nil && s.Assistant {
		req.Header.Set("X-SerieX-Assistant", "1")
	}
	if opt.ClosingPassword != "" {
		req.Header.Set("X-Closing-Password", opt.ClosingPassword)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return &Error{Status: 0, Code: CodeUnavailable, Message: fmt.Sprintf("the server at %s is not reachable (%v). Start SerieX Books and try again.", c.BaseURL, err)}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return &Error{Status: res.StatusCode, Code: CodeUnavailable, Message: err.Error()}
	}
	if res.StatusCode >= 400 {
		var e struct {
			Error string `json:"error"`
			Code  string `json:"code"`
			Field string `json:"field"`
		}
		if json.Unmarshal(data, &e) != nil || e.Error == "" {
			e.Error = strings.TrimSpace(string(data))
			if e.Error == "" {
				e.Error = res.Status
			}
		}
		if e.Code == "" {
			e.Code = "http_" + strconv.Itoa(res.StatusCode)
		}
		return &Error{Status: res.StatusCode, Code: e.Code, Message: e.Error, Field: e.Field}
	}
	if out != nil && res.StatusCode != http.StatusNoContent && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("SerieX Books returned an unexpected answer for %s %s: %w", method, path, err)
		}
	}
	return nil
}

// CPath builds a company-scoped path: CPath("acme", "/accounts") = "/c/acme/accounts".
func CPath(companyID, path string) string {
	return "/c/" + url.PathEscape(companyID) + path
}

func (c *Client) cGet(ctx context.Context, s Session, path string, out any) error {
	return c.Do(ctx, http.MethodGet, CPath(s.CompanyID, path), &s, nil, out, Options{})
}

// ---------------------------------------------------------------------------
// Global

// Ping reports whether the Books server answers /api/health.
func (c *Client) Ping(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return c.Do(ctx, http.MethodGet, "/health", nil, nil, nil, Options{}) == nil
}

// Companies lists the Books company files.
func (c *Client) Companies(ctx context.Context) ([]CompanyFile, error) {
	var out []CompanyFile
	err := c.Do(ctx, http.MethodGet, "/companies", nil, nil, &out, Options{})
	return out, err
}

// Auth tells whether the Books company requires a login and lists its users.
func (c *Client) Auth(ctx context.Context, companyID string) (AuthInfo, error) {
	var out AuthInfo
	err := c.Do(ctx, http.MethodGet, "/companies/"+url.PathEscape(companyID)+"/auth", nil, nil, &out, Options{})
	return out, err
}

// Login signs in to a Books company and returns its session token.
func (c *Client) Login(ctx context.Context, companyID, user, password string) (LoginResult, error) {
	var out LoginResult
	err := c.Do(ctx, http.MethodPost, "/companies/"+url.PathEscape(companyID)+"/login", nil,
		map[string]string{"user": user, "password": password}, &out, Options{})
	return out, err
}

// ---------------------------------------------------------------------------
// Company scoped reads

func (c *Client) CompanyInfo(ctx context.Context, s Session) (CompanyInfo, error) {
	var out CompanyInfo
	err := c.cGet(ctx, s, "/company", &out)
	return out, err
}

func (c *Client) Users(ctx context.Context, s Session) ([]User, error) {
	var out []User
	err := c.cGet(ctx, s, "/users", &out)
	return out, err
}

// Accounts lists accounts of the given types (all types when none), active and inactive.
func (c *Client) Accounts(ctx context.Context, s Session, types ...string) ([]Account, error) {
	q := "?active=all"
	if len(types) > 0 {
		q += "&types=" + url.QueryEscape(strings.Join(types, ","))
	}
	var out []Account
	err := c.cGet(ctx, s, "/accounts"+q, &out)
	return out, err
}

func (c *Client) CreateAccount(ctx context.Context, s Session, a Account) (Account, error) {
	var out Account
	err := c.Do(ctx, http.MethodPost, CPath(s.CompanyID, "/accounts"), &s, a, &out, Options{})
	return out, err
}

// Names lists names of one kind ("" = all kinds), active and inactive.
func (c *Client) Names(ctx context.Context, s Session, kind string) ([]Name, error) {
	q := "?active=all"
	if kind != "" {
		q += "&kind=" + url.QueryEscape(kind)
	}
	var out []Name
	err := c.cGet(ctx, s, "/names"+q, &out)
	return out, err
}

func (c *Client) GetName(ctx context.Context, s Session, id int64) (Name, error) {
	var out Name
	err := c.cGet(ctx, s, fmt.Sprintf("/names/%d", id), &out)
	return out, err
}

func (c *Client) CreateName(ctx context.Context, s Session, n Name) (Name, error) {
	var out Name
	err := c.Do(ctx, http.MethodPost, CPath(s.CompanyID, "/names"), &s, n, &out, Options{})
	return out, err
}

func (c *Client) UpdateName(ctx context.Context, s Session, n Name) (Name, error) {
	var out Name
	err := c.Do(ctx, http.MethodPut, CPath(s.CompanyID, fmt.Sprintf("/names/%d", n.ID)), &s, n, &out, Options{})
	return out, err
}

// List returns the entries of a Books simple list ("class", ...), active and inactive.
func (c *Client) List(ctx context.Context, s Session, list string) ([]ListEntry, error) {
	var out []ListEntry
	err := c.cGet(ctx, s, "/lists/"+url.PathEscape(list)+"?active=all", &out)
	return out, err
}

// NextRef returns the next check number Books would suggest for a bank account.
func (c *Client) NextRef(ctx context.Context, s Session, txnType string, accountID int64) (string, error) {
	var out struct {
		RefNumber string `json:"refNumber"`
	}
	err := c.cGet(ctx, s, fmt.Sprintf("/next-ref?type=%s&accountId=%d", url.QueryEscape(txnType), accountID), &out)
	return out.RefNumber, err
}

// ---------------------------------------------------------------------------
// Transactions

func (c *Client) GetTxn(ctx context.Context, s Session, id int64) (Txn, error) {
	var out Txn
	err := c.cGet(ctx, s, fmt.Sprintf("/txns/%d", id), &out)
	return out, err
}

func (c *Client) CreateTxn(ctx context.Context, s Session, t Txn, opt Options) (Txn, error) {
	var out Txn
	err := c.Do(ctx, http.MethodPost, CPath(s.CompanyID, "/txns"), &s, t, &out, opt)
	return out, err
}

func (c *Client) UpdateTxn(ctx context.Context, s Session, t Txn, opt Options) (Txn, error) {
	var out Txn
	err := c.Do(ctx, http.MethodPut, CPath(s.CompanyID, fmt.Sprintf("/txns/%d", t.ID)), &s, t, &out, opt)
	return out, err
}

func (c *Client) DeleteTxn(ctx context.Context, s Session, id int64, opt Options) error {
	return c.Do(ctx, http.MethodDelete, CPath(s.CompanyID, fmt.Sprintf("/txns/%d", id)), &s, nil, nil, opt)
}

func (c *Client) VoidTxn(ctx context.Context, s Session, id int64, opt Options) (Txn, error) {
	var out Txn
	err := c.Do(ctx, http.MethodPost, CPath(s.CompanyID, fmt.Sprintf("/txns/%d/void", id)), &s, struct{}{}, &out, opt)
	return out, err
}

// Report runs a Books report and returns its raw JSON (model.ReportResult in Books).
func (c *Client) Report(ctx context.Context, s Session, key string, params map[string]string) (map[string]any, error) {
	v := url.Values{}
	for k, p := range params {
		v.Set(k, p)
	}
	q := ""
	if len(v) > 0 {
		q = "?" + v.Encode()
	}
	var out map[string]any
	err := c.cGet(ctx, s, "/reports/"+url.PathEscape(key)+q, &out)
	return out, err
}

// ---------------------------------------------------------------------------
// Shared instance

// Default is the client every module uses (set by main from the -books flag).
var Default = New("http://127.0.0.1:8080")
