package agentcontract

import (
	"encoding/json"
	"reflect"
	"testing"

	"cursor/internal/ide/agentrun"
)

func TestRunFromLegacyPreservesIdentityAndAddsContractMetadata(t *testing.T) {
	run := agentrun.Run{
		ID:          "run_123",
		SessionID:   "session_123",
		ParentRunID: "run_parent",
		WorkspaceID: "workspace_1",
		ModelID:     "model_1",
		Prompt:      "检查当前文件",
		Mode:        agentrun.ModePlan,
		Status:      agentrun.StatusRunning,
	}

	got := RunFromLegacy(run)
	if got.ContractVersion != ContractVersion {
		t.Fatalf("contract version = %q, want %q", got.ContractVersion, ContractVersion)
	}
	if got.ID != run.ID || got.SessionID != run.SessionID || got.ParentRunID != run.ParentRunID {
		t.Fatalf("identity not preserved: %+v", got)
	}
	if got.Mode != ModePlan || got.Status != StatusRunning {
		t.Fatalf("run metadata = %+v", got)
	}
}

func TestEventFromLegacyPreservesSequenceAndReplaySafety(t *testing.T) {
	event := agentrun.Event{
		RunID:       "run_123",
		SessionID:   "session_123",
		ParentRunID: "run_parent",
		Seq:         7,
		Kind:        agentrun.KindDelta,
		Text:        "已完成检查",
		ReplaySafe:  true,
		Mode:        agentrun.ModeReview,
	}

	got := EventFromLegacy(event)
	if got.ContractVersion != ContractVersion {
		t.Fatalf("contract version = %q, want %q", got.ContractVersion, ContractVersion)
	}
	if got.Sequence != 7 || got.RunID != event.RunID || got.SessionID != event.SessionID {
		t.Fatalf("event identity = %+v", got)
	}
	if !got.ReplaySafe || got.Mode != ModeReview || got.Text != event.Text {
		t.Fatalf("event metadata = %+v", got)
	}
}

func TestClaimFromEffectIsStableAndDoesNotExposeHostPath(t *testing.T) {
	run := agentrun.Run{ID: "run_123", SessionID: "session_123", WorkspaceID: "workspace_1", Mode: agentrun.ModeChat}
	effect := agentrun.Effect{
		ID:              "effect_123",
		Kind:            agentrun.EffectWrite,
		Path:            "src/main.go",
		Text:            "package main\n",
		ExpectedVersion: "version_1",
		Summary:         "写入 src/main.go",
	}

	first := ClaimFromEffect(run, effect, "claim-fingerprint-1")
	second := ClaimFromEffect(run, effect, "claim-fingerprint-1")
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("claim mapping is not deterministic: first=%+v second=%+v", first, second)
	}
	if first.ContractVersion != ContractVersion || first.ID != effect.ID || first.Fingerprint == "" {
		t.Fatalf("claim metadata = %+v", first)
	}
	if first.Kind != ClaimWorkspaceWrite || first.Status != StatusProposed || first.Target != effect.Path {
		t.Fatalf("claim fields = %+v", first)
	}
	raw, err := json.Marshal(first)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	if string(raw) == "" || string(raw) == "null" {
		t.Fatalf("claim JSON = %s", raw)
	}
}

func TestStartRequestNormalizesMode(t *testing.T) {
	request := NormalizeStartRequest(StartRequest{WorkspaceID: "workspace_1", ModelID: "model_1", Prompt: "检查"})
	if request.Mode != ModeChat {
		t.Fatalf("mode = %q, want %q", request.Mode, ModeChat)
	}
}
