// Package workspace manages the private authorization registry for IDE workspaces.
package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	registryFileName   = "workspaces.json"
	registryVersion    = 1
	maxRegistryRecords = 1_000
)

var (
	ErrWorkspaceNotFound    = errors.New("workspace not found")
	ErrWorkspaceUnavailable = errors.New("workspace unavailable")
	ErrInvalidPath          = errors.New("invalid workspace-relative path")
	ErrSensitivePath        = errors.New("sensitive path is not accessible")
	ErrSymlinkNotAllowed    = errors.New("symbolic links are not accessible")
	ErrNotRegularFile       = errors.New("not a regular file")
	ErrRegistryInvalid      = errors.New("workspace registry is invalid")
)

type Summary struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	RegisteredAt time.Time `json:"registeredAt"`
}

type registryDocument struct {
	SchemaVersion int               `json:"schema_version"`
	Workspaces    []workspaceRecord `json:"workspaces"`
}

type workspaceRecord struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Root         string    `json:"root"`
	RegisteredAt time.Time `json:"registered_at"`
}

type Store struct {
	mu           sync.Mutex
	root         string
	registryPath string
	loaded       bool
	records      []workspaceRecord
	now          func() time.Time
}

func New(root string) *Store {
	return &Store{
		root:         strings.TrimSpace(root),
		registryPath: filepath.Join(strings.TrimSpace(root), registryFileName),
		now:          func() time.Time { return time.Now().UTC() },
	}
}

func (store *Store) Register(ctx context.Context, directory string) (Summary, error) {
	if err := contextErr(ctx); err != nil {
		return Summary{}, err
	}
	canonicalRoot, err := canonicalDirectory(directory)
	if err != nil {
		return Summary{}, err
	}
	if isSensitiveAbsolutePath(canonicalRoot) {
		return Summary{}, fmt.Errorf("%w: selected directory", ErrSensitivePath)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Summary{}, err
	}
	for _, record := range store.records {
		if samePath(record.Root, canonicalRoot) {
			return record.summary(), nil
		}
	}
	record := workspaceRecord{
		ID:           uuid.NewString(),
		Name:         filepath.Base(canonicalRoot),
		Root:         canonicalRoot,
		RegisteredAt: store.now(),
	}
	next := append(append([]workspaceRecord(nil), store.records...), record)
	if err := store.saveLocked(next); err != nil {
		return Summary{}, err
	}
	store.records = next
	return record.summary(), nil
}

func (store *Store) List(ctx context.Context) ([]Summary, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return nil, err
	}
	results := make([]Summary, 0, len(store.records))
	for _, record := range store.records {
		results = append(results, record.summary())
	}
	sort.Slice(results, func(left, right int) bool {
		if results[left].RegisteredAt.Equal(results[right].RegisteredAt) {
			return results[left].ID < results[right].ID
		}
		return results[left].RegisteredAt.After(results[right].RegisteredAt)
	})
	return results, nil
}

func (store *Store) Remove(ctx context.Context, workspaceID string) error {
	if err := contextErr(ctx); err != nil {
		return err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return fmt.Errorf("%w: empty workspace ID", ErrWorkspaceNotFound)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return err
	}
	next := make([]workspaceRecord, 0, len(store.records))
	removed := false
	for _, record := range store.records {
		if record.ID == workspaceID {
			removed = true
			continue
		}
		next = append(next, record)
	}
	if !removed {
		return fmt.Errorf("%w: workspace ID", ErrWorkspaceNotFound)
	}
	if err := store.saveLocked(next); err != nil {
		return err
	}
	store.records = next
	return nil
}

func (store *Store) loadLocked() error {
	if store.loaded {
		return nil
	}
	if strings.TrimSpace(store.root) == "" {
		return fmt.Errorf("%w: registry root unavailable", ErrRegistryInvalid)
	}
	document, exists, err := readRegistry(store.registryPath)
	if err != nil {
		return err
	}
	if !exists {
		store.records = make([]workspaceRecord, 0)
		store.loaded = true
		return nil
	}
	if err := validateRegistry(document); err != nil {
		return err
	}
	store.records = append([]workspaceRecord(nil), document.Workspaces...)
	store.loaded = true
	return nil
}

func (store *Store) saveLocked(records []workspaceRecord) error {
	document := registryDocument{SchemaVersion: registryVersion, Workspaces: records}
	if err := validateRegistry(document); err != nil {
		return err
	}
	return writeRegistryAtomically(store.registryPath, document)
}

func (store *Store) canonicalRootForID(ctx context.Context, workspaceID string) (string, error) {
	if err := contextErr(ctx); err != nil {
		return "", err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return "", err
	}
	for _, record := range store.records {
		if record.ID != workspaceID {
			continue
		}
		resolved, err := canonicalDirectory(record.Root)
		if err != nil || !samePath(resolved, record.Root) {
			return "", fmt.Errorf("%w: registered workspace", ErrWorkspaceUnavailable)
		}
		return resolved, nil
	}
	return "", fmt.Errorf("%w: workspace ID", ErrWorkspaceNotFound)
}

func (record workspaceRecord) summary() Summary {
	return Summary{ID: record.ID, Name: record.Name, RegisteredAt: record.RegisteredAt}
}

func canonicalDirectory(directory string) (string, error) {
	directory = strings.TrimSpace(directory)
	if directory == "" || strings.IndexByte(directory, 0) >= 0 {
		return "", fmt.Errorf("%w: selected directory", ErrWorkspaceUnavailable)
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return "", fmt.Errorf("%w: selected directory", ErrWorkspaceUnavailable)
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("%w: selected directory", ErrWorkspaceUnavailable)
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%w: selected directory", ErrWorkspaceUnavailable)
	}
	return filepath.Clean(resolved), nil
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return fmt.Errorf("%w: missing context", ErrWorkspaceUnavailable)
	}
	return ctx.Err()
}
