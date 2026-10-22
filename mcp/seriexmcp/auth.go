package seriexmcp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Two ways to send the access key with a request:
//
//   - "Authorization: Bearer <key>", for MCP clients that are given the key.
//   - "Authorization: SerieX-Key t=<unix time>,n=<random>,s=<signature>",
//     used by the seriex-mcp program: the key itself never leaves the
//     computer's key file. The signature is a keyed hash (HMAC-SHA256) of
//     the time, the random value, the method, the host and the path, so it
//     is good for one request only. SerieX answers with the header
//     X-SerieX-Proof, a keyed hash of the random value, which proves to the
//     program that it reached the real SerieX (a program pretending to be
//     SerieX does not know the key).

// AuthScheme is the Authorization scheme that proves the key without sending it.
const AuthScheme = "SerieX-Key"

// ProofHeader carries SerieX's proof that it knows the access key.
const ProofHeader = "X-SerieX-Proof"

// signedMaxAge is how far the time of a signed request may be from the
// server's clock.
const signedMaxAge = 2 * time.Minute

func keyedHash(key, msg string) string {
	m := hmac.New(sha256.New, []byte(key))
	m.Write([]byte(msg))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func requestMessage(t, nonce, method, host, path string) string {
	return "seriex-mcp/1 request\n" + t + "\n" + nonce + "\n" + strings.ToUpper(method) + "\n" + strings.ToLower(host) + "\n" + path
}

func proofFor(key, nonce string) string {
	return keyedHash(key, "seriex-mcp/1 server\n"+nonce)
}

// SignRequest returns the Authorization header value of one request to
// SerieX (method, host as in the URL, escaped path) and the random value to
// check SerieX's proof with (CheckProof).
func SignRequest(key, method, host, path string, now time.Time) (header, nonce string) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	nonce = base64.RawURLEncoding.EncodeToString(b)
	t := strconv.FormatInt(now.Unix(), 10)
	sig := keyedHash(key, requestMessage(t, nonce, method, host, path))
	return AuthScheme + " t=" + t + ",n=" + nonce + ",s=" + sig, nonce
}

// CheckProof reports whether proof (the X-SerieX-Proof header of an answer)
// shows that the server knows key.
func CheckProof(key, nonce, proof string) bool {
	if key == "" || nonce == "" || proof == "" {
		return false
	}
	return hmac.Equal([]byte(proofFor(key, nonce)), []byte(strings.TrimSpace(proof)))
}

// requestPath is the path the client signed: the request target as sent,
// even when a handler in front removed a prefix.
func requestPath(r *http.Request) string {
	if r.RequestURI != "" {
		if u, err := url.ParseRequestURI(r.RequestURI); err == nil {
			return u.EscapedPath()
		}
	}
	return r.URL.EscapedPath()
}

// verifySigned checks a SerieX-Key Authorization value (params is the part
// after the scheme) and returns its random value.
func verifySigned(key, params string, r *http.Request, now time.Time) (string, bool) {
	var t, nonce, sig string
	for _, part := range strings.Split(params, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return "", false
		}
		switch k {
		case "t":
			t = v
		case "n":
			nonce = v
		case "s":
			sig = v
		}
	}
	if t == "" || len(nonce) < 16 || len(nonce) > 64 || sig == "" {
		return "", false
	}
	sec, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		return "", false
	}
	if d := now.Sub(time.Unix(sec, 0)); d > signedMaxAge || d < -signedMaxAge {
		return "", false
	}
	want := keyedHash(key, requestMessage(t, nonce, r.Method, r.Host, requestPath(r)))
	if !hmac.Equal([]byte(want), []byte(sig)) {
		return "", false
	}
	return nonce, true
}

// nonceCache remembers the random values of signed requests, so a request
// seen on the way cannot be sent again.
type nonceCache struct {
	mu     sync.Mutex
	seen   map[string]time.Time
	pruned time.Time
	oldest time.Time // the oldest value kept at the last clean-up
}

// nonceKeep is how long a random value is remembered: as long as a signed
// request with it could still be accepted, plus a margin.
const nonceKeep = 2*signedMaxAge + time.Minute

// nonceState is what the cache says about the random value of a request.
type nonceState int

const (
	nonceFresh   nonceState = iota // not used before: recorded now
	nonceUsed                      // seen before: the request is sent a second time
	nonceFlooded                   // too many requests in the last minutes to remember one more
)

// record records nonce when it was not used before.
func (c *nonceCache) record(nonce string, now time.Time) nonceState {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.seen == nil {
		c.seen = map[string]time.Time{}
	}
	if _, used := c.seen[nonce]; used {
		return nonceUsed
	}
	if len(c.seen) >= 4096 && now.Sub(c.pruned) > 10*time.Second {
		c.pruned, c.oldest = now, time.Time{}
		for k, at := range c.seen {
			switch {
			case now.Sub(at) > nonceKeep:
				delete(c.seen, k)
			case c.oldest.IsZero() || at.Before(c.oldest):
				c.oldest = at
			}
		}
	}
	if len(c.seen) >= 50000 {
		return nonceFlooded // refuse rather than forget
	}
	c.seen[nonce] = now
	return nonceFresh
}

// retryAfter is how long a full cache stays full: until its oldest value
// is forgotten at a clean-up (at least 10 seconds).
func (c *nonceCache) retryAfter(now time.Time) time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := nonceKeep + 10*time.Second
	if !c.oldest.IsZero() {
		d = c.oldest.Add(nonceKeep).Sub(now) + 10*time.Second
	}
	return max(d, 10*time.Second)
}
