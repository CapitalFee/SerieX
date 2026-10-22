// Package store manages company files (one SQLite database per company) and
// holds small helpers shared by every module.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"seriex/internal/apperr"
)

//go:embed schema.sql
var schemaSQL string

// SchemaVersion is stored in meta.schema_version.
const SchemaVersion = "1"

// Ext is the company file extension.
const Ext = ".sxb"

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
	dir       string
	mu        sync.Mutex
	dbs       map[string]*sql.DB
	locks     map[string]*sync.Mutex
	replacing map[string]bool // files being swapped by Replace (Open refuses them)
}

func NewManager(dir string) (*Manager, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o700); err != nil { // company files are private to this user
		return nil, err
	}
	return &Manager{dir: abs, dbs: map[string]*sql.DB{}, locks: map[string]*sync.Mutex{}, replacing: map[string]bool{}}, nil
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

// dsn opens a company file. trusted_schema(0): functions and virtual tables
// named inside the file's own schema are not trusted (a company file can come
// from somebody else).
func dsn(path string) string {
	return path + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(15000)&_pragma=synchronous(NORMAL)&_pragma=trusted_schema(0)&_txlock=immediate"
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
		return nil, fmt.Errorf("invalid company id %q", id)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if db, ok := m.dbs[id]; ok {
		return db, nil
	}
	if m.replacing[id] {
		return nil, fmt.Errorf("company file %q is being restored from a backup; try again in a moment", id)
	}
	path := m.Path(id)
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("company file %q not found", id)
	}
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

// Replace closes company file id and puts the closed company file src in its
// place (restore of a backup over the current data). The file cannot be
// opened while it is swapped, so nobody keeps writing to the old one.
func (m *Manager) Replace(id, src string) error {
	if !ValidID(id) {
		return fmt.Errorf("invalid company id %q", id)
	}
	m.mu.Lock()
	db := m.dbs[id]
	delete(m.dbs, id)
	m.replacing[id] = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.replacing, id)
		m.mu.Unlock()
	}()
	if db != nil {
		db.Close() // waits for the queries that have started
	}
	path := m.Path(id)
	os.Remove(path + "-wal")
	os.Remove(path + "-shm")
	return os.Rename(src, path)
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
	db, err := openDB(path)
	if err != nil {
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
	if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('schema_version', ?), ('file_uid', ?)`, SchemaVersion, NewFileUID()); err != nil {
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
	// move the new data into the main file so its size and date are right
	db.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`)
	m.mu.Lock()
	m.dbs[id] = db
	m.mu.Unlock()
	return nil
}

// Stat returns the size of a company file including its write-ahead log
// (recent changes not yet copied into the main file) and the time of the
// latest change of either.
func (m *Manager) Stat(id string) (int64, time.Time, error) {
	st, err := os.Stat(m.Path(id))
	if err != nil {
		return 0, time.Time{}, err
	}
	size, mod := st.Size(), st.ModTime()
	if w, err := os.Stat(m.Path(id) + "-wal"); err == nil {
		size += w.Size()
		if w.Size() > 0 && w.ModTime().After(mod) {
			mod = w.ModTime()
		}
	}
	return size, mod, nil
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
		size, mod, err := m.Stat(id)
		if err != nil {
			continue
		}
		cf := CompanyFile{ID: id, FileName: e.Name(), Path: m.Path(id), Modified: mod.UTC().Format(time.RFC3339), Size: size}
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

// NewFileUID returns a new random company file identity (meta.file_uid).
func NewFileUID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// FileUID returns the identity of a company file. A file deleted and created
// again under the same id, a restored backup or a copy get a new identity, so
// logins to the old file do not carry over.
func FileUID(ctx context.Context, q Q) string {
	v, _ := FileUIDErr(ctx, q)
	return v
}

// FileUIDErr is FileUID with the read error (a file without an identity gives "", nil).
// Callers that act on a mismatch must check the error first: a canceled
// request gives an error, not a different identity.
func FileUIDErr(ctx context.Context, q Q) (string, error) {
	var v string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'file_uid'`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return v, err
}

// SetFileUID gives a company file a new identity (restore, copy).
func SetFileUID(ctx context.Context, q Q) error {
	_, err := q.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('file_uid', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, NewFileUID())
	return err
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

// Migrate brings an opened company file up to date (indexes and columns
// added after it was created). Open runs it; restore runs it on the uploaded copy.
func Migrate(db *sql.DB) error { return migrate(db) }

var (
	refMu      sync.Mutex
	refTables  map[string]map[string]bool
	refIndexes map[string]bool
)

// schemaTables returns the tables and columns of a company file (sqlite_master).
func schemaTables(ctx context.Context, db *sql.DB) (map[string]map[string]bool, error) {
	names, err := schemaNames(ctx, db, "table")
	if err != nil {
		return nil, err
	}
	out := map[string]map[string]bool{}
	for _, n := range names {
		cols := map[string]bool{}
		crs, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, n)
		if err != nil {
			return nil, err
		}
		for crs.Next() {
			var c string
			if err := crs.Scan(&c); err != nil {
				crs.Close()
				return nil, err
			}
			cols[c] = true
		}
		crs.Close()
		out[n] = cols
	}
	return out, nil
}

// schemaNames lists the objects of one type ("table", "index") of a company
// file, leaving out SQLite's own (sqlite_*).
func schemaNames(ctx context.Context, db *sql.DB, typ string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite\_%' ESCAPE '\'`, typ)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

// referenceSchema: the tables, columns and indexes a current company file has.
func referenceSchema(ctx context.Context) (map[string]map[string]bool, map[string]bool, error) {
	refMu.Lock()
	defer refMu.Unlock()
	if refTables != nil {
		return refTables, refIndexes, nil
	}
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		return nil, nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, schemaSQL); err != nil {
		return nil, nil, err
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('schema_version', ?)`, SchemaVersion); err != nil {
		return nil, nil, err
	}
	if err := migrate(db); err != nil {
		return nil, nil, err
	}
	t, err := schemaTables(ctx, db)
	if err != nil {
		return nil, nil, err
	}
	ix, err := schemaNames(ctx, db, "index")
	if err != nil {
		return nil, nil, err
	}
	refIndexes = map[string]bool{}
	for _, n := range ix {
		refIndexes[n] = true
	}
	refTables = t
	return t, refIndexes, nil
}

// ForeignSchemaObject reports the first part of a company file's database that
// SerieX Books never creates and that could run code: a trigger (it would
// change data on every later save), a view or a virtual table. "" when there
// is none. A file that has one was made or changed by another program, so it
// must not be opened.
func ForeignSchemaObject(ctx context.Context, db *sql.DB) (string, error) {
	var typ, name string
	err := db.QueryRowContext(ctx, `SELECT type, name FROM sqlite_master
		WHERE type IN ('trigger', 'view') OR (type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%')
		ORDER BY type, name LIMIT 1`).Scan(&typ, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if typ == "table" {
		typ = "virtual table"
	}
	return fmt.Sprintf("%s %q", typ, name), nil
}

// CheckSchema brings the company file at path up to date and reports the
// first table or column it lacks ("" when it is complete). Indexes that
// SerieX Books does not create are removed. Call it only after
// ForeignSchemaObject found nothing: bringing the file up to date writes to it.
func CheckSchema(ctx context.Context, path string) (string, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=foreign_keys(0)&_pragma=trusted_schema(0)")
	if err != nil {
		return "", err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if what, err := ForeignSchemaObject(ctx, db); err != nil || what != "" {
		if err != nil {
			return "", err
		}
		return "it contains a " + what, nil
	}
	if err := migrate(db); err != nil {
		return "company tables are missing", nil
	}
	ref, refIx, err := referenceSchema(ctx)
	if err != nil {
		return "", err
	}
	have, err := schemaTables(ctx, db)
	if err != nil {
		return "", err
	}
	var tables []string
	for t := range ref {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	for _, t := range tables {
		cols, ok := have[t]
		if !ok {
			return "table " + t + " is missing", nil
		}
		var names []string
		for c := range ref[t] {
			names = append(names, c)
		}
		sort.Strings(names)
		for _, c := range names {
			if !cols[c] {
				return "column " + t + "." + c + " is missing", nil
			}
		}
	}
	ix, err := schemaNames(ctx, db, "index")
	if err != nil {
		return "", err
	}
	for _, n := range ix {
		if !refIx[n] {
			if _, err := db.ExecContext(ctx, `DROP INDEX "`+strings.ReplaceAll(n, `"`, `""`)+`"`); err != nil {
				return "", err
			}
		}
	}
	return "", nil
}

func migrate(db *sql.DB) error {
	var v string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&v); err != nil {
		return fmt.Errorf("not a company file: %w", err)
	}
	if v != SchemaVersion {
		return fmt.Errorf("unsupported company file version %s", v)
	}
	// Indexes added after the first files were created (idempotent).
	for _, stmt := range []string{
		`CREATE INDEX IF NOT EXISTS ix_gl_line ON gl_entries(line_id)`,
		`CREATE INDEX IF NOT EXISTS ix_inventory_moves_line ON inventory_moves(line_id)`,
		`CREATE INDEX IF NOT EXISTS ix_txn_lines_billed ON txn_lines(billed_txn_id)`,
		`CREATE INDEX IF NOT EXISTS ix_bank_feed_items_txn ON bank_feed_items(txn_id)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	// columns added after the first files were created
	for _, c := range addedColumns {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, c[0], c[1]).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			if _, err := db.Exec(`ALTER TABLE ` + c[0] + ` ADD COLUMN ` + c[1] + ` ` + c[2]); err != nil {
				return err
			}
		}
	}
	for _, stmt := range addedTables {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	// Data fixes for the added columns (idempotent).
	for _, stmt := range []string{
		// list entries saved before updated_at existed: stamp them so stale
		// copies can be detected from now on
		`UPDATE list_entries SET updated_at = created_at WHERE updated_at = ''`,
		// bill payments keep an unapplied amount as a vendor credit (open
		// balance) since their bill can be deleted or voided
		`UPDATE txns SET open_balance = (CASE WHEN voided = 1 OR is_pending = 1 THEN 0 ELSE amount
			- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.from_txn_id = txns.id), 0)
			- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.to_txn_id = txns.id), 0) END)
		WHERE type = 'BILLPMT' AND open_balance <> (CASE WHEN voided = 1 OR is_pending = 1 THEN 0 ELSE amount
			- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.from_txn_id = txns.id), 0)
			- IFNULL((SELECT SUM(l.amount) FROM txn_links l WHERE l.to_txn_id = txns.id), 0) END)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			return err
		}
	}
	if _, err := db.Exec(`INSERT OR IGNORE INTO meta(key, value) VALUES('file_uid', ?)`, NewFileUID()); err != nil {
		return err
	}
	return nil
}

// addedColumns: {table, column, definition} added to schema.sql after files
// were created; migrate adds them to older files.
var addedColumns = [][3]string{
	{"txns", "tax_split", "TEXT NOT NULL DEFAULT ''"},
	{"list_entries", "updated_at", "TEXT NOT NULL DEFAULT ''"},
}

// addedTables: CREATE ... IF NOT EXISTS statements of tables added later.
var addedTables = []string{
	`CREATE TABLE IF NOT EXISTS reconcile_items (
		id           INTEGER PRIMARY KEY,
		reconcile_id INTEGER NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
		gl_id        INTEGER NOT NULL,
		txn_id       INTEGER NOT NULL,
		txn_type     TEXT NOT NULL DEFAULT '',
		type_label   TEXT NOT NULL DEFAULT '',
		date         TEXT NOT NULL DEFAULT '',
		ref_number   TEXT NOT NULL DEFAULT '',
		name         TEXT NOT NULL DEFAULT '',
		memo         TEXT NOT NULL DEFAULT '',
		amount       INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE INDEX IF NOT EXISTS ix_reconcile_items ON reconcile_items(reconcile_id)`,
	`CREATE TABLE IF NOT EXISTS bank_feed_settings (
		account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
		flip_signs INTEGER NOT NULL DEFAULT 0,
		date_order TEXT NOT NULL DEFAULT ''
	)`,
	// backups made of the company file (see schema.sql)
	`CREATE TABLE IF NOT EXISTS backup_log (
		id         INTEGER PRIMARY KEY,
		created_at TEXT NOT NULL,
		kind       TEXT NOT NULL DEFAULT '',
		path       TEXT NOT NULL DEFAULT '',
		size       INTEGER NOT NULL DEFAULT 0,
		change_seq INTEGER NOT NULL DEFAULT 0,
		file_uid   TEXT NOT NULL DEFAULT ''
	)`,
}

// ---------------------------------------------------------------------------
// Small shared helpers

// Now is the current UTC timestamp (RFC3339).
func Now() string { return time.Now().UTC().Format(time.RFC3339) }

// Stamp is the current UTC time with microseconds, fixed width (used for
// updated_at values compared to detect saves based on an older copy).
func Stamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000000Z") }

// CheckStale refuses a save of record id of table when the client's copy
// (updatedAt, "" = not sent) is older than the stored one.
func CheckStale(ctx context.Context, q Q, table string, id int64, updatedAt, what string) error {
	if updatedAt == "" || id == 0 {
		return nil
	}
	var cur string
	if err := q.QueryRowContext(ctx, `SELECT updated_at FROM `+table+` WHERE id = ?`, id).Scan(&cur); err != nil {
		return nil // missing records are reported by the caller
	}
	if cur != updatedAt {
		return apperr.Conflict("Someone else changed this %s after you opened it. Close it and open it again to see their changes.", what)
	}
	return nil
}

// Today is the local date YYYY-MM-DD.
func Today() string { return time.Now().Format("2006-01-02") }

// MaxMoney is the largest amount (in dollars) the books accept (a fixed
// maximum); MaxQty the largest quantity.
const (
	MaxMoney = 9_999_999_999.99
	MaxQty   = 999_999_999
)

// MoneyErr returns a validation error when v is not a storable amount.
// label names the value in the message ("The amount", "Line 2: the rate").
func MoneyErr(field, label string, v float64) error {
	if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > MaxMoney+0.004 {
		return apperr.Validation(field, "%s is too large. The largest amount allowed is 9,999,999,999.99.", label)
	}
	return nil
}

// QtyErr returns a validation error when q is not a storable quantity.
func QtyErr(field, label string, q float64) error {
	if math.IsNaN(q) || math.IsInf(q, 0) || math.Abs(q) > MaxQty {
		return apperr.Validation(field, "%s is too large. The largest quantity allowed is 999,999,999.", label)
	}
	return nil
}

// CentsOK is Cents that refuses values it cannot hold exactly (beyond MaxMoney).
func CentsOK(f float64) (int64, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > MaxMoney+0.004 {
		return 0, false
	}
	return Cents(f), true
}

// Cents converts dollars (as sent in JSON) to integer cents, rounding half away from zero.
// Callers validate input amounts with MoneyErr first; values far beyond the
// limit (that int64 cannot hold) give 0 instead of a wrong number.
func Cents(f float64) int64 {
	if math.IsNaN(f) || math.Abs(f) > 9e16 {
		return 0
	}
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
