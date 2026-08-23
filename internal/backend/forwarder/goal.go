package forwarder

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	agentv1 "cursor/gen/agentv1"
	modeladapter "cursor/internal/backend/agent/model"
	"cursor/internal/backend/delegation"
	"cursor/internal/historymetrics"
	"cursor/internal/safego"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

// GoalStatus 是 goal 会话的终态/运行态枚举。只在内存维护（MVP），不持久化。
type GoalStatus string

const (
	GoalStatusRunning        GoalStatus = "running"
	GoalStatusCompleted      GoalStatus = "completed"
	GoalStatusFailed         GoalStatus = "failed"
	GoalStatusBudgetExceeded GoalStatus = "budget_exceeded"
	GoalStatusStopped        GoalStatus = "stopped"
)

// GoalState 挂在 ActiveStream.Goal 上（nil = 非 goal 会话）。
const goalVerifierTimeout = 3 * time.Minute

type pendingGoalVerification struct {
	Token          uint64
	TaskID         string
	RequestID      string
	ConversationID string
	TurnSeq        int64
	ProviderPass   int
	ModelCallID    string
	Goal           *GoalState
	Scheduler      *delegation.Scheduler
	WaitCancel     context.CancelFunc
	Completion     pendingTurnCompletion
}

type GoalState struct {
	ConversationID  string
	GoalText        string
	Status          GoalStatus
	Strict          bool // /goal --strict：校验不通过时不允许模型自检兜底（借鉴 Reasonix Strict）
	ProviderPasses  int
	ToolCalls       int
	SelfChecks      int
	RetryCount      int // 校验子代理未通过的重试次数
	ErrorRetries    int // provider 错误重试次数
	StaleCount      int // 校验连续未通过次数，达到阈值后提示结构性换策略（借鉴 Reasonix stale pivot）
	CostEstimateUSD float64
	StartedAt       time.Time
	UpdatedAt       time.Time
	LastProgress    string
	CompletionText  string
	StopReason      string

	consecutiveIdle     int  // 连续无工具调用 pass 计数
	CompletionClaimed   bool // 模型已输出 [goal:complete] 声明
	costMu              sync.Mutex
	accountedModelCalls map[string]struct{}
}

func newGoalState(conversationID, goalText string, strict bool) *GoalState {
	now := time.Now().UTC()
	return &GoalState{
		ConversationID:      conversationID,
		GoalText:            strings.TrimSpace(goalText),
		Status:              GoalStatusRunning,
		Strict:              strict,
		StartedAt:           now,
		UpdatedAt:           now,
		accountedModelCalls: make(map[string]struct{}),
	}
}

func defaultGoalRuntimeConfig() GoalRuntimeConfig {
	return GoalRuntimeConfig{
		Enabled:           false,
		MaxProviderPasses: 30,
		SelfCheckPasses:   2,
		VerifyMaxRetries:  3,
		ErrorMaxRetries:   3,
		ProgressInterval:  5,
	}
}

// goalConfigProvider 由 host 层实现并注入 NewService（resolver 类型断言）。
type goalConfigProvider interface {
	GoalRuntimeConfig() GoalRuntimeConfig
}

// currentGoalConfig 返回 goal 运行时配置；provider 未注入时用默认值。
func (service *Service) currentGoalConfig() GoalRuntimeConfig {
	if service == nil || service.goalConfig == nil {
		return defaultGoalRuntimeConfig()
	}
	return service.goalConfig.GoalRuntimeConfig()
}

// goalCommandPrefixes 是 /goal 文本命令的识别前缀。命中后前缀与可选的 --strict
// flag 被剥离，剩余文本作为 goal 目标写入 GoalState。
// --strict 借鉴 Reasonix 的 /goal --strict：校验不通过不允许覆盖/兜底。
var goalCommandPrefixes = []string{"/goal", "#goal", "goal:"}

// parseGoalCommand 识别 /goal 文本命令。返回 (目标文本, strict, 是否命中)。
func parseGoalCommand(text string) (goalText string, strict bool, isGoal bool) {
	trimmed := strings.TrimSpace(text)
	lower := strings.ToLower(trimmed)
	for _, prefix := range goalCommandPrefixes {
		if !strings.HasPrefix(lower, prefix) {
			continue
		}
		rest := trimmed[len(prefix):]
		if prefix != "goal:" && rest != "" {
			first, _ := utf8.DecodeRuneInString(rest)
			if !unicode.IsSpace(first) {
				continue
			}
		}
		rest = strings.TrimSpace(rest)
		if rest == "" {
			return "", false, false
		}
		fields := strings.Fields(rest)
		if len(fields) > 0 && strings.EqualFold(fields[0], "--strict") {
			rest = strings.TrimSpace(rest[len(fields[0]):])
			if rest == "" {
				return "", true, false
			}
			return rest, true, true
		}
		return rest, false, true
	}
	return "", false, false
}

// applyGoalCommandIfEnabled 在 goal 开关（goal.enabled）开启时识别 /goal 与
// /goal --strict 文本命令：命中后标记 GoalMode 并剥离前缀；开关关闭时原样
// 保留消息内容，按普通对话处理。
func applyGoalCommandIfEnabled(intent *InboundIntent, enabled bool) {
	if intent == nil || intent.GoalMode || !enabled {
		return
	}
	if goalText, strict, isGoal := parseGoalCommand(userMessageText(intent.UserMessage)); isGoal {
		intent.GoalMode = true
		intent.GoalText = goalText
		intent.GoalStrict = strict
		// 剥离前缀，避免 goal 目标文本被当作指令重复注入。
		intent.UserMessage = replaceUserMessageText(intent.UserMessage, goalText)
	}
}

// replaceUserMessageText 返回替换 text 后的 UserMessage 副本。
func replaceUserMessageText(message *agentv1.UserMessage, text string) *agentv1.UserMessage {
	if message == nil {
		return &agentv1.UserMessage{Text: text}
	}
	cloned, ok := proto.Clone(message).(*agentv1.UserMessage)
	if !ok {
		// Clone 理论上返回同类型；失败时退回构造新消息，避免运行时 panic
		// 冒泡到 forwarder 导致所有活跃对话掉线。
		return &agentv1.UserMessage{Text: text}
	}
	cloned.Text = text
	return cloned
}

// goalSystemPromptFragment 生成 goal 模式的系统指令段，追加在
// customSystemPrompt 位置（systemParts 末尾），避免影响前缀稳定性。
func goalSystemPromptFragment(goal *GoalState, cfg GoalRuntimeConfig) string {
	if goal == nil || strings.TrimSpace(goal.GoalText) == "" {
		return ""
	}
	parts := []string{
		"你当前处于 GOAL 模式。你的目标（GOAL）：",
		goal.GoalText,
		"",
		"执行要求：",
		"0. 先拆解目标：把目标拆成 3-8 个可验证的步骤清单（在回复中列出），逐项完成并标记。",
		"1. 自主决策：持续调用工具推进目标，不要轻易停下或询问用户；只有真正无法继续时才停下并说明卡点。",
		"2. 循环执行：一轮结束（没有工具调用）不代表完成。请自检目标是否达成：未达成则继续执行下一轮，直到目标真正达成。",
		"3. 失败重试：工具执行失败时分析原因、换一种方式重试，不要直接放弃。",
		"4. 进度汇报：每完成一个阶段，用简短一句话汇报当前进度。",
		"5. 完成标准：目标的所有要求都满足后才算完成。完成时输出以 [goal:complete] 开头（单独一行）的最终完成报告，说明你做了什么、验证了什么、结果如何；不要在没有真正完成时输出该标记。",
	}
	if cfg.MaxProviderPasses > 0 {
		parts = append(parts, fmt.Sprintf("6. 预算：本 goal 最多执行 %d 轮 provider 调用，请高效推进，优先完成最关键步骤。", cfg.MaxProviderPasses))
	}
	return strings.Join(parts, "\n")
}

// joinNonEmpty 用空行连接非空片段。
func joinNonEmpty(parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			nonEmpty = append(nonEmpty, strings.TrimSpace(p))
		}
	}
	return strings.Join(nonEmpty, "\n\n")
}

// goalBudgetExceeded 检查 goal 是否超出预算（passes / 时长）。
// 返回 (是否超限, 原因)。MaxCostUSD 的费用检查在 handleGoalPassFinished 里
// 依赖 cost 估算结果（见 updateGoalCostEstimate）。
func goalBudgetExceeded(goal *GoalState, cfg GoalRuntimeConfig) (bool, string) {
	if goal == nil {
		return false, ""
	}
	return goalProviderAdmissionExceeded(goal, cfg, goal.ProviderPasses)
}

func goalProviderAdmissionExceeded(goal *GoalState, cfg GoalRuntimeConfig, dispatchedPasses int) (bool, string) {
	if goal == nil {
		return false, ""
	}
	if cfg.MaxProviderPasses > 0 && dispatchedPasses >= cfg.MaxProviderPasses {
		return true, fmt.Sprintf("达到 provider pass 上限 %d", cfg.MaxProviderPasses)
	}
	if cfg.MaxDuration > 0 && !goal.StartedAt.IsZero() && time.Since(goal.StartedAt) >= cfg.MaxDuration {
		return true, fmt.Sprintf("达到时长上限 %s", cfg.MaxDuration)
	}
	if cfg.MaxCostUSD > 0 && goal.costEstimateUSD() >= cfg.MaxCostUSD {
		return true, fmt.Sprintf("达到费用上限 $%.4f", cfg.MaxCostUSD)
	}
	return false, ""
}

func (service *Service) stopGoalForBudget(stream *ActiveStream, goal *GoalState, reason string) error {
	if goal == nil {
		return service.closeStreamWithTurnBudgetExceeded(stream, reason)
	}
	goal.Status = GoalStatusBudgetExceeded
	goal.StopReason = reason
	goal.CompletionText = "goal 因预算上限停止：" + reason
	if err := service.emitGoalCompletion(stream, goal, "budget"); err != nil {
		return err
	}
	return service.closeStreamWithTurnBudgetExceeded(stream, reason)
}

// goalCompletionMarker 是模型声明"目标已完成"的显式标记。借鉴 Reasonix 的
// [goal:complete] 完成声明拦截：后端不轻信"无工具调用"，只认显式声明；
// 声明后仍需校验子代理证据审计才放行（非 strict 且无校验能力时退化为自检）。
const goalCompletionMarker = "[goal:complete]"

func hasStandaloneGoalCompletionMarker(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		if strings.EqualFold(strings.TrimSpace(line), goalCompletionMarker) {
			return true
		}
	}
	return false
}

// goalStalePivotThreshold 是校验连续未通过 / 连续停顿达到该次数后，提示结构性
// 换策略的阈值。借鉴 Reasonix AutoResearch 的 stale_count pivot：换入口点、
// 任务分解或验证方式，而不是重复同一做法。
const goalStalePivotThreshold = 2

const promptContextSourceGoalIdle = "goal_idle"
const promptContextSourceGoalVerifyFeedback = "goal_verify_feedback"
const promptContextSourceGoalErrorRetry = "goal_error_retry"
const promptContextSourceGoalBudget = "goal_budget"

func goalContinuationSource(source string, providerPass int) string {
	if providerPass <= 0 {
		return source
	}
	return source + "/pass/" + strconv.Itoa(providerPass)
}

func isGoalContinuationPromptContextSource(source string) bool {
	for _, base := range []string{
		promptContextSourceGoalIdle,
		promptContextSourceGoalVerifyFeedback,
		promptContextSourceGoalErrorRetry,
	} {
		if source == base {
			return true
		}
		prefix := base + "/pass/"
		if !strings.HasPrefix(source, prefix) {
			continue
		}
		pass, err := strconv.ParseInt(strings.TrimPrefix(source, prefix), 10, 64)
		return err == nil && pass > 0
	}
	return false
}

// goalIdleReminder 是停顿提醒：无工具调用且未声明完成时，要求模型继续推进
// 或说明卡点；连续多轮停顿则要求改变策略（文案随 idleCount 升级）。
func goalIdleReminder(goal *GoalState, idleCount int) PromptContextMessage {
	body := fmt.Sprintf("目标：%s\n\n检测到你已连续 %d 轮没有调用工具。若目标尚未达成，请继续调用工具执行；若遇到卡点，请明确说明卡点并尝试换一种方式突破。", goal.GoalText, idleCount)
	if idleCount >= goalStalePivotThreshold {
		body += "\n连续多轮无进展：请结构性换策略（改变入口点、任务分解或验证方式），不要重复同样的做法。"
	}
	return newPromptContextReminder(promptContextSourceGoalIdle, body)
}

// goalVerifyFeedbackReminder 是校验未通过反馈：列出校验子代理的未达成理由，
// 要求继续执行（Reasonix goal intercept 的"列出未完成项"角色）。
func goalVerifyFeedbackReminder(goal *GoalState, feedback string) PromptContextMessage {
	body := fmt.Sprintf("目标：%s\n\n校验子代理判定目标尚未达成，理由：%s\n请根据该反馈继续执行，直到目标真正达成。", goal.GoalText, feedback)
	return newPromptContextReminder(promptContextSourceGoalVerifyFeedback, body)
}

// appendGoalPromptContext 追加一条 goal 提示到 conversation 并落库（幂等：同一
// source 与 turn 去重，避免无限注入）。返回是否实际追加。
func (service *Service) appendGoalPromptContext(stream *ActiveStream, conversationID string, turnSeq int64, requestID, source, text string) (bool, error) {
	if service == nil || stream == nil || strings.TrimSpace(text) == "" {
		return false, nil
	}
	conversation, _, _, err := service.snapshotCheckpointConversation(stream)
	if err != nil {
		return false, err
	}
	if conversation == nil {
		return false, nil
	}
	if currentTurnHasPromptContextSource(conversation, turnSeq, source) {
		return false, nil
	}
	msg := PromptContextMessage{
		Source:  source,
		Message: modeladapter.Message{Role: "user", Content: text},
	}
	if _, err := service.appendConversationEntries(stream, conversationID, []HistoryEntry{
		newPromptContextEntry(turnSeq, requestID, msg),
	}); err != nil {
		return false, err
	}
	return true, nil
}

// updateGoalCostEstimate 用已捕获的本 pass usage 快照估算费用并累加。
// ProviderUsage 在完成处理时会被清空，因此这里不能读取 ActiveStream 的可变字段。
func (service *Service) updateGoalCostEstimate(goal *GoalState, requestID string, turnSeq int64, modelCallID string, usage turnUsageSnapshot) {
	if service == nil || goal == nil || service.usageCostEstimator == nil || strings.TrimSpace(usage.Role) != "parent" {
		return
	}
	cost, ok := service.usageCostEstimator.Cost(usage)
	if !ok {
		return
	}
	goal.addProviderCostOnce(requestID, turnSeq, modelCallID, cost)
}

func (goal *GoalState) addProviderCostOnce(requestID string, turnSeq int64, modelCallID string, costUSD float64) (float64, bool) {
	if goal == nil || strings.TrimSpace(modelCallID) == "" || math.IsNaN(costUSD) || math.IsInf(costUSD, 0) || costUSD < 0 {
		return 0, false
	}
	key := strings.TrimSpace(requestID) + "\x00" + strconv.FormatInt(turnSeq, 10) + "\x00" + strings.TrimSpace(modelCallID)
	goal.costMu.Lock()
	defer goal.costMu.Unlock()
	if goal.accountedModelCalls == nil {
		goal.accountedModelCalls = make(map[string]struct{})
	}
	if _, exists := goal.accountedModelCalls[key]; exists {
		return goal.CostEstimateUSD, false
	}
	if math.IsInf(goal.CostEstimateUSD+costUSD, 0) {
		return goal.CostEstimateUSD, false
	}
	goal.accountedModelCalls[key] = struct{}{}
	goal.CostEstimateUSD += costUSD
	return goal.CostEstimateUSD, true
}

func (goal *GoalState) costEstimateUSD() float64 {
	if goal == nil {
		return 0
	}
	goal.costMu.Lock()
	defer goal.costMu.Unlock()
	return goal.CostEstimateUSD
}

// goalUsageCostEstimator 估算单个 provider pass 的美元费用；返回 ok=false 表示
// 无定价来源（费用检查跳过）。
type goalUsageCostEstimator interface {
	Cost(usage turnUsageSnapshot) (float64, bool)
}

// goalVerifyPrompt 构造校验子代理的任务提示：只读检查目标是否真正达成，
// 输出必须以 VERIFIED / NOT_VERIFIED 开头。
func goalVerifyPrompt(goal *GoalState) string {
	return fmt.Sprintf(`你是只读校验子代理。请检查以下 GOAL 是否已经真正达成：

GOAL：%s

检查要求：
1. 只读检查代码/结果/证据，不要修改任何文件。
2. 逐项核对 GOAL 的要求是否全部满足；检查是否有遗漏、假完成或未验证的部分。
3. 输出格式（严格）：
   第一行：VERIFIED 或 NOT_VERIFIED
   其余行：简短理由（验证了什么、还差什么）。

请基于真实证据判断，不要轻信主代理的自我声明。`, goal.GoalText)
}

// parseVerifyDecision 解析校验子代理输出首行判定。
func parseVerifyDecision(output string) (verified bool, report string) {
	lines := strings.SplitN(strings.TrimSpace(output), "\n", 2)
	if len(lines) == 0 {
		return false, ""
	}
	head := strings.ToUpper(strings.TrimSpace(lines[0]))
	switch head {
	case "VERIFIED":
		verified = true
	case "NOT_VERIFIED":
		verified = false
	default:
		// 未按格式输出时保守判定为未通过，并把全文作为理由。
		return false, strings.TrimSpace(output)
	}
	report = ""
	if len(lines) == 2 {
		report = strings.TrimSpace(lines[1])
	}
	return verified, report
}

func goalVerificationFallback(goal *GoalState, reason string) (bool, string) {
	if goal != nil && goal.Strict {
		return false, "（strict 模式要求真实只读校验子代理：" + reason + "）"
	}
	return true, "（" + reason + "，采用模型自检结论）"
}

func (service *Service) beginGoalVerification(stream *ActiveStream, goal *GoalState, completion pendingTurnCompletion) (scheduled bool, verified bool, report string, err error) {
	if service == nil || stream == nil || goal == nil {
		return false, false, "", nil
	}
	if service.multitaskDelegation == nil {
		verified, report = goalVerificationFallback(goal, "委派不可用")
		return false, verified, report, nil
	}
	scheduler := service.multitaskDelegation.schedulerSnapshot()
	if scheduler == nil {
		verified, report = goalVerificationFallback(goal, "委派不可用")
		return false, verified, report, nil
	}
	if service.delegationConfig != nil && !delegation.NormalizeRuntimeConfig(service.delegationConfig.DelegationRuntimeConfig()).Enabled {
		verified, report = goalVerificationFallback(goal, "委派已禁用")
		return false, verified, report, nil
	}
	openContext := buildExecOpenContextForStream(stream, nil)
	if strings.TrimSpace(openContext.WorkspaceHint) == "" {
		verified, report = goalVerificationFallback(goal, "未提供可验证的工作区")
		return false, verified, report, nil
	}
	stream.mu.Lock()
	if stream.Goal != goal || goal.Status != GoalStatusRunning || isTerminalStreamStatus(stream.Status) || stream.PendingGoalVerification != nil {
		stream.mu.Unlock()
		return false, false, "", errProviderLoopInterrupted
	}
	stream.CurrentGoalVerifyToken++
	waitCtx, waitCancel := context.WithTimeout(context.Background(), goalVerifierTimeout)
	lease := &pendingGoalVerification{
		Token:          stream.CurrentGoalVerifyToken,
		TaskID:         "goal-verify-" + uuid.NewString(),
		RequestID:      stream.RequestID,
		ConversationID: stream.ConversationID,
		TurnSeq:        stream.TurnSeq,
		ProviderPass:   completion.ProviderPass,
		ModelCallID:    completion.ModelCallID,
		Goal:           goal,
		Scheduler:      scheduler,
		WaitCancel:     waitCancel,
		Completion:     completion,
	}
	parentModelName := firstNonEmpty(strings.TrimSpace(stream.ModelName), strings.TrimSpace(stream.ModelID))
	mode := stream.Mode
	stream.PendingGoalVerification = lease
	stream.PendingProviderAction = providerActionNone
	stream.Phase = TurnPhaseVerifyingGoal
	stream.UpdatedAt = time.Now().UTC()
	stream.mu.Unlock()
	_, submitErr := scheduler.Submit(delegation.TaskRequest{
		ID:                           lease.TaskID,
		ParentRequest:                lease.RequestID,
		ConversationID:               openContext.ConversationID,
		RootConversationID:           openContext.RootConversationID,
		SubagentType:                 "generalPurpose",
		Readonly:                     true,
		Prompt:                       goalVerifyPrompt(goal),
		Description:                  "goal 完成校验",
		ModelID:                      openContext.ModelID,
		ModelName:                    parentModelName,
		Mode:                         mode,
		ExecutionMode:                "local",
		WorkspaceHint:                openContext.WorkspaceHint,
		SubagentModelOverrides:       cloneSubagentModelOverrides(openContext.SubagentModelOverrides),
		SelectedSubagentModels:       cloneSelectedSubagentModels(openContext.SelectedSubagentModels),
		SelectedSubagentModelDetails: cloneSelectedSubagentModelDetails(openContext.SelectedSubagentModelDetails),
		ToolWhitelist:                []string{"Read", "Glob", "Grep", "Ls", "ReadLints"},
		QueueTimeout:                 goalVerifierTimeout,
		Timeout:                      goalVerifierTimeout,
		Contract:                     &delegation.SupervisionTaskContract{DoneCriteria: []string{"输出 VERIFIED 或 NOT_VERIFIED 结论与理由"}},
	})
	if submitErr != nil {
		service.releaseGoalVerifier(stream, lease)
		verified, report = goalVerificationFallback(goal, "校验子代理无法启动")
		return false, verified, report, nil
	}
	if !service.ownsGoalVerifier(stream, lease) {
		waitCancel()
		scheduler.CancelIfActive(lease.TaskID)
		return false, false, "", errProviderLoopInterrupted
	}
	goal.SelfChecks++
	if err := service.emitGoalProgress(stream, goal); err != nil {
		service.cancelOwnedGoalVerifier(stream)
		return false, false, "", err
	}
	safego.Go("forwarder:goal-verifier", func() {
		service.waitForGoalVerifier(stream, lease, waitCtx)
	})
	return true, false, "", nil
}

func (service *Service) ownsGoalVerifier(stream *ActiveStream, lease *pendingGoalVerification) bool {
	if stream == nil || lease == nil {
		return false
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	return stream.PendingGoalVerification == lease && stream.CurrentGoalVerifyToken == lease.Token && stream.Goal == lease.Goal && !isTerminalStreamStatus(stream.Status)
}

func (service *Service) releaseGoalVerifier(stream *ActiveStream, lease *pendingGoalVerification) {
	if stream == nil || lease == nil {
		return
	}
	stream.mu.Lock()
	if stream.PendingGoalVerification == lease && stream.CurrentGoalVerifyToken == lease.Token {
		stream.PendingGoalVerification = nil
		stream.UpdatedAt = time.Now().UTC()
	}
	stream.mu.Unlock()
	lease.WaitCancel()
}

func (service *Service) cancelOwnedGoalVerifier(stream *ActiveStream) bool {
	if stream == nil {
		return false
	}
	stream.mu.Lock()
	lease := stream.PendingGoalVerification
	stream.PendingGoalVerification = nil
	stream.CurrentGoalVerifyToken++
	stream.mu.Unlock()
	if lease == nil {
		return false
	}
	lease.WaitCancel()
	lease.Scheduler.CancelIfActive(lease.TaskID)
	return true
}

func (service *Service) waitForGoalVerifier(stream *ActiveStream, lease *pendingGoalVerification, waitCtx context.Context) {
	defer lease.Scheduler.CancelIfActive(lease.TaskID)
	err := lease.Scheduler.WaitForTerminal(waitCtx, []string{lease.TaskID})
	if waitCtx.Err() != nil && !errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
		service.releaseGoalVerifier(stream, lease)
		return
	}
	payload := &streamGoalVerifyResult{
		Token: lease.Token, TaskID: lease.TaskID, RequestID: lease.RequestID, ConversationID: lease.ConversationID,
		TurnSeq: lease.TurnSeq, ProviderPass: lease.ProviderPass, ModelCallID: lease.ModelCallID,
	}
	if errors.Is(waitCtx.Err(), context.DeadlineExceeded) {
		payload.Unavailable = true
		payload.Report = "校验子代理超时"
	} else if err != nil {
		payload.Err = err
	} else if snapshot, ok := lease.Scheduler.Snapshot(lease.TaskID); !ok {
		payload.Err = fmt.Errorf("goal verify task %s has no snapshot", lease.TaskID)
	} else if snapshot.Status != delegation.TaskCompleted {
		payload.Unavailable = true
		payload.Report = firstNonEmpty(strings.TrimSpace(snapshot.Error), "校验子代理未完成")
	} else {
		payload.Verified, payload.Report = parseVerifyDecision(snapshot.Output)
	}
	if err := service.postStreamCommandAsync(stream, streamCommand{Kind: streamCommandGoalVerifyResult, GoalVerify: payload}); err != nil {
		service.releaseGoalVerifier(stream, lease)
	}
}

func (service *Service) handleGoalVerifyResult(stream *ActiveStream, payload *streamGoalVerifyResult) error {
	if stream == nil || payload == nil {
		return nil
	}
	stream.mu.Lock()
	lease := stream.PendingGoalVerification
	if lease == nil || payload.Token != stream.CurrentGoalVerifyToken || payload.Token != lease.Token || payload.TaskID != lease.TaskID || payload.RequestID != stream.RequestID || payload.RequestID != lease.RequestID || payload.ConversationID != stream.ConversationID || payload.ConversationID != lease.ConversationID || payload.TurnSeq != stream.TurnSeq || payload.TurnSeq != lease.TurnSeq || payload.ProviderPass != lease.ProviderPass || payload.ModelCallID != lease.ModelCallID || stream.Goal != lease.Goal || lease.Goal.Status != GoalStatusRunning || stream.Phase != TurnPhaseVerifyingGoal || isTerminalStreamStatus(stream.Status) {
		stream.mu.Unlock()
		return nil
	}
	stream.PendingGoalVerification = nil
	stream.mu.Unlock()
	lease.WaitCancel()
	if payload.Err != nil {
		return payload.Err
	}
	verified, report := payload.Verified, payload.Report
	if payload.Unavailable {
		verified, report = goalVerificationFallback(lease.Goal, firstNonEmpty(report, "校验子代理执行失败"))
	}
	_, err := service.finishGoalVerification(stream, lease.Goal, lease.Completion, verified, report)
	return err
}

// defaultUsageCostEstimator 用 historymetrics 定价表估算；无表时返回 ok=false。
// NewService 里始终赋值（nil 安全），保证 updateGoalCostEstimate 恒可调用。
type defaultUsageCostEstimator struct {
	lookup *historymetrics.PriceLookup
}

func (e *defaultUsageCostEstimator) Cost(usage turnUsageSnapshot) (float64, bool) {
	if e == nil || e.lookup == nil || !usage.UsagePresent {
		return 0, false
	}
	cost, ok, currency, _ := e.lookup.CostForCandidates(
		[]string{usage.BillingModel, usage.ProviderModel, usage.Model, usage.LogicalModel},
		usage.Provider,
		usage.BaseURL,
		usage.InputTokens,
		usage.OutputTokens,
		usage.CacheReadTokens,
		usage.CacheWriteTokens,
	)
	if !ok || cost == nil || (currency != "" && !strings.EqualFold(currency, "USD")) {
		return 0, false
	}
	return *cost, true
}

// newPricingLookupFromConfig 从 resolver 提供的 pricing 配置构建定价表；
// 拿不到时返回 nil（费用估算与检查自动跳过）。
func newPricingLookupFromConfig(resolver modeladapter.ChannelResolver) *historymetrics.PriceLookup {
	provider, ok := resolver.(interface {
		PricingRates() []historymetrics.PriceRate
	})
	if !ok {
		return nil
	}
	rates := provider.PricingRates()
	if len(rates) == 0 {
		return nil
	}
	return historymetrics.NewPriceLookup(rates)
}

// truncateText 按 rune 截断文本并加省略号。
func truncateText(text string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= maxRunes {
		return string(runes)
	}
	return string(runes[:maxRunes]) + "…"
}

// handleGoalPassFinished 在 provider pass 无工具调用收尾点接管 goal 循环：
// 返回 (true, nil) 表示已挂起继续（调用方 return）；(false, nil) 表示走正常收口
// （完成 / 预算超限 / 失败）；(false, err) 表示循环级错误。
func (service *Service) handleGoalPassFinished(stream *ActiveStream, conversationID string, turnSeq int64, requestID, modelCallID string, providerPass int, finishReason, accumulatedText string, hadToolInvocation bool, usage turnUsageSnapshot) (bool, error) {
	goal := stream.Goal
	if goal == nil {
		return false, nil
	}
	goal.ProviderPasses = providerPass
	goal.ToolCalls += stream.ToolInvocationCount
	goal.UpdatedAt = time.Now().UTC()

	cfg := service.currentGoalConfig()

	// 有工具调用：现有循环逻辑（actor.go）继续 resume，这里让行。
	if hadToolInvocation || shouldResumeAfterToolResults(finishReason) {
		return false, nil
	}

	// 无工具调用：模型要么显式声明完成（[goal:complete]），要么停顿。
	// 借鉴 Reasonix 的完成声明拦截：不轻信"无工具调用"，只认显式声明；
	// 停顿则注入 idle 提醒（连续多轮升级为换策略提示）。
	goal.consecutiveIdle++
	goal.LastProgress = truncateText(accumulatedText, 120)
	completionClaimed := hasStandaloneGoalCompletionMarker(accumulatedText)

	if completionClaimed {
		goal.CompletionClaimed = true
		completion := pendingTurnCompletion{
			ConversationID: conversationID,
			RequestID:      requestID,
			TurnSeq:        turnSeq,
			ModelCallID:    modelCallID,
			ProviderPass:   providerPass,
			Usage:          usage,
		}
		scheduled, verified, report, err := service.beginGoalVerification(stream, goal, completion)
		if err != nil {
			return false, err
		}
		if scheduled {
			return true, service.publishCheckpoint(requestID, conversationID)
		}
		return service.finishGoalVerification(stream, goal, completion, verified, report)
	}
	// The last admitted pass is allowed to prove completion. Budget limits block
	// subsequent provider dispatches; they do not discard an already-produced result.
	if exceeded, reason := goalBudgetExceeded(goal, cfg); exceeded {
		return true, service.stopGoalForBudget(stream, goal, reason)
	}

	appended, err := service.appendGoalPromptContext(stream, conversationID, turnSeq, requestID, goalContinuationSource(promptContextSourceGoalIdle, providerPass), goalIdleReminder(goal, goal.consecutiveIdle).Message.Content)
	if err != nil {
		return false, err
	}
	if !appended {
		return false, nil
	}
	// 每 ProgressInterval 个 pass 推一次进度摘要。
	if cfg.ProgressInterval > 0 && goal.ProviderPasses%cfg.ProgressInterval == 0 {
		service.emitGoalProgress(stream, goal)
	}
	if err := service.syncSummaryCarryForward(conversationID, requestID, modelCallID); err != nil {
		return true, err
	}
	if err := service.publishCheckpoint(requestID, conversationID); err != nil {
		return true, err
	}
	return true, service.requestProviderAction(stream, providerActionResume)
}

func (service *Service) finishGoalVerification(stream *ActiveStream, goal *GoalState, completion pendingTurnCompletion, verified bool, report string) (bool, error) {
	if goal == nil {
		return false, nil
	}
	if verified {
		goal.Status = GoalStatusCompleted
		goal.CompletionText = truncateText(report, 2000)
		goal.StopReason = ""
		if err := service.emitGoalCompletion(stream, goal, "completed"); err != nil {
			return true, err
		}
		return true, service.completeSuccessfulTurn(stream, completion)
	}
	cfg := service.currentGoalConfig()
	if goal.RetryCount >= cfg.VerifyMaxRetries {
		goal.Status = GoalStatusFailed
		goal.StopReason = fmt.Sprintf("校验子代理连续 %d 次判定目标未达成", goal.RetryCount)
		goal.CompletionText = truncateText(report, 2000)
		if err := service.emitGoalCompletion(stream, goal, "failed"); err != nil {
			return true, err
		}
		return true, service.completeSuccessfulTurn(stream, completion)
	}
	goal.RetryCount++
	goal.consecutiveIdle = 0
	feedback := report
	if goal.RetryCount >= goalStalePivotThreshold {
		goal.StaleCount++
		feedback = fmt.Sprintf("%s\n\n已连续 %d 次未通过校验：请结构性换策略（改变入口点、任务分解或验证方式），不要重复同一做法。", feedback, goal.StaleCount)
	}
	appended, err := service.appendGoalPromptContext(stream, completion.ConversationID, completion.TurnSeq, completion.RequestID, goalContinuationSource(promptContextSourceGoalVerifyFeedback, completion.ProviderPass), goalVerifyFeedbackReminder(goal, feedback).Message.Content)
	if err != nil {
		return true, err
	}
	if !appended {
		goal.Status = GoalStatusFailed
		goal.StopReason = "无法持久化新的校验恢复上下文"
		goal.CompletionText = truncateText(report, 2000)
		if err := service.emitGoalCompletion(stream, goal, "failed"); err != nil {
			return true, err
		}
		return true, service.completeSuccessfulTurn(stream, completion)
	}
	if err := service.emitGoalProgress(stream, goal); err != nil {
		return true, err
	}
	if err := service.syncSummaryCarryForward(completion.ConversationID, completion.RequestID, completion.ModelCallID); err != nil {
		return true, err
	}
	if err := service.publishCheckpoint(completion.RequestID, completion.ConversationID); err != nil {
		return true, err
	}
	return true, service.requestProviderAction(stream, providerActionResume)
}

// emitGoalProgress 向对话流注入一条 goal 进度摘要（summary 事件，Cursor 左侧摘要区可见）。
func (service *Service) emitGoalProgress(stream *ActiveStream, goal *GoalState) error {
	if service == nil || stream == nil || goal == nil {
		return nil
	}
	text := fmt.Sprintf("⏳ Goal 进度：pass %d | 工具调用 %d | 自检 %d 次%s", goal.ProviderPasses, goal.ToolCalls, goal.SelfChecks, progressSuffix(goal))
	return service.publishSummaryEvents(stream, text)
}

func progressSuffix(goal *GoalState) string {
	if strings.TrimSpace(goal.LastProgress) == "" {
		return ""
	}
	return " | 最近进展：" + goal.LastProgress
}

// emitGoalCompletion 在 goal 收口时向对话流注入最终汇报（可见 assistant 文本）。
func (service *Service) emitGoalCompletion(stream *ActiveStream, goal *GoalState, kind string) error {
	if service == nil || stream == nil || goal == nil {
		return nil
	}
	var text string
	switch kind {
	case "completed":
		text = fmt.Sprintf("✅ Goal 已完成：%s\n\n%s", goal.GoalText, firstNonEmpty(goal.CompletionText, "目标已达成。"))
	case "budget":
		text = fmt.Sprintf("⏹️ Goal 因预算上限停止：%s\n%s", goal.GoalText, firstNonEmpty(goal.StopReason, "预算超限。"))
	case "failed":
		text = fmt.Sprintf("❌ Goal 失败：%s\n%s", goal.GoalText, firstNonEmpty(goal.StopReason, "多次校验未通过。"))
	default:
		text = fmt.Sprintf("Goal 状态更新：%s", goal.StopReason)
	}
	return service.broker.Publish(stream.RequestID, StreamEvent{Message: buildTextDeltaMessage(text)})
}

// publishSummaryEvents 按 SummaryStarted → Summary → SummaryCompleted 顺序推送。
func (service *Service) publishSummaryEvents(stream *ActiveStream, text string) error {
	if err := service.broker.Publish(stream.RequestID, StreamEvent{Message: buildSummaryStartedMessage()}); err != nil {
		return err
	}
	if err := service.broker.Publish(stream.RequestID, StreamEvent{Message: buildSummaryMessage(text)}); err != nil {
		return err
	}
	return service.broker.Publish(stream.RequestID, StreamEvent{Message: buildSummaryCompletedMessage(stream.RequestID)})
}

// goalErrorRetryReminder 是 provider 错误重试时注入的提示文案。
func goalErrorRetryReminder(errText string) PromptContextMessage {
	return newPromptContextReminder(promptContextSourceGoalErrorRetry,
		fmt.Sprintf("上一轮 provider 调用出错：%s\n请分析错误原因，换一种方式继续执行，直到完成目标。", truncateText(errText, 300)))
}

// errTextOf 提取错误文本。
func errTextOf(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// handleGoalProviderError 在 goal 模式下把 provider 错误转为"注入错误摘要 + 续跑重试"，
// 超过 ErrorMaxRetries 才放行给 failStream。返回 (true, nil) 表示已重试（调用方 return）。
func (service *Service) handleGoalProviderError(stream *ActiveStream, conversationID string, turnSeq int64, requestID, modelCallID string, providerPass int, err error) (bool, error) {
	goal := stream.Goal
	if goal == nil {
		return false, nil
	}
	cfg := service.currentGoalConfig()
	if goal.ErrorRetries >= cfg.ErrorMaxRetries {
		return false, nil
	}
	goal.ErrorRetries++
	goal.ProviderPasses = providerPass
	goal.UpdatedAt = time.Now().UTC()
	appended, appendErr := service.appendGoalPromptContext(stream, conversationID, turnSeq, requestID, goalContinuationSource(promptContextSourceGoalErrorRetry, providerPass), goalErrorRetryReminder(errTextOf(err)).Message.Content)
	if appendErr != nil {
		return false, appendErr
	}
	if !appended {
		return false, nil // 已注入过同类提示，走 failStream 收口
	}
	if service.debug != nil {
		service.debug.LogRuntime(context.Background(), requestID, conversationID, "goal_error_retry", map[string]any{
			"provider_pass": providerPass,
			"retry_count":   goal.ErrorRetries,
			"error":         truncateText(errTextOf(err), 300),
		})
	}
	if err := service.syncSummaryCarryForward(conversationID, requestID, modelCallID); err != nil {
		return true, err
	}
	if err := service.publishCheckpoint(requestID, conversationID); err != nil {
		return true, err
	}
	return true, service.requestProviderAction(stream, providerActionResume)
}
