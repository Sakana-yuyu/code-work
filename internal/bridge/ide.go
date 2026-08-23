package bridge

import (
	"fmt"

	"cursor/internal/client"
	"cursor/internal/ide/workspace"
)

type IDEWorkspaceSummary = workspace.Summary
type IDEWorkspaceTreeResult = workspace.TreeResult
type IDEWorkspaceTreeEntry = workspace.TreeEntry
type IDEWorkspaceTextFile = workspace.TextFile
type IDEWorkspaceSearchResult = workspace.SearchResult
type IDEWorkspaceSearchMatch = workspace.SearchMatch

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
