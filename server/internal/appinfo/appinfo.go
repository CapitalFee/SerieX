// Package appinfo serves GET /api/info (the app name and version, and where the
// companion SerieX Payroll app runs, for the app switcher) and GET /api/c/{cid}/session.
package appinfo

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"seriex/internal/httpx"
	"seriex/internal/store"
)

// AppName and Version identify this server to the web client and to SerieX Payroll.
const (
	AppName = "SerieX Books"
	Version = "2026.10.4"
)

// Info is the response of GET /api/info.
type Info struct {
	App              string `json:"app"`
	Version          string `json:"version"`
	PayrollURL       string `json:"payrollUrl"`
	PayrollReachable bool   `json:"payrollReachable"`
}

// Register adds GET /api/info. payrollURL is the SerieX Payroll address ("" when not configured).
func Register(rt *httpx.Router, payrollURL string) {
	payrollURL = strings.TrimRight(strings.TrimSpace(payrollURL), "/")
	// keep a few idle connections, so frequent /api/info calls (AI assistant
	// tools ask it) reuse them instead of opening new ones each time
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.MaxIdleConnsPerHost = 16
	client := &http.Client{Timeout: time.Second, Transport: tr}
	rt.Handle("GET", "/api/info", func(w http.ResponseWriter, r *http.Request) error {
		info := Info{App: AppName, Version: Version, PayrollURL: payrollURL}
		if payrollURL != "" {
			info.PayrollReachable = pingPayroll(r.Context(), client, payrollURL)
		}
		return httpx.WriteJSON(w, http.StatusOK, info)
	})

	// GET /api/c/{cid}/session: whom the caller's session belongs to. SerieX Payroll uses
	// it to check a Books session token it was handed (header X-Books-Session). Read-only.
	rt.C("GET", "/session", func(c *httpx.Ctx) error {
		admin, err := store.IsAdmin(c.Context(), c.DB, c.User)
		if err != nil {
			return err
		}
		return c.JSON(map[string]any{"user": c.User, "isAdmin": admin})
	})
}

// pingPayroll is true when <url>/api/info answers as SerieX Payroll.
func pingPayroll(ctx context.Context, client *http.Client, url string) bool {
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"/api/info", nil)
	if err != nil {
		return false
	}
	res, err := client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return false
	}
	var body struct {
		App string `json:"app"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, res.Body, 64<<10)).Decode(&body); err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(body.App), "payroll")
}
