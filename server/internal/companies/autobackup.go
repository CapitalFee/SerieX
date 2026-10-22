package companies

// Automatic backups: every company file is copied (VACUUM INTO, like the
// manual backup) into its backup folder, by default <data>/backups/<id>/,
// when its last backup is older than the backup interval (a day) and the file
// changed since, when the company is closed, and on Back up now. The last
// Keep backups are kept. Each backup is recorded in the company file
// (backup_log); the settings are stored in meta.backup_settings.
//
// Changes are counted in meta.change_seq by every write transaction (see
// httpx.Router.Changed), so a file that did not change is not copied again.
// Recording a backup does not count as a change.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/store"
)

// Backup kinds (backup_log.kind).
const (
	KindAuto     = "auto"     // on the schedule
	KindClose    = "close"    // the company was closed (or the server stopped)
	KindManual   = "manual"   // Back up now
	KindRestore  = "restore"  // the current data, just before a backup replaced it
	KindDownload = "download" // a backup file the user downloaded (not in the backup folder)
)

const (
	// DefaultBackupKeep is how many backups are kept when not set.
	DefaultBackupKeep = 14
	maxBackupKeep     = 365
)

// BackupSettings are the automatic backup settings of a company file.
type BackupSettings struct {
	Enabled bool   `json:"enabled"`
	Folder  string `json:"folder"` // "" = the default folder
	Keep    int    `json:"keep"`
}

// BackupEntry is one backup made of a company file.
type BackupEntry struct {
	ID     int64  `json:"id"`
	Time   string `json:"time"` // RFC3339 (UTC)
	Kind   string `json:"kind"`
	File   string `json:"file"` // file name ("" for downloads)
	Path   string `json:"path"` // full location ("" for downloads)
	Size   int64  `json:"size"`
	Exists bool   `json:"exists"` // the file is still there
	seq    int64
}

// Backups runs the automatic backups of the company files of a data folder.
type Backups struct {
	mgr      *store.Manager
	rt       *httpx.Router
	root     string
	interval time.Duration

	mu     sync.Mutex
	locks  map[string]*sync.Mutex // one backup at a time per company file
	failed map[string]backupFailure

	stop     chan struct{}
	loopDone chan struct{}
	wg       sync.WaitGroup // backups started by a close
}

type backupFailure struct {
	at  time.Time
	msg string
}

// NewBackups prepares the automatic backups. root is the folder holding the
// default backup folders ("" = <data folder>/backups); interval is how old the
// last backup must be before the next automatic one (0 = a day).
func NewBackups(mgr *store.Manager, rt *httpx.Router, root string, interval time.Duration) (*Backups, error) {
	if root == "" {
		root = filepath.Join(mgr.Dir(), "backups")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if interval <= 0 {
		interval = 24 * time.Hour
	}
	return &Backups{mgr: mgr, rt: rt, root: abs, interval: interval,
		locks: map[string]*sync.Mutex{}, failed: map[string]backupFailure{}}, nil
}

// Root is the folder holding the default backup folders.
func (b *Backups) Root() string { return b.root }

// tick is how often the company files are checked.
func (b *Backups) tick() time.Duration {
	return min(max(b.interval/12, time.Second), time.Minute)
}

// retryDelay is how long an automatic backup that failed waits before the next try.
func (b *Backups) retryDelay() time.Duration {
	return min(max(b.interval/4, b.tick()), 15*time.Minute)
}

// Start checks the company files on a timer until Shutdown.
func (b *Backups) Start() {
	b.stop = make(chan struct{})
	b.loopDone = make(chan struct{})
	go func() {
		defer close(b.loopDone)
		t := time.NewTicker(b.tick())
		defer t.Stop()
		for {
			select {
			case <-b.stop:
				return
			case <-t.C:
				b.scan()
			}
		}
	}()
}

// Shutdown stops the timer and backs up the files that changed since their
// last backup (the companies are closed), giving up after budget.
func (b *Backups) Shutdown(budget time.Duration) {
	deadline := time.Now().Add(budget)
	if b.stop != nil {
		close(b.stop)
		select {
		case <-b.loopDone:
		case <-time.After(budget):
		}
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	for _, id := range b.companyIDs() {
		if ctx.Err() != nil {
			break
		}
		l := b.lock(id)
		if !l.TryLock() {
			continue
		}
		e, err := b.backUp(ctx, id, KindClose)
		l.Unlock()
		b.report(id, KindClose, e, err)
	}
	done := make(chan struct{})
	go func() { b.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (b *Backups) lock(id string) *sync.Mutex {
	b.mu.Lock()
	defer b.mu.Unlock()
	l, ok := b.locks[id]
	if !ok {
		l = &sync.Mutex{}
		b.locks[id] = l
	}
	return l
}

// companyIDs lists the company files of the data folder.
func (b *Backups) companyIDs() []string {
	entries, err := os.ReadDir(b.mgr.Dir())
	if err != nil {
		return nil
	}
	var ids []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), store.Ext) {
			continue
		}
		if id := strings.TrimSuffix(e.Name(), store.Ext); store.ValidID(id) {
			ids = append(ids, id)
		}
	}
	return ids
}

// scan makes the automatic backups that are due, one file at a time.
func (b *Backups) scan() {
	for _, id := range b.companyIDs() {
		select {
		case <-b.stop:
			return
		default:
		}
		b.mu.Lock()
		f, failed := b.failed[id]
		b.mu.Unlock()
		if failed && time.Since(f.at) < b.retryDelay() {
			continue
		}
		l := b.lock(id)
		if !l.TryLock() {
			continue // a backup of this file is running
		}
		e, err := b.backUp(context.Background(), id, KindAuto)
		l.Unlock()
		b.report(id, KindAuto, e, err)
	}
}

// report logs a backup and remembers the last failure of a file (logged once).
func (b *Backups) report(id, kind string, e *BackupEntry, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err != nil {
		msg := err.Error()
		if f, ok := b.failed[id]; !ok || f.msg != msg {
			log.Printf("backup of %s (%s) failed: %s", id, kind, msg)
		}
		b.failed[id] = backupFailure{at: time.Now(), msg: msg}
		return
	}
	if e != nil {
		delete(b.failed, id)
		log.Printf("backup of %s (%s): %s (%s)", id, kind, e.Path, fmtBytes(e.Size))
	}
}

// lastFailure is the error of the last backup of a file when it failed ("" otherwise).
func (b *Backups) lastFailure(id string) (string, time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	f, ok := b.failed[id]
	if !ok {
		return "", time.Time{}
	}
	return f.msg, f.at
}

// Close backs up company file id in the background when it changed since its
// last backup (the company was closed).
func (b *Backups) Close(id string) {
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		l := b.lock(id)
		l.Lock()
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		e, err := b.backUp(ctx, id, KindClose)
		cancel()
		l.Unlock()
		b.report(id, KindClose, e, err)
	}()
}

// ---------------------------------------------------------------------------
// Company file records

// countChange is installed as httpx.Router.Changed: it counts the write
// transactions that changed a company file.
func countChange(ctx context.Context, tx *sql.Tx, _ string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('change_seq', '1')
		ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`)
	return err
}

// changeSeq is the number of changes counted so far.
func changeSeq(ctx context.Context, q store.Q) (int64, error) {
	var n int64
	err := q.QueryRowContext(ctx, `SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'change_seq'`).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return n, err
}

func defaultBackupSettings() BackupSettings {
	return BackupSettings{Enabled: true, Keep: DefaultBackupKeep}
}

func loadBackupSettings(ctx context.Context, q store.Q) (BackupSettings, error) {
	s := defaultBackupSettings()
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'backup_settings'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if json.Unmarshal([]byte(raw), &s) != nil {
		return defaultBackupSettings(), nil
	}
	if s.Keep < 1 {
		s.Keep = DefaultBackupKeep
	}
	s.Keep = min(s.Keep, maxBackupKeep)
	return s, nil
}

func saveBackupSettings(ctx context.Context, q store.Q, s BackupSettings) error {
	raw, _ := json.Marshal(s)
	_, err := q.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('backup_settings', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, string(raw))
	return err
}

// folder is where the backups of file id go.
func (b *Backups) folder(id string, s BackupSettings) string {
	if s.Folder != "" {
		return s.Folder
	}
	return filepath.Join(b.root, id)
}

// ownedBackups lists the backups recorded by this company file (not the ones
// that came with a copy or a restored backup), newest first. folderOnly
// leaves out downloads.
func ownedBackups(ctx context.Context, q store.Q, folderOnly bool) ([]BackupEntry, error) {
	uid, err := store.FileUIDErr(ctx, q)
	if err != nil {
		return nil, err
	}
	where := ""
	if folderOnly {
		where = ` AND kind <> '` + KindDownload + `'`
	}
	rows, err := q.QueryContext(ctx, `SELECT id, created_at, kind, path, size, change_seq FROM backup_log
		WHERE file_uid = ?`+where+` ORDER BY created_at DESC, id DESC`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []BackupEntry{}
	for rows.Next() {
		var e BackupEntry
		if err := rows.Scan(&e.ID, &e.Time, &e.Kind, &e.Path, &e.Size, &e.seq); err != nil {
			return nil, err
		}
		if e.Path != "" {
			e.File = filepath.Base(e.Path)
			if st, err := os.Stat(e.Path); err == nil && st.Mode().IsRegular() {
				e.Exists = true
			}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// lastInFolder is the newest backup whose file is still in place (nil when none).
func lastInFolder(list []BackupEntry) *BackupEntry {
	for i := range list {
		if list[i].Kind != KindDownload && list[i].Exists {
			return &list[i]
		}
	}
	return nil
}

// recordBackup adds a backup to the log of the company file and removes the
// oldest backups beyond keep (rows and files), except backup protect (the one
// being restored). It holds the write lock only for these few rows.
func recordBackup(ctx context.Context, mgr *store.Manager, id string, db *sql.DB, e *BackupEntry, keep int, protect int64) error {
	l := mgr.WriteLock(id)
	l.Lock()
	var drop []BackupEntry
	err := func() error {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		uid, err := store.FileUIDErr(ctx, tx)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO backup_log(created_at, kind, path, size, change_seq, file_uid) VALUES(?,?,?,?,?,?)`,
			e.Time, e.Kind, e.Path, e.Size, e.seq, uid)
		if err != nil {
			return err
		}
		e.ID, _ = res.LastInsertId()
		if keep > 0 && e.Kind != KindDownload {
			list, err := ownedBackups(ctx, tx, true)
			if err != nil {
				return err
			}
			n := 0
			for _, d := range list {
				if d.ID == protect {
					continue
				}
				if n++; n > keep {
					drop = append(drop, d)
				}
			}
			for _, d := range drop {
				if _, err := tx.ExecContext(ctx, `DELETE FROM backup_log WHERE id = ?`, d.ID); err != nil {
					return err
				}
			}
		}
		return tx.Commit()
	}()
	l.Unlock()
	if err != nil {
		return err
	}
	for _, d := range drop {
		if removableBackup(id, d.Path) {
			if err := os.Remove(d.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Printf("backup of %s: could not remove old backup %s: %v", id, d.Path, err)
			}
		}
	}
	return nil
}

// removableBackup: only backup files made for this company file id are ever removed.
func removableBackup(id, path string) bool {
	base := filepath.Base(path)
	return filepath.IsAbs(path) && strings.HasPrefix(base, id+"_") && strings.HasSuffix(base, store.Ext)
}

// recordDownload notes a downloaded backup (File > Back Up Company) in the log.
func recordDownload(ctx context.Context, mgr *store.Manager, id string, db *sql.DB, seq, size int64) {
	e := &BackupEntry{Time: time.Now().UTC().Format(time.RFC3339), Kind: KindDownload, Size: size, seq: seq}
	if err := recordBackup(ctx, mgr, id, db, e, 0, 0); err != nil {
		log.Printf("backup of %s: could not record the download: %v", id, err)
	}
}

// ---------------------------------------------------------------------------
// Making a backup

// backUp makes a backup of company file id into its backup folder. Automatic
// backups (KindAuto) are made only when they are on, the last backup is older
// than the interval and the file changed since; KindClose only when they are
// on and the file changed. KindManual and KindRestore are always made.
// It returns nil, nil when no backup was needed. The caller holds b.lock(id).
func (b *Backups) backUp(ctx context.Context, id, kind string) (*BackupEntry, error) {
	return b.backUpKeeping(ctx, id, kind, 0)
}

// backUpKeeping is backUp that never removes backup protect to keep the number of backups.
func (b *Backups) backUpKeeping(ctx context.Context, id, kind string, protect int64) (*BackupEntry, error) {
	db, err := b.mgr.Open(id)
	if err != nil {
		return nil, err
	}
	s, err := loadBackupSettings(ctx, db)
	if err != nil {
		return nil, err
	}
	seq, err := changeSeq(ctx, db)
	if err != nil {
		return nil, err
	}
	if kind == KindAuto || kind == KindClose {
		if !s.Enabled {
			return nil, nil
		}
		list, err := ownedBackups(ctx, db, true)
		if err != nil {
			return nil, err
		}
		if last := lastInFolder(list); last != nil {
			if last.seq == seq {
				return nil, nil // nothing changed
			}
			if t, err := time.Parse(time.RFC3339, last.Time); kind == KindAuto && err == nil && time.Since(t) < b.interval {
				return nil, nil // not due yet
			}
		}
	}
	dir := b.folder(id, s)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("the backup folder %s cannot be created: %w", dir, err)
	}
	now := time.Now()
	stamp := now.Format("2006-01-02_15-04-05")
	name := id + "_" + stamp + store.Ext
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(dir, name)); errors.Is(err, os.ErrNotExist) {
			break
		}
		name = fmt.Sprintf("%s_%s_%d%s", id, stamp, i, store.Ext)
	}
	final := filepath.Join(dir, name)
	tmp := filepath.Join(dir, "."+name+".tmp")
	removeSQLiteFiles(tmp)
	// a read transaction: other users keep working while the copy is made
	if err := vacuumInto(ctx, db, tmp); err != nil {
		removeSQLiteFiles(tmp)
		if isNoSpace(err) || strings.Contains(strings.ToLower(err.Error()), "disk is full") {
			return nil, fmt.Errorf("there is not enough free disk space in %s", dir)
		}
		return nil, err
	}
	if err := os.Rename(tmp, final); err != nil {
		removeSQLiteFiles(tmp)
		return nil, err
	}
	st, err := os.Stat(final)
	if err != nil {
		return nil, err
	}
	e := &BackupEntry{Time: now.UTC().Format(time.RFC3339), Kind: kind, File: name, Path: final, Size: st.Size(), Exists: true, seq: seq}
	if err := recordBackup(ctx, b.mgr, id, db, e, s.Keep, protect); err != nil {
		os.Remove(final)
		return nil, err
	}
	return e, nil
}

// copyFile copies src to dst (a new file).
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// errNoBackup is returned for a backup that is not (or no longer) in the log.
var errNoBackup = apperr.NotFound("This backup is not in the list of backups of the company file.")
