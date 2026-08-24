// Package agentbridge 提供供 VS Code Agent 扩展调用的本地 HTTP 协议适配层。
package agentbridge

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"unicode"

	"cursor/internal/agentcontract"
	"cursor/internal/ide/agentrun"
	"cursor/internal/ide/approval"
	"cursor/internal/ide/workspace"

	"github.com/go-chi/chi/v5"
)

const (
	publicPrefix = "/agent/v1"
	maxBodyBytes = 1 << 20
)

// Service 是 HTTP Bridge 需要的最小 Agent 能力集合。
type Service interface {
	ListIDEWorkspaces() ([]workspace.Summary, error)
	ListAgentContractModels() ([]agentcontract.ModelSummary, error)
	StartAgentContractRun(agentcontract.StartRequest) (agentcontract.Run, error)
	GetAgentContractRun(string) (agentcontract.Run, error)
	ListAgentContractRuns(string) ([]agentcontract.Run, error)
	GetAgentContractRunEvents(string) ([]agentcontract.Event, error)
	ReplayAgentContractRun(string) ([]agentcontract.Event, error)
	CancelAgentContractRun(string) (agentcontract.Run, error)
	PreviewAgentClaim(string, agentrun.Effect) (ClaimPreview, error)
	CommitAgentClaim(string, string, agentrun.Effect) error
}

// ClaimPreview 是审批中心与 VS Code Agent 面板之间的稳定预览结果。
type ClaimPreview struct {
	Claim    agentcontract.Claim `json:"claim"`
	Approval approval.Approval   `json:"approval"`
	Effect   agentrun.Effect     `json:"effect"`
}

// NewHandler 创建带有 /agent/v1 前缀的独立 HTTP Handler。
func NewHandler(service Service) http.Handler {
	return newHandler(service, true)
}

// NewMountedHandler 创建用于挂载到现有 Backend 路由树的子 Handler。
func NewMountedHandler(service Service) http.Handler {
	return newHandler(service, false)
}

type handler struct {
	service Service
}

func (h *handler) requireService(writer http.ResponseWriter) bool {
	if h != nil && h.service != nil {
		return true
	}
	writeError(writer, http.StatusServiceUnavailable, "agent_unavailable", "Agent 服务未初始化")
	return false
}

func newHandler(service Service, withPrefix bool) http.Handler {
	h := &handler{service: service}
	router := chi.NewRouter()
	registerRoutes(router, h)
	if !withPrefix {
		return router
	}
	root := chi.NewRouter()
	root.Mount(publicPrefix, router)
	return root
}

func registerRoutes(router chi.Router, h *handler) {
	router.Get("/health", h.health)
	router.Get("/workspaces", h.listWorkspaces)
	router.Get("/models", h.listModels)
	router.Post("/runs", h.startRun)
	router.Get("/runs", h.listRuns)
	router.Get("/runs/{runID}", h.getRun)
	router.Get("/runs/{runID}/events", h.getEvents)
	router.Get("/runs/{runID}/replay", h.replayRun)
	router.Post("/runs/{runID}/cancel", h.cancelRun)
	router.Post("/runs/{runID}/claims/preview", h.previewClaim)
	router.Post("/runs/{runID}/claims/{claimID}/commit", h.commitClaim)
}

func (h *handler) health(writer http.ResponseWriter, _ *http.Request) {
	if !h.requireService(writer) {
		return
	}
	writeJSON(writer, http.StatusOK, map[string]string{
		"contractVersion": agentcontract.ContractVersion,
		"service":         "cursor-byok-agent",
		"status":          "ok",
	})
}

func (h *handler) listWorkspaces(writer http.ResponseWriter, _ *http.Request) {
	if !h.requireService(writer) {
		return
	}
	items, err := h.service.ListIDEWorkspaces()
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	for _, item := range items {
		if err := validateWorkspaceSummary(item); err != nil {
			writeProtocolError(writer, err)
			return
		}
	}
	writeJSON(writer, http.StatusOK, items)
}

func (h *handler) listModels(writer http.ResponseWriter, _ *http.Request) {
	if !h.requireService(writer) {
		return
	}
	items, err := h.service.ListAgentContractModels()
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	for _, item := range items {
		if err := validateModelSummary(item); err != nil {
			writeProtocolError(writer, err)
			return
		}
	}
	writeJSON(writer, http.StatusOK, items)
}

func (h *handler) startRun(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	var payload agentcontract.StartRequest
	if !decodeJSON(writer, request, &payload) {
		return
	}
	payload = agentcontract.NormalizeStartRequest(payload)
	if err := validateStartRequest(payload); err != nil {
		writeProtocolError(writer, err)
		return
	}
	run, err := h.service.StartAgentContractRun(payload)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateRunResponse(run); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, run)
}

func (h *handler) listRuns(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	workspaceID := strings.TrimSpace(request.URL.Query().Get("workspaceId"))
	if err := validateOpaqueID(workspaceID, "workspaceId"); err != nil {
		writeProtocolError(writer, err)
		return
	}
	runs, err := h.service.ListAgentContractRuns(workspaceID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	for _, run := range runs {
		if err := validateRunResponse(run); err != nil {
			writeProtocolError(writer, err)
			return
		}
	}
	writeJSON(writer, http.StatusOK, runs)
}

func (h *handler) getRun(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	run, err := h.service.GetAgentContractRun(runID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateRunResponse(run); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, run)
}

func (h *handler) getEvents(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	events, err := h.service.GetAgentContractRunEvents(runID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateEventsResponse(events); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, events)
}

func (h *handler) replayRun(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	events, err := h.service.ReplayAgentContractRun(runID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateEventsResponse(events); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, events)
}

func (h *handler) cancelRun(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	run, err := h.service.CancelAgentContractRun(runID)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateRunResponse(run); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, run)
}

func (h *handler) previewClaim(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	var effect agentrun.Effect
	if !decodeJSON(writer, request, &effect) {
		return
	}
	if err := validateEffectRequest(effect); err != nil {
		writeProtocolError(writer, err)
		return
	}
	preview, err := h.service.PreviewAgentClaim(runID, effect)
	if err != nil {
		writeServiceError(writer, err)
		return
	}
	if err := validateClaimPreview(preview); err != nil {
		writeProtocolError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, preview)
}

func (h *handler) commitClaim(writer http.ResponseWriter, request *http.Request) {
	if !h.requireService(writer) {
		return
	}
	runID, ok := runIDFromRequest(writer, request)
	if !ok {
		return
	}
	claimID := strings.TrimSpace(chi.URLParam(request, "claimID"))
	if err := validateOpaqueID(claimID, "claimId"); err != nil {
		writeProtocolError(writer, err)
		return
	}
	var payload commitRequest
	if !decodeJSON(writer, request, &payload) {
		return
	}
	payload.ApprovalID = strings.TrimSpace(payload.ApprovalID)
	if payload.ApprovalID == "" {
		writeProtocolError(writer, newRequestError("approvalId 不能为空"))
		return
	}
	if payload.Effect.ID != claimID {
		writeProtocolError(writer, newRequestError("claimId 与 effect.id 不匹配"))
		return
	}
	if err := validateEffectRequest(payload.Effect); err != nil {
		writeProtocolError(writer, err)
		return
	}
	if err := h.service.CommitAgentClaim(runID, payload.ApprovalID, payload.Effect); err != nil {
		writeServiceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"contractVersion": agentcontract.ContractVersion,
		"runId":           runID,
		"claimId":         claimID,
		"status":          agentcontract.StatusCommitted,
	})
}

type commitRequest struct {
	ApprovalID string          `json:"approvalId"`
	Effect     agentrun.Effect `json:"effect"`
}

type protocolError struct {
	status  int
	code    string
	message string
}

func (err *protocolError) Error() string { return err.message }

func newRequestError(message string) error {
	return &protocolError{status: http.StatusBadRequest, code: "invalid_request", message: message}
}

func runIDFromRequest(writer http.ResponseWriter, request *http.Request) (string, bool) {
	runID := strings.TrimSpace(chi.URLParam(request, "runID"))
	if err := validateOpaqueID(runID, "runId"); err != nil {
		writeProtocolError(writer, err)
		return "", false
	}
	return runID, true
}

func validateStartRequest(request agentcontract.StartRequest) error {
	if err := validateOpaqueID(request.WorkspaceID, "workspaceId"); err != nil {
		return err
	}
	if request.SessionID != "" {
		if err := validateOpaqueID(request.SessionID, "sessionId"); err != nil {
			return err
		}
	}
	if request.ParentRunID != "" {
		if err := validateOpaqueID(request.ParentRunID, "parentRunId"); err != nil {
			return err
		}
	}
	if strings.TrimSpace(request.ModelID) == "" {
		return newRequestError("modelId 不能为空")
	}
	if strings.TrimSpace(request.Prompt) == "" {
		return newRequestError("prompt 不能为空")
	}
	return nil
}

func validateWorkspaceSummary(summary workspace.Summary) error {
	if err := validateOpaqueID(summary.ID, "workspaceId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效工作区"}
	}
	if strings.TrimSpace(summary.Name) == "" || isHostAbsolutePath(summary.Name) {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效工作区"}
	}
	return nil
}

func validateModelSummary(summary agentcontract.ModelSummary) error {
	if err := validateOpaqueID(summary.ID, "modelId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效模型通道"}
	}
	if strings.TrimSpace(summary.Name) == "" || strings.TrimSpace(summary.ModelID) == "" || containsHostAbsolutePath(summary.Name) || containsHostAbsolutePath(summary.ModelID) {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效模型通道"}
	}
	return nil
}

func validateOpaqueID(value, field string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return newRequestError(field + " 不能为空")
	}
	for _, char := range value {
		if unicode.IsSpace(char) || char == '/' || char == '\\' || char == ':' || char == 0 {
			return newRequestError(field + " 必须是工作区不透明标识")
		}
	}
	return nil
}

func validateEffectRequest(effect agentrun.Effect) error {
	if strings.TrimSpace(effect.ID) == "" {
		return newRequestError("effect.id 不能为空")
	}
	if err := validateRelativePath(effect.Path, "effect.path"); err != nil {
		return err
	}
	if err := validateRelativePath(effect.Directory, "effect.directory"); err != nil {
		return err
	}
	for _, item := range effect.Paths {
		if err := validateRelativePath(item, "effect.paths"); err != nil {
			return err
		}
	}
	return nil
}

func validateRelativePath(value, field string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if strings.IndexByte(value, 0) >= 0 || isHostAbsolutePath(value) {
		return newRequestError(field + " 必须是工作区相对路径")
	}
	normalized := strings.ReplaceAll(value, "\\", "/")
	cleaned := path.Clean(normalized)
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return newRequestError(field + " 不能越出工作区")
	}
	return nil
}

func isHostAbsolutePath(value string) bool {
	if filepath.IsAbs(value) || strings.HasPrefix(value, `\\`) || strings.HasPrefix(value, "//") {
		return true
	}
	return len(value) >= 2 && value[1] == ':' && unicode.IsLetter(rune(value[0]))
}

func containsHostAbsolutePath(value string) bool {
	if strings.Contains(value, `\\`) {
		return true
	}
	for index := 0; index+2 < len(value); index++ {
		if unicode.IsLetter(rune(value[index])) && value[index+1] == ':' && (value[index+2] == '\\' || value[index+2] == '/') {
			return true
		}
	}
	return false
}

func validateRunResponse(run agentcontract.Run) error {
	if run.ContractVersion == "" || run.ContractVersion != agentcontract.ContractVersion {
		return &protocolError{status: http.StatusBadGateway, code: "contract_version_mismatch", message: "Agent Contract 版本不匹配"}
	}
	if err := validateOpaqueID(run.ID, "runId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 run"}
	}
	if err := validateOpaqueID(run.SessionID, "sessionId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 run"}
	}
	if err := validateOpaqueID(run.WorkspaceID, "workspaceId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 run"}
	}
	if run.ParentRunID != "" {
		if err := validateOpaqueID(run.ParentRunID, "parentRunId"); err != nil {
			return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 run"}
		}
	}
	if containsHostAbsolutePath(run.Error) {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了主机绝对路径"}
	}
	return nil
}

func validateEventsResponse(events []agentcontract.Event) error {
	for _, event := range events {
		if event.ContractVersion != agentcontract.ContractVersion {
			return &protocolError{status: http.StatusBadGateway, code: "contract_version_mismatch", message: "Agent Contract 版本不匹配"}
		}
		if err := validateOpaqueID(event.RunID, "runId"); err != nil {
			return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效事件"}
		}
		if event.SessionID != "" {
			if err := validateOpaqueID(event.SessionID, "sessionId"); err != nil {
				return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效事件"}
			}
		}
		if event.ParentRunID != "" {
			if err := validateOpaqueID(event.ParentRunID, "parentRunId"); err != nil {
				return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效事件"}
			}
		}
		if containsHostAbsolutePath(event.Text) {
			return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了主机绝对路径"}
		}
	}
	return nil
}

func validateClaimPreview(preview ClaimPreview) error {
	if preview.Claim.ContractVersion != agentcontract.ContractVersion {
		return &protocolError{status: http.StatusBadGateway, code: "contract_version_mismatch", message: "Agent Contract 版本不匹配"}
	}
	if err := validateRelativePath(preview.Claim.Target, "claim.target"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了主机绝对路径"}
	}
	if err := validateOpaqueID(preview.Claim.ID, "claimId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 claim"}
	}
	if err := validateOpaqueID(preview.Claim.RunID, "runId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 claim"}
	}
	if err := validateOpaqueID(preview.Claim.WorkspaceID, "workspaceId"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 claim"}
	}
	if err := validateRelativePath(preview.Approval.Summary.Target, "approval.summary.target"); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了主机绝对路径"}
	}
	if err := validateEffectRequest(preview.Effect); err != nil {
		return &protocolError{status: http.StatusBadGateway, code: "invalid_service_response", message: "Agent 返回了无效 claim"}
	}
	return nil
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, target any) bool {
	decoder := json.NewDecoder(io.LimitReader(request.Body, maxBodyBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeProtocolError(writer, newRequestError("JSON 请求体无效"))
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeProtocolError(writer, newRequestError("JSON 请求体不能包含多个值"))
		return false
	}
	return true
}

func writeServiceError(writer http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "agent_error"
	message := "Agent 操作失败"
	switch {
	case errors.Is(err, agentrun.ErrInvalidRequest), errors.Is(err, agentrun.ErrEffectInvalid):
		status = http.StatusBadRequest
		code = "invalid_request"
	case errors.Is(err, agentrun.ErrRunNotFound), errors.Is(err, agentrun.ErrEffectNotFound):
		status = http.StatusNotFound
		code = "not_found"
	case errors.Is(err, agentrun.ErrCapacity):
		status = http.StatusConflict
		code = "capacity_reached"
	case errors.Is(err, agentrun.ErrStreamerMissing):
		status = http.StatusServiceUnavailable
		code = "agent_unavailable"
	}
	writeError(writer, status, code, message)
}

func writeProtocolError(writer http.ResponseWriter, err error) {
	var protocolErr *protocolError
	if errors.As(err, &protocolErr) {
		writeError(writer, protocolErr.status, protocolErr.code, protocolErr.message)
		return
	}
	writeError(writer, http.StatusBadRequest, "invalid_request", "请求无效")
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, code, message string) {
	writeJSON(writer, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}
