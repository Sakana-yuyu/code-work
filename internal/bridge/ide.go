package bridge

import (
	"fmt"

	"cursor/internal/client"
	"cursor/internal/ide/approval"
	"cursor/internal/ide/gitstatus"
	"cursor/internal/ide/sshvault"
	"cursor/internal/ide/workspace"
)

type IDEWorkspaceSummary = workspace.Summary
type IDEWorkspaceTreeResult = workspace.TreeResult
type IDEWorkspaceTreeEntry = workspace.TreeEntry
type IDEWorkspaceTextFile = workspace.TextFile
type IDEWorkspaceSearchResult = workspace.SearchResult
type IDEWorkspaceSearchMatch = workspace.SearchMatch
type IDEWritePreview = client.IDEWritePreview
type IDEApproval = approval.Approval
type IDEGitSnapshot = gitstatus.Snapshot
type IDEGitChange = gitstatus.FileChange
type IDEGitRemote = gitstatus.Remote
type IDESSHKeySummary = sshvault.KeySummary

func (s *ProxyService) SelectAndRegisterIDEWorkspace() (IDEWorkspaceSummary, error) {
	if s == nil || s.core == nil {
		return IDEWorkspaceSummary{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.SelectAndRegisterIDEWorkspace()
}

func (s *ProxyService) ListIDEWorkspaces() ([]IDEWorkspaceSummary, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListIDEWorkspaces()
}

func (s *ProxyService) RemoveIDEWorkspace(workspaceID string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.RemoveIDEWorkspace(workspaceID)
}

func (s *ProxyService) GetIDEWorkspaceTree(workspaceID, relativeDirectory string) (IDEWorkspaceTreeResult, error) {
	if s == nil || s.core == nil {
		return IDEWorkspaceTreeResult{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetIDEWorkspaceTree(workspaceID, relativeDirectory)
}

func (s *ProxyService) ReadIDEWorkspaceText(workspaceID, relativeFile string) (IDEWorkspaceTextFile, error) {
	if s == nil || s.core == nil {
		return IDEWorkspaceTextFile{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ReadIDEWorkspaceText(workspaceID, relativeFile)
}

func (s *ProxyService) SearchIDEWorkspace(workspaceID, relativePath, query string) (IDEWorkspaceSearchResult, error) {
	if s == nil || s.core == nil {
		return IDEWorkspaceSearchResult{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.SearchIDEWorkspace(workspaceID, relativePath, query)
}

func (s *ProxyService) PreviewIDEWorkspaceWrite(workspaceID, relativeFile, text, expectedVersion string) (IDEWritePreview, error) {
	if s == nil || s.core == nil {
		return IDEWritePreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewIDEWorkspaceWrite(workspaceID, relativeFile, text, expectedVersion)
}

func (s *ProxyService) ApproveIDEApproval(workspaceID, approvalID string) (IDEApproval, error) {
	if s == nil || s.core == nil {
		return IDEApproval{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ApproveIDEApproval(workspaceID, approvalID)
}

func (s *ProxyService) RejectIDEApproval(workspaceID, approvalID string) (IDEApproval, error) {
	if s == nil || s.core == nil {
		return IDEApproval{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.RejectIDEApproval(workspaceID, approvalID)
}

func (s *ProxyService) CancelIDEWorkspaceApprovals(workspaceID string) (int, error) {
	if s == nil || s.core == nil {
		return 0, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CancelIDEWorkspaceApprovals(workspaceID)
}

func (s *ProxyService) CommitIDEWorkspaceWrite(workspaceID, approvalID, relativeFile, text, expectedVersion string) (IDEWorkspaceTextFile, error) {
	if s == nil || s.core == nil {
		return IDEWorkspaceTextFile{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitIDEWorkspaceWrite(workspaceID, approvalID, relativeFile, text, expectedVersion)
}

func (s *ProxyService) GetIDEGitSnapshot(workspaceID string) (IDEGitSnapshot, error) {
	if s == nil || s.core == nil {
		return IDEGitSnapshot{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetIDEGitSnapshot(workspaceID)
}

func (s *ProxyService) ListIDESSHKeys() ([]IDESSHKeySummary, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListIDESSHKeys()
}

func (s *ProxyService) ImportIDESSHKey(name, privateKey, passphrase string) (IDESSHKeySummary, error) {
	if s == nil || s.core == nil {
		return IDESSHKeySummary{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ImportIDESSHKey(name, privateKey, passphrase)
}

func (s *ProxyService) GenerateIDESSHKey(name string) (IDESSHKeySummary, error) {
	if s == nil || s.core == nil {
		return IDESSHKeySummary{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GenerateIDESSHKey(name)
}

func (s *ProxyService) RemoveIDESSHKey(keyID string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.RemoveIDESSHKey(keyID)
}

func (s *WindowService) selectWorkspaceDirectory() (string, error) {
	if s == nil {
		return "", client.ErrIDEWorkspaceSelectionCanceled
	}
	s.mu.RLock()
	app := s.app
	window := s.mainWindow
	s.mu.RUnlock()
	if app == nil {
		return "", fmt.Errorf("workspace directory selector is unavailable")
	}
	dialog := app.Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		SetTitle("选择工作区")
	if window != nil {
		dialog = dialog.AttachToWindow(window)
	}
	path, err := dialog.PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", client.ErrIDEWorkspaceSelectionCanceled
	}
	return path, nil
}
