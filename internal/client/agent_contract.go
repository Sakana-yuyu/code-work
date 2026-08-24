package client

import (
	"context"
	"fmt"
	"strings"

	"cursor/internal/agentbridge"
	"cursor/internal/agentcontract"
	"cursor/internal/ide/agentrun"
)

type AgentContractStartRequest = agentcontract.StartRequest
type AgentContractSession = agentcontract.Session
type AgentContractRun = agentcontract.Run
type AgentContractEvent = agentcontract.Event
type AgentContractClaim = agentcontract.Claim
type AgentContractModel = agentcontract.ModelSummary

type AgentClaimPreview = agentbridge.ClaimPreview

func (s *ProxyService) StartAgentContractRun(request agentcontract.StartRequest) (agentcontract.Run, error) {
	if s == nil || s.ideAgent == nil {
		return agentcontract.Run{}, fmt.Errorf("Agent 服务未初始化")
	}
	request = agentcontract.NormalizeStartRequest(request)
	if err := s.requireIDEWorkspace(request.WorkspaceID); err != nil {
		return agentcontract.Run{}, err
	}
	run, err := s.ideAgent.StartRequest(context.Background(), agentrun.StartRequest{
		SessionID:   request.SessionID,
		ParentRunID: request.ParentRunID,
		WorkspaceID: request.WorkspaceID,
		ModelID:     request.ModelID,
		Mode:        string(request.Mode),
		Prompt:      request.Prompt,
	})
	if err != nil {
		return agentcontract.Run{}, mapIDEWorkspaceError(err)
	}
	return agentcontract.RunFromLegacy(run), nil
}

func (s *ProxyService) ListAgentContractModels() ([]agentcontract.ModelSummary, error) {
	if s == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	cfg, err := s.LoadUserConfig()
	if err != nil {
		return nil, err
	}
	models := make([]agentcontract.ModelSummary, 0, len(cfg.ModelAdapters))
	for _, adapter := range cfg.ModelAdapters {
		id := strings.TrimSpace(adapter.ID)
		modelID := strings.TrimSpace(adapter.ModelID)
		if id == "" || modelID == "" {
			continue
		}
		name := strings.TrimSpace(adapter.DisplayName)
		if name == "" {
			name = modelID
		}
		models = append(models, agentcontract.ModelSummary{
			ID:       id,
			Name:     name,
			Provider: strings.TrimSpace(adapter.Type),
			ModelID:  modelID,
		})
	}
	return models, nil
}

func (s *ProxyService) CancelAgentContractRun(runID string) (agentcontract.Run, error) {
	if s == nil || s.ideAgent == nil {
		return agentcontract.Run{}, fmt.Errorf("Agent 服务未初始化")
	}
	run, err := s.CancelIDEAgentRun(runID)
	if err != nil {
		return agentcontract.Run{}, err
	}
	return agentcontract.RunFromLegacy(run), nil
}

func (s *ProxyService) GetAgentContractSession(runID string) (agentcontract.Session, error) {
	if s == nil || s.ideAgent == nil {
		return agentcontract.Session{}, fmt.Errorf("Agent 服务未初始化")
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	if err != nil {
		return agentcontract.Session{}, mapIDEWorkspaceError(err)
	}
	return agentcontract.SessionFromLegacy(run), nil
}

func (s *ProxyService) GetAgentContractRun(runID string) (agentcontract.Run, error) {
	if s == nil || s.ideAgent == nil {
		return agentcontract.Run{}, fmt.Errorf("Agent 服务未初始化")
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	if err != nil {
		return agentcontract.Run{}, mapIDEWorkspaceError(err)
	}
	return agentcontract.RunFromLegacy(run), nil
}

func (s *ProxyService) ListAgentContractRuns(workspaceID string) ([]agentcontract.Run, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return nil, err
	}
	runs, err := s.ideAgent.List(context.Background(), workspaceID)
	if err != nil {
		return nil, mapIDEWorkspaceError(err)
	}
	result := make([]agentcontract.Run, 0, len(runs))
	for _, run := range runs {
		result = append(result, agentcontract.RunFromLegacy(run))
	}
	return result, nil
}

func (s *ProxyService) GetAgentContractRunEvents(runID string) ([]agentcontract.Event, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	events, err := s.ideAgent.Events(context.Background(), runID)
	if err != nil {
		return nil, mapIDEWorkspaceError(err)
	}
	result := make([]agentcontract.Event, 0, len(events))
	for _, event := range events {
		result = append(result, agentcontract.EventFromLegacy(event))
	}
	return result, nil
}

func (s *ProxyService) ReplayAgentContractRun(runID string) ([]agentcontract.Event, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	events, err := s.ideAgent.Replay(context.Background(), runID)
	if err != nil {
		return nil, mapIDEWorkspaceError(err)
	}
	result := make([]agentcontract.Event, 0, len(events))
	for _, event := range events {
		result = append(result, agentcontract.EventFromLegacy(event))
	}
	return result, nil
}

func (s *ProxyService) PreviewAgentClaim(runID string, effect agentrun.Effect) (AgentClaimPreview, error) {
	preview, err := s.PreviewIDEAgentEffect(runID, effect)
	if err != nil {
		return AgentClaimPreview{}, err
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	if err != nil {
		return AgentClaimPreview{}, mapIDEWorkspaceError(err)
	}
	return AgentClaimPreview{
		Claim:    agentcontract.ClaimFromEffect(run, preview.Effect, ideAgentEffectFingerprint(run.ID, preview.Effect)),
		Approval: preview.Approval,
		Effect:   preview.Effect,
	}, nil
}

func (s *ProxyService) CommitAgentClaim(runID, approvalID string, effect agentrun.Effect) error {
	return s.CommitIDEAgentEffect(runID, approvalID, effect)
}
