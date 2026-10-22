// Package apperr defines the error type every API handler returns. The HTTP
// layer turns it into a JSON body {"error": message, "code": code, "field": field}.
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
	CodeForbidden   = "forbidden"    // 403: the user is logged in but may not do this (administrator only, ...)
	CodeInternal    = "internal"     // 500
)

type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"error"`
	Field   string `json:"field,omitempty"`
	// Warning names the kind of question of a CodeConfirm error (see the Warn*
	// constants). The client may send it back in ?accept=a,b to answer Yes to
	// that question only; ?force=1 still answers Yes to every question.
	Warning string `json:"warning,omitempty"`
	// Data carries extra details for the client (e.g. the existing record of a
	// "name already in use" error).
	Data map[string]any `json:"data,omitempty"`
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

// Warning kinds of Confirm questions (Error.Warning).
const (
	WarnDuplicateNumber = "dupnum"      // duplicate invoice / PO / bill / check number
	WarnCreditLimit     = "creditlimit" // customer over its credit limit
	WarnInventory       = "inventory"   // selling more than the quantity on hand
	WarnInactive        = "inactive"    // using an inactive account, name or item
	WarnReconciled      = "reconciled"  // changing / removing reconciled entries
	WarnDeposited       = "deposited"   // changing / removing a deposited payment
	WarnApplied         = "applied"     // removing a transaction with payments or credits applied
	WarnClosing         = "closing"     // closing date without a password
	WarnAccount         = "account"     // a bank file for another account number
)

// ConfirmKind is Confirm with a warning kind (see Error.Warning).
func ConfirmKind(kind, format string, args ...any) *Error {
	e := New(http.StatusConflict, CodeConfirm, format, args...)
	e.Warning = kind
	return e
}

// Forbidden: the user may not do this (403).
func Forbidden(format string, args ...any) *Error {
	return New(http.StatusForbidden, CodeForbidden, format, args...)
}

func ClosingDate(format string, args ...any) *Error {
	return New(http.StatusForbidden, CodeClosingDate, format, args...)
}

func Auth(format string, args ...any) *Error {
	return New(http.StatusUnauthorized, CodeAuth, format, args...)
}

// As extracts an *Error from err (or returns nil).
func As(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return nil
}
