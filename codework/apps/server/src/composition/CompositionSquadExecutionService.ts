import type {
  CompositionSquadExecution,
  CompositionSquadExecutionListRequest,
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
}

export class CompositionSquadExecutionService extends Context.Service<
  CompositionSquadExecutionService,
  CompositionSquadExecutionServiceShape
>()("codework/composition/CompositionSquadExecutionService") {}

export interface CompositionSquadExecutionServiceOptions {
  readonly store: Pick<CompositionSquadExecutionStoreShape, "listExecutions">;
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

const toStoreListInput = (
  request: CompositionSquadExecutionListRequest,
): CompositionSquadExecutionListInput => ({
  ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
  ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
  ...(request.squadId === undefined ? {} : { squadId: request.squadId }),
  ...(request.statuses === undefined ? {} : { statuses: request.statuses }),
  limit: request.limit ?? COMPOSITION_SQUAD_EXECUTION_HISTORY_DEFAULT_LIMIT,
});

export const makeCompositionSquadExecutionService = (
  options: CompositionSquadExecutionServiceOptions,
): CompositionSquadExecutionServiceShape => ({
  list: (request = {}) =>
    options.store.listExecutions(toStoreListInput(request)).pipe(Effect.mapError(listError)),
});

const live = Effect.gen(function* () {
  const store = yield* CompositionSquadExecutionStore;
  return makeCompositionSquadExecutionService({ store });
});

export const CompositionSquadExecutionServiceLive = Layer.effect(
  CompositionSquadExecutionService,
  live,
);
