/**
 * PiAdapter — Pi CLI（`pi --mode rpc`）的 Provider 适配器。
 *
 * BYOK 构造性强制：模型选择只接受 BYOK 网关路由（受管 models.json 里的
 * codework-* provider），未知模型 fail-closed。Code Work 工具经现有宿主
 * MCP 通道注入（`--mcp-config`，与 Claude/Codex/Cursor/Grok/OpenCode 一致）；
 * Pi 原生工具没有客户端执行协议，只做事件可见映射。
 *
 * 事件解析是 Pi 专属的（agent_end/agent_settled 双事件终态、message_update
 * 增量、tool_execution_* 通知）；OhMyPi 的语义差异见 OmpAdapter。
 *
 * @module provider/Layers/PiAdapter
 */
// @effect-diagnostics globalDate:off globalDateInEffect:off - 看门狗/活跃度/时间戳按墙上时间判断。
// @effect-diagnostics preferSchemaOverJson:off - 工具参数摘要的 JSON 序列化。
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ApprovalRequestId,
  type PiAgentSettings,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type ThreadId,
  ProviderDriverKind,
  RuntimeItemId,
  RuntimeRequestId,
  TurnId,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import { readMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { makeJsonlRpcProcess } from "../pifamily/jsonlRpcProcess.ts";
import type { PiRuntimeEvent, PiSessionState } from "../pifamily/piRpcTypes.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import {
  type PifamilyEmitApi,
  type PifamilySessionContext,
  forkPifamilyWatchdog,
  handlePifamilyProcessExit,
  makePifamilyEventQueue,
  makePifamilyEventStampFactory,
  makePifamilyTerminalApi,
  pifamilyEmitToQueue,
  emitPifamilyTokenUsage,
  pifamilyRandomUUID,
  readPifamilyImageAttachments,
  resolvePifamilyModel,
  settlePendingInteractions,
  spawnPifamilyProcess,
} from "../pifamily/pifamilyAdapterSupport.ts";

const PROVIDER = ProviderDriverKind.make("piAgent");
const RAW_SOURCE = "pi.rpc" as const;
export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** 已清洗并注入 PI_CODING_AGENT_DIR 的子进程环境。 */
  readonly environment: Readonly<Record<string, string>>;
  /** 解析当前可用的 BYOK 网关模型路由（driver 提供，读 settings）。 */
  readonly resolveRoutes: Effect.Effect<ReadonlyArray<PifamilyModelRoute>, ProviderAdapterError>;
}

/** Pi 会话恢复游标：pi 的 session 文件路径。 */
export interface PiResumeCursor {
  readonly piSessionFile: string;
}

const decodePiResumeCursor = (cursor: unknown): PiResumeCursor | undefined => {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const file = (cursor as { readonly piSessionFile?: unknown }).piSessionFile;
  return typeof file === "string" && file.length > 0 ? { piSessionFile: file } : undefined;
};

/** 允许映射为用户输入的问答 method；其余 extension_ui_request 一律忽略。 */
const PI_USER_INPUT_METHODS: ReadonlySet<string> = new Set([
  "select",
  "input",
  "editor",
  "confirm",
]);

const piToolItemType = (
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" => {
  if (toolName === "bash" || toolName === "shell") return "command_execution";
  if (toolName === "edit" || toolName === "write" || toolName === "apply_patch") {
    return "file_change";
  }
  return "dynamic_tool_call";
};

/** 把用户填写的 launchArgs 按引号语义拆成 argv 片段。 */
export function splitPifamilyLaunchArgs(launchArgs: string): ReadonlyArray<string> {
  const trimmed = launchArgs.trim();
  if (trimmed.length === 0) return [];
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const character of trimmed) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export const makePiAdapter = (config: PiAgentSettings, options: PiAdapterOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const randomUUID = pifamilyRandomUUID(crypto);
    const makeStamp = makePifamilyEventStampFactory(randomUUID);

    // 适配器兜底 scope：防止会话句柄在 stopAll 之外泄漏。
    const adapterScope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sessions.clear();
        yield* Scope.close(adapterScope, Exit.void);
      }),
    );

    const sessions = new Map<ThreadId, PifamilySessionContext>();
    const eventQueue = yield* makePifamilyEventQueue();

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<PifamilySessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (ctx === undefined) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
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

    // ── Pi 专属事件解析（与 OMP 的解析器相互独立）──────────────────
    const handlePiEvent = Effect.fn("piAdapter.handlePiEvent")(function* (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      frame: unknown,
    ) {
      const event = frame as PiRuntimeEvent;
      const turnId = emitApi.currentTurnId();
      const terminal = makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi });

      if (event.type === "process_exit") {
        yield* handlePifamilyProcessExit({
          ctx,
          provider: PROVIDER,
          emitApi,
          terminal,
          error: event.error,
        });
        return;
      }

      switch (event.type) {
        case "agent_start":
        case "turn_start": {
          if (ctx.turn !== null && !ctx.turn.started) {
            ctx.turn.started = true;
            emitApi.touchTurn();
          }
          return;
        }
        case "message_start": {
          // 回合级 assistant 消息 id 在 sendTurn 已生成；responseId 仅作参考。
          return;
        }
        case "message_update": {
          if (event.message !== undefined && event.message.role !== "assistant") return;
          if (event.assistantMessageEvent.type === "text_delta") {
            emitApi.touchTurn();
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "content.delta",
              turnId,
              ...(ctx.currentAssistantMessageId === null
                ? {}
                : { itemId: RuntimeItemId.make(ctx.currentAssistantMessageId) }),
              payload: {
                streamKind: "assistant_text",
                delta: event.assistantMessageEvent.delta ?? "",
              },
              raw: { source: RAW_SOURCE, method: "message_update", payload: event },
            });
            return;
          }
          if (event.assistantMessageEvent.type === "thinking_delta") {
            emitApi.touchTurn();
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "content.delta",
              turnId,
              payload: {
                streamKind: "reasoning_text",
                delta: event.assistantMessageEvent.delta ?? "",
              },
              raw: { source: RAW_SOURCE, method: "message_update", payload: event },
            });
          }
          return;
        }
        case "message_end": {
          if (event.message.role === "assistant") {
            ctx.currentAssistantMessageId = null;
            return;
          }
          if (event.message.role === "user" || event.message.role === "custom") {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "item.completed",
              turnId,
              payload: { itemType: "user_message", status: "completed" },
            });
          }
          return;
        }
        case "tool_execution_start": {
          ctx.activeToolCalls.set(event.toolCallId, {
            toolName: event.toolName,
            args: event.args,
          });
          emitApi.touchTurn();
          emitApi.appendTurnItem({ toolName: event.toolName, args: event.args });
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.started",
            turnId,
            itemId: RuntimeItemId.make(event.toolCallId),
            payload: {
              itemType: piToolItemType(event.toolName),
              status: "inProgress",
              title: event.toolName,
              detail: `${event.toolName} ${JSON.stringify(event.args)}`.slice(0, 200),
              data: { toolName: event.toolName, args: event.args },
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "tool_execution_update": {
          emitApi.touchTurn();
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.updated",
            turnId,
            itemId: RuntimeItemId.make(event.toolCallId),
            payload: {
              itemType: piToolItemType(event.toolName),
              status: "inProgress",
              title: event.toolName,
              detail: `${event.toolName} …`,
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "tool_execution_end": {
          const active = ctx.activeToolCalls.get(event.toolCallId);
          ctx.activeToolCalls.delete(event.toolCallId);
          emitApi.touchTurn();
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            itemId: RuntimeItemId.make(event.toolCallId),
            payload: {
              itemType: piToolItemType(event.toolName),
              status: event.isError === true ? "failed" : "completed",
              title: event.toolName,
              detail:
                `${active?.toolName ?? event.toolName} ${event.isError === true ? "failed" : "completed"}`.slice(
                  0,
                  200,
                ),
              data: {
                toolName: active?.toolName ?? event.toolName,
                result: event.result,
                ...(event.isError === true ? { isError: true } : {}),
              },
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "compaction_start":
        case "compaction_end": {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            payload: {
              itemType: "context_compaction",
              status: event.type === "compaction_end" ? "completed" : "inProgress",
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "auto_retry_start": {
          emitApi.touchTurn();
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "runtime.warning",
            turnId,
            payload: {
              message: `Pi provider retry (attempt ${event.attempt}): ${event.errorMessage}`,
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "agent_end": {
          const turn = ctx.turn;
          if (turn === null || turn.settled) return;
          turn.pendingSettledMessages = event.messages ?? [];
          yield* emitPifamilyTokenUsage(turn.pendingSettledMessages, emitApi);
          // willRetry=true 时失败会自动重试，等 agent_settled 才终态。
          if (event.willRetry !== true) {
            yield* terminal.completeTurn("agent_end");
          }
          return;
        }
        case "agent_settled": {
          yield* terminal.completeTurn("agent_settled");
          return;
        }
        case "extension_ui_request": {
          // 只把真正的问答 method 映射为用户输入；其余宿主 UI 请求忽略。
          if (PI_USER_INPUT_METHODS.has(event.method)) {
            yield* openPiUserInput(ctx, emitApi, event);
          }
          return;
        }
        default:
          // 未知事件（协议漂移）：丢弃，不中断会话。
          return;
      }
    });

    const openPiUserInput = (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      event: Extract<PiRuntimeEvent, { type: "extension_ui_request" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Record<string, unknown>>();
        ctx.pendingUserInputs.set(ApprovalRequestId.make(event.id), {
          requestId: ApprovalRequestId.make(event.id),
          resolve: deferred,
        });
        const question =
          event.title ?? event.message ?? event.placeholder ?? `Pi ${event.method} request`;
        const optionLabels = Array.isArray(event.options) ? event.options : [];
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "user-input.requested",
          turnId: emitApi.currentTurnId(),
          requestId: RuntimeRequestId.make(event.id),
          payload: {
            questions: [
              {
                id: event.id,
                header: "Response",
                question,
                options: optionLabels.map((label) => ({ label, description: label })),
                multiSelect: false,
              },
            ],
          },
          raw: { source: RAW_SOURCE, method: "extension_ui_request", payload: event },
        });
      });

    const startSession = Effect.fn("piAdapter.startSession")(function* (
      input: ProviderSessionStartInput,
    ) {
      const existing = sessions.get(input.threadId);
      if (existing !== undefined) {
        return existing.session;
      }

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

      const resumeCursor = decodePiResumeCursor(input.resumeCursor);
      const mcpSession = readMcpProviderSession(input.threadId);

      const sessionScope = yield* Scope.make();
      // 适配器兜底：stopSession 之外的会话泄漏在适配器销毁时清理。
      yield* Scope.addFinalizer(adapterScope, Scope.close(sessionScope, Exit.void));

      const startResult = yield* Effect.gen(function* () {
        let mcpConfigPath: string | undefined;
        if (mcpSession !== undefined) {
          const tempDir = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "codework-pi-mcp-" })
            .pipe(Effect.provideService(Scope.Scope, sessionScope));
          mcpConfigPath = path.join(tempDir, "mcp.json");
          // 与 ~/.pi/agent/mcp.json 同构：mcpServers 映射 + auth/oauth 关闭。
          const mcpConfig = {
            mcpServers: {
              "code-work": {
                url: mcpSession.endpoint,
                headers: { Authorization: mcpSession.authorizationHeader },
                auth: false,
                oauth: false,
              },
            },
          };
          yield* fileSystem.writeFileString(
            mcpConfigPath,
            `${JSON.stringify(mcpConfig, null, 2)}\n`,
          );
        }

        const args = [
          "--mode",
          "rpc",
          "--model",
          `${model.provider}/${model.adapterId}`,
          ...(resumeCursor === undefined ? [] : ["--session", resumeCursor.piSessionFile]),
          ...(mcpConfigPath === undefined ? [] : ["--mcp-config", mcpConfigPath]),
          ...splitPifamilyLaunchArgs(config.launchArgs),
        ];
        const spawn = spawnPifamilyProcess({
          spawner,
          diagnosticName: "Pi",
          binaryPath: config.binaryPath,
          args,
          cwd: input.cwd,
          environment: options.environment,
        });
        const rpcProcess = yield* makeJsonlRpcProcess({
          diagnosticName: "Pi",
          spawn,
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const state = (yield* rpcProcess.request({ type: "get_state" }, 20_000).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "get_state",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        )) as PiSessionState | undefined;

        const now = new Date().toISOString();
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
            resumeCursor:
              state?.sessionFile === undefined ? {} : { piSessionFile: state.sessionFile },
            createdAt: now,
            updatedAt: now,
          },
          sessionScope,
          process: rpcProcess,
          model,
          turns: [],
          turn: null,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          activeToolCalls: new Map(),
          currentAssistantMessageId: null,
          toolBroker: null,
        };
        sessions.set(input.threadId, ctx);

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
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "thread.started",
          payload: { providerThreadId: state?.sessionId ?? "" },
        });

        yield* rpcProcess.streamEvents
          .pipe(
            Stream.runForEach((frame) => handlePiEvent(ctx, emitApi, frame)),
            Effect.forkScoped,
          )
          .pipe(Effect.provideService(Scope.Scope, sessionScope));

        yield* forkPifamilyWatchdog({
          ctx,
          provider: PROVIDER,
          emitApi,
          terminal: makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi }),
        }).pipe(Effect.provideService(Scope.Scope, sessionScope));

        return ctx.session;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        ),
        Effect.onError(() =>
          Effect.gen(function* () {
            sessions.delete(input.threadId);
            yield* Scope.close(sessionScope, Exit.void);
          }),
        ),
      );
      return startResult;
    });

    const sendTurn = Effect.fn("piAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
      const ctx = yield* requireSession(input.threadId);
      const text = input.input?.trim() ?? "";
      const attachments = input.attachments ?? [];
      if (!text && attachments.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Pi turns require text or image-attachment input.",
        });
      }
      if (ctx.turn !== null && !ctx.turn.settled) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A Pi turn is already active on this thread.",
        });
      }

      const selectedModel =
        input.modelSelection !== undefined && input.modelSelection.instanceId === options.instanceId
          ? input.modelSelection.model
          : undefined;
      if (selectedModel !== undefined && selectedModel !== ctx.model.adapterId) {
        const routes = yield* options.resolveRoutes;
        const nextModel = yield* resolvePifamilyModel({
          routes,
          provider: PROVIDER,
          operation: "sendTurn",
          selectedModel,
        });
        yield* ctx.process
          .request(
            { type: "set_model", provider: nextModel.provider, modelId: nextModel.adapterId },
            20_000,
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "set_model",
                  detail: cause instanceof Error ? cause.message : String(cause),
                }),
            ),
          );
        ctx.model = nextModel;
        ctx.session = { ...ctx.session, model: nextModel.adapterId };
      }

      const turnId = TurnId.make(`pi-turn-${yield* randomUUID}`);
      // 回合级 assistant 消息 id：responseId 跨回合可能重复，不能直接当消息 id。
      ctx.currentAssistantMessageId = `pi-msg-${yield* randomUUID}`;
      ctx.turn = {
        turnId,
        started: false,
        pendingSettledMessages: null,
        interrupting: false,
        settled: false,
        lastActivityAt: Date.now(),
      };
      ctx.session = { ...ctx.session, status: "running", activeTurnId: turnId };

      const emitApi = makeEmitApi(ctx);
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "turn.started",
        turnId,
        payload: { model: ctx.model.adapterId },
      });

      const images = yield* readPifamilyImageAttachments(
        PROVIDER,
        attachments,
        serverConfig.attachmentsDir,
        fileSystem,
      );

      // prompt 的 ack 立即返回；终态由 agent_end/agent_settled/process_exit 驱动。
      yield* Effect.gen(function* () {
        const ack = (yield* ctx.process.request(
          { type: "prompt", message: text, ...(images.length > 0 ? { images } : {}) },
          60_000,
        )) as { readonly agentInvoked?: boolean } | undefined;
        const turn = ctx.turn;
        if (turn === null || turn.settled) return;
        if (ack?.agentInvoked === false) {
          // 斜杠命令等不经 agent 的输入：立即终态。
          yield* makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi }).completeTurn(
            "no_agent_invoked",
          );
        }
      })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const terminal = makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi });
              const turn = ctx.turn;
              if (turn === null || turn.settled) return;
              if (turn.interrupting) {
                yield* terminal.abortTurn("interrupted");
                return;
              }
              yield* terminal.failTurn(`Pi prompt failed: ${String(cause)}`);
            }),
          ),
          Effect.forkScoped,
        )
        .pipe(Effect.provideService(Scope.Scope, ctx.sessionScope));

      return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
    });

    const interruptTurn = Effect.fn("piAdapter.interruptTurn")(function* (threadId: ThreadId) {
      const ctx = yield* requireSession(threadId);
      const turn = ctx.turn;
      if (turn === null || turn.settled) return;
      turn.interrupting = true;
      // 旧版本 pi 没有 clear_queue；"Unknown command" 时直接 abort。
      yield* ctx.process
        .request({ type: "clear_queue" }, 10_000)
        .pipe(Effect.catchCause(() => Effect.void));
      yield* ctx.process
        .request({ type: "abort" }, 10_000)
        .pipe(Effect.catchCause(() => Effect.void));
      yield* makePifamilyTerminalApi({
        provider: PROVIDER,
        ctx,
        emitApi: makeEmitApi(ctx),
      }).abortTurn("interrupted");
    });

    const stopSession = Effect.fn("piAdapter.stopSession")(function* (threadId: ThreadId) {
      const ctx = yield* requireSession(threadId);
      const emitApi = makeEmitApi(ctx);
      const terminal = makePifamilyTerminalApi({ provider: PROVIDER, ctx, emitApi });
      yield* settlePendingInteractions(ctx);
      yield* terminal.abortTurn("session stopped");
      yield* ctx.process.close("Pi session stopped");
      sessions.delete(threadId);
      ctx.session = { ...ctx.session, status: "closed" };
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "session.exited",
        payload: { exitKind: "graceful" },
      });
      yield* Scope.close(ctx.sessionScope, Exit.void);
    });

    const respondToUserInput = Effect.fn("piAdapter.respondToUserInput")(function* (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (pending === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "respondToUserInput",
          issue: `No pending Pi user-input request '${requestId}'.`,
        });
      }
      ctx.pendingUserInputs.delete(requestId);
      yield* Deferred.succeed(pending.resolve, answers);
      const firstAnswer = Object.values(answers).find((value) => typeof value === "string");
      yield* ctx.process
        .send({
          type: "extension_ui_response",
          id: requestId,
          ...(typeof firstAnswer === "string" ? { value: firstAnswer } : { cancelled: true }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
          ),
        );
      const emitApi = makeEmitApi(ctx);
      yield* emitApi.emit({
        ...(yield* makeStamp()),
        type: "user-input.resolved",
        turnId: emitApi.currentTurnId(),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
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
            issue: `Pi RPC mode has no tool approval request '${requestId}'.`,
          });
        }),
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((ctx) => ctx.session)),
      hasSession: (threadId: ThreadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          return {
            threadId,
            turns: ctx.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
          } satisfies ProviderThreadSnapshot;
        }),
      rollbackThread: (threadId: ThreadId) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: `Pi adapter does not support thread rollback for ${threadId}.`,
          }),
        ),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
          discard: true,
        }),
      streamEvents: eventQueue.stream,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
