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
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  type ApprovalRequestId,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
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

interface ZCodeSessionState {
  readonly ctx: PifamilySessionContext;
  /** 当前回合的进程；回合之间为 null。 */
  current: JsonlRpcProcess | null;
  zcodeSessionId: string | undefined;
  /** 是否已经收到过流式文本增量；否则终态时用 turn.completed.response 兜底。 */
  streamedText: boolean;
  threadStarted: boolean;
}

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
        queue: eventQueue.queue,
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
        const turn = ctx.turn;
        if (turn === null || turn.settled) return;
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

      const sessionId = asString(event.sessionId);
      if (sessionId !== undefined) yield* adoptSessionId(state, emitApi, sessionId);
      const payload = asRecord(event.payload);
      const turnId = emitApi.currentTurnId();
      emitApi.touchTurn();
      const raw = { source: RAW_SOURCE, method: type, payload: frame } as const;

      switch (type) {
        case "model.streaming": {
          const kind = asString(payload.kind);
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
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "item.started",
              turnId,
              itemId: RuntimeItemId.make(toolCallId),
              payload: {
                itemType,
                status: "inProgress",
                title: toolName,
                detail: `${toolName} ${JSON.stringify(payload.input ?? {})}`.slice(0, 200),
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
          const tokenCount = payload.tokenCount;
          if (
            typeof tokenCount === "number" &&
            Number.isSafeInteger(tokenCount) &&
            tokenCount > 0
          ) {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "thread.token-usage.updated",
              payload: { usage: { usedTokens: tokenCount, lastUsedTokens: tokenCount } },
            });
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
        case "result": {
          // stream-json 的终止行：兜底结算（turn.completed 通常已先到）。
          yield* terminal.completeTurn("result");
          return;
        }
        default:
          // 其余会话事件（消息/part 镜像、权限、检查点等）不进时间线；协议漂移一律忽略。
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
            binaryPath: options.spawnTarget.command,
            args,
            cwd: ctx.session.cwd,
            environment: { ...options.environment, ...zcodeSpawnEnv(options.spawnTarget) },
          }),
        }).pipe(
          Effect.provideService(Scope.Scope, turnScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        state.current = proc;
        yield* proc.streamEvents.pipe(
          Stream.runForEach((frame) => handleFrame(state, emitApi, proc, frame)),
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
      capabilities: { sessionModelSwitch: "in-session" },
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
