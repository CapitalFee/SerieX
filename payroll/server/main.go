// SerieX Payroll server: serves the payroll web client and the JSON API, and
// posts payroll transactions to SerieX Books over its HTTP API.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"seriexpayroll/internal/books"
	"seriexpayroll/internal/employees"
	"seriexpayroll/internal/forms"
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/items"
	"seriexpayroll/internal/liabilities"
	"seriexpayroll/internal/payroll"
	"seriexpayroll/internal/posting"
	"seriexpayroll/internal/reports"
	"seriexpayroll/internal/setup"
	"seriexpayroll/internal/store"
	"seriexpayroll/internal/taxes"
)

func main() {
	// company files hold social security and bank account numbers: everything
	// this process creates is readable only by the user running it
	restrictUmask()

	host := flag.String("host", "127.0.0.1", "address to listen on")
	port := flag.Int("port", 8090, "port to listen on")
	dataDir := flag.String("data", "./data", "directory holding payroll company files")
	webDir := flag.String("web", "", "directory with the built web client (default: ../web/dist or ./web)")
	booksURL := flag.String("books", envOr("SXP_BOOKS", "http://127.0.0.1:8080"), "address of the SerieX Books server")
	allowHosts := flag.String("allow-host", envOr("SXP_ALLOW_HOST", ""), "extra host names (comma separated) the app may be opened with, besides IP addresses and localhost")
	flag.Parse()

	if !httpx.IsLoopbackHost(*host) {
		log.Printf("WARNING: -host %s lets other computers reach SerieX Payroll. Everything travels unencrypted (plain HTTP), "+
			"and a company file whose SerieX Books file has no passwords is open to anyone who can reach this address, with full administrator rights. "+
			"Give every SerieX Books company file an administrator password and use this only on a network you trust.", *host)
	}

	books.Default = books.New(*booksURL)
	stopToken := shutdownToken() // read (and removed from the environment) before anything else starts

	mgr, err := store.NewManager(*dataDir)
	if err != nil {
		log.Fatalf("data directory: %v", err)
	}
	defer mgr.CloseAll()

	rt := httpx.NewRouter(mgr)
	setup.Register(rt, mgr)
	taxes.Register(rt)
	items.Register(rt)
	employees.Register(rt)
	payroll.Register(rt)
	liabilities.Register(rt)
	forms.Register(rt)
	reports.Register(rt)
	_ = posting.Lookup
	rt.Handle("GET", "/api/health", func(w http.ResponseWriter, r *http.Request) error {
		return httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now().Format(time.RFC3339)})
	})
	asked, requestStop := context.WithCancel(context.Background())
	defer requestStop()
	registerShutdown(rt, stopToken, requestStop)

	dir := findWebDir(*webDir)
	if dir != "" {
		rt.Mux.Handle("/", spa(dir))
	} else {
		log.Printf("warning: web client not found; build it with `npm run build` in web/")
	}

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("SerieX Payroll listening on http://%s (data: %s, SerieX Books: %s)", addr, mgr.Dir(), books.Default.BaseURL)
	var extraHosts []string
	for _, h := range strings.Split(*allowHosts, ",") {
		if h = strings.TrimSpace(h); h != "" {
			extraHosts = append(extraHosts, h)
		}
	}
	srv := &http.Server{Addr: addr, Handler: logRequests(httpx.Guard(rt.Mux, extraHosts)), ReadHeaderTimeout: 10 * time.Second}

	// On Ctrl+C, SIGTERM or POST /api/shutdown (the desktop app quitting): finish
	// the requests in progress, then close the company files, which writes their
	// -wal journal back into the .sxp file (a copy of the .sxp file alone is then
	// complete).
	stop, cancel := signal.NotifyContext(asked, os.Interrupt, syscall.SIGTERM)
	defer cancel()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		<-stop.Done()
		ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("stopping: requests still running after 3 seconds: %v", err)
		}
	}()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-finished
	mgr.CloseAll()
	log.Printf("SerieX Payroll stopped")
}

func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
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
