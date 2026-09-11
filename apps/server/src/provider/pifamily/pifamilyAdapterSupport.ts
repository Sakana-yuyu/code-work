/**
 * pi-family 适配器共享骨架 —— spawn、BYOK 模型路由、终态发射、看门狗与
 * 挂起交互结算。
 *
 * Pi 与 OhMyPi 的协议事件语义不同，事件解析在各自的 Adapter 里独立实现；
 * 本模块只承载两者真正共用的生命周期工具。任何路径最终都收敛到
 * completeTurn / failTurn / abortTurn 之一 —— 不存在 running 挂死。
 *
 * @module provider/pifamily/pifamilyAdapterSupport
 */
// @effect-diagnostics globalDateInEffect:off - 看门狗/活跃度按墙上时间判断。
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  type ApprovalRequestId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  type TurnId,
  EventId,
  ProviderDriverKind,
} from "@codework/contracts";

import { resolveSpawnCommand } from "@codework/shared/shell";

import { resolveAttachmentPath } from "../../attachmentStore.ts";

import { ProviderAdapterValidationError } from "../Errors.ts";
import { JsonlRpcProcessError } from "./jsonlRpcProcess.ts";

/** spawn 闭包的标签化错误（避免裸 Error 混入失败通道）。 */
export class PifamilySpawnError extends Schema.TaggedErrorClass<PifamilySpawnError>()(
  "PifamilySpawnError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
import type {
  ProviderToolBrokerBridge,
  ProviderToolBrokerContext,
} from "../Services/ProviderAdapter.ts";
import { pifamilyProviderNameForProtocol, type PifamilyModelRoute } from "./byokProviderConfig.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** 无事件/工具进展多久后看门狗强制终态（挂起审批/输入时暂停计时）。 */
export const PIFAMILY_TURN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;
const PIFAMILY_WATCHDOG_POLL_MS = 15 * 1000;

export interface PifamilyPendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly resolve: Deferred.Deferred<
    "accept" | "acceptForSession" | "acceptAlways" | "decline" | "cancel"
  >;
}

export interface PifamilyPendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly resolve: Deferred.Deferred<Record<string, unknown>>;
}

export interface PifamilyTerminalMessage {
  readonly role: string;
  readonly errorMessage?: string | null;
  readonly stopReason?: string;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
}

/** agent_end 消息里的 usage → thread.token-usage.updated 事件。 */
export const emitPifamilyTokenUsage = (
  messages: ReadonlyArray<PifamilyTerminalMessage>,
  emitApi: PifamilyEmitApi,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const latest = [...messages].toReversed().find((message) => message.role === "assistant");
    const usage = latest?.usage;
    if (usage === undefined) return;
    const usedTokens =
      usage.total ??
      (usage.input !== undefined && usage.output !== undefined
        ? usage.input + usage.output
        : undefined);
    if (usedTokens === undefined || !Number.isSafeInteger(usedTokens) || usedTokens < 0) return;
    yield* emitApi.emit({
      ...(yield* emitApi.makeStamp()),
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens,
          lastUsedTokens: usedTokens,
          ...(usage.input === undefined
            ? {}
            : { inputTokens: usage.input, lastInputTokens: usage.input }),
          ...(usage.output === undefined
            ? {}
            : { outputTokens: usage.output, lastOutputTokens: usage.output }),
          ...(usage.cacheRead === undefined ? {} : { cachedInputTokens: usage.cacheRead }),
        },
      },
    });
  });

export interface PifamilyTurnState {
  readonly turnId: TurnId;
  /** agent_start/turn_start 已见。 */
  started: boolean;
  /** pi 的 agent_end(willRetry) 到 agent_settled 之间缓存的消息。 */
  pendingSettledMessages: ReadonlyArray<PifamilyTerminalMessage> | null;
  /** interrupt 已发出、等待终态确认。 */
  interrupting: boolean;
  /** 终态事件已发射（防止 agent_settled/process_exit/abort 双发）。 */
  settled: boolean;
  lastActivityAt: number;
}

/** 适配器侧需要的最小 JsonlRpcProcess 面（便于测试替身）。 */
export interface JsonlRpcProcessLike {
  readonly request: (
    command: Record<string, unknown>,
    timeoutMs?: number | null,
  ) => Effect.Effect<unknown, JsonlRpcProcessError>;
  readonly send: (frame: Record<string, unknown>) => Effect.Effect<void, JsonlRpcProcessError>;
  readonly streamEvents: Stream.Stream<unknown, never>;
  readonly hasExited: Effect.Effect<boolean>;
  readonly close: (reason: string) => Effect.Effect<void>;
  readonly pid: number | undefined;
}

export interface PifamilySessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly sessionScope: Scope.Scope;
  readonly process: JsonlRpcProcessLike;
  model: { readonly provider: string; readonly adapterId: string };
  turns: ReadonlyArray<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  turn: PifamilyTurnState | null;
  readonly pendingApprovals: Map<ApprovalRequestId, PifamilyPendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PifamilyPendingUserInput>;
  readonly activeToolCalls: Map<string, { readonly toolName: string; readonly args: unknown }>;
  currentAssistantMessageId: string | null;
  /** ToolBroker 绑定（configureToolBroker 写入）。 */
  toolBroker: {
    readonly bridge: ProviderToolBrokerBridge;
    readonly context: ProviderToolBrokerContext;
  } | null;
}

/**
 * 允许可选事件字段显式传 undefined、归属字段（provider/providerInstanceId/
 * threadId）省略的 ProviderRuntimeEvent 草稿——emit 收口时统一剥离 undefined
 * 并补齐归属标识，事件映射器不必逐字段条件展开。
 * 同态映射保留 `?` 修饰符，Omit 只移除由收口统一盖章的三个归属字段。
 */
type DistributeEventDraft<T> = T extends object
  ? Omit<
      {
        [K in keyof T]: K extends "turnId" | "itemId" | "requestId" ? T[K] | undefined : T[K];
      },
      "provider" | "providerInstanceId" | "threadId"
    >
  : never;
export type PifamilyEventDraft = DistributeEventDraft<ProviderRuntimeEvent>;

const stripUndefinedEventFields = (event: PifamilyEventDraft): ProviderRuntimeEvent => {
  const record = event as unknown as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    next[key] = value;
  }
  return next as unknown as ProviderRuntimeEvent;
};

/** 会话级事件发射 API —— 事件映射器与适配器共用。 */
export interface PifamilyEmitApi {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly currentTurnId: () => TurnId | undefined;
  readonly emit: (event: PifamilyEventDraft) => Effect.Effect<void>;
  readonly makeStamp: () => Effect.Effect<{
    readonly eventId: EventId;
    readonly createdAt: string;
  }>;
  readonly touchTurn: () => void;
  readonly appendTurnItem: (item: unknown) => void;
}

/** emit 的统一实现：剥离 undefined 可选字段并补齐归属标识。 */
export const pifamilyEmitToQueue =
  (input: {
    readonly queue: Queue.Queue<ProviderRuntimeEvent>;
    readonly provider: ProviderDriverKind;
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) =>
  (event: PifamilyEventDraft): Effect.Effect<void> =>
    Queue.offer(input.queue, {
      ...stripUndefinedEventFields(event),
      provider: input.provider,
      providerInstanceId: input.instanceId,
      threadId: input.threadId,
    }).pipe(Effect.asVoid);

export interface PifamilyTerminalApi {
  /** 从挂起消息提取 errorMessage 决定 completed/failed。 */
  readonly completeTurn: (stopReason?: string) => Effect.Effect<void>;
  readonly failTurn: (error: string) => Effect.Effect<void>;
  readonly abortTurn: (reason: string) => Effect.Effect<void>;
}

export const makePifamilyTerminalApi = (input: {
  readonly provider: ProviderDriverKind;
  readonly ctx: PifamilySessionContext;
  readonly emitApi: PifamilyEmitApi;
}): PifamilyTerminalApi => {
  const { ctx, emitApi } = input;

  const settleTurn = (
    state: "completed" | "failed" | "cancelled",
    payload: { readonly stopReason?: string; readonly errorMessage?: string },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turn = ctx.turn;
      if (turn === null || turn.settled) return;
      turn.settled = true;
      ctx.turn = null;
      ctx.currentAssistantMessageId = null;
      ctx.session = { ...ctx.session, activeTurnId: undefined, status: "ready" };
      yield* emitApi.emit({
        ...(yield* emitApi.makeStamp()),
        type: "turn.completed",
        turnId: turn.turnId,
        payload: {
          state,
          ...(payload.stopReason === undefined ? {} : { stopReason: payload.stopReason }),
          ...(payload.errorMessage === undefined ? {} : { errorMessage: payload.errorMessage }),
        },
      });
    });

  const extractTerminalError = (turn: PifamilyTurnState): string | undefined => {
    const messages = turn.pendingSettledMessages ?? [];
    const latest = [...messages].toReversed().find((message) => message.role === "assistant");
    const error = latest?.errorMessage?.trim();
    return error === undefined || error.length === 0 ? undefined : error;
  };

  return {
    completeTurn: (stopReason) =>
      Effect.gen(function* () {
        const turn = ctx.turn;
        if (turn === null || turn.settled) return;
        // interrupt 后的 agent_end 错误（如 "Interrupted by user"）归为取消，
        // 而不是 failed——用户主动中止不是失败。
        if (turn.interrupting) {
          yield* settleTurn("cancelled", stopReason === undefined ? {} : { stopReason });
          return;
        }
        const error = extractTerminalError(turn);
        yield* settleTurn(error === undefined ? "completed" : "failed", {
          ...(stopReason === undefined ? {} : { stopReason }),
          ...(error === undefined ? {} : { errorMessage: error }),
        });
      }),
    failTurn: (error) => settleTurn("failed", { errorMessage: error }),
    abortTurn: (reason) =>
      Effect.gen(function* () {
        const turn = ctx.turn;
        if (turn === null || turn.settled) return;
        turn.settled = true;
        ctx.turn = null;
        ctx.currentAssistantMessageId = null;
        ctx.session = { ...ctx.session, activeTurnId: undefined, status: "ready" };
        yield* emitApi.emit({
          ...(yield* emitApi.makeStamp()),
          type: "turn.aborted",
          turnId: turn.turnId,
          payload: { reason },
        });
      }),
  };
};

/** Grok 式看门狗：turn 长时间无进展强制 failed 终态。 */
export const forkPifamilyWatchdog = (input: {
  readonly ctx: PifamilySessionContext;
  readonly provider: ProviderDriverKind;
  readonly emitApi: PifamilyEmitApi;
  readonly terminal: PifamilyTerminalApi;
  readonly inactivityTimeoutMs?: number | undefined;
}): Effect.Effect<void, never, Scope.Scope> => {
  const timeoutMs = input.inactivityTimeoutMs ?? PIFAMILY_TURN_INACTIVITY_TIMEOUT_MS;
  return Effect.forever(
    Effect.gen(function* () {
      yield* Effect.sleep(PIFAMILY_WATCHDOG_POLL_MS);
      const turn = input.ctx.turn;
      if (turn === null || turn.settled || turn.interrupting) return;
      if (input.ctx.pendingApprovals.size > 0 || input.ctx.pendingUserInputs.size > 0) return;
      if (Date.now() - turn.lastActivityAt < timeoutMs) return;
      const message = `${input.provider} turn stalled without content or tool progress for ${Math.round(timeoutMs / 1000)}s`;
      yield* input.emitApi.emit({
        ...(yield* input.emitApi.makeStamp()),
        type: "runtime.error",
        turnId: turn.turnId,
        payload: { message, class: "transport_error" },
      });
      yield* input.terminal.failTurn(message);
    }),
  ).pipe(Effect.forkScoped);
};

/** 结算挂起的审批/输入（stopSession / interrupt / 进程退出时调用）。 */
export const settlePendingInteractions = (ctx: PifamilySessionContext): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const pending of ctx.pendingApprovals.values()) {
      yield* Deferred.succeed(pending.resolve, "cancel");
    }
    ctx.pendingApprovals.clear();
    for (const pending of ctx.pendingUserInputs.values()) {
      yield* Deferred.succeed(pending.resolve, {});
    }
    ctx.pendingUserInputs.clear();
  });

/** 进程退出兜底：结算交互、失败当前 turn、session.exited。 */
export const handlePifamilyProcessExit = (input: {
  readonly ctx: PifamilySessionContext;
  readonly provider: ProviderDriverKind;
  readonly emitApi: PifamilyEmitApi;
  readonly terminal: PifamilyTerminalApi;
  readonly error: string;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* settlePendingInteractions(input.ctx);
    yield* input.terminal.failTurn(input.error);
    input.ctx.session = { ...input.ctx.session, status: "closed", lastError: input.error };
    yield* input.emitApi.emit({
      ...(yield* input.emitApi.makeStamp()),
      type: "session.exited",
      payload: { reason: input.error, exitKind: "error" },
    });
  });

/** 事件戳工厂；UUID 失败视为致命（orDie）。 */
export const makePifamilyEventStampFactory =
  (
    randomUUIDv4: Effect.Effect<string>,
  ): (() => Effect.Effect<{ readonly eventId: EventId; readonly createdAt: string }>) =>
  () =>
    Effect.all({ eventId: randomUUIDv4, createdAt: nowIso }).pipe(
      Effect.map(({ eventId, createdAt }) => ({ eventId: EventId.make(eventId), createdAt })),
    );

export interface PifamilyEventQueue {
  readonly queue: Queue.Queue<ProviderRuntimeEvent>;
  readonly stream: Stream.Stream<ProviderRuntimeEvent>;
}

export const makePifamilyEventQueue = Effect.fn("pifamily.makePifamilyEventQueue")(function* () {
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  return { queue, stream: Stream.fromQueue(queue) } satisfies PifamilyEventQueue;
});

const PIFAMILY_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** 读取图片附件为 base64；附件 id 由服务端附件存储解析，不信任客户端路径。 */
export const readPifamilyImageAttachments = Effect.fn("pifamily.readImageAttachments")(function* (
  provider: ProviderDriverKind,
  attachments: ReadonlyArray<{
    readonly type: string;
    readonly id: string;
    readonly name: string;
    readonly mimeType: string;
  }>,
  attachmentsDir: string,
  fileSystem: FileSystem.FileSystem,
) {
  const images: Array<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }> = [];
  for (const attachment of attachments) {
    if (attachment.type !== "image") continue;
    if (!PIFAMILY_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterValidationError({
        provider,
        operation: "turn/start",
        issue: `Unsupported image attachment type '${attachment.mimeType}'.`,
      });
    }
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir,
      attachment: attachment as Parameters<typeof resolveAttachmentPath>[0]["attachment"],
    });
    if (attachmentPath === null) {
      return yield* new ProviderAdapterValidationError({
        provider,
        operation: "turn/start",
        issue: `Failed to resolve image attachment '${attachment.name}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterValidationError({
            provider,
            operation: "turn/start",
            issue: `Failed to read image attachment '${attachment.name}'.`,
          }),
      ),
    );
    images.push({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: attachment.mimeType,
    });
  }
  return images;
});

/** BYOK 模型解析（fail-closed）：无路由/未知 adapter id 直接失败。 */
export const resolvePifamilyModel = Effect.fn("pifamily.resolvePifamilyModel")(function* (input: {
  readonly routes: ReadonlyArray<PifamilyModelRoute>;
  readonly provider: ProviderDriverKind;
  readonly operation: string;
  readonly selectedModel: string | undefined;
}) {
  if (input.routes.length === 0) {
    return yield* new ProviderAdapterValidationError({
      provider: input.provider,
      operation: input.operation,
      issue:
        "No BYOK model adapters are routable for this instance. Add OpenAI/Anthropic adapters to the BYOK provider first.",
    });
  }
  const adapterId = input.selectedModel ?? input.routes[0]?.adapterId;
  const route = input.routes.find((candidate) => candidate.adapterId === adapterId);
  if (route === undefined) {
    return yield* new ProviderAdapterValidationError({
      provider: input.provider,
      operation: input.operation,
      issue: `No BYOK adapter is published as model '${adapterId ?? ""}'.`,
    });
  }
  return {
    provider: pifamilyProviderNameForProtocol(route.protocol),
    adapterId: route.adapterId,
  };
});

/**
 * spawn 一个 pi-family 子进程（Windows cmd/bat 自动走 shell 包装并树杀）。
 * 返回的闭包供 `makeJsonlRpcProcess` 在私有 scope 内调用。
 */
export const spawnPifamilyProcess = (input: {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly diagnosticName: string;
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly environment: Readonly<Record<string, string>>;
}): ((
  scope: Scope.Scope,
) => Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PifamilySpawnError>) => {
  const { spawner, diagnosticName, binaryPath, args, cwd, environment } = input;
  return (
    scope: Scope.Scope,
  ): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, PifamilySpawnError> =>
    Effect.gen(function* () {
      const resolved = yield* resolveSpawnCommand(binaryPath, [...args], {
        env: environment,
        extendEnv: true,
      });
      return yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            ...(cwd === undefined ? {} : { cwd }),
            env: environment,
            extendEnv: true,
            shell: resolved.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new PifamilySpawnError({
                detail: `${diagnosticName} spawn failed: ${cause.message}`,
              }),
          ),
        );
    });
};

/** 生成 UUID 的公共入口（orDie：UUID 失败不可恢复）。 */
export const pifamilyRandomUUID = (crypto: Crypto.Crypto): Effect.Effect<string> =>
  crypto.randomUUIDv4.pipe(Effect.orDie);
