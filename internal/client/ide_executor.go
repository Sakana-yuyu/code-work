package client

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"cursor/internal/backend/delegation"
	"cursor/internal/ide/approval"
)

const (
	ideExecutorWriteKind     = "executor_write"
	ideExecutorGrantFileName = "grants.json"
	executorAuthCLI          = "cli_login"
	executorAuthBYOK         = "byok_model"
)

type IDEExecutorWritePreview struct {
	Approval   approval.Approval `json:"approval"`
	ExecutorID string            `json:"executorId"`
	AuthKind   string            `json:"authKind"`
}

type executorGrantStore struct {
	path string
	mu   sync.Mutex
}

func newExecutorGrantStore(root string) *executorGrantStore {
	return &executorGrantStore{path: filepath.Join(strings.TrimSpace(root), ideExecutorGrantFileName)}
}

func (s *ProxyService) applyExecutorPolicy(items []DelegationExecutorSnapshot) []DelegationExecutorSnapshot {
	if len(items) == 0 {
		return items
	}
	grants := map[string]bool{}
	if s != nil && s.ideExecutorGrants != nil {
		grants = s.ideExecutorGrants.snapshot()
	}
	out := make([]DelegationExecutorSnapshot, 0, len(items))
	for _, item := range items {
		item.AuthKind = executorAuthKind(item.ID)
		filtered := make([]string, 0, len(item.Capabilities))
		for _, capability := range item.Capabilities {
			if capability == string(delegation.ExecutorCapabilityWriteWorkspace) && !grants[item.ID] {
				continue
			}
			filtered = append(filtered, capability)
		}
		item.Capabilities = filtered
		out = append(out, item)
	}
	return out
}

func (s *ProxyService) PreviewIDEExecutorWriteCapability(workspaceID, executorID string) (IDEExecutorWritePreview, error) {
	if s == nil || s.ideApprovals == nil {
		return IDEExecutorWritePreview{}, fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return IDEExecutorWritePreview{}, err
	}
	executorID = strings.TrimSpace(executorID)
	if executorID == "" {
		return IDEExecutorWritePreview{}, fmt.Errorf("执行器无效")
	}
	receipt, err := s.ideApprovals.Request(context.Background(), approval.Request{
		WorkspaceID: workspaceID,
		Kind:        ideExecutorWriteKind,
		Fingerprint: ideExecutorWriteFingerprint(workspaceID, executorID),
		Summary: approval.Summary{
			Title:       "允许执行器写入工作区",
			Target:      executorID,
			ImpactCodes: []string{ideExecutorWriteKind},
		},
	})
	if err != nil {
		return IDEExecutorWritePreview{}, mapIDEWorkspaceError(err)
	}
	return IDEExecutorWritePreview{
		Approval:   receipt,
		ExecutorID: executorID,
		AuthKind:   executorAuthKind(executorID),
	}, nil
}

func (s *ProxyService) CommitIDEExecutorWriteCapability(workspaceID, approvalID, executorID string) error {
	if s == nil || s.ideApprovals == nil || s.ideExecutorGrants == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return err
	}
	if _, err := s.ideApprovals.Claim(
		context.Background(),
		workspaceID,
		approvalID,
		ideExecutorWriteFingerprint(workspaceID, executorID),
	); err != nil {
		return mapIDEWorkspaceError(err)
	}
	return s.ideExecutorGrants.grant(executorID)
}

func (store *executorGrantStore) snapshot() map[string]bool {
	if store == nil {
		return map[string]bool{}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	raw, err := os.ReadFile(store.path)
	if err != nil {
		return map[string]bool{}
	}
	var grants map[string]bool
	if json.Unmarshal(raw, &grants) != nil || grants == nil {
		return map[string]bool{}
	}
	return grants
}

func (store *executorGrantStore) grant(executorID string) error {
	executorID = strings.TrimSpace(executorID)
	if executorID == "" {
		return fmt.Errorf("执行器无效")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(store.path), 0o700); err != nil {
		return err
	}
	grants := map[string]bool{}
	if raw, err := os.ReadFile(store.path); err == nil {
		_ = json.Unmarshal(raw, &grants)
	}
	if grants == nil {
		grants = map[string]bool{}
	}
	grants[executorID] = true
	raw, err := json.Marshal(grants)
	if err != nil {
		return err
	}
	return os.WriteFile(store.path, raw, 0o600)
}

func executorAuthKind(id string) string {
	normalized := strings.ToLower(strings.TrimSpace(id))
	if strings.Contains(normalized, "byok") {
		return executorAuthBYOK
	}
	return executorAuthCLI
}

func ideExecutorWriteFingerprint(workspaceID, executorID string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{ideExecutorWriteKind, workspaceID, strings.TrimSpace(executorID)}, "\n")))
	return fmt.Sprintf("ide-operation-v1:sha256:%x", sum)
}
