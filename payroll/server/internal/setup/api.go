// Package setup serves the global routes (company list, login through SerieX
// Books, payroll setup, app info, meta lists), company payroll information,
// preferences, state settings, user access, the SerieX Books link routes
// (status, pickers, sync, verify) and the audit trail. It sets rt.Auth.
package setup

import (
	"seriexpayroll/internal/httpx"
	"seriexpayroll/internal/store"
)

var mgr *store.Manager

// Register adds the setup/company/books routes and sets rt.Auth.
func Register(rt *httpx.Router, m *store.Manager) {
	mgr = m
	rt.Auth = authenticate
	loadProofKey(m.Dir())

	// global
	rt.Handle("GET", "/api/info", handleInfo)
	rt.Handle("GET", "/api/meta", handleMeta)
	rt.Handle("GET", "/api/companies", handleCompanies)
	rt.Handle("GET", "/api/companies/{id}/auth", handleAuthInfo)
	rt.Handle("POST", "/api/companies/{id}/login", handleLogin)
	rt.Handle("POST", "/api/companies/{id}/setup", handleSetup)
	rt.Handle("GET", "/api/companies/{id}/bank-accounts", handleSetupBankAccounts)
	rt.Handle("POST", "/api/c/{cid}/logout", handleLogout)

	registerCompany(rt)
	registerBooks(rt)
}
