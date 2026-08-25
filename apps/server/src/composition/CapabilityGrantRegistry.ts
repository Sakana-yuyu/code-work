import type {
  CompositionCapabilityAuditEvent,
  CompositionCapabilityAuditOutcome,
  CompositionCapabilityGrant,
  CompositionCapabilityOperation,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as CapabilityRegistry from "./CapabilityRegistry.ts";

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

export class CapabilityGrantInvalidError extends Schema.TaggedErrorClass<CapabilityGrantInvalidError>()(
  "CapabilityGrantInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Capability Grant 无效：${this.reason}`;
  }
}

export class CapabilityGrantNotFoundError extends Schema.TaggedErrorClass<CapabilityGrantNotFoundError>()(
  "CapabilityGrantNotFoundError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 不存在。`;
  }
}

export class CapabilityGrantScopeMismatchError extends Schema.TaggedErrorClass<CapabilityGrantScopeMismatchError>()(
  "CapabilityGrantScopeMismatchError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 与 task/agent/capability 作用域不匹配。`;
  }
}

export class CapabilityGrantExpiredError extends Schema.TaggedErrorClass<CapabilityGrantExpiredError>()(
  "CapabilityGrantExpiredError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 已过期。`;
  }
}

export class CapabilityGrantRevokedError extends Schema.TaggedErrorClass<CapabilityGrantRevokedError>()(
  "CapabilityGrantRevokedError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 已撤销。`;
  }
}

export type CapabilityGrantIssueInput = {
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly ttlMs?: number;
};

export type CapabilityGrantValidationInput = {
  readonly grantId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityId: string;
};

export type CapabilityGrantAuditInput = {
  readonly grantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityId: string;
  readonly operation: CompositionCapabilityOperation;
  readonly outcome: CompositionCapabilityAuditOutcome;
  readonly errorCode?: string;
};

export type CapabilityGrantRegistryOptions = {
  readonly capabilityRegistry: Pick<CapabilityRegistry.CapabilityRegistry["Service"], "list">;
  readonly now?: () => number;
};

export interface CapabilityGrantRegistryShape {
  readonly issue: (
    input: CapabilityGrantIssueInput,
  ) => Effect.Effect<
    ReadonlyArray<CompositionCapabilityGrant>,
    | CapabilityGrantInvalidError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
  >;
  readonly validate: (
    input: CapabilityGrantValidationInput,
  ) => Effect.Effect<
    CompositionCapabilityGrant,
    | CapabilityGrantNotFoundError
    | CapabilityGrantScopeMismatchError
    | CapabilityGrantExpiredError
    | CapabilityGrantRevokedError
  >;
  readonly revoke: (input: {
    readonly grantId: string;
  }) => Effect.Effect<void, CapabilityGrantNotFoundError>;
  readonly recordAudit: (input: CapabilityGrantAuditInput) => Effect.Effect<void>;
  readonly listAudit: (input: {
    readonly taskId: string;
  }) => Effect.Effect<ReadonlyArray<CompositionCapabilityAuditEvent>>;
}

export class CapabilityGrantRegistry extends Context.Service<
  CapabilityGrantRegistry,
  CapabilityGrantRegistryShape
>()("t3/composition/CapabilityGrantRegistry") {}

export const makeCapabilityGrantRegistry = (
  options: CapabilityGrantRegistryOptions,
): CapabilityGrantRegistryShape => {
  const grants = new Map<string, CompositionCapabilityGrant>();
  const audit = new Map<string, CompositionCapabilityAuditEvent>();
  const now = options.now ?? Date.now;
  let grantSequence = 0;
  let auditSequence = 0;

  const issue: CapabilityGrantRegistryShape["issue"] = Effect.fn("CapabilityGrantRegistry.issue")(
    function* (input) {
      const taskId = input.taskId.trim();
      const agentId = input.agentId.trim();
      const capabilityIds = [...new Set(input.capabilityIds.map((id) => id.trim()))].filter(
        Boolean,
      );
      const ttlMs = input.ttlMs ?? DEFAULT_GRANT_TTL_MS;
      if (taskId.length === 0 || agentId.length === 0 || capabilityIds.length === 0 || ttlMs <= 0) {
        return yield* new CapabilityGrantInvalidError({ reason: "grant_input_invalid" });
      }

      const descriptors = yield* options.capabilityRegistry.list({
        scope: "task",
        scopeId: taskId,
      });
      const descriptorIds = new Set(
        descriptors
          .filter((descriptor) => descriptor.status !== "unavailable")
          .map((descriptor) => descriptor.capabilityId),
      );
      for (const capabilityId of capabilityIds) {
        if (!descriptorIds.has(capabilityId)) {
          return yield* new CapabilityGrantInvalidError({
            reason: `capability_not_available:${capabilityId}`,
          });
        }
      }

      const issuedAtUnixMs = now();
      const expiresAtUnixMs = issuedAtUnixMs + ttlMs;
      const result: CompositionCapabilityGrant[] = [];
      for (const capabilityId of capabilityIds) {
        const existing = [...grants.values()].find(
          (grant) =>
            grant.taskId === taskId &&
            grant.agentId === agentId &&
            grant.capabilityId === capabilityId &&
            grant.revokedAtUnixMs === undefined &&
            grant.expiresAtUnixMs > issuedAtUnixMs,
        );
        if (existing !== undefined) {
          result.push(existing);
          continue;
        }
        grantSequence += 1;
        const grant = {
          grantId: `grant-${grantSequence}`,
          taskId,
          agentId,
          capabilityId,
          issuedAtUnixMs,
          expiresAtUnixMs,
        } satisfies CompositionCapabilityGrant;
        grants.set(grant.grantId, grant);
        result.push(grant);
      }
      return result;
    },
  );

  const validate: CapabilityGrantRegistryShape["validate"] = Effect.fn(
    "CapabilityGrantRegistry.validate",
  )(function* (input) {
    const grant = grants.get(input.grantId);
    if (grant === undefined) {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    if (
      grant.taskId !== input.taskId ||
      grant.agentId !== input.agentId ||
      grant.capabilityId !== input.capabilityId
    ) {
      return yield* new CapabilityGrantScopeMismatchError({ grantId: input.grantId });
    }
    if (grant.revokedAtUnixMs !== undefined) {
      return yield* new CapabilityGrantRevokedError({ grantId: input.grantId });
    }
    if (grant.expiresAtUnixMs <= now()) {
      return yield* new CapabilityGrantExpiredError({ grantId: input.grantId });
    }
    return grant;
  });

  const revoke: CapabilityGrantRegistryShape["revoke"] = Effect.fn(
    "CapabilityGrantRegistry.revoke",
  )(function* (input) {
    const grant = grants.get(input.grantId);
    if (grant === undefined) {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    grants.set(input.grantId, { ...grant, revokedAtUnixMs: now() });
  });

  const recordAudit: CapabilityGrantRegistryShape["recordAudit"] = Effect.fn(
    "CapabilityGrantRegistry.recordAudit",
  )(function* (input) {
    auditSequence += 1;
    const event = {
      auditId: `audit-${auditSequence}`,
      grantId: input.grantId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      operation: input.operation,
      outcome: input.outcome,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      occurredAtUnixMs: now(),
    } satisfies CompositionCapabilityAuditEvent;
    audit.set(event.auditId, event);
  });

  return {
    issue,
    validate,
    revoke,
    recordAudit,
    listAudit: (input) =>
      Effect.succeed([...audit.values()].filter((event) => event.taskId === input.taskId)),
  };
};

const live = Effect.gen(function* () {
  const capabilityRegistry = yield* CapabilityRegistry.CapabilityRegistry;
  return CapabilityGrantRegistry.of(makeCapabilityGrantRegistry({ capabilityRegistry }));
});

export const layer = Layer.effect(CapabilityGrantRegistry, live);
