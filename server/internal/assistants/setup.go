package assistants

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"seriex/internal/apperr"
)

// Setting up the AI assistant apps of this computer: SerieX adds itself to
// the app's settings file as a program the app starts (the seriex-mcp
// helper), changing nothing else in that file. Before a change, the file is
// copied to <file>.seriex-backup (or, when that backup already holds older
// content, to <file>.seriex-backup-<date and time>).

const (
	targetClaude = "claudeDesktop"
	targetCodex  = "codex"

	serverName = "seriex" // the name of SerieX in the apps' lists of servers
	backupExt  = ".seriex-backup"
)

func appName(target string) string {
	if target == targetCodex {
		return "ChatGPT / Codex"
	}
	return "Claude"
}

// setupResult is the answer of POST /ai-assistants/setup. Result is
// "created" (there was no settings file; SerieX made one), "changed" (SerieX
// added or updated itself in the file) or "unchanged" (the file was already
// set up).
type setupResult struct {
	File    string `json:"file"`
	Backup  string `json:"backup"`
	Message string `json:"message"`
	Result  string `json:"result"`
}

const (
	resultCreated   = "created"
	resultChanged   = "changed"
	resultUnchanged = "unchanged"
)

// resultOf names what happened to a settings file.
func resultOf(existed, changed bool) string {
	switch {
	case !changed:
		return resultUnchanged
	case !existed:
		return resultCreated
	}
	return resultChanged
}

// claudeConfigFiles returns the settings file the Claude desktop app reads
// and, on Windows, the other place Claude may read it from (SerieX writes
// both): ~/Library/Application Support/Claude (macOS), ~/.config/Claude
// (Linux), %APPDATA%\Claude (Windows). Claude for Windows from
// claude.ai/download, the Microsoft Store or WinGet is a packaged app:
// Windows gives it its own copy of %APPDATA%, under
// %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming, and it reads its
// settings from there.
func claudeConfigFiles() (string, []string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", nil, err
	}
	main, also := claudeFilesFor(runtime.GOOS, dir, os.Getenv("LOCALAPPDATA"))
	return main, also, nil
}

func claudeFilesFor(goos, configDir, localAppData string) (string, []string) {
	std := filepath.Join(configDir, "Claude", "claude_desktop_config.json")
	if goos != "windows" || strings.TrimSpace(localAppData) == "" {
		return std, nil
	}
	pkgs, _ := filepath.Glob(filepath.Join(localAppData, "Packages", "Claude_*"))
	sort.Strings(pkgs)
	for _, p := range pkgs {
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return filepath.Join(p, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"), []string{std}
		}
	}
	return std, nil
}

// codexConfigPath is the settings file of Codex, also used by the ChatGPT
// desktop app: $CODEX_HOME/config.toml, else ~/.codex/config.toml.
func codexConfigPath() (string, error) {
	if v := strings.TrimSpace(os.Getenv("CODEX_HOME")); v != "" {
		if abs, err := filepath.Abs(v); err == nil {
			v = abs
		}
		return filepath.Join(v, "config.toml"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "config.toml"), nil
}

// maxConfigSize is the largest settings file (or backup) SerieX reads; a
// larger one is left as it is.
const maxConfigSize = 4 << 20

var (
	errConfigTooLarge = errors.New("it is larger than 4 MB")
	errConfigNotFile  = errors.New("it is not a regular file")
)

// readConfig reads a settings file (exists false when there is none). A link
// is followed to the file it points to (the file saveConfig then writes).
// Only a regular file of at most 4 MB is read: anything else (a folder, a
// named pipe, a device, a larger file) is an error, so the file is left as
// it is, and reading never waits for another program.
func readConfig(path string) (data []byte, exists bool, err error) {
	target, err := filepath.EvalSymlinks(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil // no file (or a link to nothing)
	}
	if err != nil {
		target = path // (readRegular follows links too)
	}
	data, err = readRegular(target, maxConfigSize)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, false, nil
	}
	return data, true, err
}

// readRegular reads a regular file of at most max bytes. The file is opened
// without waiting (openNoWait) and checked again once open, so a named pipe
// put in its place in between is refused instead of read.
func readRegular(path string, max int64) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errConfigNotFile
	}
	if fi.Size() > max {
		return nil, errConfigTooLarge
	}
	f, err := os.OpenFile(path, os.O_RDONLY|openNoWait, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err = f.Stat(); err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errConfigNotFile
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > max {
		return nil, errConfigTooLarge
	}
	return data, nil
}

// claudeStatus: "configured" when the file Claude reads starts the helper
// with the arguments this SerieX needs. On Linux, where the Claude desktop
// app is not made, "appFound" only when Claude's settings folder exists
// (~/.config/Claude, made by a Claude app for Linux).
func claudeStatus(helper string, args []string) setupFileJSON {
	var st setupFileJSON
	path, _, err := claudeConfigFiles()
	if err != nil {
		return st
	}
	st.File = path
	if runtime.GOOS == "linux" {
		found := isDir(filepath.Dir(path))
		st.AppFound = &found
	}
	data, exists, err := readConfig(path)
	st.Exists = exists
	if err == nil && exists {
		st.Configured = claudeConfigured(data, helper, args)
	}
	return st
}

// isDir: path is a folder (or a link to one).
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

func codexStatus(helper string, args []string) setupFileJSON {
	var st setupFileJSON
	path, err := codexConfigPath()
	if err != nil {
		return st
	}
	st.File = path
	data, exists, err := readConfig(path)
	st.Exists = exists
	if err == nil && exists {
		st.Configured = codexConfigured(string(data), helper, args)
	}
	return st
}

const (
	msgClaudeRestart = "Quit Claude completely and open it again."
	msgCodexRestart  = "In ChatGPT open Settings, then MCP servers, and click Restart, or quit and reopen ChatGPT."
)

// On Linux, where the ChatGPT desktop app is not made: Codex is the codex
// terminal app or the Codex extension in VS Code or Cursor, which read the
// same settings file.
const (
	msgCodexRestartLinux   = "Close Codex and start it again (in VS Code or Cursor, reload the window). Then type /mcp to check that seriex is listed."
	msgCodexUnchangedLinux = "Codex was already set up to use SerieX. If seriex is not listed, close Codex and start it again (in VS Code or Cursor, reload the window)."
)

func setupClaude(helper string, args []string) (setupResult, error) {
	path, also, err := claudeConfigFiles()
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not find the Claude settings folder on this computer (%s).", plainErr(err))
	}
	data, existed, err := readConfig(path)
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not read the Claude settings file %s (%s), so it changed nothing.", path, plainErr(err))
	}
	out, err := mergeClaudeConfig(data, helper, args)
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not read the Claude settings file %s (it is not in the expected format), so it changed nothing. Fix that file or move it away, then try again.", path)
	}
	if len(out) > maxConfigSize {
		// (the result would be a file SerieX does not read)
		return setupResult{}, apperr.Conflict("SerieX could not add itself to the Claude settings file %s: with SerieX added it would be larger than 4 MB, so it changed nothing.", path)
	}
	backup, changed, err := saveConfig(path, data, out)
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not save the Claude settings file %s (%s).", path, plainErr(err))
	}
	// the other place Claude for Windows may read its settings from
	for _, other := range also {
		od, _, err := readConfig(other)
		if err != nil {
			log.Printf("AI assistants: did not change %s (%s)", other, plainErr(err))
			continue
		}
		oo, err := mergeClaudeConfig(od, helper, args)
		if err != nil {
			log.Printf("AI assistants: did not change %s (it is not in the expected format)", other)
			continue
		}
		if _, _, err := saveConfig(other, od, oo); err != nil {
			log.Printf("AI assistants: could not save %s (%s)", other, plainErr(err))
		}
	}
	msg := msgClaudeRestart
	if !changed {
		msg = "Claude was already set up to use SerieX. If Claude does not list SerieX, quit Claude completely and open it again."
	}
	return setupResult{File: path, Backup: backup, Message: msg, Result: resultOf(existed, changed)}, nil
}

func setupCodex(helper string, args []string) (setupResult, error) {
	path, err := codexConfigPath()
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not find the ChatGPT and Codex settings folder on this computer (%s).", plainErr(err))
	}
	data, existed, err := readConfig(path)
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not read the ChatGPT and Codex settings file %s (%s), so it changed nothing.", path, plainErr(err))
	}
	out, err := setCodexServer(string(data), helper, args)
	switch {
	case errors.Is(err, errInlineServers):
		return setupResult{}, apperr.Conflict("The ChatGPT and Codex settings file %s lists all its servers on one line (mcp_servers = { ... }), so SerieX cannot add itself there, and it changed nothing. "+
			"Add SerieX in ChatGPT instead (Settings, then MCP servers, then Add server), or rewrite the servers in that file as separate [mcp_servers.<name>] sections and try again.", path)
	case errors.Is(err, errOtherForm):
		return setupResult{}, apperr.Conflict("The ChatGPT and Codex settings file %s already lists SerieX in a way SerieX cannot update by itself, so it changed nothing. Remove the seriex entry from that file, then try again.", path)
	case err != nil:
		return setupResult{}, apperr.Conflict("SerieX could not read the ChatGPT and Codex settings file %s (it is not in the expected format), so it changed nothing. Fix that file or move it away, then try again.", path)
	case len(out) > maxConfigSize:
		// (the result would be a file SerieX does not read)
		return setupResult{}, apperr.Conflict("SerieX could not add itself to the ChatGPT and Codex settings file %s: with SerieX added it would be larger than 4 MB, so it changed nothing.", path)
	}
	backup, changed, err := saveConfig(path, data, []byte(out))
	if err != nil {
		return setupResult{}, apperr.Conflict("SerieX could not save the ChatGPT and Codex settings file %s (%s).", path, plainErr(err))
	}
	msg := msgCodexRestart
	if !changed {
		msg = "ChatGPT and Codex were already set up to use SerieX. If SerieX is not listed, open Settings, then MCP servers, and click Restart, or quit and reopen ChatGPT."
	}
	if runtime.GOOS == "linux" {
		msg = msgCodexRestartLinux
		if !changed {
			msg = msgCodexUnchangedLinux
		}
	}
	return setupResult{File: path, Backup: backup, Message: msg, Result: resultOf(existed, changed)}, nil
}

// saveConfig writes a settings file: the content it replaces is kept in a
// backup first, the file keeps its permissions (0600 for a new file), and a
// settings file that is a link to another file is written through the link.
// Returns the backup holding the replaced content ("" when there was no
// file, or nothing changed) and whether the file changed.
//
// The backup is <file>.seriex-backup; when that already holds other
// content (an earlier setup), it is kept and the content replaced now goes
// to <file>.seriex-backup-<date>-<time>.
func saveConfig(path string, orig, data []byte) (backup string, changed bool, err error) {
	target := path
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		target = resolved
	}
	mode := fs.FileMode(0o600)
	exists := false
	if fi, err := os.Stat(target); err == nil {
		exists = true
		mode = fi.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", false, err
	}
	if exists && bytes.Equal(orig, data) {
		return "", false, nil // already set up: nothing to change
	}
	if len(data) > maxConfigSize {
		return "", false, errConfigTooLarge // a file SerieX would not read again: left as it is
	}
	if exists && runtime.GOOS != "windows" && mode&0o200 == 0 {
		return "", false, fmt.Errorf("the file is read-only")
	}
	if exists {
		if backup, err = keepBackup(target, orig, mode, time.Now()); err != nil {
			return "", false, err
		}
	}
	return backup, true, writeAtomic(target, data, mode)
}

// keepBackup stores content in a backup of file and returns its name: an
// existing backup that holds the same content is reused, other backups are
// never overwritten.
func keepBackup(file string, content []byte, mode fs.FileMode, now time.Time) (string, error) {
	first := file + backupExt
	stamped := file + backupExt + "-" + now.Format("20060102-150405")
	candidates := []string{first, stamped}
	for i := 2; i <= 50; i++ {
		candidates = append(candidates, fmt.Sprintf("%s-%d", stamped, i))
	}
	for _, b := range candidates {
		old, err := readRegular(b, maxConfigSize)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			if _, lerr := os.Lstat(b); lerr == nil {
				continue // a broken link: leave it alone
			}
			return b, writeAtomic(b, content, mode)
		case err != nil:
			if _, lerr := os.Lstat(b); lerr == nil {
				continue // there but unreadable, too large or not a regular file: leave it alone
			}
			return "", err
		case bytes.Equal(old, content):
			return b, nil
		}
	}
	return "", fmt.Errorf("there are too many backups of %s", filepath.Base(file))
}

// ---------------------------------------------------------------------------
// Claude: claude_desktop_config.json {"mcpServers": {"seriex": {"command": H, "args": A}}}

// jsonMember is one member of a JSON object, kept in the file's order.
type jsonMember struct {
	key string
	val json.RawMessage
}

// parseObject reads a JSON object keeping the order of its members and their
// values exactly (numbers, escapes).
func parseObject(data []byte) ([]jsonMember, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not an object")
	}
	var out []jsonMember
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errors.New("bad key")
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		out = append(out, jsonMember{key, raw})
	}
	if _, err := dec.Token(); err != nil { // the closing }
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("extra content after the object")
	}
	return out, nil
}

func writeObject(members []jsonMember) []byte {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(m.key)
		b.Write(k)
		b.WriteByte(':')
		b.Write(m.val)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// marshalPlain encodes v without escaping <, > and & (paths stay readable).
func marshalPlain(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

func trimBOM(data []byte) []byte { return bytes.TrimPrefix(data, []byte("\xef\xbb\xbf")) }

// mergeClaudeConfig sets mcpServers.seriex in the Claude settings, keeping
// every other key and server as it is (in its place), indented with 2 spaces.
func mergeClaudeConfig(data []byte, helper string, args []string) ([]byte, error) {
	data = trimBOM(data)
	var top []jsonMember
	if len(bytes.TrimSpace(data)) > 0 {
		var err error
		if top, err = parseObject(data); err != nil {
			return nil, err
		}
	}
	if args == nil {
		args = []string{}
	}
	entry, err := marshalPlain(struct {
		Command string   `json:"command"`
		Args    []string `json:"args"`
	}{helper, args})
	if err != nil {
		return nil, err
	}
	idx := -1
	for i, m := range top {
		if m.key == "mcpServers" {
			idx = i // (with duplicate keys the last one counts, like JSON.parse)
		}
	}
	var servers []jsonMember
	if idx >= 0 && !bytes.Equal(bytes.TrimSpace(top[idx].val), []byte("null")) {
		if servers, err = parseObject(top[idx].val); err != nil {
			return nil, err
		}
	}
	found := false
	for i := range servers {
		if servers[i].key == serverName {
			servers[i].val = entry
			found = true
		}
	}
	if !found {
		servers = append(servers, jsonMember{serverName, entry})
	}
	val := writeObject(servers)
	if idx >= 0 {
		top[idx].val = val
	} else {
		top = append(top, jsonMember{"mcpServers", val})
	}
	var compact, out bytes.Buffer
	if err := json.Compact(&compact, writeObject(top)); err != nil {
		return nil, err
	}
	if err := json.Indent(&out, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}

// claudeConfigured: the Claude settings start the helper as "seriex", with
// the arguments this SerieX needs.
func claudeConfigured(data []byte, helper string, args []string) bool {
	var cfg struct {
		MCPServers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcpServers"`
	}
	if json.Unmarshal(trimBOM(data), &cfg) != nil {
		return false
	}
	e, ok := cfg.MCPServers[serverName]
	return ok && e.Command == helper && sameArgs(e.Args, args)
}

// sameArgs: two argument lists are equal (none and [] are the same).
func sameArgs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Codex and ChatGPT: config.toml
//
//	[mcp_servers.seriex]
//	command = 'H'
//	args = ['--data', '...']
//	startup_timeout_sec = 20

// errOtherForm: the file defines the seriex server in a form other than its
// own [mcp_servers.seriex] table (inline table, dotted keys), which SerieX
// does not rewrite.
var errOtherForm = errors.New("seriex is defined in another form")

// errInlineServers: the file writes all its servers as one inline table
// (mcp_servers = { ... }), to which no [mcp_servers.seriex] table can be added.
var errInlineServers = errors.New("the servers are one inline table")

func isSeriexPath(p []string) bool {
	return len(p) >= 2 && p[0] == "mcp_servers" && p[1] == serverName
}

// setCodexServer replaces the [mcp_servers.seriex] table (and its sub-tables)
// or appends one; every other table, key and comment stays byte for byte.
func setCodexServer(src, helper string, args []string) (string, error) {
	stmts, err := scanTOML(src)
	if err != nil {
		return "", err
	}
	type span struct{ start, end int }
	var blocks []span
	for i, st := range stmts {
		switch {
		case st.inline:
			continue
		case st.header:
			if isSeriexPath(st.path) {
				b := span{st.start, st.end}
				for j := i + 1; j < len(stmts) && !stmts[j].header; j++ {
					if !stmts[j].inline {
						b.end = stmts[j].end
					}
				}
				blocks = append(blocks, b)
			}
		case isSeriexPath(st.path) && !isSeriexPath(st.table):
			return "", errOtherForm // e.g. [mcp_servers] seriex = {...}, or mcp_servers.seriex.command = ...
		case len(st.path) == 1 && st.path[0] == "mcp_servers":
			return "", errInlineServers // mcp_servers = {...}: no table can be added to it
		}
	}
	nl := "\n"
	if strings.Contains(src, "\r\n") {
		nl = "\r\n"
	}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = tomlString(a)
	}
	block := "[mcp_servers." + serverName + "]" + nl +
		"command = " + tomlString(helper) + nl +
		"args = [" + strings.Join(quoted, ", ") + "]" + nl +
		"startup_timeout_sec = 20" + nl
	if len(blocks) == 0 {
		out := src
		if out != "" && !strings.HasSuffix(out, "\n") {
			out += nl
		}
		if strings.TrimSpace(out) != "" {
			out += nl
		}
		return out + block, nil
	}
	for i := 1; i < len(blocks); i++ {
		// a removed sub-table also takes the blank lines just before it
		st := blocks[i].start
		for st > blocks[i-1].end {
			prev := strings.LastIndexByte(src[:st-1], '\n') + 1
			if strings.TrimSpace(src[prev:st]) != "" {
				break
			}
			st = prev
		}
		blocks[i].start = st
	}
	var b strings.Builder
	pos := 0
	for i, bl := range blocks {
		b.WriteString(src[pos:bl.start])
		if i == 0 {
			b.WriteString(block)
		}
		pos = bl.end
	}
	b.WriteString(src[pos:])
	return b.String(), nil
}

// codexConfigured: the [mcp_servers.seriex] command is the helper and its
// args are the arguments this SerieX needs (no args counts as none).
func codexConfigured(src, helper string, args []string) bool {
	stmts, err := scanTOML(src)
	if err != nil {
		return false
	}
	command, haveCommand := "", false
	var got []string
	for _, st := range stmts {
		if st.header || len(st.path) != 3 || !isSeriexPath(st.path) {
			continue
		}
		switch st.path[2] {
		case "command":
			command, haveCommand = tomlStringValue(st.value)
		case "args":
			a, ok := tomlStringArray(st.value)
			if !ok {
				return false
			}
			got = a
		}
	}
	return haveCommand && command == helper && sameArgs(got, args)
}

// tomlString writes text as a TOML string: a literal string ('...') when it
// has no ' and no line break, else a basic string ("...") with \ and " escaped.
func tomlString(s string) string {
	literal := !strings.ContainsAny(s, "'")
	for _, r := range s {
		if (r < 0x20 && r != '\t') || r == 0x7f {
			literal = false
		}
	}
	if literal {
		return "'" + s + "'"
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '\\':
			b.WriteString(`\\`)
		case '"':
			b.WriteString(`\"`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\u%04X`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
