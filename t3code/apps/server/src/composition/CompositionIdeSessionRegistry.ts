import type { CompositionIdeProfile, CompositionIdeResolveResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type CompositionIdeRequestedProfile = Exclude<CompositionIdeProfile, "unknown">;

export type CompositionIdeCapabilityHandshakeRequest = {
  readonly sessionId: string;
  readonly requestedProfile: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly requestedOperations: ReadonlyArray<string>;
};

export type CompositionIdeCapabilityHandshakeResult = {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly profile: CompositionIdeProfile;
  readonly status: "accepted" | "rejected" | "unsupported";
  readonly handshakeId?: string;
  readonly acceptedGrantIds: ReadonlyArray<string>;
  readonly verifiedOperations: ReadonlyArray<string>;
  readonly expiresAtUnixMs?: number;
  readonly reasonCode?: string;
};

export type CompositionIdeInvocation = {
  readonly sessionId: string;
  readonly handshakeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly operation: string;
  readonly arguments: unknown;
};

export class CompositionIdeAdapterFailure extends Schema.TaggedErrorClass<CompositionIdeAdapterFailure>()(
  "CompositionIdeAdapterFailure",
  {
    sessionId: Schema.String,
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `IDE Adapter 操作失败（${this.sessionId}）：${this.code}: ${this.detail}`;
  }
}

export class CompositionIdeSessionAlreadyRegisteredError extends Schema.TaggedErrorClass<CompositionIdeSessionAlreadyRegisteredError>()(
  "CompositionIdeSessionAlreadyRegisteredError",
  { sessionId: Schema.String },
) {
  override get message(): string {
    return `IDE session '${this.sessionId}' 已注册，拒绝覆盖活动连接。`;
  }
}

export class CompositionIdeSessionInvalidError extends Schema.TaggedErrorClass<CompositionIdeSessionInvalidError>()(
  "CompositionIdeSessionInvalidError",
  { detail: Schema.String },
) {
  override get message(): string {
    return `IDE session 注册无效：${this.detail}`;
  }
}

export class CompositionIdeSessionFailure extends Schema.TaggedErrorClass<CompositionIdeSessionFailure>()(
  "CompositionIdeSessionFailure",
  {
    sessionId: Schema.String,
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `IDE session 操作被拒绝（${this.sessionId}）：${this.code}: ${this.detail}`;
  }
}

export interface CompositionIdeAdapter {
  readonly sessionId: string;
  readonly profile: CompositionIdeRequestedProfile;
  readonly probe: () => Effect.Effect<CompositionIdeResolveResult, CompositionIdeAdapterFailure>;
  readonly handshake: (
    input: CompositionIdeCapabilityHandshakeRequest,
  ) => Effect.Effect<CompositionIdeCapabilityHandshakeResult, CompositionIdeAdapterFailure>;
  readonly invoke: (
    input: CompositionIdeInvocation,
  ) => Effect.Effect<unknown, CompositionIdeAdapterFailure>;
}

export interface CompositionIdeSessionRegistry {
  readonly register: (
    adapter: CompositionIdeAdapter,
  ) => Effect.Effect<
    void,
    CompositionIdeSessionAlreadyRegisteredError | CompositionIdeSessionInvalidError
  >;
  readonly unregister: (sessionId: string) => Effect.Effect<boolean>;
  readonly get: (sessionId: string) => Effect.Effect<CompositionIdeAdapter | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<CompositionIdeAdapter>>;
  readonly resolve: (input: {
    readonly sessionId: string;
    readonly requestedProfile: string;
  }) => Effect.Effect<CompositionIdeResolveResult>;
  readonly handshake: (
    input: CompositionIdeCapabilityHandshakeRequest,
  ) => Effect.Effect<CompositionIdeCapabilityHandshakeResult>;
  readonly invoke: (
    input: CompositionIdeInvocation,
  ) => Effect.Effect<unknown, CompositionIdeSessionFailure>;
}

export interface CompositionIdeSessionRegistryServiceShape extends CompositionIdeSessionRegistry {}

export class CompositionIdeSessionRegistryService extends Context.Service<
  CompositionIdeSessionRegistryService,
  CompositionIdeSessionRegistryServiceShape
>()("t3/composition/CompositionIdeSessionRegistry/CompositionIdeSessionRegistryService") {}

type CompositionIdeHandshakeState = {
  readonly sessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly handshakeId: string;
  readonly verifiedOperations: ReadonlySet<string>;
  readonly expiresAtUnixMs: number;
};

export interface CompositionIdeSessionRegistryOptions {
  readonly now?: () => number;
  readonly handshakeTtlMs?: number;
}

const knownProfiles = new Set<CompositionIdeRequestedProfile>([
  "cursor_ide",
  "vscode_ide",
  "browser_mcp",
]);

const nonEmpty = (value: string): boolean => value.trim().length > 0;

const normalizedUnique = (values: ReadonlyArray<string>): string[] =>
  [...new Set(values.map((value) => value.trim()))].filter(nonEmpty);

const unavailable = (sessionId: string, reasonCode: string): CompositionIdeResolveResult => ({
  sessionId,
  profile: "unknown",
  verifiedOperations: [],
  status: "unavailable",
  reasonCode,
});

const rejectedHandshake = (
  input: CompositionIdeCapabilityHandshakeRequest,
  reasonCode: string,
  profile: CompositionIdeProfile = "unknown",
): CompositionIdeCapabilityHandshakeResult => ({
  sessionId: input.sessionId,
  taskId: input.taskId,
  runId: input.runId,
  agentId: input.agentId,
  profile,
  status: "rejected",
  acceptedGrantIds: [],
  verifiedOperations: [],
  reasonCode,
});

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const normalizedLeft = normalizedUnique(left);
  const normalizedRight = normalizedUnique(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value) => normalizedRight.includes(value))
  );
};

const failure = (
  input: Pick<CompositionIdeInvocation, "sessionId">,
  code: string,
  detail: string,
) => new CompositionIdeSessionFailure({ sessionId: input.sessionId, code, detail });

export const makeCompositionIdeSessionRegistry = (
  options: CompositionIdeSessionRegistryOptions = {},
): CompositionIdeSessionRegistry => {
  const adapters = new Map<string, CompositionIdeAdapter>();
  const handshakes = new Map<string, CompositionIdeHandshakeState>();
  const now = options.now ?? Date.now;
  const handshakeTtlMs = options.handshakeTtlMs ?? 5 * 60 * 1000;

  const register: CompositionIdeSessionRegistry["register"] = Effect.fn(
    "CompositionIdeSessionRegistry.register",
  )(function* (adapter) {
    const sessionId = adapter.sessionId.trim();
    if (sessionId.length === 0 || sessionId !== adapter.sessionId) {
      return yield* new CompositionIdeSessionInvalidError({
        detail: "sessionId 必须为非空且已去除首尾空白的字符串。",
      });
    }
    if (!knownProfiles.has(adapter.profile)) {
      return yield* new CompositionIdeSessionInvalidError({
        detail: `不支持的 IDE profile：${adapter.profile}。`,
      });
    }
    if (adapters.has(sessionId)) {
      return yield* new CompositionIdeSessionAlreadyRegisteredError({ sessionId });
    }
    adapters.set(sessionId, adapter);
  });

  const unregister: CompositionIdeSessionRegistry["unregister"] = (sessionId) =>
    Effect.sync(() => {
      const removed = adapters.delete(sessionId);
      for (const [handshakeId, handshake] of handshakes) {
        if (handshake.sessionId === sessionId) handshakes.delete(handshakeId);
      }
      return removed;
    });

  const resolve: CompositionIdeSessionRegistry["resolve"] = (input) => {
    const adapter = adapters.get(input.sessionId);
    if (
      adapter === undefined ||
      !knownProfiles.has(input.requestedProfile as CompositionIdeRequestedProfile)
    ) {
      return Effect.succeed(unavailable(input.sessionId, "ide_profile_unknown"));
    }
    return adapter.probe().pipe(
      Effect.map((result) =>
        result.status === "ready" &&
        result.profile === input.requestedProfile &&
        result.profile === adapter.profile
          ? result
          : unavailable(
              input.sessionId,
              result.profile === input.requestedProfile
                ? "ide_probe_unavailable"
                : "ide_profile_mismatch",
            ),
      ),
      Effect.catchTag("CompositionIdeAdapterFailure", () =>
        Effect.succeed(unavailable(input.sessionId, "ide_probe_failed")),
      ),
    );
  };

  const handshake: CompositionIdeSessionRegistry["handshake"] = (input) =>
    Effect.gen(function* () {
      const adapter = adapters.get(input.sessionId);
      const requestedOperations = normalizedUnique(input.requestedOperations);
      const capabilityGrantIds = normalizedUnique(input.capabilityGrantIds);
      if (
        adapter === undefined ||
        !knownProfiles.has(input.requestedProfile as CompositionIdeRequestedProfile)
      ) {
        return rejectedHandshake(input, "ide_profile_unknown");
      }
      if (
        !nonEmpty(input.taskId) ||
        !nonEmpty(input.runId) ||
        !nonEmpty(input.agentId) ||
        input.sessionId !== adapter.sessionId ||
        input.requestedProfile !== adapter.profile
      ) {
        return rejectedHandshake(input, "ide_handshake_scope_invalid");
      }

      const probe = yield* adapter.probe().pipe(
        Effect.mapError(() => undefined),
        Effect.option,
      );
      if (
        probe._tag === "None" ||
        probe.value.status !== "ready" ||
        probe.value.profile !== adapter.profile
      ) {
        return rejectedHandshake(input, "ide_probe_unavailable", adapter.profile);
      }

      const result = yield* adapter
        .handshake({
          ...input,
          capabilityGrantIds,
          requestedOperations,
        })
        .pipe(
          Effect.catchTag("CompositionIdeAdapterFailure", () =>
            Effect.succeed(rejectedHandshake(input, "ide_handshake_failed", adapter.profile)),
          ),
        );
      if (result.status !== "accepted") return result;
      if (
        result.handshakeId === undefined ||
        result.handshakeId.trim().length === 0 ||
        result.profile !== adapter.profile ||
        result.sessionId !== input.sessionId ||
        result.taskId !== input.taskId ||
        result.runId !== input.runId ||
        result.agentId !== input.agentId
      ) {
        return rejectedHandshake(input, "ide_handshake_result_invalid", adapter.profile);
      }
      if (!sameSet(result.acceptedGrantIds, capabilityGrantIds)) {
        return rejectedHandshake(input, "ide_grant_scope_mismatch", adapter.profile);
      }
      const verifiedOperations = normalizedUnique(result.verifiedOperations);
      const probeOperations = new Set(normalizedUnique(probe.value.verifiedOperations));
      if (verifiedOperations.some((operation) => !probeOperations.has(operation))) {
        return rejectedHandshake(input, "ide_operation_not_probe_verified", adapter.profile);
      }
      if (verifiedOperations.some((operation) => !requestedOperations.includes(operation))) {
        return rejectedHandshake(input, "ide_operation_scope_mismatch", adapter.profile);
      }
      const expiresAtUnixMs = Math.min(
        result.expiresAtUnixMs ?? Number.MAX_SAFE_INTEGER,
        now() + handshakeTtlMs,
      );
      if (!Number.isSafeInteger(expiresAtUnixMs) || expiresAtUnixMs <= now()) {
        return rejectedHandshake(input, "ide_handshake_expired", adapter.profile);
      }
      handshakes.set(result.handshakeId, {
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        handshakeId: result.handshakeId,
        verifiedOperations: new Set(verifiedOperations),
        expiresAtUnixMs,
      });
      return {
        ...result,
        acceptedGrantIds: capabilityGrantIds,
        verifiedOperations,
        expiresAtUnixMs,
      };
    });

  const invoke: CompositionIdeSessionRegistry["invoke"] = (input) =>
    Effect.gen(function* () {
      const adapter = adapters.get(input.sessionId);
      if (adapter === undefined) {
        return yield* failure(input, "ide_session_not_found", "IDE session 不存在或已断开。");
      }
      const handshake = handshakes.get(input.handshakeId);
      if (handshake === undefined || handshake.sessionId !== input.sessionId) {
        return yield* failure(
          input,
          "ide_handshake_not_found",
          "IDE capability handshake 不存在。",
        );
      }
      if (
        handshake.taskId !== input.taskId ||
        handshake.runId !== input.runId ||
        handshake.agentId !== input.agentId
      ) {
        return yield* failure(
          input,
          "ide_handshake_scope_mismatch",
          "IDE handshake 与 task/run/agent 不匹配。",
        );
      }
      if (now() >= handshake.expiresAtUnixMs) {
        handshakes.delete(input.handshakeId);
        return yield* failure(input, "ide_handshake_expired", "IDE capability handshake 已过期。");
      }
      if (!handshake.verifiedOperations.has(input.operation)) {
        return yield* failure(
          input,
          "ide_operation_not_verified",
          "IDE operation 不在已验证 allowlist 中。",
        );
      }
      return yield* adapter
        .invoke(input)
        .pipe(
          Effect.mapError((error) => failure(input, "ide_adapter_invoke_failed", error.detail)),
        );
    });

  return {
    register,
    unregister,
    get: (sessionId) => Effect.sync(() => adapters.get(sessionId)),
    get list() {
      return Effect.sync(() => Array.from(adapters.values()));
    },
    resolve,
    handshake,
    invoke,
  };
};

export const layer = Layer.effect(
  CompositionIdeSessionRegistryService,
  Effect.sync(makeCompositionIdeSessionRegistry),
);
