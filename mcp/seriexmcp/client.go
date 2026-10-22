package seriexmcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// apiError is an error answer of SerieX Books or Payroll:
// {"error", "code", "field", "warning", "data"}.
type apiError struct {
	Status  int
	App     string
	Code    string         `json:"code"`
	Message string         `json:"error"`
	Field   string         `json:"field"`
	Warning string         `json:"warning"`
	Data    map[string]any `json:"data"`
}

func (e *apiError) Error() string { return e.Message }

// userError is a plain message for the assistant (wrong input, nothing found...).
type userError struct{ msg string }

func (e *userError) Error() string { return e.msg }

func userErr(format string, args ...any) error { return &userError{fmt.Sprintf(format, args...)} }

// appInfo is GET /api/info of SerieX Books or SerieX Payroll.
type appInfo struct {
	App        string `json:"app"`
	Version    string `json:"version"`
	PayrollURL string `json:"payrollUrl"`
}

// maxReply is the largest answer read from SerieX Books or Payroll.
const maxReply = 16 << 20

// AssistantHeader marks every request these tools send to SerieX Books
// (value "1"). SerieX Books answers a marked company request only with a
// valid login of AI assistants (Session.Books): when that login is missing
// or has ended, it answers 401, and the tools ask for a new login once
// (SessionProvider, renew), instead of being treated like the SerieX app
// in a company file without passwords.
const AssistantHeader = "X-SerieX-Assistant"

// send makes one request to a SerieX server. app names the server in
// messages ("SerieX Books"); token is sent in the header named tokenHeader
// (none when token is "").
func (s *service) send(ctx context.Context, app, base, method, path string, q url.Values, body any, tokenHeader, token string, out any) error {
	return s.sendWith(ctx, s.http, app, base, method, path, q, body, tokenHeader, token, out)
}

// sendWith is send over a given client (the proven client for payroll
// tokens of company files with passwords).
func (s *service) sendWith(ctx context.Context, client *http.Client, app, base, method, path string, q url.Values, body any, tokenHeader, token string, out any) error {
	if base == "" {
		return userErr("%s is not connected to these tools.", app)
	}
	full := base + path
	if len(q) > 0 {
		full += "?" + q.Encode()
	}
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, full, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if base == s.booksURL {
		req.Header.Set(AssistantHeader, "1")
	}
	if token != "" {
		req.Header.Set(tokenHeader, token)
	}
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(err, errPayrollUnproven) {
			return userErr("%s", msgPayrollUnproven) // nothing was sent but the check
		}
		return transportErr(app, method, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, maxReply+1))
	if err != nil {
		return userErr("Could not read the answer of %s: %v", app, err)
	}
	if len(data) > maxReply {
		return userErr("The answer of %s is too large (more than %d MB). Narrow the request (dates, filters, search).", app, maxReply>>20)
	}
	if res.StatusCode >= 300 && res.StatusCode < 400 {
		return userErr("%s answered with a redirect (HTTP %d), which these tools do not follow.", app, res.StatusCode)
	}
	if res.StatusCode >= 300 {
		ae := &apiError{Status: res.StatusCode, App: app}
		if json.Unmarshal(data, ae) != nil || ae.Message == "" {
			ae.Message = fmt.Sprintf("%s answered with an error (HTTP %d).", app, res.StatusCode)
		}
		return ae
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return userErr("%s sent an answer these tools could not read: %v", app, err)
	}
	return nil
}

// transportErr explains a request that got no answer.
func transportErr(app, method string, err error) error {
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return userErr("%s is not running. Open the SerieX app and try again.", app)
	}
	change := method != http.MethodGet
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		if change {
			return userErr("%s did not answer in time. Check in SerieX whether the change was saved before trying again.", app)
		}
		return userErr("%s did not answer in time. Try again, or narrow the request.", app)
	}
	if change {
		return userErr("The connection to %s failed (%v). Check in SerieX whether the change was saved before trying again.", app, err)
	}
	return userErr("Could not reach %s: %v", app, err)
}

// global calls a SerieX Books route that is not about one company file.
func (s *service) global(ctx context.Context, path string, q url.Values, out any) error {
	return s.send(ctx, "SerieX Books", s.booksURL, http.MethodGet, path, q, nil, "", "", out)
}

// info asks a server for GET /api/info.
func (s *service) info(ctx context.Context, base string) (*appInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/info", nil)
	if err != nil {
		return nil, err
	}
	if base == s.booksURL {
		req.Header.Set(AssistantHeader, "1")
	}
	res, err := s.probe.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	var ai appInfo
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&ai); err != nil {
		return nil, err
	}
	return &ai, nil
}

// payrollApp is the name SerieX Payroll gives in GET /api/info.
const payrollApp = "SerieX Payroll"

// payroll returns the address of SerieX Payroll and whether it answers
// (checked at most every refreshEvery unless force).
func (s *service) payroll(ctx context.Context, force bool) (string, bool) {
	s.pmu.Lock()
	defer s.pmu.Unlock()
	if !force && !s.payrollAt.IsZero() && time.Since(s.payrollAt) < refreshEvery {
		return s.payrollURL, s.payrollOK
	}
	s.payrollAt = time.Now()
	base := strings.TrimRight(strings.TrimSpace(s.opts.PayrollURL), "/")
	if base == "" && s.booksURL != "" {
		if ai, err := s.info(ctx, s.booksURL); err == nil {
			base = strings.TrimRight(strings.TrimSpace(ai.PayrollURL), "/")
		}
	}
	if !onThisComputer(base) {
		base = "" // the payroll login of AI assistants is only sent on this computer
	}
	s.payrollURL, s.payrollOK, s.payrollVer = base, false, ""
	if base == "" {
		return "", false
	}
	if ai, err := s.info(ctx, base); err == nil && strings.TrimSpace(ai.App) == payrollApp {
		s.payrollOK, s.payrollVer = true, ai.Version
	}
	return s.payrollURL, s.payrollOK
}

// onThisComputer: an http(s) address on this computer (loopback).
func onThisComputer(base string) bool {
	u, err := url.Parse(base)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && IsLoopbackHost(u.Hostname())
}

// companyFile is an entry of GET /api/companies.
type companyFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Modified string `json:"modified"`
}

func (s *service) companies(ctx context.Context) ([]companyFile, error) {
	var list []companyFile
	if err := s.global(ctx, "/api/companies", nil, &list); err != nil {
		return nil, err
	}
	return list, nil
}

// payrollVersion is the version SerieX Payroll reported ("" when unknown).
func (s *service) payrollVersion() string {
	s.pmu.Lock()
	defer s.pmu.Unlock()
	return s.payrollVer
}
