// SerieX Books server: serves the web client and the JSON API.
package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/appinfo"
	"seriex/internal/assistants"
	"seriex/internal/banking"
	"seriex/internal/companies"
	"seriex/internal/company"
	"seriex/internal/httpx"
	"seriex/internal/ledger"
	"seriex/internal/lists"
	"seriex/internal/model"
	"seriex/internal/qbimport"
	"seriex/internal/reports"
	"seriex/internal/sample"
	"seriex/internal/store"
)

func main() {
	host := flag.String("host", "127.0.0.1", "address to listen on")
	port := flag.Int("port", 8080, "port to listen on")
	dataDir := flag.String("data", "./data", "directory holding company files")
	webDir := flag.String("web", "", "directory with the built web client (default: ../web/dist or ./web)")
	allowHosts := flag.String("allow-host", "", "extra host names (comma separated) the app may be opened with, besides IP addresses and localhost")
	payrollURL := flag.String("payroll", envOr("SXB_PAYROLL", "http://127.0.0.1:8090"), "address of the SerieX Payroll server (for the app switcher); empty to hide it")
	backupDir := flag.String("backups", "", "folder for the automatic backups, one folder per company (default: <data>/backups)")
	backupEvery := flag.Duration("backup-interval", 24*time.Hour, "how old the last backup of a company must be before the next automatic one")
	mcpOn := flag.Bool("mcp", true, "let AI assistant apps on this computer connect to SerieX Books (each company file is shared under AI Assistants); false turns the connection off")
	mcpHelper := flag.String("mcp-helper", "", "full path of the seriex-mcp helper program that AI assistant apps on this computer start (the desktop app sets it)")
	flag.Parse()

	if !httpx.IsLoopbackHost(*host) {
		log.Printf("WARNING: -host %s lets other computers reach SerieX Books. Everything travels unencrypted (plain HTTP), "+
			"and a company file without passwords is open to anyone who can reach this address, with full administrator rights. "+
			"Give every company file an administrator password and use this only on a network you trust.", *host)
	}

	mgr, err := store.NewManager(*dataDir)
	if err != nil {
		log.Fatalf("data directory: %v", err)
	}
	defer mgr.CloseAll()

	rt := httpx.NewRouter(mgr)
	backups, err := companies.NewBackups(mgr, rt, *backupDir, *backupEvery)
	if err != nil {
		log.Fatalf("backup folder: %v", err)
	}
	companies.Register(rt, mgr)
	companies.RegisterBackups(rt, mgr, backups)
	companies.RegisterSample(rt, mgr, sample.FileID, sample.Generate)
	lists.Register(rt)
	ledger.Register(rt)
	reports.Register(rt)
	banking.Register(rt)
	banking.RegisterRuleSuggestions(rt)
	company.Register(rt)
	appinfo.Register(rt, *payrollURL)
	qbimport.Register(rt, func(ctx context.Context, req model.NewCompanyRequest, fill func(tx *sql.Tx, id string) error) (store.CompanyFile, error) {
		return companies.CreateCompanyWith(ctx, mgr, req, fill)
	})
	rt.Handle("GET", "/api/health", func(w http.ResponseWriter, r *http.Request) error {
		return httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now().Format(time.RFC3339)})
	})
	stopRequested := make(chan struct{})
	if token := shutdownToken(); token != "" {
		var once sync.Once
		rt.Handle("POST", "/api/shutdown", shutdownRoute(token, func() { once.Do(func() { close(stopRequested) }) }))
	}

	assistants.Register(rt, mgr, assistants.Config{On: *mcpOn, Host: *host, Port: *port, PayrollURL: *payrollURL, HelperPath: *mcpHelper, Version: appinfo.Version})

	dir := findWebDir(*webDir)
	if dir != "" {
		rt.Mux.Handle("/", spa(dir))
	} else {
		log.Printf("warning: web client not found; build it with `npm run build` in web/")
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("SerieX Books listening on http://%s (data: %s)", addr, mgr.Dir())
	var extraHosts []string
	for _, h := range strings.Split(*allowHosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			extraHosts = append(extraHosts, h)
		}
	}
	srv := &http.Server{Addr: addr, Handler: logRequests(httpx.Guard(rt.Mux, extraHosts)), ReadHeaderTimeout: 10 * time.Second}
	backups.Start()
	log.Printf("automatic backups: %s (every %s)", backups.Root(), *backupEvery)

	// On Ctrl+C or a stop request (the desktop app quitting, by SIGTERM or, on
	// Windows, by POST /api/shutdown): finish the requests in progress (a save,
	// a new company or an import cut off halfway can leave a broken file), back
	// up the companies that changed, and close the files. Both together stay
	// under the 10 seconds the desktop app waits before it forces the server.
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		select {
		case <-stop.Done():
		case <-stopRequested:
			log.Printf("stop requested by the desktop app")
		}
		ctx, done := context.WithTimeout(context.Background(), 4*time.Second)
		defer done()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("requests still running when stopping: %v", err)
		}
	}()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-finished
	backups.Shutdown(5 * time.Second)
	log.Printf("SerieX Books stopped")
}

// shutdownToken reads the secret for POST /api/shutdown and removes it from
// this process's environment. A secret shorter than 32 characters leaves the
// route off.
func shutdownToken() string {
	token := os.Getenv("SXB_SHUTDOWN_TOKEN")
	os.Unsetenv("SXB_SHUTDOWN_TOKEN")
	if token != "" && len(token) < 32 {
		log.Printf("SXB_SHUTDOWN_TOKEN is shorter than 32 characters; POST /api/shutdown stays off")
		return ""
	}
	return token
}

// shutdownRoute lets the program that started the server stop it the way
// Ctrl+C or SIGTERM does. Windows has no such signal for a background program,
// so the desktop app uses this there, to keep the backup on quit. It is on only
// when the desktop app passes a secret in SXB_SHUTDOWN_TOKEN, and it accepts
// only requests from this computer that carry that secret.
func shutdownRoute(token string, stop func()) httpx.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) error {
		got := r.Header.Get("X-SerieX-Shutdown-Token")
		if !httpx.FromThisComputer(r) || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			return apperr.Forbidden("Only the SerieX desktop app can stop SerieX Books.")
		}
		err := httpx.WriteJSON(w, http.StatusAccepted, map[string]any{"ok": true})
		stop()
		return err
	}
}

func findWebDir(flagDir string) string {
	candidates := []string{flagDir, "../web/dist", "./web", "./web/dist"}
	if exe, err := os.Executable(); err == nil {
		d := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(d, "web"), filepath.Join(d, "../web/dist"))
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if st, err := os.Stat(filepath.Join(c, "index.html")); err == nil && !st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return ""
}

// spa serves static files and falls back to index.html for client routes.
func spa(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			httpx.WriteJSON(w, http.StatusNotFound, map[string]string{"error": "Not found", "code": "not_found"})
			return
		}
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if st, err := os.Stat(p); err != nil || st.IsDir() {
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fs.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the real writer (streamed
// answers, such as those of AI assistants at /mcp, need Flush).
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: 200}
		h.ServeHTTP(sw, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %d %s", r.Method, r.URL.RequestURI(), sw.status, time.Since(start).Round(time.Millisecond))
		}
	})
}

// envOr returns the environment variable name, or def when it is not set.
func envOr(name, def string) string {
	if v, ok := os.LookupEnv(name); ok {
		return v
	}
	return def
}
