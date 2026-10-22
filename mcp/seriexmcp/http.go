package seriexmcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// HTTPOptions configures Handler.
type HTTPOptions struct {
	// Options builds the MCP server (ignored when Server is set).
	Options
	// Server is a server made by NewServer, when the caller keeps it (for
	// NotifyChanged). nil: Handler makes one from Options.
	Server *mcp.Server
	// Key gives the access key every request must carry (required; see
	// KeyFile). It opens every company file shared with AI assistants.
	// Changing the key takes effect at once.
	Key KeyProvider
	// CompanyKeys, when set, gives more access keys, each of which opens
	// one company file only (company file id -> key): an assistant
	// connected with such a key sees that company file and no other, even
	// when more are shared. Called for every request, so a new key takes
	// effect at once.
	CompanyKeys func() map[string]string
	// AllowOtherComputers accepts requests sent from other computers. Off by
	// default: AI assistants are served only on this computer, even when
	// SerieX Books listens on the network for other people.
	AllowOtherComputers bool
	// MaxBodyBytes limits the size of a request (default 1 MB).
	MaxBodyBytes int64
	// SessionTimeout closes MCP sessions idle this long (default 1 hour).
	SessionTimeout time.Duration
}

// Handler serves the SerieX MCP server over MCP Streamable HTTP. Mount it on
// the SerieX Books server, for example at /mcp.
//
// Every request must carry an access key, either as "Authorization: Bearer
// <key>" or signed with it (AuthScheme, used by the seriex-mcp program, which
// then gets ProofHeader back): the access key of SerieX (Key), which opens
// every shared company file, or the key of one company file (CompanyKeys),
// which opens that file only. Refused: requests from other computers
// (unless AllowOtherComputers), requests sent by web pages (an Origin header
// that is not this server or this computer), and requests addressed to a host
// name that is not this computer (DNS rebinding). No CORS headers are sent,
// so web pages cannot read the answers.
func Handler(opts HTTPOptions) http.Handler {
	srv := opts.Server
	if srv == nil {
		srv = NewServer(opts.Options)
	}
	limit := opts.MaxBodyBytes
	if limit <= 0 {
		limit = 1 << 20
	}
	timeout := opts.SessionTimeout
	if timeout <= 0 {
		timeout = time.Hour
	}
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		MaxRequestBodyBytes: limit,
		SessionTimeout:      timeout,
		Logger:              opts.Logger,
	})
	// The key a request was accepted with reaches the tools as the token
	// information of the MCP SDK: it also ties every MCP session to that key
	// (a session started with one key cannot be used with another).
	next := auth.RequireBearerToken(func(ctx context.Context, _ string, _ *http.Request) (*auth.TokenInfo, error) {
		id, ok := ctx.Value(keyIdentityKey{}).(keyIdentity)
		if !ok {
			return nil, auth.ErrInvalidToken
		}
		return id.tokenInfo(), nil
	}, &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})(streamable)
	return &guard{next: next, key: opts.Key, companyKeys: opts.CompanyKeys, limit: limit, remote: opts.AllowOtherComputers}
}

type guard struct {
	next        http.Handler
	key         KeyProvider
	companyKeys func() map[string]string
	limit       int64
	remote      bool
	nonces      nonceCache // signed requests made with the keys of company files
	ownNonces   nonceCache // signed requests made with the access key of SerieX (the helper's), kept apart so a company file's key cannot crowd it out
}

// keyIdentity is the key a request was accepted with: the access key of
// SerieX (company "") or the key of one company file.
type keyIdentity struct{ company string }

type keyIdentityKey struct{}

// companyScopeExtra is the TokenInfo.Extra entry naming the only company
// file a key opens.
const companyScopeExtra = "seriex.company"

func (k keyIdentity) tokenInfo() *auth.TokenInfo {
	if k.company == "" {
		return &auth.TokenInfo{UserID: "seriex"}
	}
	return &auth.TokenInfo{UserID: "seriex-company:" + k.company, Extra: map[string]any{companyScopeExtra: k.company}}
}

// Error codes SerieX Books gives at its address for AI assistants when that
// connection is off ({"error": ..., "code": ...}, HTTP 404). The seriex-mcp
// program shows its own plain explanation for each.
const (
	CodeAssistantsOff     = "ai_assistants_off"     // SerieX Books was started with the connection off (-mcp=false)
	CodeAssistantsNetwork = "ai_assistants_network" // SerieX Books listens on a network address only
	// CodeAssistantsBusy (HTTP 503, with Retry-After): more signed requests
	// came in the last minutes than SerieX can remember; the key was right.
	CodeAssistantsBusy = "ai_assistants_busy"
)

// verifiedMarker replaces the Authorization header of an accepted request:
// the MCP SDK sees that the request was checked, and the key itself does not
// travel any further.
const verifiedMarker = "Bearer verified-by-seriex"

func (g *guard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if !g.remote && !FromThisComputer(r) {
		deny(w, http.StatusForbidden, "AI assistants can use SerieX only on the computer where SerieX runs.")
		return
	}
	host := hostOnly(r.Host)
	if !IsLoopbackHost(host) && !(g.remote && net.ParseIP(strings.Trim(host, "[]")) != nil) {
		deny(w, http.StatusForbidden, "This address is not allowed. Use http://127.0.0.1 or http://localhost.")
		return
	}
	if o := r.Header.Get("Origin"); o != "" && !originAllowed(o, r.Host) {
		deny(w, http.StatusForbidden, "Requests from web pages are not allowed.")
		return
	}
	if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
		deny(w, http.StatusForbidden, "Requests from web pages are not allowed.")
		return
	}
	if r.Method == http.MethodOptions {
		h.Set("Allow", "GET, POST, DELETE")
		deny(w, http.StatusMethodNotAllowed, "Cross-origin requests are not supported.")
		return
	}
	id, ok, wait := g.authorized(w, r)
	if wait > 0 {
		h.Set("Retry-After", strconv.Itoa(int((wait+time.Second-1)/time.Second)))
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "SerieX is getting too many requests from AI assistants right now. Wait a few minutes, then try again.", "code": CodeAssistantsBusy})
		return
	}
	if !ok {
		deny(w, http.StatusUnauthorized, "The SerieX access key is missing or wrong. Send it as \"Authorization: Bearer <key>\"; the key is shown in SerieX (AI Assistants).")
		return
	}
	if r.ContentLength > g.limit {
		deny(w, http.StatusRequestEntityTooLarge, "The request is too large.")
		return
	}
	r = r.Clone(context.WithValue(r.Context(), keyIdentityKey{}, id))
	r.Header.Set("Authorization", verifiedMarker)
	if r.Body != nil {
		r.Body = http.MaxBytesReader(w, r.Body, g.limit)
	}
	g.next.ServeHTTP(w, r)
}

// namedKey is an access key and the company file it opens ("" for all).
type namedKey struct{ company, key string }

// keys lists the keys a request may carry: the access key of SerieX first,
// then the keys of single company files.
func (g *guard) keys() []namedKey {
	var out []namedKey
	if g.key != nil {
		if k := g.key.AccessKey(); k != "" {
			out = append(out, namedKey{key: k})
		}
	}
	if g.companyKeys != nil {
		m := g.companyKeys()
		ids := make([]string, 0, len(m))
		for id, k := range m {
			if id != "" && k != "" {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			out = append(out, namedKey{company: id, key: m[id]})
		}
	}
	return out
}

// authorized checks the access key of a request (compared in constant time)
// and, for a signed request, adds SerieX's proof to the answer. It returns
// the key the request was accepted with; wait is more than 0 when a
// correctly signed request is refused only because too many came in the
// last minutes (how long until SerieX can take signed requests again).
func (g *guard) authorized(w http.ResponseWriter, r *http.Request) (id keyIdentity, ok bool, wait time.Duration) {
	keys := g.keys()
	if len(keys) == 0 {
		return keyIdentity{}, false, 0
	}
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	scheme, rest, found := strings.Cut(authz, " ")
	if !found {
		return keyIdentity{}, false, 0
	}
	rest = strings.TrimSpace(rest)
	switch {
	case strings.EqualFold(scheme, "Bearer"):
		got := sha256.Sum256([]byte(rest))
		found, which := 0, keyIdentity{}
		for _, k := range keys { // every key is compared, in constant time
			want := sha256.Sum256([]byte(k.key))
			if subtle.ConstantTimeCompare(got[:], want[:]) == 1 && found == 0 {
				found, which = 1, keyIdentity{company: k.company}
			}
		}
		return which, found == 1, 0
	case strings.EqualFold(scheme, AuthScheme):
		now := time.Now()
		for _, k := range keys {
			nonce, ok := verifySigned(k.key, rest, r, now)
			if !ok {
				continue
			}
			cache := &g.nonces
			if k.company == "" {
				cache = &g.ownNonces
			}
			switch cache.record(nonce, now) {
			case nonceUsed:
				return keyIdentity{}, false, 0
			case nonceFlooded:
				return keyIdentity{}, false, cache.retryAfter(now)
			}
			w.Header().Set(ProofHeader, proofFor(k.key, nonce))
			return keyIdentity{company: k.company}, true, 0
		}
	}
	return keyIdentity{}, false, 0
}

// proxyHeaders are set by programs that pass requests on from elsewhere
// (reverse proxies, tunnels such as ngrok or Tailscale Serve).
var proxyHeaders = []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto",
	"X-Real-Ip", "X-Client-Ip", "X-Original-Forwarded-For", "True-Client-Ip", "Cf-Connecting-Ip", "Fastly-Client-Ip", "Via"}

// FromThisComputer reports whether a request comes from this computer: it
// was sent from a loopback address and carries none of the headers a proxy
// or tunnel adds (a request passed on by a program on this computer may come
// from anywhere).
func FromThisComputer(r *http.Request) bool {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		h = r.RemoteAddr
	}
	ip := net.ParseIP(strings.Trim(h, "[]"))
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	for _, name := range proxyHeaders {
		if len(r.Header.Values(name)) > 0 {
			return false
		}
	}
	return true
}

// companyScope is the only company file the assistant of this call may see
// (ok false: no such limit), from the key its request was accepted with.
func companyScope(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(companyScopeKey{}).(string)
	return v, ok
}

type companyScopeKey struct{}

// withCompanyScope keeps, in the context of a call, the company file the
// key of the request opens (none: every shared company file).
func withCompanyScope(ctx context.Context, req mcp.Request) context.Context {
	if req == nil {
		return ctx
	}
	ex := req.GetExtra()
	if ex == nil || ex.TokenInfo == nil {
		return ctx
	}
	if id, ok := ex.TokenInfo.Extra[companyScopeExtra].(string); ok && id != "" {
		return context.WithValue(ctx, companyScopeKey{}, id)
	}
	return ctx
}

// originAllowed: the Origin of a browser request is this server or another
// address of this computer.
func originAllowed(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return strings.EqualFold(u.Host, host) || IsLoopbackHost(u.Hostname())
}

func deny(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
