package seriexmcp

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// IsLoopbackHost reports whether a host name (without port) is this
// computer: "localhost", a name ending in ".localhost", or a loopback address
// (127.x.x.x, ::1).
func IsLoopbackHost(h string) bool {
	h = strings.ToLower(strings.TrimSuffix(strings.Trim(h, "[]"), "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// hostOnly removes the port of a Host header value.
func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// DataDir is the data folder of the SerieX desktop app: SERIEX_DATA_DIR when
// set, else DefaultDataDir. SerieX Books keeps its company files in
// <data>/books.
func DataDir() string {
	if v := strings.TrimSpace(os.Getenv("SERIEX_DATA_DIR")); v != "" && !strings.HasPrefix(v, "${") {
		if abs, err := filepath.Abs(v); err == nil {
			return abs
		}
		return v
	}
	return DefaultDataDir()
}

// DefaultDataDir is the data folder the SerieX desktop app uses on this
// computer when SERIEX_DATA_DIR is not set: ~/Library/Application
// Support/SerieX (macOS), %APPDATA%\SerieX (Windows) or
// $XDG_CONFIG_HOME/SerieX, ~/.config/SerieX (Linux). It ignores
// SERIEX_DATA_DIR, so SerieX Books can tell whether the seriex-mcp program
// must be given its data folder (--data). "" when unknown.
func DefaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			return filepath.Join(v, "SerieX")
		}
	case "darwin":
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, "Library", "Application Support", "SerieX")
		}
	default:
		if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
			return filepath.Join(v, "SerieX")
		}
		if h, err := os.UserHomeDir(); err == nil {
			return filepath.Join(h, ".config", "SerieX")
		}
	}
	return ""
}

// KeyFileName is the name of the access key file in the SerieX Books data folder.
const KeyFileName = "mcp-access.json"

// DefaultKeyPath is <data>/books/mcp-access.json ("" when the data folder is unknown).
func DefaultKeyPath() string {
	return KeyPathIn(DataDir())
}

// KeyPathIn is the access key file of the SerieX data folder dataDir:
// <dataDir>/books/mcp-access.json ("" when dataDir is "").
func KeyPathIn(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	return filepath.Join(dataDir, "books", KeyFileName)
}

// RunningPort returns the port the desktop app started a server on ("books"
// or "payroll"), read from <data>/servers.json; 0 when unknown or when the
// process that wrote it is no longer running. The file may be left over from
// a crash, so check that the server answers.
func RunningPort(dataDir, app string) int {
	port, pid := RunningServer(dataDir, app)
	if port == 0 || (pid > 0 && !ProcessRunning(pid)) {
		return 0
	}
	return port
}

// RunningServer returns the port and process number the desktop app wrote
// for a server ("books" or "payroll") in <data>/servers.json (0 when unknown).
func RunningServer(dataDir, app string) (port, pid int) {
	if dataDir == "" {
		return 0, 0
	}
	b, err := os.ReadFile(filepath.Join(dataDir, "servers.json"))
	if err != nil {
		return 0, 0
	}
	var m map[string]struct {
		PID  int `json:"pid"`
		Port int `json:"port"`
	}
	if json.Unmarshal(b, &m) != nil {
		return 0, 0
	}
	e := m[app]
	if e.Port <= 0 || e.Port > 65535 {
		return 0, 0
	}
	return e.Port, max(e.PID, 0)
}
