import { CompositionSquadRpcError } from "@codework/contracts";
import * as Schema from "effect/Schema";

const isCompositionSquadRpcError = Schema.is(CompositionSquadRpcError);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** 将生命周期和 Runner 内部错误收敛为稳定的 typed RPC 错误。 */
export const toCompositionSquadRpcError = (
  error: unknown,
  fallbackSquadId: string,
): CompositionSquadRpcError => {
  if (isCompositionSquadRpcError(error)) return error;

  const tagged =
    typeof error === "object" && error !== null
      ? (error as {
          readonly code?: unknown;
          readonly detail?: unknown;
          readonly message?: unknown;
          readonly squadId?: unknown;
          readonly nodeId?: unknown;
          readonly expectedRevision?: unknown;
          readonly actualRevision?: unknown;
        })
      : undefined;
  const expectedRevision = positiveInteger(tagged?.expectedRevision);
  const actualRevision = nonNegativeInteger(tagged?.actualRevision);
  const nodeId = nonEmptyString(tagged?.nodeId);

  return new CompositionSquadRpcError({
    code: nonEmptyString(tagged?.code) ?? "composition_squad_failed",
    detail:
      nonEmptyString(tagged?.detail) ??
      nonEmptyString(tagged?.message) ??
      (error instanceof Error ? error.message : String(error)),
    squadId: nonEmptyString(tagged?.squadId) ?? nonEmptyString(fallbackSquadId) ?? "unknown",
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision }),
  });
};
