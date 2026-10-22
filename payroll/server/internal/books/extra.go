package books

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"seriexpayroll/internal/apperr"
)

// IsNotFound reports whether err is a SerieX Books "record not found" answer
// (HTTP 404 for a transaction, name or account). A missing Books company file
// is NOT treated as a missing record.
func IsNotFound(err error) bool {
	e := AsError(err)
	if e == nil {
		return false
	}
	if e.Status != http.StatusNotFound && e.Code != apperr.CodeNotFound {
		return false
	}
	return !strings.HasPrefix(e.Message, "Company file")
}

// IsUnavailable reports whether err means the Books server could not be reached.
func IsUnavailable(err error) bool {
	e := AsError(err)
	return e != nil && e.Code == CodeUnavailable
}

// IsAuth reports whether Books rejected the session token.
func IsAuth(err error) bool {
	e := AsError(err)
	return e != nil && e.Code == apperr.CodeAuth
}

// Logout ends a Books session (errors are ignored by callers: the session may
// already be gone after a Books restart).
func (c *Client) Logout(ctx context.Context, s Session) error {
	if s.Token == "" {
		return nil
	}
	return c.Do(ctx, http.MethodPost, CPath(s.CompanyID, "/logout"), &s, struct{}{}, nil, Options{})
}

// SetAccountActive makes a Books account active or inactive.
func (c *Client) SetAccountActive(ctx context.Context, s Session, id int64, active bool) (Account, error) {
	var out Account
	err := c.Do(ctx, http.MethodPut, CPath(s.CompanyID, fmt.Sprintf("/accounts/%d/active", id)), &s,
		map[string]bool{"active": active}, &out, Options{})
	return out, err
}

// SetNameActive makes a Books customer/vendor/other name active or inactive.
func (c *Client) SetNameActive(ctx context.Context, s Session, id int64, active bool) (Name, error) {
	var out Name
	err := c.Do(ctx, http.MethodPut, CPath(s.CompanyID, fmt.Sprintf("/names/%d/active", id)), &s,
		map[string]bool{"active": active}, &out, Options{})
	return out, err
}
