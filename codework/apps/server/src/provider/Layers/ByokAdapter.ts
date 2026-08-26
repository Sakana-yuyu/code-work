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
 * There is no structured tool input/output or permission flow in the engine,
 * so those adapter methods surface "unsupported" errors; agentic tool use
 * goes through the BYOK delegation executor instead. Rollback is local:
 * the history is truncated by N turns.
 *
 * @module provider/Layers/ByokAdapter
 */
import {
  EventId,
  type ByokModelAdapter,
  type ByokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type ByokAdapterShape } from "../Services/ByokAdapter.ts";
import {
  byokAdapterForModel,
  type ByokChatMessage,
  type ByokContentPart,
  runChatEvents,
  streamChat,
} from "./byokChatClient.ts";
import { applyPromptTemplate, renderPromptTemplate } from "../byok/PromptTemplate.ts";

const PROVIDER = ProviderDriverKind.make("byok");

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Rough chars-per-token estimate used to bound the replayed history. */
const BYOK_HISTORY_CHARS_PER_TOKEN = 4;

/** Rough replay cost of one inline image (≈1k tokens) for history fitting. */
const BYOK_IMAGE_CHARS_ESTIMATE = 4_000;

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
}

export interface ByokAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

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

    // Fibers forked into this scope are interrupted when the adapter layer
    // shuts down, so a streaming turn can never outlive its instance.
    const adapterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );

    const sessions = new Map<ThreadId, ByokSessionContext>();
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();

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

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const ctx: ByokSessionContext = {
          session,
          cwd,
          history: [],
          turns: [],
          activeTurnId: undefined,
          activeTurnFiber: undefined,
        };
        sessions.set(input.threadId, ctx);

        yield* emit({
          ...(yield* makeEventStamp()),
          type: "session.started",
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { message: "BYOK engine session started" },
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
     * Stream one turn: consume `streamChat` events, emit them as runtime
     * `content.delta`s, and settle the turn when the stream ends.
     */
    const runTurn = Effect.fn("byokRunTurn")(function* (
      ctx: ByokSessionContext,
      turnId: TurnId,
      adapter: ByokModelAdapter,
      messages: ReadonlyArray<ByokChatMessage>,
      systemPrompt: string,
    ) {
      let assistantText = "";
      let reasoningText = "";
      const stream = streamChat(httpClient, {
        protocol: adapter.protocol,
        baseURL: adapter.baseURL,
        apiKey: adapter.apiKey,
        modelId: adapter.modelId,
        messages,
        ...(systemPrompt.trim().length > 0 ? { systemPrompt } : {}),
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
            if (event.text.length === 0) {
              return;
            }
            if (event.type === "reasoning") {
              reasoningText += event.text;
              appendTurnItem(ctx, turnId, { type: "thinking", text: event.text });
              yield* emit({
                ...(yield* makeEventStamp()),
                type: "content.delta",
                provider: PROVIDER,
                threadId: ctx.session.threadId,
                turnId,
                payload: { streamKind: "reasoning_text", delta: event.text },
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

      if (assistantText.trim().length > 0) {
        ctx.history.push({ role: "assistant", content: assistantText });
      } else if (reasoningText.trim().length === 0) {
        ctx.history.push({ role: "assistant", content: "" });
      }
      ctx.history = fitHistory(ctx.history, adapter.contextWindowTokens);
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

      const fiber = yield* runTurn(ctx, turnId, adapter, messages, systemPrompt).pipe(
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
