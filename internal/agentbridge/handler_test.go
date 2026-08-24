package agentbridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cursor/internal/agentcontract"
	"cursor/internal/backend/server"
	"cursor/internal/ide/agentrun"
	"cursor/internal/ide/approval"
	"cursor/internal/ide/workspace"
)

type fakeService struct {
	run          agentcontract.Run
	runs         []agentcontract.Run
	workspaces   []workspace.Summary
	models       []agentcontract.ModelSummary
	events       []agentcontract.Event
	preview      ClaimPreview
	previewCalls int
	commitCalls  int
	cancelCalls  int
}

func (f *fakeService) StartAgentContractRun(agentcontract.StartRequest) (agentcontract.Run, error) {
	return f.run, nil
}

func (f *fakeService) GetAgentContractRun(string) (agentcontract.Run, error) {
	return f.run, nil
}

func (f *fakeService) ListAgentContractRuns(string) ([]agentcontract.Run, error) {
	return f.runs, nil
}

func (f *fakeService) ListIDEWorkspaces() ([]workspace.Summary, error) {
	return f.workspaces, nil
}

func (f *fakeService) ListAgentContractModels() ([]agentcontract.ModelSummary, error) {
	return f.models, nil
}

func (f *fakeService) GetAgentContractRunEvents(string) ([]agentcontract.Event, error) {
	return f.events, nil
}

func (f *fakeService) ReplayAgentContractRun(string) ([]agentcontract.Event, error) {
	return f.events, nil
}

func (f *fakeService) CancelAgentContractRun(string) (agentcontract.Run, error) {
	f.cancelCalls++
	return f.run, nil
}

func (f *fakeService) PreviewAgentClaim(_ string, effect agentrun.Effect) (ClaimPreview, error) {
	f.previewCalls++
	f.preview.Effect = effect
	return f.preview, nil
}

func (f *fakeService) CommitAgentClaim(string, string, agentrun.Effect) error {
	f.commitCalls++
	return nil
}

func TestHandlerExposesContractRunLifecycle(t *testing.T) {
	fake := &fakeService{
		run: agentcontract.Run{
			ContractVersion: agentcontract.ContractVersion,
			ID:              "run_1",
			SessionID:       "session_1",
			WorkspaceID:     "workspace_1",
			ModelID:         "model_1",
			Mode:            agentcontract.ModePlan,
			Prompt:          "检查当前文件",
			Status:          agentcontract.StatusRunning,
		},
		runs:       []agentcontract.Run{{ContractVersion: agentcontract.ContractVersion, ID: "run_1", SessionID: "session_1", WorkspaceID: "workspace_1"}},
		workspaces: []workspace.Summary{{ID: "workspace_1", Name: "demo", RegisteredAt: time.Unix(0, 0).UTC()}},
		models:     []agentcontract.ModelSummary{{ID: "channel_1", Name: "本地模型", Provider: "openai", ModelID: "gpt-test"}},
		events: []agentcontract.Event{{
			ContractVersion: agentcontract.ContractVersion,
			RunID:           "run_1",
			Sequence:        1,
			Kind:            agentcontract.EventStarted,
			ReplaySafe:      true,
		}},
	}
	handler := NewHandler(fake)
	workspaces := httptest.NewRecorder()
	handler.ServeHTTP(workspaces, httptest.NewRequest(http.MethodGet, "/agent/v1/workspaces", nil))
	if workspaces.Code != http.StatusOK || !strings.Contains(workspaces.Body.String(), `"id":"workspace_1"`) || strings.Contains(workspaces.Body.String(), "root") {
		t.Fatalf("GET /workspaces response = (%d, %s)", workspaces.Code, workspaces.Body.String())
	}
	models := httptest.NewRecorder()
	handler.ServeHTTP(models, httptest.NewRequest(http.MethodGet, "/agent/v1/models", nil))
	if models.Code != http.StatusOK || !strings.Contains(models.Body.String(), `"id":"channel_1"`) || strings.Contains(models.Body.String(), "apiKey") {
		t.Fatalf("GET /models response = (%d, %s)", models.Code, models.Body.String())
	}

	startBody := `{"workspaceId":"workspace_1","modelId":"model_1","mode":"plan","prompt":"检查当前文件"}`
	start := httptest.NewRecorder()
	handler.ServeHTTP(start, httptest.NewRequest(http.MethodPost, "/agent/v1/runs", strings.NewReader(startBody)))
	if start.Code != http.StatusCreated {
		t.Fatalf("POST /runs status = %d, want %d: %s", start.Code, http.StatusCreated, start.Body.String())
	}
	var created agentcontract.Run
	if err := json.Unmarshal(start.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created run: %v", err)
	}
	if created.ContractVersion != agentcontract.ContractVersion || created.ID != "run_1" {
		t.Fatalf("created run = %+v", created)
	}

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/agent/v1/runs/run_1", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /runs/:id status = %d, want %d: %s", get.Code, http.StatusOK, get.Body.String())
	}

	events := httptest.NewRecorder()
	handler.ServeHTTP(events, httptest.NewRequest(http.MethodGet, "/agent/v1/runs/run_1/events", nil))
	if events.Code != http.StatusOK || !strings.Contains(events.Body.String(), `"replaySafe":true`) {
		t.Fatalf("GET /events response = (%d, %s)", events.Code, events.Body.String())
	}

	replay := httptest.NewRecorder()
	handler.ServeHTTP(replay, httptest.NewRequest(http.MethodGet, "/agent/v1/runs/run_1/replay", nil))
	if replay.Code != http.StatusOK || !strings.Contains(replay.Body.String(), `"sequence":1`) {
		t.Fatalf("GET /replay response = (%d, %s)", replay.Code, replay.Body.String())
	}

	list := httptest.NewRecorder()
	handler.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/agent/v1/runs?workspaceId=workspace_1", nil))
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `"id":"run_1"`) {
		t.Fatalf("GET /runs response = (%d, %s)", list.Code, list.Body.String())
	}

	cancel := httptest.NewRecorder()
	handler.ServeHTTP(cancel, httptest.NewRequest(http.MethodPost, "/agent/v1/runs/run_1/cancel", nil))
	if cancel.Code != http.StatusOK || fake.cancelCalls != 1 {
		t.Fatalf("POST /cancel response = (%d, %s), calls = %d", cancel.Code, cancel.Body.String(), fake.cancelCalls)
	}
}

func TestHandlerKeepsClaimsRelativeAndRequiresMatchingClaimID(t *testing.T) {
	fake := &fakeService{
		preview: ClaimPreview{
			Claim: agentcontract.Claim{
				ContractVersion: agentcontract.ContractVersion,
				ID:              "effect_1",
				RunID:           "run_1",
				WorkspaceID:     "workspace_1",
				Kind:            agentcontract.ClaimWorkspaceWrite,
				Status:          agentcontract.StatusProposed,
				Target:          "src/main.go",
			},
			Approval: approval.Approval{ID: "approval_1", WorkspaceID: "workspace_1", State: approval.StatePending},
		},
	}
	handler := NewHandler(fake)

	absolute := httptest.NewRecorder()
	handler.ServeHTTP(absolute, jsonRequest(http.MethodPost, "/agent/v1/runs/run_1/claims/preview", agentrun.Effect{
		ID:   "effect_1",
		Kind: agentrun.EffectWrite,
		Path: `C:\secret.txt`,
	}))
	if absolute.Code != http.StatusBadRequest || fake.previewCalls != 0 {
		t.Fatalf("absolute path response = (%d, %s), preview calls = %d", absolute.Code, absolute.Body.String(), fake.previewCalls)
	}
	if strings.Contains(absolute.Body.String(), `C:\secret.txt`) {
		t.Fatalf("absolute path leaked in error response: %s", absolute.Body.String())
	}

	preview := httptest.NewRecorder()
	handler.ServeHTTP(preview, jsonRequest(http.MethodPost, "/agent/v1/runs/run_1/claims/preview", agentrun.Effect{
		ID:   "effect_1",
		Kind: agentrun.EffectWrite,
		Path: "src/main.go",
	}))
	if preview.Code != http.StatusOK || fake.previewCalls != 1 || !strings.Contains(preview.Body.String(), `"target":"src/main.go"`) {
		t.Fatalf("preview response = (%d, %s), calls = %d", preview.Code, preview.Body.String(), fake.previewCalls)
	}

	wrongID := httptest.NewRecorder()
	handler.ServeHTTP(wrongID, jsonRequest(http.MethodPost, "/agent/v1/runs/run_1/claims/other/commit", commitRequest{
		ApprovalID: "approval_1",
		Effect: agentrun.Effect{
			ID:   "effect_1",
			Kind: agentrun.EffectWrite,
			Path: "src/main.go",
		},
	}))
	if wrongID.Code != http.StatusBadRequest || fake.commitCalls != 0 {
		t.Fatalf("mismatched claim response = (%d, %s), calls = %d", wrongID.Code, wrongID.Body.String(), fake.commitCalls)
	}

	committed := httptest.NewRecorder()
	handler.ServeHTTP(committed, jsonRequest(http.MethodPost, "/agent/v1/runs/run_1/claims/effect_1/commit", commitRequest{
		ApprovalID: "approval_1",
		Effect: agentrun.Effect{
			ID:   "effect_1",
			Kind: agentrun.EffectWrite,
			Path: "src/main.go",
		},
	}))
	if committed.Code != http.StatusOK || fake.commitCalls != 1 {
		t.Fatalf("commit response = (%d, %s), calls = %d", committed.Code, committed.Body.String(), fake.commitCalls)
	}
}

func TestHandlerReturnsStructuredErrorsWithoutHostPath(t *testing.T) {
	fake := &fakeService{}
	handler := NewHandler(fake)

	missingWorkspace := httptest.NewRecorder()
	handler.ServeHTTP(missingWorkspace, httptest.NewRequest(http.MethodGet, "/agent/v1/runs", nil))
	if missingWorkspace.Code != http.StatusBadRequest {
		t.Fatalf("missing workspace status = %d, want %d", missingWorkspace.Code, http.StatusBadRequest)
	}
	var response struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(missingWorkspace.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if response.Error.Code == "" || response.Error.Message == "" {
		t.Fatalf("structured error = %+v", response.Error)
	}
	if errors.Is(errors.New(response.Error.Message), errors.New(`C:\secret.txt`)) {
		t.Fatal("error response unexpectedly contains a host path")
	}
}

func TestMountedHandlerWorksInsideBackendRouteTree(t *testing.T) {
	fake := &fakeService{run: agentcontract.Run{
		ContractVersion: agentcontract.ContractVersion,
		ID:              "run_1",
		SessionID:       "session_1",
		WorkspaceID:     "workspace_1",
		ModelID:         "model_1",
		Status:          agentcontract.StatusRunning,
	}}
	outer := server.New(server.Mount("/agent/v1", NewMountedHandler(fake)))
	response := httptest.NewRecorder()
	outer.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/agent/v1/runs/run_1", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"run_1"`) {
		t.Fatalf("mounted response = (%d, %s)", response.Code, response.Body.String())
	}
}

func TestHandlerHealthExposesContractVersion(t *testing.T) {
	response := httptest.NewRecorder()
	NewHandler(&fakeService{}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/agent/v1/health", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"contractVersion":"agent.contract.v1"`) {
		t.Fatalf("health response = (%d, %s)", response.Code, response.Body.String())
	}
}

func jsonRequest(method, target string, value any) *http.Request {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	return request
}
