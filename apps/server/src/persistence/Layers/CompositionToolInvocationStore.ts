import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../Errors.ts";
import {
  CompositionToolInvocation as CompositionToolInvocationSchema,
  CompositionToolInvocationStatus,
  CompositionToolInvocationStore,
  CompositionToolInvocationStoreDomainError,
  CompositionToolInvocationTerminalStatus,
  type CompositionToolInvocation,
  type CompositionToolInvocationClaimResult,
  type CompositionToolInvocationIdentity,
  type CompositionToolInvocationPrepareInput,
  type CompositionToolInvocationStoreErrorCode,
  type CompositionToolInvocationStoreShape,
  type CompositionToolInvocationTerminalInput,
} from "../Services/CompositionToolInvocationStore.ts";

const INVOCATION_LIST_MAX = 200;

const InvocationRowSchema = Schema.Struct({
  idempotencyKey: Schema.String,
  taskId: Schema.String,
  runId: Schema.String,
  agentId: Schema.String,
  toolCallId: Schema.String,
  canonicalToolName: Schema.String,
  operation: Schema.String,
  argumentsDigest: Schema.String,
  scopeDigest: Schema.String,
  status: CompositionToolInvocationStatus,
  revision: Schema.Number,
  outcomeCode: Schema.NullOr(Schema.String),
  createdAtUnixMs: Schema.Number,
  updatedAtUnixMs: Schema.Number,
  claimedAtUnixMs: Schema.NullOr(Schema.Number),
  finishedAtUnixMs: Schema.NullOr(Schema.Number),
});
const InvocationWriteSchema = Schema.Struct({
  idempotencyKey: Schema.String,
  taskId: Schema.String,
  runId: Schema.String,
  agentId: Schema.String,
  toolCallId: Schema.String,
  canonicalToolName: Schema.String,
  operation: Schema.String,
  argumentsDigest: Schema.String,
  scopeDigest: Schema.String,
  createdAtUnixMs: Schema.Number,
});
const InvocationIdRequest = Schema.Struct({ idempotencyKey: Schema.String });
const InvocationRunToolRequest = Schema.Struct({
  runId: Schema.String,
  toolCallId: Schema.String,
});
const InvocationClaimRequest = Schema.Struct({
  idempotencyKey: Schema.String,
  expectedRevision: Schema.Number,
  claimedAtUnixMs: Schema.Number,
});
const InvocationTerminalRequest = Schema.Struct({
  idempotencyKey: Schema.String,
  expectedRevision: Schema.Number,
  status: CompositionToolInvocationTerminalStatus,
  outcomeCode: Schema.NullOr(Schema.String),
  finishedAtUnixMs: Schema.Number,
});
const InvocationListRequest = Schema.Struct({ limit: Schema.Number });
const InvocationRecoveryRequest = Schema.Struct({
  recoveredAtUnixMs: Schema.Number,
  outcomeCode: Schema.String,
});

type InvocationRow = Schema.Schema.Type<typeof InvocationRowSchema>;

const decodeInvocation = Schema.decodeUnknownEffect(CompositionToolInvocationSchema);
const isTerminalStatus = Schema.is(CompositionToolInvocationTerminalStatus);

const toInvocationCandidate = (row: InvocationRow): CompositionToolInvocation => ({ ...row });

const sameIdentity = (
  left: CompositionToolInvocationIdentity,
  right: CompositionToolInvocationIdentity,
): boolean =>
  left.idempotencyKey === right.idempotencyKey &&
  left.taskId === right.taskId &&
  left.runId === right.runId &&
  left.agentId === right.agentId &&
  left.toolCallId === right.toolCallId &&
  left.canonicalToolName === right.canonicalToolName &&
  left.operation === right.operation &&
  left.argumentsDigest === right.argumentsDigest &&
  left.scopeDigest === right.scopeDigest;

const sameTerminalRequest = (
  invocation: CompositionToolInvocation,
  input: CompositionToolInvocationTerminalInput,
): boolean =>
  invocation.revision === input.expectedRevision + 1 &&
  invocation.status === input.status &&
  invocation.outcomeCode === input.outcomeCode &&
  invocation.finishedAtUnixMs === input.finishedAtUnixMs &&
  invocation.updatedAtUnixMs === input.finishedAtUnixMs;

const domainError = (
  code: CompositionToolInvocationStoreErrorCode,
  detail: string,
  metadata: {
    readonly idempotencyKey?: string;
    readonly expectedRevision?: number;
    readonly actualRevision?: number;
    readonly expectedStatus?: string;
    readonly actualStatus?: string;
  } = {},
): CompositionToolInvocationStoreDomainError =>
  new CompositionToolInvocationStoreDomainError({ code, detail, ...metadata });

const mapQueryError =
  (operation: string): ((cause: unknown) => PersistenceSqlError | PersistenceDecodeError) =>
  (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const hasTextWithin = (value: string, maxLength: number): boolean =>
  value.trim().length > 0 && value.length <= maxLength;

const validateIdentity = <A extends CompositionToolInvocationIdentity>(
  operation: string,
  input: A,
) => {
  const valid =
    hasTextWithin(input.idempotencyKey, 512) &&
    hasTextWithin(input.taskId, 512) &&
    hasTextWithin(input.runId, 512) &&
    hasTextWithin(input.agentId, 512) &&
    hasTextWithin(input.toolCallId, 512) &&
    hasTextWithin(input.canonicalToolName, 256) &&
    hasTextWithin(input.operation, 256) &&
    hasTextWithin(input.argumentsDigest, 512) &&
    hasTextWithin(input.scopeDigest, 512);
  return valid
    ? Effect.succeed(input)
    : Effect.fail(
        domainError(
          "tool_invocation_input_invalid",
          `${operation} 的身份摘要字段不能为空或超长。`,
          {
            idempotencyKey: input.idempotencyKey,
          },
        ),
      );
};

const validateTimestamp = (operation: string, idempotencyKey: string, value: number) =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(
        domainError("tool_invocation_input_invalid", `${operation} 的时间必须是非负安全整数。`, {
          idempotencyKey,
        }),
      );

const validateRevision = (operation: string, idempotencyKey: string, value: number) =>
  Number.isSafeInteger(value) && value >= 1
    ? Effect.succeed(value)
    : Effect.fail(
        domainError(
          "tool_invocation_input_invalid",
          `${operation} 的 revision 必须是正安全整数。`,
          {
            idempotencyKey,
            expectedRevision: value,
          },
        ),
      );

const validatePrepareInput = (input: CompositionToolInvocationPrepareInput) =>
  Effect.gen(function* () {
    yield* validateIdentity("prepareInvocation", input);
    yield* validateTimestamp("prepareInvocation", input.idempotencyKey, input.createdAtUnixMs);
    return input;
  });

const validateTerminalInput = (input: CompositionToolInvocationTerminalInput) =>
  Effect.gen(function* () {
    if (!isTerminalStatus(input.status)) {
      return yield* domainError(
        "tool_invocation_input_invalid",
        "saveTerminal 只接受 succeeded、failed、cancelled 或 unknown。",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    yield* validateRevision("saveTerminal", input.idempotencyKey, input.expectedRevision);
    yield* validateTimestamp("saveTerminal", input.idempotencyKey, input.finishedAtUnixMs);
    const outcomeValid =
      input.status === "succeeded"
        ? input.outcomeCode === null
        : input.outcomeCode !== null && hasTextWithin(input.outcomeCode, 128);
    if (!outcomeValid) {
      return yield* domainError(
        "tool_invocation_input_invalid",
        "succeeded 不保存结果正文，其余终态必须提供不超过 128 字符的稳定结果码。",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    return input;
  });

const makeStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getInvocationRow = SqlSchema.findOneOption({
    Request: InvocationIdRequest,
    Result: InvocationRowSchema,
    execute: ({ idempotencyKey }) => sql`
      SELECT
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_tool_invocations
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `,
  });

  const getInvocationByRunToolRow = SqlSchema.findOneOption({
    Request: InvocationRunToolRequest,
    Result: InvocationRowSchema,
    execute: ({ runId, toolCallId }) => sql`
      SELECT
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_tool_invocations
      WHERE run_id = ${runId} AND tool_call_id = ${toolCallId}
      LIMIT 1
    `,
  });

  const insertInvocationRow = SqlSchema.findOneOption({
    Request: InvocationWriteSchema,
    Result: InvocationRowSchema,
    execute: (input) => sql`
      INSERT INTO composition_tool_invocations (
        idempotency_key, task_id, run_id, agent_id, tool_call_id,
        canonical_tool_name, operation, arguments_digest, scope_digest,
        status, revision, outcome_code,
        created_at_unix_ms, updated_at_unix_ms,
        claimed_at_unix_ms, finished_at_unix_ms
      ) VALUES (
        ${input.idempotencyKey}, ${input.taskId}, ${input.runId}, ${input.agentId},
        ${input.toolCallId}, ${input.canonicalToolName}, ${input.operation},
        ${input.argumentsDigest}, ${input.scopeDigest},
        'prepared', 1, NULL, ${input.createdAtUnixMs}, ${input.createdAtUnixMs}, NULL, NULL
      )
      ON CONFLICT DO NOTHING
      RETURNING
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const claimPreparedRow = SqlSchema.findOneOption({
    Request: InvocationClaimRequest,
    Result: InvocationRowSchema,
    execute: (input) => sql`
      UPDATE composition_tool_invocations
      SET
        status = 'executing',
        revision = revision + 1,
        claimed_at_unix_ms = ${input.claimedAtUnixMs},
        updated_at_unix_ms = ${input.claimedAtUnixMs}
      WHERE idempotency_key = ${input.idempotencyKey}
        AND status = 'prepared'
        AND revision = ${input.expectedRevision}
        AND claimed_at_unix_ms IS NULL
        AND ${input.claimedAtUnixMs} >= created_at_unix_ms
        AND ${input.claimedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const saveTerminalRow = SqlSchema.findOneOption({
    Request: InvocationTerminalRequest,
    Result: InvocationRowSchema,
    execute: (input) => sql`
      UPDATE composition_tool_invocations
      SET
        status = ${input.status},
        revision = revision + 1,
        outcome_code = ${input.outcomeCode},
        finished_at_unix_ms = ${input.finishedAtUnixMs},
        updated_at_unix_ms = ${input.finishedAtUnixMs}
      WHERE idempotency_key = ${input.idempotencyKey}
        AND status = 'executing'
        AND revision = ${input.expectedRevision}
        AND claimed_at_unix_ms IS NOT NULL
        AND ${input.finishedAtUnixMs} >= claimed_at_unix_ms
        AND ${input.finishedAtUnixMs} >= updated_at_unix_ms
      RETURNING
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const listUnknownRows = SqlSchema.findAll({
    Request: InvocationListRequest,
    Result: InvocationRowSchema,
    execute: ({ limit }) => sql`
      SELECT
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
      FROM composition_tool_invocations
      WHERE status = 'unknown'
      ORDER BY updated_at_unix_ms ASC, idempotency_key ASC
      LIMIT ${limit}
    `,
  });

  const recoverExecutingRows = SqlSchema.findAll({
    Request: InvocationRecoveryRequest,
    Result: InvocationRowSchema,
    execute: ({ recoveredAtUnixMs, outcomeCode }) => sql`
      UPDATE composition_tool_invocations
      SET
        status = 'unknown',
        revision = revision + 1,
        outcome_code = ${outcomeCode},
        finished_at_unix_ms = MAX(${recoveredAtUnixMs}, updated_at_unix_ms),
        updated_at_unix_ms = MAX(${recoveredAtUnixMs}, updated_at_unix_ms)
      WHERE status = 'executing'
        AND revision = 2
        AND claimed_at_unix_ms IS NOT NULL
      RETURNING
        idempotency_key AS "idempotencyKey", task_id AS "taskId", run_id AS "runId",
        agent_id AS "agentId", tool_call_id AS "toolCallId",
        canonical_tool_name AS "canonicalToolName", operation,
        arguments_digest AS "argumentsDigest", scope_digest AS "scopeDigest",
        status, revision, outcome_code AS "outcomeCode",
        created_at_unix_ms AS "createdAtUnixMs", updated_at_unix_ms AS "updatedAtUnixMs",
        claimed_at_unix_ms AS "claimedAtUnixMs", finished_at_unix_ms AS "finishedAtUnixMs"
    `,
  });

  const query = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError(mapQueryError(operation)));

  const withTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            toPersistenceSqlError("CompositionToolInvocationStore.withTransaction")(cause),
          ),
        ),
      );

  const decodeRow = (operation: string, row: InvocationRow) =>
    decodeInvocation(toInvocationCandidate(row)).pipe(
      Effect.mapError(toPersistenceDecodeError(`${operation}:invocation`)),
    );

  const readInvocation = (idempotencyKey: string) =>
    query(
      "CompositionToolInvocationStore.getInvocation",
      getInvocationRow({ idempotencyKey }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionToolInvocation>()),
          onSome: (row) =>
            decodeRow("CompositionToolInvocationStore.getInvocation", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const readInvocationByRunTool = (runId: string, toolCallId: string) =>
    query(
      "CompositionToolInvocationStore.getInvocationByRunTool",
      getInvocationByRunToolRow({ runId, toolCallId }),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<CompositionToolInvocation>()),
          onSome: (row) =>
            decodeRow("CompositionToolInvocationStore.getInvocationByRunTool", row).pipe(
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const prepareInvocation: CompositionToolInvocationStoreShape["prepareInvocation"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validatePrepareInput(input);
        const inserted = yield* query(
          "CompositionToolInvocationStore.prepareInvocation.insert",
          insertInvocationRow(valid),
        );
        if (Option.isSome(inserted)) {
          return yield* decodeRow(
            "CompositionToolInvocationStore.prepareInvocation.insert",
            inserted.value,
          );
        }

        const byKey = yield* readInvocation(valid.idempotencyKey);
        if (Option.isSome(byKey)) {
          if (sameIdentity(byKey.value, valid)) return byKey.value;
          return yield* domainError(
            "tool_invocation_identity_conflict",
            "幂等键已绑定到不同的 Tool Invocation 身份。",
            { idempotencyKey: valid.idempotencyKey },
          );
        }

        const byRunTool = yield* readInvocationByRunTool(valid.runId, valid.toolCallId);
        if (Option.isSome(byRunTool)) {
          return yield* domainError(
            "tool_invocation_identity_conflict",
            "同一 runId/toolCallId 已由其他幂等键占用。",
            { idempotencyKey: valid.idempotencyKey },
          );
        }
        return yield* domainError(
          "tool_invocation_identity_conflict",
          "Tool Invocation 唯一身份竞争失败，且未找到可安全重放的记录。",
          { idempotencyKey: valid.idempotencyKey },
        );
      }),
    );

  const claimPrepared: CompositionToolInvocationStoreShape["claimPrepared"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        if (!hasTextWithin(input.idempotencyKey, 512)) {
          return yield* domainError(
            "tool_invocation_input_invalid",
            "claimPrepared 的幂等键不能为空或超长。",
            { idempotencyKey: input.idempotencyKey },
          );
        }
        yield* validateRevision("claimPrepared", input.idempotencyKey, input.expectedRevision);
        yield* validateTimestamp("claimPrepared", input.idempotencyKey, input.claimedAtUnixMs);

        const updated = yield* query(
          "CompositionToolInvocationStore.claimPrepared.update",
          claimPreparedRow(input),
        );
        if (Option.isSome(updated)) {
          return {
            invocation: yield* decodeRow(
              "CompositionToolInvocationStore.claimPrepared.update",
              updated.value,
            ),
            claimed: true,
          } satisfies CompositionToolInvocationClaimResult;
        }

        const current = yield* readInvocation(input.idempotencyKey);
        if (Option.isNone(current)) {
          return yield* domainError("tool_invocation_not_found", "Tool Invocation 不存在。", {
            idempotencyKey: input.idempotencyKey,
          });
        }
        if (current.value.status !== "prepared") {
          return {
            invocation: current.value,
            claimed: false,
          } satisfies CompositionToolInvocationClaimResult;
        }
        if (current.value.revision !== input.expectedRevision) {
          return yield* domainError(
            "tool_invocation_revision_conflict",
            "prepared revision 已被其他操作推进。",
            {
              idempotencyKey: input.idempotencyKey,
              expectedRevision: input.expectedRevision,
              actualRevision: current.value.revision,
            },
          );
        }
        return yield* domainError(
          "tool_invocation_input_invalid",
          "claimedAtUnixMs 不能早于 Invocation 创建或最近更新时间。",
          { idempotencyKey: input.idempotencyKey },
        );
      }),
    );

  const saveTerminal: CompositionToolInvocationStoreShape["saveTerminal"] = (input) =>
    withTransaction(
      Effect.gen(function* () {
        const valid = yield* validateTerminalInput(input);
        const updated = yield* query(
          "CompositionToolInvocationStore.saveTerminal.update",
          saveTerminalRow(valid),
        );
        if (Option.isSome(updated)) {
          return yield* decodeRow(
            "CompositionToolInvocationStore.saveTerminal.update",
            updated.value,
          );
        }

        const current = yield* readInvocation(valid.idempotencyKey);
        if (Option.isNone(current)) {
          return yield* domainError("tool_invocation_not_found", "Tool Invocation 不存在。", {
            idempotencyKey: valid.idempotencyKey,
          });
        }
        if (isTerminalStatus(current.value.status)) {
          if (sameTerminalRequest(current.value, valid)) return current.value;
          return yield* domainError(
            "tool_invocation_terminal_conflict",
            "Tool Invocation 已以不同终态收口，禁止覆盖或改写。",
            {
              idempotencyKey: valid.idempotencyKey,
              expectedRevision: valid.expectedRevision,
              actualRevision: current.value.revision,
              expectedStatus: valid.status,
              actualStatus: current.value.status,
            },
          );
        }
        if (current.value.status !== "executing") {
          return yield* domainError(
            "tool_invocation_status_conflict",
            "只有 executing Invocation 可以写入终态。",
            {
              idempotencyKey: valid.idempotencyKey,
              expectedStatus: "executing",
              actualStatus: current.value.status,
            },
          );
        }
        if (current.value.revision !== valid.expectedRevision) {
          return yield* domainError(
            "tool_invocation_revision_conflict",
            "executing revision 已被其他操作推进。",
            {
              idempotencyKey: valid.idempotencyKey,
              expectedRevision: valid.expectedRevision,
              actualRevision: current.value.revision,
            },
          );
        }
        return yield* domainError(
          "tool_invocation_input_invalid",
          "finishedAtUnixMs 不能早于 claim 或最近更新时间。",
          { idempotencyKey: valid.idempotencyKey },
        );
      }),
    );

  const getInvocation: CompositionToolInvocationStoreShape["getInvocation"] = (idempotencyKey) =>
    hasTextWithin(idempotencyKey, 512)
      ? readInvocation(idempotencyKey)
      : Effect.fail(
          domainError("tool_invocation_input_invalid", "getInvocation 的幂等键不能为空或超长。", {
            idempotencyKey,
          }),
        );

  const listUnknownInvocations: CompositionToolInvocationStoreShape["listUnknownInvocations"] = ({
    limit,
  }) =>
    Number.isSafeInteger(limit) && limit >= 1 && limit <= INVOCATION_LIST_MAX
      ? query(
          "CompositionToolInvocationStore.listUnknownInvocations",
          listUnknownRows({ limit }),
        ).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeRow("CompositionToolInvocationStore.listUnknownInvocations", row),
            ),
          ),
        )
      : Effect.fail(
          domainError(
            "tool_invocation_list_limit_invalid",
            `listUnknownInvocations 的 limit 必须是 1 到 ${INVOCATION_LIST_MAX} 的安全整数。`,
          ),
        );

  const recoverExecutingInvocations: CompositionToolInvocationStoreShape["recoverExecutingInvocations"] =
    (input) =>
      Effect.gen(function* () {
        yield* validateTimestamp(
          "recoverExecutingInvocations",
          "startup-recovery",
          input.recoveredAtUnixMs,
        );
        if (!hasTextWithin(input.outcomeCode, 128)) {
          return yield* domainError(
            "tool_invocation_input_invalid",
            "recoverExecutingInvocations 的 outcomeCode 不能为空或超过 128 字符。",
          );
        }
        const rows = yield* query(
          "CompositionToolInvocationStore.recoverExecutingInvocations",
          recoverExecutingRows(input),
        );
        const invocations = yield* Effect.forEach(rows, (row) =>
          decodeRow("CompositionToolInvocationStore.recoverExecutingInvocations", row),
        );
        invocations.sort(
          (left, right) =>
            left.updatedAtUnixMs - right.updatedAtUnixMs ||
            left.idempotencyKey.localeCompare(right.idempotencyKey),
        );
        return {
          type: "composition.tool_invocations.recovered" as const,
          recoveredAtUnixMs: input.recoveredAtUnixMs,
          outcomeCode: input.outcomeCode,
          recoveredCount: invocations.length,
          invocations,
        };
      });

  return {
    prepareInvocation,
    claimPrepared,
    saveTerminal,
    getInvocation,
    listUnknownInvocations,
    recoverExecutingInvocations,
  } satisfies CompositionToolInvocationStoreShape;
});

export const CompositionToolInvocationStoreLive = Layer.effect(
  CompositionToolInvocationStore,
  makeStore,
);
