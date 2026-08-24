// Package agentcontract 定义 VS Code Agent 扩展与本地 Agent Runtime 之间的稳定数据边界。
package agentcontract

import (
	"strings"

	"cursor/internal/ide/agentrun"
)

const ContractVersion = "agent.contract.v1"

type Mode string

const (
	ModeChat   Mode = agentrun.ModeChat
	ModeAsk    Mode = agentrun.ModeAsk
	ModePlan   Mode = agentrun.ModePlan
	ModeReview Mode = agentrun.ModeReview
)

type Status string

const (
	StatusRunning   Status = agentrun.StatusRunning
	StatusCompleted Status = agentrun.StatusCompleted
	StatusFailed    Status = agentrun.StatusFailed
	StatusCanceled  Status = agentrun.StatusCanceled
	StatusProposed  Status = "proposed"
	StatusCommitted Status = "committed"
)

type EventKind string

const (
	EventStarted        EventKind = agentrun.KindStarted
	EventDelta          EventKind = agentrun.KindDelta
	EventFinished       EventKind = agentrun.KindFinished
	EventCanceled       EventKind = agentrun.KindCanceled
	EventError          EventKind = agentrun.KindError
	EventClaimProposed  EventKind = agentrun.KindEffectProposed
	EventClaimCommitted EventKind = agentrun.KindEffectCommitted
)

type ClaimKind string

const (
	ClaimWorkspaceWrite ClaimKind = agentrun.EffectWrite
	ClaimGit            ClaimKind = agentrun.EffectGit
	ClaimShell          ClaimKind = agentrun.EffectShell
	ClaimMCP            ClaimKind = agentrun.EffectMCP
)

type StartRequest struct {
	SessionID   string `json:"sessionId,omitempty"`
	ParentRunID string `json:"parentRunId,omitempty"`
	WorkspaceID string `json:"workspaceId"`
	ModelID     string `json:"modelId"`
	Mode        Mode   `json:"mode,omitempty"`
	Prompt      string `json:"prompt"`
}

// ModelSummary 是供 Agent 客户端选择 Runtime 通道的非敏感摘要。
// 不允许包含 API Key、完整请求地址或其它凭据字段。
type ModelSummary struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Provider string `json:"provider"`
	ModelID  string `json:"modelId"`
}

type Session struct {
	ContractVersion string `json:"contractVersion"`
	ID              string `json:"id"`
	WorkspaceID     string `json:"workspaceId"`
	Mode            Mode   `json:"mode"`
	CreatedAtMS     int64  `json:"createdAtUnixMs,omitempty"`
	UpdatedAtMS     int64  `json:"updatedAtUnixMs,omitempty"`
}

type Run struct {
	ContractVersion string `json:"contractVersion"`
	ID              string `json:"id"`
	SessionID       string `json:"sessionId"`
	ParentRunID     string `json:"parentRunId,omitempty"`
	WorkspaceID     string `json:"workspaceId"`
	ModelID         string `json:"modelId"`
	Mode            Mode   `json:"mode"`
	Prompt          string `json:"prompt"`
	Status          Status `json:"status"`
	Error           string `json:"error,omitempty"`
	CreatedAtMS     int64  `json:"createdAtUnixMs"`
	UpdatedAtMS     int64  `json:"updatedAtUnixMs"`
}

type Event struct {
	ContractVersion string    `json:"contractVersion"`
	RunID           string    `json:"runId"`
	SessionID       string    `json:"sessionId"`
	ParentRunID     string    `json:"parentRunId,omitempty"`
	Sequence        int64     `json:"sequence"`
	Kind            EventKind `json:"kind"`
	Mode            Mode      `json:"mode"`
	ToolName        string    `json:"toolName,omitempty"`
	ClaimID         string    `json:"claimId,omitempty"`
	Text            string    `json:"text,omitempty"`
	ReplaySafe      bool      `json:"replaySafe"`
	AtUnixMS        int64     `json:"atUnixMs"`
}

type Claim struct {
	ContractVersion string    `json:"contractVersion"`
	ID              string    `json:"id"`
	SessionID       string    `json:"sessionId"`
	RunID           string    `json:"runId"`
	WorkspaceID     string    `json:"workspaceId"`
	Kind            ClaimKind `json:"kind"`
	Status          Status    `json:"status"`
	Fingerprint     string    `json:"fingerprint"`
	Summary         string    `json:"summary"`
	Target          string    `json:"target"`
	ImpactCodes     []string  `json:"impactCodes,omitempty"`
}

func NormalizeStartRequest(request StartRequest) StartRequest {
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.ParentRunID = strings.TrimSpace(request.ParentRunID)
	request.WorkspaceID = strings.TrimSpace(request.WorkspaceID)
	request.ModelID = strings.TrimSpace(request.ModelID)
	request.Prompt = strings.TrimSpace(request.Prompt)
	request.Mode = Mode(normalizeMode(string(request.Mode)))
	return request
}

func RunFromLegacy(run agentrun.Run) Run {
	run = normalizeLegacyRun(run)
	return Run{
		ContractVersion: ContractVersion,
		ID:              run.ID,
		SessionID:       run.SessionID,
		ParentRunID:     run.ParentRunID,
		WorkspaceID:     run.WorkspaceID,
		ModelID:         run.ModelID,
		Mode:            Mode(run.Mode),
		Prompt:          run.Prompt,
		Status:          Status(run.Status),
		Error:           run.Error,
		CreatedAtMS:     run.CreatedAtMS,
		UpdatedAtMS:     run.UpdatedAtMS,
	}
}

func SessionFromLegacy(run agentrun.Run) Session {
	run = normalizeLegacyRun(run)
	return Session{
		ContractVersion: ContractVersion,
		ID:              run.SessionID,
		WorkspaceID:     run.WorkspaceID,
		Mode:            Mode(run.Mode),
		CreatedAtMS:     run.CreatedAtMS,
		UpdatedAtMS:     run.UpdatedAtMS,
	}
}

func EventFromLegacy(event agentrun.Event) Event {
	return Event{
		ContractVersion: ContractVersion,
		RunID:           event.RunID,
		SessionID:       event.SessionID,
		ParentRunID:     event.ParentRunID,
		Sequence:        event.Seq,
		Kind:            EventKind(event.Kind),
		Mode:            Mode(normalizeMode(event.Mode)),
		ToolName:        event.ToolName,
		ClaimID:         event.ClaimID,
		Text:            event.Text,
		ReplaySafe:      event.ReplaySafe,
		AtUnixMS:        event.AtUnixMS,
	}
}

func ClaimFromEffect(run agentrun.Run, effect agentrun.Effect, fingerprint string) Claim {
	run = normalizeLegacyRun(run)
	return Claim{
		ContractVersion: ContractVersion,
		ID:              effect.ID,
		SessionID:       run.SessionID,
		RunID:           run.ID,
		WorkspaceID:     run.WorkspaceID,
		Kind:            ClaimKind(effect.Kind),
		Status:          StatusProposed,
		Fingerprint:     strings.TrimSpace(fingerprint),
		Summary:         effect.Summary,
		Target:          effectTarget(effect),
		ImpactCodes:     []string{effect.Kind},
	}
}

func normalizeLegacyRun(run agentrun.Run) agentrun.Run {
	if strings.TrimSpace(run.SessionID) == "" {
		run.SessionID = "session_" + strings.TrimSpace(run.ID)
	}
	run.Mode = normalizeMode(run.Mode)
	return run
}

func normalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case agentrun.ModeAsk, agentrun.ModePlan, agentrun.ModeReview:
		return strings.ToLower(strings.TrimSpace(mode))
	default:
		return agentrun.ModeChat
	}
}

func effectTarget(effect agentrun.Effect) string {
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
