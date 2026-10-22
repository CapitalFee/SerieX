package seriexmcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// companyArg is the "company" argument of every company tool.
type companyArg struct {
	Company string `json:"company,omitempty" jsonschema:"Company file id or exact name (see list_companies). May be left out when only one company file is shared with AI assistants."`
}

// Plain messages about the AI assistant settings in SerieX.
const (
	settingsWhere = "AI Assistants"
	msgReadOnly   = "Nothing was saved: AI assistants may only look at the books of %s, not change them. " +
		"If the user wants this change, they can make it in SerieX themselves, or an administrator can allow changes in SerieX (" + settingsWhere + "). Do not try another way to make the change."
)

type companyRef struct {
	ID     string
	Name   string
	Access Access
}

// call is one tool call on one company file: it keeps the login token and
// the lists loaded during the call.
type call struct {
	s   *service
	ctx context.Context
	co  companyRef

	sess     Session
	haveSess bool

	accounts []account
	names    []name
	items    []item
	lists    map[string][]listEntry
	prefs    *prefs
}

// open selects the company file of a tool call. write: the tool makes changes.
func (s *service) open(ctx context.Context, arg string, write bool) (*call, error) {
	co, err := s.company(ctx, arg)
	if err != nil {
		return nil, err
	}
	noteCompany(ctx, co.ID)
	if co.Access.UserGone {
		return nil, userErr("%s cannot be used until an administrator chooses another SerieX user for AI assistants in SerieX (%s): the user chosen before no longer exists or is inactive.", co.Name, settingsWhere)
	}
	if write && !co.Access.AllowChanges {
		return nil, userErr(msgReadOnly, co.Name)
	}
	return &call{s: s, ctx: ctx, co: co, lists: map[string][]listEntry{}}, nil
}

// company finds the company file named by arg (id or exact name) among the
// files shared with AI assistants; "" is fine when only one is shared. Files
// that are not shared are treated as if they did not exist.
func (s *service) company(ctx context.Context, arg string) (companyRef, error) {
	list, err := s.companies(ctx)
	if err != nil {
		return companyRef{}, err
	}
	var shared []companyRef
	for _, c := range list {
		if a := s.access(ctx, c.ID); a.Enabled {
			shared = append(shared, companyRef{ID: c.ID, Name: c.Name, Access: a})
		}
	}
	if only, ok := companyScope(ctx); ok && len(shared) == 0 {
		return companyRef{}, userErr("The company file this assistant was connected for (id %s) is not shared with AI assistants right now. An administrator can share it in SerieX (%s).", only, settingsWhere)
	}
	describe := func(refs []companyRef) string {
		var out []string
		for _, c := range refs {
			out = append(out, fmt.Sprintf("%q (id %s)", c.Name, c.ID))
		}
		return strings.Join(out, ", ")
	}
	want := strings.TrimSpace(arg)
	if want != "" {
		for _, c := range shared {
			if strings.EqualFold(c.ID, want) {
				return c, nil
			}
		}
		var byName []companyRef
		for _, c := range shared {
			if strings.EqualFold(strings.Join(strings.Fields(c.Name), " "), strings.Join(strings.Fields(want), " ")) {
				byName = append(byName, c)
			}
		}
		switch {
		case len(byName) == 1:
			return byName[0], nil
		case len(byName) > 1:
			return companyRef{}, userErr("Several shared company files are named %q: %s. Ask the user which one they mean and pass its id as \"company\".", want, describe(byName))
		case len(shared) == 0:
			return companyRef{}, userErr("No company file is shared with AI assistants. An administrator can share one in SerieX (%s).", settingsWhere)
		}
		return companyRef{}, userErr("No company file %q is shared with AI assistants. Shared company files: %s.", want, describe(shared))
	}
	switch len(shared) {
	case 0:
		if len(list) == 0 {
			return companyRef{}, userErr("SerieX Books has no company files yet. Create or open a company in the SerieX app first.")
		}
		return companyRef{}, userErr("No company file is shared with AI assistants. An administrator can share one in SerieX (%s).", settingsWhere)
	case 1:
		return shared[0], nil
	}
	return companyRef{}, userErr("Several company files are shared with AI assistants: %s. Ask the user which one they mean and pass its id as \"company\".", describe(shared))
}

// where names the company file in answers: "Name (company file id x)".
func (c *call) where() string {
	return fmt.Sprintf("%s (company file id %s)", c.co.Name, c.co.ID)
}

// session returns the login token of the company file (renew: the last
// one was refused).
func (c *call) session(renew bool) error {
	if c.haveSess && !renew {
		return nil
	}
	c.haveSess = true
	c.sess = Session{}
	if c.s.opts.Sessions == nil {
		return nil
	}
	sess, err := c.s.opts.Sessions.Session(c.ctx, c.co.ID, renew)
	if err != nil {
		return userErr("SerieX could not open %s for AI assistants: %s", c.co.Name, strings.TrimSpace(err.Error()))
	}
	c.sess = sess
	return nil
}

// books calls a company route of SerieX Books (/api/c/{id}{path}). A refused
// login (401: missing, ended or expired) is renewed once; every request is
// marked (AssistantHeader), so SerieX Books never answers it without a login
// of AI assistants.
func (c *call) books(method, path string, q url.Values, body, out any) error {
	for attempt := 0; ; attempt++ {
		if err := c.session(attempt > 0); err != nil {
			return err
		}
		err := c.s.send(c.ctx, "SerieX Books", c.s.booksURL, method, "/api/c/"+url.PathEscape(c.co.ID)+path, q, body, "X-Session", c.sess.Books, out)
		var ae *apiError
		if errors.As(err, &ae) && ae.Status == http.StatusUnauthorized {
			if attempt == 0 {
				continue
			}
			return userErr("SerieX did not give AI assistants a valid login to %s (%s). Try again; if it keeps happening, an administrator can check the SerieX user AI assistants work as in SerieX (%s).", c.co.Name, strings.TrimSpace(ae.Message), settingsWhere)
		}
		return err
	}
}

func (c *call) get(path string, q url.Values, out any) error {
	return c.books(http.MethodGet, path, q, nil, out)
}

func (c *call) post(path string, q url.Values, body, out any) error {
	return c.books(http.MethodPost, path, q, body, out)
}

// payroll calls a company route of SerieX Payroll (GET only). The payroll
// token (a read-only SerieX Books token, never the Books login itself) goes
// in the X-Books-Session header: Payroll then gives a read-only session that
// never shows full social security or bank account numbers. Only an expired
// token ("books_auth") is renewed. The token of a company file with
// passwords goes only over a connection whose program proved it is SerieX
// Payroll (payrollproof.go); when it cannot, nothing is sent and the
// assistant is told why.
func (c *call) payroll(path string, q url.Values, out any) error {
	base, ok := c.s.payroll(c.ctx, false)
	if !ok {
		return userErr("SerieX Payroll is not running, so payroll information is not available. Open SerieX Payroll from the SerieX app and try again.")
	}
	for attempt := 0; ; attempt++ {
		if err := c.session(attempt > 0); err != nil {
			return err
		}
		client := c.s.http
		if c.sess.Payroll != "" && c.sess.Protected {
			client = c.s.proven
		}
		err := c.s.sendWith(c.ctx, client, "SerieX Payroll", base, http.MethodGet, "/api/c/"+url.PathEscape(c.co.ID)+path, q, nil, "X-Books-Session", c.sess.Payroll, out)
		var ae *apiError
		if !errors.As(err, &ae) {
			return err
		}
		switch {
		case ae.Code == "books_auth" && attempt == 0:
			continue
		case ae.Code == "books_auth":
			return userErr("SerieX Payroll could not check the login of AI assistants in %s with SerieX Books (%s). An administrator can check the SerieX user AI assistants work as in SerieX (%s).", c.co.Name, strings.TrimSpace(ae.Message), settingsWhere)
		case ae.Status == http.StatusUnauthorized:
			return userErr("SerieX Payroll needs a login for %s, and SerieX did not give AI assistants one. An administrator can choose the SerieX user AI assistants work as in SerieX (%s).", c.co.Name, settingsWhere)
		case ae.Status == http.StatusForbidden || ae.Code == "forbidden":
			return userErr("SerieX Payroll refused: %s (This is the SerieX user AI assistants work as in %s. An administrator can also choose another user for AI assistants in SerieX: %s.)", strings.TrimSpace(ae.Message), c.co.Name, settingsWhere)
		case ae.Status == http.StatusNotFound && strings.Contains(strings.ToLower(ae.Message), "company file not found"):
			return userErr("Payroll is not set up for %s. It can be set up in SerieX Payroll.", c.co.Name)
		}
		return err
	}
}
