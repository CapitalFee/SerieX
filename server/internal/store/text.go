package store

import (
	"bytes"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	xunicode "golang.org/x/text/encoding/unicode"
	"golang.org/x/text/unicode/norm"

	"seriex/internal/apperr"
)

// CleanText normalizes a one-line text field typed by a user: invalid UTF-8
// is refused, the text is put in Unicode NFC form (so "é" typed as one or two
// characters is the same name), surrounding spaces are trimmed, and control
// characters (line breaks, tabs, NUL...) are refused. max > 0 limits the
// length in characters. field and label are used in the error messages.
func CleanText(s, field, label string, max int) (string, error) {
	if !utf8.ValidString(s) {
		return "", apperr.Validation(field, "%s contains characters that cannot be read. Type it again.", label)
	}
	s = strings.TrimSpace(norm.NFC.String(s))
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == ' ' || r == ' ' {
			return "", apperr.Validation(field, "%s cannot contain line breaks, tabs or other control characters.", label)
		}
	}
	if max > 0 && utf8.RuneCountInString(s) > max {
		return "", apperr.Validation(field, "%s is too long (%d characters maximum).", label, max)
	}
	return s, nil
}

// CleanMultiline is CleanText for multi-line fields (notes, addresses): line
// breaks and tabs are allowed, other control characters are removed.
func CleanMultiline(s string, max int) (string, bool) {
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "")
	}
	s = norm.NFC.String(s)
	s = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if r == '\r' {
			return -1
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return s, max <= 0 || utf8.RuneCountInString(s) <= max
}

// DecodeText converts an uploaded text file to UTF-8: UTF-8 (with or without
// a byte-order mark) is kept, UTF-16 files (Excel "Unicode Text") are decoded,
// and anything else that is not valid UTF-8 is read as Windows-1252 (Excel
// "CSV (Comma delimited)" on Windows), so names like "Café" stay readable.
func DecodeText(data []byte) []byte {
	switch {
	case bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}):
		data = data[3:]
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}), bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		if out, err := xunicode.UTF16(xunicode.LittleEndian, xunicode.UseBOM).NewDecoder().Bytes(data); err == nil {
			return out
		}
	case len(data) >= 4 && data[0] == 0 && data[1] != 0 && data[2] == 0:
		if out, err := xunicode.UTF16(xunicode.BigEndian, xunicode.IgnoreBOM).NewDecoder().Bytes(data); err == nil {
			return out
		}
	case len(data) >= 4 && data[0] != 0 && data[1] == 0 && data[3] == 0:
		if out, err := xunicode.UTF16(xunicode.LittleEndian, xunicode.IgnoreBOM).NewDecoder().Bytes(data); err == nil {
			return out
		}
	}
	if utf8.Valid(data) {
		return data
	}
	if out, err := charmap.Windows1252.NewDecoder().Bytes(data); err == nil {
		return out
	}
	return bytes.ToValidUTF8(data, []byte("�"))
}

// CSVDelimiter guesses the field separator of a decoded CSV / text export from
// its first non-blank line: a tab (Excel "Unicode Text" / "Text (Tab
// delimited)") or a semicolon (Excel in countries that use a decimal comma)
// when the line has more of them than commas, else a comma.
func CSVDelimiter(data []byte) rune {
	first := ""
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			first = line
			break
		}
	}
	delim := ','
	if strings.Count(first, ";") > strings.Count(first, ",") {
		delim = ';'
	}
	if strings.Count(first, "\t") > strings.Count(first, string(delim)) {
		delim = '\t'
	}
	return delim
}
