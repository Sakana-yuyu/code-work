package client

import (
	"context"
	"fmt"

	"cursor/internal/ide/sshvault"
)

func (s *ProxyService) ListIDESSHKeys() ([]sshvault.KeySummary, error) {
	if s == nil || s.ideSSH == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	items, err := s.ideSSH.List(context.Background())
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ImportIDESSHKey(name, privateKey, passphrase string) (sshvault.KeySummary, error) {
	if s == nil || s.ideSSH == nil {
		return sshvault.KeySummary{}, fmt.Errorf("工作区服务未初始化")
	}
	summary, err := s.ideSSH.Import(context.Background(), sshvault.ImportRequest{
		Name:       name,
		PrivateKey: privateKey,
		Passphrase: passphrase,
	})
	return summary, mapIDEWorkspaceError(err)
}

func (s *ProxyService) GenerateIDESSHKey(name string) (sshvault.KeySummary, error) {
	if s == nil || s.ideSSH == nil {
		return sshvault.KeySummary{}, fmt.Errorf("工作区服务未初始化")
	}
	summary, err := s.ideSSH.Generate(context.Background(), name)
	return summary, mapIDEWorkspaceError(err)
}

func (s *ProxyService) RemoveIDESSHKey(keyID string) error {
	if s == nil || s.ideSSH == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return mapIDEWorkspaceError(s.ideSSH.Remove(context.Background(), keyID))
}
