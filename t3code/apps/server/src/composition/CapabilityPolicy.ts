import type {
  CompositionCapabilityPolicyDecision,
  CompositionCapabilityDescriptor,
} from "@t3tools/contracts";
import { ApprovalRequestId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

export const CapabilityPolicyInput = Schema.Struct({
  taskId: Schema.String,
  agentId: Schema.String,
  capabilityId: Schema.String,
  capabilityGrantIds: Schema.Array(Schema.String),
  operation: Schema.Literals(["read", "execute", "mutate"]),
  approvalRequestId: Schema.optional(Schema.String),
});
export type CapabilityPolicyInput = typeof CapabilityPolicyInput.Type;

export class CapabilityNotGrantedError extends Schema.TaggedErrorClass<CapabilityNotGrantedError>()(
  "CapabilityNotGrantedError",
  { capabilityId: Schema.String },
) {
  override get message(): string {
    return `Capability '${this.capabilityId}' was not granted to this task.`;
  }
}

export class CapabilityPolicyInvalidError extends Schema.TaggedErrorClass<CapabilityPolicyInvalidError>()(
  "CapabilityPolicyInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Capability policy is invalid: ${this.reason}`;
  }
}

export class ApprovalRequestNotFoundError extends Schema.TaggedErrorClass<ApprovalRequestNotFoundError>()(
  "ApprovalRequestNotFoundError",
  { approvalRequestId: Schema.String },
) {
  override get message(): string {
    return `Approval request '${this.approvalRequestId}' was not found.`;
  }
}

export type CompositionCapabilityPolicyOptions = {
  readonly capabilityRegistry: Pick<CapabilityRegistry.CapabilityRegistry["Service"], "list">;
  readonly grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "validate">;
};

type ApprovalState = {
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityId: string;
  approved: boolean;
};

export class CapabilityPolicy extends Context.Service<
  CapabilityPolicy,
  {
    readonly evaluate: (
      input: CapabilityPolicyInput,
    ) => Effect.Effect<
      CompositionCapabilityPolicyDecision,
      | CapabilityNotGrantedError
      | CapabilityPolicyInvalidError
      | CapabilityRegistry.CapabilityScopeNotFoundError
      | CapabilityRegistry.CapabilityRegistryUnavailableError
      | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    >;
    readonly approve: (input: {
      readonly approvalRequestId: string;
    }) => Effect.Effect<void, ApprovalRequestNotFoundError>;
    readonly cancel: (input: { readonly idempotencyKey: string }) => Effect.Effect<void>;
    readonly isCancelled: (idempotencyKey: string) => boolean;
  }
>()("t3/composition/CapabilityPolicy") {}

export const makeCompositionCapabilityPolicy = (
  options: CompositionCapabilityPolicyOptions,
): CapabilityPolicy["Service"] => {
  const registry = options.capabilityRegistry;
  const approvals = new Map<string, ApprovalState>();
  const cancelled = new Set<string>();
  let approvalSequence = 0;

  const findCapability = (
    descriptors: readonly CompositionCapabilityDescriptor[],
    capabilityId: string,
  ) => descriptors.find((descriptor) => descriptor.capabilityId === capabilityId);

  const evaluate: CapabilityPolicy["Service"]["evaluate"] = Effect.fn("CapabilityPolicy.evaluate")(
    function* (input) {
      if (input.taskId.trim().length === 0 || input.agentId.trim().length === 0) {
        return yield* new CapabilityPolicyInvalidError({
          reason: "task_or_agent_identity_missing",
        });
      }
      const descriptors = yield* registry.list({ scope: "task", scopeId: input.taskId });
      const capability = findCapability(descriptors, input.capabilityId);
      if (!capability || capability.status === "unavailable") {
        return yield* new CapabilityNotGrantedError({ capabilityId: input.capabilityId });
      }
      if (!capability.grants[input.operation]) {
        return yield* new CapabilityNotGrantedError({ capabilityId: input.capabilityId });
      }

      const legacyGrant = input.capabilityGrantIds.includes(input.capabilityId);
      let validGrantExpiresAtUnixMs: number | undefined;
      if (!legacyGrant && options.grantRegistry !== undefined) {
        for (const grantId of input.capabilityGrantIds) {
          const grant = yield* options.grantRegistry
            .validate({
              grantId,
              taskId: input.taskId,
              agentId: input.agentId,
              capabilityId: input.capabilityId,
            })
            .pipe(
              Effect.catchTags({
                CapabilityGrantNotFoundError: () => Effect.succeed(undefined),
                CapabilityGrantScopeMismatchError: () => Effect.succeed(undefined),
                CapabilityGrantExpiredError: () => Effect.succeed(undefined),
                CapabilityGrantRevokedError: () => Effect.succeed(undefined),
              }),
            );
          if (grant !== undefined) {
            validGrantExpiresAtUnixMs = grant.expiresAtUnixMs;
            break;
          }
        }
      }
      if (!legacyGrant && validGrantExpiresAtUnixMs === undefined) {
        return yield* new CapabilityNotGrantedError({ capabilityId: input.capabilityId });
      }

      if (capability.approval === "never") {
        return {
          decision: "allow",
          reasonCode: legacyGrant ? "legacy_capability_grant" : "capability_granted",
          ...(validGrantExpiresAtUnixMs === undefined
            ? {}
            : { expiresAtUnixMs: validGrantExpiresAtUnixMs }),
        };
      }

      if (input.approvalRequestId) {
        const approval = approvals.get(input.approvalRequestId);
        if (!approval) {
          return yield* new CapabilityPolicyInvalidError({ reason: "approval_request_not_found" });
        }
        if (
          approval.taskId !== input.taskId ||
          approval.agentId !== input.agentId ||
          approval.capabilityId !== input.capabilityId
        ) {
          return yield* new CapabilityPolicyInvalidError({ reason: "approval_scope_mismatch" });
        }
        if (approval.approved) {
          approvals.delete(input.approvalRequestId);
          return { decision: "allow", reasonCode: "approval_granted" };
        }
      }

      approvalSequence += 1;
      const approvalRequestId = yield* Schema.decodeUnknownEffect(ApprovalRequestId)(
        `approval-${approvalSequence}`,
      ).pipe(
        Effect.mapError(
          () => new CapabilityPolicyInvalidError({ reason: "approval_request_id_invalid" }),
        ),
      );
      approvals.set(approvalRequestId, {
        taskId: input.taskId,
        agentId: input.agentId,
        capabilityId: input.capabilityId,
        approved: false,
      });
      return {
        decision: "approval_required",
        reasonCode: "destructive_capability_requires_approval",
        approvalRequestId,
        ...(validGrantExpiresAtUnixMs === undefined
          ? {}
          : { expiresAtUnixMs: validGrantExpiresAtUnixMs }),
      };
    },
  );

  const approve: CapabilityPolicy["Service"]["approve"] = Effect.fn("CapabilityPolicy.approve")(
    function* (input) {
      const approval = approvals.get(input.approvalRequestId);
      if (!approval) {
        return yield* new ApprovalRequestNotFoundError(input);
      }
      approvals.set(input.approvalRequestId, { ...approval, approved: true });
    },
  );

  const cancel: CapabilityPolicy["Service"]["cancel"] = Effect.fn("CapabilityPolicy.cancel")(
    function* (input) {
      cancelled.add(input.idempotencyKey);
    },
  );

  return CapabilityPolicy.of({
    evaluate,
    approve,
    cancel,
    isCancelled: (idempotencyKey) => cancelled.has(idempotencyKey),
  });
};

const make = Effect.gen(function* () {
  const registry = yield* CapabilityRegistry.CapabilityRegistry;
  const grantRegistry = yield* Effect.serviceOption(
    CapabilityGrantRegistry.CapabilityGrantRegistry,
  );
  return makeCompositionCapabilityPolicy({
    capabilityRegistry: registry,
    ...(Option.isSome(grantRegistry) ? { grantRegistry: grantRegistry.value } : {}),
  });
});

export const layer = Layer.effect(CapabilityPolicy, make);
