package client

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strconv"
	"strings"

	"cursor/internal/ide/approval"
	"cursor/internal/ide/knownhosts"
	"cursor/internal/ide/workspace"
)

const (
	ideKnownHostKind      = "ssh_known_host"
	ideHostKeyChangedKind = "ssh_host_key_changed"
)

type IDEKnownHostPreview struct {
	Approval         approval.Approval `json:"approval"`
	Status           string            `json:"status"`
	Host             string            `json:"host"`
	Port             int               `json:"port"`
	Algorithm        string            `json:"algorithm"`
	Fingerprint      string            `json:"fingerprint"`
	PublicKey        string            `json:"publicKey"`
	KnownFingerprint string            `json:"knownFingerprint,omitempty"`
}

func (s *ProxyService) ListIDEKnownHosts() ([]knownhosts.Entry, error) {
	if s == nil || s.ideKnownHosts == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	items, err := s.ideKnownHosts.List(context.Background())
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ProbeIDEHostKey(host string, port int) (knownhosts.Entry, error) {
	if s == nil || s.ideKnownHosts == nil {
		return knownhosts.Entry{}, fmt.Errorf("工作区服务未初始化")
	}
	entry, err := s.ideKnownHosts.Probe(context.Background(), host, port)
	return entry, mapIDEWorkspaceError(err)
}

func (s *ProxyService) PreviewIDEKnownHost(workspaceID, host string, port int, publicKey string) (IDEKnownHostPreview, error) {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil || s.ideKnownHosts == nil {
		return IDEKnownHostPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return IDEKnownHostPreview{}, err
	}
	result, err := s.ideKnownHosts.Lookup(context.Background(), host, port, publicKey)
	if err != nil {
		return IDEKnownHostPreview{}, mapIDEWorkspaceError(err)
	}
	preview := previewFromLookup(result)
	if result.Status == knownhosts.StatusMatched {
		return preview, nil
	}
	kind := ideKnownHostKind
	title := "信任 SSH 主机"
	if result.Status == knownhosts.StatusMismatch {
		kind = ideHostKeyChangedKind
		title = "主机密钥已变更"
	}
	receipt, err := s.ideApprovals.Request(context.Background(), approval.Request{
		WorkspaceID: workspaceID,
		Kind:        kind,
		Fingerprint: ideKnownHostFingerprint(kind, workspaceID, result.Presented),
		Summary: approval.Summary{
			Title:       title,
			ImpactCodes: []string{kind},
		},
	})
	if err != nil {
		return IDEKnownHostPreview{}, mapIDEWorkspaceError(err)
	}
	preview.Approval = receipt
	return preview, nil
}

func (s *ProxyService) CommitIDEKnownHost(workspaceID, approvalID, host string, port int, publicKey string) (knownhosts.Entry, error) {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil || s.ideKnownHosts == nil {
		return knownhosts.Entry{}, fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return knownhosts.Entry{}, err
	}
	result, err := s.ideKnownHosts.Lookup(context.Background(), host, port, publicKey)
	if err != nil {
		return knownhosts.Entry{}, mapIDEWorkspaceError(err)
	}
	switch result.Status {
	case knownhosts.StatusMatched:
		return result.Presented, nil
	case knownhosts.StatusUnknown:
		if _, err := s.ideApprovals.Claim(
			context.Background(),
			workspaceID,
			approvalID,
			ideKnownHostFingerprint(ideKnownHostKind, workspaceID, result.Presented),
		); err != nil {
			return knownhosts.Entry{}, mapIDEWorkspaceError(err)
		}
		if err := s.ideKnownHosts.Append(context.Background(), result.Presented); err != nil {
			return knownhosts.Entry{}, mapIDEWorkspaceError(err)
		}
	case knownhosts.StatusMismatch:
		if _, err := s.ideApprovals.Claim(
			context.Background(),
			workspaceID,
			approvalID,
			ideKnownHostFingerprint(ideHostKeyChangedKind, workspaceID, result.Presented),
		); err != nil {
			return knownhosts.Entry{}, mapIDEWorkspaceError(err)
		}
		if err := s.ideKnownHosts.Replace(context.Background(), result.Presented); err != nil {
			return knownhosts.Entry{}, mapIDEWorkspaceError(err)
		}
	default:
		return knownhosts.Entry{}, mapIDEWorkspaceError(fmt.Errorf("%w: lookup status", knownhosts.ErrStoreInvalid))
	}
	return result.Presented, nil
}

func (s *ProxyService) requireIDEWorkspace(workspaceID string) error {
	items, err := s.ideWorkspaces.List(context.Background())
	if err != nil {
		return mapIDEWorkspaceError(err)
	}
	for _, item := range items {
		if item.ID == workspaceID {
			return nil
		}
	}
	return mapIDEWorkspaceError(fmt.Errorf("%w: workspace ID", workspace.ErrWorkspaceNotFound))
}

func previewFromLookup(result knownhosts.LookupResult) IDEKnownHostPreview {
	preview := IDEKnownHostPreview{
		Status:      result.Status,
		Host:        result.Presented.Host,
		Port:        result.Presented.Port,
		Algorithm:   result.Presented.Algorithm,
		Fingerprint: result.Presented.Fingerprint,
		PublicKey:   result.Presented.PublicKey,
	}
	if result.Known != nil {
		preview.KnownFingerprint = result.Known.Fingerprint
	}
	return preview
}

func ideKnownHostFingerprint(kind, workspaceID string, entry knownhosts.Entry) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		kind,
		workspaceID,
		entry.Host,
		strconv.Itoa(entry.Port),
		entry.Algorithm,
		entry.PublicKey,
	}, "\n")))
	return fmt.Sprintf("ide-operation-v1:sha256:%x", sum)
}
