// Package seriexmcp is the SerieX Model Context Protocol (MCP) server: tools
// that let an AI assistant read the books kept in SerieX Books and SerieX
// Payroll and, for company files where an administrator allows it, record
// common transactions.
//
// The tools call the JSON API of SerieX Books (and SerieX Payroll) on this
// computer over HTTP, exactly like the SerieX web client, so every rule of
// the books (closing date, warnings, permissions of the SerieX user) applies.
//
// The SerieX Books server serves it over MCP Streamable HTTP (see Handler),
// protected by an access key kept in a file (see KeyFile). The seriex-mcp
// program (cmd/seriex-mcp) offers the same tools over stdio for assistants
// that start a local program.
package seriexmcp

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Options configures NewServer.
type Options struct {
	// BooksURL is the address of SerieX Books, for example
	// http://127.0.0.1:47180 (required to answer tool calls).
	BooksURL string
	// PayrollURL is the address of SerieX Payroll. When empty, the address
	// SerieX Books reports in GET /api/info is used (none: no payroll tools).
	// Either is used only when it is on this computer (loopback), since the
	// payroll login of AI assistants (Session.Payroll) is sent there.
	PayrollURL string
	// PayrollProofFile is the file holding the secret SerieX Payroll proves
	// who it is with (<Payroll data folder>/assistant-proof.key, see
	// PayrollProofFileName). The payroll token of a company file with
	// passwords (Session.Protected) is sent only over a connection whose
	// program proved it knows that secret; "" (unknown): such tokens are
	// never sent.
	PayrollProofFile string
	// Sessions gives the login tokens the tools use for a company file.
	// nil: no token is sent, and SerieX Books refuses the requests of the
	// tools to company files (it answers them only with a login of AI
	// assistants, see AssistantHeader).
	Sessions SessionProvider
	// Policy says which company files AI assistants may use and change.
	// nil: no company file is shared (see ShareAllForDevelopment).
	Policy Policy
	// ShareAllForDevelopment shares every company file (to look at only)
	// when Policy is nil. For development and tests only: never set it in a
	// build given to users.
	ShareAllForDevelopment bool
	// Version is the SerieX version reported to the assistant.
	Version string
	// Logger receives one line per tool call (nil: no logging).
	Logger *slog.Logger
	// HTTPClient is used to call SerieX Books and Payroll (nil: a client
	// with a 90 second timeout that never follows redirects and never uses
	// a proxy). Redirects are refused even with a client given here.
	HTTPClient *http.Client
}

// Session holds the login tokens of one company file.
//
// Books is sent to SerieX Books only (header X-Session). Payroll is sent to
// SerieX Payroll only (header X-Books-Session): it should be a separate
// SerieX Books token that can only read, so the Books login itself never
// leaves SerieX Books. Payroll asks SerieX Books whose token it is and gives
// AI assistants a read-only session that never shows full social security
// or bank account numbers. Empty tokens mean none is sent (the Books server
// should still give both for company files without passwords, so Payroll
// always knows the caller is an AI assistant).
//
// Protected tells that the company file has passwords: its payroll token
// then goes only to a program that proves it is SerieX Payroll (see
// Options.PayrollProofFile). A file without passwords has no secret to
// protect (any program on this computer can open it), so its token is sent
// to the payroll address as it is.
type Session struct {
	Books     string // token for SerieX Books ("" when none)
	Payroll   string // read-only token for SerieX Payroll ("" when none)
	Protected bool   // the company file has passwords
}

// SessionProvider gives the token the tools use for a company file.
//
// Session is called at the start of every tool call that needs the company
// file; implementations should keep returning the same token while it is
// valid. renew is true when the token returned before was refused (expired,
// logged out, or ended by a change of the settings). It is a hint: a
// provider may return a token it knows is still valid (another call may
// already have made a new one). An error is shown to the assistant as is,
// so it should be a plain sentence.
type SessionProvider interface {
	Session(ctx context.Context, companyID string, renew bool) (Session, error)
}

// SessionFunc adapts a function to SessionProvider.
type SessionFunc func(ctx context.Context, companyID string, renew bool) (Session, error)

// Session calls f.
func (f SessionFunc) Session(ctx context.Context, companyID string, renew bool) (Session, error) {
	return f(ctx, companyID, renew)
}

// Access is what AI assistants may do with one company file.
type Access struct {
	Enabled      bool // the company file is shared with AI assistants (read)
	AllowChanges bool // ...and they may record transactions and list entries
	// UserGone: the SerieX user chosen for AI assistants no longer exists or
	// is inactive, so the shared file cannot be used until an administrator
	// chooses another user.
	UserGone bool
}

// Policy tells what AI assistants may do with each company file. It is
// asked on every tool call, so a change in SerieX applies at once.
type Policy interface {
	Access(ctx context.Context, companyID string) (Access, error)
}

// PolicyFunc adapts a function to Policy.
type PolicyFunc func(ctx context.Context, companyID string) (Access, error)

// Access calls f.
func (f PolicyFunc) Access(ctx context.Context, companyID string) (Access, error) {
	return f(ctx, companyID)
}

// The tool list follows the state of SerieX: the payroll tools are listed
// while SerieX Payroll answers, and the tools that make changes while at
// least one company file allows changes. The state is checked when the
// assistant lists or calls tools (at most every refreshEvery) and by
// NotifyChanged. A call to a tool that was just taken off the list still
// reaches it, so it can explain why it cannot be used.
const refreshEvery = 5 * time.Second

// handshakeVersions are the MCP protocol versions offered: the ones that
// start with an initialize handshake, so the server may ask the user a
// question during a tool call (elicitation) and send tool list changes.
var handshakeVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// service is the state behind one *mcp.Server.
type service struct {
	opts     Options
	log      *slog.Logger
	http     *http.Client
	probe    *http.Client
	proven   *http.Client // payroll tokens of files with passwords (see payrollproof.go)
	server   *mcp.Server
	booksURL string

	defs   []toolDef
	byName map[string]toolDef

	confirms confirmStore

	tmu       sync.Mutex // tool groups
	groupOn   map[toolGroup]bool
	checkedAt time.Time

	pmu        sync.Mutex // payroll address
	payrollURL string
	payrollVer string
	payrollAt  time.Time
	payrollOK  bool
}

var services sync.Map // *mcp.Server -> *service

// NewServer returns the SerieX MCP server. Serve it with Handler (Streamable
// HTTP) or run it on any other MCP transport.
func NewServer(opts Options) *mcp.Server {
	s := newService(opts)
	services.Store(s.server, s)
	return s.server
}

// NotifyChanged re-checks at once which tools the assistant should see (call
// it after an administrator changed the AI assistant settings, or when SerieX
// Payroll started or stopped). Connected assistants are told when the tool
// list changes. It waits for SerieX to answer (a few seconds at most).
func NotifyChanged(srv *mcp.Server) {
	if v, ok := services.Load(srv); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		v.(*service).refresh(ctx, true)
	}
}

// noRedirect refuses to follow a redirect: the login token must never be
// sent anywhere but the SerieX server asked.
func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// localTransport talks only to this computer: no proxy, short connect time.
// It keeps up to 16 idle connections per server (not 2), so tool calls of
// several assistants at the same time reuse their connections instead of
// opening a new one per request.
func localTransport() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.Proxy = nil
	t.MaxIdleConnsPerHost = 16
	return t
}

func newService(opts Options) *service {
	s := &service{opts: opts, groupOn: map[toolGroup]bool{}, byName: map[string]toolDef{}}
	s.log = opts.Logger
	if s.log == nil {
		s.log = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opts.HTTPClient != nil {
		c := *opts.HTTPClient
		c.CheckRedirect = noRedirect
		s.http = &c
	} else {
		s.http = &http.Client{Timeout: 90 * time.Second, Transport: localTransport(), CheckRedirect: noRedirect}
	}
	s.probe = &http.Client{Timeout: 2 * time.Second, Transport: s.http.Transport, CheckRedirect: noRedirect}
	s.proven = provenPayrollClient(opts.PayrollProofFile, s.log)
	s.booksURL = strings.TrimRight(strings.TrimSpace(opts.BooksURL), "/")
	version := strings.TrimSpace(opts.Version)
	if version == "" {
		version = "dev"
	}
	s.server = mcp.NewServer(&mcp.Implementation{Name: "seriex", Title: "SerieX", Version: version}, &mcp.ServerOptions{
		Instructions:              Instructions,
		Capabilities:              &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{ListChanged: true}},
		SupportedProtocolVersions: handshakeVersions,
	})
	s.defs = s.catalog()
	for _, d := range s.defs {
		s.byName[d.tool.Name] = d
		if d.group == groupBooks {
			d.add(s.server)
		}
	}
	s.server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			if method == "tools/list" || method == "tools/call" {
				s.refresh(ctx, false)
			}
			ctx = withCompanyScope(ctx, req)
			if cr, ok := req.(*mcp.CallToolRequest); ok && method == "tools/call" && cr.Params != nil {
				if kind := agreesToAppOnly(cr.Params.Arguments); kind != "" {
					// answered before the arguments are checked against the tool's
					// input (which does not offer these kinds), so the reason is plain
					s.log.Info("tool call", "tool", cr.Params.Name, "company", "", "ms", 0, "result", "refused")
					return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: appOnlyRefusal(kind, "").Error()}}}, nil
				}
			}
			res, err := next(ctx, method, req)
			if method == "tools/call" && isUnknownTool(err) {
				// a tool taken off the list (changes no longer allowed, Payroll
				// stopped) still answers, to say why it cannot be used
				if cr, ok := req.(*mcp.CallToolRequest); ok && cr.Params != nil {
					if d, ok := s.byName[cr.Params.Name]; ok {
						return d.raw(ctx, cr)
					}
				}
			}
			return res, err
		}
	})
	return s
}

// isUnknownTool: the error the MCP server gives for a tool it does not list.
func isUnknownTool(err error) bool {
	var werr *jsonrpc.Error
	return errors.As(err, &werr) && werr.Code == jsonrpc.CodeInvalidParams && strings.Contains(werr.Message, "unknown tool")
}

// catalog builds every tool definition.
func (s *service) catalog() []toolDef {
	var defs []toolDef
	defs = append(defs, s.readTools()...)
	defs = append(defs, s.reportTools()...)
	defs = append(defs, s.payrollTools()...)
	defs = append(defs, s.writeTools()...)
	return defs
}

// refresh shows or hides the payroll tools and the tools that make changes.
// When SerieX Books does not answer, the tool list is left as it is.
func (s *service) refresh(ctx context.Context, force bool) {
	s.tmu.Lock()
	defer s.tmu.Unlock()
	if !force && time.Since(s.checkedAt) < refreshEvery {
		return
	}
	s.checkedAt = time.Now()
	if s.booksURL == "" {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, payrollOK := s.payroll(cctx, force)
	s.setGroup(groupPayroll, payrollOK)
	if writable, err := s.anyChangesAllowed(cctx); err == nil {
		s.setGroup(groupWrite, writable)
	} else {
		s.log.Debug("could not check the AI assistant settings", "error", err)
	}
}

// setGroup adds or removes the tools of a group (s.tmu held).
func (s *service) setGroup(g toolGroup, on bool) {
	if s.groupOn[g] == on {
		return
	}
	s.groupOn[g] = on
	var names []string
	for _, d := range s.defs {
		if d.group != g {
			continue
		}
		if on {
			d.add(s.server)
		} else {
			names = append(names, d.tool.Name)
		}
	}
	if len(names) > 0 {
		s.server.RemoveTools(names...)
	}
}

// listed: the tools of a group are on the tool list now.
func (s *service) listed(g toolGroup) bool {
	s.tmu.Lock()
	defer s.tmu.Unlock()
	return s.groupOn[g]
}

// anyChangesAllowed: at least one shared company file allows changes.
func (s *service) anyChangesAllowed(ctx context.Context) (bool, error) {
	list, err := s.companies(ctx)
	if err != nil {
		return false, err
	}
	for _, c := range list {
		if a := s.policyAccess(ctx, c.ID); a.Enabled && a.AllowChanges {
			return true, nil
		}
	}
	return false, nil
}

// inScope: the key of this call opens the company file (keys of one
// company file open no other).
func inScope(ctx context.Context, companyID string) bool {
	only, ok := companyScope(ctx)
	return !ok || only == companyID
}

// access tells what the assistant of this call may do with a company file:
// what the policy allows, within what the key of its request opens.
func (s *service) access(ctx context.Context, companyID string) Access {
	if !inScope(ctx, companyID) {
		return Access{}
	}
	return s.policyAccess(ctx, companyID)
}

// policyAccess asks the policy about a company file (a failing or missing
// policy denies access).
func (s *service) policyAccess(ctx context.Context, companyID string) Access {
	if s.opts.Policy == nil {
		return Access{Enabled: s.opts.ShareAllForDevelopment}
	}
	a, err := s.opts.Policy.Access(ctx, companyID)
	if err != nil {
		s.log.Warn("AI assistant policy failed", "company", companyID, "error", err)
		return Access{}
	}
	if !a.Enabled || a.UserGone {
		a.AllowChanges = false
	}
	return a
}

// OfflineTools returns the definitions of the tools that read SerieX Books
// (no payroll tools, no tools that make changes). The seriex-mcp program
// lists them while SerieX is not running yet.
func OfflineTools() []*mcp.Tool {
	s := &service{groupOn: map[toolGroup]bool{}}
	var out []*mcp.Tool
	for _, d := range s.catalog() {
		if d.group == groupBooks {
			out = append(out, d.tool)
		}
	}
	return out
}
