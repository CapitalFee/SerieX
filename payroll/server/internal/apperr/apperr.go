// Package apperr defines the error type every API handler returns. The HTTP
// layer turns it into a JSON body {"error": message, "code": code, "field": field}.
// It uses the same error codes as SerieX Books plus two codes for the Books link.
package apperr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error codes understood by the web client.
const (
	CodeValidation  = "validation"   // 400: bad input, show message
	CodeNotFound    = "not_found"    // 404
	CodeConflict    = "conflict"     // 409: cannot do it (e.g. name in use, account has transactions)
	CodeConfirm     = "confirm"      // 409: needs a Yes/No from the user; client retries with ?force=1
	CodeClosingDate = "closing_date" // 403: on/before closing date; client asks for the closing date password and retries with header X-Closing-Password
	CodeAuth        = "auth"         // 401: login required
	CodeForbidden   = "forbidden"    // 403: signed in, but the user may not do this (e.g. not an administrator)
	CodeInternal    = "internal"     // 500

	// SerieX Books link problems (payroll only).
	CodeBooksAuth        = "books_auth"        // 401: the SerieX Books session expired; the client shows the login dialog again
	CodeBooksUnavailable = "books_unavailable" // 503: SerieX Books did not answer (not running, wrong address)
)

type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"error"`
	Field   string `json:"field,omitempty"`
}

func (e *Error) Error() string { return e.Message }

func New(status int, code, format string, args ...any) *Error {
	return &Error{Status: status, Code: code, Message: fmt.Sprintf(format, args...)}
}

// BadRequest is a generic validation failure.
func BadRequest(format string, args ...any) *Error {
	return New(http.StatusBadRequest, CodeValidation, format, args...)
}

// Validation is a validation failure tied to one input field (JSON field name).
func Validation(field, format string, args ...any) *Error {
	e := New(http.StatusBadRequest, CodeValidation, format, args...)
	e.Field = field
	return e
}

func NotFound(format string, args ...any) *Error {
	return New(http.StatusNotFound, CodeNotFound, format, args...)
}

func Conflict(format string, args ...any) *Error {
	return New(http.StatusConflict, CodeConflict, format, args...)
}

// Confirm asks the user a Yes/No question. The client re-sends the same
// request with ?force=1 when the user answers Yes.
func Confirm(format string, args ...any) *Error {
	return New(http.StatusConflict, CodeConfirm, format, args...)
}

func ClosingDate(format string, args ...any) *Error {
	return New(http.StatusForbidden, CodeClosingDate, format, args...)
}

// Forbidden: the signed-in user lacks the right (shown as a message; no login dialog).
func Forbidden(format string, args ...any) *Error {
	return New(http.StatusForbidden, CodeForbidden, format, args...)
}

func Auth(format string, args ...any) *Error {
	return New(http.StatusUnauthorized, CodeAuth, format, args...)
}

// BooksAuth reports that SerieX Books rejected the stored session.
func BooksAuth(format string, args ...any) *Error {
	return New(http.StatusUnauthorized, CodeBooksAuth, format, args...)
}

// BooksUnavailable reports that SerieX Books could not be reached.
func BooksUnavailable(format string, args ...any) *Error {
	return New(http.StatusServiceUnavailable, CodeBooksUnavailable, format, args...)
}

// As extracts an *Error from err (or returns nil).
func As(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}
