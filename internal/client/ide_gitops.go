package client

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"cursor/internal/ide/approval"
	"cursor/internal/ide/gitops"
)

type IDEGitPreview struct {
	Approval  approval.Approval `json:"approval"`
	Operation gitops.Prepared   `json:"operation"`
}

func (s *ProxyService) PreviewIDEGitOperation(workspaceID string, operation gitops.Operation) (IDEGitPreview, error) {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil || s.ideGitOps == nil {
		return IDEGitPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return IDEGitPreview{}, err
	}
	prepared, err := s.ideGitOps.Prepare(operation)
	if err != nil {
		return IDEGitPreview{}, mapIDEWorkspaceError(err)
	}
	receipt, err := s.ideApprovals.Request(context.Background(), approval.Request{
		WorkspaceID: workspaceID,
		Kind:        prepared.Kind,
		Fingerprint: ideGitFingerprint(workspaceID, prepared),
		Summary: approval.Summary{
			Title:       gitOperationTitle(prepared.Kind),
			Target:      gitOperationTarget(prepared),
			ImpactCodes: []string{prepared.Kind},
		},
	})
	if err != nil {
		return IDEGitPreview{}, mapIDEWorkspaceError(err)
	}
	return IDEGitPreview{Approval: receipt, Operation: prepared}, nil
}

func (s *ProxyService) CommitIDEGitOperation(workspaceID, approvalID string, operation gitops.Operation) error {
	if s == nil || s.ideWorkspaces == nil || s.ideApprovals == nil || s.ideGitOps == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return err
	}
	prepared, err := s.ideGitOps.Prepare(operation)
	if err != nil {
		return mapIDEWorkspaceError(err)
	}
	if _, err := s.ideApprovals.Claim(
		context.Background(),
		workspaceID,
		approvalID,
		ideGitFingerprint(workspaceID, prepared),
	); err != nil {
		return mapIDEWorkspaceError(err)
	}
	return mapIDEWorkspaceError(s.ideGitOps.Execute(context.Background(), workspaceID, operation))
}

func gitOperationTitle(kind string) string {
	switch kind {
	case gitops.KindClone:
		return "克隆仓库"
	case gitops.KindStage:
		return "暂存文件"
	case gitops.KindCommit:
		return "创建提交"
	case gitops.KindFetch:
		return "获取远程"
	case gitops.KindPull:
		return "拉取远程"
	case gitops.KindPush:
		return "推送到远程"
	default:
		return "Git 操作"
	}
}

func gitOperationTarget(prepared gitops.Prepared) string {
	switch prepared.Kind {
	case gitops.KindClone:
		return prepared.Directory
	case gitops.KindStage:
		if prepared.StageAll {
			return "."
		}
		if len(prepared.Paths) > 0 {
			return prepared.Paths[0]
		}
	case gitops.KindFetch, gitops.KindPull, gitops.KindPush:
		return prepared.Remote
	}
	return ""
}

func ideGitFingerprint(workspaceID string, prepared gitops.Prepared) string {
	parts := []string{
		prepared.Kind,
		workspaceID,
		prepared.RemoteURL,
		prepared.Remote,
		prepared.Directory,
		prepared.Message,
		strings.Join(prepared.Paths, "\n"),
	}
	if prepared.StageAll {
		parts = append(parts, "stage-all")
	}
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return fmt.Sprintf("ide-operation-v1:sha256:%x", sum)
}
