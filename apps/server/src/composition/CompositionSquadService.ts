import {
  CompositionSquad as CompositionSquadSchema,
  type CompositionSquad,
  type CompositionSquadApprovalStage,
  type CompositionSquadCollaborationMode,
  type CompositionSquadFailurePolicy,
  type CompositionSquadMember,
  type CompositionSquadPartialSuccessPolicy,
  type CompositionSquadRevision,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CompositionTaskStore,
  type CompositionTaskStoreError,
  type CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";

const decodeCompositionSquad = Schema.decodeUnknownEffect(CompositionSquadSchema);

export interface CompositionSquadCreateInput {
  readonly squadId: string;
  readonly name: string;
  readonly leaderAgentId: string;
  readonly instructions?: string;
  readonly collaborationMode: CompositionSquadCollaborationMode;
  readonly members: ReadonlyArray<CompositionSquadMember>;
  readonly maxConcurrency: number;
  readonly maxRetries?: number;
  readonly failurePolicy: CompositionSquadFailurePolicy;
  readonly partialSuccessPolicy: CompositionSquadPartialSuccessPolicy;
  readonly approvalStages?: ReadonlyArray<CompositionSquadApprovalStage>;
}

export type CompositionSquadUpdateInput = CompositionSquadCreateInput & {
  readonly expectedRevision: number;
};

export interface CompositionSquadDuplicateInput {
  readonly sourceSquadId: string;
  readonly squadId: string;
  readonly name: string;
}

export interface CompositionSquadRevisionInput {
  readonly squadId: string;
  readonly expectedRevision: number;
}

export type CompositionSquadServiceErrorCode =
  | "squad_not_found"
  | "squad_already_exists"
  | "squad_archived"
  | "squad_already_archived"
  | "squad_not_archived"
  | "squad_revision_conflict"
  | "squad_revision_not_found"
  | "squad_revision_unavailable"
  | "squad_validation_failed"
  | "squad_persistence_failed";

export class CompositionSquadServiceError extends Schema.TaggedErrorClass<CompositionSquadServiceError>()(
  "CompositionSquadServiceError",
  {
    code: Schema.String,
    squadId: Schema.String,
    detail: Schema.String,
    expectedRevision: Schema.optional(Schema.Number),
    actualRevision: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Squad 服务失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionSquadServiceShape {
  readonly create: (
    input: CompositionSquadCreateInput,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly update: (
    input: CompositionSquadUpdateInput,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly duplicate: (
    input: CompositionSquadDuplicateInput,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly archive: (
    input: CompositionSquadRevisionInput,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly restore: (
    input: CompositionSquadRevisionInput,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly get: (squadId: string) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly getRunnable: (
    squadId: string,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly getRevision: (
    squadId: string,
    revision: number,
  ) => Effect.Effect<CompositionSquad, CompositionSquadServiceError>;
  readonly list: (options?: {
    readonly includeArchived?: boolean;
  }) => Effect.Effect<ReadonlyArray<CompositionSquad>, CompositionSquadServiceError>;
  readonly listRevisions: (
    squadId: string,
  ) => Effect.Effect<ReadonlyArray<CompositionSquadRevision>, CompositionSquadServiceError>;
}

export class CompositionSquadService extends Context.Service<
  CompositionSquadService,
  CompositionSquadServiceShape
>()("codework/composition/CompositionSquadService") {}

export interface CompositionSquadServiceOptions {
  readonly store: CompositionTaskStoreShape;
  readonly now?: () => number;
}

const revisionOf = (squad: CompositionSquad): number => squad.revision ?? 1;

const persistenceError = (
  operation: string,
  squadId: string,
  cause: CompositionTaskStoreError,
): CompositionSquadServiceError =>
  new CompositionSquadServiceError({
    code: "squad_persistence_failed",
    squadId,
    detail: `${operation} 失败：${cause.message}`,
  });

const serviceError = (
  code: CompositionSquadServiceErrorCode,
  squadId: string,
  detail: string,
  revisions?: { readonly expectedRevision?: number; readonly actualRevision?: number },
): CompositionSquadServiceError =>
  new CompositionSquadServiceError({
    code,
    squadId,
    detail,
    ...(revisions === undefined ? {} : revisions),
  });

const buildSquad = (
  input: CompositionSquadCreateInput,
  metadata: {
    readonly revision: number;
    readonly createdAtUnixMs: number;
    readonly updatedAtUnixMs: number;
    readonly archivedAtUnixMs?: number;
  },
): CompositionSquad => ({
  squadId: input.squadId,
  name: input.name,
  leaderAgentId: input.leaderAgentId,
  memberAgentIds: input.members.map((member) => member.agentId),
  ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
  revision: metadata.revision,
  collaborationMode: input.collaborationMode,
  members: input.members,
  maxConcurrency: input.maxConcurrency,
  ...(input.maxRetries === undefined ? {} : { maxRetries: input.maxRetries }),
  failurePolicy: input.failurePolicy,
  partialSuccessPolicy: input.partialSuccessPolicy,
  ...(input.approvalStages === undefined ? {} : { approvalStages: input.approvalStages }),
  createdAtUnixMs: metadata.createdAtUnixMs,
  updatedAtUnixMs: metadata.updatedAtUnixMs,
  ...(metadata.archivedAtUnixMs === undefined
    ? {}
    : { archivedAtUnixMs: metadata.archivedAtUnixMs }),
});

const normalizeStoredConfiguration = (squad: CompositionSquad): CompositionSquadCreateInput => {
  if (
    squad.collaborationMode !== undefined &&
    squad.members !== undefined &&
    squad.maxConcurrency !== undefined &&
    squad.failurePolicy !== undefined &&
    squad.partialSuccessPolicy !== undefined
  ) {
    return {
      squadId: squad.squadId,
      name: squad.name,
      leaderAgentId: squad.leaderAgentId,
      ...(squad.instructions === undefined ? {} : { instructions: squad.instructions }),
      collaborationMode: squad.collaborationMode,
      members: squad.members,
      maxConcurrency: squad.maxConcurrency,
      ...(squad.maxRetries === undefined ? {} : { maxRetries: squad.maxRetries }),
      failurePolicy: squad.failurePolicy,
      partialSuccessPolicy: squad.partialSuccessPolicy,
      ...(squad.approvalStages === undefined ? {} : { approvalStages: squad.approvalStages }),
    };
  }

  const memberAgentIds = [
    squad.leaderAgentId,
    ...squad.memberAgentIds.filter((agentId) => agentId !== squad.leaderAgentId),
  ];
  return {
    squadId: squad.squadId,
    name: squad.name,
    leaderAgentId: squad.leaderAgentId,
    ...(squad.instructions === undefined ? {} : { instructions: squad.instructions }),
    collaborationMode: "serial",
    members: memberAgentIds.map((agentId, order) => ({
      agentId,
      role: agentId === squad.leaderAgentId ? "leader" : "worker",
      order,
      required: true,
      capabilityIds: [],
      maxConcurrentTasks: 1,
    })),
    maxConcurrency: memberAgentIds.length,
    maxRetries: 0,
    failurePolicy: "fail_fast",
    partialSuccessPolicy: "reject",
    approvalStages: [],
  };
};

export const makeCompositionSquadService = (
  options: CompositionSquadServiceOptions,
): CompositionSquadServiceShape => {
  const currentTimeMillis =
    options.now === undefined ? Clock.currentTimeMillis : Effect.sync(options.now);

  const getOption = (operation: string, squadId: string) =>
    options.store
      .getSquad(squadId)
      .pipe(Effect.mapError((cause) => persistenceError(operation, squadId, cause)));

  const get = Effect.fn("CompositionSquadService.get")(function* (squadId: string) {
    const squad = yield* getOption("读取 Squad", squadId);
    if (Option.isNone(squad)) {
      return yield* serviceError("squad_not_found", squadId, "Squad 不存在。");
    }
    return squad.value;
  });

  const validate = (squad: CompositionSquad) =>
    decodeCompositionSquad(squad).pipe(
      Effect.mapError((cause) =>
        serviceError("squad_validation_failed", squad.squadId, cause.message),
      ),
    );

  const saveNextRevision = Effect.fn("CompositionSquadService.saveNextRevision")(function* (
    operation: string,
    expectedRevision: number,
    squad: CompositionSquad,
  ) {
    return yield* options.store.upsertSquad(squad).pipe(
      Effect.mapError((cause) => persistenceError(operation, squad.squadId, cause)),
      Effect.catch((writeError) =>
        getOption(operation, squad.squadId).pipe(
          Effect.flatMap((latest) => {
            const actualRevision = Option.isSome(latest) ? revisionOf(latest.value) : 0;
            return actualRevision !== expectedRevision
              ? serviceError(
                  "squad_revision_conflict",
                  squad.squadId,
                  `预期 revision ${expectedRevision}，实际为 ${actualRevision}。`,
                  { expectedRevision, actualRevision },
                )
              : writeError;
          }),
        ),
      ),
    );
  });

  const create = Effect.fn("CompositionSquadService.create")(function* (
    input: CompositionSquadCreateInput,
  ) {
    const existing = yield* getOption("创建 Squad", input.squadId);
    if (Option.isSome(existing)) {
      return yield* serviceError("squad_already_exists", input.squadId, "Squad 已存在。");
    }
    const now = yield* currentTimeMillis;
    const squad = yield* validate(
      buildSquad(input, { revision: 1, createdAtUnixMs: now, updatedAtUnixMs: now }),
    );
    return yield* options.store.upsertSquad(squad).pipe(
      Effect.mapError((cause) => persistenceError("创建 Squad", input.squadId, cause)),
      Effect.catch((writeError) =>
        getOption("创建 Squad", input.squadId).pipe(
          Effect.flatMap((latest) =>
            Option.isSome(latest)
              ? serviceError("squad_already_exists", input.squadId, "Squad 已存在。")
              : writeError,
          ),
        ),
      ),
    );
  });

  const update = Effect.fn("CompositionSquadService.update")(function* (
    input: CompositionSquadUpdateInput,
  ) {
    const current = yield* get(input.squadId);
    const actualRevision = revisionOf(current);
    if (current.archivedAtUnixMs !== undefined) {
      return yield* serviceError("squad_archived", input.squadId, "归档 Squad 不允许编辑。");
    }
    if (actualRevision !== input.expectedRevision) {
      return yield* serviceError(
        "squad_revision_conflict",
        input.squadId,
        `预期 revision ${input.expectedRevision}，实际为 ${actualRevision}。`,
        { expectedRevision: input.expectedRevision, actualRevision },
      );
    }
    const now = yield* currentTimeMillis;
    const squad = yield* validate(
      buildSquad(input, {
        revision: actualRevision + 1,
        createdAtUnixMs: current.createdAtUnixMs ?? 0,
        updatedAtUnixMs: now,
      }),
    );
    return yield* saveNextRevision("编辑 Squad", input.expectedRevision, squad);
  });

  const duplicate = Effect.fn("CompositionSquadService.duplicate")(function* (
    input: CompositionSquadDuplicateInput,
  ) {
    const source = yield* get(input.sourceSquadId);
    const sourceInput = normalizeStoredConfiguration(source);
    return yield* create({
      ...sourceInput,
      squadId: input.squadId,
      name: input.name,
    });
  });

  const archive = Effect.fn("CompositionSquadService.archive")(function* (
    input: CompositionSquadRevisionInput,
  ) {
    const current = yield* get(input.squadId);
    const actualRevision = revisionOf(current);
    if (current.archivedAtUnixMs !== undefined) {
      return yield* serviceError("squad_already_archived", input.squadId, "Squad 已归档。");
    }
    if (actualRevision !== input.expectedRevision) {
      return yield* serviceError(
        "squad_revision_conflict",
        input.squadId,
        `预期 revision ${input.expectedRevision}，实际为 ${actualRevision}。`,
        { expectedRevision: input.expectedRevision, actualRevision },
      );
    }
    const now = yield* currentTimeMillis;
    const squad = yield* validate(
      buildSquad(normalizeStoredConfiguration(current), {
        revision: actualRevision + 1,
        createdAtUnixMs: current.createdAtUnixMs ?? 0,
        updatedAtUnixMs: now,
        archivedAtUnixMs: now,
      }),
    );
    return yield* saveNextRevision("归档 Squad", input.expectedRevision, squad);
  });

  const restore = Effect.fn("CompositionSquadService.restore")(function* (
    input: CompositionSquadRevisionInput,
  ) {
    const current = yield* get(input.squadId);
    const actualRevision = revisionOf(current);
    if (current.archivedAtUnixMs === undefined) {
      return yield* serviceError("squad_not_archived", input.squadId, "Squad 尚未归档。");
    }
    if (actualRevision !== input.expectedRevision) {
      return yield* serviceError(
        "squad_revision_conflict",
        input.squadId,
        `预期 revision ${input.expectedRevision}，实际为 ${actualRevision}。`,
        { expectedRevision: input.expectedRevision, actualRevision },
      );
    }
    const now = yield* currentTimeMillis;
    const squad = yield* validate(
      buildSquad(normalizeStoredConfiguration(current), {
        revision: actualRevision + 1,
        createdAtUnixMs: current.createdAtUnixMs ?? 0,
        updatedAtUnixMs: now,
      }),
    );
    return yield* saveNextRevision("恢复 Squad", input.expectedRevision, squad);
  });

  const getRunnable = Effect.fn("CompositionSquadService.getRunnable")(function* (squadId: string) {
    const squad = yield* get(squadId);
    if (squad.archivedAtUnixMs !== undefined) {
      return yield* serviceError("squad_archived", squadId, "归档 Squad 不能启动新运行。");
    }
    return squad;
  });

  const listRevisions = (squadId: string) =>
    options.store
      .listSquadRevisions(squadId)
      .pipe(Effect.mapError((cause) => persistenceError("列出 Squad revision", squadId, cause)));

  const getRevision = Effect.fn("CompositionSquadService.getRevision")(function* (
    squadId: string,
    revision: number,
  ) {
    const revisions = yield* listRevisions(squadId);
    const snapshot = revisions.find((candidate) => candidate.revision === revision);
    if (snapshot === undefined) {
      const latestRevision = revisions.at(-1)?.revision;
      return yield* serviceError(
        "squad_revision_not_found",
        squadId,
        `Squad revision ${revision} 不存在。`,
        {
          expectedRevision: revision,
          ...(latestRevision === undefined ? {} : { actualRevision: latestRevision }),
        },
      );
    }
    if (
      snapshot.configuration === null ||
      snapshot.configuration.squadId !== squadId ||
      revisionOf(snapshot.configuration) !== revision
    ) {
      return yield* serviceError(
        "squad_revision_unavailable",
        squadId,
        `Squad revision ${revision} 缺少可恢复的完整配置。`,
        { expectedRevision: revision },
      );
    }
    return snapshot.configuration;
  });

  return {
    create,
    update,
    duplicate,
    archive,
    restore,
    get,
    getRunnable,
    getRevision,
    list: (listOptions) =>
      options.store
        .listSquads(listOptions)
        .pipe(Effect.mapError((cause) => persistenceError("列出 Squad", "*", cause))),
    listRevisions,
  };
};

const live = Effect.gen(function* () {
  const store = yield* CompositionTaskStore;
  return makeCompositionSquadService({ store });
});

export const layer = Layer.effect(CompositionSquadService, live);
