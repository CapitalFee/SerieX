package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/CapitalFee/SerieX/mcp/seriexmcp"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	statusTool     = "seriex_status"
	retryEvery     = 10 * time.Second // reconnect attempts while SerieX is closed
	connectTimeout = 8 * time.Second
	// answerTimeout bounds the wait for SerieX to start answering a request
	// (a tool call that reads a large report can take a while).
	answerTimeout = 150 * time.Second
	// protocolVersion is used with SerieX: a session with a standalone event
	// stream, so SerieX can say when its tool list changes.
	protocolVersion = "2025-11-25"
)

// handshakeVersions are the protocol versions offered to the assistant's
// app: the ones with an initialize handshake, so questions from SerieX can be
// passed on during a tool call.
var handshakeVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// bridge is the stdio MCP server that passes everything on to SerieX.
type bridge struct {
	cfg config
	log *slog.Logger
	srv *mcp.Server // the stdio server, set once it exists (guarded by tmu)

	connecting  chan struct{} // held while connecting (a lock that respects contexts)
	smu         sync.Mutex    // session state
	sess        *mcp.ClientSession
	endpoint    string
	appVersion  string
	lastErr     error
	lastAttempt time.Time
	busyUntil   time.Time                  // SerieX said it gets too many requests: no new connection before this
	transports  map[string]*http.Transport // one per SerieX address, so connections are reused

	tmu    sync.Mutex // tools listed to the assistant
	listed map[string]*mcp.Tool

	closing atomic.Bool
}

func newBridge(cfg config, log *slog.Logger) *bridge {
	return &bridge{cfg: cfg, log: log, listed: map[string]*mcp.Tool{}, connecting: make(chan struct{}, 1)}
}

// run serves the assistant on stdin/stdout until it disconnects.
func (b *bridge) run(ctx context.Context) error {
	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	sess, err := b.ensure(cctx, false)
	cancel()
	instructions := seriexmcp.Instructions
	if sess != nil {
		if r := sess.InitializeResult(); r != nil && r.Instructions != "" {
			instructions = r.Instructions
		}
	} else {
		b.log.Info("SerieX is not available yet; waiting for it", "reason", err)
		if msg := plain(err); err != nil && !strings.HasPrefix(msg, "SerieX is not running") && !errors.Is(err, context.DeadlineExceeded) {
			// another reason (a wrong data folder, the connection turned off...): say that one
			instructions += "\n\nWhen this assistant started, SerieX could not be used: " + msg + " seriex_status tells whether this is still so."
		} else {
			instructions += "\n\nSerieX was not running when this assistant started. If a tool answers that SerieX is not running, ask the user to open the SerieX app; seriex_status tells whether SerieX can be reached."
		}
	}
	srv := mcp.NewServer(&mcp.Implementation{Name: "seriex", Title: "SerieX", Version: version}, &mcp.ServerOptions{
		Instructions:              instructions,
		Capabilities:              &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{ListChanged: true}},
		SupportedProtocolVersions: handshakeVersions,
	})
	srv.AddTool(&mcp.Tool{
		Name:        statusTool,
		Title:       "SerieX connection",
		Description: "Tell whether SerieX is running on this computer and reachable by these tools, and what to do when it is not.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Annotations: &mcp.ToolAnnotations{Title: "SerieX connection", ReadOnlyHint: true},
	}, func(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return textResult(b.statusText(ctx), false), nil
	})
	srv.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
			switch method {
			case "tools/list":
				if b.current() == nil {
					cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
					b.ensure(cctx, false)
					cancel()
				}
			case "tools/call":
				// a tool SerieX no longer lists (or not yet): ask SerieX anyway,
				// it explains why the tool cannot be used
				if cr, ok := req.(*mcp.CallToolRequest); ok && cr.Params != nil && cr.Params.Name != statusTool && !b.isListed(cr.Params.Name) {
					var args map[string]any
					if len(cr.Params.Arguments) > 0 {
						if err := json.Unmarshal(cr.Params.Arguments, &args); err != nil {
							return textResult("The arguments could not be read: "+err.Error(), true), nil
						}
					}
					return b.forward(ctx, cr.Params.Name, args)
				}
			}
			return next(ctx, method, req)
		}
	})
	b.tmu.Lock()
	b.srv = srv
	b.tmu.Unlock()
	if sess != nil {
		if err := b.sync(ctx, sess); err != nil {
			b.log.Warn("could not list the SerieX tools", "error", err)
		}
	}
	b.tmu.Lock()
	empty := len(b.listed) == 0
	b.tmu.Unlock()
	if empty {
		b.applyTools(seriexmcp.OfflineTools())
	}

	go b.reconnectLoop(ctx)
	err = srv.Run(ctx, &mcp.StdioTransport{})
	b.close()
	return err
}

// close ends the session with SerieX.
func (b *bridge) close() {
	b.closing.Store(true)
	b.smu.Lock()
	sess := b.sess
	b.sess = nil
	b.smu.Unlock()
	if sess != nil {
		sess.Close()
	}
}

// serving: the stdio server exists (tools can be listed to the assistant).
func (b *bridge) serving() bool {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	return b.srv != nil
}

// current is the open session with SerieX (nil when disconnected).
func (b *bridge) current() *mcp.ClientSession {
	b.smu.Lock()
	defer b.smu.Unlock()
	return b.sess
}

// drop forgets a session that failed.
func (b *bridge) drop(sess *mcp.ClientSession) {
	b.smu.Lock()
	if b.sess == sess {
		b.sess = nil
	}
	b.smu.Unlock()
	sess.Close()
}

// reconnectLoop connects again while SerieX is closed.
func (b *bridge) reconnectLoop(ctx context.Context) {
	t := time.NewTicker(retryEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if b.current() != nil {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, connectTimeout)
		b.ensure(cctx, false)
		cancel()
	}
}

// ensure returns the session with SerieX, connecting when needed. It gives
// up when ctx ends, also while another connection attempt is under way.
// After a failed attempt, the next 2 seconds give the same answer without
// trying again, unless now is true (a tool call: SerieX may have just been
// opened).
func (b *bridge) ensure(ctx context.Context, now bool) (*mcp.ClientSession, error) {
	b.smu.Lock()
	busy := time.Now().Before(b.busyUntil)
	b.smu.Unlock()
	if busy {
		return nil, errBusy // wait as SerieX asked: nothing is sent, also over a live session
	}
	if s := b.current(); s != nil {
		return s, nil
	}
	select {
	case b.connecting <- struct{}{}:
	case <-ctx.Done():
		return nil, errf("SerieX did not answer in time. If the SerieX app is open, it may be busy: try again in a moment, or restart SerieX.")
	}
	defer func() { <-b.connecting }()
	if s := b.current(); s != nil {
		return s, nil
	}
	b.smu.Lock()
	recent, lastErr := time.Since(b.lastAttempt) < 2*time.Second, b.lastErr
	busy = time.Now().Before(b.busyUntil)
	b.smu.Unlock()
	if busy {
		return nil, errBusy // wait as SerieX asked instead of reconnecting
	}
	if recent && lastErr != nil && !now {
		return nil, lastErr
	}
	sess, endpoint, err := b.connect(ctx)
	b.smu.Lock()
	b.lastAttempt, b.lastErr = time.Now(), err
	if err == nil {
		b.sess, b.endpoint = sess, endpoint
		if r := sess.InitializeResult(); r != nil && r.ServerInfo != nil {
			b.appVersion = r.ServerInfo.Version
		}
	}
	b.smu.Unlock()
	if err != nil {
		b.log.Debug("SerieX not reachable", "reason", err)
		return nil, err
	}
	b.log.Info("connected to SerieX", "endpoint", endpoint)
	go func() {
		err := sess.Wait()
		b.smu.Lock()
		gone := b.sess == sess
		if gone {
			b.sess = nil
		}
		b.smu.Unlock()
		if gone && !b.closing.Load() {
			b.log.Info("the connection to SerieX ended", "error", err)
		}
	}()
	if b.serving() {
		go func() {
			sctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
			defer cancel()
			if err := b.sync(sctx, sess); err != nil {
				b.log.Warn("could not list the SerieX tools", "error", err)
			}
		}()
	}
	return sess, nil
}

// connectErr is a plain explanation of why SerieX cannot be used.
type connectErr struct{ msg string }

func (e *connectErr) Error() string { return e.msg }

func errf(format string, args ...any) error { return &connectErr{fmt.Sprintf(format, args...)} }

// errNotSerieX: the server could not prove it knows the access key.
var errNotSerieX = errors.New("the server could not prove it is SerieX")

// errOff: SerieX Books answers, but its connection for AI assistants is off.
var errOff = errors.New("the connection for AI assistants is off in SerieX")

// errBusy: SerieX Books refused a correctly signed request only because it
// got too many requests from AI assistants in the last minutes (nothing was done).
var errBusy = errors.New("SerieX is getting too many requests from AI assistants")

// busyMessage answers a tool call SerieX refused because it is getting too
// many requests; busyStatus describes the same state (status, --check).
const (
	busyMessage = "SerieX is getting too many requests from AI assistants right now, so nothing was done. Wait a few minutes, then try again."
	busyStatus  = "SerieX is getting too many requests from AI assistants right now. Wait a few minutes, then try again."
)

// setBusy records that SerieX asked to wait d before sending more requests.
func (b *bridge) setBusy(d time.Duration) {
	if d <= 0 {
		d = time.Minute
	}
	d = min(d, 10*time.Minute)
	until := time.Now().Add(d)
	b.smu.Lock()
	if until.After(b.busyUntil) {
		b.busyUntil = until
	}
	b.smu.Unlock()
}

// retryAfter reads the Retry-After header of res (seconds).
func retryAfter(res *http.Response) time.Duration {
	n, err := strconv.Atoi(strings.TrimSpace(res.Header.Get("Retry-After")))
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Second
}

// busyCode reports whether res is SerieX's "too many requests" answer.
func busyCode(res *http.Response) bool {
	if res.StatusCode != http.StatusServiceUnavailable {
		return false
	}
	var body struct {
		Code string `json:"code"`
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<10)).Decode(&body) == nil && body.Code == seriexmcp.CodeAssistantsBusy
}

// offMessage explains why SerieX Books does not let AI assistants connect.
func offMessage(code string) string {
	if code == seriexmcp.CodeAssistantsNetwork {
		return "SerieX is running, but it does not let AI assistants connect: AI assistants can connect only when SerieX Books accepts connections from this computer alone (the normal setup). Start SerieX from the SerieX app, or ask whoever set up this SerieX."
	}
	return "SerieX is running, but its connection for AI assistants was turned off when SerieX Books was started. To turn it back on, start SerieX from the SerieX app, or ask whoever set up this SerieX."
}

// callKey marks the context of one tool call, to learn the HTTP status
// SerieX gave to that call's request.
type callKey struct{}

type callTrack struct{ status atomic.Int32 }

// authTransport signs every request to SerieX with the access key (the key
// itself is never sent), checks SerieX's proof on every answer, and sends
// nothing to any other address.
type authTransport struct {
	base http.RoundTripper
	key  string
	host string // host:port of the SerieX endpoint

	unauthorized atomic.Int32        // SerieX refused the key
	notSerieX    atomic.Bool         // an answer without a valid proof
	off          atomic.Value        // string: the error code of SerieX Books when its connection for AI assistants is off
	onBusy       func(time.Duration) // SerieX gets too many requests: wait this long (0: unknown)
}

// offCode reads the error code of an answer without proof: SerieX Books
// answers 404 {"code": seriexmcp.CodeAssistantsOff...} when its connection
// for AI assistants is off ("" for any other answer). Only known codes are
// used, with this program's own wording, so a program pretending to be
// SerieX cannot make the assistant read its text.
func offCode(res *http.Response) string {
	if res.StatusCode != http.StatusNotFound {
		return ""
	}
	var body struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 8<<10)).Decode(&body) != nil {
		return ""
	}
	switch body.Code {
	case seriexmcp.CodeAssistantsOff, seriexmcp.CodeAssistantsNetwork:
		return body.Code
	}
	return ""
}

func (t *authTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if !strings.EqualFold(r.URL.Host, t.host) {
		return nil, fmt.Errorf("refusing to send a request to %s (SerieX is at %s)", r.URL.Host, t.host)
	}
	r = r.Clone(r.Context())
	auth, nonce := seriexmcp.SignRequest(t.key, r.Method, r.URL.Host, r.URL.EscapedPath(), time.Now())
	r.Header.Set("Authorization", auth)
	res, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	if tr, ok := r.Context().Value(callKey{}).(*callTrack); ok {
		tr.status.Store(int32(res.StatusCode))
	}
	if res.StatusCode == http.StatusServiceUnavailable && res.Header.Get(seriexmcp.ProofHeader) == "" {
		busy := busyCode(res)
		res.Body.Close()
		if busy {
			if t.onBusy != nil {
				t.onBusy(retryAfter(res))
			}
			return nil, errBusy
		}
		res.Body = io.NopCloser(strings.NewReader(""))
		return res, nil
	}
	if res.StatusCode == http.StatusUnauthorized {
		t.unauthorized.Add(1)
		res.Body.Close()
		res.Body = io.NopCloser(strings.NewReader(""))
		return res, nil
	}
	if !seriexmcp.CheckProof(t.key, nonce, res.Header.Get(seriexmcp.ProofHeader)) {
		code := offCode(res)
		res.Body.Close()
		if code != "" {
			t.off.Store(code)
			return nil, errOff
		}
		t.notSerieX.Store(true)
		return nil, errNotSerieX
	}
	return res, nil
}

// httpClient talks to one SerieX address: no redirects, no proxy on this
// computer, bounded waits.
func (b *bridge) httpClient(base string) *http.Client {
	host := base
	if u, err := url.Parse(base); err == nil {
		host = u.Scheme + "://" + u.Host
	}
	b.smu.Lock()
	tr := b.transports[host]
	if tr == nil {
		// one transport per address, kept across reconnects, so connections
		// are reused instead of opened anew for every attempt
		tr = http.DefaultTransport.(*http.Transport).Clone()
		tr.Proxy = nil
		if u, err := url.Parse(base); err == nil && !seriexmcp.IsLoopbackHost(u.Hostname()) {
			tr.Proxy = http.ProxyFromEnvironment
		}
		tr.DialContext = (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext
		tr.ResponseHeaderTimeout = answerTimeout
		tr.MaxIdleConnsPerHost = 8
		if b.transports == nil {
			b.transports = map[string]*http.Transport{}
		}
		b.transports[host] = tr
	}
	b.smu.Unlock()
	return &http.Client{Transport: tr, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// connect finds SerieX and opens an MCP session with it. Each candidate
// address must answer as SerieX Books and then prove it knows the key.
func (b *bridge) connect(ctx context.Context) (*mcp.ClientSession, string, error) {
	if err := b.cfg.checkData(); err != nil {
		return nil, "", err
	}
	cands, err := b.candidates()
	if err != nil {
		return nil, "", err
	}
	var firstErr error
	for _, base := range cands {
		if !b.isBooks(ctx, base) {
			continue
		}
		endpoint := base + "/mcp"
		// first without the key: a SerieX Books whose connection for AI
		// assistants is off says so (and makes no key file)
		if code := b.offProbe(ctx, endpoint); code != "" {
			return nil, endpoint, errf("%s", offMessage(code))
		}
		key, keyErr := b.accessKey()
		if keyErr != nil {
			return nil, endpoint, keyErr
		}
		sess, err := b.open(ctx, endpoint, key)
		if err == nil {
			return sess, endpoint, nil
		}
		if errors.Is(err, errBusy) {
			return nil, endpoint, err // this is SerieX, asking to wait: no other address is tried
		}
		if firstErr == nil {
			firstErr = err
		}
		if ctx.Err() != nil {
			break
		}
	}
	if firstErr != nil {
		return nil, "", firstErr
	}
	if b.cfg.url != "" {
		return nil, "", errf("SerieX is not running at %s (SERIEX_URL). Open the SerieX app first, then try again.", b.cfg.url)
	}
	return nil, "", errf("SerieX is not running on this computer. Open the SerieX app first, then try again.")
}

// open starts an MCP session with SerieX at endpoint.
func (b *bridge) open(ctx context.Context, endpoint, key string) (*mcp.ClientSession, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return nil, errf("Not a valid address: %s", endpoint)
	}
	httpc := b.httpClient(endpoint)
	auth := &authTransport{base: httpc.Transport, key: key, host: u.Host, onBusy: b.setBusy}
	httpc.Transport = auth
	client := mcp.NewClient(&mcp.Implementation{Name: "seriex-mcp", Version: version}, &mcp.ClientOptions{
		KeepAlive: 30 * time.Second,
		ToolListChangedHandler: func(context.Context, *mcp.ToolListChangedRequest) {
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), connectTimeout)
				defer cancel()
				if s := b.current(); s != nil {
					if err := b.sync(ctx, s); err != nil {
						b.log.Warn("could not list the SerieX tools", "error", err)
					}
				}
			}()
		},
		ElicitationHandler: b.askUser,
	})
	tr := &mcp.StreamableClientTransport{Endpoint: endpoint, HTTPClient: httpc, MaxRetries: 2}
	sess, err := client.Connect(ctx, tr, &mcp.ClientSessionOptions{ProtocolVersion: protocolVersion})
	if err != nil {
		code, _ := auth.off.Load().(string)
		switch {
		case code != "":
			return nil, errf("%s", offMessage(code))
		case errors.Is(err, errBusy):
			return nil, errBusy
		case auth.notSerieX.Load():
			return nil, errf("The program answering at %s says it is SerieX but could not prove it holds this computer's SerieX access key, so it was not used. Close it, then open the SerieX app.", endpoint)
		case auth.unauthorized.Load() > 0:
			return nil, errf("SerieX refused the access key. If the key was changed in SerieX (AI Assistants), this program reads the new one by itself; when SERIEX_MCP_KEY is set, update it.")
		case refused(err):
			return nil, errf("SerieX is not running on this computer (nothing answers at %s). Open the SerieX app first, then try again.", endpoint)
		case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
			return nil, errf("SerieX at %s did not answer in time. If the SerieX app is open, it may be busy: try again in a moment, or restart SerieX.", endpoint)
		}
		var werr *jsonrpc.Error
		if errors.As(err, &werr) {
			return nil, errf("SerieX refused the connection (%s): %s", endpoint, werr.Message)
		}
		if strings.Contains(err.Error(), "Not Found") || strings.Contains(err.Error(), "Method Not Allowed") {
			return nil, errf("This version of SerieX does not offer access for AI assistants (%s). Update SerieX.", endpoint)
		}
		if strings.Contains(err.Error(), "Forbidden") {
			return nil, errf("SerieX refused the connection (%s).", endpoint)
		}
		return nil, errf("Could not connect to SerieX at %s: %v", endpoint, err)
	}
	return sess, nil
}

// candidates are the addresses where SerieX Books may run: SERIEX_URL, else
// the port the desktop app wrote in servers.json (while that process runs),
// else the usual port (and, in development builds, the developer port).
func (b *bridge) candidates() ([]string, error) {
	if b.cfg.url != "" {
		if b.cfg.urlErr != nil {
			return nil, b.cfg.urlErr
		}
		return []string{b.cfg.base}, nil
	}
	var cands []string
	if p := seriexmcp.RunningPort(b.cfg.dataDir, "books"); p > 0 {
		cands = append(cands, fmt.Sprintf("http://127.0.0.1:%d", p))
	}
	cands = append(cands, "http://127.0.0.1:47180")
	if version == "dev" {
		cands = append(cands, "http://127.0.0.1:8080") // ./start-books.sh
	}
	seen := map[string]bool{}
	var out []string
	for _, c := range cands {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out, nil
}

// isBooks: base answers GET /api/info as SerieX Books. It needs no secret,
// so it only picks the addresses to try; the key proof decides.
func (b *bridge) isBooks(ctx context.Context, base string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/info", nil)
	if err != nil {
		return false
	}
	res, err := b.httpClient(base).Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var info struct {
		App string `json:"app"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&info) != nil {
		return false
	}
	return strings.TrimSpace(info.App) == "SerieX Books"
}

// offProbe asks SerieX Books at endpoint, without the access key, whether
// its connection for AI assistants is off: the error code it gives then
// (seriexmcp.CodeAssistants...), or "" (on, or no clear answer).
func (b *bridge) offProbe(ctx context.Context, endpoint string) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return ""
	}
	req.Header.Set("Accept", "application/json, text/event-stream")
	res, err := b.httpClient(endpoint).Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	return offCode(res)
}

// accessKey is SERIEX_MCP_KEY or the key in the SerieX data folder (read
// again at every connection, so a new key is picked up).
func (b *bridge) accessKey() (string, error) {
	if b.cfg.key != "" {
		return b.cfg.key, nil
	}
	if b.cfg.keyPath == "" {
		return "", errf("The SerieX data folder is unknown; set SERIEX_MCP_KEY to the access key shown in SerieX (AI Assistants).")
	}
	key, err := seriexmcp.ReadKey(b.cfg.keyPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", errf("SerieX is running, but the file with its access key for AI assistants (%s) was not found. Quit SerieX and open it again; SerieX makes this file when it starts.", b.cfg.keyPath)
	case err != nil:
		return "", errf("SerieX is running, but the file with its access key for AI assistants (%s) could not be read. Quit SerieX and open it again; SerieX makes this file when it starts.", b.cfg.keyPath)
	}
	return key, nil
}

// sync lists the tools of SerieX to the assistant.
func (b *bridge) sync(ctx context.Context, sess *mcp.ClientSession) error {
	var tools []*mcp.Tool
	for t, err := range sess.Tools(ctx, nil) {
		if err != nil {
			return err
		}
		tools = append(tools, t)
	}
	b.applyTools(tools)
	return nil
}

// applyTools makes the listed tools match tools (the status tool stays).
func (b *bridge) applyTools(tools []*mcp.Tool) {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	if b.srv == nil {
		return
	}
	want := map[string]*mcp.Tool{}
	for _, t := range tools {
		if t != nil && t.Name != statusTool {
			want[t.Name] = t
		}
	}
	var remove []string
	for name := range b.listed {
		if want[name] == nil {
			remove = append(remove, name)
			delete(b.listed, name)
		}
	}
	if len(remove) > 0 {
		b.srv.RemoveTools(remove...)
	}
	for name, t := range want {
		if old := b.listed[name]; old != nil && sameJSON(old, t) {
			continue
		}
		if t.InputSchema == nil {
			t.InputSchema = map[string]any{"type": "object"}
		}
		b.srv.AddTool(t, b.proxy(name))
		b.listed[name] = t
	}
}

func (b *bridge) isListed(name string) bool {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	return b.listed[name] != nil
}

func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

func textResult(text string, isErr bool) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: isErr, Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}

// readOnly: the tool only looks (safe to send again).
func (b *bridge) readOnly(name string) bool {
	b.tmu.Lock()
	defer b.tmu.Unlock()
	t := b.listed[name]
	return t != nil && t.Annotations != nil && t.Annotations.ReadOnlyHint
}

// proxy passes a tool call on to SerieX.
func (b *bridge) proxy(name string) mcp.ToolHandler {
	return func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var args map[string]any
		if len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &args); err != nil {
				return textResult("The arguments could not be read: "+err.Error(), true), nil
			}
		}
		return b.forward(ctx, name, args)
	}
}

// forward calls a tool of SerieX. A call SerieX refused because of the
// access key (nothing was done) is sent again once after reconnecting with
// the current key; a read is also sent again after a lost connection.
func (b *bridge) forward(ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, error) {
	call := func(sess *mcp.ClientSession) (*mcp.CallToolResult, int32, error) {
		p := &mcp.CallToolParams{Name: name}
		if len(args) > 0 {
			p.Arguments = args
		}
		tr := &callTrack{}
		res, err := sess.CallTool(context.WithValue(ctx, callKey{}, tr), p)
		return res, tr.status.Load(), err
	}
	connect := func() (*mcp.ClientSession, error) {
		cctx, cancel := context.WithTimeout(ctx, connectTimeout)
		defer cancel()
		return b.ensure(cctx, true)
	}
	sess, err := connect()
	if err != nil {
		if errors.Is(err, errBusy) {
			return textResult(busyMessage, true), nil
		}
		return textResult(plain(err), true), nil
	}
	for attempt := 0; ; attempt++ {
		res, status, err := call(sess)
		if err == nil {
			return res, nil
		}
		var werr *jsonrpc.Error
		if errors.As(err, &werr) && !transportErr(err) {
			if werr.Code == jsonrpc.CodeInvalidParams && strings.Contains(werr.Message, "unknown tool") {
				go b.sync(context.Background(), sess)
				return textResult(fmt.Sprintf("The tool %s is not available in SerieX right now (the AI assistant settings or the running apps may have changed). List the tools again.", name), true), nil
			}
			return nil, werr
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.Is(err, errBusy) {
			return textResult(busyMessage, true), nil // refused before anything was done; the connection is fine
		}
		b.log.Info("lost the connection to SerieX", "tool", name, "status", status, "error", err)
		b.drop(sess)
		if attempt > 0 {
			return textResult("Could not reach SerieX: "+plain(err), true), nil
		}
		refusedKey := status == http.StatusUnauthorized
		notSerieX := errors.Is(err, errNotSerieX)
		if !refusedKey && !notSerieX && !errors.Is(err, mcp.ErrSessionMissing) && !b.readOnly(name) {
			return textResult("The connection to SerieX was lost while this change was being sent, so it is not known whether it was saved. Check in SerieX (or with the tools that look at the books) before trying again.", true), nil
		}
		if sess, err = connect(); err != nil {
			if errors.Is(err, errBusy) {
				return textResult(busyMessage, true), nil
			}
			if refusedKey {
				return textResult("Nothing was saved: SerieX refused the access key. "+plain(err), true), nil
			}
			return textResult(plain(err), true), nil
		}
	}
}

// askUser passes a question of SerieX on to the assistant's app, when the
// app can show questions (else SerieX gives the assistant a confirmation code).
func (b *bridge) askUser(ctx context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
	b.tmu.Lock()
	srv := b.srv
	b.tmu.Unlock()
	if srv == nil {
		return nil, errors.New("no assistant is connected")
	}
	for ss := range srv.Sessions() {
		ip := ss.InitializeParams()
		if ip == nil || ip.Capabilities == nil || ip.Capabilities.Elicitation == nil {
			continue
		}
		return ss.Elicit(ctx, req.Params)
	}
	return nil, errors.New("the assistant's app cannot show questions")
}

// rejectedCode is the code of errors the MCP transport makes when a message
// cannot be delivered (the request did not reach SerieX or got no answer).
const rejectedCode = -32005

// transportErr: the error comes from the connection, not from SerieX.
func transportErr(err error) bool {
	var werr *jsonrpc.Error
	return errors.As(err, &werr) && werr.Code == rejectedCode
}

// refused: nothing listens at the address (SerieX is not running).
func refused(err error) bool {
	var op *net.OpError
	if errors.As(err, &op) && op.Op == "dial" {
		return true
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "connection refused") || strings.Contains(msg, "actively refused")
}

func plain(err error) string {
	var ce *connectErr
	if errors.As(err, &ce) {
		return ce.msg
	}
	if errors.Is(err, errOff) {
		return offMessage(seriexmcp.CodeAssistantsOff)
	}
	if errors.Is(err, errBusy) {
		return busyStatus
	}
	if errors.Is(err, errNotSerieX) {
		return "The program answering for SerieX could not prove it holds this computer's SerieX access key, so its answer was not used."
	}
	return "Could not reach SerieX: " + err.Error()
}

// statusText describes the connection with SerieX (connecting when needed).
func (b *bridge) statusText(ctx context.Context) string {
	cctx, cancel := context.WithTimeout(ctx, connectTimeout)
	defer cancel()
	sess, err := b.ensure(cctx, false)
	if err != nil {
		return plain(err)
	}
	b.smu.Lock()
	endpoint, ver := b.endpoint, b.appVersion
	b.smu.Unlock()
	n := 0
	for _, err := range sess.Tools(cctx, nil) {
		if err != nil {
			if errors.Is(err, errBusy) {
				return busyStatus
			}
			return "SerieX answered but its tools could not be listed: " + err.Error()
		}
		n++
	}
	return fmt.Sprintf("Connected to SerieX %s at %s: %d SerieX tools available (besides this status tool). Use list_companies to see the company files shared with AI assistants.", ver, endpoint, n)
}
