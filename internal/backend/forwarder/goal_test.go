package forwarder

import (
	"context"
	"strings"
	"testing"
	"time"

	agentv1 "cursor/gen/agentv1"
	modeladapter "cursor/internal/backend/agent/model"
	"cursor/internal/backend/delegation"
	"cursor/internal/historymetrics"
)

func TestNewGoalState(t *testing.T) {
	state := newGoalState("conv-1", "  修复所有测试  ", false)
	if state.ConversationID != "conv-1" {
		t.Fatalf("conversation id = %q, want conv-1", state.ConversationID)
	}
	if state.GoalText != "修复所有测试" {
		t.Fatalf("goal text = %q, want trimmed", state.GoalText)
	}
	if state.Status != GoalStatusRunning {
		t.Fatalf("status = %q, want running", state.Status)
	}
	if state.StartedAt.IsZero() || state.UpdatedAt.IsZero() {
		t.Fatal("timestamps must be set")
	}
}

func TestDefaultGoalRuntimeConfig(t *testing.T) {
	cfg := defaultGoalRuntimeConfig()
	if cfg.MaxProviderPasses != 30 {
		t.Fatalf("max provider passes = %d, want 30", cfg.MaxProviderPasses)
	}
	if cfg.SelfCheckPasses != 2 {
		t.Fatalf("self check passes = %d, want 2", cfg.SelfCheckPasses)
	}
	if cfg.VerifyMaxRetries != 3 || cfg.ErrorMaxRetries != 3 {
		t.Fatalf("retry defaults wrong: verify=%d error=%d", cfg.VerifyMaxRetries, cfg.ErrorMaxRetries)
	}
	if cfg.ProgressInterval != 5 {
		t.Fatalf("progress interval = %d, want 5", cfg.ProgressInterval)
	}
	if cfg.MaxDuration != 0 || cfg.MaxCostUSD != 0 || cfg.Enabled {
		t.Fatalf("unlimited/defaults wrong: %+v", cfg)
	}
}

func TestParseGoalCommand(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		wantText   string
		wantStrict bool
		wantGoal   bool
	}{
		{"slash goal", "/goal 修复登录 bug", "修复登录 bug", false, true},
		{"hash goal", "#goal 跑通全部单测", "跑通全部单测", false, true},
		{"uppercase", "/GOAL 重构模块", "重构模块", false, true},
		{"strict", "/goal --strict 实现支付流程", "实现支付流程", true, true},
		{"goal empty", "/goal   ", "", false, false},
		{"no prefix", "修复登录 bug", "", false, false},
		{"prefix in middle", "请 /goal 修复", "", false, false},
		{"goal colon", "goal: 整理依赖", "整理依赖", false, true},
		{"goal colon without whitespace", "goal:整理依赖", "整理依赖", false, true},
		{"plural is ordinary text", "/goals investigate", "", false, false},
		{"suffix is ordinary text", "#goalpost investigate", "", false, false},
		{"strict prefix collision stays goal text", "/goal --strictly investigate", "--strictly investigate", false, true},
		{"strict token delimiter", "/goal\t--STRICT\tinvestigate", "investigate", true, true},
		{"goal prefix requires delimiter", "/goal--strict investigate", "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotText, gotStrict, gotGoal := parseGoalCommand(tc.input)
			if gotText != tc.wantText || gotStrict != tc.wantStrict || gotGoal != tc.wantGoal {
				t.Fatalf("parseGoalCommand(%q) = (%q, %v, %v), want (%q, %v, %v)", tc.input, gotText, gotStrict, gotGoal, tc.wantText, tc.wantStrict, tc.wantGoal)
			}
		})
	}
}

// TestApplyGoalCommandIfEnabled 覆盖 goal 开关语义：
// enabled=false 时 /goal 与 /goal --strict 均不被识别，消息原样保留（普通对话）；
// enabled=true 时正常识别并剥离前缀。
func TestApplyGoalCommandIfEnabled(t *testing.T) {
	cases := []struct {
		name         string
		text         string
		enabled      bool
		alreadyGoal  bool
		wantGoalMode bool
		wantText     string
		wantStrict   bool
		wantMsg      string // 期望保留在 UserMessage 中的文本（关闭/未命中时）
	}{
		{"disabled slash goal", "/goal 修复登录 bug", false, false, false, "", false, "/goal 修复登录 bug"},
		{"disabled strict goal", "/goal --strict 实现支付流程", false, false, false, "", false, "/goal --strict 实现支付流程"},
		{"disabled plain message", "修复登录 bug", false, false, false, "", false, "修复登录 bug"},
		{"enabled slash goal", "/goal 修复登录 bug", true, false, true, "修复登录 bug", false, "修复登录 bug"},
		{"enabled strict goal", "/goal --strict 实现支付流程", true, false, true, "实现支付流程", true, "实现支付流程"},
		{"enabled plain message", "修复登录 bug", true, false, false, "", false, "修复登录 bug"},
		{"already goal mode", "/goal 修复登录 bug", true, true, true, "", false, "/goal 修复登录 bug"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			intent := &InboundIntent{
				GoalMode:    tc.alreadyGoal,
				UserMessage: &agentv1.UserMessage{Text: tc.text},
			}
			applyGoalCommandIfEnabled(intent, tc.enabled)
			if intent.GoalMode != tc.wantGoalMode {
				t.Fatalf("GoalMode = %v, want %v", intent.GoalMode, tc.wantGoalMode)
			}
			if intent.GoalText != tc.wantText {
				t.Fatalf("GoalText = %q, want %q", intent.GoalText, tc.wantText)
			}
			if intent.GoalStrict != tc.wantStrict {
				t.Fatalf("GoalStrict = %v, want %v", intent.GoalStrict, tc.wantStrict)
			}
			if gotMsg := userMessageText(intent.UserMessage); gotMsg != tc.wantMsg {
				t.Fatalf("UserMessage = %q, want %q", gotMsg, tc.wantMsg)
			}
		})
	}
}

func TestHasStandaloneGoalCompletionMarker(t *testing.T) {
	for _, tc := range []struct {
		text string
		want bool
	}{
		{"[goal:complete]", true},
		{"progress\n [GOAL:COMPLETE] \nreport", true},
		{"I have not reached [goal:complete] yet.", false},
		{"`[goal:complete]`", false},
		{"[goal:completed]", false},
		{"[goal:complete] report", false},
	} {
		if got := hasStandaloneGoalCompletionMarker(tc.text); got != tc.want {
			t.Fatalf("hasStandaloneGoalCompletionMarker(%q) = %v, want %v", tc.text, got, tc.want)
		}
	}
}

func TestGoalSystemPromptFragment(t *testing.T) {
	goal := &GoalState{GoalText: "修复全部测试"}
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxProviderPasses = 10
	frag := goalSystemPromptFragment(goal, cfg)
	for _, want := range []string{"GOAL", "修复全部测试", "10 轮", "自检", "失败", "完成报告"} {
		if !strings.Contains(frag, want) {
			t.Fatalf("fragment missing %q: %s", want, frag)
		}
	}
	if frag := goalSystemPromptFragment(nil, cfg); frag != "" {
		t.Fatalf("nil goal must produce empty fragment, got %q", frag)
	}
	if frag := goalSystemPromptFragment(&GoalState{GoalText: "  "}, cfg); frag != "" {
		t.Fatalf("blank goal must produce empty fragment, got %q", frag)
	}
}

func TestJoinNonEmpty(t *testing.T) {
	if got := joinNonEmpty("a", "", "b", "  "); got != "a\n\nb" {
		t.Fatalf("joinNonEmpty = %q, want %q", got, "a\n\nb")
	}
	if got := joinNonEmpty("", ""); got != "" {
		t.Fatalf("joinNonEmpty all empty = %q, want empty", got)
	}
}

func TestGoalBudgetExceeded(t *testing.T) {
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxProviderPasses = 5
	goal := &GoalState{ProviderPasses: 4}
	if exceeded, _ := goalBudgetExceeded(goal, cfg); exceeded {
		t.Fatal("pass 4 of 5 must not exceed")
	}
	goal.ProviderPasses = 5
	if exceeded, reason := goalBudgetExceeded(goal, cfg); !exceeded || reason == "" {
		t.Fatalf("pass 5 of 5 must exceed, got exceeded=%v reason=%q", exceeded, reason)
	}
	unlimited := defaultGoalRuntimeConfig()
	unlimited.MaxProviderPasses = 0 // 0 = 不限
	goal.ProviderPasses = 999
	if exceeded, _ := goalBudgetExceeded(goal, unlimited); exceeded {
		t.Fatal("unlimited passes must never exceed")
	}
	durCfg := defaultGoalRuntimeConfig()
	durCfg.MaxDuration = time.Minute
	old := &GoalState{StartedAt: time.Now().UTC().Add(-2 * time.Minute), ProviderPasses: 1}
	if exceeded, _ := goalBudgetExceeded(old, durCfg); !exceeded {
		t.Fatal("started 2m ago with 1m budget must exceed")
	}
}

func TestGoalProviderAdmissionRespectsPassDurationAndCostBudgets(t *testing.T) {
	goal := newGoalState("conversation", "test", false)
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxProviderPasses = 1
	if exceeded, _ := goalProviderAdmissionExceeded(goal, cfg, 0); exceeded {
		t.Fatal("first provider pass must be admitted")
	}
	if exceeded, _ := goalProviderAdmissionExceeded(goal, cfg, 1); !exceeded {
		t.Fatal("second provider pass must be denied at a one-pass budget")
	}
	cfg.MaxProviderPasses = 0
	cfg.MaxDuration = time.Minute
	goal.StartedAt = time.Now().Add(-2 * time.Minute)
	if exceeded, _ := goalProviderAdmissionExceeded(goal, cfg, 0); !exceeded {
		t.Fatal("expired Goal duration must deny a new provider pass")
	}
	cfg.MaxDuration = 0
	cfg.MaxCostUSD = 1
	goal.StartedAt = time.Now()
	goal.addProviderCostOnce("request", 1, "call", 1)
	if exceeded, _ := goalProviderAdmissionExceeded(goal, cfg, 0); !exceeded {
		t.Fatal("reached Goal cost budget must deny a new provider pass")
	}
}

func TestGoalIdleReminder(t *testing.T) {
	goal := &GoalState{GoalText: "修复测试"}
	msg := goalIdleReminder(goal, 1)
	if msg.Source != promptContextSourceGoalIdle {
		t.Fatalf("source = %q", msg.Source)
	}
	if !strings.Contains(msg.Message.Content, "修复测试") {
		t.Fatalf("reminder missing goal text: %q", msg.Message.Content)
	}
	if !strings.Contains(msg.Message.Content, "连续 1 轮") {
		t.Fatalf("reminder missing idle count: %q", msg.Message.Content)
	}
	escalated := goalIdleReminder(goal, goalStalePivotThreshold)
	if !strings.Contains(escalated.Message.Content, "换策略") {
		t.Fatalf("escalated reminder missing pivot instruction: %q", escalated.Message.Content)
	}
}

func TestGoalVerifyFeedbackReminder(t *testing.T) {
	goal := &GoalState{GoalText: "修复测试"}
	msg := goalVerifyFeedbackReminder(goal, "仍有 3 个用例失败")
	if msg.Source != promptContextSourceGoalVerifyFeedback {
		t.Fatalf("source = %q", msg.Source)
	}
	if !strings.Contains(msg.Message.Content, "仍有 3 个用例失败") {
		t.Fatalf("feedback missing report: %q", msg.Message.Content)
	}
}

func TestParseVerifyDecision(t *testing.T) {
	cases := []struct {
		name       string
		output     string
		wantVer    bool
		wantReport string
	}{
		{"verified", "VERIFIED\n测试全部通过，无回归。", true, "测试全部通过，无回归。"},
		{"not verified", "NOT_VERIFIED\n仍有 3 个用例失败。", false, "仍有 3 个用例失败。"},
		{"lowercase", "verified\nok", true, "ok"},
		{"blank", "", false, ""},
		{"no marker", "测试全部通过", false, "测试全部通过"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotVer, gotReport := parseVerifyDecision(tc.output)
			if gotVer != tc.wantVer || gotReport != tc.wantReport {
				t.Fatalf("parseVerifyDecision(%q) = (%v, %q), want (%v, %q)", tc.output, gotVer, gotReport, tc.wantVer, tc.wantReport)
			}
		})
	}
}

func TestGoalVerifyPrompt(t *testing.T) {
	p := goalVerifyPrompt(&GoalState{GoalText: "跑通全部单测"})
	for _, want := range []string{"VERIFIED", "NOT_VERIFIED", "跑通全部单测", "只读"} {
		if !strings.Contains(p, want) {
			t.Fatalf("verify prompt missing %q", want)
		}
	}
}

func TestTruncateText(t *testing.T) {
	if got := truncateText("你好世界", 2); got != "你好…" {
		t.Fatalf("truncateText = %q", got)
	}
	if got := truncateText("abc", 10); got != "abc" {
		t.Fatalf("truncateText short = %q", got)
	}
	if got := truncateText("", 5); got != "" {
		t.Fatalf("truncateText empty = %q", got)
	}
}

func TestGoalCostLedgerAndProviderModelPricing(t *testing.T) {
	inputRate, outputRate := 1.0, 2.0
	estimator := &defaultUsageCostEstimator{lookup: historymetrics.NewPriceLookup([]historymetrics.PriceRate{{
		Model:    "provider-model",
		Provider: "priced",
		BaseURL:  "https://priced.example/v1",
		Input:    &inputRate,
		Output:   &outputRate,
		Currency: "USD",
		Known:    true,
	}})}
	usage := turnUsageSnapshot{
		Role:         "parent",
		UsagePresent: true,
		BillingModel: "provider-model",
		LogicalModel: "Display Name",
		Provider:     "priced",
		BaseURL:      "https://priced.example/v1",
		InputTokens:  1_000_000,
		OutputTokens: 1_000_000,
	}
	cost, ok := estimator.Cost(usage)
	if !ok || cost != 3 {
		t.Fatalf("estimator cost = %v, %v; want 3, true", cost, ok)
	}
	goal := newGoalState("conversation", "test", false)
	if total, added := goal.addProviderCostOnce("request", 1, "call-1", cost); !added || total != 3 {
		t.Fatalf("first cost ledger update = %v, %v; want 3, true", total, added)
	}
	if total, added := goal.addProviderCostOnce("request", 1, "call-1", cost); added || total != 3 {
		t.Fatalf("duplicate cost ledger update = %v, %v; want 3, false", total, added)
	}
	if total, added := goal.addProviderCostOnce("request", 1, "call-2", cost); !added || total != 6 {
		t.Fatalf("second cost ledger update = %v, %v; want 6, true", total, added)
	}
}

type goalConfigStub struct {
	cfg GoalRuntimeConfig
}

func (stub goalConfigStub) GoalRuntimeConfig() GoalRuntimeConfig {
	return stub.cfg
}

func TestHandleProviderDoneAccountsGoalUsageBeforeStreamReset(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	conversation := testConversation([]HistoryEntry{
		testUserMessageEntry(t, 1, "request-goal-cost", "完成测试"),
	})
	persisted, err := store.SaveConversationWithEntries(conversation.ConversationID, conversation, conversation.Entries)
	if err != nil {
		t.Fatalf("SaveConversationWithEntries() error = %v", err)
	}
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), nil, nil, broker)
	inputRate := 1.0
	service.usageCostEstimator = &defaultUsageCostEstimator{lookup: historymetrics.NewPriceLookup([]historymetrics.PriceRate{{
		Model: "priced-model", Provider: "priced", Input: &inputRate, Currency: "USD", Known: true,
	}})}
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxCostUSD = 0.0005
	service.goalConfig = goalConfigStub{cfg: cfg}
	stream, err := broker.OpenStream("request-goal-cost", persisted.ConversationID, 1, "model-a", "display-name", agentv1.AgentMode_AGENT_MODE_AGENT, "完成测试")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	stream.CheckpointConversation = cloneConversationFile(persisted)
	stream.CurrentModelCallID = "goal-cost-call"
	stream.ProviderPassCount = 1
	stream.Status = StreamStatusStreaming
	stream.Goal = newGoalState(persisted.ConversationID, "完成测试", false)
	if err := service.applyProviderModelEvent(stream, modeladapter.ModelEvent{
		Kind:         modeladapter.ModelEventKindTurnFinished,
		FinishReason: "stop",
		Provider:     "priced",
		Model:        "priced-model",
		BillingModel: "priced-model",
		InputTokens:  1_000,
		UsagePresent: true,
	}); err != nil {
		t.Fatalf("apply turn finished: %v", err)
	}
	if err := service.handleProviderDoneEvent(stream, &streamProviderEvent{}); err != nil {
		t.Fatalf("handleProviderDoneEvent() error = %v", err)
	}
	if got := stream.Goal.costEstimateUSD(); got != 0.001 {
		t.Fatalf("Goal CostEstimateUSD = %v, want 0.001", got)
	}
	if stream.Goal.Status != GoalStatusBudgetExceeded {
		t.Fatalf("Goal status = %q, want %q", stream.Goal.Status, GoalStatusBudgetExceeded)
	}
}

func TestForcedTurnClearsPriorGoalState(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), nil, nil, broker)
	stream, err := broker.OpenStream("request-reset", "conversation-reset", 1, "model-a", "model-a", agentv1.AgentMode_AGENT_MODE_AGENT, "old goal")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	stream.Goal = newGoalState("conversation-reset", "old goal", true)
	if err := service.prepareStreamForForcedTurn(InboundIntent{RequestID: "request-reset", ForceNewTurn: true}); err != nil {
		t.Fatalf("prepareStreamForForcedTurn() error = %v", err)
	}
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.Goal != nil {
		t.Fatalf("forced ordinary turn retained Goal state: %+v", stream.Goal)
	}
	if stream.Status != StreamStatusCreated || stream.Phase != TurnPhaseIdle {
		t.Fatalf("forced turn state = status=%q phase=%q", stream.Status, stream.Phase)
	}
}

func TestGoalCanCompleteOnFinalAdmittedPass(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	conversation := testConversation([]HistoryEntry{
		testUserMessageEntry(t, 1, "request-final-pass", "finish"),
	})
	persisted, err := store.SaveConversationWithEntries(conversation.ConversationID, conversation, conversation.Entries)
	if err != nil {
		t.Fatalf("SaveConversationWithEntries() error = %v", err)
	}
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), nil, nil, broker)
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxProviderPasses = 1
	service.goalConfig = goalConfigStub{cfg: cfg}
	stream, err := broker.OpenStream("request-final-pass", persisted.ConversationID, 1, "model-a", "model-a", agentv1.AgentMode_AGENT_MODE_AGENT, "finish")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	stream.CheckpointConversation = cloneConversationFile(persisted)
	stream.Status = StreamStatusStreaming
	stream.Goal = newGoalState(persisted.ConversationID, "finish", false)
	handled, err := service.handleGoalPassFinished(stream, persisted.ConversationID, 1, stream.RequestID, "final-pass-call", 1, "stop", "[goal:complete]\nfinished", false, turnUsageSnapshot{Role: "parent"})
	if err != nil || !handled {
		t.Fatalf("handleGoalPassFinished() = (%v, %v)", handled, err)
	}
	if stream.Goal.Status != GoalStatusCompleted {
		t.Fatalf("Goal status = %q, want %q", stream.Goal.Status, GoalStatusCompleted)
	}
}

func TestDriveProviderStopsGoalBeforeExceedingPassBudget(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	conversation := testConversation([]HistoryEntry{
		testUserMessageEntry(t, 1, "request-budget", "continue"),
	})
	persisted, err := store.SaveConversationWithEntries(conversation.ConversationID, conversation, conversation.Entries)
	if err != nil {
		t.Fatalf("SaveConversationWithEntries() error = %v", err)
	}
	provider := &contextProjectionRequestProvider{requests: make(chan ProviderRequest, 1)}
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), contextProjectionLifecycleCompiler{}, provider, broker)
	cfg := defaultGoalRuntimeConfig()
	cfg.MaxProviderPasses = 1
	service.goalConfig = goalConfigStub{cfg: cfg}
	stream, err := broker.OpenStream("request-budget", persisted.ConversationID, 1, "model-a", "model-a", agentv1.AgentMode_AGENT_MODE_AGENT, "continue")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	stream.CheckpointConversation = cloneConversationFile(persisted)
	stream.ProviderPassCount = 1
	stream.Goal = newGoalState(persisted.ConversationID, "continue", false)
	if err := service.driveProvider(stream); err != nil {
		t.Fatalf("driveProvider() error = %v", err)
	}
	if stream.Goal.Status != GoalStatusBudgetExceeded {
		t.Fatalf("Goal status = %q, want %q", stream.Goal.Status, GoalStatusBudgetExceeded)
	}
	select {
	case <-provider.requests:
		t.Fatal("provider received a forbidden pass after Goal budget exhaustion")
	default:
	}
}

func TestGoalVerificationSchedulesAndCancelsWithoutBlocking(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), nil, nil, broker)
	started := make(chan struct{}, 1)
	blockingScheduler := delegation.NewScheduler(delegation.Config{MaxConcurrency: 1}, func(ctx context.Context, _ delegation.TaskRequest) delegation.TaskResult {
		started <- struct{}{}
		<-ctx.Done()
		return delegation.TaskResult{Error: ctx.Err()}
	})
	defer blockingScheduler.Close()
	coordinator := service.multitaskDelegation
	coordinator.mu.Lock()
	originalScheduler := coordinator.scheduler
	coordinator.scheduler = blockingScheduler
	coordinator.mu.Unlock()
	defer originalScheduler.Close()
	stream, err := broker.OpenStream("request-async-verify", "conversation-async-verify", 1, "model-a", "model-a", agentv1.AgentMode_AGENT_MODE_AGENT, "verify")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	stream.WorkspacePaths = []string{t.TempDir()}
	goal := newGoalState("conversation-async-verify", "verify", true)
	stream.Goal = goal
	completion := pendingTurnCompletion{ConversationID: stream.ConversationID, RequestID: stream.RequestID, TurnSeq: stream.TurnSeq, ModelCallID: "verify-call", ProviderPass: 1}
	scheduled, _, _, err := service.beginGoalVerification(stream, goal, completion)
	if err != nil || !scheduled {
		t.Fatalf("beginGoalVerification() = (%v, %v)", scheduled, err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("verification executor did not start")
	}
	stream.mu.Lock()
	lease := stream.PendingGoalVerification
	taskID := lease.TaskID
	stream.mu.Unlock()
	if !service.cancelOwnedGoalVerifier(stream) {
		t.Fatal("cancelOwnedGoalVerifier() did not own the scheduled task")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := blockingScheduler.WaitForTerminal(ctx, []string{taskID}); err != nil {
		t.Fatalf("WaitForTerminal() error = %v", err)
	}
	snapshot, ok := blockingScheduler.Snapshot(taskID)
	if !ok || snapshot.Status != delegation.TaskCanceled {
		t.Fatalf("canceled verifier snapshot = %+v", snapshot)
	}
	stream.mu.Lock()
	if stream.PendingGoalVerification != nil {
		stream.mu.Unlock()
		t.Fatal("canceled verifier remained attached to stream")
	}
	stream.mu.Unlock()
	if err := service.handleGoalVerifyResult(stream, &streamGoalVerifyResult{
		Token: lease.Token, TaskID: lease.TaskID, RequestID: lease.RequestID, ConversationID: lease.ConversationID,
		TurnSeq: lease.TurnSeq, ProviderPass: lease.ProviderPass, ModelCallID: lease.ModelCallID, Verified: true, Report: "late result",
	}); err != nil {
		t.Fatalf("handleGoalVerifyResult() error = %v", err)
	}
	if goal.Status != GoalStatusRunning {
		t.Fatalf("late verifier result changed Goal status to %q", goal.Status)
	}
}

func TestGoalVerifierRequiresWorkspaceBeforeScheduling(t *testing.T) {
	store := NewConversationFileStore(t.TempDir())
	broker := NewStreamBroker()
	service := newServiceWithDependencies(store, NewHistoryProjector(), nil, nil, broker)
	stream, err := broker.OpenStream("request-verify", "conversation-verify", 1, "model-a", "model-a", agentv1.AgentMode_AGENT_MODE_AGENT, "verify")
	if err != nil {
		t.Fatalf("OpenStream() error = %v", err)
	}
	completion := pendingTurnCompletion{ConversationID: "conversation-verify", RequestID: "request-verify", TurnSeq: 1, ModelCallID: "verify-call", ProviderPass: 1}
	nonStrictScheduled, nonStrictVerified, nonStrictReport, err := service.beginGoalVerification(stream, newGoalState("conversation-verify", "verify", false), completion)
	if err != nil || nonStrictScheduled || !nonStrictVerified || !strings.Contains(nonStrictReport, "未提供可验证的工作区") {
		t.Fatalf("non-strict workspace fallback = (%v, %v, %q, %v)", nonStrictScheduled, nonStrictVerified, nonStrictReport, err)
	}
	strictScheduled, strictVerified, strictReport, err := service.beginGoalVerification(stream, newGoalState("conversation-verify", "verify", true), completion)
	if err != nil || strictScheduled || strictVerified || !strings.Contains(strictReport, "未提供可验证的工作区") {
		t.Fatalf("strict workspace fallback = (%v, %v, %q, %v)", strictScheduled, strictVerified, strictReport, err)
	}
}

func TestGoalContinuationSourcesArePassScoped(t *testing.T) {
	first := goalContinuationSource(promptContextSourceGoalIdle, 1)
	if first != goalContinuationSource(promptContextSourceGoalIdle, 1) {
		t.Fatal("same continuation pass must be idempotent")
	}
	if first == goalContinuationSource(promptContextSourceGoalIdle, 2) {
		t.Fatal("different continuation passes must have different sources")
	}
	if !isGoalContinuationPromptContextSource(first) || !isGoalContinuationPromptContextSource(promptContextSourceGoalVerifyFeedback) {
		t.Fatal("recognized Goal continuation sources must be classified")
	}
	if isGoalContinuationPromptContextSource("goal_custom/pass/1") {
		t.Fatal("unknown goal-shaped source must not be classified as a continuation")
	}
}

func TestGoalContinuationContextsExpireOutsideOwningTurn(t *testing.T) {
	conversation := &ConversationFile{
		CurrentTurnSeq: 2,
		NextTurnSeq:    3,
		Entries: []HistoryEntry{
			newPromptContextEntry(1, "request-1", PromptContextMessage{Source: goalContinuationSource(promptContextSourceGoalIdle, 1), Message: modeladapter.Message{Role: "user", Content: "expired goal control"}}),
			newPromptContextEntry(1, "request-1", PromptContextMessage{Source: "ordinary_context", Message: modeladapter.Message{Role: "user", Content: "ordinary history remains"}}),
			newPromptContextEntry(2, "request-2", PromptContextMessage{Source: goalContinuationSource(promptContextSourceGoalIdle, 2), Message: modeladapter.Message{Role: "user", Content: "current goal control"}}),
		},
	}
	messages, err := NewHistoryProjector().ProjectPromptReplay(conversation)
	if err != nil {
		t.Fatalf("ProjectPromptReplay() error = %v", err)
	}
	contents := make([]string, 0, len(messages))
	for _, message := range messages {
		contents = append(contents, message.Content)
	}
	joined := strings.Join(contents, "\n")
	if strings.Contains(joined, "expired goal control") {
		t.Fatalf("expired Goal continuation leaked into replay: %q", joined)
	}
	if !strings.Contains(joined, "ordinary history remains") || !strings.Contains(joined, "current goal control") {
		t.Fatalf("replay dropped active or ordinary contexts: %q", joined)
	}
	if len(conversation.Entries) != 3 {
		t.Fatal("projection must not delete Goal continuation history")
	}
}

func TestGoalErrorRetryReminder(t *testing.T) {
	reminder := goalErrorRetryReminder("upstream 429")
	if !strings.Contains(reminder.Message.Content, "429") {
		t.Fatalf("reminder missing error text: %q", reminder.Message.Content)
	}
	if !strings.Contains(reminder.Message.Content, "继续") {
		t.Fatalf("reminder missing retry instruction: %q", reminder.Message.Content)
	}
}
