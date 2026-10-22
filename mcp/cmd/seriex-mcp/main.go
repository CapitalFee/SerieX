// Command seriex-mcp lets AI assistants that start a local program (Claude
// Desktop and other MCP clients using stdio) use SerieX.
//
// It finds the SerieX app running on this computer and passes everything on
// to the MCP server built into SerieX Books (<books address>/mcp), signing
// every request with the access key SerieX keeps in
// <data>/books/mcp-access.json (the key itself is never sent) and checking
// that the answers come from a SerieX that knows the same key. It keeps
// running when SerieX is closed: the tools then answer that SerieX must be
// opened, and it connects again as soon as SerieX runs.
//
// Options:
//
//	--data <folder>  the SerieX data folder: the folder that holds books/ and
//	                 servers.json (default: SERIEX_DATA_DIR, else the SerieX
//	                 app's data folder on this computer). SerieX Books adds it
//	                 to the settings it writes for AI assistant apps when its
//	                 data folder is not the usual one. An empty value (an
//	                 optional setting the user left blank) means the default.
//	--version        print the version and exit
//	--check          check the connection to SerieX, print the result and exit
//
// Settings (environment variables, all optional):
//
//	SERIEX_URL           address of SerieX Books (default: found automatically)
//	SERIEX_MCP_KEY       access key (default: read from the SerieX data folder)
//	SERIEX_DATA_DIR      SerieX data folder (default: the desktop app's; --data wins)
//	SERIEX_ALLOW_REMOTE  "true" to allow a SERIEX_URL on another computer (https only)
//	SERIEX_MCP_DEBUG     "true" for detailed logs on stderr
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/CapitalFee/SerieX/mcp/seriexmcp"
)

// version is set at build time (-ldflags "-X main.version=...").
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	check := flag.Bool("check", false, "check the connection to SerieX, print the result and exit")
	dataDir := flag.String("data", "", "the SerieX data `folder` (the folder that holds books/ and servers.json); "+
		"default: SERIEX_DATA_DIR, else the SerieX app's data folder on this computer")
	flag.Parse()
	if *showVersion {
		fmt.Println("seriex-mcp", version)
		return
	}
	level := slog.LevelInfo
	if envBool("SERIEX_MCP_DEBUG") {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	b := newBridge(loadConfig(*dataDir), log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *check {
		fmt.Println(b.statusText(ctx))
		connected := b.current() != nil
		b.close()
		if !connected {
			os.Exit(1)
		}
		return
	}
	if err := b.run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("seriex-mcp stopped", "error", err)
		os.Exit(1)
	}
}

// config is read once from the environment.
type config struct {
	url         string // SERIEX_URL
	base        string // SERIEX_URL without "/mcp"
	urlErr      error  // SERIEX_URL cannot be used
	key         string // SERIEX_MCP_KEY
	allowRemote bool   // SERIEX_ALLOW_REMOTE
	dataDir     string
	dataFrom    string // where dataDir was given: "--data", "SERIEX_DATA_DIR" or "" (the usual folder)
	keyPath     string
}

// loadConfig reads the settings; dataFlag is the --data option ("" when not
// given, or given empty: an optional setting of the assistant app left blank).
func loadConfig(dataFlag string) config {
	c := config{
		url:         envValue("SERIEX_URL"),
		key:         envValue("SERIEX_MCP_KEY"),
		allowRemote: envBool("SERIEX_ALLOW_REMOTE"),
		dataDir:     seriexmcp.DataDir(),
	}
	if envValue("SERIEX_DATA_DIR") != "" {
		c.dataFrom = "SERIEX_DATA_DIR"
	}
	if d := strings.TrimSpace(dataFlag); d != "" && !strings.HasPrefix(d, "${") { // (a placeholder the app did not fill in)
		if abs, err := filepath.Abs(d); err == nil {
			d = abs
		}
		c.dataDir, c.dataFrom = d, "--data"
	}
	c.keyPath = seriexmcp.KeyPathIn(c.dataDir)
	if c.url != "" {
		c.base, c.urlErr = checkURL(c.url, c.allowRemote)
	}
	return c
}

// checkData explains, in plain words, why a data folder given with --data
// or SERIEX_DATA_DIR cannot be used (nil when it can, or when it is not
// needed because SERIEX_URL and SERIEX_MCP_KEY are both set). It is checked
// at every connection attempt, so a folder made later is picked up.
func (c config) checkData() error {
	if c.dataFrom == "" || (c.url != "" && c.key != "") {
		return nil
	}
	fix := "Correct the SerieX data folder in the settings of your AI assistant app (or leave it empty to use the usual one), or set the app up again from SerieX (AI Assistants)."
	if c.dataFrom != "--data" {
		fix = "Correct " + c.dataFrom + ", or remove it to use the usual SerieX data folder."
	}
	fi, err := os.Stat(c.dataDir)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return errf("The SerieX data folder %s (given with %s) does not exist. %s", c.dataDir, c.dataFrom, fix)
	case err != nil:
		return errf("The SerieX data folder %s (given with %s) cannot be opened: %s. %s", c.dataDir, c.dataFrom, plainOS(err), fix)
	case !fi.IsDir():
		return errf("The SerieX data folder %s (given with %s) is a file, not a folder. %s", c.dataDir, c.dataFrom, fix)
	}
	if _, err := os.Stat(filepath.Join(c.dataDir, "books")); errors.Is(err, fs.ErrNotExist) {
		return errf("The folder %s (given with %s) is not a SerieX data folder: it has no books folder in it. %s", c.dataDir, c.dataFrom, fix)
	}
	return nil
}

// plainOS is the reason of a file error without the operation and path.
func plainOS(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
}

// checkURL checks SERIEX_URL and returns the address of SerieX Books (without
// "/mcp"). An address on another computer needs SERIEX_ALLOW_REMOTE=true and
// https, so the requests are encrypted.
func checkURL(raw string, allowRemote bool) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return "", errf("SERIEX_URL must be an address such as http://127.0.0.1:47180 (it is %q).", raw)
	}
	if !seriexmcp.IsLoopbackHost(u.Hostname()) {
		if !allowRemote {
			return "", errf("SERIEX_URL must point to this computer (127.0.0.1 or localhost). To use SerieX on another computer, also set SERIEX_ALLOW_REMOTE=true.")
		}
		if u.Scheme != "https" {
			return "", errf("SERIEX_URL points to another computer, so it must start with https:// (the connection must be encrypted).")
		}
	}
	u.RawQuery, u.Fragment = "", ""
	u.Path = strings.TrimSuffix(strings.TrimRight(u.Path, "/"), "/mcp")
	u.RawPath = ""
	return strings.TrimRight(u.String(), "/"), nil
}

// envValue is a setting, or "" when missing or a placeholder the host did not
// fill in (for example "${user_config.url}").
func envValue(name string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if strings.HasPrefix(v, "${") {
		return ""
	}
	return v
}

func envBool(name string) bool {
	switch strings.ToLower(envValue(name)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}
