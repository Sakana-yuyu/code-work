// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { stableStringify } from "@codework/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionToolInvocationStore,
  CompositionToolInvocationStoreDomainError,
  type CompositionToolInvocation,
  type CompositionToolInvocationClaimResult,
  type CompositionToolInvocationStoreError,
  type CompositionToolInvocationStoreShape,
  type CompositionToolInvocationTerminalStatus,
} from "../persistence/Services/CompositionToolInvocationStore.ts";

export const CompositionToolInvocationCoordinatorErrorCode = Schema.Literals([
  "tool_invocation_not_found",
  "tool_invocation_input_invalid",
  "tool_invocation_identity_conflict",
  "tool_invocation_revision_conflict",
  "tool_invocation_status_conflict",
  "tool_invocation_terminal_conflict",
  "tool_invocation_list_limit_invalid",
  "tool_invocation_store_unavailable",
]);
export type CompositionToolInvocationCoordinatorErrorCode =
  typeof CompositionToolInvocationCoordinatorErrorCode.Type;

export class CompositionToolInvocationCoordinatorError extends Schema.TaggedErrorClass<CompositionToolInvocationCoordinatorError>()(
  "CompositionToolInvocationCoordinatorError",
  {
    code: CompositionToolInvocationCoordinatorErrorCode,
    phase: Schema.Literals(["startup", "begin", "finish"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Tool Invocation 协调失败：${this.phase}: ${this.code}`;
  }
}

export interface CompositionToolInvocationBeginInput {
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly canonicalToolName: string;
  readonly operation: string;
  readonly arguments: unknown;
  readonly workspaceRoot: string;
  readonly capabilityGrantIds: readonly string[];
  readonly runtimeId?: string;
  readonly threadId?: string;
  readonly providerInstanceId?: string;
  readonly startedAtUnixMs: number;
}

export interface CompositionToolInvocationFinishInput {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly status: CompositionToolInvocationTerminalStatus;
  readonly outcomeCode: string | null;
  readonly finishedAtUnixMs: number;
}

export interface CompositionToolInvocationCoordinatorShape {
  readonly begin: (
    input: CompositionToolInvocationBeginInput,
  ) => Effect.Effect<
    CompositionToolInvocationClaimResult,
    CompositionToolInvocationCoordinatorError
  >;
  readonly finish: (
    input: CompositionToolInvocationFinishInput,
  ) => Effect.Effect<CompositionToolInvocation, CompositionToolInvocationCoordinatorError>;
}

export class CompositionToolInvocationCoordinator extends Context.Service<
  CompositionToolInvocationCoordinator,
  CompositionToolInvocationCoordinatorShape
>()("codework/composition/CompositionToolInvocationCoordinator") {
  static readonly layer = Layer.effect(
    CompositionToolInvocationCoordinator,
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      return yield* makeCompositionToolInvocationCoordinator(store);
    }),
  );
}

const isStoreDomainError = Schema.is(CompositionToolInvocationStoreDomainError);
const isCoordinatorError = Schema.is(CompositionToolInvocationCoordinatorError);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);

const coordinatorError = (
  phase: CompositionToolInvocationCoordinatorError["phase"],
  error: CompositionToolInvocationStoreError | unknown,
): CompositionToolInvocationCoordinatorError =>
  new CompositionToolInvocationCoordinatorError({
    code: isStoreDomainError(error) ? error.code : "tool_invocation_store_unavailable",
    phase,
    cause: error,
  });

const digest = (
  phase: CompositionToolInvocationCoordinatorError["phase"],
  value: unknown,
): Effect.Effect<string, CompositionToolInvocationCoordinatorError> =>
  Effect.gen(function* () {
    const json = yield* decodeJson(value).pipe(
      Effect.mapError(
        (cause) =>
          new CompositionToolInvocationCoordinatorError({
            code: "tool_invocation_input_invalid",
            phase,
            cause,
          }),
      ),
    );
    return yield* Effect.try({
      try: () =>
        `sha256:${NodeCrypto.createHash("sha256").update(stableStringify(json), "utf8").digest("hex")}`,
      catch: (cause) =>
        new CompositionToolInvocationCoordinatorError({
          code: "tool_invocation_input_invalid",
          phase,
          cause,
        }),
    });
  });

const sameTerminal = (
  invocation: CompositionToolInvocation,
  input: CompositionToolInvocationFinishInput,
): boolean =>
  invocation.revision === input.expectedRevision + 1 &&
  invocation.status === input.status &&
  invocation.outcomeCode === input.outcomeCode;

export const makeCompositionToolInvocationCoordinator = (
  store: CompositionToolInvocationStoreShape,
): Effect.Effect<
  CompositionToolInvocationCoordinatorShape,
  CompositionToolInvocationCoordinatorError
> => {
  const begin: CompositionToolInvocationCoordinatorShape["begin"] = Effect.fn(
    "CompositionToolInvocationCoordinator.begin",
  )(function* (input) {
    const argumentsDigest = yield* digest("begin", input.arguments);
    const scopeDigest = yield* digest("begin", {
      capabilityGrantIds: [...new Set(input.capabilityGrantIds)].sort(),
      ...(input.providerInstanceId === undefined
        ? {}
        : { providerInstanceId: input.providerInstanceId }),
      ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
      ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      workspaceRoot: input.workspaceRoot,
    });
    const prepared = yield* store
      .prepareInvocation({
        idempotencyKey: input.idempotencyKey,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
        canonicalToolName: input.canonicalToolName,
        operation: input.operation,
        argumentsDigest,
        scopeDigest,
        createdAtUnixMs: input.startedAtUnixMs,
      })
      .pipe(Effect.mapError((error) => coordinatorError("begin", error)));
    return yield* store
      .claimPrepared({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: prepared.revision,
        claimedAtUnixMs: Math.max(input.startedAtUnixMs, prepared.updatedAtUnixMs),
      })
      .pipe(Effect.mapError((error) => coordinatorError("begin", error)));
  });

  const finish: CompositionToolInvocationCoordinatorShape["finish"] = Effect.fn(
    "CompositionToolInvocationCoordinator.finish",
  )(function* (input) {
    return yield* store.saveTerminal(input).pipe(
      Effect.catchTag("CompositionToolInvocationStoreDomainError", (error) =>
        error.code !== "tool_invocation_terminal_conflict"
          ? Effect.fail(coordinatorError("finish", error))
          : store.getInvocation(input.idempotencyKey).pipe(
              Effect.mapError((currentError) => coordinatorError("finish", currentError)),
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(coordinatorError("finish", error)),
                  onSome: (current) =>
                    sameTerminal(current, input)
                      ? Effect.succeed(current)
                      : Effect.fail(coordinatorError("finish", error)),
                }),
              ),
            ),
      ),
      Effect.mapError((error) =>
        isCoordinatorError(error) ? error : coordinatorError("finish", error),
      ),
    );
  });

  return Effect.succeed(CompositionToolInvocationCoordinator.of({ begin, finish }));
};
