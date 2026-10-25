// @effect-diagnostics globalDate:off globalDateInEffect:off - 活跃度/时间戳按墙上时间判断。
// @effect-diagnostics preferSchemaOverJson:off - 工具参数摘要的 JSON 序列化。
/**
 * ZCodeAdapter — ZCode CLI 的 Provider 适配器。
 *
 * 传输是「每轮一个进程」：`zcode --prompt=… --output-format stream-json --cwd …`
 * 逐行输出会话事件（信封同 ZCode 协议的 `mapSessionEvent`：`type`/`sessionId`/
 * `turnId`/`payload`），最后一行 `type:"result"` 收尾；会话靠 `--resume <sessionId>`
 * 续接。ZCode 没有 `--model`，模型由受管 `provider_config.json` 的
 * `defaultModelSelection` 决定，所以每轮启动前先按所选 BYOK 通道重写它。
 *
 * BYOK 构造性强制：模型选择只接受网关路由，未知模型 fail-closed。
 * 无头模式没有交互式审批，Code Work 运行时模式映射到 ZCode `--mode`。
 *
 * @module provider/Layers/ZCodeAdapter
 */
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  type ApprovalRequestId,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ThreadTokenUsageUpdatedPayload,
  type ThreadId,
  type ZCodeAgentSettings,
  ProviderDriverKind,
  RuntimeItemId,
  TurnId,
} from "@codework/contracts";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  makeJsonlRpcProcess,
  type JsonlRpcProcess,
  type JsonlRpcProcessExit,
} from "../pifamily/jsonlRpcProcess.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import {
  type PifamilyEmitApi,
  type PifamilySessionContext,
  forkPifamilyWatchdog,
  makePifamilyEventQueue,
  makePifamilyEventStampFactory,
  makePifamilyTerminalApi,
  pifamilyEmitToQueue,
  pifamilyRandomUUID,
  resolvePifamilyModel,
  settlePendingInteractions,
  spawnPifamilyProcess,
} from "../pifamily/pifamilyAdapterSupport.ts";
import { splitPifamilyLaunchArgs } from "./PiAdapter.ts";
import { ServerConfig } from "../../config.ts";
import { zcodeSpawnEnv } from "../zcode/zcodeBundledRuntime.ts";

const PROVIDER = ProviderDriverKind.make("zcodeAgent");
const RAW_SOURCE = "zcode.stream-json" as const;

export interface ZCodeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** 已清洗并注入 ZCODE_DATA_BASE_DIR 的子进程环境。 */
  readonly environment: Readonly<Record<string, string>>;
  /** spawn 目标：显式路径 / 内嵌 bundle（node + bundle 路径 + RUN_AS_NODE）/ PATH。 */
  readonly spawnTarget: import("../zcode/zcodeBundledRuntime.ts").ZCodeSpawnTarget;
  /** 解析当前可用的 BYOK 网关模型路由（driver 提供，读 settings）。 */
  readonly resolveRoutes: Effect.Effect<ReadonlyArray<PifamilyModelRoute>, ProviderAdapterError>;
  /** 按本轮所选通道重写受管 provider_config.json 的 defaultModelSelection。 */
  readonly prepareTurnConfig: (
    selected: PifamilyModelRoute,
  ) => Effect.Effect<void, ProviderAdapterError>;
}

/** ZCode 会话恢复游标：`--resume` 用的会话 id。 */
export interface ZCodeResumeCursor {
  readonly zcodeSessionId: string;
}

const decodeZCodeResumeCursor = (cursor: unknown): ZCodeResumeCursor | undefined => {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const id = (cursor as { readonly zcodeSessionId?: unknown }).zcodeSessionId;
  return typeof id === "string" && id.length > 0 ? { zcodeSessionId: id } : undefined;
};

/** Code Work 运行时模式 → ZCode `--mode`（无头默认 yolo，其余保守收紧）。 */
export function zcodeModeFor(input: {
  readonly runtimeMode: string;
  readonly interactionMode?: string | undefined;
}): "build" | "plan" | "edit" | "yolo" {
  if (input.interactionMode === "plan") return "plan";
  if (input.runtimeMode === "full-access") return "yolo";
  if (input.runtimeMode === "auto-accept-edits" || input.runtimeMode === "auto") return "edit";
  return "build";
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const asTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * 把 `turn.completed` 的用量折算成 Code Work 的线程用量快照。
 *
 * ZCode 的 `usage`（`ModelUsageSummary`）是**本回合**的模型调用汇总，因此它同时
 * 充当 `last*` 字段；缺失时退回只有一个总数的 `tokenCount`。这里刻意不填
 * `totalProcessedTokens`：那是线程累计账单，而 `tokenCount` 只是本回合的量，
 * 填进去会让「本轮比上轮省 token」被下游当成回退而整条丢弃。真正的累计值由
 * `result` 帧的 `projection.totalTokenCount` 提供（见 zcodeContextUsageSnapshot）。
 */
export function zcodeUsageSnapshot(
  payload: Record<string, unknown>,
): ThreadTokenUsageUpdatedPayload["usage"] | undefined {
  const usage = asRecord(payload.usage);
  const inputTokens = asTokenCount(usage.inputTokens);
  const outputTokens = asTokenCount(usage.outputTokens);
  const cachedInputTokens = asTokenCount(usage.cacheReadTokens);
  const reasoningOutputTokens = asTokenCount(usage.reasoningTokens);
  const totalTokens = asTokenCount(usage.totalTokens);
  const tokenCount = asTokenCount(payload.tokenCount);
  const usedTokens = totalTokens ?? tokenCount;
  if (usedTokens === undefined) return undefined;
  const toolCallCount = asTokenCount(payload.toolCallCount);
  const duration = asTokenCount(payload.duration);
  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(inputTokens === undefined ? {} : { inputTokens, lastInputTokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens, lastOutputTokens: outputTokens }),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens, lastCachedInputTokens: cachedInputTokens }),
    ...(reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens, lastReasoningOutputTokens: reasoningOutputTokens }),
    ...(toolCallCount === undefined ? {} : { toolUses: toolCallCount }),
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}

/**
 * `result` 帧的 `projection` 才是**上下文占用**（上游只累计 `main_turn` 的
 * ModelComplete，标题生成/压缩/子代理都不算），`usage.totalTokens` 则是本回合
 * 的计费总量。上下文进度条要的是前者，所以用 projection 覆盖 `usedTokens` 与
 * `maxTokens`，本回合明细仍留给 `last*`。
 *
 * `projection` 和 `usage` 一样挂在 `result` 帧顶层，不在 `payload` 里。
 */
export function zcodeContextUsageSnapshot(
  frame: Record<string, unknown>,
  lastTurnUsage: ThreadTokenUsageUpdatedPayload["usage"] | undefined,
): ThreadTokenUsageUpdatedPayload["usage"] | undefined {
  const projection = asRecord(frame.projection);
  const contextUsed = asTokenCount(projection.contextUsed);
  if (contextUsed === undefined) return undefined;
  const maxTokens = asTokenCount(projection.contextWindow);
  const totalProcessedTokens = asTokenCount(projection.totalTokenCount);
  return {
    // 本回合的输入/输出明细整体沿用 turn.completed 的读数，再让上下文占用覆盖
    // 进度条真正要读的字段——别把已经拿到的明细丢掉。
    ...lastTurnUsage,
    usedTokens: contextUsed,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
    ...(totalProcessedTokens === undefined ? {} : { totalProcessedTokens }),
  };
}

export function zcodeToolItemType(
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" {
  const name = toolName.toLowerCase();
  if (/(^|[._-])(bash|shell|command|exec|terminal)/.test(name)) return "command_execution";
  if (/(^|[._-])(edit|write|patch|multiedit|create|notebookedit)/.test(name)) {
    return "file_change";
  }
  return "dynamic_tool_call";
}

/**
 * 工具调用的单行摘要：优先跑命令原文，其次退化成截断的 JSON。
 *
 * 时间线里每条工具行都要能一眼看出「在干什么」，所以命令必须原样露出；
 * 其余工具的参数体积不可控，统一截到 400 字符。
 */
export function zcodeToolSummary(toolName: string, input: unknown): string {
  const record = asRecord(input);
  const command = asString(record.command ?? record.cmd);
  if (command !== undefined && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }
  const serialized = JSON.stringify(input ?? {}) ?? "{}";
  return serialized.length <= 400
    ? `${toolName}: ${serialized}`
    : `${toolName}: ${serialized.slice(0, 397)}...`;
}

/**
 * `tool_input_delta` 只带**不完整的 JSON 片段**，逐块解析不出来；这里把整段累积
 * 起来，只在「已能解析成对象且序列化结果变了」时才更新一次时间线，和 Claude
 * 适配器的做法一致——否则一条命令会刷出几十条近似重复的活动。
 */
export function zcodeToolInputPreview(
  text: string,
  previousFingerprint: string | undefined,
): { input: Record<string, unknown>; fingerprint: string } | undefined {
  if (text.length === 0 || !text.trimEnd().endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (Object.keys(record).length === 0) return undefined;
  const fingerprint = JSON.stringify(record);
  if (fingerprint === undefined || fingerprint === previousFingerprint) return undefined;
  return { input: record, fingerprint };
}

interface ZCodeSessionState {
  readonly ctx: PifamilySessionContext;
  /** 当前回合的进程；回合之间为 null。 */
  current: JsonlRpcProcess | null;
  zcodeSessionId: string | undefined;
  /** 是否已经收到过流式文本增量；否则终态时用 turn.completed.response 兜底。 */
  streamedText: boolean;
  threadStarted: boolean;
  /** 续接会话的实际模型与配置不一致时只提醒一次，避免每轮刷屏。 */
  modelDriftReported: boolean;
  /** 已经用 `model.streaming/tool_input_*` 提前开行的工具调用，避免 scheduled 重复开行。 */
  readonly streamedToolInputs: Set<string>;
  /** 参数流的累计文本（按 toolCallId）+ 上次发过的指纹，用于去重与短预览。 */
  readonly partialToolInput: Map<string, ZCodePartialToolInput>;
  /** 已提醒过「无头模式无法审批」的请求，避免同一请求刷屏。 */
  readonly warnedPermissions: Set<string>;
  /** 本回合 turn.completed 报的用量；result 补上下文占用时沿用它的明细字段。 */
  lastTurnUsage: ThreadTokenUsageUpdatedPayload["usage"] | undefined;
}

interface ZCodePartialToolInput {
  text: string;
  lastEmittedFingerprint: string | undefined;
  /** 参数超过预览上限：不再累计也不再发更新，完整入参由 tool.updated 补上。 */
  truncated: boolean;
}

/** 参数流预览的累计上限；超过后只保留尾部，避免长文件写入把内存拉爆。 */
const TOOL_INPUT_PREVIEW_LIMIT = 4_096;

/**
 * 无头模式下 ZCode 用 `DenyPermissionBroker` 兜底：除这两个工具外一律拒绝，
 * 不会有人等得到审批。因此 `permission.requested` 只值得当成一次性提示。
 */
const HEADLESS_AUTO_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "CreateWorkflow",
  "AmendWorkflow",
]);

/** ZCode 的占位标题；这些值不配覆盖用户起的线程名。 */
const ZCODE_PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  "new session",
  "untitled",
  "新会话",
]);

export const makeZCodeAdapter = (config: ZCodeAgentSettings, options: ZCodeAdapterOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const randomUUID = pifamilyRandomUUID(crypto);
    const makeStamp = makePifamilyEventStampFactory(randomUUID);

    const adapterScope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sessions.clear();
        yield* Scope.close(adapterScope, Exit.void);
      }),
    );

    const sessions = new Map<ThreadId, ZCodeSessionState>();
    const eventQueue = yield* makePifamilyEventQueue();

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ZCodeSessionState, ProviderAdapterSessionNotFoundError> => {
      const state = sessions.get(threadId);
      return state === undefined
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(state);
    };

    const makeEmitApi = (ctx: PifamilySessionContext): PifamilyEmitApi => ({
      provider: PROVIDER,
      instanceId: options.instanceId,
      threadId: ctx.threadId,
      currentTurnId: () => ctx.turn?.turnId,
      emit: pifamilyEmitToQueue({
        emit: eventQueue.emit,
        provider: PROVIDER,
        instanceId: options.instanceId,
        threadId: ctx.threadId,
      }),
      makeStamp,
      touchTurn: () => {
        if (ctx.turn !== null) ctx.turn.lastActivityAt = Date.now();
      },
      appendTurnItem: (item) => {
        const turn = ctx.turn;
        if (turn === null) return;
        const existing = ctx.turns.find((entry) => entry.id === turn.turnId);
        ctx.turns = [
          ...ctx.turns.filter((entry) => entry.id !== turn.turnId),
          { id: turn.turnId, items: [...(existing?.items ?? []), item] },
        ];
      },
    });

    /** 会话 id 首次出现时登记为续接游标，并发出 thread.started。 */
    const adoptSessionId = (state: ZCodeSessionState, emitApi: PifamilyEmitApi, id: string) =>
      Effect.gen(function* () {
        if (state.zcodeSessionId === id) return;
        state.zcodeSessionId = id;
        state.ctx.session = { ...state.ctx.session, resumeCursor: { zcodeSessionId: id } };
        if (state.threadStarted) return;
        state.threadStarted = true;
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "thread.started",
          payload: { providerThreadId: id },
        });
      });

    const handleFrame = Effect.fn("zcodeAdapter.handleFrame")(function* (
      state: ZCodeSessionState,
      emitApi: PifamilyEmitApi,
      proc: JsonlRpcProcess,
      frame: unknown,
      ownTurnId: TurnId,
    ) {
      const { ctx } = state;
      const terminal = makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi });
      const event = asRecord(frame);
      const type = asString(event.type);
      if (type === undefined) return;

      if (type === "process_exit") {
        const exit = frame as JsonlRpcProcessExit;
        // 上一回合进程的退出帧可能晚于下一回合的启动：只结算仍属于自己的回合。
        if (state.current !== proc) return;
        state.current = null;
        // 进程没走到 result 就退了（崩溃/被杀）：把只记了账的用量补发出去，
        // 正常路径下 result 帧已经清空它，这里不会重复。
        const pendingUsage = state.lastTurnUsage;
        state.lastTurnUsage = undefined;
        if (pendingUsage !== undefined) {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "thread.token-usage.updated",
            turnId: ownTurnId,
            payload: { usage: pendingUsage },
          });
        }
        const turn = ctx.turn;
        if (turn === null || turn.turnId !== ownTurnId || turn.settled) return;
        if (turn.interrupting) {
          yield* terminal.completeTurn("interrupted");
          return;
        }
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "runtime.error",
          turnId: turn.turnId,
          payload: { message: exit.error, class: "provider_error" },
        });
        yield* terminal.failTurn(exit.error);
        return;
      }

      // 每个进程只拥有创建它的回合；旧进程迟到的 result/增量不能触碰新回合。
      const sessionId = asString(event.sessionId);
      const payload = asRecord(event.payload);

      // `result` 是 stream-json 的终止行，且**只在这里**才拿得到 `projection`
      //（上下文占用与累计账单）。它到达时 turn.completed 通常已经结算、ctx.turn
      // 已清空，所以这段必须排在 settled 守卫之前，用本进程的 turnId 挂账。
      if (type === "result") {
        if (state.current !== proc) return;
        if (sessionId !== undefined) yield* adoptSessionId(state, emitApi, sessionId);
        // 没有 projection（老版本 / 中断）就退回本回合读数，信息少但不丢账。
        const usage = zcodeContextUsageSnapshot(event, state.lastTurnUsage) ?? state.lastTurnUsage;
        state.lastTurnUsage = undefined;
        if (usage !== undefined) {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "thread.token-usage.updated",
            turnId: ownTurnId,
            payload: { usage },
            raw: { source: RAW_SOURCE, method: type, payload: frame } as const,
          });
        }
        const settleTurn = ctx.turn;
        if (settleTurn !== null && settleTurn.turnId === ownTurnId && !settleTurn.settled) {
          yield* terminal.completeTurn("result");
        }
        return;
      }

      // 标题是**会话级**事件，可能在本回合结算之后才到（上游在首句之后异步生成），
      // 所以和 `result` 一样排在回合守卫之前，只认「还是我这条会话的进程」。
      if (type === "session.titleUpdated") {
        if (state.current !== proc) return;
        const title = asString(payload.title)?.trim();
        // 占位标题（"New session"）会把用户自己起的线程名覆盖掉，必须丢掉。
        // 真正的防冲突在写入侧：`canReplaceThreadTitle` 只允许替换仍是默认标题的线程。
        if (title === undefined || title.length === 0) return;
        if (ZCODE_PLACEHOLDER_TITLES.has(title.toLowerCase())) return;
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "thread.metadata.updated",
          payload: { name: title },
          raw: { source: RAW_SOURCE, method: type, payload: frame } as const,
        });
        return;
      }

      const activeTurn = ctx.turn;
      if (activeTurn === null || activeTurn.turnId !== ownTurnId || activeTurn.settled) return;

      if (sessionId !== undefined) yield* adoptSessionId(state, emitApi, sessionId);
      const turnId = emitApi.currentTurnId();
      emitApi.touchTurn();
      const raw = { source: RAW_SOURCE, method: type, payload: frame } as const;

      switch (type) {
        case "turn.started": {
          // ZCode 在 intent 里回报本回合真正生效的模型选择。续接的会话以会话库为准，
          // 和当前配置不一致时必须让用户看见，不能等回答完了才发现用错模型。
          const intent = asRecord(payload.intent);
          const actual = asRecord(intent.modelSelection);
          const providerId = asString(actual.providerId);
          const modelId = asString(actual.modelId);
          const expected = ctx.model.adapterId;
          if (providerId === undefined || modelId === undefined) return;
          if (modelId === expected || state.modelDriftReported) return;
          state.modelDriftReported = true;
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "runtime.warning",
            turnId,
            payload: {
              message: `ZCode is running this conversation on '${providerId}/${modelId}' (this session's stored choice), not '${expected}'. Start a new thread to switch models.`,
              detail: { providerId, modelId, expected },
            },
            raw,
          });
          return;
        }
        case "model.streaming": {
          const kind = asString(payload.kind);
          // 参数流的三个 kind 允许空 delta（start/end 本来就是空串），先分流再判空。
          if (
            kind === "tool_input_start" ||
            kind === "tool_input_delta" ||
            kind === "tool_input_end"
          ) {
            const toolCallId = asString(payload.toolCallId);
            if (toolCallId === undefined) return;
            if (kind === "tool_input_start") {
              const toolName = asString(payload.toolName) ?? "tool";
              state.partialToolInput.set(toolCallId, {
                text: "",
                lastEmittedFingerprint: undefined,
                truncated: false,
              });
              // 参数流比 tool.updated/scheduled 更早：先开一行「进行中」，让用户看到
              // 模型正在写这条命令，而不是等工具真正跑起来才有反馈。
              state.streamedToolInputs.add(toolCallId);
              yield* emitApi.emit({
                ...(yield* makeStamp()),
                type: "item.started",
                turnId,
                itemId: RuntimeItemId.make(toolCallId),
                payload: {
                  itemType: zcodeToolItemType(toolName),
                  status: "inProgress",
                  title: toolName,
                  detail: `${toolName} …`,
                  data: { toolName },
                },
                raw,
              });
              return;
            }

            const tracked = state.partialToolInput.get(toolCallId);
            if (tracked === undefined) return;
            if (kind === "tool_input_end") {
              state.partialToolInput.delete(toolCallId);
              return;
            }

            const delta = asString(payload.delta);
            if (delta === undefined || tracked.truncated) return;
            const text = tracked.text + delta;
            if (text.length > TOOL_INPUT_PREVIEW_LIMIT) {
              // 超长参数（整文件写入）不再流式预览：完整入参随后由 tool.updated 给出。
              tracked.truncated = true;
              tracked.text = "";
              return;
            }
            tracked.text = text;
            const preview = zcodeToolInputPreview(text, tracked.lastEmittedFingerprint);
            if (preview === undefined) return;
            tracked.lastEmittedFingerprint = preview.fingerprint;
            const known = ctx.activeToolCalls.get(toolCallId);
            const toolName = asString(payload.toolName) ?? known?.toolName ?? "tool";
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "item.updated",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType: zcodeToolItemType(toolName),
                status: "inProgress",
                title: toolName,
                detail: zcodeToolSummary(toolName, preview.input),
                data: { toolName },
              },
              raw,
            });
            return;
          }

          const delta = asString(payload.delta);
          if (delta === undefined) return;
          if (kind === "text_delta") {
            state.streamedText = true;
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "content.delta",
              turnId,
              ...(ctx.currentAssistantMessageId === null
                ? {}
                : { itemId: RuntimeItemId.make(ctx.currentAssistantMessageId) }),
              payload: { streamKind: "assistant_text", delta },
              raw,
            });
          } else if (kind === "reasoning_delta") {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "content.delta",
              turnId,
              payload: { streamKind: "reasoning_text", delta },
              raw,
            });
          }
          return;
        }
        case "tool.updated": {
          const toolCallId = asString(payload.toolCallId);
          const kind = asString(payload.kind);
          if (toolCallId === undefined || kind === undefined) return;
          const known = ctx.activeToolCalls.get(toolCallId);
          const toolName = asString(payload.toolName) ?? known?.toolName ?? "tool";
          const itemType = zcodeToolItemType(toolName);
          if (kind === "scheduled") {
            ctx.activeToolCalls.set(toolCallId, { toolName, args: payload.input });
            emitApi.appendTurnItem({ toolName, args: payload.input });
            state.partialToolInput.delete(toolCallId);
            // 参数流已经开过这一行时不能再发 item.started：同一 itemId 会落下
            // 两条 tool.started 活动，时间线上就是重复的工具卡。改成带完整入参的
            // 更新，正好把流式期间只有「tool …」的摘要补成真正的命令。
            const streamed = state.streamedToolInputs.delete(toolCallId);
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: streamed ? "item.updated" : "item.started",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title: toolName,
                detail: zcodeToolSummary(toolName, payload.input),
                data: { toolName, args: payload.input },
              },
              raw,
            });
          } else if (kind === "started" || kind === "progress") {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "item.updated",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: { itemType, status: "inProgress", title: toolName, detail: `${toolName} …` },
              raw,
            });
          } else if (kind === "result" || kind === "error") {
            ctx.activeToolCalls.delete(toolCallId);
            const failed = kind === "error";
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "item.completed",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType,
                status: failed ? "failed" : "completed",
                title: toolName,
                detail: `${toolName} ${failed ? "failed" : "completed"}`.slice(0, 200),
                data: {
                  toolName,
                  ...(failed
                    ? { isError: true, error: payload.error }
                    : { result: payload.result }),
                },
              },
              raw,
            });
          }
          return;
        }
        case "permission.requested": {
          // 无头 ZCode 自己就拒绝所有审批（只有 CreateWorkflow/AmendWorkflow 放行），
          // 所以这里绝不能开成可交互的 request.opened——用户点了也没人接，只会
          // 留下一个永远挂起的审批卡。改成一次性的警告，解释为什么那个工具被拒。
          const requestId = asString(payload.requestId);
          const toolName = asString(payload.toolName);
          if (requestId === undefined || toolName === undefined) return;
          if (HEADLESS_AUTO_ALLOWED_TOOLS.has(toolName)) return;
          if (state.warnedPermissions.has(requestId)) return;
          state.warnedPermissions.add(requestId);
          const reason = asString(payload.reason);
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "runtime.warning",
            turnId,
            payload: {
              message:
                `ZCode asked to run '${toolName}', but headless ZCode cannot ask for approval and will deny it.` +
                (reason === undefined ? "" : ` ${reason}`),
              detail: { toolName, requestId },
            },
            raw,
          });
          return;
        }
        case "turn.completed": {
          const response = asString(payload.response);
          if (!state.streamedText && response !== undefined) {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "content.delta",
              turnId,
              payload: { streamKind: "assistant_text", delta: response },
              raw,
            });
          }
          const usage = zcodeUsageSnapshot(payload);
          if (usage !== undefined) {
            // 只记账不发事件：`result` 帧的 `projection` 才带上下文占用，两处各发
            // 一条会多出一行时间线（「N 步」按用量行数统计，会凭空翻倍）。
            state.lastTurnUsage = usage;
          }
          const resultType = asString(payload.resultType);
          if (resultType === "cancelled") {
            const turn = ctx.turn;
            if (turn !== null) turn.interrupting = true;
            yield* terminal.completeTurn("cancelled");
          } else if (resultType !== undefined && resultType !== "success") {
            yield* terminal.failTurn(`ZCode turn ended with ${resultType}.`);
          } else {
            yield* terminal.completeTurn("turn.completed");
          }
          return;
        }
        case "turn.failed": {
          const message =
            asString(asRecord(payload.error).message) ?? "ZCode turn failed without details.";
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "runtime.error",
            turnId,
            payload: { message, class: "provider_error" },
            raw,
          });
          yield* terminal.failTurn(message);
          return;
        }
        default:
          // 其余会话事件（消息/part 镜像、检查点、steering 回执等）不进时间线；
          // 协议漂移一律忽略——上游新增事件不应让适配器报错。
          return;
      }
    });

    const startSession = Effect.fn("zcodeAdapter.startSession")(function* (
      input: ProviderSessionStartInput,
    ) {
      const existing = sessions.get(input.threadId);
      if (existing !== undefined) return existing.ctx.session;

      const routes = yield* options.resolveRoutes;
      const selectedModel =
        input.modelSelection !== undefined && input.modelSelection.instanceId === options.instanceId
          ? input.modelSelection.model
          : undefined;
      const model = yield* resolvePifamilyModel({
        routes,
        provider: PROVIDER,
        operation: "startSession",
        selectedModel,
      });

      const resumeCursor = decodeZCodeResumeCursor(input.resumeCursor);
      const sessionScope = yield* Scope.make();
      yield* Scope.addFinalizer(adapterScope, Scope.close(sessionScope, Exit.void));

      const now = new Date().toISOString();
      const placeholder: ZCodeSessionState = {
        ctx: undefined as unknown as PifamilySessionContext,
        current: null,
        zcodeSessionId: resumeCursor?.zcodeSessionId,
        streamedText: false,
        threadStarted: resumeCursor !== undefined,
        modelDriftReported: false,
        streamedToolInputs: new Set(),
        partialToolInput: new Map(),
        warnedPermissions: new Set(),
        lastTurnUsage: undefined,
      };
      // ctx.process 只在测试替身/看门狗签名里出现，ZCode 的进程按回合创建，这里代理当前回合进程。
      const processProxy: PifamilySessionContext["process"] = {
        request: () => Effect.die(new Error("ZCode headless mode has no request channel.")),
        send: () => Effect.die(new Error("ZCode headless mode has no stdin channel.")),
        streamEvents: Stream.empty,
        hasExited: Effect.sync(() => placeholder.current === null),
        close: (reason) => placeholder.current?.close(reason) ?? Effect.void,
        get pid() {
          return placeholder.current?.pid;
        },
      };
      const ctx: PifamilySessionContext = {
        threadId: input.threadId,
        session: {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          model: model.adapterId,
          threadId: input.threadId,
          resumeCursor: resumeCursor ?? {},
          createdAt: now,
          updatedAt: now,
        },
        sessionScope,
        process: processProxy,
        model,
        turns: [],
        turn: null,
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        activeToolCalls: new Map(),
        currentAssistantMessageId: null,
        toolBroker: null,
      };
      (placeholder as { ctx: PifamilySessionContext }).ctx = ctx;
      sessions.set(input.threadId, placeholder);

      const emitApi = makeEmitApi(ctx);
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "session.started",
        payload: resumeCursor === undefined ? {} : { resume: true },
      });
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "session.state.changed",
        payload: { state: "ready" },
      });
      if (resumeCursor !== undefined) {
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "thread.started",
          payload: { providerThreadId: resumeCursor.zcodeSessionId },
        });
      }
      yield* forkPifamilyWatchdog({
        ctx,
        provider: PROVIDER,
        emitApi,
        terminal: makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi }),
      }).pipe(Effect.provideService(Scope.Scope, sessionScope));
      return ctx.session;
    });

    const sendTurn = Effect.fn("zcodeAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
      const state = yield* requireSession(input.threadId);
      const { ctx } = state;
      const text = input.input?.trim() ?? "";
      const attachments = input.attachments ?? [];
      if (!text) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "ZCode turns require text input.",
        });
      }
      if (ctx.turn !== null && !ctx.turn.settled) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A ZCode turn is already active on this thread.",
        });
      }

      const routes = yield* options.resolveRoutes;
      const selectedModel =
        input.modelSelection !== undefined && input.modelSelection.instanceId === options.instanceId
          ? input.modelSelection.model
          : ctx.model.adapterId;
      const model = yield* resolvePifamilyModel({
        routes,
        provider: PROVIDER,
        operation: "sendTurn",
        selectedModel,
      });
      const route = routes.find((candidate) => candidate.adapterId === model.adapterId);
      if (route === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `No BYOK adapter is published as model '${model.adapterId}'.`,
        });
      }
      // ZCode 把会话选中的 Provider/Model 写进自己的会话库，`--resume` 时以会话库为准；
      // 改写 `provider_config.json` 的 defaultModelSelection 只影响**新建**会话
      // （上游 `runtime-config.ts`：resume 时不套用 configuredDefaultModelSelection）。
      // 因此会话一旦落地，换模型就只能换线程，不能悄悄按旧模型跑一轮。
      if (state.zcodeSessionId !== undefined && model.adapterId !== ctx.model.adapterId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `ZCode keeps the model of a started conversation ('${ctx.model.adapterId}'); start a new thread to use '${model.adapterId}'.`,
        });
      }
      yield* options.prepareTurnConfig(route);
      ctx.model = model;
      ctx.session = { ...ctx.session, model: model.adapterId };

      const imagePaths: string[] = [];
      for (const attachment of attachments) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (
          attachmentPath === null ||
          !(yield* fileSystem.exists(attachmentPath).pipe(Effect.orElseSucceed(() => false)))
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Failed to resolve image attachment '${attachment.name}'.`,
          });
        }
        imagePaths.push(attachmentPath);
      }

      const turnId = TurnId.make(`zcode-turn-${yield* randomUUID}`);
      ctx.currentAssistantMessageId = `zcode-msg-${yield* randomUUID}`;
      ctx.turn = {
        turnId,
        started: true,
        pendingSettledMessages: null,
        interrupting: false,
        settled: false,
        lastActivityAt: Date.now(),
      };
      ctx.session = { ...ctx.session, status: "running", activeTurnId: turnId };
      state.streamedText = false;
      // 工具参数流/权限提醒都是回合内的临时状态；上一回合残留的会让新回合的
      // 工具卡错开成 item.updated，时间线上就少一条 started。
      state.streamedToolInputs.clear();
      state.partialToolInput.clear();
      state.warnedPermissions.clear();
      state.lastTurnUsage = undefined;
      // 新回合先脱离旧进程；旧进程随后到达的退出帧只能被自己的 turnId 守卫丢弃。
      state.current = null;

      const emitApi = makeEmitApi(ctx);
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "turn.started",
        turnId,
        payload: { model: model.adapterId },
      });

      const args = [
        ...options.spawnTarget.argsPrefix,
        `--prompt=${text}`,
        "--output-format",
        "stream-json",
        "--mode",
        zcodeModeFor({
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
        }),
        ...(ctx.session.cwd === undefined ? [] : ["--cwd", ctx.session.cwd]),
        ...(state.zcodeSessionId === undefined ? [] : ["--resume", state.zcodeSessionId]),
        ...imagePaths.flatMap((imagePath) => ["--attach", imagePath]),
        ...splitPifamilyLaunchArgs(config.launchArgs),
      ];

      // 进程绑定在回合 scope 上：回合结束 / 中断 / 会话停止时统一回收。
      const turnScope = yield* Scope.make();
      yield* Scope.addFinalizer(ctx.sessionScope, Scope.close(turnScope, Exit.void));

      yield* Effect.gen(function* () {
        const proc = yield* makeJsonlRpcProcess({
          diagnosticName: "ZCode",
          spawn: spawnPifamilyProcess({
            spawner,
            diagnosticName: "ZCode",
            owner: { provider: PROVIDER, kind: "session-transport" },
            binaryPath: options.spawnTarget.command,
            args,
            cwd: ctx.session.cwd,
            environment: { ...options.environment, ...zcodeSpawnEnv(options.spawnTarget) },
            argvPrompt: { provider: PROVIDER, prompt: text },
          }),
        }).pipe(
          Effect.provideService(Scope.Scope, turnScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        state.current = proc;
        yield* proc.streamEvents.pipe(
          Stream.runForEach((frame) => handleFrame(state, emitApi, proc, frame, turnId)),
          Effect.ensuring(Scope.close(turnScope, Exit.void)),
          Effect.forkScoped,
          Effect.provideService(Scope.Scope, ctx.sessionScope),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            state.current = null;
            yield* Scope.close(turnScope, Exit.void);
            yield* makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi }).failTurn(
              `ZCode failed to start: ${String(cause)}`,
            );
          }),
        ),
      );

      return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
    });

    const interruptTurn = Effect.fn("zcodeAdapter.interruptTurn")(function* (threadId: ThreadId) {
      const state = yield* requireSession(threadId);
      const turn = state.ctx.turn;
      if (turn === null || turn.settled) return;
      turn.interrupting = true;
      // 结算已排在 process_exit 帧之后；先直接终态，随后到达的 process_exit 是空操作。
      yield* makePifamilyTerminalApi({
        provider: PROVIDER,
        ctx: state.ctx,
        emitApi: makeEmitApi(state.ctx),
      }).abortTurn("interrupted");
      yield* state.current?.close("ZCode turn interrupted") ?? Effect.void;
    });

    const stopSession = Effect.fn("zcodeAdapter.stopSession")(function* (threadId: ThreadId) {
      const state = yield* requireSession(threadId);
      const { ctx } = state;
      const emitApi = makeEmitApi(ctx);
      yield* settlePendingInteractions(ctx);
      yield* makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi }).abortTurn(
        "session stopped",
      );
      yield* state.current?.close("ZCode session stopped") ?? Effect.void;
      sessions.delete(threadId);
      ctx.session = { ...ctx.session, status: "closed" };
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "session.exited",
        payload: { exitKind: "graceful" },
      });
      yield* Scope.close(ctx.sessionScope, Exit.void);
    });

    return {
      provider: PROVIDER,
      capabilities: {
        // ZCode 无 `--model`，且 `--resume` 以会话库里的模型选择为准；换模型必须换线程。
        sessionModelSwitch: "unsupported",
        streaming: true,
        reasoningStream: true,
        persistence: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId: ThreadId, requestId: ApprovalRequestId) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: `ZCode headless mode has no tool approval request '${requestId}'.`,
          });
        }),
      respondToUserInput: (threadId: ThreadId, requestId: ApprovalRequestId) =>
        Effect.gen(function* () {
          yield* requireSession(threadId);
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: `ZCode headless mode has no user-input request '${requestId}'.`,
          });
        }),
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((state) => state.ctx.session)),
      hasSession: (threadId: ThreadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const state = yield* requireSession(threadId);
          return {
            threadId,
            turns: state.ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          } satisfies ProviderThreadSnapshot;
        }),
      rollbackThread: (threadId: ThreadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `ZCode adapter does not support thread rollback for ${threadId}.`,
          }),
        ),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
          discard: true,
        }),
      streamEvents: eventQueue.stream,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
