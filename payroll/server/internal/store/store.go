// Package store manages payroll company files (one SQLite database per SerieX
// Books company, same file id) and holds small helpers shared by every module.
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

// SchemaVersion is stored in meta.schema_version.
const SchemaVersion = "1"

// Ext is the payroll company file extension.
const Ext = ".sxp"

// Q is satisfied by *sql.DB, *sql.Tx and *sql.Conn. Helpers that only read or
// write take a Q so they work both inside and outside a transaction.
// RULE: inside a write transaction always pass the *sql.Tx, never the *sql.DB.
type Q interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Manager opens and caches company databases stored in one data directory.
type Manager struct {
	dir   string
	mu    sync.Mutex
	dbs   map[string]*sql.DB
	locks map[string]*sync.Mutex
}

// Company files hold social security and bank account numbers: the data
// folder is created readable only by the user running SerieX Payroll (0700)
// and every company file (with its -wal and -shm files) is 0600.
const (
	dirPerm  fs.FileMode = 0o700
	filePerm fs.FileMode = 0o600
)

func NewManager(dir string) (*Manager, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, dirPerm); err != nil {
		return nil, err
	}
	// a folder made earlier (or by the desktop app) may be readable by others
	if st, err := os.Stat(abs); err == nil {
		tighten(abs, st.Mode())
	}
	return &Manager{dir: abs, dbs: map[string]*sql.DB{}, locks: map[string]*sync.Mutex{}}, nil
}

// tighten removes the group and other permission bits of a file or folder
// (no-op on Windows, which has no such bits).
func tighten(path string, mode fs.FileMode) {
	if runtime.GOOS == "windows" || mode.Perm()&0o077 == 0 {
		return
	}
	os.Chmod(path, mode.Perm()&^0o077)
}

// tightenFile makes a company file and its -wal and -shm files private (0600).
func tightenFile(path string) {
	for _, p := range []string{path, path + "-wal", path + "-shm"} {
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			tighten(p, st.Mode())
		}
	}
}

func (m *Manager) Dir() string { return m.dir }

func (m *Manager) Path(id string) string { return filepath.Join(m.dir, id+Ext) }

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ValidID reports whether id is a legal company file id.
func ValidID(id string) bool { return idRe.MatchString(id) }

// Slug turns a company name into a file id candidate.
func Slug(name string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			dash = false
		default:
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
		}
	}
	s := strings.Trim(b.String(), "-")
	if len(s) > 48 {
		s = strings.Trim(s[:48], "-")
	}
	if s == "" {
		s = "company"
	}
	return s
}

// UniqueID returns a file id derived from name that is not in use yet.
func (m *Manager) UniqueID(name string) string {
	base := Slug(name)
	id := base
	for i := 2; m.Exists(id); i++ {
		id = fmt.Sprintf("%s-%d", base, i)
	}
	return id
}

func (m *Manager) Exists(id string) bool {
	if !ValidID(id) {
		return false
	}
	_, err := os.Stat(m.Path(id))
	return err == nil
}

func dsn(path string) string {
	return path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_txlock=immediate"
}

func openDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	db.SetConnMaxIdleTime(5 * time.Minute)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// Open returns the (cached) database of a company file.
func (m *Manager) Open(id string) (*sql.DB, error) {
	if !ValidID(id) {
		return nil, fmt.Errorf("invalid company id %q: %w", id, fs.ErrNotExist)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if db, ok := m.dbs[id]; ok {
		return db, nil
	}
	path := m.Path(id)
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("company file %q not found: %w", id, fs.ErrNotExist)
	}
	tightenFile(path) // made by an older version with 0644
	db, err := openDB(path)
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	m.dbs[id] = db
	return db, nil
}

// Close closes a cached company database (no-op when not open).
func (m *Manager) Close(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if db, ok := m.dbs[id]; ok {
		db.Close()
		delete(m.dbs, id)
	}
}

// CloseAll closes every cached database.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, db := range m.dbs {
		db.Close()
		delete(m.dbs, id)
	}
}

// WriteLock returns the mutex that serializes write transactions of a company.
func (m *Manager) WriteLock(id string) *sync.Mutex {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.locks[id]
	if !ok {
		l = &sync.Mutex{}
		m.locks[id] = l
	}
	return l
}

// Create makes a new company file, applies the schema and runs init inside
// the same transaction. The file is removed again when anything fails.
func (m *Manager) Create(ctx context.Context, id string, init func(tx *sql.Tx) error) error {
	if !ValidID(id) {
		return fmt.Errorf("invalid company id %q", id)
	}
	path := m.Path(id)
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("company file %q already exists", id)
	}
	// Create the empty file first with private permissions: SQLite gives the
	// -wal and -shm files the permissions of the database file.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL, filePerm)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return fmt.Errorf("company file %q already exists", id)
		}
		return err
	}
	f.Close()
	db, err := openDB(path)
	if err != nil {
		os.Remove(path)
		return err
	}
	fail := func(err error) error {
		db.Close()
		os.Remove(path)
		os.Remove(path + "-wal")
		os.Remove(path + "-shm")
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fail(err)
	}
	if _, err := tx.ExecContext(ctx, schemaSQL); err != nil {
		tx.Rollback()
		return fail(fmt.Errorf("apply schema: %w", err))
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('schema_version', ?)`, SchemaVersion); err != nil {
		tx.Rollback()
		return fail(err)
	}
	if init != nil {
		if err := init(tx); err != nil {
			tx.Rollback()
			return fail(err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fail(err)
	}
	m.mu.Lock()
	m.dbs[id] = db
	m.mu.Unlock()
	return nil
}

// CompanyFile describes one company file in the data directory.
type CompanyFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	FileName string `json:"fileName"`
	Path     string `json:"path"`
	Modified string `json:"modified"`
	Size     int64  `json:"size"`
}

// List returns all company files, most recently modified first.
func (m *Manager) List() ([]CompanyFile, error) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return nil, err
	}
	out := []CompanyFile{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), Ext) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), Ext)
		if !ValidID(id) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		cf := CompanyFile{ID: id, FileName: e.Name(), Path: m.Path(id), Modified: info.ModTime().UTC().Format(time.RFC3339), Size: info.Size()}
		if db, err := m.Open(id); err == nil {
			db.QueryRow(`SELECT name FROM company WHERE id = 1`).Scan(&cf.Name)
		}
		if cf.Name == "" {
			cf.Name = id
		}
		out = append(out, cf)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified > out[j].Modified })
	return out, nil
}

// Delete closes and removes a company file.
func (m *Manager) Delete(id string) error {
	if !ValidID(id) {
		return fmt.Errorf("invalid company id %q", id)
	}
	m.Close(id)
	path := m.Path(id)
	os.Remove(path + "-wal")
	os.Remove(path + "-shm")
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func migrate(db *sql.DB) error {
	var v string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v); err != nil {
		return fmt.Errorf("not a payroll company file: %w", err)
	}
	if v != SchemaVersion {
		return fmt.Errorf("unsupported payroll company file version %s", v)
	}
	return addColumns(db)
}

// appendedColumns are columns appended to schema.sql tables after files were
// created: files that lack one get it (same definition and default).
var appendedColumns = []struct{ table, column, def string }{
	{"employees", "w4_exempt_year", "INTEGER NOT NULL DEFAULT 0"},
	{"employees", "books_sync_error", "TEXT NOT NULL DEFAULT ''"},
}

func addColumns(db *sql.DB) error {
	for _, c := range appendedColumns {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, c.table, c.column).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if _, err := db.Exec(`ALTER TABLE ` + c.table + ` ADD COLUMN ` + c.column + ` ` + c.def); err != nil &&
			!strings.Contains(err.Error(), "duplicate column") {
			return fmt.Errorf("add column %s.%s: %w", c.table, c.column, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Small shared helpers

// Now is the current UTC timestamp (RFC3339).
func Now() string { return time.Now().UTC().Format(time.RFC3339) }

// Today is the local date YYYY-MM-DD.
func Today() string { return time.Now().Format("2006-01-02") }

// Cents converts dollars (as sent in JSON) to integer cents, rounding half away from zero.
func Cents(f float64) int64 {
	v := f * 100
	if v >= 0 {
		v += 1e-7
	} else {
		v -= 1e-7
	}
	return int64(math.Round(v))
}

// Dollars converts integer cents to dollars for JSON.
func Dollars(c int64) float64 { return float64(c) / 100 }

// Round2 rounds a dollar amount to cents.
func Round2(f float64) float64 { return Dollars(Cents(f)) }

// NullID converts an optional id to a SQL argument (nil or the value). Zero is treated as nil.
func NullID(p *int64) any {
	if p == nil || *p == 0 {
		return nil
	}
	return *p
}

// PtrID converts a scanned nullable id to *int64.
func PtrID(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	v := n.Int64
	return &v
}

// B converts a bool to 0/1 for SQLite.
func B(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ParseDate validates YYYY-MM-DD.
func ParseDate(s string) (time.Time, error) { return time.Parse("2006-01-02", s) }

// ValidDate reports whether s is YYYY-MM-DD.
func ValidDate(s string) bool {
	_, err := ParseDate(s)
	return err == nil
}

// AddDays adds n days to a YYYY-MM-DD date.
func AddDays(date string, n int) string {
	t, err := ParseDate(date)
	if err != nil {
		return date
	}
	return t.AddDate(0, 0, n).Format("2006-01-02")
}
