import { CompositionAutomationRpcError } from "@codework/contracts";
import * as Schema from "effect/Schema";

const isCompositionAutomationRpcError = Schema.is(CompositionAutomationRpcError);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** 将 Automation 生命周期、执行和持久化错误收敛为稳定的 typed RPC 错误。 */
export const toCompositionAutomationRpcError = (
  error: unknown,
  fallbackAutomationId: string,
): CompositionAutomationRpcError => {
  if (isCompositionAutomationRpcError(error)) return error;

  const tagged =
    typeof error === "object" && error !== null
      ? (error as {
          readonly code?: unknown;
          readonly detail?: unknown;
          readonly message?: unknown;
          readonly automationId?: unknown;
          readonly automationRunId?: unknown;
          readonly expectedRevision?: unknown;
          readonly actualRevision?: unknown;
        })
      : undefined;
  const automationRunId = nonEmptyString(tagged?.automationRunId);
  const expectedRevision = positiveInteger(tagged?.expectedRevision);
  const actualRevision = nonNegativeInteger(tagged?.actualRevision);

  return new CompositionAutomationRpcError({
    code: nonEmptyString(tagged?.code) ?? "composition_automation_failed",
    detail:
      nonEmptyString(tagged?.detail) ??
      nonEmptyString(tagged?.message) ??
      (error instanceof Error ? error.message : String(error)),
    automationId:
      nonEmptyString(tagged?.automationId) ?? nonEmptyString(fallbackAutomationId) ?? "unknown",
    ...(automationRunId === undefined ? {} : { automationRunId }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision }),
  });
};
