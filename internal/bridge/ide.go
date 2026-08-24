package bridge

import (
	"fmt"

	"cursor/internal/agentcontract"
	"cursor/internal/client"
	"cursor/internal/ide/approval"
	"cursor/internal/ide/gitops"
	"cursor/internal/ide/gitstatus"
	"cursor/internal/ide/knownhosts"
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
type IDEKnownHost = knownhosts.Entry
type IDEKnownHostPreview = client.IDEKnownHostPreview
type IDEGitPreview = client.IDEGitPreview
type IDEGitOperation = gitops.Operation
type IDETerminalProfile = client.IDETerminalProfile
type IDETerminalSession = client.IDETerminalSession
type IDETerminalOutput = client.IDETerminalOutput

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

func (s *ProxyService) ListIDEKnownHosts() ([]IDEKnownHost, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListIDEKnownHosts()
}

func (s *ProxyService) ProbeIDEHostKey(host string, port int) (IDEKnownHost, error) {
	if s == nil || s.core == nil {
		return IDEKnownHost{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ProbeIDEHostKey(host, port)
}

func (s *ProxyService) PreviewIDEKnownHost(workspaceID, host string, port int, publicKey string) (IDEKnownHostPreview, error) {
	if s == nil || s.core == nil {
		return IDEKnownHostPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewIDEKnownHost(workspaceID, host, port, publicKey)
}

func (s *ProxyService) CommitIDEKnownHost(workspaceID, approvalID, host string, port int, publicKey string) (IDEKnownHost, error) {
	if s == nil || s.core == nil {
		return IDEKnownHost{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitIDEKnownHost(workspaceID, approvalID, host, port, publicKey)
}

func (s *ProxyService) PreviewIDEGitOperation(workspaceID string, operation IDEGitOperation) (IDEGitPreview, error) {
	if s == nil || s.core == nil {
		return IDEGitPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewIDEGitOperation(workspaceID, operation)
}

func (s *ProxyService) CommitIDEGitOperation(workspaceID, approvalID string, operation IDEGitOperation) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitIDEGitOperation(workspaceID, approvalID, operation)
}

func (s *ProxyService) ListIDETerminalProfiles() []IDETerminalProfile {
	if s == nil || s.core == nil {
		return nil
	}
	return s.core.ListIDETerminalProfiles()
}

func (s *ProxyService) OpenIDETerminalSession(workspaceID, profileID string, cols, rows int) (IDETerminalSession, error) {
	if s == nil || s.core == nil {
		return IDETerminalSession{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.OpenIDETerminalSession(workspaceID, profileID, cols, rows)
}

func (s *ProxyService) WriteIDETerminalSession(sessionID, data string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.WriteIDETerminalSession(sessionID, data)
}

func (s *ProxyService) ResizeIDETerminalSession(sessionID string, cols, rows int) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ResizeIDETerminalSession(sessionID, cols, rows)
}

func (s *ProxyService) InterruptIDETerminalSession(sessionID string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.InterruptIDETerminalSession(sessionID)
}

func (s *ProxyService) CloseIDETerminalSession(sessionID string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CloseIDETerminalSession(sessionID)
}

func (s *ProxyService) GetIDETerminalOutput(sessionID string) (IDETerminalOutput, error) {
	if s == nil || s.core == nil {
		return IDETerminalOutput{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetIDETerminalOutput(sessionID)
}

type IDEAgentRun = client.IDEAgentRun
type IDEAgentEvent = client.IDEAgentEvent
type IDEAgentEffect = client.IDEAgentEffect
type IDEAgentEffectPreview = client.IDEAgentEffectPreview
type IDEExecutorWritePreview = client.IDEExecutorWritePreview
type AgentContractStartRequest = agentcontract.StartRequest
type AgentContractSession = agentcontract.Session
type AgentContractRun = agentcontract.Run
type AgentContractEvent = agentcontract.Event
type AgentContractClaim = agentcontract.Claim
type AgentContractModel = agentcontract.ModelSummary
type AgentClaimPreview = client.AgentClaimPreview

func (s *ProxyService) StartIDEAgentRun(workspaceID, modelID, prompt string) (IDEAgentRun, error) {
	if s == nil || s.core == nil {
		return IDEAgentRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.StartIDEAgentRun(workspaceID, modelID, prompt)
}

func (s *ProxyService) CancelIDEAgentRun(runID string) (IDEAgentRun, error) {
	if s == nil || s.core == nil {
		return IDEAgentRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CancelIDEAgentRun(runID)
}

func (s *ProxyService) GetIDEAgentRun(runID string) (IDEAgentRun, error) {
	if s == nil || s.core == nil {
		return IDEAgentRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetIDEAgentRun(runID)
}

func (s *ProxyService) ListIDEAgentRuns(workspaceID string) ([]IDEAgentRun, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListIDEAgentRuns(workspaceID)
}

func (s *ProxyService) GetIDEAgentRunEvents(runID string) ([]IDEAgentEvent, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetIDEAgentRunEvents(runID)
}

func (s *ProxyService) ReplayIDEAgentRun(runID string) ([]IDEAgentEvent, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ReplayIDEAgentRun(runID)
}

func (s *ProxyService) PreviewIDEAgentEffect(runID string, effect IDEAgentEffect) (IDEAgentEffectPreview, error) {
	if s == nil || s.core == nil {
		return IDEAgentEffectPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewIDEAgentEffect(runID, effect)
}

func (s *ProxyService) CommitIDEAgentEffect(runID, approvalID string, effect IDEAgentEffect) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitIDEAgentEffect(runID, approvalID, effect)
}

func (s *ProxyService) StartAgentContractRun(request AgentContractStartRequest) (AgentContractRun, error) {
	if s == nil || s.core == nil {
		return AgentContractRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.StartAgentContractRun(request)
}

func (s *ProxyService) ListAgentContractModels() ([]AgentContractModel, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListAgentContractModels()
}

func (s *ProxyService) CancelAgentContractRun(runID string) (AgentContractRun, error) {
	if s == nil || s.core == nil {
		return AgentContractRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CancelAgentContractRun(runID)
}

func (s *ProxyService) GetAgentContractSession(runID string) (AgentContractSession, error) {
	if s == nil || s.core == nil {
		return AgentContractSession{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetAgentContractSession(runID)
}

func (s *ProxyService) GetAgentContractRun(runID string) (AgentContractRun, error) {
	if s == nil || s.core == nil {
		return AgentContractRun{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetAgentContractRun(runID)
}

func (s *ProxyService) ListAgentContractRuns(workspaceID string) ([]AgentContractRun, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ListAgentContractRuns(workspaceID)
}

func (s *ProxyService) GetAgentContractRunEvents(runID string) ([]AgentContractEvent, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.GetAgentContractRunEvents(runID)
}

func (s *ProxyService) ReplayAgentContractRun(runID string) ([]AgentContractEvent, error) {
	if s == nil || s.core == nil {
		return nil, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.ReplayAgentContractRun(runID)
}

func (s *ProxyService) PreviewAgentClaim(runID string, effect IDEAgentEffect) (AgentClaimPreview, error) {
	if s == nil || s.core == nil {
		return AgentClaimPreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewAgentClaim(runID, effect)
}

func (s *ProxyService) CommitAgentClaim(runID, approvalID string, effect IDEAgentEffect) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitAgentClaim(runID, approvalID, effect)
}

func (s *ProxyService) PreviewIDEExecutorWriteCapability(workspaceID, executorID string) (IDEExecutorWritePreview, error) {
	if s == nil || s.core == nil {
		return IDEExecutorWritePreview{}, fmt.Errorf("工作区服务未初始化")
	}
	return s.core.PreviewIDEExecutorWriteCapability(workspaceID, executorID)
}

func (s *ProxyService) CommitIDEExecutorWriteCapability(workspaceID, approvalID, executorID string) error {
	if s == nil || s.core == nil {
		return fmt.Errorf("工作区服务未初始化")
	}
	return s.core.CommitIDEExecutorWriteCapability(workspaceID, approvalID, executorID)
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
