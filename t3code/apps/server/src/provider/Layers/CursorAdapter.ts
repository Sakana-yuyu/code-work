/**
 * CursorAdapterLive — Cursor CLI (`agent acp`) via ACP.
 *
 * @module CursorAdapterLive
 */

import {
  ApprovalRequestId,
  type CompositionRuntimeCapabilityHandshakeRequest,
  type CompositionRuntimeCapabilityHandshakeResult,
  type CursorSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyCursorAcpModelSelection, makeCursorAcpRuntime } from "../acp/CursorAcpSupport.ts";
import {
  CursorAskQuestionRequest,
  CursorCreatePlanRequest,
  CursorUpdateTodosRequest,
  extractAskQuestions,
  extractPlanMarkdown,
  extractTodosAsPlan,
} from "../acp/CursorAcpExtension.ts";
import {
  type ProviderToolBrokerCancellation,
  type ProviderToolBrokerBridge,
  type ProviderToolBrokerContext,
  type ProviderToolBrokerInvocation,
} from "../Services/ProviderAdapter.ts";
import { type CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { resolveCursorAcpBaseModelId } from "./CursorProvider.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const PROVIDER = ProviderDriverKind.make("cursor");
const CURSOR_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const CAPABILITY_HANDSHAKE_TTL_MS = 10 * 60 * 1000;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface CursorAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`cursor`).
   */
  readonly instanceId?: ProviderInstanceId;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `cursorSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<CursorSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CursorToolBrokerBinding {
  readonly bridge: ProviderToolBrokerBridge;
  readonly context: ProviderToolBrokerContext;
  readonly terminalOutputByteLimits: Map<string, number | null>;
  readonly inFlightInvocations: Map<string, ProviderToolBrokerCancellation>;
  active: boolean;
}

interface CursorCapabilityHandshake {
  readonly request: CompositionRuntimeCapabilityHandshakeRequest;
  readonly result: CompositionRuntimeCapabilityHandshakeResult;
}

interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateTerminalOutput(
  output: string,
  byteLimit: number | null | undefined,
): {
  readonly output: string;
  readonly truncated: boolean;
} {
  if (byteLimit === null || byteLimit === undefined) return { output, truncated: false };
  const encoder = new TextEncoder();
  if (encoder.encode(output).byteLength <= byteLimit) return { output, truncated: false };
  const characters = Array.from(output);
  let retainedBytes = 0;
  let start = characters.length;
  while (start > 0) {
    const nextBytes = encoder.encode(characters[start - 1]).byteLength;
    if (retainedBytes + nextBytes > byteLimit) break;
    retainedBytes += nextBytes;
    start -= 1;
  }
  return { output: characters.slice(start).join(""), truncated: true };
}

function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyCursorAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

export function makeCursorAdapter(
  cursorSettings: CursorSettings,
  options?: CursorAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("cursor");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, CursorSessionContext>();
    const capabilityHandshakes = new Map<string, CursorCapabilityHandshake>();
    const pendingToolBrokerContexts = new Map<ThreadId, CursorToolBrokerBinding>();
    const toolBrokerContexts = new Map<ThreadId, CursorToolBrokerBinding>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Cursor runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapExtensionFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Cursor ACP extension event.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.cursor.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: CursorSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.cursor.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<CursorSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const closeOwnedTerminal = (
      threadId: ThreadId,
      binding: CursorToolBrokerBinding,
      terminalId: string,
    ) =>
      binding.bridge
        .invoke({
          toolCallId: `cursor-acp:cleanup:${terminalId}`,
          canonicalToolName: "terminal.close",
          arguments: { terminalId },
          idempotencyKey: `cursor-acp:${threadId}:cleanup:${binding.context.capabilityHandshakeId}:${terminalId}`,
        })
        .pipe(Effect.asVoid, Effect.ignore);

    const cleanupToolBrokerBinding = (threadId: ThreadId, binding: CursorToolBrokerBinding) =>
      Effect.gen(function* () {
        binding.active = false;
        if (pendingToolBrokerContexts.get(threadId) === binding) {
          pendingToolBrokerContexts.delete(threadId);
        }
        if (toolBrokerContexts.get(threadId) === binding) {
          toolBrokerContexts.delete(threadId);
        }
        const inFlight = [...binding.inFlightInvocations.values()];
        binding.inFlightInvocations.clear();
        yield* Effect.forEach(inFlight, (invocation) => binding.bridge.cancel(invocation), {
          concurrency: "unbounded",
          discard: true,
        }).pipe(Effect.ignore);
        const terminalIds = [...binding.terminalOutputByteLimits.keys()];
        binding.terminalOutputByteLimits.clear();
        yield* Effect.forEach(
          terminalIds,
          (terminalId) => closeOwnedTerminal(threadId, binding, terminalId),
          { concurrency: "unbounded", discard: true },
        );
      });

    const cleanupThreadToolBrokerContexts = (threadId: ThreadId) => {
      const bindings = new Set<CursorToolBrokerBinding>();
      const pending = pendingToolBrokerContexts.get(threadId);
      const active = toolBrokerContexts.get(threadId);
      if (pending !== undefined) bindings.add(pending);
      if (active !== undefined) bindings.add(active);
      pendingToolBrokerContexts.delete(threadId);
      toolBrokerContexts.delete(threadId);
      return Effect.forEach(bindings, (binding) => cleanupToolBrokerBinding(threadId, binding), {
        concurrency: "unbounded",
        discard: true,
      });
    };

    const handshakeCapabilities: NonNullable<CursorAdapterShape["handshakeCapabilities"]> = (
      input,
    ) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4;
        const expiresAtUnixMs =
          DateTime.toEpochMillis(yield* DateTime.now) + CAPABILITY_HANDSHAKE_TTL_MS;
        const result = {
          ...input,
          status: "accepted" as const,
          handshakeId: `cursor-handshake:${id}`,
          acceptedGrantIds: [...input.capabilityGrantIds],
          expiresAtUnixMs,
        } satisfies CompositionRuntimeCapabilityHandshakeResult;
        capabilityHandshakes.set(result.handshakeId, { request: input, result });
        return result;
      });

    const revokeCapabilityHandshake: NonNullable<
      CursorAdapterShape["revokeCapabilityHandshake"]
    > = (input) =>
      Effect.gen(function* () {
        capabilityHandshakes.delete(input.handshakeId);
        const threadIds = new Set<ThreadId>();
        for (const [threadId, binding] of pendingToolBrokerContexts)
          if (binding.context.capabilityHandshakeId === input.handshakeId) threadIds.add(threadId);
        for (const [threadId, binding] of toolBrokerContexts)
          if (binding.context.capabilityHandshakeId === input.handshakeId) threadIds.add(threadId);
        yield* Effect.forEach(threadIds, cleanupThreadToolBrokerContexts, {
          concurrency: "unbounded",
          discard: true,
        });
      });

    const configureToolBroker: NonNullable<CursorAdapterShape["configureToolBroker"]> = (input) =>
      Effect.gen(function* () {
        if (input.threadId !== input.context.threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "configureToolBroker",
            issue: "threadId 与可信 ToolBroker context 不匹配。",
          });
        }
        const handshake = capabilityHandshakes.get(input.context.capabilityHandshakeId);
        const nowUnixMs = DateTime.toEpochMillis(yield* DateTime.now);
        const requestedGrantIds = [...input.context.capabilityGrantIds].sort();
        const acceptedGrantIds = [...(handshake?.result.acceptedGrantIds ?? [])].sort();
        if (
          handshake === undefined ||
          handshake.result.expiresAtUnixMs === undefined ||
          handshake.result.expiresAtUnixMs <= nowUnixMs ||
          handshake.request.runtimeId !== input.context.runtimeId ||
          handshake.request.taskId !== input.context.taskId ||
          handshake.request.runId !== input.context.runId ||
          handshake.request.agentId !== input.context.agentId ||
          requestedGrantIds.length !== acceptedGrantIds.length ||
          requestedGrantIds.some((grantId, index) => grantId !== acceptedGrantIds[index])
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "configureToolBroker",
            issue: "ToolBroker context 与有效 capability handshake 不匹配。",
          });
        }
        pendingToolBrokerContexts.set(input.threadId, {
          bridge: input.bridge,
          context: input.context,
          terminalOutputByteLimits: new Map(),
          inFlightInvocations: new Map(),
          active: true,
        });
      });

    const clearToolBroker: NonNullable<CursorAdapterShape["clearToolBroker"]> = (threadId) =>
      cleanupThreadToolBrokerContexts(threadId);

    const stopSessionInternal = (ctx: CursorSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* cleanupThreadToolBrokerContexts(ctx.threadId);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: CursorAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const cursorModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }
          const pendingToolBroker = pendingToolBrokerContexts.get(input.threadId);
          if (
            input.capabilityHandshakeId !== undefined &&
            (pendingToolBroker === undefined ||
              !pendingToolBroker.active ||
              pendingToolBroker.context.capabilityHandshakeId !== input.capabilityHandshakeId)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "Session capability handshake 没有匹配同一 Adapter 代次的 ToolBroker binding。",
            });
          }
          if (
            pendingToolBroker !== undefined &&
            input.capabilityHandshakeId !== pendingToolBroker.context.capabilityHandshakeId
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "ToolBroker binding 与 Session capability handshake 不匹配。",
            });
          }
          if (pendingToolBroker !== undefined) {
            toolBrokerContexts.set(input.threadId, pendingToolBroker);
          }
          const toolBrokerBinding = toolBrokerContexts.get(input.threadId);
          if (
            toolBrokerBinding !== undefined &&
            path.resolve(toolBrokerBinding.context.workspaceRoot) !== cwd
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "ToolBroker workspaceRoot 与 Cursor session cwd 不匹配。",
            });
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred
              ? Effect.void
              : Scope.close(sessionScope, Exit.void).pipe(
                  Effect.ensuring(cleanupThreadToolBrokerContexts(input.threadId)),
                ),
          );
          let ctx!: CursorSessionContext;

          const resumeSessionId = parseCursorResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the CursorSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { cursor: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveCursorSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : cursorSettings;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeCursorAcpRuntime({
            cursorSettings: effectiveCursorSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(toolBrokerBinding === undefined
              ? {}
              : {
                  clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: true,
                  },
                }),
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const makeToolIdentity = (method: string, suffix?: string) =>
            randomUUIDv4.pipe(
              Effect.map((id) => {
                const stableSuffix = suffix === undefined ? "" : `:${suffix}`;
                return {
                  id,
                  toolCallId: `cursor-acp:${method}:${id}${stableSuffix}`,
                  idempotencyKey: `cursor-acp:${input.threadId}:${method}:${id}${stableSuffix}`,
                };
              }),
              Effect.mapError(() =>
                EffectAcpErrors.AcpRequestError.internalError(
                  "无法生成 ACP 工具调用标识。",
                  undefined,
                  { method, operation: "handle-request" },
                ),
              ),
            );
          const toolRequestFailed = (
            method: string,
            result: { readonly status: string; readonly errorCode?: string | undefined },
          ) =>
            EffectAcpErrors.AcpRequestError.internalError(
              "T3 ToolBroker 未完成 ACP 请求。",
              {
                status: result.status,
                ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
              },
              { method, operation: "handle-request" },
            );
          const invokeTool = (
            method: string,
            canonicalToolName: string,
            argumentsValue: unknown,
            identity: { readonly toolCallId: string; readonly idempotencyKey: string },
          ) =>
            Effect.gen(function* () {
              const binding = toolBrokerContexts.get(input.threadId);
              if (binding === undefined || !binding.active) {
                return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
                  "T3 ToolBroker binding 已撤销。",
                );
              }
              const invocation: ProviderToolBrokerInvocation = {
                ...identity,
                canonicalToolName,
                arguments: argumentsValue,
              };
              binding.inFlightInvocations.set(invocation.toolCallId, invocation);
              const result = yield* binding.bridge.invoke(invocation).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    binding.inFlightInvocations.delete(invocation.toolCallId);
                  }),
                ),
              );
              if (!binding.active || toolBrokerContexts.get(input.threadId) !== binding) {
                return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
                  "T3 ToolBroker binding 已撤销。",
                );
              }
              if (result.status !== "succeeded") return yield* toolRequestFailed(method, result);
              return result.result;
            });
          const resolveAcpRelativePath = (requestPath: string) =>
            Effect.gen(function* () {
              const binding = toolBrokerContexts.get(input.threadId);
              if (binding === undefined || !binding.active) {
                return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
                  "T3 ToolBroker binding 已撤销。",
                );
              }
              if (!path.isAbsolute(requestPath)) {
                return yield* EffectAcpErrors.AcpRequestError.invalidParams(
                  "ACP 文件路径必须是绝对路径。",
                );
              }
              const workspaceRoot = path.resolve(binding.context.workspaceRoot);
              const relativePath = path.relative(workspaceRoot, path.resolve(requestPath));
              if (
                relativePath.length === 0 ||
                relativePath === ".." ||
                relativePath.startsWith(`..${path.sep}`) ||
                path.isAbsolute(relativePath)
              ) {
                return yield* EffectAcpErrors.AcpRequestError.invalidParams(
                  "ACP 文件路径不在授权工作区内。",
                );
              }
              return relativePath;
            });
          const requireOwnedTerminal = (terminalId: string) =>
            Effect.gen(function* () {
              const binding = toolBrokerContexts.get(input.threadId);
              if (
                binding === undefined ||
                !binding.active ||
                !binding.terminalOutputByteLimits.has(terminalId)
              ) {
                return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
                  "ACP terminal handle 不属于当前授权 Run。",
                );
              }
              return binding;
            });
          const readTerminalSnapshot = (
            method: string,
            terminalId: string,
            identity: { readonly toolCallId: string; readonly idempotencyKey: string },
          ): Effect.Effect<
            {
              readonly history: string;
              readonly status: string;
              readonly exitCode: unknown;
              readonly exitSignal: unknown;
            },
            EffectAcpErrors.AcpError
          > =>
            invokeTool(method, "terminal.snapshot", { terminalId }, identity).pipe(
              Effect.flatMap((result) => {
                if (
                  !isRecord(result) ||
                  typeof result.history !== "string" ||
                  typeof result.status !== "string"
                ) {
                  return Effect.fail(
                    EffectAcpErrors.AcpRequestError.internalError(
                      "T3 终端快照格式无效。",
                      undefined,
                      { method, operation: "handle-request" },
                    ),
                  );
                }
                return Effect.succeed({
                  history: result.history,
                  status: result.status,
                  exitCode: result.exitCode,
                  exitSignal: result.exitSignal,
                });
              }),
            );
          let activeAcpSessionId: string | undefined;
          const requireActiveAcpSession = (requestSessionId: string) =>
            requestSessionId === activeAcpSessionId
              ? Effect.void
              : Effect.fail(
                  EffectAcpErrors.AcpRequestError.invalidParams(
                    "ACP 请求 sessionId 与当前 Cursor session 不匹配。",
                  ),
                );
          const started = yield* Effect.gen(function* () {
            if (toolBrokerBinding !== undefined) {
              yield* acp.handleReadTextFile((request) =>
                Effect.gen(function* () {
                  yield* requireActiveAcpSession(request.sessionId);
                  const relativePath = yield* resolveAcpRelativePath(request.path);
                  const result = yield* invokeTool(
                    "fs/read_text_file",
                    "workspace.read_file",
                    {
                      cwd: toolBrokerBinding.context.workspaceRoot,
                      relativePath,
                    },
                    yield* makeToolIdentity("fs/read_text_file"),
                  );
                  if (!isRecord(result) || typeof result.contents !== "string") {
                    return yield* EffectAcpErrors.AcpRequestError.internalError(
                      "T3 文件读取结果格式无效。",
                    );
                  }
                  const startLine = Math.max(0, (request.line ?? 1) - 1);
                  const lines = result.contents.split(/\r?\n/);
                  const selected =
                    request.limit === undefined || request.limit === null
                      ? lines.slice(startLine)
                      : lines.slice(startLine, startLine + request.limit);
                  return { content: selected.join("\n") };
                }),
              );
              yield* acp.handleWriteTextFile((request) =>
                Effect.gen(function* () {
                  yield* requireActiveAcpSession(request.sessionId);
                  const relativePath = yield* resolveAcpRelativePath(request.path);
                  yield* invokeTool(
                    "fs/write_text_file",
                    "workspace.write_file",
                    {
                      cwd: toolBrokerBinding.context.workspaceRoot,
                      relativePath,
                      contents: request.content,
                    },
                    yield* makeToolIdentity("fs/write_text_file"),
                  );
                  return {};
                }),
              );
              yield* acp.handleCreateTerminal((request) =>
                Effect.gen(function* () {
                  yield* requireActiveAcpSession(request.sessionId);
                  if (
                    request.cwd !== undefined &&
                    request.cwd !== null &&
                    path.resolve(request.cwd) !==
                      path.resolve(toolBrokerBinding.context.workspaceRoot)
                  ) {
                    return yield* EffectAcpErrors.AcpRequestError.invalidParams(
                      "ACP 终端 cwd 必须等于授权工作区根目录。",
                    );
                  }
                  const baseIdentity = yield* makeToolIdentity("terminal/create");
                  const terminalId = `acp-${baseIdentity.id}`;
                  const binding = toolBrokerContexts.get(input.threadId);
                  if (binding === undefined || !binding.active) {
                    return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
                      "T3 ToolBroker binding 已撤销。",
                    );
                  }
                  const env = Object.fromEntries(
                    (request.env ?? []).map((entry) => [entry.name, entry.value]),
                  );
                  const createResult = yield* Effect.result(
                    invokeTool(
                      "terminal/create",
                      "terminal.exec",
                      {
                        cwd: binding.context.workspaceRoot,
                        terminalId,
                        command: request.command,
                        args: [...(request.args ?? [])],
                        ...(Object.keys(env).length === 0 ? {} : { env }),
                      },
                      baseIdentity,
                    ),
                  );
                  if (createResult._tag === "Failure") {
                    yield* closeOwnedTerminal(input.threadId, binding, terminalId);
                    return yield* createResult.failure;
                  }
                  binding.terminalOutputByteLimits.set(terminalId, request.outputByteLimit ?? null);
                  return { terminalId };
                }),
              );
              yield* acp.handleTerminalOutput((request) =>
                Effect.gen(function* () {
                  yield* requireActiveAcpSession(request.sessionId);
                  const binding = yield* requireOwnedTerminal(request.terminalId);
                  const snapshot = yield* readTerminalSnapshot(
                    "terminal/output",
                    request.terminalId,
                    yield* makeToolIdentity("terminal/output"),
                  );
                  const limited = truncateTerminalOutput(
                    snapshot.history,
                    binding.terminalOutputByteLimits.get(request.terminalId),
                  );
                  const exited = snapshot.status === "exited" || snapshot.status === "error";
                  return {
                    output: limited.output,
                    truncated: limited.truncated,
                    ...(exited
                      ? {
                          exitStatus: {
                            exitCode:
                              typeof snapshot.exitCode === "number" ? snapshot.exitCode : null,
                            signal:
                              typeof snapshot.exitSignal === "number"
                                ? String(snapshot.exitSignal)
                                : null,
                          },
                        }
                      : {}),
                  };
                }),
              );
              yield* acp.handleTerminalWaitForExit((request) => {
                const waitForExit = (
                  attempt: number,
                ): Effect.Effect<
                  EffectAcpSchema.WaitForTerminalExitResponse,
                  EffectAcpErrors.AcpError
                > =>
                  Effect.gen(function* () {
                    yield* requireActiveAcpSession(request.sessionId);
                    yield* requireOwnedTerminal(request.terminalId);
                    const baseIdentity = yield* makeToolIdentity(
                      "terminal/wait_for_exit",
                      String(attempt),
                    );
                    const snapshot = yield* readTerminalSnapshot(
                      "terminal/wait_for_exit",
                      request.terminalId,
                      baseIdentity,
                    );
                    if (snapshot.status === "exited" || snapshot.status === "error") {
                      return {
                        exitCode: typeof snapshot.exitCode === "number" ? snapshot.exitCode : null,
                        signal:
                          typeof snapshot.exitSignal === "number"
                            ? String(snapshot.exitSignal)
                            : null,
                      };
                    }
                    yield* Effect.sleep(Duration.millis(100));
                    return yield* Effect.suspend(() => waitForExit(attempt + 1));
                  });
                return waitForExit(0);
              });
              const releaseTerminal = (terminalId: string) =>
                Effect.gen(function* () {
                  const binding = yield* requireOwnedTerminal(terminalId);
                  yield* invokeTool(
                    "terminal/release",
                    "terminal.close",
                    { terminalId },
                    yield* makeToolIdentity("terminal/release"),
                  );
                  binding.terminalOutputByteLimits.delete(terminalId);
                  return {};
                });
              yield* acp.handleTerminalKill((request) =>
                Effect.gen(function* () {
                  yield* requireActiveAcpSession(request.sessionId);
                  yield* requireOwnedTerminal(request.terminalId);
                  yield* invokeTool(
                    "terminal/kill",
                    "terminal.kill",
                    { terminalId: request.terminalId },
                    yield* makeToolIdentity("terminal/kill"),
                  );
                  return {};
                }),
              );
              yield* acp.handleTerminalRelease((request) =>
                requireActiveAcpSession(request.sessionId).pipe(
                  Effect.andThen(releaseTerminal(request.terminalId)),
                ),
              );
            }
            yield* acp.handleExtRequest("cursor/ask_question", CursorAskQuestionRequest, (params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "cursor/ask_question",
                    params,
                    "acp.cursor.extension",
                  );
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: extractAskQuestions(params) },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/ask_question",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolved },
                  });
                  return { answers: resolved };
                }),
              ),
            );
            yield* acp.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "cursor/create_plan",
                    params,
                    "acp.cursor.extension",
                  );
                  yield* offerRuntimeEvent({
                    type: "turn.proposed.completed",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    payload: { planMarkdown: extractPlanMarkdown(params) },
                    raw: {
                      source: "acp.cursor.extension",
                      method: "cursor/create_plan",
                      payload: params,
                    },
                  });
                  return { accepted: true } as const;
                }),
              ),
            );
            yield* acp.handleExtNotification(
              "cursor/update_todos",
              CursorUpdateTodosRequest,
              (params) =>
                mapExtensionFailure(
                  Effect.gen(function* () {
                    yield* logNative(
                      input.threadId,
                      "cursor/update_todos",
                      params,
                      "acp.cursor.extension",
                    );
                    if (ctx) {
                      yield* emitPlanUpdate(
                        ctx,
                        extractTodosAsPlan(params),
                        params,
                        "acp.cursor.extension",
                        "cursor/update_todos",
                      );
                    }
                  }),
                ),
            );
            yield* acp.handleRequestPermission((params) =>
              mapExtensionFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parsePermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : {
                            outcome: "selected" as const,
                            optionId: acpPermissionOutcome(resolved),
                          },
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          activeAcpSessionId = started.sessionId;

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: cursorModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: cursorModelSelection?.model,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: CURSOR_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Cursor runtime notification.", { cause }),
            ),
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          if (pendingToolBrokerContexts.get(input.threadId) === toolBrokerBinding) {
            pendingToolBrokerContexts.delete(input.threadId);
          }
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Cursor ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: CursorAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // A sendTurn while a prompt is in flight is a steer: the agent folds
        // the new prompt into the ongoing work, so the active turn id is
        // reused instead of opening a new turn.
        const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
        const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
        // Count this prompt immediately so a superseded in-flight prompt
        // resolving from here on does not settle the turn; the matching
        // decrement is the `ensuring` below.
        ctx.promptsInFlight += 1;

        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const resolvedModel = resolveCursorAcpBaseModelId(model);
          yield* applyRequestedSessionConfiguration({
            runtime: ctx.acp,
            runtimeMode: ctx.session.runtimeMode,
            interactionMode: input.interactionMode,
            modelSelection:
              model === undefined
                ? undefined
                : {
                    model,
                    options: turnModelSelection?.options,
                  },
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });
          ctx.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            ctx.lastPlanFingerprint = undefined;
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };

          if (steeringTurnId === undefined) {
            yield* offerRuntimeEvent({
              type: "turn.started",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { model: resolvedModel },
            });
          }

          const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
          if (input.input?.trim()) {
            promptParts.push({ type: "text", text: input.input.trim() });
          }
          if (input.attachments && input.attachments.length > 0) {
            for (const attachment of input.attachments) {
              const attachmentPath = resolveAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "session/prompt",
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              promptParts.push({
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              });
            }
          }

          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }

          const result = yield* ctx.acp
            .prompt({
              prompt: promptParts,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          const turnRecord = ctx.turns.find((turn) => turn.id === turnId);
          if (turnRecord) {
            turnRecord.items.push({ prompt: promptParts, result });
          } else {
            ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          }
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            model: resolvedModel,
          };

          // Only the last remaining prompt settles the turn — a steer-
          // superseded prompt resolving (usually cancelled) while another is
          // in flight or pending must leave the merged turn running.
          if (ctx.promptsInFlight === 1) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: {
                state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                stopReason: result.stopReason ?? null,
              },
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);
            }),
          ),
        );
      });

    const interruptTurn: CursorAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const respondToRequest: CursorAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: CursorAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "cursor/ask_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: CursorAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: CursorAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: CursorAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: CursorAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: CursorAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const clearAllToolBrokerContexts = Effect.gen(function* () {
      const threadIds = new Set<ThreadId>([
        ...pendingToolBrokerContexts.keys(),
        ...toolBrokerContexts.keys(),
      ]);
      yield* Effect.forEach(threadIds, cleanupThreadToolBrokerContexts, {
        concurrency: "unbounded",
        discard: true,
      });
      capabilityHandshakes.clear();
    });

    const stopAll: CursorAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.ensuring(clearAllToolBrokerContexts),
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.ensuring(clearAllToolBrokerContexts),
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Cursor session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        toolBrokerCanonicalTools: [
          "workspace.read_file",
          "workspace.write_file",
          "terminal.exec",
          "terminal.snapshot",
          "terminal.kill",
          "terminal.close",
        ],
      },
      handshakeCapabilities,
      revokeCapabilityHandshake,
      configureToolBroker,
      clearToolBroker,
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies CursorAdapterShape;
  });
}
