import {
  EventId,
  type AntigravitySettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@codework/shared/shell";

import { ServerConfig } from "../../config.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import { resolveConfiguredAntigravityModel } from "./AntigravityProvider.ts";
import {
  ProviderAdapterProcessError,
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("antigravity");

type SessionContext = {
  session: ProviderSession;
  turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }>;
  conversationId?: string;
  activeChild:
    | { readonly kill: () => Effect.Effect<unknown, PlatformError.PlatformError> }
    | undefined;
  interrupted: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textDelta(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record?.event !== "step_update") return undefined;
  const step = asRecord(record.step_update);
  return step?.step_type === "agent_response" && typeof step.text_delta === "string"
    ? step.text_delta
    : undefined;
}

function conversationId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const body = asRecord(record[record.event === "result" ? "result" : "step_update"]);
  const id = record.conversation_id ?? body?.conversation_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function parseAntigravityLine(
  line: string,
): { readonly raw: unknown; readonly text?: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const raw: unknown = JSON.parse(trimmed);
    const text = textDelta(raw);
    return text === undefined ? { raw } : { raw, text };
  } catch {
    // agy 可能在 NDJSON 之间输出人类可读的诊断行。
    return undefined;
  }
}

export function parseAntigravityStreamJson(
  stdout: string,
): ReadonlyArray<{ readonly raw: unknown; readonly text?: string }> {
  const events: Array<{ readonly raw: unknown; readonly text?: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseAntigravityLine(line);
    if (event) events.push(event);
  }
  return events;
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options?: { readonly instanceId?: ProviderInstanceId; readonly environment?: NodeJS.ProcessEnv },
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("antigravity");
    const sessions = new Map<ThreadId, SessionContext>();
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const now = () => Effect.map(DateTime.now, DateTime.formatIso);
    const uuid = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
    const emit = (event: Omit<ProviderRuntimeEvent, "eventId" | "createdAt">) =>
      Effect.all({ eventId: uuid(), createdAt: now() }).pipe(
        Effect.flatMap((stamp) =>
          Queue.offer(events, { ...event, ...stamp } as ProviderRuntimeEvent),
        ),
      );
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession = Effect.fn("antigravityStartSession")(function* (
      input: ProviderSessionStartInput,
    ) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}'.`,
        });
      }
      const cwd = input.cwd?.trim() || serverConfig.cwd;
      if (!cwd) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required.",
        });
      }
      const createdAt = yield* now();
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        turns: [],
        activeChild: undefined,
        interrupted: false,
      });
      yield* emit({
        type: "session.started",
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        payload: { message: "Antigravity headless session started" },
      });
      yield* emit({
        type: "thread.started",
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        payload: { providerThreadId: input.threadId },
      });
      return session;
    }) as unknown as ProviderAdapterShape<ProviderAdapterError>["startSession"];

    const sendTurnEffect = Effect.fn("antigravitySendTurn")(function* (
      input: ProviderSendTurnInput,
    ) {
      const context = yield* requireSession(input.threadId);
      const prompt = input.input?.trim();
      if (!prompt) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Antigravity headless turns require non-empty text.",
        });
      }
      const turnId = TurnId.make(yield* crypto.randomUUIDv4);
      const itemId = RuntimeItemId.make(yield* crypto.randomUUIDv4);
      context.interrupted = false;
      yield* emit({
        type: "turn.started",
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        turnId,
        payload: { model: input.modelSelection?.model ?? context.session.model },
        raw: { source: "antigravity.stream-json", payload: { prompt } },
      });

      const args = ["-p", prompt, "--output-format", "stream-json"];
      const resume = context.conversationId;
      if (resume) args.push("--conversation", resume);
      const selectedModel = resolveConfiguredAntigravityModel(
        settings,
        input.modelSelection?.model,
      );
      if (selectedModel) {
        args.push("--model", selectedModel);
      }
      const resolved = yield* resolveSpawnCommand(settings.binaryPath, args, {
        ...(options?.environment ? { env: options.environment } : {}),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: String(cause),
              cause,
            }),
        ),
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: context.session.cwd,
            ...(options?.environment ? { env: options.environment } : { extendEnv: true }),
            shell: resolved.shell,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: String(cause),
                cause,
              }),
          ),
        );
      context.activeChild = child;
      const outputParts: string[] = [];
      let resultStatus: string | undefined;
      let resultError: string | undefined;
      let resultResponse: string | undefined;
      const consumeStdout = child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const event = parseAntigravityLine(line);
          if (!event) return Effect.void;
          const nextConversationId = conversationId(event.raw);
          if (nextConversationId) context.conversationId = nextConversationId;
          const raw = asRecord(event.raw);
          const result = raw?.event === "result" ? asRecord(raw.result) : undefined;
          if (result) {
            resultStatus = typeof result.status === "string" ? result.status : undefined;
            resultError = typeof result.error === "string" ? result.error : undefined;
            resultResponse = typeof result.response === "string" ? result.response : undefined;
          }
          const step = raw?.event === "step_update" ? asRecord(raw.step_update) : undefined;
          if (
            step?.step_type === "tool" &&
            Number.isInteger(step.step_index) &&
            Number(step.step_index) >= 0 &&
            (step.state === "ACTIVE" || step.state === "DONE")
          ) {
            const toolInfo = asRecord(step.tool_info);
            const toolError = asRecord(toolInfo?.error);
            const toolName =
              typeof step.tool_name === "string"
                ? step.tool_name
                : typeof toolInfo?.name === "string"
                  ? toolInfo.name
                  : "Antigravity tool";
            const detail =
              typeof toolError?.message === "string"
                ? toolError.message
                : typeof toolInfo?.output === "string"
                  ? toolInfo.output
                  : undefined;
            return emit({
              type: step.state === "DONE" ? "item.completed" : "item.updated",
              provider: PROVIDER,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              turnId,
              itemId: RuntimeItemId.make(`${turnId}:tool:${step.step_index}`),
              payload: {
                itemType: "dynamic_tool_call",
                status: step.state === "DONE" ? (toolError ? "failed" : "completed") : "inProgress",
                title: toolName,
                ...(detail ? { detail } : {}),
              },
            });
          }
          if (!event.text) return Effect.void;
          outputParts.push(event.text);
          return emit({
            type: "content.delta",
            provider: PROVIDER,
            providerInstanceId: instanceId,
            threadId: input.threadId,
            turnId,
            itemId,
            payload: { streamKind: "assistant_text", delta: event.text },
            raw: { source: "antigravity.stream-json", payload: event.raw },
          });
        }),
      );
      const [, stderr, exitCode] = yield* Effect.all(
        [consumeStdout, collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      ).pipe(Effect.ensuring(Effect.sync(() => (context.activeChild = undefined))));
      // 标准流的 result.response 是完整答案；仅在没有正文增量时用它补齐输出。
      if (outputParts.length === 0 && resultResponse) {
        outputParts.push(resultResponse);
        yield* emit({
          type: "content.delta",
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: { streamKind: "assistant_text", delta: resultResponse },
        });
      }
      const output = outputParts.join("");
      const succeeded = Number(exitCode) === 0 && resultStatus === "SUCCESS";
      const cancelled =
        context.interrupted || resultStatus === "CANCELED" || resultStatus === "INTERRUPTED";
      const errorMessage =
        resultError ||
        stderr.trim() ||
        (resultStatus
          ? `agy returned ${resultStatus}.`
          : "agy stream ended without a result event.");
      context.turns.push({ id: turnId, items: [{ prompt, output, stderr }] });
      context.session = { ...context.session, updatedAt: yield* now() };
      yield* emit({
        type: "item.completed",
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        turnId,
        itemId,
        payload: {
          itemType: "assistant_message",
          status: cancelled ? "cancelled" : succeeded ? "completed" : "failed",
          data: output,
        },
      });
      yield* emit({
        type: "turn.completed",
        provider: PROVIDER,
        providerInstanceId: instanceId,
        threadId: input.threadId,
        turnId,
        payload: {
          state: cancelled ? "cancelled" : succeeded ? "completed" : "failed",
          stopReason: cancelled ? "cancelled" : succeeded ? null : "process_exit",
          ...(!succeeded && !cancelled ? { errorMessage } : {}),
        },
        raw: { source: "antigravity.stream-json", payload: { exitCode: Number(exitCode) } },
      });
      if (!succeeded && !cancelled) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "agy -p",
          detail: errorMessage,
        });
      }
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { schemaVersion: 1, conversationId: context.conversationId },
      };
    });
    const sendTurn = ((input: ProviderSendTurnInput) =>
      Effect.scoped(
        sendTurnEffect(input),
      )) as unknown as ProviderAdapterShape<ProviderAdapterError>["sendTurn"];

    const readThread = ((threadId: ThreadId) =>
      requireSession(threadId).pipe(
        Effect.map((context) => ({ threadId, turns: context.turns })),
      )) as unknown as ProviderAdapterShape<ProviderAdapterError>["readThread"];
    const rollbackThread = ((threadId: ThreadId, numTurns: number) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) => {
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "numTurns must be >= 1.",
              }),
            );
          }
          context.turns.splice(Math.max(0, context.turns.length - numTurns));
          return Effect.succeed({ threadId, turns: context.turns });
        }),
      )) as unknown as ProviderAdapterShape<ProviderAdapterError>["rollbackThread"];
    const stopSession = ((threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.activeChild) yield* context.activeChild.kill().pipe(Effect.ignore);
        sessions.delete(threadId);
      })) as unknown as ProviderAdapterShape<ProviderAdapterError>["stopSession"];
    const interruptTurn = ((threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.interrupted = true;
        if (context.activeChild) yield* context.activeChild.kill().pipe(Effect.ignore);
      })) as unknown as ProviderAdapterShape<ProviderAdapterError>["interruptTurn"];
    const respondToRequest = ((threadId: ThreadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "request_permission",
              detail:
                "Antigravity headless print mode does not expose interactive permission requests.",
            }),
          ),
        ),
      )) as unknown as ProviderAdapterShape<ProviderAdapterError>["respondToRequest"];
    const respondToUserInput = ((threadId: ThreadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "user_input",
              detail: "Antigravity headless print mode does not expose interactive user input.",
            }),
          ),
        ),
      )) as unknown as ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"];
    const listSessions = () =>
      Effect.succeed([...sessions.values()].map((context) => context.session));
    const hasSession = (threadId: ThreadId) => Effect.succeed(sessions.has(threadId));
    const stopAll = () =>
      Effect.forEach(
        [...sessions.values()],
        (context) =>
          context.activeChild ? context.activeChild.kill().pipe(Effect.ignore) : Effect.void,
        { discard: true },
      ).pipe(Effect.tap(() => Effect.sync(() => sessions.clear())));
    const streamEvents = Stream.fromQueue(events);

    yield* Effect.addFinalizer(stopAll);
    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
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
      streamEvents,
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
