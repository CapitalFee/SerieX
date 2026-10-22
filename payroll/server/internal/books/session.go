package books

import "seriexpayroll/internal/httpx"

// S returns the Books session of a company-scoped payroll request.
func S(c *httpx.Ctx) Session {
	return Session{CompanyID: c.CompanyID, Token: c.BooksToken, Assistant: c.Assistant}
}

// Opts returns the answers the user already gave in this request: ?force=1
// (Yes to a confirm question) and the closing date password header.
func Opts(c *httpx.Ctx) Options {
	return Options{Force: c.Force(), ClosingPassword: c.ClosingPassword()}
}
