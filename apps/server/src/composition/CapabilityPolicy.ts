import type {
  CompositionCapabilityPolicyDecision,
  CompositionCapabilityDescriptor,
} from "@codework/contracts";
import { ApprovalRequestId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";

import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";

export const CapabilityPolicyInput = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  agentId: Schema.String,
  capabilityId: Schema.String,
  capabilityGrantIds: Schema.Array(Schema.String),
  operation: Schema.Literals(["read", "execute", "mutate"]),
  idempotencyKey: Schema.String,
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
  readonly grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "validate"> &
    Partial<
      Pick<
        CapabilityGrantRegistry.CapabilityGrantRegistryShape,
        "getAuditById" | "recordAuditIfNew"
      >
    >;
};

type ApprovalState = {
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityId: string;
  readonly operation: CapabilityPolicyInput["operation"];
  readonly idempotencyKey: string;
  approved: boolean;
};

const approvalRequestIdFor = (input: CapabilityPolicyInput): string => {
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.taskId,
        input.runId,
        input.agentId,
        input.capabilityId,
        input.operation,
        input.idempotencyKey,
      ]),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `approval-${digest}`;
};

const approvalAuditId = (
  phase: "requested" | "approved" | "consumed",
  approvalRequestId: string,
): string => {
  const order = phase === "requested" ? 1 : phase === "approved" ? 2 : 3;
  return `capability-approval:${approvalRequestId}:${order}-${phase}`;
};

const decodeApprovalRequestId = Schema.decodeUnknownEffect(ApprovalRequestId);

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
    }) => Effect.Effect<
      void,
      ApprovalRequestNotFoundError | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    >;
    readonly cancel: (input: { readonly idempotencyKey: string }) => Effect.Effect<void>;
    readonly isCancelled: (idempotencyKey: string) => boolean;
  }
>()("codework/composition/CapabilityPolicy") {}

export const makeCompositionCapabilityPolicy = (
  options: CompositionCapabilityPolicyOptions,
): CapabilityPolicy["Service"] => {
  const registry = options.capabilityRegistry;
  const approvals = new Map<string, ApprovalState>();
  const cancelled = new Set<string>();
  const approvalLedger =
    options.grantRegistry?.getAuditById === undefined ||
    options.grantRegistry.recordAuditIfNew === undefined
      ? undefined
      : {
          getAuditById: options.grantRegistry.getAuditById,
          recordAuditIfNew: options.grantRegistry.recordAuditIfNew,
        };

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
      let validGrantId: string | undefined;
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
            validGrantId = grant.grantId;
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

      const approvalRequestId = yield* decodeApprovalRequestId(approvalRequestIdFor(input)).pipe(
        Effect.mapError(
          () => new CapabilityPolicyInvalidError({ reason: "approval_request_id_invalid" }),
        ),
      );
      if (input.approvalRequestId !== undefined && input.approvalRequestId !== approvalRequestId) {
        return yield* new CapabilityPolicyInvalidError({ reason: "approval_scope_mismatch" });
      }

      const approvalGrantId = legacyGrant
        ? `legacy:${input.capabilityId}`
        : (validGrantId ?? input.capabilityGrantIds[0]);
      if (approvalGrantId === undefined) {
        return yield* new CapabilityPolicyInvalidError({ reason: "approval_grant_missing" });
      }

      if (approvalLedger !== undefined) {
        const requestedAuditId = approvalAuditId("requested", approvalRequestId);
        const approvedAuditId = approvalAuditId("approved", approvalRequestId);
        const consumedAuditId = approvalAuditId("consumed", approvalRequestId);
        const requested = yield* approvalLedger.getAuditById({ auditId: requestedAuditId });
        const consumed = yield* approvalLedger.getAuditById({ auditId: consumedAuditId });

        if (input.approvalRequestId !== undefined) {
          if (Option.isNone(requested)) {
            return yield* new CapabilityPolicyInvalidError({
              reason: "approval_request_not_found",
            });
          }
          const request = requested.value;
          if (
            request.taskId !== input.taskId ||
            request.runId !== input.runId ||
            request.agentId !== input.agentId ||
            request.capabilityId !== input.capabilityId ||
            request.operation !== input.operation ||
            request.grantId !== approvalGrantId
          ) {
            return yield* new CapabilityPolicyInvalidError({ reason: "approval_scope_mismatch" });
          }
          if (Option.isSome(consumed)) {
            return yield* new CapabilityPolicyInvalidError({
              reason: "approval_request_consumed",
            });
          }
          const approved = yield* approvalLedger.getAuditById({ auditId: approvedAuditId });
          if (Option.isSome(approved)) {
            const consumedNow = yield* approvalLedger.recordAuditIfNew({
              auditId: consumedAuditId,
              grantId: approvalGrantId,
              taskId: input.taskId,
              runId: input.runId,
              agentId: input.agentId,
              capabilityId: input.capabilityId,
              operation: input.operation,
              outcome: "allowed",
              errorCode: "capability_approval_consumed",
            });
            if (!consumedNow) {
              return yield* new CapabilityPolicyInvalidError({
                reason: "approval_request_consumed",
              });
            }
            return { decision: "allow", reasonCode: "approval_granted" };
          }
        } else if (Option.isSome(consumed)) {
          return { decision: "deny", reasonCode: "approval_request_consumed" };
        }

        yield* approvalLedger.recordAuditIfNew({
          auditId: requestedAuditId,
          grantId: approvalGrantId,
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          capabilityId: input.capabilityId,
          operation: input.operation,
          outcome: "approval_required",
          errorCode: "capability_approval_requested",
        });
        return {
          decision: "approval_required",
          reasonCode: "destructive_capability_requires_approval",
          approvalRequestId,
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
          approval.runId !== input.runId ||
          approval.agentId !== input.agentId ||
          approval.capabilityId !== input.capabilityId ||
          approval.operation !== input.operation ||
          approval.idempotencyKey !== input.idempotencyKey
        ) {
          return yield* new CapabilityPolicyInvalidError({ reason: "approval_scope_mismatch" });
        }
        if (approval.approved) {
          approvals.delete(input.approvalRequestId);
          return { decision: "allow", reasonCode: "approval_granted" };
        }
      }
      if (!approvals.has(approvalRequestId)) {
        approvals.set(approvalRequestId, {
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          capabilityId: input.capabilityId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          approved: false,
        });
      }
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
      if (approvalLedger !== undefined) {
        const requested = yield* approvalLedger.getAuditById({
          auditId: approvalAuditId("requested", input.approvalRequestId),
        });
        if (Option.isNone(requested)) {
          return yield* new ApprovalRequestNotFoundError(input);
        }
        const request = requested.value;
        yield* approvalLedger.recordAuditIfNew({
          auditId: approvalAuditId("approved", input.approvalRequestId),
          grantId: request.grantId,
          taskId: request.taskId,
          runId: request.runId,
          agentId: request.agentId,
          capabilityId: request.capabilityId,
          operation: request.operation,
          outcome: "allowed",
          errorCode: "capability_approval_approved",
        });
        return;
      }
      const approval = approvals.get(input.approvalRequestId);
      if (!approval) {
        return yield* new ApprovalRequestNotFoundError(input);
      }
      approvals.set(input.approvalRequestId, { ...approval, approved: true });
    },
  );

  const cancel: CapabilityPolicy["Service"]["cancel"] = Effect.fn("CapabilityPolicy.cancel")(
    (input) => Effect.sync(() => void cancelled.add(input.idempotencyKey)),
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
