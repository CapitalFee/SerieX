package seriexmcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// toolGroup decides when a tool is listed.
type toolGroup int

const (
	groupBooks   toolGroup = iota // always
	groupPayroll                  // while SerieX Payroll answers
	groupWrite                    // while a company file allows changes
)

// toolKind sets the annotations of a tool.
type toolKind int

const (
	readTool    toolKind = iota
	createTool           // records something new (not destructive)
	destroyTool          // voids or removes (destructive)
)

// toolDef is a tool, the function that adds it to a server, and its handler
// for calls that arrive while the tool is not listed.
type toolDef struct {
	group toolGroup
	tool  *mcp.Tool
	add   func(*mcp.Server)
	raw   func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error)
}

func boolPtr(b bool) *bool { return &b }

// maxAnswer is the largest answer given to the assistant (bytes); longer
// answers are cut with a note on how to narrow the request.
const maxAnswer = 80_000

// def defines a tool whose input is In and whose answer is plain text. fix
// may adjust the inferred input schema (enums, limits).
func def[In any](s *service, group toolGroup, kind toolKind, name, title, desc string, fix func(*jsonschema.Schema), h func(ctx context.Context, in In) (string, error)) toolDef {
	schema, err := jsonschema.For[In](nil)
	if err != nil {
		panic(fmt.Sprintf("tool %s: %v", name, err))
	}
	if fix != nil {
		fix(schema)
	}
	ann := &mcp.ToolAnnotations{Title: title, OpenWorldHint: boolPtr(false)}
	switch kind {
	case readTool:
		ann.ReadOnlyHint = true
	case createTool:
		ann.DestructiveHint = boolPtr(false)
	case destroyTool:
		ann.DestructiveHint = boolPtr(true)
	}
	t := &mcp.Tool{Name: name, Title: title, Description: desc, InputSchema: schema, Annotations: ann}
	run := func(ctx context.Context, req *mcp.CallToolRequest, in In) *mcp.CallToolResult {
		start := time.Now()
		cl := &callLog{}
		ctx = context.WithValue(ctx, callLogKey{}, cl)
		text, err := invoke(s, ctx, req, name, title, &in, h)
		if err != nil {
			msg := explain(name, kind, err)
			s.log.Info("tool call", "tool", name, "company", cl.get(), "ms", time.Since(start).Milliseconds(), "result", "refused", "why", firstLine(msg))
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: finishAnswer(msg)}}}
		}
		s.log.Info("tool call", "tool", name, "company", cl.get(), "ms", time.Since(start).Milliseconds(), "result", "ok")
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: finishAnswer(text)}}}
	}
	handler := func(ctx context.Context, req *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		return run(ctx, req, in), nil, nil
	}
	raw := func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var in In
		if req.Params != nil && len(req.Params.Arguments) > 0 {
			if err := json.Unmarshal(req.Params.Arguments, &in); err != nil {
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "The arguments could not be read: " + err.Error()}}}, nil
			}
		}
		return run(ctx, req, in), nil
	}
	return toolDef{group: group, tool: t, add: func(srv *mcp.Server) { mcp.AddTool(srv, t, handler) }, raw: raw}
}

// invoke runs a tool. For tools that save, it checks the warnings the
// assistant says the user agreed to, and answers SerieX's Yes/No questions:
// by asking the user directly when the assistant's app can show a question
// (MCP elicitation), else by returning the question with a one-time code
// the next call must carry.
func invoke[In any](s *service, ctx context.Context, req *mcp.CallToolRequest, name, title string, in *In, h func(ctx context.Context, in In) (string, error)) (string, error) {
	ca := confirmOf(in)
	if ca == nil {
		return h(ctx, *in)
	}
	fp := fingerprint(in)
	ca.ConfirmWarnings = normKinds(ca.ConfirmWarnings)
	for _, k := range ca.ConfirmWarnings {
		if appOnly(k) {
			return "", appOnlyRefusal(k, "")
		}
	}
	if len(ca.ConfirmWarnings) > 0 {
		if err := s.confirms.redeem(ca.ConfirmationCode, name, fp, ca.ConfirmWarnings); err != nil {
			return "", err
		}
	} else if strings.TrimSpace(ca.ConfirmationCode) != "" {
		return "", userErr("Nothing was saved. A confirmation_code goes together with confirm_warnings (the warning kinds the user agreed to).")
	}
	for round := 0; ; round++ {
		text, err := h(ctx, *in)
		var cn *confirmNeeded
		if !errors.As(err, &cn) || cn.kind == "" || round >= 8 || containsStr(ca.ConfirmWarnings, cn.kind) {
			return text, err // (a question asked again after Yes: only the app can answer it)
		}
		if cn.kind == closingKind {
			// never asked, never given a code: only the SerieX app can agree to it
			return "", closingRefusal(cn.question)
		}
		agreed := normKinds(append(append([]string{}, ca.ConfirmWarnings...), cn.kind))
		switch s.askUser(ctx, req, title, cn) {
		case answerYes:
			ca.ConfirmWarnings = agreed
			continue
		case answerNo:
			return "", userErr("Nothing was saved: the user answered No when SerieX asked %q. Do not try again unless the user asks for it.", cn.question)
		}
		for _, k := range agreed {
			if appOnly(k) {
				// only the user answers it, in their app's question box: no code
				return "", appOnlyRefusal(k, cn.question)
			}
		}
		cn.code = s.confirms.issue(name, fp, agreed)
		return "", cn
	}
}

// callLog collects what the log line of a tool call says besides the tool:
// the id of the company file it worked on ("" for none).
type callLog struct {
	mu      sync.Mutex
	company string
}

type callLogKey struct{}

func (cl *callLog) get() string {
	cl.mu.Lock()
	defer cl.mu.Unlock()
	return cl.company
}

// noteCompany records the company file of the tool call running in ctx.
func noteCompany(ctx context.Context, id string) {
	if cl, ok := ctx.Value(callLogKey{}).(*callLog); ok {
		cl.mu.Lock()
		cl.company = id
		cl.mu.Unlock()
	}
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// field returns the schema of a property; "lines.item" walks into the items of an array.
func field(s *jsonschema.Schema, path string) *jsonschema.Schema {
	for _, p := range strings.Split(path, ".") {
		if s.Items != nil {
			s = s.Items
		}
		s = s.Properties[p]
		if s == nil {
			panic("schema: no property " + path)
		}
	}
	return s
}

// enum sets the allowed values of a property (or of the items of an array property).
func enum(s *jsonschema.Schema, path string, values ...string) {
	p := field(s, path)
	if p.Items != nil {
		p = p.Items
	}
	p.Enum = nil
	for _, v := range values {
		p.Enum = append(p.Enum, v)
	}
}

// minItems requires at least n entries in an array property.
func minItems(s *jsonschema.Schema, path string, n int) {
	field(s, path).MinItems = &n
}

// ---------------------------------------------------------------------------
// Answers

// finishAnswer makes book text harmless to display, hides anything written
// like a full social security number, and caps the size.
func finishAnswer(s string) string {
	return capAnswer(maskSSNs(neutralize(s)))
}

// capAnswer cuts an answer longer than maxAnswer at a line end.
func capAnswer(s string) string {
	if len(s) <= maxAnswer {
		return s
	}
	cut := s[:maxAnswer]
	if i := strings.LastIndexByte(cut, '\n'); i > maxAnswer/2 {
		cut = cut[:i]
	}
	return cut + fmt.Sprintf("\n\n… The answer was cut at about %d KB (it was %d KB). Narrow the request (dates, filters, search, max_rows) to see the rest.\n", maxAnswer/1000, len(s)/1000)
}

var (
	mdImage = regexp.MustCompile(`!\[([^\]\n]*)\]\(([^)\n]*)\)`)
	mdLink  = regexp.MustCompile(`\[([^\]\n]*)\]\(([^)\n]*)\)`)
	htmlTag = regexp.MustCompile(`<(/?[A-Za-z!?])`)
)

// neutralize removes what an app showing the answer could load or follow by
// itself from text typed in the books: Markdown images become their alt
// text, Markdown links show their address in plain text, and HTML tags are
// shown as text. The tools' own text never uses these.
func neutralize(s string) string {
	if !strings.Contains(s, "](") && !strings.Contains(s, "<") {
		return s
	}
	s = mdImage.ReplaceAllString(s, "$1 (image removed)")
	s = mdLink.ReplaceAllString(s, "$1 ($2)")
	return htmlTag.ReplaceAllString(s, "‹$1")
}

// quoted shows free text typed in the books as quoted data.
func quoted(s string, n int) string {
	return "“" + short(s, n) + "”"
}

// ---------------------------------------------------------------------------
// Errors as plain messages

// confirmNeeded: SerieX asked a Yes/No question; nothing was saved.
type confirmNeeded struct {
	question string
	kind     string
	accepted []string
	company  string
	code     string // one-time code to agree with the next call
}

func (c *confirmNeeded) Error() string { return c.question }

// explain turns an error into the text the assistant reads.
func explain(tool string, kind toolKind, err error) string {
	var cn *confirmNeeded
	var ae *apiError
	var ue *userError
	switch {
	case errors.As(err, &cn):
		if cn.kind == "" || cn.code == "" {
			return fmt.Sprintf("Nothing was saved. SerieX asks: %q\nThis question can only be answered in the SerieX app: if the user wants to go ahead, they need to make this change there.", cn.question)
		}
		kinds := normKinds(append(append([]string{}, cn.accepted...), cn.kind))
		quotedKinds := make([]string, len(kinds))
		for i, k := range kinds {
			quotedKinds[i] = fmt.Sprintf("%q", k)
		}
		return fmt.Sprintf("Nothing was saved yet. SerieX asks the user: %q (warning: %s)\n"+
			"Show this question to the user in your own words, leaving nothing out, and wait for their answer. "+
			"Only if the user clearly says yes, call %s again with exactly the same arguments plus "+
			"\"confirm_warnings\": [%s] and \"confirmation_code\": %q. "+
			"The code works once, only for these arguments, for %d minutes. If the user says no, do not call it again.",
			cn.question, cn.kind, tool, strings.Join(quotedKinds, ", "), cn.code, int(confirmTTL/time.Minute))
	case errors.As(err, &ae):
		switch ae.Code {
		case "closing_date":
			return "Nothing was saved. SerieX says: " + ae.Message + "\n" +
				"The books are closed through the closing date, and changes dated on or before it need the closing date password, which AI assistants never handle. " +
				"Tell the user to make this change in the SerieX app themselves, or to use a later date if that is what they meant."
		case "forbidden":
			return "SerieX refused: " + ae.Message + " (The SerieX user AI assistants work as is not allowed to do this.)"
		case "books_unavailable":
			return "SerieX Payroll could not reach SerieX Books: " + ae.Message
		}
		msg := "SerieX says: " + ae.Message
		if kind != readTool {
			msg = "Nothing was saved. " + msg
		}
		if ae.Field != "" {
			msg += fmt.Sprintf(" (field: %s)", ae.Field)
		}
		return msg
	case errors.As(err, &ue):
		return ue.msg
	}
	return "Unexpected problem: " + err.Error()
}

// ---------------------------------------------------------------------------
// Warnings the user agrees to

// warningKinds are the kinds of Yes/No questions SerieX Books may ask before
// saving that an assistant may pass on to the user and answer with a
// one-time confirmation code. "date" is asked by these tools themselves (a
// date far in the past or future), like the SerieX forms do. The questions
// of userOnlyKinds and the closing date question (closingKind) are not
// among them.
var warningKinds = []string{"dupnum", "creditlimit", "inventory", "inactive", "date"}

// userOnlyKinds are questions about changing entries that were already
// reconciled, deposited or paid. Only the user answers them, in the
// question box of their assistant app (SerieX asks them directly); an
// assistant never gets a confirmation code for them. When the app cannot
// show SerieX's questions, the change is made in SerieX itself.
var userOnlyKinds = []string{"reconciled", "deposited", "applied"}

// closingKind is the question SerieX Books asks before a change dated on or
// before the closing date (when there is no closing date password). AI
// assistants never agree to it, neither by asking the user directly nor with
// a confirmation code: they say the change must be made in SerieX itself.
const closingKind = "closing"

// appOnly: an assistant never agrees to this kind of question with a
// confirmation code.
func appOnly(kind string) bool {
	return kind == closingKind || containsStr(userOnlyKinds, kind)
}

// closingRefusal is the answer when SerieX asks about the closing date
// (question is "" when the assistant tried to agree to it beforehand).
func closingRefusal(question string) error {
	asked := ""
	if question != "" {
		asked = fmt.Sprintf(" SerieX says: %q", question)
	}
	return userErr("%s", "Nothing was saved."+asked+"\n"+
		"Changes dated on or before the closing date can only be made in SerieX itself: AI assistants cannot agree to the closing date warning. "+
		"Tell the user to make this change in the SerieX app, or to use a later date if that is what they meant. Do not try another way to make the change.")
}

// appOnlyRefusal is the answer for a question only the user may answer
// (question is "" when the assistant tried to agree to it by itself).
func appOnlyRefusal(kind, question string) error {
	if kind == closingKind {
		return closingRefusal(question)
	}
	asked := ""
	if question != "" {
		asked = fmt.Sprintf(" SerieX asks: %q", question)
	}
	return userErr("%s", "Nothing was saved."+asked+"\n"+
		"Only the user can answer this question about changing entries that were already reconciled, deposited or paid, and only when their app shows SerieX's questions directly (it does not here). "+
		"Tell the user to make this change in the SerieX app. Do not try another way to make the change.")
}

// agreesToAppOnly returns the first warning kind in confirm_warnings that an
// assistant may not agree to ("" when none).
func agreesToAppOnly(args json.RawMessage) string {
	var in struct {
		ConfirmWarnings []string `json:"confirm_warnings"`
	}
	if len(args) == 0 || json.Unmarshal(args, &in) != nil {
		return ""
	}
	for _, k := range normKinds(in.ConfirmWarnings) {
		if appOnly(k) {
			return k
		}
	}
	return ""
}

const confirmDesc = "Leave this out on the first call. Only after this tool returned a question with a confirmation_code and the user clearly agreed, " +
	"list the warning kinds the user agreed to: dupnum (number already used), creditlimit (over the customer's credit limit), " +
	"inventory (selling more than on hand), inactive (using an inactive account, name or item), " +
	"date (a date far in the past or the future). " +
	"Never add a kind the user did not agree to. Questions about the closing date, or about changing entries that were reconciled, deposited or paid, are never agreed to here."

const codeDesc = "The confirmation code this tool returned with its question. Only together with confirm_warnings, after the user agreed."

// confirmArg holds the "confirm_warnings" and "confirmation_code" arguments
// of every tool that saves.
type confirmArg struct {
	ConfirmWarnings  []string `json:"confirm_warnings,omitempty" jsonschema:"Warnings the user agreed to. Leave this out on the first call; see the tool description."`
	ConfirmationCode string   `json:"confirmation_code,omitempty" jsonschema:"Code returned with SerieX's question."`
}

func (c *confirmArg) confirmState() *confirmArg { return c }

type confirmer interface{ confirmState() *confirmArg }

// confirmOf returns the confirm arguments of a tool input (nil: the tool does not save).
func confirmOf(in any) *confirmArg {
	if c, ok := in.(confirmer); ok {
		return c.confirmState()
	}
	return nil
}

// fixConfirm sets the allowed values and descriptions of the confirm arguments.
func fixConfirm(sc *jsonschema.Schema) {
	enum(sc, "confirm_warnings", warningKinds...)
	field(sc, "confirm_warnings").Description = confirmDesc
	field(sc, "confirmation_code").Description = codeDesc
}

// save runs a change with the warnings the user agreed to (?accept=...). A
// question from SerieX becomes a confirmNeeded error. ?force=1 is never sent.
func (b *call) save(accepted []string, run func(q url.Values) error) error {
	q := url.Values{}
	var kinds []string
	for _, k := range normKinds(accepted) {
		if k != closingKind { // never agreed to here (see closingKind)
			kinds = append(kinds, k)
		}
	}
	if len(kinds) > 0 {
		q.Set("accept", strings.Join(kinds, ","))
	}
	err := run(q)
	var ae *apiError
	if errors.As(err, &ae) && ae.Code == "confirm" {
		return &confirmNeeded{question: ae.Message, kind: ae.Warning, accepted: kinds, company: b.co.Name}
	}
	return err
}

// normKinds cleans the warning kinds the user agreed to (lower case, sorted, once each).
func normKinds(accepted []string) []string {
	var kinds []string
	seen := map[string]bool{}
	for _, k := range accepted {
		k = strings.ToLower(strings.TrimSpace(k))
		if k != "" && !seen[k] {
			seen[k] = true
			kinds = append(kinds, k)
		}
	}
	sort.Strings(kinds)
	return kinds
}

// fingerprint identifies the arguments of a call, without the confirm arguments.
func fingerprint(in any) string {
	b, err := json.Marshal(in)
	if err != nil {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return ""
	}
	delete(m, "confirm_warnings")
	delete(m, "confirmation_code")
	b, _ = json.Marshal(m)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:16])
}

// confirmTTL is how long a confirmation code can be used.
const confirmTTL = 10 * time.Minute

type pendingConfirm struct {
	tool, fingerprint string
	kinds             []string
	expires           time.Time
}

// confirmStore keeps the one-time codes given with SerieX's questions: an
// agreement to a warning is accepted only with the code of a question that
// was actually returned, for the same tool and arguments.
type confirmStore struct {
	mu sync.Mutex
	m  map[string]*pendingConfirm
}

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func (cs *confirmStore) issue(tool, fp string, kinds []string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	code := string(b[:4]) + "-" + string(b[4:])
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if cs.m == nil {
		cs.m = map[string]*pendingConfirm{}
	}
	now := time.Now()
	for k, p := range cs.m {
		if now.After(p.expires) {
			delete(cs.m, k)
		}
	}
	if len(cs.m) >= 1000 { // drop the oldest
		var oldest string
		for k, p := range cs.m {
			if oldest == "" || p.expires.Before(cs.m[oldest].expires) {
				oldest = k
			}
		}
		delete(cs.m, oldest)
	}
	cs.m[normCode(code)] = &pendingConfirm{tool: tool, fingerprint: fp, kinds: kinds, expires: now.Add(confirmTTL)}
	return code
}

func normCode(c string) string {
	c = strings.ToUpper(c)
	return strings.Map(func(r rune) rune {
		if r == '-' || r == ' ' {
			return -1
		}
		return r
	}, c)
}

// redeem checks (and uses up) the code of an agreement to warnings.
func (cs *confirmStore) redeem(code, tool, fp string, want []string) error {
	key := normCode(strings.TrimSpace(code))
	if key == "" {
		return userErr("Nothing was saved. confirm_warnings can only be used together with the confirmation_code SerieX gave with its question. "+
			"Call %s without confirm_warnings first: if SerieX asks a question, show it to the user and wait for their answer.", tool)
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	p := cs.m[key]
	if p == nil || time.Now().After(p.expires) {
		delete(cs.m, key)
		return userErr("Nothing was saved. The confirmation code is not valid (each code works once, for %d minutes). "+
			"Call %s again without confirm_warnings to get SerieX's question again, and ask the user.", int(confirmTTL/time.Minute), tool)
	}
	if p.tool != tool || p.fingerprint != fp {
		return userErr("Nothing was saved. The confirmation code was given for a call with other arguments. "+
			"Call %s with exactly the same arguments as when SerieX asked, or call it without confirm_warnings to get a new question.", tool)
	}
	for _, k := range want {
		if !containsStr(p.kinds, k) {
			return userErr("Nothing was saved. confirm_warnings lists %q, but the user was not asked about it. List only the warnings of the question SerieX asked: %s.", k, strings.Join(p.kinds, ", "))
		}
	}
	delete(cs.m, key)
	return nil
}

// ---------------------------------------------------------------------------
// Asking the user directly

type answer int

const (
	answerUnavailable answer = iota // the assistant's app cannot show the question
	answerYes
	answerNo
)

// askUser shows SerieX's question to the user through the assistant's app
// (MCP elicitation), when the app can do that.
func (s *service) askUser(ctx context.Context, req *mcp.CallToolRequest, title string, cn *confirmNeeded) answer {
	if req == nil || req.Session == nil {
		return answerUnavailable
	}
	ip := req.Session.InitializeParams()
	if ip == nil || ip.Capabilities == nil || ip.Capabilities.Elicitation == nil {
		return answerUnavailable
	}
	if el := ip.Capabilities.Elicitation; el.Form == nil && el.URL != nil {
		return answerUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, confirmTTL)
	defer cancel()
	where := "SerieX"
	if cn.company != "" {
		where = cn.company
	}
	msg := fmt.Sprintf("An AI assistant wants to save a change in %s (%s). SerieX asks:\n\n%s\n\nAnswer Yes only if you want this change saved.", where, title, cn.question)
	res, err := req.Session.Elicit(ctx, &mcp.ElicitParams{
		Message: msg,
		RequestedSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"answer": map[string]any{"type": "string", "title": "Your answer", "enum": []string{"Yes", "No"}},
			},
			"required": []string{"answer"},
		},
	})
	if err != nil {
		s.log.Debug("could not ask the user directly", "error", err)
		return answerUnavailable
	}
	if res.Action == "accept" && res.Content != nil && fmt.Sprint(res.Content["answer"]) == "Yes" {
		return answerYes
	}
	return answerNo
}
