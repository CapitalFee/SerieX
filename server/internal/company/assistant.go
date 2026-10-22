package company

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/store"
)

// Sessions of AI assistants.
//
// The AI assistant connection built into this server (package assistants)
// works as the SerieX user an administrator chose, through sessions made by
// AssistantSession. These sessions are marked, and this server enforces what
// they may do itself (checkAssistantRequest), whatever the assistant tools
// send: they never answer the closing date question, never send the closing
// date password, never change users, preferences, the closing date or the
// company file, and only make the changes the tools make, when an
// administrator allowed changes. Every transaction they save shows in the
// audit trail as "<user> (AI assistant)" (new customers, vendors and items
// are not in the audit trail, as for people).

// ErrAssistantUser: the SerieX user chosen for AI assistants does not exist
// (any more) or is inactive.
var ErrAssistantUser = errors.New("the SerieX user chosen for AI assistants no longer exists or is inactive")

// AssistantAccess is what the AI assistant sessions of a company file may do.
type AssistantAccess struct {
	AllowChanges bool // an administrator allowed changes (else they only look)
}

type assistantKind uint8

const (
	notAssistant     assistantKind = iota
	assistantBooks                 // used by the assistant connection of this server, for its requests to this server
	assistantPayroll               // handed to SerieX Payroll: reads only, short-lived
)

// assistantHeader marks the requests the AI assistant connection of this
// server sends to it (seriexmcp.AssistantHeader, "1"). authenticate answers
// such a request only with a valid session of AI assistants: when that
// session is missing or ended, it gets 401 (the tools then ask for a new
// login, checked against the settings again), never the "Admin" of a file
// without passwords. Requests without the header are not affected.
const assistantHeader = "X-SerieX-Assistant"

// msgAssistantLogin answers a marked request without a valid session of AI assistants.
const msgAssistantLogin = "The login of AI assistants to this company file has ended. Try again."

// payrollTokenMax is how long the token handed to SerieX Payroll works. The
// assistant connection asks for a new one when it expires.
const payrollTokenMax = 30 * time.Minute

// AssistantSession logs the active user named user in to a company file
// without a password, for AI assistants, and returns two session tokens:
// books, for the requests the assistant connection of this server sends to
// this server, and payroll, for SerieX Payroll, which can only read and
// works for 30 minutes (Payroll asks with it whose token it is, and reads
// the books with it). Both are bound to the file's identity (store.FileUID),
// like a login, so a restored or copied file does not accept them. Tokens
// made while the file had no passwords end as soon as it has one.
//
// Only the AI assistant connection built into this server calls it: an
// administrator chose this user for AI assistants under AI Assistants.
// Never call it for a request that comes from outside this
// server.
func AssistantSession(ctx context.Context, companyID string, db *sql.DB, user string, access AssistantAccess) (books, payroll string, err error) {
	user = strings.TrimSpace(user)
	if user == "" {
		return "", "", ErrAssistantUser
	}
	var id int64
	err = db.QueryRowContext(ctx, `SELECT id FROM users WHERE name = ? AND active = 1`, user).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrAssistantUser
	}
	if err != nil {
		return "", "", err
	}
	uid, err := store.FileUIDErr(ctx, db)
	if err != nil {
		return "", "", err
	}
	pw, err := authRequired(ctx, db)
	if err != nil {
		return "", "", err
	}
	books = addSession(session{companyID: companyID, fileUID: uid, userID: id, assistant: assistantBooks, allowChanges: access.AllowChanges, noPasswords: !pw})
	payroll = addSession(session{companyID: companyID, fileUID: uid, userID: id, assistant: assistantPayroll, maxAge: payrollTokenMax, noPasswords: !pw})
	return books, payroll, nil
}

// SessionValid reports whether token is a session of companyID that has not
// ended or expired (it counts as a use of the session).
func SessionValid(token, companyID string) bool {
	s, ok := lookupSession(token)
	return ok && s.companyID == companyID
}

// EndSession ends a session (like a logout).
func EndSession(token string) {
	if token != "" {
		dropSession(token)
	}
}

// assistantWrites are the requests other than reads that AI assistant
// sessions may send, and only when an administrator allowed changes: the
// changes the tools for AI assistants make (mcp/seriexmcp/tools_write.go).
// A new tool that saves something else must be added here.
var assistantWrites = map[string]bool{
	"POST /api/c/{cid}/txns":           true, // create invoices, receipts, payments, bills, checks, journal entries...
	"POST /api/c/{cid}/txns/{id}/void": true,
	"POST /api/c/{cid}/names":          true, // new customer or vendor
	"POST /api/c/{cid}/items":          true,
	"POST /api/c/{cid}/pay-bills":      true,
}

// checkAssistantRequest enforces what an AI assistant session may do.
func checkAssistantRequest(r *http.Request, s session) error {
	// the path of the route: r.Pattern is "<METHOD> <path>", and a GET
	// route also serves HEAD requests (r.Method "HEAD", pattern "GET ...")
	_, route, _ := strings.Cut(r.Pattern, " ")
	route = strings.TrimSpace(route)
	if route == "" {
		return forbidden("AI assistants cannot make this request.")
	}
	if strings.HasPrefix(route, "/api/c/{cid}/ai-assistants") {
		return forbidden("AI assistants cannot see or change their own access. An administrator does that in SerieX (AI Assistants).")
	}
	if r.Header.Get("X-Closing-Password") != "" || r.URL.Query().Has("force") || acceptsClosing(r) {
		return forbidden("Changes dated on or before the closing date can only be made in SerieX itself, not by AI assistants.")
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return nil
	}
	switch {
	case s.assistant == assistantPayroll:
		return forbidden("This login of AI assistants can only read.")
	case !s.allowChanges:
		return forbidden("AI assistants may only look at the books of this company file. An administrator can allow changes in SerieX (AI Assistants).")
	case !assistantWrites[r.Pattern]:
		return forbidden("AI assistants cannot make this change. Make it in SerieX itself.")
	}
	return nil
}

// acceptsClosing: the request answers Yes to the closing date question.
func acceptsClosing(r *http.Request) bool {
	for _, src := range append(r.URL.Query()["accept"], r.Header.Values("X-Accept")...) {
		for _, p := range strings.Split(src, ",") {
			if strings.EqualFold(strings.TrimSpace(p), apperr.WarnClosing) {
				return true
			}
		}
	}
	return false
}

// assistantContext is installed as rt.Context: requests made with an AI
// assistant session get a context the audit trail recognizes.
func assistantContext(r *http.Request, companyID string) context.Context {
	tok := strings.TrimSpace(r.Header.Get("X-Session"))
	if tok == "" {
		return nil
	}
	s, ok := peekSession(tok)
	if !ok || s.companyID != companyID || s.assistant == notAssistant {
		return nil
	}
	return store.WithAssistant(r.Context())
}
