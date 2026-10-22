// Package assistants connects AI assistant apps on this computer (Claude,
// ChatGPT, Codex and others) to SerieX Books: it serves the SerieX tools for
// AI assistants (package seriexmcp) at /mcp and the company routes behind
// AI Assistants (/api/c/{cid}/ai-assistants...).
//
// What assistants may do is decided per company file by an administrator and
// kept in <Books data>/ai-assistants.json, outside the company files on
// purpose: a copied or restored company file never arrives with assistant
// access on (each entry is bound to the file's identity, store.FileUID).
// Assistants work as a SerieX user the administrator chose, through a Books
// session of AI assistants (company.AssistantSession), so the permissions of
// that user, the closing date and the audit trail apply as in the app, and
// SerieX Books itself limits what such a session may do.
//
// Access keys: the helper program (seriex-mcp) proves it holds the access
// key in <Books data>/mcp-access.json, which only this computer account can
// read and which opens every shared company file; that key is never shown
// or sent anywhere. Assistants set up with the web address and a key use
// the key of one company file (kept in ai-assistants.json, shown only to
// administrators of that file), which opens that company file only.
package assistants

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/CapitalFee/SerieX/mcp/seriexmcp"

	"seriex/internal/apperr"
	"seriex/internal/company"
	"seriex/internal/httpx"
	"seriex/internal/store"
)

// SettingsFileName is the AI assistant settings file in the Books data folder.
const SettingsFileName = "ai-assistants.json"

// Config is how SerieX Books was started.
type Config struct {
	On         bool   // -mcp: false turns the assistant connection off
	Host       string // -host
	Port       int    // -port
	PayrollURL string // -payroll ("" when none)
	HelperPath string // -mcp-helper ("" when the app does not carry the helper)
	Version    string // version of SerieX Books
}

// Plain messages.
const (
	msgAdminOnly   = "Only an administrator can change AI assistant access."
	msgOff         = "The connection for AI assistants was turned off when SerieX Books was started. To turn it back on, start SerieX from the SerieX app, or ask whoever set up this SerieX Books server."
	msgNetworkHost = "AI assistants can connect only when SerieX Books accepts connections from this computer alone (the normal setup)."
	msgUserGone    = "The SerieX user chosen for AI assistants no longer exists or is inactive. An administrator can choose another one under AI Assistants."
	msgNotShared   = "This company file is not shared with AI assistants. An administrator can share it under AI Assistants."
)

// Service is the AI assistant connection of one SerieX Books server.
type Service struct {
	cfg       Config
	mgr       *store.Manager
	available bool
	reason    string // why the connection is off ("" when available)
	offCode   string // error code of /mcp while off (seriexmcp.CodeAssistants...)
	booksURL  string // http://127.0.0.1:<port>
	settings  *settingsStore
	keys      *seriexmcp.KeyFile // nil when the key file could not be opened
	notify    func()             // seriexmcp.NotifyChanged of the server (no-op when off)
	handler   http.Handler       // /mcp
	helper    helperInfo

	smu      sync.Mutex
	sessions map[string]cachedSession // company id -> sessions of its assistant user
	gen      uint64                   // counts forget calls (settings saved), guarded by smu

	wmu sync.Mutex // changes of the settings and keys (company file first, then ai-assistants.json)
}

type cachedSession struct {
	books     string // for the requests of the assistant connection to this server
	payroll   string // read-only, for SerieX Payroll
	userID    int64
	fileUID   string
	allow     bool // made while changes were allowed
	protected bool // made while the file had passwords
}

// helperInfo describes the seriex-mcp helper program the assistant apps start.
type helperInfo struct {
	path string   // absolute path ("" when not given or not usable)
	ok   bool     // the setup of assistant apps can use it
	args []string // ["--data", <data root>] when the data root is not the default one
}

// Register sets up the AI assistant connection: the company routes and /mcp.
// Call it before the web app's catch-all route is added.
func Register(rt *httpx.Router, mgr *store.Manager, cfg Config) *Service {
	s := &Service{cfg: cfg, mgr: mgr, notify: func() {}, sessions: map[string]cachedSession{}}
	s.settings = openSettings(filepath.Join(mgr.Dir(), SettingsFileName))

	host := strings.Trim(strings.TrimSpace(cfg.Host), "[]")
	switch {
	case !cfg.On:
		s.reason, s.offCode = msgOff, seriexmcp.CodeAssistantsOff
	case !localOrAll(host):
		s.reason, s.offCode = msgNetworkHost, seriexmcp.CodeAssistantsNetwork
	default:
		s.available = true
	}
	urlHost := "127.0.0.1"
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() && ip.To4() == nil {
		urlHost = "[::1]" // listening on ::1 only
	}
	s.booksURL = "http://" + net.JoinHostPort(strings.Trim(urlHost, "[]"), strconv.Itoa(cfg.Port))
	s.helper = findHelper(cfg.HelperPath, mgr.Dir())

	if s.available {
		keyPath := filepath.Join(mgr.Dir(), seriexmcp.KeyFileName)
		keys, err := seriexmcp.OpenKeyFile(keyPath)
		if err != nil {
			log.Printf("AI assistants: could not open the access key file %s (%v); AI assistants cannot connect until it can be read.", keyPath, plainErr(err))
		} else {
			s.keys = keys
		}
		logger := slog.New(logHandler{})
		srv := seriexmcp.NewServer(seriexmcp.Options{
			BooksURL:         s.booksURL,
			PayrollURL:       strings.TrimSpace(cfg.PayrollURL),
			PayrollProofFile: payrollProofFile(mgr.Dir()),
			Sessions:         seriexmcp.SessionFunc(s.session),
			Policy:           seriexmcp.PolicyFunc(s.access),
			Version:          cfg.Version,
			Logger:           logger,
		})
		s.notify = func() { seriexmcp.NotifyChanged(srv) }
		var key seriexmcp.KeyProvider = seriexmcp.KeyFunc(func() string { return "" })
		if s.keys != nil {
			key = s.keys
		}
		s.handler = seriexmcp.Handler(seriexmcp.HTTPOptions{Options: seriexmcp.Options{Logger: logger}, Server: srv, Key: key,
			CompanyKeys: s.companyKeys})
		log.Printf("AI assistants: apps on this computer can connect at %s/mcp (company files are shared under AI Assistants)", s.booksURL)
	} else {
		off := apperr.New(http.StatusNotFound, s.offCode, "%s", s.reason)
		s.handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			httpx.WriteJSON(w, http.StatusNotFound, off)
		})
		log.Printf("AI assistants: off. %s", s.reason)
	}
	rt.Mux.Handle("/mcp", s.handler)
	s.routes(rt)
	return s
}

// payrollProofFile is the file SerieX Payroll proves who it is with:
// <data root>/payroll/assistant-proof.key, where the data root is the folder
// that holds the Books data folder when that folder is named books (as the
// SerieX app sets it up). "" when unknown: then files with passwords share
// no payroll details with AI assistants (see seriexmcp payrollproof.go).
func payrollProofFile(booksDir string) string {
	if !strings.EqualFold(filepath.Base(booksDir), "books") {
		log.Printf("AI assistants: the company files are not in a folder named books (they are in %s), so SerieX cannot check that the program at the payroll address is SerieX Payroll; payroll details of company files with passwords are not shared with AI assistants.", booksDir)
		return ""
	}
	return filepath.Join(filepath.Dir(booksDir), "payroll", seriexmcp.PayrollProofFileName)
}

// localOrAll: -host listens on this computer only (loopback) or on every
// address (0.0.0.0, ::), which includes this computer's own address.
func localOrAll(host string) bool {
	if host == "" || strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}

// findHelper checks the -mcp-helper program (one warning when it cannot be used).
func findHelper(path, booksDir string) helperInfo {
	var h helperInfo
	path = strings.TrimSpace(path)
	if path == "" {
		return h
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	fi, err := os.Stat(abs)
	switch {
	case err != nil:
		log.Printf("AI assistants: the helper program %s was not found; AI assistant apps cannot be set up from SerieX.", abs)
		return h
	case !fi.Mode().IsRegular() || (runtime.GOOS != "windows" && fi.Mode().Perm()&0o111 == 0):
		log.Printf("AI assistants: the helper program %s cannot be run; AI assistant apps cannot be set up from SerieX.", abs)
		return h
	}
	h.path = abs
	// the helper reads the access key from <data root>/books/mcp-access.json
	if !strings.EqualFold(filepath.Base(booksDir), "books") {
		log.Printf("AI assistants: the helper program finds SerieX only when the company files are in a folder named books (they are in %s); AI assistant apps cannot be set up from SerieX.", booksDir)
		return h
	}
	root := filepath.Dir(booksDir)
	h.ok = true
	h.args = []string{}
	if !sameDir(root, seriexmcp.DefaultDataDir()) {
		h.args = []string{"--data", root}
	}
	return h
}

// sameDir: a and b are the same folder.
func sameDir(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	fa, err1 := os.Stat(a)
	fb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(fa, fb)
}

// companyKeys lists the access keys of single company files (company id ->
// key), for seriexmcp.HTTPOptions.CompanyKeys (asked on every request to
// /mcp). The policy decides at every call whether the company file is still
// shared (and still the same file).
//
// A key made while its company file had no passwords is left out once the
// file has one, whatever way the password was set (Users window, a restored
// backup, a user made active again...): anybody on this computer could read
// such a key, since a file without passwords has no login.
func (s *Service) companyKeys() map[string]string {
	out := map[string]string{}
	for id, cs := range s.settings.all() {
		if cs.Key == "" {
			continue
		}
		if !cs.KeyWithPasswords {
			if pw, err := s.hasPasswords(context.Background(), id); err != nil || pw {
				continue
			}
		}
		out[id] = cs.Key
	}
	return out
}

// hasPasswords: an active user of the company file has a password (false
// when the file does not exist).
func (s *Service) hasPasswords(ctx context.Context, companyID string) (bool, error) {
	if !s.mgr.Exists(companyID) {
		return false, nil
	}
	db, err := s.mgr.Open(companyID)
	if err != nil {
		return false, err
	}
	return passwordsRequired(ctx, db)
}

// ---------------------------------------------------------------------------
// What assistants may do (seriexmcp.Policy) and the session they use

// effective is the saved setting of a company file, when it still applies to
// the file (same identity); ok is false otherwise.
func (s *Service) effective(ctx context.Context, companyID string) (companySetting, bool, error) {
	cs, ok := s.settings.get(companyID)
	if !ok {
		return companySetting{}, false, nil
	}
	if !s.mgr.Exists(companyID) {
		return companySetting{}, false, nil
	}
	db, err := s.mgr.Open(companyID)
	if err != nil {
		return companySetting{}, false, err
	}
	uid, err := store.FileUIDErr(ctx, db)
	if err != nil {
		return companySetting{}, false, err
	}
	if uid == "" || uid != cs.FileUID {
		return companySetting{}, false, nil // another file under this id (copied, restored, re-created)
	}
	return cs, true, nil
}

// access is the seriexmcp.Policy: a company file is shared when an
// administrator turned access on for this very file.
func (s *Service) access(ctx context.Context, companyID string) (seriexmcp.Access, error) {
	cs, ok, err := s.effective(ctx, companyID)
	if err != nil || !ok || !cs.Enabled {
		return seriexmcp.Access{}, err
	}
	db, err := s.mgr.Open(companyID)
	if err != nil {
		return seriexmcp.Access{}, err
	}
	user, err := activeUser(ctx, db, cs.User)
	if err != nil {
		return seriexmcp.Access{}, err
	}
	return seriexmcp.Access{Enabled: true, AllowChanges: cs.AllowChanges, UserGone: user == ""}, nil
}

// session is the seriexmcp.SessionProvider: sessions of AI assistants for
// the user the administrator chose, also for files without passwords (so
// SerieX Payroll always knows the caller is an AI assistant and applies its
// read-only rules). The Books session stays in this server; Payroll gets a
// separate token that can only read.
//
// The tokens are shared by every tool call on the company file. New ones are
// made only when the cached ones no longer work or no longer match the
// settings, even when renew is asked (a token was refused): several tool
// calls that saw their token refused at the same time (its settings changed,
// or it expired) then all get the same new tokens, instead of each one
// ending the tokens another call has just received.
func (s *Service) session(ctx context.Context, companyID string, _ bool) (seriexmcp.Session, error) {
	// settings saved while this call read them: read them again, so tokens
	// made from settings that were just replaced never end newer ones
	for try := 0; ; try++ {
		sess, stale, err := s.sessionFrom(ctx, companyID, try < 5)
		if !stale {
			return sess, err
		}
	}
}

// sessionFrom is one try of session. When checkStale is true and the
// settings were saved after this try read them, it does nothing and returns
// stale true.
func (s *Service) sessionFrom(ctx context.Context, companyID string, checkStale bool) (sess seriexmcp.Session, stale bool, err error) {
	s.smu.Lock()
	gen := s.gen
	s.smu.Unlock()
	cs, ok, err := s.effective(ctx, companyID)
	if err != nil {
		return seriexmcp.Session{}, false, err
	}
	if !ok || !cs.Enabled {
		return seriexmcp.Session{}, false, errors.New(msgNotShared)
	}
	db, err := s.mgr.Open(companyID)
	if err != nil {
		return seriexmcp.Session{}, false, err
	}
	var userID int64
	err = db.QueryRowContext(ctx, `SELECT id FROM users WHERE name = ? AND active = 1`, cs.User).Scan(&userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return seriexmcp.Session{}, false, errors.New(msgUserGone)
		}
		return seriexmcp.Session{}, false, err
	}
	// a file with passwords: its payroll token goes only to a SerieX Payroll
	// that proves who it is (seriexmcp.Options.PayrollProofKey)
	protected, err := passwordsRequired(ctx, db)
	if err != nil {
		return seriexmcp.Session{}, false, err
	}
	allow := cs.Enabled && cs.AllowChanges
	s.smu.Lock()
	defer s.smu.Unlock()
	if checkStale && s.gen != gen {
		return seriexmcp.Session{}, true, nil
	}
	old := s.sessions[companyID]
	// a file that got passwords since gets new tokens: the old payroll token
	// may have gone to a program that did not prove it is SerieX Payroll,
	// which was fine only while the file had no secret. Valid tokens that
	// still match are kept even when renew is asked: the refused token was
	// an older one (ended by a change of the settings, or expired), and these
	// may be in use by other tool calls right now.
	if old.books != "" && old.userID == userID && old.fileUID == cs.FileUID && old.allow == allow &&
		old.protected == protected &&
		company.SessionValid(old.books, companyID) && company.SessionValid(old.payroll, companyID) {
		return seriexmcp.Session{Books: old.books, Payroll: old.payroll, Protected: protected}, false, nil
	}
	company.EndSession(old.books)
	company.EndSession(old.payroll)
	delete(s.sessions, companyID)
	books, payroll, err := company.AssistantSession(ctx, companyID, db, cs.User, company.AssistantAccess{AllowChanges: allow})
	if err != nil {
		if errors.Is(err, company.ErrAssistantUser) {
			return seriexmcp.Session{}, false, errors.New(msgUserGone)
		}
		return seriexmcp.Session{}, false, err
	}
	s.sessions[companyID] = cachedSession{books: books, payroll: payroll, userID: userID, fileUID: cs.FileUID, allow: allow, protected: protected}
	return seriexmcp.Session{Books: books, Payroll: payroll, Protected: protected}, false, nil
}

// forget ends the cached sessions of a company file (its settings changed).
func (s *Service) forget(companyID string) {
	s.smu.Lock()
	defer s.smu.Unlock()
	s.gen++
	old := s.sessions[companyID]
	company.EndSession(old.books)
	company.EndSession(old.payroll)
	delete(s.sessions, companyID)
}

// ---------------------------------------------------------------------------
// Log: one plain line per tool call (tool, company file id, result), never
// the access key, the arguments or the answers.

type logHandler struct{}

func (logHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= slog.LevelInfo }
func (h logHandler) WithAttrs([]slog.Attr) slog.Handler         { return h }
func (h logHandler) WithGroup(string) slog.Handler              { return h }

func (logHandler) Handle(_ context.Context, r slog.Record) error {
	if r.Message == "tool call" {
		var tool, co, result, ms string
		r.Attrs(func(a slog.Attr) bool {
			switch a.Key {
			case "tool":
				tool = a.Value.String()
			case "company":
				co = a.Value.String()
			case "result":
				result = a.Value.String()
			case "ms":
				ms = a.Value.String()
			}
			return true
		})
		where := ""
		if co != "" {
			where = " on " + co
		}
		log.Printf("AI assistant: %s%s: %s (%s ms)", oneLine(tool, 80), oneLine(where, 80), oneLine(result, 20), oneLine(ms, 12))
		return nil
	}
	if r.Level < slog.LevelWarn {
		return nil
	}
	line := oneLine(r.Message, 200)
	r.Attrs(func(a slog.Attr) bool {
		if a.Key == "company" || a.Key == "error" {
			line += fmt.Sprintf(" (%s: %s)", a.Key, oneLine(a.Value.String(), 200))
		}
		return true
	})
	log.Printf("AI assistants: %s", line)
	return nil
}

// oneLine keeps a log value on one line and short.
func oneLine(s string, max int) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

// plainErr is an error for a log line.
func plainErr(err error) string { return oneLine(err.Error(), 300) }
