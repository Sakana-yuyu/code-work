// Package approval persists one-shot IDE authorization receipts without executing operations.
package approval

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	documentVersion      = 1
	defaultTTL           = 5 * time.Minute
	maximumTTL           = 15 * time.Minute
	terminalRetention    = 24 * time.Hour
	maxApprovalRecords   = 512
	maxActiveApprovals   = 128
	approvalRegistryName = "approvals.json"
)

var (
	ErrInvalidContext      = errors.New("approval context is invalid")
	ErrInvalidRequest      = errors.New("approval request is invalid")
	ErrApprovalNotFound    = errors.New("approval not found")
	ErrInvalidTransition   = errors.New("approval state transition is invalid")
	ErrFingerprintMismatch = errors.New("approval fingerprint mismatch")
	ErrApprovalCapacity    = errors.New("approval capacity reached")
	ErrStoreInvalid        = errors.New("approval store is invalid")
	ErrStoreWrite          = errors.New("approval store persistence failed")
)

type State string

const (
	StatePending  State = "pending"
	StateApproved State = "approved"
	StateRejected State = "rejected"
	StateCanceled State = "canceled"
	StateExpired  State = "expired"
	StateConsumed State = "consumed"
)

type Summary struct {
	Title       string   `json:"title"`
	Target      string   `json:"target,omitempty"`
	ImpactCodes []string `json:"impactCodes,omitempty"`
}

type Request struct {
	WorkspaceID string
	RunID       string
	Kind        string
	Fingerprint string
	Summary     Summary
	TTL         time.Duration
}

type Approval struct {
	ID             string    `json:"id"`
	WorkspaceID    string    `json:"workspaceId"`
	RunID          string    `json:"runId,omitempty"`
	Kind           string    `json:"kind"`
	Summary        Summary   `json:"summary"`
	State          State     `json:"state"`
	CreatedAt      time.Time `json:"createdAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
	StateChangedAt time.Time `json:"stateChangedAt"`
}

type Claim struct {
	ApprovalID  string
	WorkspaceID string
	RunID       string
	Kind        string
	ApprovedAt  time.Time
}

type approvalDocument struct {
	SchemaVersion int              `json:"schema_version"`
	Approvals     []approvalRecord `json:"approvals"`
}

type approvalRecord struct {
	ID             string    `json:"id"`
	WorkspaceID    string    `json:"workspace_id"`
	RunID          string    `json:"run_id,omitempty"`
	Kind           string    `json:"kind"`
	Fingerprint    string    `json:"fingerprint"`
	Summary        Summary   `json:"summary"`
	State          State     `json:"state"`
	CreatedAt      time.Time `json:"created_at"`
	ExpiresAt      time.Time `json:"expires_at"`
	StateChangedAt time.Time `json:"state_changed_at"`
}

type Store struct {
	mu      sync.Mutex
	root    string
	path    string
	loaded  bool
	records []approvalRecord
	now     func() time.Time
}

func New(root string) *Store {
	return &Store{root: strings.TrimSpace(root), path: joinPath(root, approvalRegistryName), now: func() time.Time { return time.Now().UTC() }}
}

func (store *Store) Request(ctx context.Context, request Request) (Approval, error) {
	if err := validContext(ctx); err != nil {
		return Approval{}, err
	}
	normalized, err := normalizeRequest(request)
	if err != nil {
		return Approval{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Approval{}, err
	}
	now := store.now()
	next, changed := expireAndPrune(store.records, now)
	if activeApprovalCount(next) >= maxActiveApprovals || len(next) >= maxApprovalRecords {
		if changed {
			_ = store.persistLocked(next)
		}
		return Approval{}, fmt.Errorf("%w: active approval limit", ErrApprovalCapacity)
	}
	id := uuid.NewString()
	record := approvalRecord{ID: id, WorkspaceID: normalized.WorkspaceID, RunID: normalized.RunID, Kind: normalized.Kind, Fingerprint: normalized.Fingerprint, Summary: normalized.Summary, State: StatePending, CreatedAt: now, ExpiresAt: now.Add(normalized.TTL), StateChangedAt: now}
	next = append(next, record)
	if err := store.persistLocked(next); err != nil {
		return Approval{}, err
	}
	store.records = next
	return record.public(), nil
}

func (store *Store) List(ctx context.Context, workspaceID string) ([]Approval, error) {
	if err := validContext(ctx); err != nil {
		return nil, err
	}
	if !validUUID(workspaceID) {
		return nil, fmt.Errorf("%w: workspace ID", ErrInvalidRequest)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return nil, err
	}
	next, changed := expireAndPrune(store.records, store.now())
	if changed {
		if err := store.persistLocked(next); err != nil {
			return nil, err
		}
		store.records = next
	}
	items := make([]Approval, 0)
	for _, record := range store.records {
		if record.WorkspaceID == workspaceID {
			items = append(items, record.public())
		}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	return items, nil
}

func (store *Store) Approve(ctx context.Context, workspaceID, approvalID string) (Approval, error) {
	return store.transition(ctx, workspaceID, approvalID, StateApproved)
}
func (store *Store) Reject(ctx context.Context, workspaceID, approvalID string) (Approval, error) {
	return store.transition(ctx, workspaceID, approvalID, StateRejected)
}

func (store *Store) Claim(ctx context.Context, workspaceID, approvalID, expectedFingerprint string) (Claim, error) {
	if err := validContext(ctx); err != nil {
		return Claim{}, err
	}
	if !validUUID(workspaceID) || !validUUID(approvalID) || !validFingerprint(expectedFingerprint) {
		return Claim{}, fmt.Errorf("%w: claim", ErrInvalidRequest)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Claim{}, err
	}
	now := store.now()
	next, changed := expireAndPrune(store.records, now)
	index := findApproval(next, workspaceID, approvalID)
	if index < 0 {
		if changed {
			_ = store.persistLocked(next)
		}
		return Claim{}, fmt.Errorf("%w: approval ID", ErrApprovalNotFound)
	}
	record := next[index]
	if record.State != StateApproved {
		if changed {
			_ = store.persistLocked(next)
		}
		return Claim{}, fmt.Errorf("%w: approval state", ErrInvalidTransition)
	}
	if subtle.ConstantTimeCompare([]byte(record.Fingerprint), []byte(expectedFingerprint)) != 1 {
		if changed {
			_ = store.persistLocked(next)
		}
		return Claim{}, fmt.Errorf("%w: approval fingerprint", ErrFingerprintMismatch)
	}
	approvedAt := record.StateChangedAt
	next[index].State = StateConsumed
	next[index].StateChangedAt = now
	if err := store.persistLocked(next); err != nil {
		return Claim{}, err
	}
	store.records = next
	return Claim{ApprovalID: record.ID, WorkspaceID: record.WorkspaceID, RunID: record.RunID, Kind: record.Kind, ApprovedAt: approvedAt}, nil
}

func (store *Store) CancelWorkspace(ctx context.Context, workspaceID string) (int, error) {
	return store.cancel(ctx, workspaceID, "")
}
func (store *Store) CancelRun(ctx context.Context, workspaceID, runID string) (int, error) {
	if !validToken(runID, 96) {
		return 0, fmt.Errorf("%w: run ID", ErrInvalidRequest)
	}
	return store.cancel(ctx, workspaceID, runID)
}

func (store *Store) transition(ctx context.Context, workspaceID, approvalID string, target State) (Approval, error) {
	if err := validContext(ctx); err != nil {
		return Approval{}, err
	}
	if !validUUID(workspaceID) || !validUUID(approvalID) {
		return Approval{}, fmt.Errorf("%w: approval", ErrInvalidRequest)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return Approval{}, err
	}
	now := store.now()
	next, changed := expireAndPrune(store.records, now)
	index := findApproval(next, workspaceID, approvalID)
	if index < 0 {
		if changed {
			_ = store.persistLocked(next)
		}
		return Approval{}, fmt.Errorf("%w: approval ID", ErrApprovalNotFound)
	}
	if next[index].State != StatePending {
		if changed {
			_ = store.persistLocked(next)
		}
		return Approval{}, fmt.Errorf("%w: approval state", ErrInvalidTransition)
	}
	next[index].State = target
	next[index].StateChangedAt = now
	if err := store.persistLocked(next); err != nil {
		return Approval{}, err
	}
	store.records = next
	return next[index].public(), nil
}

func (store *Store) cancel(ctx context.Context, workspaceID, runID string) (int, error) {
	if err := validContext(ctx); err != nil {
		return 0, err
	}
	if !validUUID(workspaceID) {
		return 0, fmt.Errorf("%w: workspace ID", ErrInvalidRequest)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := store.loadLocked(); err != nil {
		return 0, err
	}
	now := store.now()
	next, changed := expireAndPrune(store.records, now)
	count := 0
	for index := range next {
		if next[index].WorkspaceID != workspaceID || (runID != "" && next[index].RunID != runID) {
			continue
		}
		if next[index].State == StatePending || next[index].State == StateApproved {
			next[index].State = StateCanceled
			next[index].StateChangedAt = now
			count++
			changed = true
		}
	}
	if changed {
		if err := store.persistLocked(next); err != nil {
			return 0, err
		}
		store.records = next
	}
	return count, nil
}

func (store *Store) loadLocked() error {
	if store.loaded {
		return nil
	}
	if store.root == "" {
		return fmt.Errorf("%w: store root", ErrStoreInvalid)
	}
	document, exists, err := readDocument(store.path)
	if err != nil {
		return err
	}
	if !exists {
		store.records = make([]approvalRecord, 0)
		store.loaded = true
		return nil
	}
	if err := validateDocument(document); err != nil {
		return err
	}
	store.records = append([]approvalRecord(nil), document.Approvals...)
	store.loaded = true
	return nil
}

func (store *Store) persistLocked(records []approvalRecord) error {
	document := approvalDocument{SchemaVersion: documentVersion, Approvals: records}
	if err := validateDocument(document); err != nil {
		return err
	}
	if err := writeDocument(store.path, document); err != nil {
		return err
	}
	return nil
}

func (record approvalRecord) public() Approval {
	return Approval{ID: record.ID, WorkspaceID: record.WorkspaceID, RunID: record.RunID, Kind: record.Kind, Summary: cloneSummary(record.Summary), State: record.State, CreatedAt: record.CreatedAt, ExpiresAt: record.ExpiresAt, StateChangedAt: record.StateChangedAt}
}
func findApproval(records []approvalRecord, workspaceID, approvalID string) int {
	for i := range records {
		if records[i].WorkspaceID == workspaceID && records[i].ID == approvalID {
			return i
		}
	}
	return -1
}
