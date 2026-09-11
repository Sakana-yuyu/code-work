// @effect-diagnostics globalDate:off globalDateInEffect:off preferSchemaOverJson:off - 看门狗按墙上时间；工具摘要 JSON 序列化。
/**
 * OmpAdapter — OhMyPi（`omp --mode rpc-ui`）的 Provider 适配器。
 *
 * 与 Pi 同族 wire 格式但语义独立，本文件的事件解析不复用 Pi 的映射：
 *  - 协议 v2（ready → negotiate_protocol → chunked frames）；
 *  - host tools：`set_host_tools` 注册 Code Work canonical 工具，omp 的
 *    `host_tool_call`/`host_tool_cancel` 经 ToolBroker 桥执行（审批/拒绝/
 *    取消/失败全状态）；
 *  - 内置工具审批：`extension_ui_request`（Allow tool … Approve/Deny）映射
 *    `request.opened`，经 `thread.approval.respond` 决策；
 *  - 子代理 lifecycle/progress 映射 task.* 事件；
 *  - todo / notice / goal / auto-compaction 独立映射。
 *
 * 模型路由与 Pi 相同：BYOK 构造性强制，fail-closed。
 *
 * @module provider/Layers/OmpAdapter
 */
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  type OmpAgentSettings,
  type ProviderApprovalDecision,
  type ProviderInstanceId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadId,
  ProviderDriverKind,
  ApprovalRequestId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderToolBrokerBridge,
  ProviderToolBrokerContext,
} from "../Services/ProviderAdapter.ts";
import { makeJsonlRpcProcess } from "../pifamily/jsonlRpcProcess.ts";
import { supportsJsonlRpcProtocolV2 } from "../pifamily/jsonlFrameDecoder.ts";
import type { OmpRuntimeEvent, OmpSessionState } from "../pifamily/ompRpcTypes.ts";
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
import { splitPifamilyLaunchArgs } from "./PiAdapter.ts";

const PROVIDER = ProviderDriverKind.make("ompAgent");
const RAW_SOURCE = "omp.rpc" as const;
/** 与 Cursor 相同的 canonical 工具面：宿主工具注册进 omp 的白名单。 */
const OMP_TOOL_BROKER_CANONICAL_TOOLS: ReadonlyArray<string> = [
  "workspace.read_file",
  "workspace.write_file",
  "terminal.exec",
  "terminal.snapshot",
  "terminal.kill",
  "terminal.close",
];

const OMP_HOST_TOOL_DEFINITIONS = [
  {
    name: "workspace.read_file",
    description: "Read a text file inside the authorized workspace.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path." } },
      required: ["path"],
    },
  },
  {
    name: "workspace.write_file",
    description: "Write a text file inside the authorized workspace.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path." },
        content: { type: "string", description: "File content." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "terminal.exec",
    description: "Run a shell command in the authorized workspace terminal.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command line to execute." },
        cwd: { type: "string", description: "Working directory." },
      },
      required: ["command"],
    },
  },
  {
    name: "terminal.snapshot",
    description: "Read the current output snapshot of a terminal.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: { terminalId: { type: "string", description: "Terminal id." } },
      required: ["terminalId"],
    },
  },
  {
    name: "terminal.kill",
    description: "Terminate a terminal process.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: { terminalId: { type: "string", description: "Terminal id." } },
      required: ["terminalId"],
    },
  },
  {
    name: "terminal.close",
    description: "Close and release a terminal.",
    loadMode: "essential",
    parameters: {
      type: "object",
      properties: { terminalId: { type: "string", description: "Terminal id." } },
      required: ["terminalId"],
    },
  },
] as const;

const ompToolItemType = (
  toolName: string,
): "command_execution" | "file_change" | "dynamic_tool_call" => {
  if (toolName === "bash" || toolName === "shell") return "command_execution";
  if (toolName === "edit" || toolName === "write" || toolName === "apply_patch") {
    return "file_change";
  }
  return "dynamic_tool_call";
};

/** Code Work runtimeMode → omp --approval-mode。 */
export function ompApprovalModeForRuntime(
  setting: OmpAgentSettings["approvalMode"],
  runtimeMode: RuntimeMode,
): "always-ask" | "write" | "yolo" {
  if (setting === "always-ask" || setting === "write" || setting === "yolo") return setting;
  switch (runtimeMode) {
    case "approval-required":
      return "always-ask";
    case "full-access":
      return "yolo";
    default:
      return "write";
  }
}

/** omp 工具审批请求的特征（rpc-ui 的 select，Approve/Deny 选项）。 */
/** 允许映射为用户输入的问答 method；其余 extension_ui_request 一律忽略。 */
const OMP_USER_INPUT_METHODS: ReadonlySet<string> = new Set([
  "select",
  "input",
  "editor",
  "confirm",
]);

const isOmpToolApprovalRequest = (
  event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
): boolean => {
  const title = event.title ?? "";
  const options = Array.isArray(event.options) ? event.options : [];
  return title.startsWith("Allow tool:") && options.includes("Approve") && options.includes("Deny");
};

const approvalRequestTypeForTool = (
  toolName: string,
): "command_execution_approval" | "file_change_approval" | "dynamic_tool_call" => {
  if (toolName === "bash" || toolName === "shell") return "command_execution_approval";
  if (toolName === "edit" || toolName === "write") return "file_change_approval";
  return "dynamic_tool_call";
};

export interface OmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** 已清洗并注入 PI_CODING_AGENT_DIR 的子进程环境。 */
  readonly environment: Readonly<Record<string, string>>;
  readonly resolveRoutes: Effect.Effect<ReadonlyArray<PifamilyModelRoute>, ProviderAdapterError>;
}

/** OhMyPi 会话恢复游标：omp 的 session 文件路径。 */
export interface OmpResumeCursor {
  readonly ompSessionFile: string;
}

const decodeOmpResumeCursor = (cursor: unknown): OmpResumeCursor | undefined => {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
  const file = (cursor as { readonly ompSessionFile?: unknown }).ompSessionFile;
  return typeof file === "string" && file.length > 0 ? { ompSessionFile: file } : undefined;
};

export const makeOmpAdapter = (config: OmpAgentSettings, options: OmpAdapterOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;

    const adapterScope = yield* Scope.make();
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        sessions.clear();
        yield* Scope.close(adapterScope, Exit.void);
      }),
    );

    const sessions = new Map<ThreadId, PifamilySessionContext>();
    // 审批请求 → canonical requestType（resolve 事件需要回填）。
    const approvalRequestTypes = new Map<
      ApprovalRequestId,
      "command_execution_approval" | "file_change_approval" | "dynamic_tool_call"
    >();
    const approvalRequestTypeForRequest = (
      requestId: ApprovalRequestId,
    ): "command_execution_approval" | "file_change_approval" | "dynamic_tool_call" =>
      approvalRequestTypes.get(requestId) ?? "dynamic_tool_call";
    const eventQueue = yield* makePifamilyEventQueue();
    const randomUUID = pifamilyRandomUUID(crypto);
    const makeStamp = makePifamilyEventStampFactory(randomUUID);

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

    // ── OMP 专属事件解析（与 Pi 相互独立）─────────────────────────
    const handleOmpEvent = Effect.fn("ompAdapter.handleOmpEvent")(function* (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      frame: unknown,
    ) {
      const event = frame as OmpRuntimeEvent;
      const turnId = emitApi.currentTurnId();
      const terminal = makePifamilyTerminalApi({
        provider: PROVIDER,
        ctx,
        emitApi,
      });

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

      if (event.type === "host_tool_call" || event.type === "host_tool_cancel") {
        yield* routeOmpHostToolEvent(ctx, emitApi, event);
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
              itemType: ompToolItemType(event.toolName),
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
              itemType: ompToolItemType(event.toolName),
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
              itemType: ompToolItemType(event.toolName),
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
        case "agent_end": {
          const turn = ctx.turn;
          if (turn === null || turn.settled) return;
          turn.pendingSettledMessages = event.messages ?? [];
          yield* emitPifamilyTokenUsage(turn.pendingSettledMessages, emitApi);
          yield* terminal.completeTurn("agent_end");
          return;
        }
        case "compaction_start":
        case "compaction_end":
        case "auto_compaction_start":
        case "auto_compaction_end": {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            payload: {
              itemType: "context_compaction",
              status: event.type.endsWith("end") ? "completed" : "inProgress",
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
              message: `OhMyPi provider retry (attempt ${event.attempt}): ${event.errorMessage}`,
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "notice": {
          if (event.level === "error") {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "runtime.warning",
              turnId,
              payload: { message: event.message },
              raw: { source: RAW_SOURCE, method: event.type, payload: event },
            });
            return;
          }
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            payload: { itemType: "unknown", status: "completed", title: event.message },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "todo_reminder": {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            payload: {
              itemType: "plan",
              status: "completed",
              title: "Todos",
              data: event.todos,
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "goal_updated": {
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "item.completed",
            turnId,
            payload: {
              itemType: "unknown",
              status: "completed",
              title: event.goal?.objective ?? "Goal",
              data: event,
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "subagent_lifecycle": {
          const payload = event.payload;
          const statusByLifecycle = {
            started: "inProgress",
            completed: "completed",
            failed: "failed",
            aborted: "declined",
          } as const;
          const taskId = RuntimeTaskId.make(`omp-subagent-${payload.id}`);
          const taskStatus = statusByLifecycle[payload.status];
          if (taskStatus === "inProgress") {
            yield* emitApi.emit({
              ...(yield* makeStamp()),
              type: "task.started",
              turnId,
              payload: {
                taskId,
                description: payload.description ?? payload.agent,
                taskType: "provider_subagent",
              },
              raw: { source: RAW_SOURCE, method: event.type, payload: event },
            });
            return;
          }
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "task.completed",
            turnId,
            payload: {
              taskId,
              status:
                payload.status === "completed"
                  ? "completed"
                  : payload.status === "failed"
                    ? "failed"
                    : "stopped",
              summary: payload.description ?? payload.agent,
              taskType: "provider_subagent",
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "subagent_progress": {
          const payload = event.payload;
          const taskId = RuntimeTaskId.make(`omp-subagent-${payload.progress.id}`);
          emitApi.touchTurn();
          yield* emitApi.emit({
            ...(yield* makeStamp()),
            type: "task.progress",
            turnId,
            payload: {
              taskId,
              description: payload.progress.description ?? payload.task,
              status: payload.progress.status === "aborted" ? "cancelled" : payload.progress.status,
              taskType: "provider_subagent",
            },
            raw: { source: RAW_SOURCE, method: event.type, payload: event },
          });
          return;
        }
        case "extension_ui_request": {
          if (isOmpToolApprovalRequest(event)) {
            yield* openOmpToolApproval(ctx, emitApi, event);
            return;
          }
          // 只把真正的问答 method 映射为用户输入；setWidget/notify 等宿主 UI
          // 请求直接忽略（与 Paseo 参考实现一致），否则会把输入框劫持成回答模式。
          if (OMP_USER_INPUT_METHODS.has(event.method)) {
            yield* openOmpUserInput(ctx, emitApi, event);
          }
          return;
        }
        default:
          // 未知事件（协议漂移）：丢弃，不中断会话。
          return;
      }
    });

    const openOmpToolApproval = (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const requestId = RuntimeRequestId.make(event.id);
        const mapRequestId = ApprovalRequestId.make(event.id);
        const deferred = yield* Deferred.make<
          "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
        >();
        const toolName = /^Allow tool:\s*(\S+)/u.exec(event.title ?? "")?.[1] ?? "tool";
        ctx.pendingApprovals.set(mapRequestId, { requestId: mapRequestId, resolve: deferred });
        approvalRequestTypes.set(mapRequestId, approvalRequestTypeForTool(toolName));
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "request.opened",
          turnId: emitApi.currentTurnId(),
          requestId,
          payload: {
            requestType: approvalRequestTypeForTool(toolName),
            detail: event.title ?? `Allow tool: ${toolName}`,
            options: [
              { decision: "decline", label: "Deny" },
              { decision: "accept", label: "Approve" },
            ],
            ...(event.message === undefined ? {} : { args: event.message }),
          },
          raw: { source: RAW_SOURCE, method: "extension_ui_request", payload: event },
        });
      });

    const openOmpUserInput = (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      event: Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const requestId = RuntimeRequestId.make(event.id);
        const mapRequestId = ApprovalRequestId.make(event.id);
        const deferred = yield* Deferred.make<Record<string, unknown>>();
        ctx.pendingUserInputs.set(mapRequestId, { requestId: mapRequestId, resolve: deferred });
        const question = event.title ?? event.message ?? `OhMyPi ${event.method} request`;
        const optionLabels = Array.isArray(event.options) ? event.options : [];
        yield* emitApi.emit({
          ...(yield* makeStamp()),
          type: "user-input.requested",
          turnId: emitApi.currentTurnId(),
          requestId,
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

    // ── host tools 桥：omp → ToolBroker → 结果回传 ────────────────
    const routeOmpHostToolEvent = (
      ctx: PifamilySessionContext,
      emitApi: PifamilyEmitApi,
      event: OmpRuntimeEvent,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.type === "host_tool_cancel") {
          const binding = ctx.toolBroker;
          if (binding === null) return;
          yield* binding.bridge
            .cancel({
              toolCallId: `omp-host-${event.targetId}`,
              canonicalToolName: "",
              idempotencyKey: `${binding.context.runId}:omp-host-${event.targetId}`,
            })
            .pipe(Effect.catchCause(() => Effect.void));
          return;
        }
        if (event.type !== "host_tool_call") return;
        const binding = ctx.toolBroker;
        if (binding === null) {
          yield* ctx.process
            .send({
              type: "host_tool_result",
              id: event.id,
              result: {
                content: [
                  {
                    type: "text",
                    text: `Host tool "${event.toolName}" was called before the Code Work ToolBroker binding was configured.`,
                  },
                ],
                isError: true,
              },
              isError: true,
            })
            .pipe(Effect.catchCause(() => Effect.void));
          return;
        }
        const toolCallId = `omp-host-${event.toolCallId}`;
        const idempotencyKey = `${binding.context.runId}:${toolCallId}`;
        const result = yield* binding.bridge
          .invoke({
            toolCallId,
            canonicalToolName: event.toolName,
            arguments: event.arguments,
            idempotencyKey,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({
                status: "failed" as const,
                errorCode: "tool_broker_failed",
                result: String(cause),
              }),
            ),
          );
        yield* ctx.process
          .send({
            type: "host_tool_result",
            id: event.id,
            result: ompHostToolResultContent(result),
            isError: result.status !== "succeeded",
          })
          .pipe(Effect.catchCause(() => Effect.void));
        emitApi.touchTurn();
      });

    const startSession = Effect.fn("ompAdapter.startSession")(function* (
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

      const resumeCursor = decodeOmpResumeCursor(input.resumeCursor);

      const sessionScope = yield* Scope.make();
      yield* Scope.addFinalizer(adapterScope, Scope.close(sessionScope, Exit.void));

      const startResult = yield* Effect.gen(function* () {
        const args = [
          "--mode",
          "rpc-ui",
          "--approval-mode",
          ompApprovalModeForRuntime(config.approvalMode, input.runtimeMode),
          "--model",
          `${model.provider}/${model.adapterId}`,
          // 会话被回收/服务器重启后经 --session 文件恢复对话上下文。
          ...(resumeCursor === undefined ? [] : ["--session", resumeCursor.ompSessionFile]),
          ...splitPifamilyLaunchArgs(config.launchArgs),
        ];
        const spawn = spawnPifamilyProcess({
          spawner,
          diagnosticName: "OhMyPi",
          binaryPath: config.binaryPath,
          args,
          cwd: input.cwd,
          environment: options.environment,
        });
        const rpcProcess = yield* makeJsonlRpcProcess({
          diagnosticName: "OhMyPi",
          spawn,
        }).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        // OMP 协议 v2：事件泵先启动（单一消费者，ready 帧经 Deferred 交接，
        // 避免双订阅争抢队列丢帧）→ 等 ready（10s）→ negotiate → 校验版本。
        const readyDeferred = yield* Deferred.make<unknown, never>();
        const readyDelivered = { done: false };
        const now = DateTime.formatIso(yield* DateTime.now);
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
            resumeCursor: {},
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

        const readyOrTimeout = Deferred.await(readyDeferred).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "negotiate_protocol",
                detail: "OhMyPi did not send a protocol ready frame within 10s.",
              }),
            ),
          ),
        );

        yield* rpcProcess.streamEvents
          .pipe(
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                if (
                  !readyDelivered.done &&
                  (frame as { readonly type?: string }).type === "ready"
                ) {
                  readyDelivered.done = true;
                  yield* Deferred.succeed(readyDeferred, frame);
                  return;
                }
                yield* handleOmpEvent(ctx, emitApi, frame);
              }),
            ),
            Effect.forkScoped,
          )
          .pipe(Effect.provideService(Scope.Scope, sessionScope));

        yield* readyOrTimeout;
        const negotiated = (yield* rpcProcess.request(
          {
            type: "negotiate_protocol",
            ...(supportsJsonlRpcProtocolV2(yield* Deferred.await(readyDeferred))
              ? { protocolVersion: 2 }
              : { protocolVersion: 1 }),
          },
          10_000,
        )) as { readonly protocolVersion?: number } | undefined;
        if (negotiated?.protocolVersion !== 1 && negotiated?.protocolVersion !== 2) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "negotiate_protocol",
            detail: `OhMyPi negotiated an unsupported protocol version: ${JSON.stringify(negotiated)}`,
          });
        }

        const state = (yield* rpcProcess.request({ type: "get_state" }, 20_000)) as
          | OmpSessionState
          | undefined;
        if (state?.sessionFile !== undefined) {
          ctx.session = { ...ctx.session, resumeCursor: { ompSessionFile: state.sessionFile } };
        }

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

        yield* forkPifamilyWatchdog({
          ctx,
          provider: PROVIDER,
          emitApi,
          terminal: makePifamilyTerminalApi({
            provider: PROVIDER,
            ctx,
            emitApi,
          }),
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

    const sendTurn = Effect.fn("ompAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
      const ctx = yield* requireSession(input.threadId);
      const text = input.input?.trim() ?? "";
      const attachments = input.attachments ?? [];
      if (!text && attachments.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OhMyPi turns require text or image-attachment input.",
        });
      }
      if (ctx.turn !== null && !ctx.turn.settled) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "An OhMyPi turn is already active on this thread.",
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

      const turnId = TurnId.make(`omp-turn-${yield* randomUUID}`);
      // 回合级 assistant 消息 id：上游响应 id（responseId）跨回合可能重复，
      // 直接当消息 id 会把多个回合的流式文本合并进同一条消息。
      const assistantMessageId = `omp-msg-${yield* randomUUID}`;
      ctx.currentAssistantMessageId = assistantMessageId;
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

      yield* Effect.gen(function* () {
        const ack = (yield* ctx.process.request(
          { type: "prompt", message: text, ...(images.length > 0 ? { images } : {}) },
          60_000,
        )) as { readonly agentInvoked?: boolean } | undefined;
        const turn = ctx.turn;
        if (turn === null || turn.settled) return;
        if (ack?.agentInvoked === false) {
          yield* makePifamilyTerminalApi({
            provider: PROVIDER,
            ctx,
            emitApi,
          }).completeTurn("no_agent_invoked");
        }
      })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const terminal = makePifamilyTerminalApi({
                provider: PROVIDER,
                ctx,
                emitApi,
              });
              const turn = ctx.turn;
              if (turn === null || turn.settled) return;
              if (turn.interrupting) {
                yield* terminal.abortTurn("interrupted");
                return;
              }
              yield* terminal.failTurn(`OhMyPi prompt failed: ${String(cause)}`);
            }),
          ),
          Effect.forkScoped,
        )
        .pipe(Effect.provideService(Scope.Scope, ctx.sessionScope));

      return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
    });

    const interruptTurn = Effect.fn("ompAdapter.interruptTurn")(function* (threadId: ThreadId) {
      const ctx = yield* requireSession(threadId);
      const turn = ctx.turn;
      if (turn === null || turn.settled) return;
      turn.interrupting = true;
      yield* ctx.process
        .request({ type: "abort" }, 10_000)
        .pipe(Effect.catchCause(() => Effect.void));
      yield* makePifamilyTerminalApi({
        provider: PROVIDER,
        ctx,
        emitApi: makeEmitApi(ctx),
      }).abortTurn("interrupted");
    });

    const stopSession = Effect.fn("ompAdapter.stopSession")(function* (threadId: ThreadId) {
      const ctx = yield* requireSession(threadId);
      const emitApi = makeEmitApi(ctx);
      const terminal = makePifamilyTerminalApi({
        provider: PROVIDER,
        ctx,
        emitApi,
      });
      yield* settlePendingInteractions(ctx);
      yield* terminal.abortTurn("session stopped");
      yield* ctx.process.close("OhMyPi session stopped");
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
        sessionModelSwitch: "in-session",
        toolBrokerCanonicalTools: [...OMP_TOOL_BROKER_CANONICAL_TOOLS],
      },
      configureToolBroker: (input: {
        readonly threadId: ThreadId;
        readonly bridge: ProviderToolBrokerBridge;
        readonly context: ProviderToolBrokerContext;
      }) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          ctx.toolBroker = { bridge: input.bridge, context: input.context };
          // 注册宿主工具面；omp 之后可直接 host_tool_call 调用这些工具。
          yield* ctx.process
            .request({ type: "set_host_tools", tools: OMP_HOST_TOOL_DEFINITIONS }, 20_000)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_host_tools",
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
              ),
            );
        }),
      clearToolBroker: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          ctx.toolBroker = null;
          yield* ctx.process
            .request({ type: "set_host_tools", tools: [] }, 20_000)
            .pipe(Effect.catchCause(() => Effect.void));
        }),
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (
        threadId: ThreadId,
        requestId: ApprovalRequestId,
        decision: ProviderApprovalDecision,
      ) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingApprovals.get(requestId);
          if (pending === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToRequest",
              issue: `No pending OhMyPi approval request '${requestId}'.`,
            });
          }
          ctx.pendingApprovals.delete(requestId);
          yield* Deferred.succeed(pending.resolve, decision);
          // Approve/Deny select：accept* → confirmed，decline/cancel → cancelled。
          yield* ctx.process
            .send({
              type: "extension_ui_response",
              id: requestId,
              ...(decision === "decline" || decision === "cancel"
                ? { cancelled: true }
                : { value: "Approve" }),
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
            type: "request.resolved",
            turnId: emitApi.currentTurnId(),
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType: approvalRequestTypeForRequest(requestId),
              decision,
            },
          });
        }),
      respondToUserInput: (
        threadId: ThreadId,
        requestId: ApprovalRequestId,
        answers: ProviderUserInputAnswers,
      ) =>
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          const pending = ctx.pendingUserInputs.get(requestId);
          if (pending === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "respondToUserInput",
              issue: `No pending OhMyPi user-input request '${requestId}'.`,
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
        }),
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
            issue: `OhMyPi adapter does not support thread rollback for ${threadId}.`,
          }),
        ),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], (threadId) => stopSession(threadId), {
          discard: true,
        }),
      streamEvents: eventQueue.stream,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });

/** ToolBroker 结果 → omp host_tool_result 的 content 形状。 */
function ompHostToolResultContent(result: {
  readonly status: "succeeded" | "denied" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly errorCode?: string | undefined;
}): {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly isError: boolean;
} {
  if (result.status === "succeeded") {
    return {
      content: [{ type: "text", text: JSON.stringify(result.result ?? null) }],
      isError: false,
    };
  }
  const reason =
    result.status === "denied"
      ? `Tool call denied by Code Work${result.errorCode === undefined ? "" : ` (${result.errorCode})`}.`
      : result.status === "cancelled"
        ? "Tool call cancelled."
        : `Tool call failed${result.errorCode === undefined ? "" : ` (${result.errorCode})`}: ${JSON.stringify(result.result ?? null)}`;
  return { content: [{ type: "text", text: reason }], isError: true };
}
