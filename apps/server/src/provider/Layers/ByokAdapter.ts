/**
 * ByokAdapter — `ProviderAdapterShape` implementation for the built-in BYOK
 * chat engine.
 *
 * There is no external gateway anymore: sessions live in a local map and each
 * turn streams directly from the configured model adapter
 * (`ByokSettings.adapters`) via {@link ./byokChatClient.ts}.
 *
 *   - `startSession` creates a local session context and emits
 *     session/thread started events.
 *   - `sendTurn` appends the user prompt (plus inline image attachments read
 *     from the server attachment store) to the in-memory history, resolves
 *     the model adapter for the selected model slug (falling back to the
 *     first adapter), and forks a fiber that streams chat events as
 *     `content.delta` runtime events until the turn completes.
 *   - `interruptTurn` interrupts the active streaming fiber and emits
 *     `turn.aborted`.
 *
 * Text-only project turns reuse the shared BYOK Agent Loop and ToolBroker for
 * read-only repository inspection. Image turns retain the legacy multimodal
 * stream. Rollback is local: the history is truncated by N turns.
 *
 * @module provider/Layers/ByokAdapter
 */
import {
  EventId,
  type ByokModelAdapter,
  type ByokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { extractRescuableCanvas, normalizeRescuedCanvas } from "../../canvas/CanvasTextRescue.ts";
import { runByokAgentLoop, type ByokAgentToolCall } from "../../composition/ByokAgentLoop.ts";
import { makeByokModelDriver } from "../../composition/OpenAiByokModelDriver.ts";
import {
  compositionToolCapabilityId,
  listCompositionAgentTools,
} from "../../composition/CompositionToolRegistry.ts";
import type { ToolBroker, ToolBrokerResult } from "../../composition/ToolBroker.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ByokAdapterShape } from "../Services/ByokAdapter.ts";
import {
  byokAdapterForModel,
  collectChatText,
  type ByokChatMessage,
  type ByokContentPart,
  type ByokTokenUsage,
  runChatEvents,
  streamChat,
} from "./byokChatClient.ts";
import { getModelSelectionStringOptionValue } from "@codework/shared/model";
import { applyPromptTemplate, renderPromptTemplate } from "../byok/PromptTemplate.ts";
import {
  buildVisionPrompt,
  isImagePart,
  messageTextContext,
  messagesContainImages,
  modelLikelySupportsVision,
  replaceMessageImagesWithTexts,
  VISION_FAILURE_PREFIX,
  VISION_RESULT_PREFIX,
} from "../byok/VisionDelegation.ts";

const PROVIDER = ProviderDriverKind.make("byok");

/**
 * BYOK 会话没有外部 CLI 进程托管历史，服务器重启即丢上下文（CLI 供应商
 * 可原生 resume）。历史随回合落盘到 stateDir，startSession 收到该标记时
 * 原生重建；ProviderService 见到 resumeCursor 也会跳过降级的文本前缀
 * 重放，避免历史双份。
 */
const BYOK_RESUME_CURSOR = "byok-native-history-v1";

const ByokPersistedContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mimeType: Schema.String,
    dataBase64: Schema.String,
  }),
]);
const ByokPersistedMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.Union([Schema.String, Schema.Array(ByokPersistedContentPart)]),
  reasoningContent: Schema.optional(Schema.String),
  reasoningSignature: Schema.optional(Schema.String),
  toolCallId: Schema.optional(Schema.String),
  canonicalToolName: Schema.optional(Schema.String),
  toolCalls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        toolCallId: Schema.String,
        canonicalToolName: Schema.String,
        arguments: Schema.Unknown,
      }),
    ),
  ),
});
const ByokPersistedSessionFile = Schema.Struct({
  version: Schema.Literal(1),
  history: Schema.Array(ByokPersistedMessage),
  model: Schema.NullOr(Schema.String),
  totalProcessedTokens: Schema.Number,
  totalModelDurationMs: Schema.optional(Schema.Number),
});
const decodePersistedSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    ByokPersistedSessionFile as unknown as Schema.Codec<typeof ByokPersistedSessionFile.Type>,
  ),
);
const encodePersistedSession = Schema.encodeEffect(
  Schema.fromJsonString(
    ByokPersistedSessionFile as unknown as Schema.Codec<typeof ByokPersistedSessionFile.Type>,
  ),
);

type ByokPersistedMessage = (typeof ByokPersistedSessionFile.Type)["history"][number];

/** 解码结果的可选字段带 undefined，规整为引擎消息类型（exactOptionalPropertyTypes）。 */
const toByokChatMessages = (messages: ReadonlyArray<ByokPersistedMessage>): ByokChatMessage[] =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.reasoningContent !== undefined
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.reasoningSignature !== undefined
      ? { reasoningSignature: message.reasoningSignature }
      : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.canonicalToolName !== undefined
      ? { canonicalToolName: message.canonicalToolName }
      : {}),
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
  }));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Rough chars-per-token estimate used to bound the replayed history. */
const BYOK_HISTORY_CHARS_PER_TOKEN = 4;

/** Rough replay cost of one inline image (≈1k tokens) for history fitting. */
const BYOK_IMAGE_CHARS_ESTIMATE = 4_000;

/** Per-image budget for one vision delegation completion. */
const BYOK_VISION_IMAGE_TIMEOUT_MS = 120_000;

/** Image mime types all three BYOK transports accept inline. */
const BYOK_SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

interface ByokTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface ByokSessionContext {
  session: ProviderSession;
  readonly cwd: string;
  history: Array<ByokChatMessage>;
  turns: Array<ByokTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeTurnFiber: Fiber.Fiber<void, unknown> | undefined;
  totalProcessedTokens: number;
  totalModelDurationMs: number;
}

export interface ByokAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly toolBroker?: ToolBroker["Service"];
}

const BYOK_PROJECT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "workspace.read_file",
  "workspace.list_files",
  "workspace.search_files",
  "workspace.search_contents",
  "git.status",
  "git.diff",
  "canvas.create",
  // 远程服务器只读三件套与本地 workspace 只读同级。
  "ssh.status",
  "ssh.list_files",
  "ssh.read_file",
]);
const BYOK_FULL_ACCESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BYOK_PROJECT_TOOL_NAMES,
  "workspace.write_file",
  "terminal.exec",
  "terminal.snapshot",
  "terminal.kill",
  "terminal.close",
  "delegate_task",
  // 远程服务器写路径与本地 terminal 同级，仅在 full-access 模式放行。
  "ssh.exec",
  "ssh.write_file",
  "ssh.delete_file",
]);

/** BYOK 循环内的工具分组：project 只读集在所有模式可用，其余仅 full-access。 */
export const isByokProjectTool = (canonicalToolName: string): boolean =>
  BYOK_PROJECT_TOOL_NAMES.has(canonicalToolName);
export const isByokFullAccessTool = (canonicalToolName: string): boolean =>
  BYOK_FULL_ACCESS_TOOL_NAMES.has(canonicalToolName);

const renderAgentConversation = (messages: ReadonlyArray<ByokChatMessage>): string =>
  messages
    .map(
      (message) =>
        `${message.role === "assistant" ? "助手" : "用户"}: ${messageTextContext(message)}`,
    )
    .join("\n\n");

/** Rough char cost of a message, estimating inline images at a fixed budget. */
const messageHistoryChars = (message: ByokChatMessage): number =>
  typeof message.content === "string"
    ? message.content.length
    : message.content.reduce(
        (sum, part) => sum + (part.type === "text" ? part.text.length : BYOK_IMAGE_CHARS_ESTIMATE),
        0,
      );

/** Drop oldest history turns until the transcript fits the model context window. */
const fitHistory = (
  history: ReadonlyArray<ByokChatMessage>,
  contextWindowTokens: number,
): Array<ByokChatMessage> => {
  const maxChars = contextWindowTokens * BYOK_HISTORY_CHARS_PER_TOKEN;
  let total = history.reduce((sum, message) => sum + messageHistoryChars(message), 0);
  const next = [...history];
  while (next.length > 0 && total > maxChars) {
    const dropped = next.shift();
    if (dropped === undefined) {
      break;
    }
    total -= messageHistoryChars(dropped);
  }
  return next;
};

export function makeByokAdapter(byokSettings: ByokSettings, options?: ByokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("byok");
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const httpClient = yield* HttpClient.HttpClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const availableProjectTools = listCompositionAgentTools().filter((tool) =>
      isByokFullAccessTool(tool.canonicalToolName),
    );

    // Fibers forked into this scope are interrupted when the adapter layer
    // shuts down, so a streaming turn can never outlive its instance.
    const adapterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const sessions = new Map<ThreadId, ByokSessionContext>();
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

    // 每实例一目录、每线程一文件；文件名编码线程 id，避免任意字符落盘。
    const sessionStateDir = path.join(
      serverConfig.stateDir,
      "byok-sessions",
      encodeURIComponent(String(boundInstanceId)),
    );
    const sessionStatePath = (threadId: ThreadId) =>
      path.join(sessionStateDir, `${encodeURIComponent(String(threadId))}.json`);

    const loadPersistedSession = (threadId: ThreadId) =>
      fileSystem.readFileString(sessionStatePath(threadId)).pipe(
        Effect.flatMap(decodePersistedSession),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    // 落盘失败只降级为"重启后无原生恢复"，绝不影响回合本身。
    const persistSessionState = Effect.fn("byokPersistSessionState")((ctx: ByokSessionContext) =>
      Effect.gen(function* () {
        const serialized = yield* encodePersistedSession({
          version: 1,
          history: ctx.history,
          model: ctx.session.model ?? null,
          totalProcessedTokens: ctx.totalProcessedTokens,
          totalModelDurationMs: ctx.totalModelDurationMs,
        }).pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (serialized === null) return;
        yield* fileSystem
          .makeDirectory(sessionStateDir, { recursive: true })
          .pipe(Effect.catchCause(() => Effect.void));
        yield* fileSystem.writeFileString(sessionStatePath(ctx.session.threadId), serialized).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("BYOK 会话历史持久化失败", {
              threadId: String(ctx.session.threadId),
              cause,
            }),
          ),
        );
      }),
    );

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate BYOK runtime identifier.",
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: randomUUIDv4, createdAt: nowIso }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId: EventId.make(eventId),
          createdAt,
        })),
      );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sessions.clear();
        yield* Scope.close(adapterScope, Exit.void);
        yield* Queue.shutdown(runtimeEvents);
      }),
    );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ByokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const updateSession = Effect.fn("byokUpdateSession")(function* (
      ctx: ByokSessionContext,
      patch: Partial<ProviderSession>,
      clearActiveTurnId?: boolean,
    ) {
      const updatedAt = yield* nowIso;
      const next = { ...ctx.session, ...patch, updatedAt } as ProviderSession &
        Record<string, unknown>;
      if (clearActiveTurnId) {
        delete (next as Record<string, unknown>).activeTurnId;
      }
      ctx.session = next;
    });

    const appendTurnItem = (ctx: ByokSessionContext, turnId: TurnId, item: unknown): void => {
      const existing = ctx.turns.find((turn) => turn.id === turnId);
      if (existing) {
        existing.items.push(item);
        return;
      }
      ctx.turns.push({ id: turnId, items: [item] });
    };

    const emitThreadTokenUsage = Effect.fn("byokEmitThreadTokenUsage")(function* (
      ctx: ByokSessionContext,
      turnId: TurnId,
      adapter: ByokModelAdapter,
      usage: ByokTokenUsage,
    ) {
      const activeTokens =
        usage.totalTokens ??
        (usage.inputTokens !== undefined && usage.outputTokens !== undefined
          ? usage.inputTokens + usage.outputTokens
          : undefined);
      if (activeTokens === undefined || !Number.isSafeInteger(activeTokens) || activeTokens < 0)
        return;

      const maxTokens =
        Number.isSafeInteger(adapter.contextWindowTokens) && adapter.contextWindowTokens > 0
          ? adapter.contextWindowTokens
          : undefined;
      const usedTokens = activeTokens;
      ctx.totalProcessedTokens += activeTokens;
      if (usage.durationMs !== undefined) {
        ctx.totalModelDurationMs += usage.durationMs;
      }
      yield* emit({
        ...(yield* makeEventStamp()),
        type: "thread.token-usage.updated",
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        turnId,
        payload: {
          usage: {
            usedTokens,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(ctx.totalProcessedTokens > usedTokens
              ? { totalProcessedTokens: ctx.totalProcessedTokens }
              : {}),
            ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage.cachedInputTokens === undefined
              ? {}
              : { cachedInputTokens: usage.cachedInputTokens }),
            ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
            ...(usage.reasoningTokens === undefined
              ? {}
              : { reasoningOutputTokens: usage.reasoningTokens }),
            lastUsedTokens: usedTokens,
            ...(usage.inputTokens === undefined ? {} : { lastInputTokens: usage.inputTokens }),
            ...(usage.cachedInputTokens === undefined
              ? {}
              : { lastCachedInputTokens: usage.cachedInputTokens }),
            ...(usage.outputTokens === undefined ? {} : { lastOutputTokens: usage.outputTokens }),
            ...(usage.reasoningTokens === undefined
              ? {}
              : { lastReasoningOutputTokens: usage.reasoningTokens }),
            ...(usage.durationMs === undefined ? {} : { durationMs: ctx.totalModelDurationMs }),
          },
        },
      });
    });

    const startSession: ByokAdapterShape["startSession"] = Effect.fn("byokStartSession")(
      function* (input) {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const cwd = input.cwd ?? serverConfig.cwd;
        if (!cwd.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        sessions.delete(input.threadId);

        // 重启/会话重启后的原生恢复：resumeCursor 标记由 ProviderService 从
        // 会话绑定透传，历史从磁盘重建而不是空上下文重来。
        const resumed =
          input.resumeCursor === BYOK_RESUME_CURSOR
            ? yield* loadPersistedSession(input.threadId)
            : null;

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection
            ? { model: input.modelSelection.model }
            : resumed?.model
              ? { model: resumed.model }
              : {}),
          threadId: input.threadId,
          resumeCursor: BYOK_RESUME_CURSOR,
          createdAt,
          updatedAt: createdAt,
        };
        const ctx: ByokSessionContext = {
          session,
          cwd,
          history: resumed ? toByokChatMessages(resumed.history) : [],
          turns: [],
          activeTurnId: undefined,
          activeTurnFiber: undefined,
          totalProcessedTokens: resumed?.totalProcessedTokens ?? 0,
          totalModelDurationMs: resumed?.totalModelDurationMs ?? 0,
        };
        sessions.set(input.threadId, ctx);

        yield* emit({
          ...(yield* makeEventStamp()),
          type: "session.started",
          provider: PROVIDER,
          threadId: input.threadId,
          payload: {
            message: "BYOK engine session started",
            ...(resumed ? { resume: true } : {}),
          },
        });
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "thread.started",
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: `byok-local-${input.threadId}` },
        });

        return session;
      },
    );

    /**
     * Vision delegation (original cursor-byok behavior): when the target
     * model likely cannot read images and a vision model adapter is
     * configured, forward every inline image to it and replace the image
     * parts with the returned description/OCR text. Rewrites are written back
     * into the session history so later turns reuse the text instead of
     * re-delegating the same images.
     */
    const applyVisionDelegation = Effect.fn("byokApplyVisionDelegation")(function* (
      ctx: ByokSessionContext,
      targetAdapter: ByokModelAdapter,
      messages: ReadonlyArray<ByokChatMessage>,
    ) {
      const vision = byokSettings.delegation?.visionDelegation;
      if (vision?.enabled !== true || vision.visionModelId.trim().length === 0) return messages;
      if (!messagesContainImages(messages)) return messages;
      if (modelLikelySupportsVision(targetAdapter.modelId, targetAdapter.displayName)) {
        return messages;
      }
      const visionAdapter = byokAdapterForModel(byokSettings, vision.visionModelId);
      if (visionAdapter === undefined || visionAdapter.id === targetAdapter.id) return messages;

      const next = [...messages];
      for (let index = 0; index < next.length; index += 1) {
        const message = next[index]!;
        const images = (typeof message.content === "string" ? [] : message.content).filter(
          isImagePart,
        );
        if (images.length === 0) continue;
        const prompt = buildVisionPrompt(vision.mode, messageTextContext(message));
        const texts: string[] = [];
        for (const image of images) {
          const stream = streamChat(httpClient, {
            protocol: visionAdapter.protocol,
            baseURL: visionAdapter.baseURL,
            apiKey: visionAdapter.apiKey,
            modelId: visionAdapter.modelId,
            ...(visionAdapter.customHeaders !== undefined &&
            visionAdapter.customHeaders.trim().length > 0
              ? { customHeaders: visionAdapter.customHeaders }
              : {}),
            messages: [{ role: "user", content: [{ type: "text", text: prompt }, image] }],
          });
          const description = yield* collectChatText(stream).pipe(
            Effect.timeoutOption(BYOK_VISION_IMAGE_TIMEOUT_MS),
            Effect.map((outcome) => (Option.isSome(outcome) ? outcome.value.trim() : "")),
            Effect.catch(() => Effect.succeed("")),
          );
          texts.push(
            description.length === 0
              ? `${VISION_FAILURE_PREFIX} 识图请求失败或超时。请改用支持视觉的模型或检查视觉委派配置。`
              : `${VISION_RESULT_PREFIX} ${description}`,
          );
        }
        next[index] = replaceMessageImagesWithTexts(message, texts);
      }

      // `messages` is fitHistory's suffix of ctx.history in the same order.
      const offset = Math.max(0, ctx.history.length - messages.length);
      ctx.history.splice(offset, messages.length, ...next);
      return next;
    });

    /**
     * Stream one turn: consume `streamChat` events, emit them as runtime
     * `content.delta`s, and settle the turn when the stream ends.
     */
    const runTurn = Effect.fn("byokRunTurn")(function* (
      ctx: ByokSessionContext,
      turnId: TurnId,
      adapter: ByokModelAdapter,
      messages: ReadonlyArray<ByokChatMessage>,
      systemPrompt: string,
      reasoningEffort?: string,
    ) {
      let assistantText = "";
      let reasoningText = "";
      let reasoningSignature = "";
      const modelStartedAt = yield* Clock.currentTimeMillis;
      // 一次流式请求一个关联 id：随 x-request-id 发给供应商，事件里透出，
      // 供应商侧日志与本端 provider 事件日志靠它互相对上。
      const providerRequestId = yield* randomUUIDv4;
      const effectiveMessages = yield* applyVisionDelegation(ctx, adapter, messages);
      const stream = streamChat(httpClient, {
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
        modelId: adapter.modelId,
        requestId: providerRequestId,
        messages: effectiveMessages,
        includeUsage: true,
        ...(systemPrompt.trim().length > 0 ? { systemPrompt } : {}),
        ...(reasoningEffort !== undefined && reasoningEffort.trim().length > 0
          ? { reasoningEffort }
          : {}),
      });
      const outcome = yield* Effect.exit(
        runChatEvents(stream, (event) =>
          Effect.gen(function* () {
            if (event.type === "tool_call") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "sendTurn",
                detail: "BYOK 旧文本会话不支持结构化工具调用，请使用 composition agent loop 入口。",
              });
            }
            if (event.type === "completed") {
              const modelCompletedAt = yield* Clock.currentTimeMillis;
              yield* emitThreadTokenUsage(ctx, turnId, adapter, {
                ...event,
                durationMs: Math.max(0, modelCompletedAt - modelStartedAt),
              });
              return;
            }
            if (event.type === "reasoning_signature") {
              // Anthropic 思考块签名：不进时间线，只随历史回放。
              reasoningSignature = event.signature;
              return;
            }
            if (event.text.length === 0) {
              return;
            }
            if (event.type === "reasoning") {
              reasoningText += event.text;
              appendTurnItem(ctx, turnId, { type: "thinking", text: event.text });
              // BYOK 没有独立的 summary 通道：reasoning_content/thinking 块本身就是
              // 面向用户展示的思考流，走 reasoning_summary_text 才会像 Codex 一样
              // 在时间线上渲染成可折叠的 Thought 行；reasoning_text 会被时间线丢弃。
              yield* emit({
                ...(yield* makeEventStamp()),
                type: "content.delta",
                provider: PROVIDER,
                threadId: ctx.session.threadId,
                turnId,
                providerRefs: { providerRequestId },
                payload: { streamKind: "reasoning_summary_text", delta: event.text },
              });
              return;
            }
            assistantText += event.text;
            appendTurnItem(ctx, turnId, { type: "text", text: event.text });
            yield* emit({
              ...(yield* makeEventStamp()),
              type: "content.delta",
              provider: PROVIDER,
              threadId: ctx.session.threadId,
              turnId,
              providerRefs: { providerRequestId },
              payload: { streamKind: "assistant_text", delta: event.text },
            });
          }),
        ),
      );

      if (sessions.get(ctx.session.threadId) !== ctx) {
        return;
      }
      ctx.activeTurnId = undefined;
      ctx.activeTurnFiber = undefined;
      yield* updateSession(ctx, { status: "ready" }, true);

      if (Exit.isFailure(outcome)) {
        if (Cause.hasInterruptsOnly(outcome.cause)) {
          // Interruption is handled by `interruptTurn` (turn.aborted).
          return;
        }
        const detail =
          Option.getOrUndefined(Cause.findErrorOption(outcome.cause))?.message ??
          "BYOK engine turn failed.";
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "runtime.error",
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId,
          providerRefs: { providerRequestId },
          payload: { message: detail, class: "provider_error" },
        });
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "turn.completed",
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId,
          providerRefs: { providerRequestId },
          payload: { state: "failed", errorMessage: detail },
        });
        return;
      }

      // GLM/MiniMax 等端点的保留式思考要求历史 assistant 消息带回思考内容
      // （anthropic 协议回放为 thinking 块；openai 协议回放 reasoning_content，
      // 不识别该字段的端点会忽略）。
      if (assistantText.trim().length > 0) {
        ctx.history.push({
          role: "assistant",
          content: assistantText,
          ...(reasoningText.trim().length > 0 ? { reasoningContent: reasoningText } : {}),
          ...(reasoningText.trim().length > 0 && reasoningSignature.length > 0
            ? { reasoningSignature }
            : {}),
        });
      } else if (reasoningText.trim().length === 0) {
        ctx.history.push({ role: "assistant", content: "" });
      }
      ctx.history = fitHistory(ctx.history, adapter.contextWindowTokens);
      // 历史定型后、终态事件前落盘：turn.completed 即"已可恢复"的回执。
      yield* persistSessionState(ctx);
      yield* emit({
        ...(yield* makeEventStamp()),
        type: "turn.completed",
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        turnId,
        providerRefs: { providerRequestId },
        payload: { state: "completed" },
      });
    });

    const runAgentTurn = Effect.fn("byokRunAgentTurn")(function* (
      ctx: ByokSessionContext,
      turnId: TurnId,
      adapter: ByokModelAdapter,
      messages: ReadonlyArray<ByokChatMessage>,
      systemPrompt: string,
      toolBroker: ToolBroker["Service"],
      isPlanMode: boolean,
      reasoningEffort?: string,
    ) {
      const runtimeMode = isPlanMode ? "approval-required" : ctx.session.runtimeMode;
      const projectTools = availableProjectTools.filter(
        (tool) => runtimeMode === "full-access" || isByokProjectTool(tool.canonicalToolName),
      );
      const effectiveMessages = yield* applyVisionDelegation(ctx, adapter, messages);
      // 工具时间线行的发射器提出来共用：agent loop 的每个工具调用与文本抢救
      // 改道的 canvas.create 都走同一对 item.started/item.completed。
      const emitToolRowStarted = (toolCall: ByokAgentToolCall) =>
        Effect.gen(function* () {
          yield* emit({
            ...(yield* makeEventStamp()),
            type: "item.started",
            provider: PROVIDER,
            threadId: ctx.session.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolCall.toolCallId),
            payload: {
              itemType: "mcp_tool_call",
              status: "inProgress",
              title: toolCall.canonicalToolName,
              data: {
                toolName: toolCall.canonicalToolName,
                input: toolCall.arguments,
              },
            },
          });
        }).pipe(Effect.orDie);
      const emitToolRowCompleted = (toolCall: ByokAgentToolCall, result: ToolBrokerResult) =>
        Effect.gen(function* () {
          yield* emit({
            ...(yield* makeEventStamp()),
            type: "item.completed",
            provider: PROVIDER,
            threadId: ctx.session.threadId,
            turnId,
            itemId: RuntimeItemId.make(toolCall.toolCallId),
            payload: {
              itemType: "mcp_tool_call",
              status: result.status === "succeeded" ? "completed" : "failed",
              title: toolCall.canonicalToolName,
              data: {
                toolName: toolCall.canonicalToolName,
                input: toolCall.arguments,
                ...(result.status === "succeeded" && result.result !== undefined
                  ? { canvas: result.result }
                  : {}),
                result: {
                  content: encodeUnknownJson(
                    result.status === "succeeded"
                      ? result.result
                      : { errorCode: result.errorCode ?? "tool_failed" },
                  ),
                },
              },
            },
          });
        }).pipe(Effect.orDie);
      const agentSystemPrompt = [
        systemPrompt,
        "你正在 Code Work 中处理当前项目，可用操作以本轮工具清单为准。",
        `当前项目工作区根目录是：${ctx.cwd}`,
        "当用户要求审查、读取或分析代码时，先使用可用的工作区工具取得证据，不要声称没有项目上下文。",
        isPlanMode
          ? "当前为计划模式，仅分析代码并给出计划，不执行文件修改或命令。"
          : "当用户要求创建或修改文件、执行命令时，使用本轮已授权工具完成操作。",
        // 对齐 Cursor canvas skill 的常驻语义：独立分析交付物默认用 Canvas
        // 承载，而不是把结论倒进 markdown 表格或长代码块。
        "当产出独立的分析型交付物（审计、评审、代码地图、量化分析、数据密集结论、对比、时间线）时，优先用 canvas.create 工具承载并随任务推进复用相同 canvasId 更新它，而不是写大段 markdown 表格或长代码块；定向实现、调试等明确交付物不适用。",
        "画布只能通过调用 canvas.create 工具创建：把画布 JSON 写进回复正文或代码块不会生成画布面板。",
      ]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
      const outcome = yield* Effect.exit(
        runByokAgentLoop(
          {
            taskId: String(ctx.session.threadId),
            runId: String(turnId),
            agentId: `provider:${boundInstanceId}`,
            runtimeId: `byok:${boundInstanceId}`,
            threadId: String(ctx.session.threadId),
            workspaceRoot: ctx.cwd,
            prompt: renderAgentConversation(effectiveMessages),
            capabilityGrantIds: projectTools.map((tool) =>
              compositionToolCapabilityId(tool.canonicalToolName),
            ),
            tools: projectTools,
            runtimeMode,
            onTextCheckpoint: (checkpoint) =>
              Effect.gen(function* () {
                appendTurnItem(ctx, turnId, { type: "text", text: checkpoint.delta });
                yield* emit({
                  ...(yield* makeEventStamp()),
                  type: "content.delta",
                  provider: PROVIDER,
                  threadId: ctx.session.threadId,
                  turnId,
                  payload: { streamKind: "assistant_text", delta: checkpoint.delta },
                });
              }).pipe(Effect.orDie),
            onReasoningCheckpoint: (checkpoint) =>
              Effect.gen(function* () {
                appendTurnItem(ctx, turnId, { type: "thinking", text: checkpoint.delta });
                // 每轮模型调用对应一条 Thought 行：summaryIndex 取模型轮次，轮间
                // 的思考块与工具行按时间交错，而不是全部汇进同一个折叠行。
                yield* emit({
                  ...(yield* makeEventStamp()),
                  type: "content.delta",
                  provider: PROVIDER,
                  threadId: ctx.session.threadId,
                  turnId,
                  payload: {
                    streamKind: "reasoning_summary_text",
                    delta: checkpoint.delta,
                    summaryIndex: checkpoint.turn,
                  },
                });
              }).pipe(Effect.orDie),
            onToolStarted: (toolCall) => emitToolRowStarted(toolCall),
            onToolCompleted: (toolCall, result) => emitToolRowCompleted(toolCall, result),
            onModelUsage: (usage) =>
              emitThreadTokenUsage(ctx, turnId, adapter, usage).pipe(Effect.orDie),
          },
          makeByokModelDriver(httpClient, {
            protocol: adapter.protocol,
            baseURL: adapter.baseURL,
            apiKey: adapter.apiKey,
            modelId: adapter.modelId,
            contextWindowTokens: adapter.contextWindowTokens,
            ...(adapter.maxOutputTokens !== undefined
              ? { maxOutputTokens: adapter.maxOutputTokens }
              : {}),
            ...(adapter.customHeaders !== undefined && adapter.customHeaders.trim().length > 0
              ? { customHeaders: adapter.customHeaders }
              : {}),
            ...(reasoningEffort !== undefined && reasoningEffort.trim().length > 0
              ? { reasoningEffort }
              : {}),
            systemPrompt: agentSystemPrompt,
          }),
          toolBroker,
        ),
      );

      if (sessions.get(ctx.session.threadId) !== ctx) return;
      ctx.activeTurnId = undefined;
      ctx.activeTurnFiber = undefined;
      yield* updateSession(ctx, { status: "ready" }, true);

      if (Exit.isFailure(outcome)) {
        if (Cause.hasInterruptsOnly(outcome.cause)) return;
        const detail =
          Option.getOrUndefined(Cause.findErrorOption(outcome.cause))?.message ??
          "BYOK agent turn failed.";
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "runtime.error",
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId,
          payload: { message: detail, class: "provider_error" },
        });
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "turn.completed",
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId,
          payload: { state: "failed", errorMessage: detail },
        });
        return;
      }

      // 抢救落空的画布交付：模型偶尔把画布 JSON 以代码块写进正文而不调用
      // canvas.create。本回合没走过该工具且正文里能解析出画布时，改道真实
      // 的工具调用把交付物落成画布；解析失败则原文原样保留。
      if (
        outcome.value.messages.some(
          (message) => message.role === "tool" && message.canonicalToolName === "canvas.create",
        ) !== true
      ) {
        const rawCanvas = extractRescuableCanvas(outcome.value.text);
        const rescuedCanvas =
          rawCanvas === undefined ? undefined : normalizeRescuedCanvas(rawCanvas, ctx.cwd);
        if (rescuedCanvas !== undefined) {
          const toolCallId = `canvas-rescue-${yield* randomUUIDv4}`;
          const toolCall: ByokAgentToolCall = {
            toolCallId,
            canonicalToolName: "canvas.create",
            arguments: rescuedCanvas,
          };
          yield* emitToolRowStarted(toolCall);
          const result = yield* toolBroker.invoke({
            taskId: String(ctx.session.threadId),
            runId: String(turnId),
            agentId: `provider:${boundInstanceId}`,
            runtimeId: `byok:${boundInstanceId}`,
            threadId: String(ctx.session.threadId),
            runtimeMode,
            toolCallId,
            canonicalToolName: toolCall.canonicalToolName,
            arguments: rescuedCanvas,
            idempotencyKey: `${turnId}:${toolCallId}`,
            capabilityGrantIds: projectTools.map((tool) =>
              compositionToolCapabilityId(tool.canonicalToolName),
            ),
            workspaceRoot: ctx.cwd,
          });
          yield* emitToolRowCompleted(toolCall, result);
        }
      }

      ctx.history.push({ role: "assistant", content: outcome.value.text });
      ctx.history = fitHistory(ctx.history, adapter.contextWindowTokens);
      // 历史定型后、终态事件前落盘：turn.completed 即"已可恢复"的回执。
      yield* persistSessionState(ctx);
      yield* emit({
        ...(yield* makeEventStamp()),
        type: "turn.completed",
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        turnId,
        payload: { state: "completed" },
      });
    });

    const sendTurn: ByokAdapterShape["sendTurn"] = Effect.fn("byokSendTurn")(function* (input) {
      const ctx = yield* requireSession(input.threadId);
      const text = input.input?.trim() ?? "";
      const attachments = input.attachments ?? [];
      if (!text && attachments.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "BYOK turns require text or image-attachment input.",
        });
      }
      const modelSelection = input.modelSelection;
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `BYOK model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const model = modelSelection?.model ?? ctx.session.model;
      const adapter = byokAdapterForModel(byokSettings, model);
      if (adapter === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            byokSettings.adapters.length === 0
              ? "No BYOK model adapters are configured. Add one in Settings."
              : `No BYOK model adapter matches model '${model ?? ""}'.`,
        });
      }

      const turnId = TurnId.make(`byok-turn-${yield* randomUUIDv4}`);
      ctx.activeTurnId = turnId;
      yield* updateSession(ctx, {
        status: "running",
        activeTurnId: turnId,
        model: model ?? adapter.id,
      });

      yield* emit({
        ...(yield* makeEventStamp()),
        type: "turn.started",
        provider: PROVIDER,
        threadId: input.threadId,
        turnId,
        payload: { model: model ?? adapter.id },
      });
      // Resolve image attachments to inline base64 parts from the server-side
      // attachment store; nothing client-supplied is trusted beyond its id.
      const contentParts: ByokContentPart[] = [];
      if (text.length > 0) {
        contentParts.push({ type: "text", text });
      }
      for (const attachment of attachments) {
        if (attachment.type !== "image") continue;
        if (!BYOK_SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Unsupported BYOK image attachment type '${attachment.mimeType}'.`,
          });
        }
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/start",
                detail: "Failed to read attachment file.",
                cause,
              }),
          ),
        );
        contentParts.push({
          type: "image",
          mimeType: attachment.mimeType,
          dataBase64: Buffer.from(bytes).toString("base64"),
        });
      }
      appendTurnItem(ctx, turnId, {
        type: "user",
        text: text.length > 0 ? text : `[${contentParts.length} image attachment(s)]`,
      });
      ctx.history.push({
        role: "user",
        content:
          contentParts.length === 1 && contentParts[0]?.type === "text"
            ? contentParts[0].text
            : contentParts,
      });
      const messages = fitHistory(ctx.history, adapter.contextWindowTokens);
      // Prompt-template injection: user-selected template/custom text plus the
      // optional software-Chinese policy, rendered against the active model.
      // Remote template content never activates without an explicit save.
      const systemPrompt = renderPromptTemplate(
        applyPromptTemplate("", byokSettings.promptTemplate ?? {}),
        adapter.modelId,
      );

      const reasoningEffort =
        modelSelection === undefined
          ? undefined
          : getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
      const turnEffect =
        options?.toolBroker !== undefined && text.length > 0 && attachments.length === 0
          ? runAgentTurn(
              ctx,
              turnId,
              adapter,
              messages,
              systemPrompt,
              options.toolBroker,
              input.interactionMode === "plan",
              reasoningEffort,
            )
          : runTurn(ctx, turnId, adapter, messages, systemPrompt, reasoningEffort);
      const fiber = yield* turnEffect.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const detail =
              Option.getOrUndefined(Cause.findErrorOption(cause))?.message ??
              "BYOK engine turn failed.";
            if (ctx.activeTurnId !== undefined) {
              ctx.activeTurnId = undefined;
              ctx.activeTurnFiber = undefined;
              yield* updateSession(ctx, { status: "error" }, true);
            }
            yield* emit({
              ...(yield* makeEventStamp()),
              type: "runtime.error",
              provider: PROVIDER,
              threadId: ctx.session.threadId,
              turnId,
              payload: { message: detail, class: "provider_error" },
            });
            yield* persistSessionState(ctx);
            yield* emit({
              ...(yield* makeEventStamp()),
              type: "turn.completed",
              provider: PROVIDER,
              threadId: ctx.session.threadId,
              turnId,
              payload: { state: "failed", errorMessage: detail },
            });
          }),
        ),
        Effect.forkIn(adapterScope),
      );
      ctx.activeTurnFiber = fiber;

      return {
        threadId: input.threadId,
        turnId,
      };
    });

    const interruptTurn: ByokAdapterShape["interruptTurn"] = Effect.fn("byokInterruptTurn")(
      function* (threadId, turnId) {
        const ctx = yield* requireSession(threadId);
        const interruptedTurnId = turnId ?? ctx.activeTurnId;
        const activeFiber = ctx.activeTurnFiber;
        ctx.activeTurnId = undefined;
        ctx.activeTurnFiber = undefined;
        if (activeFiber !== undefined) {
          yield* Fiber.interrupt(activeFiber).pipe(Effect.exit, Effect.asVoid);
        }
        yield* updateSession(ctx, { status: "ready" }, true);
        // 中断后的部分历史（用户消息 + 已流出的内容）同样落盘，保持与
        // 内存状态一致，turn.aborted 即"已可恢复"的回执。
        yield* persistSessionState(ctx);
        if (interruptedTurnId !== undefined) {
          yield* emit({
            ...(yield* makeEventStamp()),
            type: "turn.aborted",
            provider: PROVIDER,
            threadId,
            turnId: interruptedTurnId,
            payload: { reason: "Interrupted by user." },
          });
        }
      },
    );

    const respondToRequest: ByokAdapterShape["respondToRequest"] = Effect.fn(
      "byokRespondToRequest",
    )(function* () {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "request/respond",
        detail: "The BYOK engine does not expose interactive approval requests.",
      });
    });

    const respondToUserInput: ByokAdapterShape["respondToUserInput"] = Effect.fn(
      "byokRespondToUserInput",
    )(function* () {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user-input/respond",
        detail: "The BYOK engine does not expose structured user-input requests.",
      });
    });

    const stopSession: ByokAdapterShape["stopSession"] = Effect.fn("byokStopSession")(
      function* (threadId) {
        const ctx = yield* requireSession(threadId);
        const activeFiber = ctx.activeTurnFiber;
        sessions.delete(threadId);
        if (activeFiber !== undefined) {
          yield* Fiber.interrupt(activeFiber).pipe(Effect.exit, Effect.asVoid);
        }
        yield* updateSession(ctx, { status: "closed" }, true);
        yield* emit({
          ...(yield* makeEventStamp()),
          type: "session.exited",
          provider: PROVIDER,
          threadId,
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
        });
      },
    );

    const listSessions: ByokAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session));

    const hasSession: ByokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: ByokAdapterShape["readThread"] = Effect.fn("byokReadThread")(
      function* (threadId) {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      },
    );

    const rollbackThread: ByokAdapterShape["rollbackThread"] = Effect.fn("byokRollbackThread")(
      function* (threadId, numTurns) {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        if (ctx.activeTurnFiber !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/rollback",
            detail: "Cannot roll back a BYOK thread while a turn is running.",
          });
        }
        // Each completed turn is one user + one assistant message in history
        // and one snapshot entry; truncate both.
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        const keepTurns = Math.max(0, Math.floor(ctx.history.length / 2) - numTurns);
        ctx.history.splice(keepTurns * 2);
        yield* persistSessionState(ctx);
        return { threadId, turns: ctx.turns };
      },
    );

    const stopAll: ByokAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies ByokAdapterShape;
  });
}
