package main

import (
	"crypto/subtle"
	"log"
	"net"
	"net/http"
	"os"

	"seriexpayroll/internal/apperr"
	"seriexpayroll/internal/httpx"
)

// Stop request of the SerieX desktop app. Windows has no SIGTERM: the app
// would have to force the server to end, so the company files would not be
// closed (their -wal journal stays next to the .sxp file until the next
// open). When the app starts this server with SXP_SHUTDOWN_TOKEN set to a
// random secret, it can instead send
//
//	POST /api/shutdown   header X-SerieX-Shutdown-Token: <token>, no body
//
// and the server answers 202 {"ok":true}, then does what SIGTERM does (finish
// the requests in progress, close the company files) and exits with code 0.
// A wrong token or a caller on another computer gets 403. Without the
// variable the route does not exist (404). Same contract as SerieX Books
// (SXB_SHUTDOWN_TOKEN).
const (
	shutdownEnv    = "SXP_SHUTDOWN_TOKEN"
	shutdownHeader = "X-SerieX-Shutdown-Token"
	shutdownMinLen = 32
)

// shutdownToken reads the token and removes it from this process's
// environment, so nothing this server starts can inherit it.
func shutdownToken() string {
	tok := os.Getenv(shutdownEnv)
	os.Unsetenv(shutdownEnv)
	if tok != "" && len(tok) < shutdownMinLen {
		log.Printf("%s is shorter than %d characters; POST /api/shutdown stays off", shutdownEnv, shutdownMinLen)
		return ""
	}
	return tok
}

// registerShutdown adds POST /api/shutdown when token is set; stop starts the shutdown.
func registerShutdown(rt *httpx.Router, token string, stop func()) {
	if token == "" {
		return
	}
	rt.Handle("POST", "/api/shutdown", func(w http.ResponseWriter, r *http.Request) error {
		if !fromThisComputer(r) || subtle.ConstantTimeCompare([]byte(r.Header.Get(shutdownHeader)), []byte(token)) != 1 {
			return apperr.Forbidden("Not allowed.")
		}
		log.Printf("stopping: asked by the SerieX app")
		err := httpx.WriteJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
		stop() // srv.Shutdown waits for this request to finish, so the answer is sent first
		return err
	})
}

// fromThisComputer: the request came over a loopback connection.
func fromThisComputer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
