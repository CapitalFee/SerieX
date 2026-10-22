package assistants

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/CapitalFee/SerieX/mcp/seriexmcp"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/store"
)

// Routes (company routes, under /api/c/{cid}):
//
//	GET  /ai-assistants          the settings and how to connect (any user of the file)
//	PUT  /ai-assistants          {enabled, allowChanges, user} (administrators)
//	                             Both answer "keyVersion": it changes whenever the access key of
//	                             this company file is made, replaced or dropped ("" while it has
//	                             none), and tells nothing about the key.
//	GET  /ai-assistants/key      {key, keyVersion}: the access key of this company file (administrators, on this computer)
//	POST /ai-assistants/new-key  {key, keyVersion}: a new access key of this company file (administrators, on this computer)
//	POST /ai-assistants/setup    {target: "claudeDesktop" | "codex"} -> {file, backup, message,
//	                             result: "created" | "changed" | "unchanged"}
//	                             (administrators, on this computer, with the helper program)
//
// The key of a company file opens that company file only (while it is
// shared): an administrator of one file can never see or replace a key that
// opens another one. The helper program uses the access key in
// mcp-access.json instead, which is never shown or sent.
func (s *Service) routes(rt *httpx.Router) {
	rt.C("GET", "/ai-assistants", s.getStatus)
	rt.C("PUT", "/ai-assistants", s.putSettings)
	rt.C("GET", "/ai-assistants/key", s.getKey)
	rt.C("POST", "/ai-assistants/new-key", s.newKey)
	rt.C("POST", "/ai-assistants/setup", s.setupApp)
}

type helperJSON struct {
	Available bool     `json:"available"`
	Path      string   `json:"path"`
	Args      []string `json:"args"`
}

type setupFileJSON struct {
	File       string `json:"file"`
	Exists     bool   `json:"exists"`
	Configured bool   `json:"configured"`
}

type setupJSON struct {
	ClaudeDesktop setupFileJSON `json:"claudeDesktop"`
	Codex         setupFileJSON `json:"codex"`
}

type statusJSON struct {
	Available         bool       `json:"available"`
	UnavailableReason string     `json:"unavailableReason"`
	Enabled           bool       `json:"enabled"`
	AllowChanges      bool       `json:"allowChanges"`
	User              string     `json:"user"`
	Users             []string   `json:"users"`
	PasswordsRequired bool       `json:"passwordsRequired"`
	KeyVersion        string     `json:"keyVersion"` // see keyVersionOf
	IsAdmin           bool       `json:"isAdmin"`
	Address           string     `json:"address"`
	Helper            helperJSON `json:"helper"`
	Platform          string     `json:"platform"`
	FromThisComputer  bool       `json:"fromThisComputer"`
	Setup             *setupJSON `json:"setup"`
}

// helperReady: the assistant apps on this computer can be set up to start the helper.
func (s *Service) helperReady() bool { return s.available && s.helper.ok }

func platform() string {
	switch runtime.GOOS {
	case "darwin", "windows":
		return runtime.GOOS
	}
	return "linux"
}

// fromThisComputer: the request comes from this computer and was not passed
// on by a proxy or tunnel (which may bring it from anywhere).
func fromThisComputer(r *http.Request) bool { return seriexmcp.FromThisComputer(r) }

func (s *Service) status(c *httpx.Ctx) (statusJSON, error) {
	ctx := c.Context()
	out := statusJSON{
		Available:         s.available,
		UnavailableReason: s.reason,
		Users:             []string{},
		Address:           s.booksURL + "/mcp",
		Helper:            helperJSON{Available: s.helperReady(), Args: []string{}},
		Platform:          platform(),
		FromThisComputer:  fromThisComputer(c.R),
	}
	cs, ok, err := s.effective(ctx, c.CompanyID)
	if err != nil {
		return out, err
	}
	if ok {
		out.Enabled, out.AllowChanges, out.User = cs.Enabled, cs.Enabled && cs.AllowChanges, cs.User
	}
	if out.PasswordsRequired, err = passwordsRequired(ctx, c.DB); err != nil {
		return out, err
	}
	if ok {
		out.KeyVersion = keyVersionOf(cs, out.PasswordsRequired)
	}
	if out.IsAdmin, err = store.IsAdmin(ctx, c.DB, c.User); err != nil {
		return out, err
	}
	if out.IsAdmin {
		if out.Users, err = activeUsers(ctx, c.DB); err != nil {
			return out, err
		}
		if out.FromThisComputer && out.Helper.Available {
			// the folders of this computer (user name, data folder) only for
			// administrators sitting at it
			out.Helper.Path, out.Helper.Args = s.helper.path, s.helper.args
			if out.Helper.Args == nil {
				out.Helper.Args = []string{}
			}
			cl, cx := claudeStatus(s.helper.path, s.helper.args), codexStatus(s.helper.path, s.helper.args)
			out.Setup = &setupJSON{ClaudeDesktop: cl, Codex: cx}
		}
	}
	return out, nil
}

func (s *Service) getStatus(c *httpx.Ctx) error {
	out, err := s.status(c)
	if err != nil {
		return err
	}
	return c.JSON(out)
}

func passwordsRequired(ctx context.Context, q store.Q) (bool, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE active = 1 AND password_hash <> ''`).Scan(&n)
	return n > 0, err
}

func activeUsers(ctx context.Context, q store.Q) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT name FROM users WHERE active = 1 ORDER BY is_admin DESC, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// activeUser returns the stored name of an active user ("" when there is none).
func activeUser(ctx context.Context, q store.Q, name string) (string, error) {
	var out string
	err := q.QueryRowContext(ctx, `SELECT name FROM users WHERE name = ? AND active = 1`, strings.TrimSpace(name)).Scan(&out)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return out, err
}

// defaultUser is the user assistants work as when the administrator chose
// none: the administrator making the change in a file with passwords, else
// "Admin" (or the first active administrator).
func defaultUser(ctx context.Context, q store.Q, caller string) (string, error) {
	pw, err := passwordsRequired(ctx, q)
	if err != nil {
		return "", err
	}
	if pw {
		if u, err := activeUser(ctx, q, caller); err != nil || u != "" {
			return u, err
		}
	} else if u, err := activeUser(ctx, q, "Admin"); err != nil || u != "" {
		return u, err
	}
	var name string
	err = q.QueryRowContext(ctx, `SELECT name FROM users WHERE is_admin = 1 AND active = 1 ORDER BY id LIMIT 1`).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", apperr.Conflict("This company file has no active administrator.")
	}
	return name, err
}

// putSettings: PUT /ai-assistants {enabled, allowChanges, user}. The audit
// trail of the company file is written first; the settings file only once
// that is saved (if the settings file cannot be written, the audit trail
// says so and nothing changed).
func (s *Service) putSettings(c *httpx.Ctx) error {
	var in struct {
		Enabled      bool   `json:"enabled"`
		AllowChanges bool   `json:"allowChanges"`
		User         string `json:"user"`
	}
	if err := c.Decode(&in); err != nil {
		return err
	}
	if !in.Enabled {
		in.AllowChanges = false
	}
	ctx := c.Context()
	s.wmu.Lock()
	defer s.wmu.Unlock()
	var next companySetting
	save := false
	err := c.Write(func(tx *sql.Tx) error {
		if err := store.RequireAdmin(ctx, tx, c.User, msgAdminOnly); err != nil {
			return err
		}
		user, err := activeUser(ctx, tx, in.User)
		if err != nil {
			return err
		}
		if user == "" && strings.TrimSpace(in.User) != "" && in.Enabled {
			return apperr.Validation("user", "%q is not an active user of this company file. Choose an active user for AI assistants.", strings.TrimSpace(in.User))
		}
		if user == "" { // none chosen (or, while turning access off, one that is gone)
			if user, err = defaultUser(ctx, tx, c.User); err != nil {
				return err
			}
		}
		uid, err := store.FileUIDErr(ctx, tx)
		if err != nil {
			return err
		}
		if uid == "" {
			return apperr.Conflict("This company file has no identity yet. Close it and open it again, then try again.")
		}
		prev, had := s.settings.get(c.CompanyID)
		same := had && prev.FileUID == uid // else the saved setting was for another file under this id
		var old companySetting
		if same {
			old = prev
		}
		next = companySetting{Enabled: in.Enabled, AllowChanges: in.AllowChanges, User: user, FileUID: uid,
			ChangedAt: time.Now().UTC().Format(time.RFC3339), ChangedBy: c.User, Key: old.Key, KeyVersion: old.KeyVersion, KeyWithPasswords: old.KeyWithPasswords}
		if !old.Enabled && next.Enabled {
			// a key read earlier (perhaps while the file had no passwords and
			// anybody on this computer could read it) does not open the file
			// now shared: a new one is made when an administrator asks for it
			next.Key, next.KeyVersion, next.KeyWithPasswords = "", "", false
		}
		changes := describeChanges(old, next)
		if same && len(changes) == 0 && old.User == next.User {
			return nil // nothing changed
		}
		for _, ch := range changes {
			if err := store.Audit(ctx, tx, store.AuditEntry{User: c.User, Action: "ai_assistants", Name: ch.summary, Details: ch.details}); err != nil {
				return err
			}
		}
		save = true
		return nil
	})
	if err != nil {
		return err
	}
	if save {
		if err := s.settings.put(c.CompanyID, next); err != nil {
			log.Printf("AI assistants: could not save %s: %s", s.settings.path, plainErr(err))
			s.auditFailure(c, "AI assistants: the change above could not be saved, so nothing changed", plainErr(err))
			return apperr.Conflict("SerieX could not save the AI assistant settings (%s), so nothing changed. Try again.", plainErr(err))
		}
		// the sessions of AI assistants end at once (a saved setting that did
		// not change leaves them alone)
		s.forget(c.CompanyID)
		s.notify()
	}
	return s.getStatus(c)
}

// auditFailure records in the audit trail that a change just recorded there
// could not be saved after all.
func (s *Service) auditFailure(c *httpx.Ctx, summary, why string) {
	err := c.Write(func(tx *sql.Tx) error {
		return store.Audit(c.Context(), tx, store.AuditEntry{User: c.User, Action: "ai_assistants", Name: summary,
			Details: map[string]any{"change": "failed", "error": why}})
	})
	if err != nil {
		log.Printf("AI assistants: could not record in the audit trail of %s that a change failed: %s", c.CompanyID, plainErr(err))
	}
}

type change struct {
	summary string
	details map[string]any
}

// describeChanges lists the changes recorded in the audit trail.
func describeChanges(old, next companySetting) []change {
	var out []change
	if old.Enabled != next.Enabled {
		if next.Enabled {
			out = append(out, change{fmt.Sprintf("AI assistants: access turned on, working as %s", next.User), map[string]any{"change": "access", "before": false, "after": true, "user": next.User}})
		} else {
			out = append(out, change{"AI assistants: access turned off", map[string]any{"change": "access", "before": true, "after": false}})
		}
	}
	if old.AllowChanges != next.AllowChanges {
		if next.AllowChanges {
			out = append(out, change{"AI assistants: may make changes", map[string]any{"change": "allowChanges", "before": false, "after": true}})
		} else {
			out = append(out, change{"AI assistants: may only look", map[string]any{"change": "allowChanges", "before": true, "after": false}})
		}
	}
	if old.Enabled && next.Enabled && old.User != next.User { // (turning access on names the user above)
		out = append(out, change{fmt.Sprintf("AI assistants: work as %s", next.User), map[string]any{"change": "user", "before": old.User, "after": next.User}})
	}
	return out
}

// localAdmin checks that the caller is an administrator and on this computer.
func (s *Service) localAdmin(c *httpx.Ctx, q store.Q, notLocal string) error {
	if err := store.RequireAdmin(c.Context(), q, c.User, msgAdminOnly); err != nil {
		return err
	}
	if !fromThisComputer(c.R) {
		return apperr.Forbidden("%s", notLocal)
	}
	if site := strings.ToLower(c.R.Header.Get("Sec-Fetch-Site")); site != "" && site != "same-origin" && site != "none" {
		return apperr.Forbidden("Requests from other web pages are not allowed.")
	}
	if !s.available {
		return apperr.Conflict("%s", s.reason)
	}
	return nil
}

const msgKeyNotLocal = "The access key can only be shown on the computer where SerieX Books runs."

// companyKey returns the access key of this company file, making one when
// it has none yet (or when renew). A key made or shown while the file had no
// passwords (when anybody on this computer could read it, with no login) is
// replaced once the file has them: companyKeys no longer accepts it from
// the moment the file has a password, whatever way it was set, and a new
// one is made here.
//
// It returns the key and its version (keyVersionOf).
func (s *Service) companyKey(c *httpx.Ctx, renew bool) (key, version string, err error) {
	ctx := c.Context()
	uid, err := store.FileUIDErr(ctx, c.DB)
	if err != nil {
		return "", "", err
	}
	if uid == "" {
		return "", "", apperr.Conflict("This company file has no identity yet. Close it and open it again, then try again.")
	}
	pw, err := passwordsRequired(ctx, c.DB)
	if err != nil {
		return "", "", err
	}
	prev, had := s.settings.get(c.CompanyID)
	same := had && prev.FileUID == uid
	if same && prev.Key != "" && !renew {
		switch {
		case !pw && prev.KeyWithPasswords:
			// shown now, with no login: from here on it counts as a key made
			// without passwords (it stops working once the file has one)
			next := prev
			next.KeyWithPasswords = false
			if err := s.settings.put(c.CompanyID, next); err != nil {
				log.Printf("AI assistants: could not save %s: %s", s.settings.path, plainErr(err))
				return "", "", apperr.Conflict("SerieX could not save the AI assistant settings (%s). Try again.", plainErr(err))
			}
			return prev.Key, keyVersionOf(next, pw), nil
		case !pw || prev.KeyWithPasswords:
			return prev.Key, keyVersionOf(prev, pw), nil
		}
		log.Printf("AI assistants: the access key of %s was made or shown before the file had passwords; a new one was made", c.CompanyID)
	}
	next := companySetting{FileUID: uid, ChangedAt: time.Now().UTC().Format(time.RFC3339), ChangedBy: c.User}
	if same {
		next = prev
	}
	if key, err = seriexmcp.NewKey(); err != nil {
		return "", "", err
	}
	if version, err = newKeyVersion(); err != nil {
		return "", "", err
	}
	next.Key, next.KeyVersion, next.KeyWithPasswords = key, version, pw
	if err := s.settings.put(c.CompanyID, next); err != nil {
		log.Printf("AI assistants: could not save the access key of %s in %s: %s", c.CompanyID, s.settings.path, plainErr(err))
		return "", "", apperr.Conflict("SerieX could not save the access key (%s). Try again.", plainErr(err))
	}
	return key, version, nil
}

// keyJSON is the answer of the key routes: the key and its version (the
// "keyVersion" the status routes give while this key is the one that works).
type keyJSON struct {
	Key        string `json:"key"`
	KeyVersion string `json:"keyVersion"`
}

// getKey: GET /ai-assistants/key -> {key, keyVersion}, the access key of this company file.
// It may make a key (or mark one as shown), so it answers GET only: a HEAD
// request (which a GET route also receives) never makes or changes a key.
func (s *Service) getKey(c *httpx.Ctx) error {
	if c.R.Method != http.MethodGet {
		c.W.Header().Set("Allow", http.MethodGet)
		return apperr.New(http.StatusMethodNotAllowed, apperr.CodeValidation, "The access key can only be read with a GET request.")
	}
	if err := s.localAdmin(c, c.DB, msgKeyNotLocal); err != nil {
		return err
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	key, version, err := s.companyKey(c, false)
	if err != nil {
		return err
	}
	return c.JSON(keyJSON{Key: key, KeyVersion: version})
}

// newKey: POST /ai-assistants/new-key -> {key, keyVersion}: a new access key of this
// company file; the old one stops working at once. Assistants that were
// given the old key must be given the new one; the helper program does not
// use it (it reads the key in mcp-access.json by itself).
func (s *Service) newKey(c *httpx.Ctx) error {
	ctx := c.Context()
	s.wmu.Lock()
	defer s.wmu.Unlock()
	err := c.Write(func(tx *sql.Tx) error {
		if err := s.localAdmin(c, tx, "A new access key can only be made on the computer where SerieX Books runs."); err != nil {
			return err
		}
		return store.Audit(ctx, tx, store.AuditEntry{User: c.User, Action: "ai_assistants", Name: "AI assistants: new access key made",
			Details: map[string]any{"change": "newKey"}})
	})
	if err != nil {
		return err
	}
	key, version, err := s.companyKey(c, true)
	if err != nil {
		s.auditFailure(c, "AI assistants: the new access key could not be saved, so the old key still works", plainErr(err))
		return err
	}
	log.Printf("AI assistants: a new access key was made for %s; assistants given the old one must be given the new one", c.CompanyID)
	s.notify()
	return c.JSON(keyJSON{Key: key, KeyVersion: version})
}

// setupApp: POST /ai-assistants/setup {target} -> {file, backup, message, result}.
//
// It is allowed for a company file without passwords too, on purpose: every
// program on this computer already has full administrator access to such a
// file, and setup only ever writes the fixed entry that starts the SerieX
// helper program (this SerieX's own path and data folder) into the settings
// of the assistant app.
func (s *Service) setupApp(c *httpx.Ctx) error {
	var in struct {
		Target string `json:"target"`
	}
	if err := c.Decode(&in); err != nil {
		return err
	}
	if err := s.localAdmin(c, c.DB, "AI assistant apps can only be set up on the computer where SerieX Books runs."); err != nil {
		return err
	}
	if !s.helper.ok {
		return apperr.Conflict("This SerieX does not include the program AI assistant apps start, so they cannot be set up from here.")
	}
	var res setupResult
	var err error
	switch in.Target {
	case targetClaude:
		res, err = setupClaude(s.helper.path, s.helper.args)
	case targetCodex:
		res, err = setupCodex(s.helper.path, s.helper.args)
	default:
		return apperr.Validation("target", "Unknown AI assistant app %q.", in.Target)
	}
	if err != nil {
		return err
	}
	log.Printf("AI assistants: %s set up to use SerieX (settings file %s: %s)", appName(in.Target), res.File, res.Result)
	return c.JSON(res)
}
