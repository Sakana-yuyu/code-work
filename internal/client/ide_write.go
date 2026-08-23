package client

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"cursor/internal/ide/approval"
	"cursor/internal/ide/workspace"
)

const ideWriteKind = "workspace_write"

type IDEWritePreview struct {
	Approval        approval.Approval `json:"approval"`
	Path            string            `json:"path"`
	ExpectedVersion string            `json:"expectedVersion"`
	CurrentVersion  string            `json:"currentVersion"`
	Before          string            `json:"before"`
	After           string            `json:"after"`
}

func (s *ProxyService) PreviewIDEWorkspaceWrite(
	workspaceID string,
	relativeFile string,
	text string,
	expectedVersion string,
) (IDEWritePreview, error) {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil {
		return IDEWritePreview{}, fmt.Errorf("工作区服务未初始化")
	}
	current, err := s.ideWorkspaces.ReadText(context.Background(), workspaceID, relativeFile)
	if err != nil {
		return IDEWritePreview{}, mapIDEWorkspaceError(err)
	}
	if current.Binary || current.Truncated {
		return IDEWritePreview{}, mapIDEWorkspaceError(fmt.Errorf("%w: current file", workspace.ErrWriteNotAllowed))
	}
	if current.Version != expectedVersion {
		return IDEWritePreview{}, mapIDEWorkspaceError(fmt.Errorf("%w: expected version", workspace.ErrVersionConflict))
	}
	receipt, err := s.ideApprovals.Request(context.Background(), approval.Request{
		WorkspaceID: workspaceID,
		Kind:        ideWriteKind,
		Fingerprint: ideWriteFingerprint(workspaceID, current.Path, expectedVersion, text),
		Summary: approval.Summary{
			Title:       "保存文件",
			Target:      current.Path,
			ImpactCodes: []string{ideWriteKind},
		},
	})
	if err != nil {
		return IDEWritePreview{}, mapIDEWorkspaceError(err)
	}
	return IDEWritePreview{
		Approval:        receipt,
		Path:            current.Path,
		ExpectedVersion: expectedVersion,
		CurrentVersion:  current.Version,
		Before:          current.Text,
		After:           text,
	}, nil
}

func (s *ProxyService) ApproveIDEApproval(workspaceID, approvalID string) (approval.Approval, error) {
	if s == nil || s.ideApprovals == nil {
		return approval.Approval{}, fmt.Errorf("工作区服务未初始化")
	}
	receipt, err := s.ideApprovals.Approve(context.Background(), workspaceID, approvalID)
	return receipt, mapIDEWorkspaceError(err)
}

func (s *ProxyService) RejectIDEApproval(workspaceID, approvalID string) (approval.Approval, error) {
	if s == nil || s.ideApprovals == nil {
		return approval.Approval{}, fmt.Errorf("工作区服务未初始化")
	}
	receipt, err := s.ideApprovals.Reject(context.Background(), workspaceID, approvalID)
	return receipt, mapIDEWorkspaceError(err)
}

func (s *ProxyService) CancelIDEWorkspaceApprovals(workspaceID string) (int, error) {
	if s == nil || s.ideApprovals == nil {
		return 0, fmt.Errorf("工作区服务未初始化")
	}
	count, err := s.ideApprovals.CancelWorkspace(context.Background(), workspaceID)
	return count, mapIDEWorkspaceError(err)
}

func (s *ProxyService) CommitIDEWorkspaceWrite(
	workspaceID string,
	approvalID string,
	relativeFile string,
	text string,
	expectedVersion string,
) (workspace.TextFile, error) {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil {
		return workspace.TextFile{}, fmt.Errorf("工作区服务未初始化")
	}
	current, err := s.ideWorkspaces.ReadText(context.Background(), workspaceID, relativeFile)
	if err != nil {
		return workspace.TextFile{}, mapIDEWorkspaceError(err)
	}
	if current.Binary || current.Truncated {
		return workspace.TextFile{}, mapIDEWorkspaceError(fmt.Errorf("%w: current file", workspace.ErrWriteNotAllowed))
	}
	if current.Version != expectedVersion {
		return workspace.TextFile{}, mapIDEWorkspaceError(fmt.Errorf("%w: expected version", workspace.ErrVersionConflict))
	}
	if _, err := s.ideApprovals.Claim(
		context.Background(),
		workspaceID,
		approvalID,
		ideWriteFingerprint(workspaceID, current.Path, expectedVersion, text),
	); err != nil {
		return workspace.TextFile{}, mapIDEWorkspaceError(err)
	}
	written, err := s.ideWorkspaces.WriteText(context.Background(), workspaceID, workspace.WriteRequest{
		Path:            current.Path,
		Text:            text,
		ExpectedVersion: expectedVersion,
	})
	return written, mapIDEWorkspaceError(err)
}

func ideWriteFingerprint(workspaceID, path, version, text string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{ideWriteKind, workspaceID, path, version, text}, "\n")))
	return fmt.Sprintf("ide-operation-v1:sha256:%x", sum)
}
