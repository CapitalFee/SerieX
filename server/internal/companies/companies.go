// Package companies manages company files: list, create (with a default chart
// of accounts and default lists), delete, backup, restore and copy.
//
// Exported for other packages (e.g. the sample company generator):
// Templates, InitCompany (fills a new file inside store.Manager.Create),
// CreateCompany (validates, picks a file id and creates the file) and FileInfo.
package companies

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/model"
	"seriex/internal/store"
)

// maxRestoreSize is the largest backup file accepted by restore (a safety
// limit far above any real company file; free disk space is checked too).
const maxRestoreSize = 64 << 30

// fileMu serializes the choice of new file ids and file creation/renames.
var fileMu sync.Mutex

// Register adds the /api/companies routes.
func Register(rt *httpx.Router, mgr *store.Manager) {
	rt.Handle("GET", "/api/companies", func(w http.ResponseWriter, r *http.Request) error {
		list, err := mgr.List()
		if err != nil {
			return err
		}
		if !httpx.FromThisComputer(r) {
			// the full location names the folders (and user name) of this computer
			for i := range list {
				list[i].Path = ""
			}
		}
		return httpx.WriteJSON(w, http.StatusOK, list)
	})
	rt.Handle("GET", "/api/companies/templates", func(w http.ResponseWriter, r *http.Request) error {
		return httpx.WriteJSON(w, http.StatusOK, Templates())
	})
	rt.Handle("POST", "/api/companies", func(w http.ResponseWriter, r *http.Request) error {
		var req model.NewCompanyRequest
		if err := httpx.DecodeJSON(r, &req); err != nil {
			return err
		}
		cf, err := CreateCompany(r.Context(), mgr, req)
		if err != nil {
			return err
		}
		return httpx.WriteJSON(w, http.StatusOK, cf)
	})
	del := func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !mgr.Exists(id) {
			return apperr.NotFound("Company file %q not found.", id)
		}
		var creds Credentials
		if err := decodeCredentials(r, &creds); err != nil {
			return err
		}
		if err := RequireFileAccess(rt, mgr, r, id, true, &creds,
			"This company file has passwords. Only an administrator can delete it: enter the user name and password of an administrator of this file, or open the company, log in as an administrator and choose File > Utilities > Delete Company File."); err != nil {
			return err
		}
		fileMu.Lock()
		defer fileMu.Unlock()
		if err := mgr.Delete(id); err != nil {
			return err
		}
		if rt.FileReplaced != nil {
			rt.FileReplaced(id)
		}
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	rt.Handle("DELETE", "/api/companies/{id}", del)
	// POST form of DELETE for clients that cannot send a body with DELETE: {user, password}
	rt.Handle("POST", "/api/companies/{id}/delete", del)
	rt.Handle("GET", "/api/companies/{id}/backup", func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !mgr.Exists(id) {
			return apperr.NotFound("Company file %q not found.", id)
		}
		// a backup holds everything, including the password hashes of the users and
		// the audit trail, so only an administrator may take a copy away
		if err := RequireFileAccess(rt, mgr, r, id, true, nil,
			"Only an administrator of this company file can download a backup of it."); err != nil {
			return err
		}
		return backup(w, r, mgr)
	})
	rt.Handle("POST", "/api/companies/restore", func(w http.ResponseWriter, r *http.Request) error {
		return restore(w, r, mgr)
	})
	rt.Handle("POST", "/api/companies/{id}/copy", func(w http.ResponseWriter, r *http.Request) error {
		var body struct {
			Name string `json:"name"`
		}
		if err := httpx.DecodeJSON(r, &body); err != nil {
			return err
		}
		id := r.PathValue("id")
		if !mgr.Exists(id) {
			return apperr.NotFound("Company file %q not found.", id)
		}
		if err := RequireFileAccess(rt, mgr, r, id, true, nil,
			"Only an administrator of this company file can make a copy of it."); err != nil {
			return err
		}
		cf, err := CopyCompany(r.Context(), mgr, id, body.Name)
		if err != nil {
			return err
		}
		return httpx.WriteJSON(w, http.StatusOK, cf)
	})
}

// Credentials are a user name and password of a company file sent with a
// request that acts on the whole file (delete, replace the sample).
type Credentials struct {
	User     string `json:"user"`
	Password string `json:"password"`
}

// decodeCredentials reads optional {user, password} from the request body.
func decodeCredentials(r *http.Request, c *Credentials) error {
	if r.Body == nil || r.Body == http.NoBody || r.ContentLength == 0 {
		return nil
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		return httpx.BodyError(err)
	}
	if strings.TrimSpace(string(b)) == "" {
		return nil
	}
	if err := json.Unmarshal(b, c); err != nil {
		return httpx.BodyError(err)
	}
	return nil
}

// RequireFileAccess checks that the request may act on the whole company file
// id (backup, copy, delete, replace). When no user of the file has a
// password anybody may. Otherwise the request needs an X-Session token of
// that file (of an administrator when admin is true), or creds of such a user.
// adminMsg is the message when an administrator is required and missing.
func RequireFileAccess(rt *httpx.Router, mgr *store.Manager, r *http.Request, id string, admin bool, creds *Credentials, adminMsg string) error {
	if rt.Session == nil {
		return nil
	}
	db, err := mgr.Open(id)
	if err != nil {
		return apperr.Conflict("The company file could not be opened. It may be damaged.")
	}
	si, err := rt.Session(r, id, db)
	if err != nil {
		return err
	}
	if !si.Required || (si.User != "" && (si.Admin || !admin)) {
		return nil
	}
	if creds != nil && creds.User != "" && rt.Login != nil {
		li, err := rt.Login(r.Context(), id, db, creds.User, creds.Password)
		if err != nil {
			return err
		}
		if li.Admin || !admin {
			return nil
		}
		e := apperr.Forbidden("%s is not an administrator of this company file. Enter the user name and password of an administrator.", li.User)
		e.Field = "user"
		return e
	}
	if admin {
		msg := orMsg(adminMsg, "Only an administrator of this company file can do this.")
		if si.User != "" {
			msg = fmt.Sprintf("%s, the user logged in, is not an administrator of this company file. Enter the user name and password of an administrator.", si.User)
		}
		e := apperr.Forbidden("%s", msg)
		e.Field = "password"
		return e
	}
	return apperr.Auth("Please log in to this company file first.")
}

func orMsg(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// FileInfo describes one company file of the data directory.
func FileInfo(mgr *store.Manager, id string) (store.CompanyFile, error) {
	size, mod, err := mgr.Stat(id)
	if err != nil {
		return store.CompanyFile{}, apperr.NotFound("Company file %q not found.", id)
	}
	cf := store.CompanyFile{ID: id, FileName: id + store.Ext, Path: mgr.Path(id), Modified: mod.UTC().Format(time.RFC3339), Size: size}
	if db, err := mgr.Open(id); err == nil {
		db.QueryRow(`SELECT name FROM company WHERE id = 1`).Scan(&cf.Name)
	}
	if cf.Name == "" {
		cf.Name = id
	}
	return cf, nil
}

// ---------------------------------------------------------------------------
// Create

func cleanRequest(req *model.NewCompanyRequest) error {
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		return apperr.Validation("name", "Enter the name of your company.")
	}
	if len([]rune(req.Name)) > 100 {
		return apperr.Validation("name", "The company name is too long (100 characters maximum).")
	}
	req.Industry = strings.TrimSpace(req.Industry)
	if req.Industry == "" {
		req.Industry = "general_service"
	}
	if _, ok := findIndustry(req.Industry); !ok {
		return apperr.Validation("industry", "Unknown industry %q.", req.Industry)
	}
	if req.FiscalYearStartMonth == 0 {
		req.FiscalYearStartMonth = 1
	}
	if req.FiscalYearStartMonth < 1 || req.FiscalYearStartMonth > 12 {
		return apperr.Validation("fiscalYearStartMonth", "The first month of the fiscal year must be between 1 and 12.")
	}
	if strings.TrimSpace(req.LegalName) == "" {
		req.LegalName = req.Name
	}
	if strings.TrimSpace(req.Country) == "" {
		req.Country = "US"
	}
	return store.CheckNewPassword("adminPassword", req.AdminPassword)
}

// InitCompany fills a brand-new company file (run it as the init function of
// store.Manager.Create): company row with preferences, the "Admin" user, the
// default simple lists and the chart of accounts of the industry template.
// req must already be valid (see CreateCompany).
func InitCompany(ctx context.Context, tx *sql.Tx, req model.NewCompanyRequest) error {
	ind, ok := findIndustry(req.Industry)
	if !ok {
		ind, _ = findIndustry("none")
	}
	prefs := store.DefaultPrefs()
	prefs.SalesTaxEnabled = req.SalesTaxEnabled
	prefs.InventoryEnabled = req.InventoryEnabled
	// inventory and purchase orders are turned on and off together by one setup choice
	prefs.PurchaseOrdersEnabled = req.InventoryEnabled
	if serviceIndustries[ind.Key] && !req.InventoryEnabled {
		prefs.DefaultInvoiceTemplate = "Service Invoice"
	}
	pj, _ := json.Marshal(prefs)
	now := store.Now()
	fy := req.FiscalYearStartMonth
	if fy < 1 || fy > 12 {
		fy = 1
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO company(id, name, legal_name, address1, address2, city, state, zip, country,
		phone, email, website, tax_id, industry, entity_type, fiscal_year_start_month, tax_year_start_month, prefs, created_at, updated_at)
		VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		req.Name, req.LegalName, req.Address1, req.Address2, req.City, req.State, req.Zip, req.Country,
		req.Phone, req.Email, req.Website, req.TaxID, ind.Key, req.EntityType, fy, fy, string(pj), now, now); err != nil {
		return fmt.Errorf("company row: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO users(name, password_hash, is_admin, active, created_at) VALUES('Admin', ?, 1, 1, ?)`,
		store.HashPassword(req.AdminPassword), now); err != nil {
		return fmt.Errorf("admin user: %w", err)
	}
	if err := insertLists(ctx, tx); err != nil {
		return fmt.Errorf("default lists: %w", err)
	}
	if !req.CreateDefaultAccounts {
		ind, _ = findIndustry("none")
	}
	chart := chartOfAccounts(ind, req.EntityType, req.SalesTaxEnabled, req.InventoryEnabled)
	if err := insertChart(ctx, tx, chart, req.SalesTaxEnabled, req.InventoryEnabled); err != nil {
		return fmt.Errorf("chart of accounts: %w", err)
	}
	return nil
}

// CreateCompany validates req, chooses a file id from the company name and
// creates the company file.
func CreateCompany(ctx context.Context, mgr *store.Manager, req model.NewCompanyRequest) (store.CompanyFile, error) {
	if err := cleanRequest(&req); err != nil {
		return store.CompanyFile{}, err
	}
	fileMu.Lock()
	id := mgr.UniqueID(req.Name)
	err := mgr.Create(ctx, id, func(tx *sql.Tx) error { return InitCompany(ctx, tx, req) })
	fileMu.Unlock()
	if err != nil {
		return store.CompanyFile{}, err
	}
	return FileInfo(mgr, id)
}

// ---------------------------------------------------------------------------
// Backup / restore / copy

// vacuumInto writes a consistent copy of a company database to path.
func vacuumInto(ctx context.Context, db *sql.DB, path string) error {
	_, err := db.ExecContext(ctx, `VACUUM INTO ?`, path)
	return err
}

func contentDisposition(filename string) string {
	ascii := strings.Map(func(r rune) rune {
		switch {
		case r == '"' || r == '\\' || r == '/' || r < 0x20 || r == 0x7f:
			return '_'
		case r > 0x7e:
			return '_'
		}
		return r
	}, filename)
	v := `attachment; filename="` + ascii + `"`
	if ascii != filename {
		v += `; filename*=UTF-8''` + url.PathEscape(filename)
	}
	return v
}

func backup(w http.ResponseWriter, r *http.Request, mgr *store.Manager) error {
	id := r.PathValue("id")
	if !mgr.Exists(id) {
		return apperr.NotFound("Company file %q not found.", id)
	}
	db, err := mgr.Open(id)
	if err != nil {
		return apperr.Conflict("The company file could not be opened: %v", err)
	}
	dir, err := os.MkdirTemp("", "sxbackup-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	tmp := filepath.Join(dir, "backup"+store.Ext)
	seq, err := changeSeq(r.Context(), db)
	if err != nil {
		return err
	}
	if err := vacuumInto(r.Context(), db, tmp); err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	f, err := os.Open(tmp)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	name := store.CompanyName(r.Context(), db)
	if name == "" {
		name = id
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", contentDisposition(fmt.Sprintf("%s %s%s", name, store.Today(), store.Ext)))
	w.Header().Set("Content-Length", fmt.Sprint(st.Size()))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, err = io.Copy(w, f)
	if err != nil {
		// headers are sent; nothing more can be reported to the client
		return nil
	}
	recordDownload(context.WithoutCancel(r.Context()), mgr, id, db, seq, st.Size())
	return nil
}

func removeSQLiteFiles(path string) {
	os.Remove(path)
	os.Remove(path + "-wal")
	os.Remove(path + "-shm")
	os.Remove(path + "-journal")
}

// validateCompanyFile checks that path is a SerieX Books company file of the
// current version and returns its company name.
func validateCompanyFile(ctx context.Context, path string) (string, error) {
	notCompany := apperr.Validation("file", "This file is not a SerieX Books company file or backup.")
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	head := make([]byte, 16)
	n, _ := io.ReadFull(f, head)
	f.Close()
	if n < 16 || string(head) != "SQLite format 3\x00" {
		return "", notCompany
	}
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=query_only(1)&_pragma=trusted_schema(0)")
	if err != nil {
		return "", notCompany
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	// before anything writes to the file: refuse database code hidden in it
	what, err := store.ForeignSchemaObject(ctx, db)
	if err != nil {
		return "", notCompany
	}
	if what != "" {
		return "", apperr.Validation("file", "This file contains database code that SerieX Books never creates (a %s). It was changed by another program, so it cannot be restored.", what)
	}
	var v string
	if err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v); err != nil {
		return "", notCompany
	}
	if v != store.SchemaVersion {
		return "", apperr.Validation("file", "This company file was made by a different version of SerieX Books (file version %s, expected %s).", v, store.SchemaVersion)
	}
	var name string
	if err := db.QueryRowContext(ctx, `SELECT name FROM company WHERE id = 1`).Scan(&name); err != nil {
		return "", notCompany
	}
	var check string
	if err := db.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&check); err != nil || check != "ok" {
		if check == "" && err != nil {
			check = err.Error()
		}
		return "", apperr.Validation("file", "The company file is damaged and cannot be restored (%s).", check)
	}
	db.Close()
	missing, err := store.CheckSchema(ctx, path)
	if err != nil {
		return "", err
	}
	if missing != "" {
		return "", apperr.Validation("file", "This backup is damaged or incomplete (%s). It cannot be restored.", missing)
	}
	return name, nil
}

// tempPath returns a unique temporary file path inside the data directory
// (same file system, so it can be renamed into place; ignored by List).
func tempPath(mgr *store.Manager, prefix string) (string, error) {
	f, err := os.CreateTemp(mgr.Dir(), "."+prefix+"-*.tmp")
	if err != nil {
		return "", err
	}
	p := f.Name()
	f.Close()
	os.Remove(p)
	return p, nil
}

// install moves a validated temporary company file into the data directory
// under a new id derived from name.
func install(mgr *store.Manager, tmp, name string) (string, error) {
	fileMu.Lock()
	defer fileMu.Unlock()
	id := mgr.UniqueID(name)
	if err := os.Rename(tmp, mgr.Path(id)); err != nil {
		return "", err
	}
	return id, nil
}

func restore(w http.ResponseWriter, r *http.Request, mgr *store.Manager) error {
	if free := diskFree(mgr.Dir()); free >= 0 && r.ContentLength > 0 && r.ContentLength*2+(64<<20) > free {
		return apperr.Validation("file", "There is not enough free disk space to restore this backup (%s needed, %s free).",
			fmtBytes(r.ContentLength*2+(64<<20)), fmtBytes(free))
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxRestoreSize+1<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		return apperr.BadRequest("Upload the backup file as multipart form data in the \"file\" field.")
	}
	tmp, err := tempPath(mgr, "restore")
	if err != nil {
		return err
	}
	defer removeSQLiteFiles(tmp)
	gotFile := false
	formName := ""
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return apperr.BadRequest("The backup file is too large (%s maximum).", fmtBytes(maxRestoreSize))
			}
			return apperr.BadRequest("The upload could not be read. Try again.")
		}
		switch part.FormName() {
		case "file":
			// a company file starts with the SQLite header, a compressed one with the gzip
			// header: anything else is refused before it is written to disk
			br := bufio.NewReaderSize(part, 64<<10)
			head, _ := br.Peek(len(sqliteHeader))
			if !bytes.HasPrefix(head, gzipMagic) && !bytes.Equal(head, sqliteHeader) {
				return notCompanyFile()
			}
			out, err := os.Create(tmp)
			if err != nil {
				return err
			}
			n, err := io.Copy(out, io.LimitReader(br, maxRestoreSize+1))
			cerr := out.Close()
			if err != nil {
				var mbe *http.MaxBytesError
				if errors.As(err, &mbe) {
					return apperr.BadRequest("The backup file is too large (%s maximum).", fmtBytes(maxRestoreSize))
				}
				if isNoSpace(err) {
					return apperr.Validation("file", "There is not enough free disk space to restore this backup.")
				}
				return apperr.BadRequest("The uploaded file could not be read. Try again.")
			}
			if cerr != nil {
				if isNoSpace(cerr) {
					return apperr.Validation("file", "There is not enough free disk space to restore this backup.")
				}
				return cerr
			}
			if n > maxRestoreSize {
				return apperr.BadRequest("The backup file is too large (%s maximum).", fmtBytes(maxRestoreSize))
			}
			if err := gunzipInPlace(tmp, n); err != nil {
				return err
			}
			gotFile = true
		case "name":
			b, _ := io.ReadAll(io.LimitReader(part, 1024))
			formName = strings.TrimSpace(string(b))
		}
		part.Close()
	}
	if !gotFile {
		return apperr.Validation("file", "Choose the backup file to restore.")
	}
	companyName, err := validateCompanyFile(r.Context(), tmp)
	if err != nil {
		return err
	}
	if err := newIdentity(r.Context(), tmp); err != nil {
		return err
	}
	// an uploaded file may come from another computer: its backup folder and list of
	// backups describe that computer, so the restored file starts with the default folder
	if err := resetBackupState(r.Context(), tmp); err != nil {
		return err
	}
	os.Remove(tmp + "-wal")
	os.Remove(tmp + "-shm")
	name := formName
	if name == "" {
		name = companyName
	}
	id, err := install(mgr, tmp, name)
	if err != nil {
		return err
	}
	cf, err := FileInfo(mgr, id)
	if err != nil {
		return err
	}
	return httpx.WriteJSON(w, http.StatusOK, cf)
}

// CopyCompany makes a copy of a company file under a new name (the company
// name inside the copy is changed too).
func CopyCompany(ctx context.Context, mgr *store.Manager, id, name string) (store.CompanyFile, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return store.CompanyFile{}, apperr.Validation("name", "Enter a name for the copy.")
	}
	if len([]rune(name)) > 100 {
		return store.CompanyFile{}, apperr.Validation("name", "The company name is too long (100 characters maximum).")
	}
	if !mgr.Exists(id) {
		return store.CompanyFile{}, apperr.NotFound("Company file %q not found.", id)
	}
	src, err := mgr.Open(id)
	if err != nil {
		return store.CompanyFile{}, apperr.Conflict("The company file could not be opened: %v", err)
	}
	tmp, err := tempPath(mgr, "copy")
	if err != nil {
		return store.CompanyFile{}, err
	}
	defer removeSQLiteFiles(tmp)
	if err := vacuumInto(ctx, src, tmp); err != nil {
		return store.CompanyFile{}, fmt.Errorf("copy: %w", err)
	}
	db, err := sql.Open("sqlite", tmp+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return store.CompanyFile{}, err
	}
	_, err = db.ExecContext(ctx, `UPDATE company SET name = ?, updated_at = ? WHERE id = 1`, name, store.Now())
	if err == nil {
		err = store.SetFileUID(ctx, db)
	}
	if cerr := db.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return store.CompanyFile{}, err
	}
	os.Remove(tmp + "-wal")
	os.Remove(tmp + "-shm")
	newID, err := install(mgr, tmp, name)
	if err != nil {
		return store.CompanyFile{}, err
	}
	return FileInfo(mgr, newID)
}

// newIdentity gives the company file at path a new file identity (restored
// files never share logins with the file they were made from).
func newIdentity(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	err = store.SetFileUID(ctx, db)
	if cerr := db.Close(); err == nil {
		err = cerr
	}
	return err
}

var (
	sqliteHeader = []byte("SQLite format 3\x00")
	gzipMagic    = []byte{0x1f, 0x8b}
)

func notCompanyFile() error {
	return apperr.Validation("file", "This file is not a SerieX Books company file or backup.")
}

// maxUnzipRatio: a compressed company file never grows more than this when
// it is uncompressed (company files compress about 3 to 10 times).
const maxUnzipRatio = 50

// gunzipInPlace replaces a gzip-compressed upload (of size bytes) by its
// content. The content must start like a company file, and it may not grow
// beyond maxUnzipRatio times the upload (at least 256 MB) or the free disk
// space, so a small crafted upload cannot fill the disk.
func gunzipInPlace(path string, size int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 2)
	n, _ := io.ReadFull(f, head)
	if n < 2 || !bytes.Equal(head, gzipMagic) {
		return nil
	}
	f.Seek(0, io.SeekStart)
	zr, err := gzip.NewReader(f)
	if err != nil {
		return notCompanyFile()
	}
	start := make([]byte, len(sqliteHeader))
	if _, err := io.ReadFull(zr, start); err != nil || !bytes.Equal(start, sqliteHeader) {
		return notCompanyFile()
	}
	limit := min(max(size*maxUnzipRatio, 256<<20), int64(maxRestoreSize))
	diskLimited := false
	if free := diskFree(filepath.Dir(path)); free >= 0 && free-(64<<20) < limit {
		limit, diskLimited = max(free-(64<<20), 0), true
	}
	out, err := os.Create(path + ".unz")
	if err != nil {
		return err
	}
	_, err = out.Write(start)
	var written int64
	if err == nil {
		written, err = io.Copy(out, io.LimitReader(zr, limit-int64(len(start))+1))
		written += int64(len(start))
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil && written > limit {
		os.Remove(path + ".unz")
		if diskLimited {
			return apperr.Validation("file", "There is not enough free disk space to restore this backup.")
		}
		return apperr.Validation("file", "The compressed backup file is damaged or is not a SerieX Books company file.")
	}
	if err != nil {
		os.Remove(path + ".unz")
		if isNoSpace(err) {
			return apperr.Validation("file", "There is not enough free disk space to restore this backup.")
		}
		return apperr.Validation("file", "The compressed backup file is damaged.")
	}
	f.Close()
	return os.Rename(path+".unz", path)
}

// resetBackupState gives a restored company file the default backup folder
// (keeping the other backup settings) and forgets the backups recorded in it.
func resetBackupState(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=trusted_schema(0)")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	err = func() error {
		s, err := loadBackupSettings(ctx, db)
		if err != nil {
			return err
		}
		s.Folder = ""
		if err := saveBackupSettings(ctx, db, s); err != nil {
			return err
		}
		_, err = db.ExecContext(ctx, `DELETE FROM backup_log`)
		return err
	}()
	if cerr := db.Close(); err == nil {
		err = cerr
	}
	return err
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(n)/(1<<20))
	}
	return fmt.Sprintf("%d KB", (n+1023)/1024)
}
