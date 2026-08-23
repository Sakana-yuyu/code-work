package client

import (
	"context"
	"crypto/sha256"
	"fmt"
	"strings"

	"cursor/internal/ide/agentrun"
	"cursor/internal/ide/approval"
	"cursor/internal/ide/gitops"
	"cursor/internal/ide/workspace"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const (
	ideAgentEventName = "ide:agent-event"
	ideAgentEffectKind = "agent_effect"
)

type IDEAgentRun = agentrun.Run
type IDEAgentEvent = agentrun.Event
type IDEAgentEffect = agentrun.Effect

type IDEAgentEffectPreview struct {
	Approval approval.Approval `json:"approval"`
	Effect   agentrun.Effect   `json:"effect"`
}

func (s *ProxyService) StartIDEAgentRun(workspaceID, modelID, prompt string) (IDEAgentRun, error) {
	if s == nil || s.ideAgent == nil {
		return IDEAgentRun{}, fmt.Errorf("Agent 服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return IDEAgentRun{}, err
	}
	run, err := s.ideAgent.Start(context.Background(), workspaceID, modelID, prompt)
	return run, mapIDEWorkspaceError(err)
}

func (s *ProxyService) CancelIDEAgentRun(runID string) (IDEAgentRun, error) {
	if s == nil || s.ideAgent == nil {
		return IDEAgentRun{}, fmt.Errorf("Agent 服务未初始化")
	}
	run, err := s.ideAgent.Cancel(context.Background(), runID)
	if err != nil {
		return IDEAgentRun{}, mapIDEWorkspaceError(err)
	}
	if s.ideApprovals != nil {
		_, _ = s.ideApprovals.CancelRun(context.Background(), run.WorkspaceID, run.ID)
	}
	return run, nil
}

func (s *ProxyService) GetIDEAgentRun(runID string) (IDEAgentRun, error) {
	if s == nil || s.ideAgent == nil {
		return IDEAgentRun{}, fmt.Errorf("Agent 服务未初始化")
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	return run, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ListIDEAgentRuns(workspaceID string) ([]IDEAgentRun, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	if err := s.requireIDEWorkspace(workspaceID); err != nil {
		return nil, err
	}
	items, err := s.ideAgent.List(context.Background(), workspaceID)
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) GetIDEAgentRunEvents(runID string) ([]IDEAgentEvent, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	items, err := s.ideAgent.Events(context.Background(), runID)
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) ReplayIDEAgentRun(runID string) ([]IDEAgentEvent, error) {
	if s == nil || s.ideAgent == nil {
		return nil, fmt.Errorf("Agent 服务未初始化")
	}
	items, err := s.ideAgent.Replay(context.Background(), runID)
	return items, mapIDEWorkspaceError(err)
}

func (s *ProxyService) PreviewIDEAgentEffect(runID string, effect IDEAgentEffect) (IDEAgentEffectPreview, error) {
	if s == nil || s.ideAgent == nil || s.ideApprovals == nil {
		return IDEAgentEffectPreview{}, fmt.Errorf("Agent 服务未初始化")
	}
	proposed, err := s.ideAgent.ProposeEffect(context.Background(), runID, effect)
	if err != nil {
		return IDEAgentEffectPreview{}, mapIDEWorkspaceError(err)
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	if err != nil {
		return IDEAgentEffectPreview{}, mapIDEWorkspaceError(err)
	}
	receipt, err := s.ideApprovals.Request(context.Background(), approval.Request{
		WorkspaceID: run.WorkspaceID,
		RunID:       run.ID,
		Kind:        ideAgentEffectKind,
		Fingerprint: ideAgentEffectFingerprint(run.ID, proposed),
		Summary: approval.Summary{
			Title:       proposed.Summary,
			Target:      agentEffectTarget(proposed),
			ImpactCodes: []string{proposed.Kind},
		},
	})
	if err != nil {
		return IDEAgentEffectPreview{}, mapIDEWorkspaceError(err)
	}
	return IDEAgentEffectPreview{Approval: receipt, Effect: proposed}, nil
}

func (s *ProxyService) CommitIDEAgentEffect(runID, approvalID string, effect IDEAgentEffect) error {
	if s == nil || s.ideAgent == nil || s.ideApprovals == nil {
		return fmt.Errorf("Agent 服务未初始化")
	}
	stored, err := s.ideAgent.Effect(context.Background(), runID, effect.ID)
	if err != nil {
		return mapIDEWorkspaceError(err)
	}
	run, err := s.ideAgent.Get(context.Background(), runID)
	if err != nil {
		return mapIDEWorkspaceError(err)
	}
	if _, err := s.ideApprovals.Claim(
		context.Background(),
		run.WorkspaceID,
		approvalID,
		ideAgentEffectFingerprint(run.ID, stored),
	); err != nil {
		return mapIDEWorkspaceError(err)
	}
	if err := s.executeIDEAgentEffect(run, stored); err != nil {
		return err
	}
	return mapIDEWorkspaceError(s.ideAgent.MarkEffectCommitted(context.Background(), run.ID, stored.ID))
}

func (s *ProxyService) executeIDEAgentEffect(run agentrun.Run, effect agentrun.Effect) error {
	switch effect.Kind {
	case agentrun.EffectWrite:
		if s.ideWorkspaces == nil {
			return fmt.Errorf("工作区服务未初始化")
		}
		_, err := s.ideWorkspaces.WriteText(context.Background(), run.WorkspaceID, workspace.WriteRequest{
			Path:            effect.Path,
			Text:            effect.Text,
			ExpectedVersion: effect.ExpectedVersion,
		})
		return mapIDEWorkspaceError(err)
	case agentrun.EffectGit:
		if s.ideGitOps == nil {
			return fmt.Errorf("Git 服务未初始化")
		}
		return mapIDEWorkspaceError(s.ideGitOps.Execute(context.Background(), run.WorkspaceID, gitops.Operation{
			Kind:      effect.GitKind,
			RemoteURL: effect.RemoteURL,
			Remote:    effect.Remote,
			Directory: effect.Directory,
			Paths:     append([]string(nil), effect.Paths...),
			Message:   effect.Message,
			StageAll:  effect.StageAll,
		}))
	case agentrun.EffectShell:
		if s.ideTerminal == nil {
			return fmt.Errorf("终端服务未初始化")
		}
		return mapIDEWorkspaceError(s.ideTerminal.Write(context.Background(), effect.SessionID, effect.Text))
	case agentrun.EffectMCP:
		return nil
	default:
		return mapIDEWorkspaceError(agentrun.ErrEffectInvalid)
	}
}

func ideAgentEffectFingerprint(runID string, effect agentrun.Effect) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		ideAgentEffectKind,
		runID,
		effect.ID,
		effect.Kind,
		effect.Path,
		effect.Text,
		effect.ExpectedVersion,
		effect.SessionID,
		effect.Server,
		effect.GitKind,
		effect.RemoteURL,
		effect.Remote,
		effect.Directory,
		strings.Join(effect.Paths, ","),
		effect.Message,
		fmt.Sprintf("%t", effect.StageAll),
	}, "\n")))
	return fmt.Sprintf("ide-operation-v1:sha256:%x", sum)
}

func agentEffectTarget(effect agentrun.Effect) string {
	switch effect.Kind {
	case agentrun.EffectWrite:
		return effect.Path
	case agentrun.EffectGit:
		return effect.GitKind
	case agentrun.EffectShell:
		return effect.SessionID
	case agentrun.EffectMCP:
		return effect.Server
	default:
		return effect.Kind
	}
}

func emitIDEAgentEvent(event agentrun.Event) {
	app := application.Get()
	if app == nil {
		return
	}
	app.Event.Emit(ideAgentEventName, event)
}
