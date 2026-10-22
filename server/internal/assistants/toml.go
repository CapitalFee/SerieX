package assistants

import (
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

// A small reader of TOML files (the settings of Codex and ChatGPT). It finds
// the table headers and the key/value statements with their byte positions,
// so SerieX can replace its own table and keep everything else byte for byte.
// It checks the structure (strings, arrays, inline tables, comments) but does
// not build the values.

type tomlStmt struct {
	start, end int      // the statement's whole lines, newline included (not set for inline keys)
	header     bool     // [table] or [[array of tables]]
	path       []string // header: the table; key: the full key (table + dotted key)
	table      []string // key: the table it is written in
	value      string   // key: the value as written
	inline     bool     // key inside an inline table { ... }
}

var errTOML = errors.New("the file is not valid TOML")

type tomlScanner struct {
	src   string
	pos   int
	stmts []tomlStmt
	table []string
}

// scanTOML lists the headers and key/value statements of a TOML document.
func scanTOML(src string) ([]tomlStmt, error) {
	sc := &tomlScanner{src: src}
	if strings.HasPrefix(src, "\xef\xbb\xbf") {
		sc.pos = len("\xef\xbb\xbf")
	}
	for {
		sc.skipBlank()
		if sc.pos >= len(sc.src) {
			return sc.stmts, nil
		}
		lineStart := strings.LastIndexByte(sc.src[:sc.pos], '\n') + 1
		if sc.src[sc.pos] == '[' {
			array := strings.HasPrefix(sc.src[sc.pos:], "[[")
			sc.pos++
			if array {
				sc.pos++
			}
			path, err := sc.key()
			if err != nil {
				return nil, err
			}
			sc.skipSpace()
			closing := "]"
			if array {
				closing = "]]"
			}
			if !strings.HasPrefix(sc.src[sc.pos:], closing) {
				return nil, errTOML
			}
			sc.pos += len(closing)
			if err := sc.endLine(); err != nil {
				return nil, err
			}
			sc.stmts = append(sc.stmts, tomlStmt{start: lineStart, end: sc.pos, header: true, path: path})
			sc.table = path
			continue
		}
		key, err := sc.key()
		if err != nil {
			return nil, err
		}
		if !sc.eat('=') {
			return nil, errTOML
		}
		sc.skipSpace()
		full := joinPath(sc.table, key)
		vstart := sc.pos
		if err := sc.value(full); err != nil {
			return nil, err
		}
		value := sc.src[vstart:sc.pos]
		if err := sc.endLine(); err != nil {
			return nil, err
		}
		sc.stmts = append(sc.stmts, tomlStmt{start: lineStart, end: sc.pos, path: full, table: sc.table, value: value})
	}
}

func joinPath(a, b []string) []string {
	out := make([]string, 0, len(a)+len(b))
	return append(append(out, a...), b...)
}

func (sc *tomlScanner) peek() byte {
	if sc.pos < len(sc.src) {
		return sc.src[sc.pos]
	}
	return 0
}

// eat skips spaces and then c (false when c is not there).
func (sc *tomlScanner) eat(c byte) bool {
	sc.skipSpace()
	if sc.peek() == c {
		sc.pos++
		return true
	}
	return false
}

func (sc *tomlScanner) skipSpace() {
	for sc.pos < len(sc.src) && (sc.src[sc.pos] == ' ' || sc.src[sc.pos] == '\t') {
		sc.pos++
	}
}

func (sc *tomlScanner) skipComment() {
	if sc.peek() == '#' {
		for sc.pos < len(sc.src) && sc.src[sc.pos] != '\n' {
			sc.pos++
		}
	}
}

// skipBlank skips spaces, line breaks and comments.
func (sc *tomlScanner) skipBlank() {
	for sc.pos < len(sc.src) {
		switch sc.src[sc.pos] {
		case ' ', '\t', '\r', '\n':
			sc.pos++
		case '#':
			sc.skipComment()
		default:
			return
		}
	}
}

// endLine skips the rest of a statement's line: spaces, a comment, the line break.
func (sc *tomlScanner) endLine() error {
	sc.skipSpace()
	sc.skipComment()
	switch {
	case sc.pos >= len(sc.src):
		return nil
	case strings.HasPrefix(sc.src[sc.pos:], "\r\n"):
		sc.pos += 2
	case sc.src[sc.pos] == '\n':
		sc.pos++
	default:
		return errTOML
	}
	return nil
}

// key reads a key, dotted or not: a.b, "a b".c, 'x'.
func (sc *tomlScanner) key() ([]string, error) {
	var parts []string
	for {
		sc.skipSpace()
		var part string
		var err error
		switch sc.peek() {
		case '"':
			part, err = sc.basicString()
		case '\'':
			part, err = sc.literalString()
		default:
			start := sc.pos
			for sc.pos < len(sc.src) && bareKeyChar(sc.src[sc.pos]) {
				sc.pos++
			}
			if sc.pos == start {
				return nil, errTOML
			}
			part = sc.src[start:sc.pos]
		}
		if err != nil {
			return nil, err
		}
		parts = append(parts, part)
		sc.skipSpace()
		if sc.peek() != '.' {
			return parts, nil
		}
		sc.pos++
	}
}

func bareKeyChar(c byte) bool {
	return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

// value reads one value. path is the key it belongs to: the keys of an inline
// table are listed under it (nil: not listed).
func (sc *tomlScanner) value(path []string) error {
	rest := sc.src[sc.pos:]
	switch {
	case strings.HasPrefix(rest, `"""`):
		return sc.multiline(`"""`, '"', true)
	case strings.HasPrefix(rest, `'''`):
		return sc.multiline(`'''`, '\'', false)
	case strings.HasPrefix(rest, `"`):
		_, err := sc.basicString()
		return err
	case strings.HasPrefix(rest, `'`):
		_, err := sc.literalString()
		return err
	case strings.HasPrefix(rest, "["):
		return sc.array()
	case strings.HasPrefix(rest, "{"):
		return sc.inlineTable(path)
	}
	return sc.scalar()
}

func (sc *tomlScanner) array() error {
	sc.pos++ // [
	for {
		sc.skipBlank()
		if sc.peek() == ']' {
			sc.pos++
			return nil
		}
		if sc.pos >= len(sc.src) {
			return errTOML
		}
		if err := sc.value(nil); err != nil {
			return err
		}
		sc.skipBlank()
		switch sc.peek() {
		case ',':
			sc.pos++
		case ']':
		default:
			return errTOML
		}
	}
}

func (sc *tomlScanner) inlineTable(path []string) error {
	sc.pos++ // {
	sc.skipBlank()
	if sc.peek() == '}' {
		sc.pos++
		return nil
	}
	for {
		sc.skipBlank()
		key, err := sc.key()
		if err != nil {
			return err
		}
		sc.skipBlank()
		if sc.peek() != '=' {
			return errTOML
		}
		sc.pos++
		sc.skipBlank()
		var full []string
		if path != nil {
			full = joinPath(path, key)
		}
		vstart := sc.pos
		if err := sc.value(full); err != nil {
			return err
		}
		if path != nil {
			sc.stmts = append(sc.stmts, tomlStmt{inline: true, path: full, table: path, value: sc.src[vstart:sc.pos]})
		}
		sc.skipBlank()
		switch sc.peek() {
		case ',':
			sc.pos++
			sc.skipBlank()
			if sc.peek() == '}' { // a trailing comma (TOML 1.1)
				sc.pos++
				return nil
			}
		case '}':
			sc.pos++
			return nil
		default:
			return errTOML
		}
	}
}

// scalar reads a number, a boolean or a date and time.
func (sc *tomlScanner) scalar() error {
	start := sc.pos
	for sc.pos < len(sc.src) {
		c := sc.src[sc.pos]
		if c == ' ' && isDate(sc.src[start:sc.pos]) && sc.pos+1 < len(sc.src) && sc.src[sc.pos+1] >= '0' && sc.src[sc.pos+1] <= '9' {
			sc.pos++ // 1979-05-27 07:32:00
			continue
		}
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == ',' || c == ']' || c == '}' || c == '#' {
			break
		}
		sc.pos++
	}
	if sc.pos == start {
		return errTOML
	}
	return nil
}

func isDate(s string) bool {
	if len(s) != 10 || s[4] != '-' || s[7] != '-' {
		return false
	}
	for i, c := range []byte(s) {
		if i != 4 && i != 7 && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// multiline skips a multi-line string (between three double quotes, or
// three single quotes), with up to two more quotes just before the closing ones.
func (sc *tomlScanner) multiline(delim string, quote byte, escapes bool) error {
	sc.pos += 3
	for sc.pos < len(sc.src) {
		if escapes && sc.src[sc.pos] == '\\' {
			sc.pos += 2
			continue
		}
		if strings.HasPrefix(sc.src[sc.pos:], delim) {
			sc.pos += 3
			for i := 0; i < 2 && sc.peek() == quote; i++ {
				sc.pos++
			}
			return nil
		}
		sc.pos++
	}
	return errTOML
}

// literalString reads '...' (no escapes, one line).
func (sc *tomlScanner) literalString() (string, error) {
	sc.pos++
	start := sc.pos
	for sc.pos < len(sc.src) {
		switch sc.src[sc.pos] {
		case '\'':
			s := sc.src[start:sc.pos]
			sc.pos++
			return s, nil
		case '\n', '\r':
			return "", errTOML
		}
		sc.pos++
	}
	return "", errTOML
}

// basicString reads "..." (one line) and decodes its escapes.
func (sc *tomlScanner) basicString() (string, error) {
	sc.pos++
	var b strings.Builder
	for sc.pos < len(sc.src) {
		c := sc.src[sc.pos]
		switch c {
		case '"':
			sc.pos++
			return b.String(), nil
		case '\n', '\r':
			return "", errTOML
		case '\\':
			if sc.pos+1 >= len(sc.src) {
				return "", errTOML
			}
			e := sc.src[sc.pos+1]
			sc.pos += 2
			switch e {
			case 'b':
				b.WriteByte('\b')
			case 't':
				b.WriteByte('\t')
			case 'n':
				b.WriteByte('\n')
			case 'f':
				b.WriteByte('\f')
			case 'r':
				b.WriteByte('\r')
			case 'e':
				b.WriteByte(0x1b)
			case '"':
				b.WriteByte('"')
			case '\\':
				b.WriteByte('\\')
			case 'x', 'u', 'U':
				n := map[byte]int{'x': 2, 'u': 4, 'U': 8}[e]
				if sc.pos+n > len(sc.src) {
					return "", errTOML
				}
				v, err := strconv.ParseUint(sc.src[sc.pos:sc.pos+n], 16, 32)
				if err != nil || !utf8.ValidRune(rune(v)) {
					return "", errTOML
				}
				b.WriteRune(rune(v))
				sc.pos += n
			default:
				return "", errTOML
			}
		default:
			b.WriteByte(c)
			sc.pos++
		}
	}
	return "", errTOML
}

// tomlStringValue decodes a value written as a one-line string ('...' or "...").
func tomlStringValue(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, `"""`) || strings.HasPrefix(raw, `'''`) {
		return "", false
	}
	sc := &tomlScanner{src: raw}
	var s string
	var err error
	switch sc.peek() {
	case '"':
		s, err = sc.basicString()
	case '\'':
		s, err = sc.literalString()
	default:
		return "", false
	}
	return s, err == nil && sc.pos == len(raw)
}

// tomlStringArray decodes a value written as an array of one-line strings
// (['a', "b"], also over several lines, with comments).
func tomlStringArray(raw string) ([]string, bool) {
	sc := &tomlScanner{src: strings.TrimSpace(raw)}
	if sc.peek() != '[' {
		return nil, false
	}
	sc.pos++
	out := []string{}
	for {
		sc.skipBlank()
		switch sc.peek() {
		case ']':
			sc.pos++
			return out, sc.pos == len(sc.src)
		case '"', '\'':
			if strings.HasPrefix(sc.src[sc.pos:], `"""`) || strings.HasPrefix(sc.src[sc.pos:], `'''`) {
				return nil, false
			}
			var v string
			var err error
			if sc.peek() == '"' {
				v, err = sc.basicString()
			} else {
				v, err = sc.literalString()
			}
			if err != nil {
				return nil, false
			}
			out = append(out, v)
		default:
			return nil, false
		}
		sc.skipBlank()
		switch sc.peek() {
		case ',':
			sc.pos++
		case ']':
		default:
			return nil, false
		}
	}
}
