package assistants

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// The settings file <Books data>/ai-assistants.json (only the user can read
// it, mode 0600):
//
//	{"version": 1, "companies": {"<company id>": {"enabled": true, "allowChanges": false,
//	  "user": "Admin", "fileUid": "<store.FileUID when saved>",
//	  "changedAt": "2026-10-21T10:00:00Z", "changedBy": "Admin", "key": "<access key>",
//	  "keyVersion": "<random id>", "keyWithPasswords": true}}}
//
// A company file without an entry, or whose identity (fileUid) changed since,
// is not shared with AI assistants. "key" is the access key of that company
// file alone (made when an administrator first asks for it), for assistants
// set up with the web address and a key. "keyWithPasswords" tells that the
// file had passwords whenever the key was made or shown: in a file without
// passwords anybody on this computer can read the key (there is no login),
// so such a key stops working as soon as the file has a password, however
// the password was set, and a new one is made when an administrator next
// asks for it. Turning sharing on also replaces the key: the old one stops
// working, and a new one is made when an administrator asks for it.
// "keyVersion" is a random id made with each key, unrelated to the key: the
// settings window learns from it that the key it shows was replaced or
// dropped (see keyVersionOf).

const settingsVersion = 1

type companySetting struct {
	Enabled      bool   `json:"enabled"`
	AllowChanges bool   `json:"allowChanges"`
	User         string `json:"user"`
	FileUID      string `json:"fileUid"`
	ChangedAt    string `json:"changedAt"`
	ChangedBy    string `json:"changedBy"`
	Key          string `json:"key,omitempty"`
	KeyVersion   string `json:"keyVersion,omitempty"` // a random id made with Key
	// KeyWithPasswords: the file had passwords whenever Key was made or shown.
	KeyWithPasswords bool `json:"keyWithPasswords,omitempty"`
}

// newKeyVersion is the keyVersion of a new access key: a random id, so it
// tells nothing about the key (nor when it was made).
func newKeyVersion() (string, error) {
	b := make([]byte, 9)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// keyVersionOf is the "keyVersion" of the status routes: it changes whenever
// the access key of the company file is made, replaced or dropped, and is ""
// while the file has no key that works. A key made or shown while the file
// had no passwords stopped working when it got one (passwords: the file has
// passwords now). cs must be the setting of this very file (effective).
func keyVersionOf(cs companySetting, passwords bool) string {
	switch {
	case cs.Key == "", passwords && !cs.KeyWithPasswords:
		return ""
	case cs.KeyVersion == "":
		return "0" // a key saved before keys had versions (any new key gets a random id)
	}
	return cs.KeyVersion
}

type settingsData struct {
	Version   int                       `json:"version"`
	Companies map[string]companySetting `json:"companies"`
}

type settingsStore struct {
	path string
	mu   sync.Mutex
	data settingsData
}

// openSettings loads the settings file (a missing or damaged file shares nothing).
func openSettings(path string) *settingsStore {
	st := &settingsStore{path: path, data: settingsData{Version: settingsVersion, Companies: map[string]companySetting{}}}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return st
	}
	if err != nil {
		log.Printf("AI assistants: could not read %s (%v); no company file is shared with AI assistants.", path, plainErr(err))
		return st
	}
	var d settingsData
	if err := json.Unmarshal(b, &d); err != nil {
		log.Printf("AI assistants: %s is damaged (%v); no company file is shared with AI assistants until an administrator turns access on again.", path, plainErr(err))
		return st
	}
	for id, cs := range d.Companies {
		if !cs.Enabled {
			cs.AllowChanges = false
		}
		st.data.Companies[id] = cs
	}
	return st
}

func (st *settingsStore) get(companyID string) (companySetting, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	cs, ok := st.data.Companies[companyID]
	return cs, ok
}

// all returns a copy of every saved setting (company id -> setting).
func (st *settingsStore) all() map[string]companySetting {
	st.mu.Lock()
	defer st.mu.Unlock()
	out := make(map[string]companySetting, len(st.data.Companies))
	for id, cs := range st.data.Companies {
		out[id] = cs
	}
	return out
}

// put saves the setting of a company file (the file is replaced atomically;
// on failure nothing changes).
func (st *settingsStore) put(companyID string, cs companySetting) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	next := settingsData{Version: settingsVersion, Companies: make(map[string]companySetting, len(st.data.Companies)+1)}
	for id, v := range st.data.Companies {
		next.Companies[id] = v
	}
	next.Companies[companyID] = cs
	b, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(st.path, append(b, '\n'), 0o600); err != nil {
		return err
	}
	st.data = next
	return nil
}

// writeAtomic replaces a file with data: a temporary file in the same folder,
// renamed over the old one, so a crash never leaves half a file.
func writeAtomic(path string, data []byte, mode fs.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if runtime.GOOS != "windows" {
		if err := f.Chmod(mode); err != nil {
			f.Close()
			return err
		}
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
