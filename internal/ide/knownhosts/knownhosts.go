package knownhosts

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/crypto/ssh"
	opensshhosts "golang.org/x/crypto/ssh/knownhosts"
)

const (
	fileName          = "known_hosts"
	maxEntries        = 256
	maxPublicKeyBytes = 16 << 10
	maxHostRunes      = 253
	directoryPerm     = 0o700
	filePerm          = 0o600
	maxFileBytes      = 1 << 20
	defaultPort       = 22
	StatusUnknown     = "unknown"
	StatusMatched     = "matched"
	StatusMismatch    = "mismatch"
)

var (
	ErrInvalidHost      = errors.New("ssh host is invalid")
	ErrInvalidKey       = errors.New("ssh host key is invalid")
	ErrHostKeyChanged   = errors.New("ssh host key has changed")
	ErrStoreInvalid     = errors.New("ssh known hosts store is invalid")
	ErrProbeFailed      = errors.New("ssh host key probe failed")
	ErrCapacity         = errors.New("ssh known hosts capacity reached")
	ErrUntrustedHostKey = errors.New("ssh host key is not trusted")
)

type Entry struct {
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Algorithm   string `json:"algorithm"`
	Fingerprint string `json:"fingerprint"`
	PublicKey   string `json:"publicKey"`
}

type LookupResult struct {
	Status    string `json:"status"`
	Presented Entry  `json:"presented"`
	Known     *Entry `json:"known,omitempty"`
}

type Store struct {
	mu   sync.Mutex
	root string
	path string
}

func New(root string) *Store {
	root = strings.TrimSpace(root)
	return &Store{root: root, path: filepath.Join(root, fileName)}
}

func (store *Store) FilePath() string {
	if store == nil {
		return ""
	}
	return store.path
}

func (store *Store) Parse(ctx context.Context, host string, port int, publicKey string) (Entry, error) {
	if err := contextErr(ctx); err != nil {
		return Entry{}, err
	}
	normalizedHost, normalizedPort, err := normalizeHostPort(host, port)
	if err != nil {
		return Entry{}, err
	}
	key, err := parseHostPublicKey(publicKey)
	if err != nil {
		return Entry{}, err
	}
	return entryFromKey(normalizedHost, normalizedPort, key), nil
}

func (store *Store) Lookup(ctx context.Context, host string, port int, publicKey string) (LookupResult, error) {
	presented, err := store.Parse(ctx, host, port, publicKey)
	if err != nil {
		return LookupResult{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	entries, err := store.listLocked()
	if err != nil {
		return LookupResult{}, err
	}
	return lookupPresented(entries, presented), nil
}

func (store *Store) List(ctx context.Context) ([]Entry, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.listLocked()
}

func (store *Store) Append(ctx context.Context, presented Entry) error {
	if err := contextErr(ctx); err != nil {
		return err
	}
	normalized, err := store.Parse(ctx, presented.Host, presented.Port, presented.PublicKey)
	if err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	entries, err := store.listLocked()
	if err != nil {
		return err
	}
	result := lookupPresented(entries, normalized)
	switch result.Status {
	case StatusMatched:
		return nil
	case StatusMismatch:
		return fmt.Errorf("%w: %s", ErrHostKeyChanged, normalized.Host)
	}
	if len(entries) >= maxEntries {
		return fmt.Errorf("%w: known hosts limit", ErrCapacity)
	}
	return store.writeLocked(append(entries, normalized))
}

func (store *Store) Replace(ctx context.Context, presented Entry) error {
	if err := contextErr(ctx); err != nil {
		return err
	}
	normalized, err := store.Parse(ctx, presented.Host, presented.Port, presented.PublicKey)
	if err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	entries, err := store.listLocked()
	if err != nil {
		return err
	}
	next := make([]Entry, 0, len(entries)+1)
	for _, entry := range entries {
		if sameHost(entry, normalized) {
			continue
		}
		next = append(next, entry)
	}
	if len(next) >= maxEntries {
		return fmt.Errorf("%w: known hosts limit", ErrCapacity)
	}
	return store.writeLocked(append(next, normalized))
}

func (store *Store) Probe(ctx context.Context, host string, port int) (Entry, error) {
	if err := contextErr(ctx); err != nil {
		return Entry{}, err
	}
	normalizedHost, normalizedPort, err := normalizeHostPort(host, port)
	if err != nil {
		return Entry{}, err
	}
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 8*time.Second)
		defer cancel()
	}
	address := net.JoinHostPort(normalizedHost, strconv.Itoa(normalizedPort))
	var captured ssh.PublicKey
	config := &ssh.ClientConfig{
		User: "git",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			captured = key
			return ErrUntrustedHostKey
		},
	}
	dialer := net.Dialer{}
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return Entry{}, fmt.Errorf("%w: dial host", ErrProbeFailed)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	_, _, _, err = ssh.NewClientConn(conn, address, config)
	if captured == nil {
		if err != nil {
			return Entry{}, fmt.Errorf("%w: %v", ErrProbeFailed, err)
		}
		return Entry{}, fmt.Errorf("%w: missing host key", ErrProbeFailed)
	}
	return entryFromKey(normalizedHost, normalizedPort, captured), nil
}

func (store *Store) listLocked() ([]Entry, error) {
	if store == nil || store.root == "" {
		return nil, fmt.Errorf("%w: store root", ErrStoreInvalid)
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		if os.IsNotExist(err) {
			return []Entry{}, nil
		}
		return nil, fmt.Errorf("%w: read known hosts", ErrStoreInvalid)
	}
	if len(data) > maxFileBytes {
		return nil, fmt.Errorf("%w: known hosts too large", ErrStoreInvalid)
	}
	entries := make([]Entry, 0)
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		entry, ok, err := parseKnownHostsLine(scanner.Text())
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("%w: scan known hosts", ErrStoreInvalid)
	}
	return entries, nil
}

func (store *Store) writeLocked(entries []Entry) error {
	if store.root == "" {
		return fmt.Errorf("%w: store root", ErrStoreInvalid)
	}
	if err := os.MkdirAll(store.root, directoryPerm); err != nil {
		return fmt.Errorf("%w: create known hosts directory", ErrStoreInvalid)
	}
	var builder strings.Builder
	for _, entry := range entries {
		key, err := parseHostPublicKey(entry.PublicKey)
		if err != nil {
			return err
		}
		line := opensshhosts.Line([]string{net.JoinHostPort(entry.Host, strconv.Itoa(entry.Port))}, key)
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	data := []byte(builder.String())
	temporary, err := os.CreateTemp(store.root, ".known_hosts-*.tmp")
	if err != nil {
		return fmt.Errorf("%w: create known hosts temporary file", ErrStoreInvalid)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(filePerm); err != nil {
		return fmt.Errorf("%w: secure known hosts temporary file", ErrStoreInvalid)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("%w: write known hosts", ErrStoreInvalid)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("%w: sync known hosts", ErrStoreInvalid)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%w: close known hosts", ErrStoreInvalid)
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("%w: replace known hosts", ErrStoreInvalid)
	}
	_ = os.Chmod(store.path, filePerm)
	committed = true
	return nil
}

func lookupPresented(entries []Entry, presented Entry) LookupResult {
	result := LookupResult{Status: StatusUnknown, Presented: presented}
	for index := range entries {
		entry := entries[index]
		if !sameHost(entry, presented) {
			continue
		}
		copied := entry
		result.Known = &copied
		if entry.Fingerprint == presented.Fingerprint && entry.Algorithm == presented.Algorithm {
			result.Status = StatusMatched
			return result
		}
		result.Status = StatusMismatch
	}
	return result
}

func parseKnownHostsLine(line string) (Entry, bool, error) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "|") || strings.HasPrefix(line, "@") {
		return Entry{}, false, nil
	}
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return Entry{}, false, fmt.Errorf("%w: known hosts line", ErrStoreInvalid)
	}
	host, port, err := parseHostField(fields[0])
	if err != nil {
		return Entry{}, false, err
	}
	key, err := parseHostPublicKey(strings.Join(fields[1:], " "))
	if err != nil {
		return Entry{}, false, err
	}
	return entryFromKey(host, port, key), true, nil
}

func parseHostField(value string) (string, int, error) {
	if strings.Contains(value, ",") {
		value = strings.Split(value, ",")[0]
	}
	if strings.HasPrefix(value, "[") {
		host, portText, err := net.SplitHostPort(value)
		if err != nil {
			return "", 0, fmt.Errorf("%w: known hosts host", ErrStoreInvalid)
		}
		port, err := strconv.Atoi(portText)
		if err != nil {
			return "", 0, fmt.Errorf("%w: known hosts port", ErrStoreInvalid)
		}
		return normalizeHostPort(host, port)
	}
	return normalizeHostPort(value, defaultPort)
}

func entryFromKey(host string, port int, key ssh.PublicKey) Entry {
	return Entry{
		Host:        host,
		Port:        port,
		Algorithm:   key.Type(),
		Fingerprint: ssh.FingerprintSHA256(key),
		PublicKey:   strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key))),
	}
}

func parseHostPublicKey(value string) (ssh.PublicKey, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || len(trimmed) > maxPublicKeyBytes || !utf8.ValidString(trimmed) {
		return nil, fmt.Errorf("%w: key material", ErrInvalidKey)
	}
	lower := strings.ToLower(trimmed)
	if strings.Contains(lower, "begin ") || strings.Contains(lower, "private key") {
		return nil, fmt.Errorf("%w: private key material", ErrInvalidKey)
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(trimmed))
	if err != nil {
		return nil, fmt.Errorf("%w: parse host key", ErrInvalidKey)
	}
	if strings.Contains(key.Type(), "cert") {
		return nil, fmt.Errorf("%w: host certificate", ErrInvalidKey)
	}
	return key, nil
}

func normalizeHostPort(host string, port int) (string, int, error) {
	host = strings.TrimSpace(host)
	if host == "" || utf8.RuneCountInString(host) > maxHostRunes || strings.IndexByte(host, 0) >= 0 {
		return "", 0, fmt.Errorf("%w: empty or too long", ErrInvalidHost)
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	for _, character := range host {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return "", 0, fmt.Errorf("%w: control character", ErrInvalidHost)
		}
	}
	if strings.ContainsAny(host, `/\\@`) || strings.Contains(host, "..") {
		return "", 0, fmt.Errorf("%w: reserved characters", ErrInvalidHost)
	}
	if len(host) >= 2 && host[1] == ':' && unicode.IsLetter(rune(host[0])) {
		return "", 0, fmt.Errorf("%w: host path", ErrInvalidHost)
	}
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else if !validHostname(host) {
		return "", 0, fmt.Errorf("%w: hostname", ErrInvalidHost)
	}
	if port == 0 {
		port = defaultPort
	}
	if port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("%w: port", ErrInvalidHost)
	}
	return host, port, nil
}

func validHostname(host string) bool {
	if host == "" || strings.HasPrefix(host, "-") || strings.HasSuffix(host, "-") || strings.Contains(host, "..") {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for i, character := range label {
			ok := (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || (character == '-' && i > 0 && i < len(label)-1)
			if !ok {
				return false
			}
		}
	}
	return true
}

func sameHost(left, right Entry) bool {
	return left.Host == right.Host && left.Port == right.Port
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("%w: missing context", ErrStoreInvalid)
	}
	return ctx.Err()
}
