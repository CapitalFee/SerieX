package seriexmcp

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"
)

// Proof of identity of SerieX Payroll.
//
// The payroll token of a company file with passwords reads that whole file
// for 30 minutes, so it must reach SerieX Payroll and nothing else: any
// program on this computer could be listening at the payroll address while
// SerieX Payroll is closed. SerieX Payroll keeps a secret only this computer
// account can read and proves it knows it before the token is sent.
//
// The secret: <Payroll data folder>/assistant-proof.key (PayrollProofFileName),
// made by SerieX Payroll when it starts: exactly 43 characters, base64url
// without padding (base64.RawURLEncoding) of 32 random bytes, no line break
// (whitespace around it is ignored when reading). The HMAC key is the DECODED
// 32 bytes, not the 43 characters.
//
// The check: GET <payroll>/api/info with the header X-SerieX-Challenge set to
// a fresh random nonce (16 to 64 characters of A-Z a-z 0-9 _ -). SerieX
// Payroll answers with the header
//
//	X-SerieX-Proof: base64.RawURLEncoding(HMAC-SHA256(key, "seriex-payroll-proof\n" + address + "\n" + nonce))
//
// where address is the local end of the connection the request arrived on
// (SerieX Payroll's own address), written as netip.AddrPortFrom(ip.Unmap(),
// port).String(): "127.0.0.1:47190" or "[::1]:47190". Here it is the address
// of the connection that was dialed, so a program that passes the challenge
// on to a real SerieX Payroll at another address or port (a relay) gets an
// answer that does not match: no token is sent to it. "localhost" is dialed
// as 127.0.0.1, so the address is always a literal one. The proof is
// compared in constant time.
//
// The check is made on the very connection that then carries the token: the
// client below opens a new connection for every request with a token (no
// connection is reused), proves the program at the other end first, and only
// then sends the request. A program that takes the port later cannot receive
// a token sent over a connection proven earlier, so no check result is kept
// for an address (nothing to re-check after a connection error: every
// connection is checked).

// PayrollProofFileName is the file, in the SerieX Payroll data folder, that
// holds the secret SerieX Payroll proves who it is with.
const PayrollProofFileName = "assistant-proof.key"

const (
	payrollChallengeHeader = "X-SerieX-Challenge"
	payrollProofHeader     = "X-SerieX-Proof"
	payrollProofLabel      = "seriex-payroll-proof\n"
	payrollProofKeyBytes   = 32
	payrollProofKeyChars   = 43 // base64url without padding of 32 bytes
)

// errPayrollUnproven: the program at the payroll address did not prove it is
// SerieX Payroll (or the proof could not be checked).
var errPayrollUnproven = errors.New("the program at the payroll address did not prove it is SerieX Payroll")

// msgPayrollUnproven answers a payroll tool call when no token was sent.
const msgPayrollUnproven = "SerieX could not confirm that the program at the payroll address is SerieX Payroll, so payroll details are not shared. Make sure SerieX Payroll is open, or update SerieX."

// readPayrollProofKey reads the secret of SerieX Payroll (the decoded 32 bytes).
func readPayrollProofKey(path string) ([]byte, error) {
	if path == "" {
		return nil, errors.New("the SerieX Payroll data folder is unknown")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	txt := strings.TrimSpace(string(b))
	key, err := base64.RawURLEncoding.DecodeString(txt)
	if len(txt) != payrollProofKeyChars || err != nil || len(key) != payrollProofKeyBytes {
		return nil, fmt.Errorf("%s does not hold a valid key", path)
	}
	return key, nil
}

// payrollProof is the proof SerieX Payroll listening at address
// ("127.0.0.1:47190", "[::1]:47190") gives for nonce.
func payrollProof(key []byte, address, nonce string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(payrollProofLabel + address + "\n" + nonce))
	return m.Sum(nil)
}

// dialedAddress is the address conn was dialed to, as SerieX Payroll writes
// its own: netip.AddrPortFrom(ip.Unmap(), port).String().
func dialedAddress(conn net.Conn) (string, error) {
	ta, ok := conn.RemoteAddr().(*net.TCPAddr)
	if !ok {
		return "", fmt.Errorf("not a TCP connection")
	}
	ap := ta.AddrPort()
	ip := ap.Addr().Unmap()
	if !ip.IsValid() || ip.IsUnspecified() || ap.Port() == 0 {
		return "", fmt.Errorf("unknown address %s", ta)
	}
	return netip.AddrPortFrom(ip, ap.Port()).String(), nil
}

// literalLoopback writes "localhost" as 127.0.0.1, so the address dialed is
// the one SerieX Payroll signs (otherwise ::1 may be tried first, where
// another program could listen).
func literalLoopback(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err == nil && strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return net.JoinHostPort("127.0.0.1", port)
	}
	return addr
}

// newChallenge is a fresh random nonce (32 characters of A-Z a-z 0-9 _ -).
func newChallenge() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// provePayroll asks the program at the other end of conn (addr: host:port)
// to prove it is SerieX Payroll, on that connection, before anything else
// is sent over it. The connection is left ready for the next request.
func provePayroll(ctx context.Context, conn net.Conn, addr string, key []byte) error {
	address, err := dialedAddress(conn)
	if err != nil {
		return fmt.Errorf("%w (%v)", errPayrollUnproven, err)
	}
	nonce, err := newChallenge()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(3 * time.Second)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/api/info", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set(payrollChallengeHeader, nonce)
	if err := req.Write(conn); err != nil {
		return err
	}
	br := bufio.NewReader(conn)
	res, err := http.ReadResponse(br, req)
	if err != nil {
		return fmt.Errorf("%w (%v)", errPayrollUnproven, err)
	}
	n, err := io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10+1))
	res.Body.Close()
	switch {
	case err != nil:
		return fmt.Errorf("%w (%v)", errPayrollUnproven, err)
	case n > 64<<10 || res.Close || br.Buffered() > 0:
		// the connection cannot carry the next request cleanly
		return fmt.Errorf("%w (unexpected answer)", errPayrollUnproven)
	case res.StatusCode != http.StatusOK:
		return fmt.Errorf("%w (HTTP %d)", errPayrollUnproven, res.StatusCode)
	}
	got, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(res.Header.Get(payrollProofHeader)))
	if err != nil || !hmac.Equal(got, payrollProof(key, address, nonce)) {
		return fmt.Errorf("%w (no valid proof)", errPayrollUnproven)
	}
	return conn.SetDeadline(time.Time{})
}

// provenPayrollClient sends requests to SerieX Payroll only over
// connections whose program proved it is SerieX Payroll (one new connection
// per request; plain http on this computer only). The secret is read from
// keyPath for every connection, so a new one is picked up at once.
func provenPayrollClient(keyPath string, log *slog.Logger) *http.Client {
	tr := localTransport()
	tr.DisableKeepAlives = true // never reuse a connection: each one is proven
	tr.ForceAttemptHTTP2 = false
	tr.TLSClientConfig = nil
	tr.DialTLSContext = func(context.Context, string, string) (net.Conn, error) {
		return nil, fmt.Errorf("%w (only http on this computer is supported)", errPayrollUnproven)
	}
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	tr.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		addr = literalLoopback(addr)
		host, _, err := net.SplitHostPort(addr)
		if err != nil || !IsLoopbackHost(host) {
			return nil, fmt.Errorf("%w (not on this computer)", errPayrollUnproven)
		}
		key, err := readPayrollProofKey(keyPath)
		if err != nil {
			if log != nil {
				log.Warn("the SerieX Payroll proof key cannot be read; payroll details of company files with passwords are not shared", "error", plainKeyErr(err))
			}
			return nil, fmt.Errorf("%w (%v)", errPayrollUnproven, plainKeyErr(err))
		}
		conn, err := dialer.DialContext(ctx, network, addr)
		if err != nil {
			return nil, err // not running: a plain dial error
		}
		if err := provePayroll(ctx, conn, addr, key); err != nil {
			conn.Close()
			if log != nil {
				log.Warn("the program at the payroll address did not prove it is SerieX Payroll; no token was sent", "error", err)
			}
			if !errors.Is(err, errPayrollUnproven) {
				err = fmt.Errorf("%w (%v)", errPayrollUnproven, err)
			}
			return nil, err
		}
		return conn, nil
	}
	return &http.Client{Timeout: 90 * time.Second, Transport: tr, CheckRedirect: noRedirect}
}

// plainKeyErr describes a failure to read the proof key without its content.
func plainKeyErr(err error) string {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return "the file is missing"
	case errors.Is(err, os.ErrPermission):
		return "the file cannot be read"
	}
	return err.Error()
}
