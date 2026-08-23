package knownhosts

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestLookupUnknownDoesNotCreateKnownHostsFile(t *testing.T) {
	root := t.TempDir()
	store := New(root)
	_, public := mustHostKey(t)
	result, err := store.Lookup(context.Background(), "github.com", 22, public)
	if err != nil {
		t.Fatalf("Lookup() error = %v", err)
	}
	if result.Status != StatusUnknown || result.Presented.Fingerprint == "" || result.Known != nil {
		t.Fatalf("Lookup() = %+v", result)
	}
	if _, err := os.Stat(store.FilePath()); !os.IsNotExist(err) {
		t.Fatalf("Lookup wrote %s: %v", store.FilePath(), err)
	}
}

func TestAppendWritesManagedFileAndMatchesLaterLookup(t *testing.T) {
	root := t.TempDir()
	store := New(root)
	_, public := mustHostKey(t)
	presented, err := store.Parse(context.Background(), "github.com", 22, public)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if err := store.Append(context.Background(), presented); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	if store.FilePath() != filepath.Join(root, "known_hosts") {
		t.Fatalf("FilePath() = %q", store.FilePath())
	}
	if strings.Contains(strings.ToLower(store.FilePath()), filepath.Join(".ssh", "known_hosts")) {
		t.Fatalf("managed file used user known_hosts: %s", store.FilePath())
	}
	disk, err := os.ReadFile(store.FilePath())
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if !strings.Contains(string(disk), "github.com") || !strings.Contains(string(disk), "ssh-ed25519") {
		t.Fatalf("known_hosts = %q", disk)
	}
	assertNoSecret(t, string(disk), "BEGIN OPENSSH PRIVATE KEY", "PRIVATE KEY")
	result, err := store.Lookup(context.Background(), "github.com", 22, public)
	if err != nil || result.Status != StatusMatched {
		t.Fatalf("Lookup() = (%+v, %v)", result, err)
	}
	items, err := store.List(context.Background())
	if err != nil || len(items) != 1 || items[0].Host != "github.com" || items[0].Port != 22 {
		t.Fatalf("List() = (%+v, %v)", items, err)
	}
	encoded := strings.ToLower(fmtJSON(t, items) + fmtJSON(t, result) + fmtJSON(t, presented))
	if strings.Contains(encoded, "privatekey") || strings.Contains(encoded, "begin ") {
		t.Fatalf("DTO leaked secret: %s", encoded)
	}
}

func TestChangedHostKeyIsMismatchAndAppendDoesNotOverwrite(t *testing.T) {
	store := New(t.TempDir())
	_, first := mustHostKey(t)
	_, second := mustHostKey(t)
	presented, err := store.Parse(context.Background(), "gitlab.example", 22, first)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if err := store.Append(context.Background(), presented); err != nil {
		t.Fatalf("Append() error = %v", err)
	}
	result, err := store.Lookup(context.Background(), "gitlab.example", 22, second)
	if err != nil || result.Status != StatusMismatch || result.Known == nil || result.Known.Fingerprint == result.Presented.Fingerprint {
		t.Fatalf("Lookup() = (%+v, %v)", result, err)
	}
	changed, err := store.Parse(context.Background(), "gitlab.example", 22, second)
	if err != nil {
		t.Fatalf("Parse(changed) error = %v", err)
	}
	if err := store.Append(context.Background(), changed); err == nil {
		t.Fatal("Append(changed) = nil")
	}
	still, err := store.Lookup(context.Background(), "gitlab.example", 22, first)
	if err != nil || still.Status != StatusMatched {
		t.Fatalf("Lookup after rejected append = (%+v, %v)", still, err)
	}
	if err := store.Replace(context.Background(), changed); err != nil {
		t.Fatalf("Replace() error = %v", err)
	}
	after, err := store.Lookup(context.Background(), "gitlab.example", 22, second)
	if err != nil || after.Status != StatusMatched {
		t.Fatalf("Lookup after Replace = (%+v, %v)", after, err)
	}
}

func TestParseRejectsPrivateKeysAndHostPaths(t *testing.T) {
	store := New(t.TempDir())
	_, public := mustHostKey(t)
	if _, err := store.Parse(context.Background(), `C:\windows`, 22, public); err == nil {
		t.Fatal("Parse(host path) = nil")
	}
	if _, err := store.Parse(context.Background(), "../escape", 22, public); err == nil {
		t.Fatal("Parse(relative path) = nil")
	}
	if _, err := store.Parse(context.Background(), "git@github.com", 22, public); err == nil {
		t.Fatal("Parse(user@host) = nil")
	}
	if _, err := store.Parse(context.Background(), "github.com", 22, "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"); err == nil {
		t.Fatal("Parse(private key) = nil")
	}
}

func TestProbeCapturesHostKeyWithoutWritingKnownHosts(t *testing.T) {
	signer, public := mustHostKey(t)
	addr := startTestSSHServer(t, signer)
	host, port := splitAddr(t, addr)
	store := New(t.TempDir())
	presented, err := store.Probe(context.Background(), host, port)
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if presented.Fingerprint == "" || presented.PublicKey != strings.TrimSpace(public) {
		t.Fatalf("presented = %+v want %q", presented, public)
	}
	if _, err := os.Stat(store.FilePath()); !os.IsNotExist(err) {
		t.Fatalf("Probe wrote %s: %v", store.FilePath(), err)
	}
}

func mustHostKey(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey() error = %v", err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		t.Fatalf("NewSignerFromKey() error = %v", err)
	}
	return signer, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey())))
}

func startTestSSHServer(t *testing.T, hostKey ssh.Signer) string {
	t.Helper()
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(hostKey)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen() error = %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				_, _, _, _ = ssh.NewServerConn(conn, config)
			}(conn)
		}
	}()
	return listener.Addr().String()
}

func splitAddr(t *testing.T, addr string) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("SplitHostPort(%q) error = %v", addr, err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 {
		t.Fatalf("port %q", portText)
	}
	return host, port
}

func fmtJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return string(raw)
}

func assertNoSecret(t *testing.T, haystack string, secrets ...string) {
	t.Helper()
	lower := strings.ToLower(haystack)
	for _, secret := range secrets {
		if strings.Contains(lower, strings.ToLower(secret)) {
			t.Fatalf("secret %q leaked", secret)
		}
	}
}
