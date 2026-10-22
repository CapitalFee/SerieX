package seriexmcp

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// The access key file (<books data>/mcp-access.json) holds the key AI
// assistants send as "Authorization: Bearer <key>":
//
//	{"key": "<43 characters>", "created": "2026-10-20T22:30:00Z"}
//
// Only the user can read it (mode 0600). The SerieX Books server creates it;
// the seriex-mcp program only reads it.

// keyBytes is the number of random bytes of a key (base64url: 43 characters).
const keyBytes = 32

type keyFileData struct {
	Key     string `json:"key"`
	Created string `json:"created"`
}

// NewKey returns a new random access key.
func NewKey() (string, error) {
	b := make([]byte, keyBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// validKey: base64url of at least 32 bytes.
func validKey(k string) bool {
	b, err := base64.RawURLEncoding.DecodeString(k)
	return err == nil && len(b) >= keyBytes
}

// ReadKey reads the access key of a key file (it never creates one).
func ReadKey(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	var d keyFileData
	if err := json.Unmarshal(b, &d); err != nil {
		return "", fmt.Errorf("%s is not a valid access key file: %v", path, err)
	}
	d.Key = strings.TrimSpace(d.Key)
	if !validKey(d.Key) {
		return "", fmt.Errorf("%s does not hold a valid access key", path)
	}
	return d.Key, nil
}

// LoadOrCreateKey returns the access key of the key file, creating the file
// with a new key when it is missing or not valid. A file other users could
// read is made private (0600).
func LoadOrCreateKey(path string) (string, error) {
	key, err := ReadKey(path)
	if err == nil {
		if fi, err := os.Stat(path); err == nil && runtime.GOOS != "windows" && fi.Mode().Perm()&0o077 != 0 {
			if err := os.Chmod(path, 0o600); err != nil {
				return "", err
			}
		}
		return key, nil
	}
	if errors.Is(err, fs.ErrPermission) {
		return "", err // a file this user cannot read: do not replace it
	}
	return RegenerateKey(path) // missing or not valid
}

// RegenerateKey writes a new access key to the key file (replacing the old
// one: assistants using the old key must be set up again) and returns it.
func RegenerateKey(path string) (string, error) {
	key, err := NewKey()
	if err != nil {
		return "", err
	}
	data, err := json.MarshalIndent(keyFileData{Key: key, Created: time.Now().UTC().Format(time.RFC3339)}, "", "  ")
	if err != nil {
		return "", err
	}
	if err := writePrivate(path, append(data, '\n')); err != nil {
		return "", err
	}
	return key, nil
}

// writePrivate replaces a file atomically with a file only the user can read.
func writePrivate(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".mcp-access-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if err := f.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		f.Close()
		return err
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

// KeyProvider gives the access key requests must carry ("" refuses every request).
type KeyProvider interface {
	AccessKey() string
}

// KeyFunc adapts a function to KeyProvider.
type KeyFunc func() string

// AccessKey calls f.
func (f KeyFunc) AccessKey() string { return f() }

// KeyFile is the access key file of a SerieX Books server: it keeps the key
// in memory and can replace it while the server runs.
type KeyFile struct {
	path string
	mu   sync.RWMutex
	key  string
}

// OpenKeyFile loads the key file at path, creating it when needed.
func OpenKeyFile(path string) (*KeyFile, error) {
	key, err := LoadOrCreateKey(path)
	if err != nil {
		return nil, err
	}
	return &KeyFile{path: path, key: key}, nil
}

// Path is the location of the key file.
func (k *KeyFile) Path() string { return k.path }

// AccessKey returns the current key.
func (k *KeyFile) AccessKey() string {
	k.mu.RLock()
	defer k.mu.RUnlock()
	return k.key
}

// Regenerate replaces the key (the old one stops working at once) and returns the new one.
func (k *KeyFile) Regenerate() (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	key, err := RegenerateKey(k.path)
	if err != nil {
		return "", err
	}
	k.key = key
	return key, nil
}
