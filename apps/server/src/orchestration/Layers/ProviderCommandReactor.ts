import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  type MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type ThreadGoal,
  type SpecWorkflowCapability,
  type SpecWorkflowState,
  type TurnId,
} from "@codework/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@codework/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@codework/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { isByokNativeSlashInput } from "../../provider/byok/ByokSlashCommands.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { forkParked, ServerActivation } from "../../serverActivation.ts";
import { canReplaceThreadTitle, DEFAULT_THREAD_TITLE } from "../threadTitles.ts";
import {
  resolveSourceControlWriterModelSelection,
  ServerSettingsService,
} from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ThreadGoalStore } from "../../persistence/Services/ThreadGoalStore.ts";
import { SpecWorkflowCapabilityStore } from "../../persistence/Services/SpecWorkflowCapabilityStore.ts";
import { SpecWorkflowService } from "../../specWorkflow/SpecWorkflowService.ts";
import { formatSpecWorkflowSelectedInput } from "../../specWorkflow/SpecWorkflowAgentProtocol.ts";
import { WorkspaceOperationLock } from "../WorkspaceOperationLock.ts";
import { projectActivityPayload } from "../ActivityPayloadProjection.ts";
import {
  evaluateRestartContinuationEligibility,
  isRestartDeadProviderSession,
  ORPHANED_PROVIDER_SESSION_ERROR,
  readRestartContinuationIntent,
  RESTART_CONTINUATION_PAYLOAD_KEY,
  RESTART_CONTINUATION_PROMPT,
  restartContinuationCommandId,
  restartContinuationMessageId,
  restartContinuationSessionSetCommandId,
} from "../restartContinuation.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
class ThreadGoalBudgetExhaustedError extends Schema.TaggedError<ThreadGoalBudgetExhaustedError>()(
  "ThreadGoalBudgetExhaustedError",
  {},
) {
  override get message() {
    return "任务目标预算已耗尽，请增加预算或清除目标后再启动下一轮。";
  }
}
const isThreadGoalBudgetExhaustedError = Schema.is(ThreadGoalBudgetExhaustedError);
const PROVIDER_SWITCH_WHILE_RUNNING_DETAIL =
  "Cannot switch providers while a turn is running. Wait for it to finish or stop it first.";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.turn-start-cancelled"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-set"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function formatThreadGoalProviderInput(
  goal: Pick<ThreadGoal, "objective" | "status" | "timeUsedSeconds" | "tokensUsed" | "tokenBudget">,
  userInput: string | undefined,
): string {
  // Codex update_plan 式收尾机制：是否达成由模型在回合末自报显式标记，
  // 服务端在回合终帧扫描标记并自动收敛 Goal 状态（见 ProviderRuntimeIngestion）。
  // “发送目标”会以目标文本本身发起首轮回合，此时不再重复 [User Request] 段。
  const goalStatusLabels: Record<ThreadGoal["status"], string> = {
    active: "执行中",
    paused: "已暂停",
    blocked: "需要处理",
    usageLimited: "已达 token 预算上限（已暂停执行）",
    budgetLimited: "已达预算上限（已暂停执行）",
    complete: "已完成",
  };
  const lines = [
    "[Thread Goal]",
    `目标：${goal.objective}`,
    `状态：${goalStatusLabels[goal.status]}`,
    `累计用时：${goal.timeUsedSeconds} 秒`,
    `token 用量：${goal.tokensUsed}${goal.tokenBudget === null ? "" : ` / ${goal.tokenBudget}`}`,
    "",
    "Keep working toward this goal across turns without pausing to ask whether to continue.",
    "- If this reply fully achieves the goal, end the reply with [[GOAL_COMPLETE: one-line reason]].",
    "- If the goal has become impossible or no longer relevant, end the reply with [[GOAL_CANCELLED: one-line reason]].",
    "- Never emit either marker while the goal is still unfinished.",
  ];
  if (
    userInput !== undefined &&
    userInput.trim().length > 0 &&
    userInput.trim() !== goal.objective.trim()
  ) {
    lines.push("", "[User Request]", userInput);
  }
  return lines.join("\n");
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const MAX_REGENERATION_ATTACHMENTS = 4;
const MAX_THREAD_TITLE_CONTEXT_CHARS = 8_000;
const MAX_PROVIDER_HISTORY_CONTEXT_CHARS = 64_000;
const MAX_PROVIDER_TOOL_RESULT_CONTEXT_CHARS = 4_000;
const MAX_PROVIDER_TOOL_RESULT_ROWS = 6;
const MAX_FIRST_USER_TITLE_CONTEXT_CHARS = 2_000;
const THREAD_TITLE_CONTEXT_TRUNCATION_MARKER = "[Earlier content truncated]\n\n";
const FIRST_USER_CONTEXT_TRUNCATION_MARKER = "\n[First user message truncated]";

type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system";
  readonly providerInstanceId?: string | undefined;
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

function formatThreadTitleSection(message: ThreadTitleMessage): string | undefined {
  if (message.role === "system") {
    return undefined;
  }
  const text = message.text.trim();
  const attachmentSummary = (message.attachments ?? [])
    .map((attachment) => attachment.name)
    .join(", ");
  const contents = [
    ...(text.length > 0 ? [text] : []),
    ...(attachmentSummary.length > 0 ? [`[Attachments: ${attachmentSummary}]`] : []),
  ].join("\n");
  const roleLabel =
    message.role === "assistant" && message.providerInstanceId
      ? `ASSISTANT (${message.providerInstanceId})`
      : message.role.toUpperCase();
  return contents.length > 0 ? `${roleLabel}:\n${contents}` : undefined;
}

function limitFirstUserSection(section: string): string {
  if (section.length <= MAX_FIRST_USER_TITLE_CONTEXT_CHARS) {
    return section;
  }
  return `${section.slice(
    0,
    MAX_FIRST_USER_TITLE_CONTEXT_CHARS - FIRST_USER_CONTEXT_TRUNCATION_MARKER.length,
  )}${FIRST_USER_CONTEXT_TRUNCATION_MARKER}`;
}

function collectRecentThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars: number,
): {
  readonly context: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly truncated: boolean;
} {
  let context = "";
  let truncated = false;
  const retainedAttachments: Array<ChatAttachment> = [];

  for (const message of messages.toReversed()) {
    const section = formatThreadTitleSection(message);
    if (section === undefined) {
      continue;
    }

    const separator = context.length > 0 ? "\n\n" : "";
    const available = maxChars - context.length - separator.length;
    if (section.length > available) {
      if (available > 0) {
        context = `${section.slice(-available)}${separator}${context}`;
        retainedAttachments.unshift(...(message.attachments ?? []));
      }
      truncated = true;
      break;
    }
    context = `${section}${separator}${context}`;
    retainedAttachments.unshift(...(message.attachments ?? []));
  }

  return { context, attachments: retainedAttachments, truncated };
}

function formatThreadTitleContext(
  messages: ReadonlyArray<ThreadTitleMessage>,
  maxChars = MAX_THREAD_TITLE_CONTEXT_CHARS,
): {
  readonly message: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
} {
  const recent = collectRecentThreadTitleContext(messages, maxChars);
  if (!recent.truncated) {
    return {
      message: recent.context,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const firstUserMessage = messages.find(
    (message) => message.role === "user" && formatThreadTitleSection(message),
  );
  const firstUserSection = firstUserMessage
    ? formatThreadTitleSection(firstUserMessage)
    : undefined;
  if (!firstUserMessage || !firstUserSection) {
    return {
      message: `${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${
        collectRecentThreadTitleContext(
          messages,
          maxChars - THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length,
        ).context
      }`,
      attachments: recent.attachments.slice(-MAX_REGENERATION_ATTACHMENTS),
    };
  }

  const pinnedSection = limitFirstUserSection(firstUserSection);
  const recentContextBudget =
    maxChars - pinnedSection.length - "\n\n".length - THREAD_TITLE_CONTEXT_TRUNCATION_MARKER.length;
  const retainedRecent = collectRecentThreadTitleContext(messages, recentContextBudget);
  const pinnedAttachment = firstUserMessage.attachments?.[0];
  const recentAttachments = retainedRecent.attachments.filter(
    (attachment) => attachment.id !== pinnedAttachment?.id,
  );

  return {
    message: `${pinnedSection}\n\n${THREAD_TITLE_CONTEXT_TRUNCATION_MARKER}${retainedRecent.context}`,
    attachments: [
      ...(pinnedAttachment ? [pinnedAttachment] : []),
      ...recentAttachments.slice(
        -(MAX_REGENERATION_ATTACHMENTS - (pinnedAttachment === undefined ? 0 : 1)),
      ),
    ],
  };
}

// 完整消息仍保留在原线程；仅限制发送给新运行器的引用上下文，避免切换时撑爆输入窗口。
export function formatThreadConversationHistory(
  messages: ReadonlyArray<ThreadTitleMessage>,
  activities: ReadonlyArray<OrchestrationThreadActivity> = [],
): string {
  const toolResults: string[] = [];
  let remainingChars = MAX_PROVIDER_TOOL_RESULT_CONTEXT_CHARS;
  for (const activity of activities.toReversed()) {
    if (toolResults.length >= MAX_PROVIDER_TOOL_RESULT_ROWS || remainingChars <= 0) break;
    if (activity.kind !== "tool.completed") continue;
    const projected = projectActivityPayload(activity);
    const payload =
      projected.payload && typeof projected.payload === "object"
        ? (projected.payload as Record<string, unknown>)
        : null;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : null;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : null;
    const item =
      data?.item && typeof data.item === "object" ? (data.item as Record<string, unknown>) : null;
    const resultValue = data?.result ?? item?.result;
    const resultData =
      resultValue && typeof resultValue === "object"
        ? (resultValue as Record<string, unknown>)
        : null;
    const status = typeof payload?.status === "string" ? payload.status : "completed";
    const result =
      typeof rawOutput?.content === "string"
        ? rawOutput.content.trim()
        : typeof resultData?.content === "string"
          ? resultData.content.trim()
          : (status === "failed" || status === "declined" || status === "error") &&
              typeof payload?.detail === "string"
            ? payload.detail.trim()
            : "";
    if (result.length === 0) continue;
    const row = `- [${status}] ${activity.summary}: ${result}`;
    const clipped = row.slice(0, Math.min(remainingChars, 600));
    toolResults.unshift(clipped);
    remainingChars -= clipped.length + 1;
  }
  const toolSection =
    toolResults.length > 0
      ? `\n\n历史工具结果摘要（仅供参考，不要重复执行旧操作）：\n${toolResults.join("\n")}`
      : "";
  const messageContext = formatThreadTitleContext(
    messages,
    MAX_PROVIDER_HISTORY_CONTEXT_CHARS - toolSection.length,
  ).message;
  return `${messageContext}${toolSection}`;
}

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const workspaceLock = yield* WorkspaceOperationLock;
  const threadGoalStore = yield* Effect.serviceOption(ThreadGoalStore);
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4().pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const specWorkflowCapabilityStore = yield* Effect.serviceOption(SpecWorkflowCapabilityStore);
  const specWorkflowService = yield* Effect.serviceOption(SpecWorkflowService);
  const serverEventId = () => crypto.randomUUIDv4().pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  const pendingTurnSends = new Map<ThreadId, number>();
  // Steer contract bookkeeping. `pendingSteerMessageIds` tracks every turn
  // start that has not yet reached the provider (in-flight sends plus held
  // queue entries), so an interrupt can discard steer input the provider
  // never read. `heldTurnStarts` parks turn starts for adapters that cannot
  // receive mid-turn input; they drain FIFO once the running turn ends.
  const pendingSteerMessageIds = new Map<ThreadId, Set<MessageId>>();
  const heldTurnStarts = new Map<
    ThreadId,
    Map<
      MessageId,
      {
        readonly event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>;
        readonly cwd: string;
      }
    >
  >();
  const lastTurnInterruptedAt = new Map<ThreadId, string>();
  const trackPendingSteer = (threadId: ThreadId, messageId: MessageId) => {
    const set = pendingSteerMessageIds.get(threadId) ?? new Set<MessageId>();
    set.add(messageId);
    pendingSteerMessageIds.set(threadId, set);
  };
  const untrackPendingSteer = (threadId: ThreadId, messageId: MessageId) => {
    const set = pendingSteerMessageIds.get(threadId);
    if (set === undefined) return;
    set.delete(messageId);
    if (set.size === 0) pendingSteerMessageIds.delete(threadId);
  };
  // Discards every turn start the provider has not read yet: parked queue
  // entries plus sends still in flight. `except` keeps the caller's own
  // message live so an interrupt-then-replace can still deliver it.
  const discardUnreadSteer = (threadId: ThreadId, except?: MessageId) =>
    Effect.sync(() => {
      const set = pendingSteerMessageIds.get(threadId);
      if (set !== undefined) {
        for (const messageId of set) {
          if (messageId !== except) markTurnStartCancelled(messageId);
        }
        if (except === undefined) {
          pendingSteerMessageIds.delete(threadId);
        } else {
          set.clear();
          set.add(except);
        }
      }
      if (except === undefined) {
        heldTurnStarts.delete(threadId);
      } else {
        heldTurnStarts.get(threadId)?.delete(except);
      }
    });
  // Queued turn starts the user cancelled before the provider adopted them. The
  // set is process-lifetime only and covers the race window between the cancel
  // event and the projection row delete; the cancel event deletes the pending
  // row in the projection (ProjectionPipeline), so nothing survives restart to
  // be re-sent from the read model.
  // ponytail: bounded FIFO set — a cancelled messageId is only needed until the
  // matching turn-start-requested reaches the send check; 1000 is far past any
  // realistic queue depth and prevents unbounded growth from orphaned cancels.
  const CANCELLED_TURN_START_MAX = 1000;
  const cancelledTurnStartMessageIds = new Set<MessageId>();
  const markTurnStartCancelled = (messageId: MessageId) => {
    if (cancelledTurnStartMessageIds.size >= CANCELLED_TURN_START_MAX) {
      const oldest = cancelledTurnStartMessageIds.values().next().value;
      if (oldest !== undefined) cancelledTurnStartMessageIds.delete(oldest);
    }
    cancelledTurnStartMessageIds.add(messageId);
  };

  const syncThreadGoalStatus = (threadId: ThreadId, status: "active" | "paused") => {
    if (Option.isNone(threadGoalStore)) return Effect.void;
    return Effect.gen(function* () {
      const current = yield* threadGoalStore.value.get(threadId);
      if (Option.isNone(current) || current.value.status === status) return;
      // Provider-native goals are driven by the provider; the store row is a
      // mirror and Code Work never flips its status around send/interrupt.
      if (current.value.providerNative === true) return;
      // 只有 paused 会在新一轮用户输入时自动恢复；usageLimited（预算到限）、
      // blocked（需要处理）与 complete 必须由用户显式恢复或清除。
      if (
        status === "active" ? current.value.status !== "paused" : current.value.status !== "active"
      )
        return;
      yield* threadGoalStore.value.setStatus({
        threadId,
        status,
        expectedGoalId: current.value.goalId,
        expectedStatus: current.value.status,
        expectedTokensUsed: current.value.tokensUsed,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("provider command reactor failed to sync thread Goal status", {
          threadId,
          status,
          cause: Cause.pretty(cause),
        });
      }),
    );
  };

  const checkThreadGoalBudget = Effect.fn("checkThreadGoalBudget")(function* (threadId: ThreadId) {
    if (Option.isNone(threadGoalStore)) return;
    const goal = yield* threadGoalStore.value.get(threadId);
    if (
      Option.isSome(goal) &&
      // Provider-native budgets are enforced provider-side; the mirrored
      // limit must not block ordinary user sends.
      goal.value.providerNative !== true &&
      (goal.value.status === "usageLimited" ||
        goal.value.status === "budgetLimited" ||
        (goal.value.tokenBudget !== null && goal.value.tokensUsed >= goal.value.tokenBudget))
    ) {
      return yield* new ThreadGoalBudgetExhaustedError();
    }
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly messageId?: MessageId;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
              ...(input.messageId ? { messageId: input.messageId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Recreates a thread's worktree from its branch when the directory has
   * disappeared. Provider sessions resume into the persisted cwd, so a missing
   * worktree makes every later turn fail as a bogus "session not found".
   * Best-effort: on failure the turn proceeds and reports the real error.
   */
  const ensureThreadWorktree = Effect.fnUntraced(function* (thread: {
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }) {
    const { worktreePath, branch } = thread;
    if (!worktreePath || !branch) {
      return;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    if (!project) {
      return;
    }
    const cwd = project.workspaceRoot;
    yield* Effect.logWarning("provider command reactor recreating missing worktree", {
      threadId: thread.id,
      worktreePath,
      branch,
    });
    // A directory deleted without `git worktree remove` leaves an admin entry
    // that makes `git worktree add` refuse the path; prune clears it.
    yield* gitWorkflow.pruneWorktrees({ cwd }).pipe(
      Effect.andThen(gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath })),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("provider command reactor failed to recreate worktree", {
              threadId: thread.id,
              worktreePath,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const ensureSpecWorkflowStateForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) {
    if (Option.isNone(specWorkflowCapabilityStore) || Option.isNone(specWorkflowService)) {
      return Option.none<{ capability: SpecWorkflowCapability; state: SpecWorkflowState | null }>();
    }
    const capability = yield* specWorkflowCapabilityStore.value.get(input.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to read Spec Workflow capability", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
    if (capability?.enabled !== true) {
      return Option.none<{ capability: SpecWorkflowCapability; state: SpecWorkflowState | null }>();
    }
    const existing = yield* specWorkflowService.value.getState(input.threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to read Spec Workflow state", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isSome(existing)) {
      return Option.some({ capability, state: existing.value });
    }
    if (["chat", "status", "stash", "resume"].includes(capability.selectedIntent ?? "workflow")) {
      return Option.some({ capability, state: null });
    }
    return yield* specWorkflowService.value
      .start({
        workflowId: `thread:${input.threadId}`,
        projectId: input.projectId,
        threadId: input.threadId,
        changeName: `thread-${input.threadId}`,
        mode: capability.selectedIntent === "fix" ? "fix" : "full",
        updatedAt: 0,
      })
      .pipe(
        Effect.map((state) => Option.some({ capability, state })),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to initialize Spec Workflow", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(Option.none())),
        ),
      );
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
      (providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
        providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
          ?.requiresNewThreadForModelChange === true);
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
      readonly messageId?: MessageId;
      readonly historySequence?: number;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : (thread.session?.providerInstanceId ?? thread.modelSelection.instanceId);
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.catch(() =>
        currentInstanceId !== desiredInstanceId
          ? Effect.void
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: providerErrorLabelFromInstanceHint({
                  instanceId: String(currentInstanceId),
                  modelSelectionInstanceId: String(thread.modelSelection.instanceId),
                  sessionProvider: thread.session?.providerName ?? undefined,
                }),
                method: "thread.turn.start",
                detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
              }),
            ),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    const incompatibleSession =
      currentInfo?.driverKind !== desiredInfo.driverKind ||
      currentInfo?.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey;
    if (
      (currentInstanceId !== desiredInstanceId && (pendingTurnSends.get(threadId) ?? 0) > 0) ||
      (incompatibleSession &&
        (activeSession?.status === "running" ||
          activeSession?.status === "connecting" ||
          (thread.session?.status === "running" && thread.session.activeTurnId !== null)))
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: preferredProvider,
        method: "thread.turn.start",
        detail: PROVIDER_SWITCH_WHILE_RUNNING_DETAIL,
      });
    }
    const project = yield* resolveProject(thread.projectId);
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly freshConversation?: boolean;
    }) =>
      Effect.gen(function* () {
        const excludedMessageIds = new Set<MessageId>(
          options?.messageId ? [options.messageId] : [],
        );
        const excludedActivityIds = new Set<EventId>();
        if (options?.historySequence !== undefined) {
          const latestSequence = yield* orchestrationEngine.latestSequence;
          if (latestSequence > options.historySequence) {
            // 消息展示按客户端时间排序；用已落库事件边界排除队列中的后续消息，不能依赖时间或 ID 顺序。
            yield* orchestrationEngine
              .readEvents(options.historySequence, latestSequence - options.historySequence)
              .pipe(
                Stream.runForEach((event) =>
                  Effect.sync(() => {
                    if (
                      event.type === "thread.message-sent" &&
                      event.payload.threadId === threadId
                    ) {
                      excludedMessageIds.add(event.payload.messageId);
                    } else if (
                      event.type === "thread.activity-appended" &&
                      event.payload.threadId === threadId
                    ) {
                      excludedActivityIds.add(event.payload.activity.id);
                    }
                  }),
                ),
              );
          }
        }
        return yield* providerService.startSession(
          threadId,
          {
            threadId,
            ...(preferredProvider ? { provider: preferredProvider } : {}),
            providerInstanceId: desiredInstanceId,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            ...(thread.title ? { title: thread.title } : {}),
            modelSelection: desiredModelSelection,
            ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
            runtimeMode: desiredRuntimeMode,
          },
          {
            // 本轮消息已落库，不能同时作为历史和当前输入重复交给模型。
            conversationHistory: formatThreadConversationHistory(
              thread.messages.filter((message) => !excludedMessageIds.has(message.id)),
              thread.activities.filter((activity) => !excludedActivityIds.has(activity.id)),
            ),
            freshConversation: incompatibleSession || input?.freshConversation === true,
          },
        );
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged = activeSession?.providerInstanceId !== desiredInstanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch !== "in-session";
      const restartPreservesConversation = sessionModelSwitch === "restart-continue";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        (shouldRestartForModelChange && !restartPreservesConversation) || incompatibleSession
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession({
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        freshConversation: shouldRestartForModelChange && !restartPreservesConversation,
      });
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly messageId: MessageId;
    readonly sequence: number;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
      messageId: input.messageId,
      historySequence: input.sequence,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const providerInput = Option.isNone(threadGoalStore)
      ? normalizedInput
      : yield* threadGoalStore.value.get(input.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider command reactor failed to read thread Goal", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(Option.none<ThreadGoal>())),
          ),
          Effect.map(
            Option.match({
              onNone: () => normalizedInput,
              onSome: (goal) =>
                goal.status === "complete" || goal.providerNative === true
                  ? normalizedInput
                  : formatThreadGoalProviderInput(goal, normalizedInput),
            }),
          ),
        );
    const specWorkflowState = yield* ensureSpecWorkflowStateForThread({
      threadId: input.threadId,
      projectId: thread.projectId,
    });
    const providerInputWithWorkflow = Option.match(specWorkflowState, {
      onNone: () => providerInput,
      onSome: ({ capability, state }) =>
        formatSpecWorkflowSelectedInput(capability, state, providerInput),
    });
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    // 原生控制命令不能被 Goal / 工作流说明包裹，否则 CLI 会将其当成普通提示词。
    const nativeCommand =
      (activeSession?.provider === "codex" &&
        (/^\/review(?:\s|$)/i.test(normalizedInput ?? "") ||
          /^\/goal(?:\s|$)/i.test(normalizedInput ?? ""))) ||
      (activeSession?.provider === "claudeAgent" &&
        (/^\/compact(?:\s|$)/i.test(normalizedInput ?? "") ||
          /^\/goal(?:\s|$)/i.test(normalizedInput ?? ""))) ||
      (activeSession?.provider === "byok" && isByokNativeSlashInput(normalizedInput));
    const turnInput = nativeCommand ? normalizedInput : providerInputWithWorkflow;
    const modelForTurn =
      sessionModelSwitch !== "in-session" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      providerSessionReady: activeSession?.status === "ready",
      request: {
        threadId: input.threadId,
        ...(turnInput ? { input: turnInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      },
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings;
      const modelSelection =
        settings.sourceControlWriterModelSelection === null
          ? settings.textGenerationModelSelection
          : resolveSourceControlWriterModelSelection(
              settings,
              yield* providerRegistry.getProviders,
            );

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const regenerateThreadTitle = Effect.fn("regenerateThreadTitle")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>,
    requestId: CommandId,
  ) {
    if (event.payload.regenerateTitle !== true) {
      return { _tag: "Superseded" } as const;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread || thread.titleRegeneration?.requestId !== requestId) {
      return { _tag: "Superseded" } as const;
    }

    const { message, attachments } = formatThreadTitleContext(thread.messages);
    if (message.length === 0) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const previousTitle = event.payload.previousTitle ?? thread.title;
    if (thread.title !== previousTitle) {
      return { _tag: "Superseded" } as const;
    }
    const project = yield* resolveProject(thread.projectId);
    const cwd =
      resolveThreadWorkspaceCwd({
        thread,
        projects: project ? [project] : [],
      }) ?? process.cwd();
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const generated = yield* textGeneration.generateThreadTitle({
      cwd,
      message,
      previousTitle,
      ...(attachments.length > 0 ? { attachments } : {}),
      modelSelection,
    });
    if (generated.title === DEFAULT_THREAD_TITLE || generated.title === previousTitle) {
      return { _tag: "Completed", title: undefined } as const;
    }

    const latestThread = yield* resolveThread(event.payload.threadId);
    if (
      !latestThread ||
      latestThread.titleRegeneration?.requestId !== requestId ||
      latestThread.title !== previousTitle
    ) {
      return { _tag: "Superseded" } as const;
    }

    return { _tag: "Completed", title: generated.title } as const;
  });
  const dispatchThreadTitleRegenerationCompletion = Effect.fn(
    "dispatchThreadTitleRegenerationCompletion",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: yield* serverCommandId("thread-title-regeneration-complete"),
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  });
  const findInterruptedThreadTitleRegenerations = Effect.fn(
    "findInterruptedThreadTitleRegenerations",
  )(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    return readModel.threads.flatMap((thread) => {
      const requestId = thread.titleRegeneration?.requestId;
      return requestId === undefined ? [] : [{ threadId: thread.id, requestId }];
    });
  });
  const clearInterruptedThreadTitleRegenerations = Effect.fn(
    "clearInterruptedThreadTitleRegenerations",
  )(function* (
    interrupted: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestId: CommandId }>,
  ) {
    yield* Effect.forEach(
      interrupted,
      ({ threadId, requestId }) => {
        return dispatchThreadTitleRegenerationCompletion({
          threadId,
          requestId,
        }).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to clear interrupted title regeneration",
              {
                threadId,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      },
      { discard: true },
    );
  });
  const processThreadTitleRegenerationSafely = Effect.fn("processThreadTitleRegenerationSafely")(
    function* (event: Extract<ProviderIntentEvent, { type: "thread.meta-updated" }>) {
      if (event.payload.regenerateTitle !== true) {
        return;
      }

      const requestId = event.payload.titleRegeneration?.requestId ?? event.commandId;
      if (requestId === null) {
        return;
      }
      const result = yield* regenerateThreadTitle(event, requestId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("provider command reactor failed to regenerate thread title", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ _tag: "Completed", title: undefined } as const));
        }),
      );
      if (result._tag === "Superseded") {
        return;
      }

      const completion = {
        threadId: event.payload.threadId,
        requestId,
        ...(result.title !== undefined ? { title: result.title } : {}),
      };
      yield* dispatchThreadTitleRegenerationCompletion(completion).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor retrying title regeneration completion",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          ).pipe(Effect.andThen(dispatchThreadTitleRegenerationCompletion(completion)));
        }),
      );
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning(
            "provider command reactor failed to complete title regeneration",
            {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            },
          );
        }),
      ),
  );
  const threadTitleRegenerationWorker = yield* makeDrainableWorker(
    processThreadTitleRegenerationSafely,
  );

  const processTurnStartRequestedUnlocked = Effect.fn("processTurnStartRequestedUnlocked")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
      cwd: string,
      skipHandledDedupe = false,
    ) {
      if (cancelledTurnStartMessageIds.has(event.payload.messageId)) {
        return;
      }
      // A queued turn start written before the user interrupted is unread
      // steer input: the projection already drops its pending row on the
      // interrupted session-set, so the reactor must not deliver it either.
      const interruptedAt = lastTurnInterruptedAt.get(event.payload.threadId);
      if (
        interruptedAt !== undefined &&
        event.payload.createdAt <= interruptedAt &&
        event.payload.steer !== true
      ) {
        markTurnStartCancelled(event.payload.messageId);
        return;
      }
      if (!skipHandledDedupe) {
        const key = turnStartKeyForEvent(event);
        if (yield* hasHandledTurnStartRecently(key)) {
          return;
        }
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      // Queue-or-steer split. A running turn plus an adapter that cannot
      // receive mid-turn input means this turn start waits for the turn to
      // end; a `steer` command still goes through and the send path applies
      // interrupt-then-replace. An in-flight send on the thread counts as an
      // in-progress turn for the same reason.
      const turnInFlight =
        thread.session?.status === "running" && thread.session.activeTurnId !== null;
      const steerAlreadyInFlight =
        (pendingSteerMessageIds.get(thread.id)?.size ?? 0) > 0 ||
        (pendingTurnSends.get(thread.id) ?? 0) > 0;
      if (event.payload.steer !== true && (turnInFlight || steerAlreadyInFlight)) {
        const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
        const supportsSteer =
          instanceId !== undefined &&
          (yield* providerService.getCapabilities(instanceId).pipe(
            Effect.map((capabilities) => capabilities.steer === true),
            Effect.orElseSucceed(() => false),
          ));
        if (!supportsSteer) {
          const held = heldTurnStarts.get(thread.id) ?? new Map();
          held.set(event.payload.messageId, { event, cwd });
          heldTurnStarts.set(thread.id, held);
          trackPendingSteer(thread.id, event.payload.messageId);
          return;
        }
      }

      // From here the turn start is being delivered: held entries are marked
      // pending so an interrupt discards them before the provider reads them.
      // The flag is cleared by the send fiber's ensuring, by an early return
      // below, or by an interrupt/cancel that marks the message cancelled.
      trackPendingSteer(thread.id, event.payload.messageId);
      let deliveredToSend = false;
      yield* Effect.gen(function* () {
        const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
        if (!message || message.role !== "user") {
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
            messageId: event.payload.messageId,
            turnId: null,
            createdAt: event.payload.createdAt,
          });
          return;
        }

        yield* ensureThreadWorktree(thread);

        const isFirstUserMessageTurn =
          thread.messages.filter((entry) => entry.role === "user").length === 1;
        if (isFirstUserMessageTurn) {
          const project = yield* resolveProject(thread.projectId);
          const generationCwd =
            resolveThreadWorkspaceCwd({
              thread,
              projects: project ? [project] : [],
            }) ?? process.cwd();
          const generationInput = {
            messageText: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(event.payload.titleSeed !== undefined
              ? { titleSeed: event.payload.titleSeed }
              : {}),
          };

          yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
            threadId: event.payload.threadId,
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            ...generationInput,
          }).pipe(Effect.forkScoped);

          if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
            yield* maybeGenerateThreadTitleForFirstTurn({
              threadId: event.payload.threadId,
              cwd: generationCwd,
              ...generationInput,
            }).pipe(Effect.forkScoped);
          }
        }

        let providerSessionReady = false;
        const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.void;
          }
          const detail = formatFailureDetail(cause);
          if (detail === PROVIDER_SWITCH_WHILE_RUNNING_DETAIL) {
            // 拒绝追加的切换请求不能把仍在执行的原回合改成错误或暂停其目标。
            return appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              messageId: event.payload.messageId,
              turnId: null,
              createdAt: event.payload.createdAt,
            }).pipe(Effect.asVoid);
          }
          if (isThreadGoalBudgetExhaustedError(cause.reasons.find(Cause.isFailReason)?.error)) {
            return Effect.gen(function* () {
              const latest = yield* resolveThread(thread.id);
              // 只结束本请求创建的待启动状态，不能覆盖正在执行的追加输入。
              if (
                providerSessionReady &&
                latest?.session?.status === "starting" &&
                latest.session.activeTurnId === null &&
                latest.messages.findLast((entry) => entry.role === "user")?.id ===
                  event.payload.messageId
              ) {
                yield* setThreadSession({
                  threadId: thread.id,
                  session: { ...latest.session, status: "ready" },
                  createdAt: event.payload.createdAt,
                });
              }
              yield* appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.turn.start.failed",
                summary: "任务目标预算已耗尽",
                detail,
                messageId: event.payload.messageId,
                turnId: null,
                createdAt: event.payload.createdAt,
              });
            });
          }
          return setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }).pipe(
            Effect.ensuring(
              syncThreadGoalStatus(event.payload.threadId, "paused").pipe(
                Effect.catchCause(() => Effect.void),
              ),
            ),
            Effect.flatMap(() =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.turn.start.failed",
                summary: "Provider turn start failed",
                detail,
                messageId: event.payload.messageId,
                turnId: null,
                createdAt: event.payload.createdAt,
              }),
            ),
            Effect.asVoid,
          );
        };

        const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
          handleTurnStartFailure(cause).pipe(
            Effect.catchCause((recoveryCause) =>
              Effect.logWarning("provider command reactor failed to recover turn start failure", {
                eventType: event.type,
                threadId: event.payload.threadId,
                cause: Cause.pretty(recoveryCause),
                originalCause: Cause.pretty(cause),
              }),
            ),
          );

        // 先把暂停中的 Goal 恢复为本轮执行态，再读取上下文，避免模型看到过期的 paused 状态。
        const budgetAvailable = yield* checkThreadGoalBudget(thread.id).pipe(
          Effect.as(true),
          Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(false))),
        );
        if (!budgetAvailable) return;
        yield* syncThreadGoalStatus(event.payload.threadId, "active");

        const sendTurnRequest = yield* buildSendTurnRequestForThread({
          threadId: event.payload.threadId,
          messageText: message.text,
          messageId: event.payload.messageId,
          sequence: event.sequence,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          ...(event.payload.modelSelection !== undefined
            ? { modelSelection: event.payload.modelSelection }
            : {}),
          interactionMode: event.payload.interactionMode,
          createdAt: event.payload.createdAt,
        }).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            handleTurnStartFailure(cause).pipe(Effect.as(Option.none())),
          ),
        );

        if (Option.isNone(sendTurnRequest)) {
          return;
        }
        providerSessionReady = sendTurnRequest.value.providerSessionReady;

        const activeTurnIdAtSend = thread.session?.activeTurnId ?? null;
        const send = workspaceLock.withLock(
          cwd,
          Effect.gen(function* () {
            // 会话启动及排队等待期间可能收到预算事件，实际发送前再读一次。
            yield* checkThreadGoalBudget(thread.id);
            // 排队期间收到取消即丢弃；取消事件在同一事件流中排在 start 之后。
            if (cancelledTurnStartMessageIds.has(event.payload.messageId)) {
              return;
            }
            if (event.payload.steer === true && activeTurnIdAtSend !== null) {
              const instanceId =
                thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
              const steerCapable =
                instanceId !== undefined &&
                (yield* providerService.getCapabilities(instanceId, thread.id).pipe(
                  Effect.map((capabilities) => capabilities.steer === true),
                  Effect.orElseSucceed(() => false),
                ));
              if (!steerCapable) {
                // Interrupt-then-replace fallback: an explicit steer on an
                // adapter that cannot receive mid-turn input aborts the running
                // turn and this start becomes a fresh turn. Still-unread queued
                // input is discarded first, matching the interrupt contract.
                yield* providerService.interruptTurn({ threadId: thread.id });
                yield* discardUnreadSteer(thread.id, event.payload.messageId);
              }
            }
            const turn = yield* providerService.sendTurn(sendTurnRequest.value.request);
            cancelledTurnStartMessageIds.delete(event.payload.messageId);
            if (activeTurnIdAtSend !== null && turn.turnId === activeTurnIdAtSend) {
              // The adapter folded this send into the already-running turn, so
              // no new turn.started arrives to adopt the pending turn-start
              // row. Re-dispatching the session unchanged runs that adoption.
              const latest = yield* resolveThread(thread.id);
              if (latest?.session && latest.session.activeTurnId !== null) {
                yield* setThreadSession({
                  threadId: thread.id,
                  session: { ...latest.session, updatedAt: event.payload.createdAt },
                  createdAt: event.payload.createdAt,
                });
              }
            }
          }),
        );
        const sendWhenAvailable: typeof send = send.pipe(
          Effect.catchTag("WorkspaceBusyError", (error) =>
            workspaceLock
              .waitUntilAvailable(error.cwd)
              .pipe(Effect.andThen(Effect.suspend(() => sendWhenAvailable))),
          ),
        );
        // 实际发送在后台等待时也必须保留绑定，不能让后续选择把该请求送给另一个运行器。
        pendingTurnSends.set(thread.id, (pendingTurnSends.get(thread.id) ?? 0) + 1);
        deliveredToSend = true;
        yield* sendWhenAvailable.pipe(
          Effect.catchCause(recoverTurnStartFailure),
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (pendingTurnSends.get(thread.id) ?? 1) - 1;
              if (remaining > 0) pendingTurnSends.set(thread.id, remaining);
              else pendingTurnSends.delete(thread.id);
              untrackPendingSteer(thread.id, event.payload.messageId);
            }),
          ),
          Effect.forkScoped,
        );
      }).pipe(
        // Turn starts that never reach the send fiber (missing message,
        // session bootstrap failure, validation) must not stay marked as
        // unread steer input.
        Effect.ensuring(
          Effect.sync(() => {
            if (!deliveredToSend) untrackPendingSteer(thread.id, event.payload.messageId);
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const start = Effect.gen(function* () {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) return;
      const project = yield* resolveProject(thread.projectId);
      const cwd =
        resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ?? process.cwd();
      yield* workspaceLock.withLock(cwd, processTurnStartRequestedUnlocked(event, cwd));
    });
    const startWhenAvailable: typeof start = start.pipe(
      Effect.catchTag("WorkspaceBusyError", (error) =>
        workspaceLock
          .waitUntilAvailable(error.cwd)
          .pipe(Effect.andThen(Effect.suspend(() => startWhenAvailable))),
      ),
    );
    // 回退在锁内发现已落库的 pending 后立即退出；保留 worker 顺序，避免并发启动会话。
    yield* startWhenAvailable;
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);
      return Effect.gen(function* () {
        const latestThread = yield* resolveThread(event.payload.threadId);
        const latestSession = latestThread?.session;
        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* providerService.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }
            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThread(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;
        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...stoppedSession,
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId }).pipe(
      // Interrupt discards steer input the provider never read: parked
      // queue entries and still-in-flight sends are marked cancelled. The
      // timestamp also lets the turn-start path drop stale queued starts
      // whose createdAt predates the interrupt.
      Effect.tap(() => discardUnreadSteer(event.payload.threadId)),
      Effect.tap(() =>
        Effect.sync(() => {
          lastTurnInterruptedAt.set(event.payload.threadId, event.payload.createdAt);
        }),
      ),
      Effect.catchCause(recoverInterruptFailure),
      Effect.ensuring(
        syncThreadGoalStatus(event.payload.threadId, "paused").pipe(
          Effect.catchCause(() => Effect.void),
        ),
      ),
    );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
    // A session that is going away can never read parked queue entries or
    // in-flight sends; discard them so they cannot fire into the next
    // session bound to this thread.
    yield* discardUnreadSteer(thread.id);
    yield* syncThreadGoalStatus(thread.id, "paused");
  });

  // Every session transition lands here. A turn that ended with the session
  // still usable drains the earliest parked turn start so queued input
  // becomes its own turn; entries queued before an interrupt are discarded
  // because the provider never read them.
  const processSessionSet = Effect.fn("processSessionSet")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-set" }>,
  ) {
    const session = event.payload.session;
    if (session.activeTurnId !== null) {
      // A turn is live (including the fold-in adoption re-set); parked queue
      // entries keep waiting for the next turn end.
      return;
    }
    const held = heldTurnStarts.get(event.payload.threadId);
    if (held === undefined || held.size === 0) {
      return;
    }
    if (session.status === "stopped" || session.status === "error") {
      // Unusable session: discard unread input instead of firing it at a
      // dead runner. The projection already dropped the pending rows on this
      // same event.
      yield* discardUnreadSteer(event.payload.threadId);
      return;
    }
    if (session.status === "interrupted") {
      const watermark = lastTurnInterruptedAt.get(event.payload.threadId) ?? event.occurredAt;
      for (const [messageId, entry] of held) {
        if (entry.event.payload.createdAt <= watermark) {
          markTurnStartCancelled(messageId);
          untrackPendingSteer(event.payload.threadId, messageId);
          held.delete(messageId);
        }
      }
    }
    yield* drainHeldTurnStarts(event.payload.threadId);
  });

  // Drain the earliest surviving entry: it becomes its own turn. Cancelled
  // or otherwise dropped entries are skipped in the same pass so a dead
  // head cannot pin the queue; survivors drain one per completed turn.
  const drainHeldTurnStarts = Effect.fn("drainHeldTurnStarts")(function* (threadId: ThreadId) {
    let delivered = false;
    while (!delivered) {
      const held = heldTurnStarts.get(threadId);
      const next = held?.entries().next().value;
      if (held === undefined || next === undefined) {
        heldTurnStarts.delete(threadId);
        return;
      }
      const [messageId, entry] = next;
      held.delete(messageId);
      if (held.size === 0) heldTurnStarts.delete(threadId);
      // Untrack first so the in-flight check does not count this entry
      // against itself when it re-enters the turn-start path.
      untrackPendingSteer(threadId, messageId);
      if (cancelledTurnStartMessageIds.has(messageId)) {
        continue;
      }
      const deliver = workspaceLock.withLock(
        entry.cwd,
        processTurnStartRequestedUnlocked(entry.event, entry.cwd, true),
      );
      const deliverWhenAvailable: typeof deliver = deliver.pipe(
        Effect.catchTag("WorkspaceBusyError", (error) =>
          workspaceLock
            .waitUntilAvailable(error.cwd)
            .pipe(Effect.andThen(Effect.suspend(() => deliverWhenAvailable))),
        ),
      );
      yield* deliverWhenAvailable;
      // A handled entry is either back in-flight (tracked again) or parked
      // by the busy re-check; a dropped one lets the next entry try.
      delivered =
        pendingSteerMessageIds.get(threadId)?.has(messageId) === true ||
        heldTurnStarts.get(threadId)?.has(messageId) === true;
    }
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);
        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        const boundInstanceId = thread.session.providerInstanceId;
        if (
          boundInstanceId !== undefined &&
          ((cachedModelSelection ?? thread.modelSelection).instanceId !== boundInstanceId ||
            thread.modelSelection.instanceId !== boundInstanceId)
        ) {
          // 模型选择已经保存但尚未发送时，留到 turn-start 统一切换并排除本轮消息。
          return;
        }
        const project = yield* resolveProject(thread.projectId);
        const cwd =
          resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ??
          process.cwd();
        yield* workspaceLock.withLock(
          cwd,
          ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
            historySequence: event.sequence,
          }),
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-start-cancelled":
        markTurnStartCancelled(event.payload.messageId);
        heldTurnStarts.get(event.payload.threadId)?.delete(event.payload.messageId);
        untrackPendingSteer(event.payload.threadId, event.payload.messageId);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.session-set":
        yield* processSessionSet(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  // 重启续接：reconcile 在绑定上写下 restartContinuation 意图后，本例程在激活后
  // （或运行时再次 reconcile 时）认领它——修复死会话行、补发续接轮次、把持久化
  // 的排队输入重新挂回进程内 held 队列。派发使用确定性 command/message id，
  // 命令回执使跨重启重试成为 no-op。
  const recoverRestartedSession: ProviderCommandReactorShape["recoverRestartedSession"] = Effect.fn(
    "ProviderCommandReactor.recoverRestartedSession",
  )(function* (threadId: ThreadId) {
    const binding = Option.getOrUndefined(
      yield* providerSessionDirectory
        .getBinding(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    const intent = readRestartContinuationIntent(binding?.runtimePayload);
    if (binding === undefined || intent === null) return;

    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => null),
    );
    const thread = yield* resolveThread(threadId).pipe(Effect.orElseSucceed(() => undefined));
    const session = thread?.session ?? null;
    const queuedMessages = thread?.queuedMessages ?? [];
    const liveThreadIds = new Set(
      (yield* providerService.listSessions().pipe(Effect.orElseSucceed(() => []))).map(
        (providerSession) => providerSession.threadId,
      ),
    );
    const deadTurnId = intent.deadTurnId;
    // 陈旧源：标记后已有更新的轮次接管（线程详情里 latestTurn 不再是死轮次），
    // 或会话行挂着别的在途轮次——用户已经手动续上，意图作废但不清算会话。
    const staleSource = deadTurnId !== null && thread?.latestTurn?.turnId !== deadTurnId;
    const sessionHoldsOtherWork =
      session !== null && session.activeTurnId !== null && session.activeTurnId !== deadTurnId;
    const sessionCanResume =
      session !== null &&
      session.status !== "stopped" &&
      session.status !== "interrupted" &&
      !sessionHoldsOtherWork;
    const eligibility =
      liveThreadIds.has(threadId) ||
      settings === null ||
      thread === undefined ||
      session === null ||
      staleSource ||
      sessionHoldsOtherWork
        ? null
        : evaluateRestartContinuationEligibility({
            settings,
            thread,
            session,
            latestTurn: thread.latestTurn,
            binding,
          });
    if (eligibility !== null && !eligibility.allowed) {
      yield* Effect.logInfo("restart continuation declined", {
        threadId,
        rejection: eligibility.rejection,
      });
    }
    const eligible =
      eligibility?.allowed === true &&
      sessionCanResume &&
      (deadTurnId !== null || queuedMessages.length > 0);

    const clearIntent = providerSessionDirectory
      .upsert({
        ...binding,
        runtimePayload: {
          ...(typeof binding.runtimePayload === "object" &&
          binding.runtimePayload !== null &&
          !Array.isArray(binding.runtimePayload)
            ? binding.runtimePayload
            : {}),
          activeTurnId: null,
          [RESTART_CONTINUATION_PAYLOAD_KEY]: null,
        },
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to clear restart continuation intent", {
            threadId,
            detail: String(error),
          }),
        ),
      );

    if (!eligible) {
      yield* clearIntent;
      if (
        thread !== undefined &&
        session !== null &&
        (session.status === "starting" ||
          session.status === "running" ||
          session.activeTurnId !== null) &&
        !sessionHoldsOtherWork
      ) {
        const settledAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.set",
            commandId: restartContinuationSessionSetCommandId(threadId, deadTurnId),
            threadId,
            session: {
              ...session,
              status: "error",
              activeTurnId: null,
              lastError: ORPHANED_PROVIDER_SESSION_ERROR,
              updatedAt: settledAt,
            },
            createdAt: settledAt,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to settle declined restart continuation", {
                threadId,
                detail: String(error),
              }),
            ),
          );
      }
      return;
    }
    if (thread === undefined || session === null) {
      yield* clearIntent;
      return;
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    // 先把死会话行修复成可派遣状态；会话离开 running 的同时把仍在 running 的
    // 旧回合行结算为 completed，排队行保留（ready 不删除 pending turn start）。
    const healed = yield* orchestrationEngine
      .dispatch({
        type: "thread.session.set",
        commandId: restartContinuationSessionSetCommandId(threadId, deadTurnId),
        threadId,
        session: {
          ...session,
          status: "ready",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (healed === null) {
      // 修复失败时保留意图，下一次启动可重试。
      return;
    }

    const continuationMessageId = restartContinuationMessageId(threadId, deadTurnId);
    const alreadyRequested = thread.messages.some(
      (message) => message.id === continuationMessageId,
    );
    const needsContinuationDispatch = deadTurnId !== null && !alreadyRequested;
    if (needsContinuationDispatch) {
      const dispatched = yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: restartContinuationCommandId(threadId, deadTurnId),
          threadId,
          message: {
            messageId: continuationMessageId,
            role: "user" as const,
            text: RESTART_CONTINUATION_PROMPT,
            attachments: [],
          },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: now,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (dispatched === null) {
        return;
      }
    }

    const project = yield* resolveProject(thread.projectId).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const cwd =
      resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] }) ?? process.cwd();
    const syntheticTurnStart = (
      messageId: MessageId,
      createdAt: string,
      commandId: CommandId | null,
    ): Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }> => ({
      sequence: 0,
      eventId: EventId.make(`restart-recovery:${threadId}:${messageId}`),
      aggregateKind: "thread" as const,
      aggregateId: threadId,
      occurredAt: createdAt,
      commandId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.turn-start-requested" as const,
      payload: {
        threadId,
        messageId,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      },
    });

    if (needsContinuationDispatch) {
      // 先把续接请求送进 worker 并等它落地：热流里迟到的那条真事件按同一
      // commandId 被判重，先处理者胜出。等待 drain 保证它已记为在途，排在其后
      // 的排队轮次才会被挂到 held 队列尾部而不是反超。
      yield* worker.enqueue(
        syntheticTurnStart(
          continuationMessageId,
          now,
          restartContinuationCommandId(threadId, deadTurnId),
        ),
      );
      yield* worker.drain;
    }

    // 已持久化的排队回合在进程内 held 队列里重挂；逐个按回合结束排空。续接消息
    // 自身的 pending 行（上次启动已派发但未送达的场景）排在最前以保持顺序。
    if (queuedMessages.length > 0) {
      const orderedQueued = [...queuedMessages].sort((a, b) =>
        a.messageId === continuationMessageId ? -1 : b.messageId === continuationMessageId ? 1 : 0,
      );
      const held = heldTurnStarts.get(threadId) ?? new Map();
      for (const queued of orderedQueued) {
        if (held.has(queued.messageId)) continue;
        held.set(queued.messageId, {
          event: syntheticTurnStart(queued.messageId, queued.createdAt, null),
          cwd,
        });
        trackPendingSteer(threadId, queued.messageId);
      }
      heldTurnStarts.set(threadId, held);
      if (!needsContinuationDispatch) {
        yield* drainHeldTurnStarts(threadId).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("failed to drain re-armed queued turns after restart", {
                  threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      }
    }
    yield* clearIntent;
    yield* Effect.logInfo("resumed provider thread after server restart", {
      threadId,
      deadTurnId,
      queuedTurnStarts: queuedMessages.length,
      dispatchedContinuation: needsContinuationDispatch,
    });
  });

  const recoverMarkedRestartContinuations = Effect.fn(
    "ProviderCommandReactor.recoverMarkedRestartContinuations",
  )(function* () {
    const bindings = yield* providerSessionDirectory
      .listBindings()
      .pipe(Effect.orElseSucceed(() => []));
    for (const binding of bindings) {
      if (readRestartContinuationIntent(binding.runtimePayload) === null) continue;
      yield* recoverRestartedSession(binding.threadId);
    }
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const interruptedTitleRegenerations = yield* findInterruptedThreadTitleRegenerations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to find interrupted title regenerations",
          { cause: Cause.pretty(cause) },
        ).pipe(Effect.as([]));
      }),
    );
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        (event.type === "thread.meta-updated" && event.payload.regenerateTitle === true) ||
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-start-cancelled" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-set" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent));

    // The domain event stream is hot, so work pending before this reactor
    // starts cannot be resumed. Correlated completions only clear the request
    // captured here, leaving any newer request untouched.
    const clearInterrupted = clearInterruptedThreadTitleRegenerations(
      interruptedTitleRegenerations,
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning(
          "provider command reactor failed to clear interrupted title regenerations",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    const activation = yield* ServerActivation;
    const recoverRestarted = recoverMarkedRestartContinuations().pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logWarning("provider command reactor failed to recover restarted sessions", {
          cause: Cause.pretty(cause),
        });
      }),
    );
    if (activation === undefined) {
      yield* clearInterrupted;
      yield* recoverRestarted;
    } else {
      yield* forkParked(Effect.andThen(clearInterrupted, recoverRestarted));
    }
  });

  return {
    start,
    recoverRestartedSession,
    drain: Effect.gen(function* () {
      yield* worker.drain;
      yield* threadTitleRegenerationWorker.drain;
    }),
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
