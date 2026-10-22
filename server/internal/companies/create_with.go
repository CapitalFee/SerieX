package companies

import (
	"context"
	"database/sql"

	"seriex/internal/model"
	"seriex/internal/store"
)

// CreateCompanyWith creates a company file like CreateCompany, then runs fill
// inside the same transaction (the QuickBooks import fills a new company this
// way). When fill returns an error nothing is kept: the file is removed and
// the error returned, so a trial run returns an error of its own on purpose.
func CreateCompanyWith(ctx context.Context, mgr *store.Manager, req model.NewCompanyRequest, fill func(tx *sql.Tx, id string) error) (store.CompanyFile, error) {
	if err := cleanRequest(&req); err != nil {
		return store.CompanyFile{}, err
	}
	fileMu.Lock()
	id := mgr.UniqueID(req.Name)
	err := mgr.Create(ctx, id, func(tx *sql.Tx) error {
		if err := InitCompany(ctx, tx, req); err != nil {
			return err
		}
		return fill(tx, id)
	})
	fileMu.Unlock()
	if err != nil {
		return store.CompanyFile{}, err
	}
	return FileInfo(mgr, id)
}
