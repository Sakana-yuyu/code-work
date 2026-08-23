package sshvault

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/crypto/ssh"
)

const (
	vaultFileName      = "keys.json"
	vaultSchemaVersion = 1
	maxVaultKeys       = 32
	maxPrivateKeyBytes = 32 << 10
	maxNameRunes       = 64
	vaultDirectoryPerm = 0o700
	vaultFilePerm      = 0o600
	maxVaultJSONBytes  = 2 << 20
)

type KeySummary struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Algorithm   string    `json:"algorithm"`
	Fingerprint string    `json:"fingerprint"`
	PublicKey   string    `json:"publicKey"`
	CreatedAt   time.Time `json:"createdAt"`
}

type ImportRequest struct {
	Name       string
	PrivateKey string
	Passphrase string
}

type vaultDocument struct {
	SchemaVersion int           `json:"schema_version"`
	Keys          []vaultRecord `json:"keys"`
}

type vaultRecord struct {
	ID                  string    `json:"id"`
	Name                string    `json:"name"`
	Algorithm           string    `json:"algorithm"`
	Fingerprint         string    `json:"fingerprint"`
	PublicKey           string    `json:"public_key"`
	CreatedAt           time.Time `json:"created_at"`
	ProtectedPrivateKey string    `json:"protected_private_key"`
}

type Store struct {
	mu        sync.Mutex
	root      string
	path      string
	protector Protector
	loaded    bool
	records   []vaultRecord
	now       func() time.Time
}

func New(root string, protector Protector) *Store {
	if protector == nil {
		protector = NewDPAPIProtector()
	}
	root = strings.TrimSpace(root)
	return &Store{
		root:      root,
		path:      filepath.Join(root, vaultFileName),
		protector: protector,
		now:       func() time.Time { return time.Now().UTC() },
	}
}

func (store *Store) Import(ctx context.Context, request ImportRequest) (KeySummary, error) {
	if err := contextErr(ctx); err != nil {
		return KeySummary{}, err
	}
	name, err := normalizeName(request.Name)
	if err != nil {
		return KeySummary{}, err
	}
	storedPEM, signer, err := parsePrivateKey(request.PrivateKey, request.Passphrase)
	if err != nil {
		return KeySummary{}, err
	}
	protected, err := store.protect(storedPEM)
	if err != nil {
		return KeySummary{}, err
	}
	return store.insert(signer, name, protected)
}

func (store *Store) Generate(ctx context.Context, name string) (KeySummary, error) {
	if err := contextErr(ctx); err != nil {
		return KeySummary{}, err
	}
	normalized, err := normalizeName(name)
	if err != nil {
		return KeySummary{}, err
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return KeySummary{}, fmt.Errorf("%w: generate key", ErrInvalidKey)
	}
	block, err := ssh.MarshalPrivateKey(private, normalized)
	if err != nil {
		return KeySummary{}, fmt.Errorf("%w: marshal key", ErrInvalidKey)
	}
	pemBytes := pem.EncodeToMemory(block)
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		return KeySummary{}, fmt.Errorf("%w: signer", ErrInvalidKey)
	}
	protected, err := store.protect(pemBytes)
	if err != nil {
		return KeySummary{}, err
	}
	return store.insert(signer, normalized, protected)
}

func (store *Store) List(ctx context.Context) ([]KeySummary, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return nil, err
	}
	items := make([]KeySummary, 0, len(store.records))
	for _, record := range store.records {
		items = append(items, record.summary())
	}
	sort.Slice(items, func(left, right int) bool {
		if items[left].CreatedAt.Equal(items[right].CreatedAt) {
			return items[left].ID < items[right].ID
		}
		return items[left].CreatedAt.After(items[right].CreatedAt)
	})
	return items, nil
}

func (store *Store) Remove(ctx context.Context, keyID string) error {
	if err := contextErr(ctx); err != nil {
		return err
	}
	keyID = strings.TrimSpace(keyID)
	if keyID == "" {
		return fmt.Errorf("%w: empty key ID", ErrKeyNotFound)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return err
	}
	next := make([]vaultRecord, 0, len(store.records))
	removed := false
	for _, record := range store.records {
		if record.ID == keyID {
			removed = true
			continue
		}
		next = append(next, record)
	}
	if !removed {
		return fmt.Errorf("%w: key ID", ErrKeyNotFound)
	}
	if err := store.saveLocked(next); err != nil {
		return err
	}
	store.records = next
	return nil
}

func (store *Store) PrivateMaterial(ctx context.Context, keyID string) ([]byte, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return nil, err
	}
	for _, record := range store.records {
		if record.ID != keyID {
			continue
		}
		raw, err := base64.StdEncoding.DecodeString(record.ProtectedPrivateKey)
		if err != nil {
			return nil, fmt.Errorf("%w: decode protected key", ErrVaultInvalid)
		}
		plaintext, err := store.protector.Unprotect(raw)
		if err != nil {
			return nil, err
		}
		return plaintext, nil
	}
	return nil, fmt.Errorf("%w: key ID", ErrKeyNotFound)
}

func (store *Store) insert(signer ssh.Signer, name string, protected []byte) (KeySummary, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return KeySummary{}, err
	}
	if len(store.records) >= maxVaultKeys {
		return KeySummary{}, fmt.Errorf("%w: key limit", ErrVaultCapacity)
	}
	record := vaultRecord{
		ID:                  uuid.NewString(),
		Name:                name,
		Algorithm:           signer.PublicKey().Type(),
		Fingerprint:         ssh.FingerprintSHA256(signer.PublicKey()),
		PublicKey:           strings.TrimSpace(string(ssh.MarshalAuthorizedKey(signer.PublicKey()))),
		CreatedAt:           store.now(),
		ProtectedPrivateKey: base64.StdEncoding.EncodeToString(protected),
	}
	next := append(append([]vaultRecord(nil), store.records...), record)
	if err := store.saveLocked(next); err != nil {
		return KeySummary{}, err
	}
	store.records = next
	return record.summary(), nil
}

func (store *Store) protect(plaintext []byte) ([]byte, error) {
	if store.protector == nil {
		return nil, ErrProtectorUnavailable
	}
	protected, err := store.protector.Protect(plaintext)
	if err != nil {
		return nil, err
	}
	if bytes.Contains(protected, []byte("BEGIN ")) || bytes.Contains(protected, []byte("PRIVATE KEY")) {
		return nil, fmt.Errorf("%w: protector left plaintext markers", ErrProtectorUnavailable)
	}
	return protected, nil
}

func (store *Store) loadLocked() error {
	if store.loaded {
		return nil
	}
	if strings.TrimSpace(store.root) == "" {
		return fmt.Errorf("%w: vault root unavailable", ErrVaultInvalid)
	}
	file, err := os.Open(store.path)
	if err != nil {
		if os.IsNotExist(err) {
			store.records = make([]vaultRecord, 0)
			store.loaded = true
			return nil
		}
		return fmt.Errorf("%w: read vault", ErrVaultInvalid)
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, maxVaultJSONBytes+1))
	decoder.DisallowUnknownFields()
	var document vaultDocument
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("%w: decode vault", ErrVaultInvalid)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return fmt.Errorf("%w: vault has trailing data", ErrVaultInvalid)
	}
	if document.SchemaVersion != vaultSchemaVersion || len(document.Keys) > maxVaultKeys {
		return fmt.Errorf("%w: unsupported vault schema", ErrVaultInvalid)
	}
	store.records = append([]vaultRecord(nil), document.Keys...)
	store.loaded = true
	return nil
}

func (store *Store) saveLocked(records []vaultRecord) error {
	if err := os.MkdirAll(store.root, vaultDirectoryPerm); err != nil {
		return fmt.Errorf("%w: create vault directory", ErrVaultInvalid)
	}
	_ = os.Chmod(store.root, vaultDirectoryPerm)
	document := vaultDocument{SchemaVersion: vaultSchemaVersion, Keys: records}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: encode vault", ErrVaultInvalid)
	}
	data = append(data, '\n')
	temporary, err := os.CreateTemp(store.root, ".keys-*.tmp")
	if err != nil {
		return fmt.Errorf("%w: create vault temporary file", ErrVaultInvalid)
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		if !committed {
			_ = temporary.Close()
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(vaultFilePerm); err != nil {
		return fmt.Errorf("%w: secure vault temporary file", ErrVaultInvalid)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("%w: write vault", ErrVaultInvalid)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("%w: sync vault", ErrVaultInvalid)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("%w: close vault", ErrVaultInvalid)
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("%w: replace vault", ErrVaultInvalid)
	}
	_ = os.Chmod(store.path, vaultFilePerm)
	committed = true
	return nil
}

func (record vaultRecord) summary() KeySummary {
	return KeySummary{
		ID:          record.ID,
		Name:        record.Name,
		Algorithm:   record.Algorithm,
		Fingerprint: record.Fingerprint,
		PublicKey:   record.PublicKey,
		CreatedAt:   record.CreatedAt,
	}
}

func parsePrivateKey(privateKey, passphrase string) ([]byte, ssh.Signer, error) {
	pemBytes := []byte(privateKey)
	if strings.TrimSpace(privateKey) == "" || len(pemBytes) > maxPrivateKeyBytes {
		return nil, nil, fmt.Errorf("%w: key material", ErrInvalidKey)
	}
	signer, err := ssh.ParsePrivateKey(pemBytes)
	stored := pemBytes
	if err != nil {
		if strings.TrimSpace(passphrase) == "" {
			return nil, nil, fmt.Errorf("%w: parse key", ErrInvalidKey)
		}
		raw, parseErr := ssh.ParseRawPrivateKeyWithPassphrase(pemBytes, []byte(passphrase))
		if parseErr != nil {
			return nil, nil, fmt.Errorf("%w: parse protected key", ErrInvalidKey)
		}
		block, marshalErr := ssh.MarshalPrivateKey(raw, "")
		if marshalErr != nil {
			return nil, nil, fmt.Errorf("%w: normalize key", ErrInvalidKey)
		}
		stored = pem.EncodeToMemory(block)
		signer, err = ssh.ParsePrivateKey(stored)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: parse normalized key", ErrInvalidKey)
		}
	}
	return stored, signer, nil
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxNameRunes || strings.IndexByte(name, 0) >= 0 {
		return "", fmt.Errorf("%w: empty or too long", ErrInvalidName)
	}
	if strings.ContainsAny(name, `/\:*?"<>|`) || strings.Contains(name, "..") {
		return "", fmt.Errorf("%w: reserved characters", ErrInvalidName)
	}
	return name, nil
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("%w: missing context", ErrVaultInvalid)
	}
	return ctx.Err()
}
