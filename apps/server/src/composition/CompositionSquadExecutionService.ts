import {
  COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT,
  type CompositionSquadExecution,
  type CompositionSquadExecutionListRequest,
  type CompositionSquadExecutionSummary,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CompositionSquadExecutionStore,
  type CompositionSquadExecutionListInput,
  type CompositionSquadExecutionStoreError,
  type CompositionSquadExecutionStoreShape,
} from "../persistence/Services/CompositionSquadExecutionStore.ts";
import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

export const COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT = 50;

export const CompositionSquadExecutionServiceErrorCode = Schema.Literals([
  "squad_execution_list_limit_invalid",
  "squad_execution_persistence_failed",
]);
export type CompositionSquadExecutionServiceErrorCode =
  typeof CompositionSquadExecutionServiceErrorCode.Type;

export class CompositionSquadExecutionServiceError extends Schema.TaggedErrorClass<CompositionSquadExecutionServiceError>()(
  "CompositionSquadExecutionServiceError",
  {
    code: CompositionSquadExecutionServiceErrorCode,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Squad execution 查询失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionSquadExecutionServiceShape {
  readonly list: (
    request?: CompositionSquadExecutionListRequest,
  ) => Effect.Effect<
    ReadonlyArray<CompositionSquadExecution>,
    CompositionSquadExecutionServiceError
  >;
  readonly listSummaries: (
    request?: CompositionSquadExecutionListRequest,
  ) => Effect.Effect<
    ReadonlyArray<CompositionSquadExecutionSummary>,
    CompositionSquadExecutionServiceError
  >;
}

export class CompositionSquadExecutionService extends Context.Service<
  CompositionSquadExecutionService,
  CompositionSquadExecutionServiceShape
>()("codework/composition/CompositionSquadExecutionService") {}

export interface CompositionSquadExecutionServiceOptions {
  readonly store: Pick<CompositionSquadExecutionStoreShape, "listExecutions">;
  readonly squadStore: Pick<CompositionTaskStoreShape, "listSquads">;
}

const listError = (
  cause: CompositionSquadExecutionStoreError,
): CompositionSquadExecutionServiceError =>
  cause._tag === "CompositionSquadExecutionStoreDomainError" &&
  cause.code === "squad_execution_list_limit_invalid"
    ? new CompositionSquadExecutionServiceError({
        code: "squad_execution_list_limit_invalid",
        detail: "Squad execution 历史查询数量无效。",
      })
    : new CompositionSquadExecutionServiceError({
        code: "squad_execution_persistence_failed",
        detail: "列出 Squad execution 历史失败。",
      });

const squadListError = (_cause: CompositionTaskStoreError): CompositionSquadExecutionServiceError =>
  new CompositionSquadExecutionServiceError({
    code: "squad_execution_persistence_failed",
    detail: "读取 Squad 显示名称失败。",
  });

const toStoreListInput = (
  request: CompositionSquadExecutionListRequest,
): CompositionSquadExecutionListInput => ({
  ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
  ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
  ...(request.squadId === undefined ? {} : { squadId: request.squadId }),
  ...(request.statuses === undefined ? {} : { statuses: request.statuses }),
  limit: request.limit ?? COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT,
});

const toSummaryStoreListInput = (
  request: CompositionSquadExecutionListRequest,
): CompositionSquadExecutionListInput => {
  const input = toStoreListInput(request);
  return {
    ...input,
    limit: Math.min(input.limit, COMPOSITION_SQUAD_EXECUTION_HISTORY_MAX_LIMIT),
  };
};

const toSummary = (
  execution: CompositionSquadExecution,
  squadDisplayNamesById: ReadonlyMap<string, string>,
): CompositionSquadExecutionSummary => ({
  executionId: execution.executionId,
  squadId: execution.squadId,
  squadDisplayName: squadDisplayNamesById.get(execution.squadId) ?? execution.squadId,
  projectId: execution.projectId,
  status: execution.status,
  squadRevision: execution.squadRevision,
  nodeCount: execution.nodes?.length ?? 0,
  pendingApprovalCount: execution.pendingApprovals.length,
  createdAtUnixMs: execution.createdAtUnixMs,
  ...(execution.resultSummary === undefined ? {} : { resultSummary: execution.resultSummary }),
  ...(execution.failureCode === undefined ? {} : { failureCode: execution.failureCode }),
});

export const makeCompositionSquadExecutionService = (
  options: CompositionSquadExecutionServiceOptions,
): CompositionSquadExecutionServiceShape => {
  const list: CompositionSquadExecutionServiceShape["list"] = (request = {}) =>
    options.store.listExecutions(toStoreListInput(request)).pipe(Effect.mapError(listError));

  const listSummaries: CompositionSquadExecutionServiceShape["listSummaries"] = (request = {}) =>
    Effect.gen(function* () {
      const executions = yield* options.store
        .listExecutions(toSummaryStoreListInput(request))
        .pipe(Effect.mapError(listError));
      if (executions.length === 0) return [];

      const squads = yield* options.squadStore
        .listSquads({ includeArchived: true })
        .pipe(Effect.mapError(squadListError));
      const squadDisplayNamesById = new Map(
        squads.map((squad) => [squad.squadId, squad.name] as const),
      );
      return executions.map((execution) => toSummary(execution, squadDisplayNamesById));
    });

  return { list, listSummaries };
};

const live = Effect.gen(function* () {
  const store = yield* CompositionSquadExecutionStore;
  const squadStore = yield* CompositionTaskStore;
  return makeCompositionSquadExecutionService({ store, squadStore });
});

export const CompositionSquadExecutionServiceLive = Layer.effect(
  CompositionSquadExecutionService,
  live,
);
