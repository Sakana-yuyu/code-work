package client

import (
	"context"
	"fmt"

	"cursor/internal/ide/gitstatus"
)

func (s *ProxyService) GetIDEGitSnapshot(workspaceID string) (gitstatus.Snapshot, error) {
	if s == nil || s.ideGit == nil {
		return gitstatus.Snapshot{}, fmt.Errorf("工作区服务未初始化")
	}
	snapshot, err := s.ideGit.Snapshot(context.Background(), workspaceID)
	return snapshot, mapIDEWorkspaceError(err)
}
