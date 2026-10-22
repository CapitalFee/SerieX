package setup

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Proof of identity for SerieX Books. Before the AI assistant connection of
// SerieX Books sends a session token to the Payroll address, it checks that the
// program answering there is this payroll server and not another program that
// took the port: it sends GET /api/info with a fresh random challenge, and only
// the payroll server can answer with the HMAC of that challenge keyed with the
// secret in <data folder>/assistant-proof.key, which SerieX Books reads from
// disk (the file is private to the user: mode 0600 in a 0700 folder).
//
// The signed message also holds the local address (IP and port) the request
// arrived on, and SerieX Books checks it against the address of the connection
// it dialed: a program on the address SerieX Books uses cannot pass the
// challenge on to a real payroll server on another port or another local
// address (for example [::1] next to 127.0.0.1) and return its answer.
//
//	X-SerieX-Proof = base64url_nopad(HMAC-SHA256(key, "seriex-payroll-proof\n" + address + "\n" + challenge))
//
// address is netip.AddrPortFrom(ip.Unmap(), port).String(): "127.0.0.1:47190"
// or "[::1]:47190" (Unmap, because a listener on all addresses sees IPv4
// clients as ::ffff:127.0.0.1).
//
// File format: 43 characters, base64url without padding, of 32 random bytes;
// the HMAC key is the decoded 32 bytes. The key is never logged or served.

const (
	proofFile      = "assistant-proof.key"
	challengeHdr   = "X-SerieX-Challenge"
	proofHdr       = "X-SerieX-Proof"
	proofLabel     = "seriex-payroll-proof\n"
	proofKeyLength = 32
)

var (
	proofKey      []byte
	challengeForm = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)
)

// loadProofKey reads the proof key of the data folder, creating it (or
// replacing a damaged one) when needed. On failure the server runs without
// one and answers no proofs, so SerieX Books will not send it tokens.
func loadProofKey(dir string) {
	path := filepath.Join(dir, proofFile)
	if b, err := os.ReadFile(path); err == nil {
		if key, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(b))); err == nil && len(key) == proofKeyLength {
			if st, err := os.Stat(path); err == nil && st.Mode().Perm()&0o077 != 0 {
				os.Chmod(path, 0o600)
			}
			proofKey = key
			return
		}
		log.Printf("the AI assistant proof key in %s is damaged; a new one is created", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		log.Printf("could not read the AI assistant proof key in %s: %v", dir, err)
		return
	}
	key := make([]byte, proofKeyLength)
	if _, err := rand.Read(key); err != nil {
		log.Printf("could not create the AI assistant proof key: %v", err)
		return
	}
	// Write to a private temporary file, then rename it, so SerieX Books never reads half a key.
	tmp, err := os.CreateTemp(dir, ".assistant-proof-*")
	if err != nil {
		log.Printf("could not create the AI assistant proof key in %s: %v", dir, err)
		return
	}
	name := tmp.Name()
	_, werr := tmp.WriteString(base64.RawURLEncoding.EncodeToString(key))
	if werr == nil {
		werr = tmp.Chmod(0o600)
	}
	if werr == nil {
		werr = tmp.Sync()
	}
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Rename(name, path)
	}
	if werr != nil {
		os.Remove(name)
		log.Printf("could not save the AI assistant proof key in %s: %v", dir, werr)
		return
	}
	proofKey = key
}

// addProof answers a valid X-SerieX-Challenge header with X-SerieX-Proof.
func addProof(w http.ResponseWriter, r *http.Request) {
	nonce := r.Header.Get(challengeHdr)
	if proofKey == nil || !challengeForm.MatchString(nonce) {
		return
	}
	// the local end of this connection: the address and port this server listens on
	local, ok := r.Context().Value(http.LocalAddrContextKey).(*net.TCPAddr)
	if !ok {
		return
	}
	ap := local.AddrPort()
	ip := ap.Addr().Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ap.Port() == 0 {
		return
	}
	m := hmac.New(sha256.New, proofKey)
	m.Write([]byte(proofLabel + netip.AddrPortFrom(ip, ap.Port()).String() + "\n" + nonce))
	w.Header().Set(proofHdr, base64.RawURLEncoding.EncodeToString(m.Sum(nil)))
}
