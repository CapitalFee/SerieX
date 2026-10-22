package companies

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"seriex/internal/apperr"
	"seriex/internal/httpx"
	"seriex/internal/store"
)

// RegisterBackups adds the automatic backup routes of a company file
// (/api/c/{cid}/backups...) and starts counting changes for them:
//
//	GET  /backups                -> backupStatus (settings, last backup, the backups in the folder)
//	GET  /backups/settings       -> backupSettingsView
//	PUT  /backups/settings       {enabled, folder, keep} (administrator) -> backupSettingsView
//	POST /backups                Back up now -> BackupEntry
//	POST /backups/close          the company was closed: back it up in the background when it changed
//	POST /backups/{bid}/restore  {mode: "new"|"replace", name} -> store.CompanyFile
func RegisterBackups(rt *httpx.Router, mgr *store.Manager, b *Backups) {
	rt.Changed = countChange
	rt.C("GET", "/backups", b.getStatus)
	rt.C("GET", "/backups/settings", b.getSettings)
	rt.C("PUT", "/backups/settings", b.putSettings)
	rt.C("POST", "/backups", b.backupNow)
	rt.C("POST", "/backups/close", func(c *httpx.Ctx) error {
		b.Close(c.CompanyID)
		return c.JSONStatus(http.StatusAccepted, map[string]any{"ok": true})
	})
	rt.C("POST", "/backups/{bid}/restore", b.restoreListed)
}

type backupSettingsView struct {
	BackupSettings
	FolderInUse   string `json:"folderInUse"`   // the folder backups go to
	DefaultFolder string `json:"defaultFolder"` // the folder used when Folder is ""
	CanChange     bool   `json:"canChange"`     // the user may change the settings (administrator)
}

type backupStatus struct {
	backupSettingsView
	IntervalSeconds int64         `json:"intervalSeconds"` // age of the last backup before the next automatic one
	Last            *BackupEntry  `json:"last"`            // the newest backup of any kind (downloads too)
	NextDue         string        `json:"nextDue"`         // when the next automatic backup is due, if the file changed ("" when off)
	Changed         bool          `json:"changed"`         // the file changed since its last backup in the folder
	Error           string        `json:"error"`           // the last automatic backup failed with this error
	ErrorTime       string        `json:"errorTime"`
	Backups         []BackupEntry `json:"backups"` // the backups in the folder, newest first
}

func (b *Backups) settingsView(ctx context.Context, c *httpx.Ctx, s BackupSettings) (backupSettingsView, error) {
	admin, err := store.IsAdmin(ctx, c.DB, c.User)
	if err != nil {
		return backupSettingsView{}, err
	}
	return backupSettingsView{BackupSettings: s, FolderInUse: b.folder(c.CompanyID, s),
		DefaultFolder: b.folder(c.CompanyID, BackupSettings{}), CanChange: admin}, nil
}

func (b *Backups) getStatus(c *httpx.Ctx) error {
	ctx := c.Context()
	s, err := loadBackupSettings(ctx, c.DB)
	if err != nil {
		return err
	}
	view, err := b.settingsView(ctx, c, s)
	if err != nil {
		return err
	}
	seq, err := changeSeq(ctx, c.DB)
	if err != nil {
		return err
	}
	all, err := ownedBackups(ctx, c.DB, false)
	if err != nil {
		return err
	}
	out := backupStatus{backupSettingsView: view, IntervalSeconds: int64(b.interval / time.Second), Backups: []BackupEntry{}}
	if len(all) > 0 {
		out.Last = &all[0]
	}
	for _, e := range all {
		if e.Kind != KindDownload {
			out.Backups = append(out.Backups, e)
		}
	}
	last := lastInFolder(out.Backups)
	out.Changed = last == nil || last.seq != seq
	if s.Enabled {
		due := time.Now()
		if last != nil {
			if t, err := time.Parse(time.RFC3339, last.Time); err == nil {
				due = t.Add(b.interval)
			}
		}
		out.NextDue = due.UTC().Format(time.RFC3339)
	}
	if msg, at := b.lastFailure(c.CompanyID); msg != "" {
		out.Error, out.ErrorTime = msg, at.UTC().Format(time.RFC3339)
	}
	return c.JSON(out)
}

func (b *Backups) getSettings(c *httpx.Ctx) error {
	s, err := loadBackupSettings(c.Context(), c.DB)
	if err != nil {
		return err
	}
	view, err := b.settingsView(c.Context(), c, s)
	if err != nil {
		return err
	}
	return c.JSON(view)
}

func (b *Backups) putSettings(c *httpx.Ctx) error {
	ctx := c.Context()
	const adminMsg = "Only an administrator can change the backup settings."
	if err := store.RequireAdmin(ctx, c.DB, c.User, adminMsg); err != nil {
		return err
	}
	s, err := loadBackupSettings(ctx, c.DB)
	if err != nil {
		return err
	}
	// decode over the current settings so omitted fields are kept
	if err := c.Decode(&s); err != nil {
		return err
	}
	if s.Keep < 1 || s.Keep > maxBackupKeep {
		return apperr.Validation("keep", "Keep between 1 and %d backups.", maxBackupKeep)
	}
	s.Folder = strings.TrimSpace(s.Folder)
	if s.Folder != "" {
		if !filepath.IsAbs(s.Folder) {
			return apperr.Validation("folder", "Enter the full location of the backup folder, starting from the top of the drive (for example /Users/me/Backups or C:\\Backups).")
		}
		s.Folder = filepath.Clean(s.Folder)
		if s.Folder == filepath.Clean(b.folder(c.CompanyID, BackupSettings{})) {
			s.Folder = "" // the default folder
		}
	}
	if s.Folder != "" {
		if s.Folder == filepath.Clean(b.mgr.Dir()) {
			return apperr.Validation("folder", "Choose a folder other than the one holding the company files.")
		}
		if err := checkWritable(s.Folder); err != nil {
			return apperr.Validation("folder", "SerieX Books cannot create or write to this folder (%v). Choose another folder.", plainFSError(err))
		}
	}
	err = c.Write(func(tx *sql.Tx) error {
		if err := store.RequireAdmin(ctx, tx, c.User, adminMsg); err != nil {
			return err
		}
		return saveBackupSettings(ctx, tx, s)
	})
	if err != nil {
		return err
	}
	view, err := b.settingsView(ctx, c, s)
	if err != nil {
		return err
	}
	return c.JSON(view)
}

// checkWritable creates folder when needed and checks that files can be written in it.
func checkWritable(folder string) error {
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(folder, ".sxb-write-test-*")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

// plainFSError drops the operation and path from a file system error ("permission denied").
func plainFSError(err error) string {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err.Error()
	}
	return err.Error()
}

func (b *Backups) backupNow(c *httpx.Ctx) error {
	// finish the backup even when the browser stops waiting
	ctx := context.WithoutCancel(c.Context())
	l := b.lock(c.CompanyID)
	l.Lock()
	e, err := b.backUp(ctx, c.CompanyID, KindManual)
	l.Unlock()
	b.report(c.CompanyID, KindManual, e, err)
	if err != nil {
		return apperr.Conflict("The backup could not be made: %v", err)
	}
	return c.JSON(e)
}

// restoreListed restores a backup of the list: as a new company file, or in
// place of the current data (administrator, after a Yes to the question; the
// current data is backed up first).
func (b *Backups) restoreListed(c *httpx.Ctx) error {
	bid, err := c.ID("bid")
	if err != nil {
		return err
	}
	var body struct {
		Mode string `json:"mode"` // "new" | "replace"
		Name string `json:"name"`
	}
	if err := c.Decode(&body); err != nil {
		return err
	}
	if body.Mode != "new" && body.Mode != "replace" {
		return apperr.Validation("mode", "Choose whether to restore the backup as a new company file or in place of the current one.")
	}
	ctx := context.WithoutCancel(c.Context())
	list, err := ownedBackups(ctx, c.DB, true)
	if err != nil {
		return err
	}
	var e *BackupEntry
	for i := range list {
		if list[i].ID == bid {
			e = &list[i]
		}
	}
	if e == nil {
		return errNoBackup
	}
	if !e.Exists {
		return apperr.NotFound("The backup file %s is no longer in the backup folder.", e.Path)
	}
	when := e.Time
	if t, err := time.Parse(time.RFC3339, e.Time); err == nil {
		when = t.Local().Format("01/02/2006 3:04 PM")
	}
	if body.Mode == "replace" {
		if err := store.RequireAdmin(ctx, c.DB, c.User, "Only an administrator can replace the company file with a backup."); err != nil {
			return err
		}
		if !c.Accepts("restore") {
			name := store.CompanyName(ctx, c.DB)
			return apperr.ConfirmKind("restore", "Replace the data of \"%s\" with the backup from %s?\n\nEverything entered after that backup is removed. A backup of the current data is made first, so you can go back to it. Everybody working in this company file is logged out.", name, when)
		}
	}
	name := strings.TrimSpace(body.Name)
	if len([]rune(name)) > 100 {
		return apperr.Validation("name", "The company name is too long (100 characters maximum).")
	}
	if free := diskFree(b.mgr.Dir()); free >= 0 && e.Size*2+(64<<20) > free {
		return apperr.Validation("file", "There is not enough free disk space to restore this backup (%s needed, %s free).",
			fmtBytes(e.Size*2+(64<<20)), fmtBytes(free))
	}
	tmp, err := tempPath(b.mgr, "restore")
	if err != nil {
		return err
	}
	defer removeSQLiteFiles(tmp)
	if err := copyFile(e.Path, tmp); err != nil {
		if isNoSpace(err) {
			return apperr.Validation("file", "There is not enough free disk space to restore this backup.")
		}
		return apperr.Conflict("The backup file could not be read: %v", plainFSError(err))
	}
	companyName, err := validateCompanyFile(ctx, tmp)
	if err != nil {
		return err
	}
	if body.Mode == "new" {
		if err := newIdentity(ctx, tmp); err != nil {
			return err
		}
		os.Remove(tmp + "-wal")
		os.Remove(tmp + "-shm")
		if name == "" {
			name = companyName + " " + e.Time[:10]
			if t, err := time.Parse(time.RFC3339, e.Time); err == nil {
				name = companyName + " " + t.Local().Format("2006-01-02")
			}
		}
		id, err := install(b.mgr, tmp, name)
		if err != nil {
			return err
		}
		cf, err := FileInfo(b.mgr, id)
		if err != nil {
			return err
		}
		return c.JSON(cf)
	}

	// replace the current data
	id := c.CompanyID
	l := b.lock(id)
	l.Lock()
	defer l.Unlock()
	// (the backup being restored stays: it is the only copy of the restored data until the next backup)
	safety, err := b.backUpKeeping(ctx, id, KindRestore, e.ID)
	b.report(id, KindRestore, safety, err)
	if err != nil {
		return apperr.Conflict("The current data could not be backed up first, so nothing was changed: %v", err)
	}
	s, err := loadBackupSettings(ctx, c.DB)
	if err != nil {
		return err
	}
	rows, err := ownedBackups(ctx, c.DB, false)
	if err != nil {
		return err
	}
	seq, err := changeSeq(ctx, c.DB)
	if err != nil {
		return err
	}
	if err := prepareReplacement(ctx, tmp, s, rows, seq); err != nil {
		return err
	}
	fileMu.Lock()
	wl := b.mgr.WriteLock(id)
	wl.Lock() // let the saves that started finish
	err = b.mgr.Replace(id, tmp)
	wl.Unlock()
	fileMu.Unlock()
	if err != nil {
		return err
	}
	if b.rt.FileReplaced != nil {
		b.rt.FileReplaced(id)
	}
	cf, err := FileInfo(b.mgr, id)
	if err != nil {
		return err
	}
	return c.JSON(cf)
}

// prepareReplacement readies a validated backup copy to take the place of the
// current company file: a new file identity (logins end), the current backup
// settings and backup list (they describe the backup folder, not the data),
// and a change count above the current one, so the restored data gets a
// backup of its own at the next close or automatic backup.
func prepareReplacement(ctx context.Context, path string, s BackupSettings, rows []BackupEntry, seq int64) error {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(1)
	err = func() error {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err := store.SetFileUID(ctx, tx); err != nil {
			return err
		}
		uid, err := store.FileUIDErr(ctx, tx)
		if err != nil {
			return err
		}
		if err := saveBackupSettings(ctx, tx, s); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM backup_log`); err != nil {
			return err
		}
		for i := len(rows) - 1; i >= 0; i-- {
			r := rows[i]
			if _, err := tx.ExecContext(ctx, `INSERT INTO backup_log(id, created_at, kind, path, size, change_seq, file_uid) VALUES(?,?,?,?,?,?,?)`,
				r.ID, r.Time, r.Kind, r.Path, r.Size, r.seq, uid); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO meta(key, value) VALUES('change_seq', ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, seq+1); err != nil {
			return err
		}
		return tx.Commit()
	}()
	if cerr := db.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	os.Remove(path + "-wal")
	os.Remove(path + "-shm")
	return nil
}
