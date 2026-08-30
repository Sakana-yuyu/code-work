import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type CompositionRunStartRecoveryPolicy = {
  readonly mode: "idempotent-replay" | "reconcile-only" | "manual";
  readonly requiredReceipt: "none" | "runtime-task";
  readonly capabilityGrantReplay?: { readonly mode: "none" | "verified" };
};

export type CompositionRunStartReceipt = {
  readonly runtimeTaskId: string | null;
  readonly capabilityHandshakeId: string | null;
};

export const COMPOSITION_RUN_START_OUTCOME_CODE_MAX_LENGTH = 128;
export const COMPOSITION_RUN_START_OUTCOME_DETAIL_MAX_LENGTH = 1_024;
export const COMPOSITION_RUN_START_RECEIPT_ID_MAX_LENGTH = 1_024;

const OUTCOME_CODE_FALLBACK = "agent_driver_failure";
const OUTCOME_DETAIL_FALLBACK = "Agent Driver 未提供可持久化的错误详情。";

export class CompositionRunStartReceiptError extends Schema.TaggedErrorClass<CompositionRunStartReceiptError>()(
  "CompositionRunStartReceiptError",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Run Start receipt 无效：${this.code}: ${this.detail}`;
  }
}

const digest = (value: unknown): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

const normalizeText = (value: string | undefined): string | null => {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
};

const truncateUtf16 = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  const truncated = value.slice(0, maxLength);
  const finalCodeUnit = truncated.charCodeAt(truncated.length - 1);
  return finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff ? truncated.slice(0, -1) : truncated;
};

const normalizeBoundedText = (value: string, fallback: string, maxLength: number): string => {
  const trimmed = value.trim();
  return truncateUtf16(trimmed.length === 0 ? fallback : trimmed, maxLength);
};

export const normalizeCompositionRunStartRejectedOutcome = (failure: {
  readonly code: string;
  readonly detail: string;
}) => ({
  outcomeCode: normalizeBoundedText(
    failure.code,
    OUTCOME_CODE_FALLBACK,
    COMPOSITION_RUN_START_OUTCOME_CODE_MAX_LENGTH,
  ),
  outcomeDetail: normalizeBoundedText(
    failure.detail,
    OUTCOME_DETAIL_FALLBACK,
    COMPOSITION_RUN_START_OUTCOME_DETAIL_MAX_LENGTH,
  ),
});

export const makeCompositionRunStartDigests = (input: {
  readonly taskId: string;
  readonly runId: string;
  readonly previousRunId: string | null;
  readonly agentId: string;
  readonly runtimeId: string;
  readonly attempt: number;
  readonly promptDigest: string;
  readonly workspaceRootDigest?: string;
  readonly model?: string;
  readonly capabilityIds: ReadonlyArray<string> | null;
}) => {
  const capabilityIds =
    input.capabilityIds === null
      ? null
      : [...new Set(input.capabilityIds.map((id) => id.trim()).filter(Boolean))].sort(
          (left, right) => (left < right ? -1 : left > right ? 1 : 0),
        );
  return {
    payloadDigest: digest({
      schemaVersion: 1,
      taskId: input.taskId,
      runId: input.runId,
      previousRunId: input.previousRunId,
      agentId: input.agentId,
      runtimeId: input.runtimeId,
      attempt: input.attempt,
      promptDigest: input.promptDigest,
      workspaceRootDigest: normalizeText(input.workspaceRootDigest),
      model: normalizeText(input.model),
    }),
    capabilityDigest: digest({ schemaVersion: 1, capabilityIds }),
  } as const;
};

export const validateCompositionRunStartReceipt = (input: {
  readonly policy: CompositionRunStartRecoveryPolicy;
  readonly startResult: {
    readonly runtimeTaskId?: string;
    readonly capabilityHandshakeId?: string;
  };
  readonly capabilityGrantIds: ReadonlyArray<string>;
}): Effect.Effect<CompositionRunStartReceipt, CompositionRunStartReceiptError> => {
  const runtimeTaskId = normalizeText(input.startResult.runtimeTaskId);
  const capabilityHandshakeId = normalizeText(input.startResult.capabilityHandshakeId);
  if (
    runtimeTaskId !== null &&
    runtimeTaskId.length > COMPOSITION_RUN_START_RECEIPT_ID_MAX_LENGTH
  ) {
    return Effect.fail(
      new CompositionRunStartReceiptError({
        code: "run_start_runtime_task_receipt_invalid",
        detail: "Driver 返回的 runtimeTaskId 超过持久化长度上限。",
      }),
    );
  }
  if (
    capabilityHandshakeId !== null &&
    capabilityHandshakeId.length > COMPOSITION_RUN_START_RECEIPT_ID_MAX_LENGTH
  ) {
    return Effect.fail(
      new CompositionRunStartReceiptError({
        code: "run_start_capability_handshake_receipt_invalid",
        detail: "Driver 返回的 capabilityHandshakeId 超过持久化长度上限。",
      }),
    );
  }
  if (input.policy.requiredReceipt === "runtime-task" && runtimeTaskId === null) {
    return Effect.fail(
      new CompositionRunStartReceiptError({
        code: "run_start_runtime_task_receipt_missing",
        detail: "Driver 未返回策略要求的 runtimeTaskId，不能确认外部启动归属。",
      }),
    );
  }
  if (
    input.policy.capabilityGrantReplay?.mode === "verified" &&
    input.capabilityGrantIds.length > 0 &&
    capabilityHandshakeId === null
  ) {
    return Effect.fail(
      new CompositionRunStartReceiptError({
        code: "run_start_capability_handshake_receipt_missing",
        detail: "Driver 未返回已验证 capability grant 对应的 handshake receipt。",
      }),
    );
  }
  return Effect.succeed({ runtimeTaskId, capabilityHandshakeId });
};
