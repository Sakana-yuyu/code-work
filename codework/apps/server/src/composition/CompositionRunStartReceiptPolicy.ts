import type {
  CompositionAgentDriverStartRecoveryPolicy,
  CompositionAgentDriverStartReceiptRequirement,
} from "./CompositionOrchestrator.ts";
import type { CompositionRunStartReceipt } from "./CompositionRunStartLifecycle.ts";

export type CompositionRunStartReceiptPolicyErrorCode =
  | "driver_start_recovery_policy_missing"
  | "run_start_runtime_task_receipt_missing"
  | "run_start_capability_handshake_receipt_missing";

const hasReceiptValue = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0;

const requiresCapabilityHandshake = (
  requirement: CompositionAgentDriverStartReceiptRequirement,
  capabilityGrantIds: ReadonlyArray<string>,
): boolean =>
  requirement === "runtime-task-and-handshake" ||
  (requirement === "runtime-task-and-handshake-when-granted" && capabilityGrantIds.length > 0);

export const validateCompositionRunStartReceipt = (input: {
  readonly policy: CompositionAgentDriverStartRecoveryPolicy | undefined;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly receipt: CompositionRunStartReceipt;
}): CompositionRunStartReceiptPolicyErrorCode | undefined => {
  if (input.policy === undefined) return "driver_start_recovery_policy_missing";
  if (!hasReceiptValue(input.receipt.runtimeTaskId)) {
    return "run_start_runtime_task_receipt_missing";
  }
  if (
    requiresCapabilityHandshake(input.policy.requiredReceipt, input.capabilityGrantIds) &&
    !hasReceiptValue(input.receipt.capabilityHandshakeId)
  ) {
    return "run_start_capability_handshake_receipt_missing";
  }
  return undefined;
};
