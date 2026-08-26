import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

export type CompositionRuntimeMcpBindingRequest = {
  readonly rawToken: string;
  readonly runtimeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly expiresAtUnixMs: number;
};

export type CompositionRuntimeMcpBinding = Omit<CompositionRuntimeMcpBindingRequest, "rawToken"> & {
  readonly capabilityHandshakeId: string;
};

export class CompositionRuntimeMcpBindingError extends Schema.TaggedErrorClass<CompositionRuntimeMcpBindingError>()(
  "CompositionRuntimeMcpBindingError",
  {
    code: Schema.Literals(["invalid_binding", "credential_in_use"]),
  },
) {}

export interface CompositionRuntimeMcpSessionRegistryShape {
  readonly activate: (
    request: CompositionRuntimeMcpBindingRequest,
  ) => Effect.Effect<CompositionRuntimeMcpBinding, CompositionRuntimeMcpBindingError>;
  readonly resolve: (rawToken: string) => Effect.Effect<CompositionRuntimeMcpBinding | undefined>;
  readonly revokeHandshake: (capabilityHandshakeId: string) => Effect.Effect<void>;
  readonly revokeRun: (runId: string) => Effect.Effect<void>;
  readonly revokeRuntime: (runtimeId: string) => Effect.Effect<void>;
  readonly awaitRevocation: (capabilityHandshakeId: string) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class CompositionRuntimeMcpSessionRegistry extends Context.Service<
  CompositionRuntimeMcpSessionRegistry,
  CompositionRuntimeMcpSessionRegistryShape
>()("codework/mcp/CompositionRuntimeMcpSessionRegistry") {}

type CredentialRecord = {
  readonly tokenHash: string;
  readonly binding: CompositionRuntimeMcpBinding;
  readonly revocation: Deferred.Deferred<void>;
};

type RegistryState = {
  readonly records: ReadonlyMap<string, CredentialRecord>;
};

export type CompositionRuntimeMcpSessionRegistryOptions = {
  readonly now?: () => number;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const normalizedUnique = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))].sort();

const sameStringSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const normalizedLeft = normalizedUnique(left);
  const normalizedRight = normalizedUnique(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
};

const sameScope = (
  binding: CompositionRuntimeMcpBinding,
  request: CompositionRuntimeMcpBindingRequest,
): boolean =>
  binding.runtimeId === request.runtimeId &&
  binding.taskId === request.taskId &&
  binding.runId === request.runId &&
  binding.agentId === request.agentId &&
  sameStringSet(binding.capabilityGrantIds, request.capabilityGrantIds);

const makeWithOptions = Effect.fn("CompositionRuntimeMcpSessionRegistry.make")(function* (
  options: CompositionRuntimeMcpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneExpired = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) =>
    new Map(Array.from(records).filter(([, record]) => record.binding.expiresAtUnixMs > timestamp));

  const activate: CompositionRuntimeMcpSessionRegistryShape["activate"] = Effect.fn(
    "CompositionRuntimeMcpSessionRegistry.activate",
  )(function* (request) {
    const rawToken = request.rawToken.trim();
    const runtimeId = request.runtimeId.trim();
    const taskId = request.taskId.trim();
    const runId = request.runId.trim();
    const agentId = request.agentId.trim();
    const capabilityGrantIds = normalizedUnique(request.capabilityGrantIds);
    const timestamp = yield* currentTimeMillis;
    if (
      rawToken.length === 0 ||
      runtimeId.length === 0 ||
      taskId.length === 0 ||
      runId.length === 0 ||
      agentId.length === 0 ||
      capabilityGrantIds.length !== request.capabilityGrantIds.length ||
      request.expiresAtUnixMs <= timestamp
    ) {
      return yield* new CompositionRuntimeMcpBindingError({ code: "invalid_binding" });
    }

    const tokenHash = yield* hashToken(rawToken);
    const nextHandshakeId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const revocation = yield* Deferred.make<void>();
    return yield* SynchronizedRef.modifyEffect(state, ({ records }) => {
      const current = pruneExpired(records, timestamp);
      const existing = current.get(tokenHash);
      if (existing !== undefined) {
        if (!sameScope(existing.binding, request)) {
          return Effect.fail(new CompositionRuntimeMcpBindingError({ code: "credential_in_use" }));
        }
        return Effect.succeed([existing.binding, { records: current }] as const);
      }

      const binding: CompositionRuntimeMcpBinding = {
        runtimeId,
        taskId,
        runId,
        agentId,
        capabilityGrantIds,
        capabilityHandshakeId: nextHandshakeId,
        expiresAtUnixMs: request.expiresAtUnixMs,
      };
      const next = new Map(current);
      next.set(tokenHash, { tokenHash, binding, revocation });
      return Effect.succeed([binding, { records: next }] as const);
    });
  });

  const resolve: CompositionRuntimeMcpSessionRegistryShape["resolve"] = Effect.fn(
    "CompositionRuntimeMcpSessionRegistry.resolve",
  )(function* (rawToken) {
    const token = rawToken.trim();
    if (token.length === 0) return undefined;
    const tokenHash = yield* hashToken(token);
    const timestamp = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const current = pruneExpired(records, timestamp);
      return [current.get(tokenHash)?.binding, { records: current }] as const;
    });
  });

  const revokeWhere = (predicate: (binding: CompositionRuntimeMcpBinding) => boolean) =>
    SynchronizedRef.modify(state, ({ records }) => {
      const revoked: Array<Deferred.Deferred<void>> = [];
      const remaining = new Map<string, CredentialRecord>();
      for (const [tokenHash, record] of records) {
        if (predicate(record.binding)) revoked.push(record.revocation);
        else remaining.set(tokenHash, record);
      }
      return [revoked, { records: remaining }] as const;
    }).pipe(
      Effect.flatMap((revoked) =>
        Effect.all(revoked.map((signal) => Deferred.succeed(signal, undefined))).pipe(
          Effect.asVoid,
        ),
      ),
    );

  return CompositionRuntimeMcpSessionRegistry.of({
    activate,
    resolve,
    revokeHandshake: Effect.fn("CompositionRuntimeMcpSessionRegistry.revokeHandshake")(
      function* (capabilityHandshakeId) {
        yield* revokeWhere((binding) => binding.capabilityHandshakeId === capabilityHandshakeId);
      },
    ),
    revokeRun: Effect.fn("CompositionRuntimeMcpSessionRegistry.revokeRun")(function* (runId) {
      yield* revokeWhere((binding) => binding.runId === runId);
    }),
    revokeRuntime: Effect.fn("CompositionRuntimeMcpSessionRegistry.revokeRuntime")(
      function* (runtimeId) {
        yield* revokeWhere((binding) => binding.runtimeId === runtimeId);
      },
    ),
    awaitRevocation: Effect.fn("CompositionRuntimeMcpSessionRegistry.awaitRevocation")(
      function* (capabilityHandshakeId) {
        const record = yield* SynchronizedRef.get(state).pipe(
          Effect.map(({ records }) =>
            Array.from(records.values()).find(
              (candidate) => candidate.binding.capabilityHandshakeId === capabilityHandshakeId,
            ),
          ),
        );
        if (record === undefined) return;
        const now = yield* currentTimeMillis;
        if (record.binding.expiresAtUnixMs <= now) return;
        yield* Effect.raceFirst(
          Deferred.await(record.revocation),
          Effect.sleep(Duration.millis(record.binding.expiresAtUnixMs - now)),
        );
      },
    ),
    revokeAll: revokeWhere(() => true),
  });
});

const make = makeWithOptions();

export const layer = Layer.effect(CompositionRuntimeMcpSessionRegistry, make);

export const __testing = { make: makeWithOptions };
