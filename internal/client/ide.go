package client

import (
	"context"
	"errors"
	"fmt"

	"cursor/internal/ide/workspace"
)

var ErrIDEWorkspaceSelectionCanceled = errors.New("workspace selection canceled")

func (s *ProxyService) SetIDEDirectorySelector(selector func() (string, error)) {
	if s == nil {
		return
	}
	s.selectIDEDirectory = selector
}

func (s *ProxyService) SelectAndRegisterIDEWorkspace() (workspace.Summary, error) {
	if s == nil || s.ideWorkspaces == nil {
		return workspace.Summary{}, fmt.Errorf("工作区服务未初始化")
	}
	if s.selectIDEDirectory == nil {
		return workspace.Summary{}, fmt.Errorf("工作区目录选择器不可用")
	}
	directory, err := s.selectIDEDirectory()
	if err != nil {
		return workspace.Summary{}, mapIDEWorkspaceError(err)
	}
	if directory == "" {
		return workspace.Summary{}, mapIDEWorkspaceError(ErrIDEWorkspaceSelectionCanceled)
	}
	summary, err := s.ideWorkspaces.Register(context.Background(), directory)
	return summary, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ListIDEWorkspaces() ([]workspace.Summary, error) {
	if s == nil || s.ideWorkspaces == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	items, err := s.ideWorkspaces.List(context.Background())
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) RemoveIDEWorkspace(workspaceID string) error {
	if s == nil || s.ideWorkspaces == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideWorkspaces.Remove(context.Background(), workspaceID))
}

func (s *ProxyService) GetIDEWorkspaceTree(workspaceID, relativeDirectory string) (workspace.TreeResult, error) {
	if s == nil || s.ideWorkspaces == nil {
		return workspace.TreeResult{}, fmt.Errorf("工作区服务未初始化")
	}
	result, err := s.ideWorkspaces.Tree(context.Background(), workspaceID, relativeDirectory)
	return result, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ReadIDEWorkspaceText(workspaceID, relativeFile string) (workspace.TextFile, error) {
	if s == nil || s.ideWorkspaces == nil {
		return workspace.TextFile{}, fmt.Errorf("工作区服务未初始化")
	}
	file, err := s.ideWorkspaces.ReadText(context.Background(), workspaceID, relativeFile)
	return file, mapIDEWorkspaceError(err)
}

func (s *ProxyService) SearchIDEWorkspace(workspaceID, relativePath, query string) (workspace.SearchResult, error) {
	if s == nil || s.ideWorkspaces == nil {
		return workspace.SearchResult{}, fmt.Errorf("工作区服务未初始化")
	}
	result, err := s.ideWorkspaces.Search(context.Background(), workspaceID, workspace.SearchRequest{Path: relativePath, Query: query})
	return result, mapIDEWorkspaceError(err)
}

func mapIDEWorkspaceError(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrIDEWorkspaceSelectionCanceled):
		return fmt.Errorf("已取消选择工作区: %w", err)
	case errors.Is(err, workspace.ErrWorkspaceNotFound):
		return fmt.Errorf("工作区不存在: %w", err)
	case errors.Is(err, workspace.ErrWorkspaceUnavailable):
		return fmt.Errorf("工作区不可用: %w", err)
	case errors.Is(err, workspace.ErrSensitivePath):
		return fmt.Errorf("敏感路径不可访问: %w", err)
	case errors.Is(err, workspace.ErrInvalidPath):
		return fmt.Errorf("路径不合法: %w", err)
	case errors.Is(err, workspace.ErrSymlinkNotAllowed):
		return fmt.Errorf("符号链接不可访问: %w", err)
	case errors.Is(err, workspace.ErrNotRegularFile):
		return fmt.Errorf("不是普通文件: %w", err)
	case errors.Is(err, workspace.ErrRegistryInvalid):
		return fmt.Errorf("工作区登记失败: %w", err)
	default:
		return err
	}
}
