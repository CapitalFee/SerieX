package companies

import (
	"context"
	"database/sql"
	"net/http"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/store"
)

// SampleGenerator fills a new company file with the sample company
// (sample.Generate); today is YYYY-MM-DD.
type SampleGenerator func(ctx context.Context, tx *sql.Tx, today string) error

// RegisterSample adds POST /api/companies/sample: it (re)creates the sample
// company file fileID with gen and returns its store.CompanyFile. An existing
// sample file is closed and deleted first.
func RegisterSample(rt *httpx.Router, mgr *store.Manager, fileID string, gen SampleGenerator) {
	rt.Handle("POST", "/api/companies/sample", func(w http.ResponseWriter, r *http.Request) error {
		// finish the file even when the browser stops waiting
		ctx := context.WithoutCancel(r.Context())
		var creds Credentials
		if err := decodeCredentials(r, &creds); err != nil {
			return err
		}
		if mgr.Exists(fileID) {
			// replacing a sample that was given passwords needs its administrator
			if err := RequireFileAccess(rt, mgr, r, fileID, true, &creds,
				"The sample company file has passwords. Only its administrator can replace it: enter the administrator's user name and password."); err != nil {
				return err
			}
		}
		fileMu.Lock()
		defer fileMu.Unlock()
		if mgr.Exists(fileID) {
			if err := mgr.Delete(fileID); err != nil {
				return apperr.Conflict("The existing sample company could not be replaced. Close it in every window and try again.")
			}
		}
		if rt.FileReplaced != nil {
			rt.FileReplaced(fileID)
		}
		today := store.Today()
		if err := mgr.Create(ctx, fileID, func(tx *sql.Tx) error { return gen(ctx, tx, today) }); err != nil {
			return err
		}
		cf, err := FileInfo(mgr, fileID)
		if err != nil {
			return err
		}
		return httpx.WriteJSON(w, http.StatusOK, cf)
	})
}
