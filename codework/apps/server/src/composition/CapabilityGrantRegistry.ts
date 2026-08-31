import type {
  CompositionCapabilityAuditEvent,
  CompositionCapabilityAuditOutcome,
  CompositionCapabilityGrant,
  CompositionCapabilityOperation,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as NodeCrypto from "node:crypto";

import * as CapabilityRegistry from "./CapabilityRegistry.ts";

const DEFAULT_GRANT_TTL_MS = 15 * 60 * 1000;

export class CapabilityGrantInvalidError extends Schema.TaggedErrorClass<CapabilityGrantInvalidError>()(
  "CapabilityGrantInvalidError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Capability Grant 无效：${this.reason}`;
  }
}

export class CapabilityGrantNotFoundError extends Schema.TaggedErrorClass<CapabilityGrantNotFoundError>()(
  "CapabilityGrantNotFoundError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 不存在。`;
  }
}

export class CapabilityGrantScopeMismatchError extends Schema.TaggedErrorClass<CapabilityGrantScopeMismatchError>()(
  "CapabilityGrantScopeMismatchError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 与 task/agent/capability 作用域不匹配。`;
  }
}

export class CapabilityGrantExpiredError extends Schema.TaggedErrorClass<CapabilityGrantExpiredError>()(
  "CapabilityGrantExpiredError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 已过期。`;
  }
}

export class CapabilityGrantRevokedError extends Schema.TaggedErrorClass<CapabilityGrantRevokedError>()(
  "CapabilityGrantRevokedError",
  { grantId: Schema.String },
) {
  override get message(): string {
    return `Capability Grant '${this.grantId}' 已撤销。`;
  }
}

export class CapabilityGrantPersistenceError extends Schema.TaggedErrorClass<CapabilityGrantPersistenceError>()(
  "CapabilityGrantPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Capability Grant 持久化失败：${this.operation}: ${this.detail}`;
  }
}

export type CapabilityGrantIssueInput = {
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly ttlMs?: number;
  /** 仅复用在该时长之后仍有效的 grant，避免恢复流程拿到即将过期的授权。 */
  readonly minimumRemainingMs?: number;
};

type NormalizedCapabilityGrantIssueInput = {
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly issuedAtUnixMs: number;
  readonly expiresAtUnixMs: number;
  readonly minimumRemainingMs: number;
};

const normalizeCapabilityGrantIssueInput = Effect.fn("normalizeCapabilityGrantIssueInput")(
  function* (
    input: CapabilityGrantIssueInput,
    issuedAtUnixMs: number,
  ): Effect.fn.Return<NormalizedCapabilityGrantIssueInput, CapabilityGrantInvalidError> {
    const taskId = input.taskId.trim();
    const agentId = input.agentId.trim();
    const capabilityIds = input.capabilityIds.map((capabilityId) => capabilityId.trim());
    const ttlMs = input.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    const minimumRemainingMs = input.minimumRemainingMs ?? 0;
    const expiresAtUnixMs = issuedAtUnixMs + ttlMs;
    if (
      taskId.length === 0 ||
      agentId.length === 0 ||
      capabilityIds.length === 0 ||
      capabilityIds.some((capabilityId) => capabilityId.length === 0) ||
      new Set(capabilityIds).size !== capabilityIds.length ||
      !Number.isSafeInteger(issuedAtUnixMs) ||
      issuedAtUnixMs < 0 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      !Number.isSafeInteger(minimumRemainingMs) ||
      minimumRemainingMs < 0 ||
      ttlMs <= minimumRemainingMs ||
      !Number.isSafeInteger(expiresAtUnixMs)
    ) {
      return yield* new CapabilityGrantInvalidError({ reason: "grant_input_invalid" });
    }
    return {
      taskId,
      agentId,
      capabilityIds,
      issuedAtUnixMs,
      expiresAtUnixMs,
      minimumRemainingMs,
    };
  },
);

export type CapabilityGrantValidationInput = {
  readonly grantId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly capabilityId: string;
};

export type CapabilityGrantAuditInput = {
  readonly grantId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly capabilityId: string;
  readonly operation: CompositionCapabilityOperation;
  readonly outcome: CompositionCapabilityAuditOutcome;
  readonly errorCode?: string;
};

export type CapabilityGrantAuditIfNewInput = CapabilityGrantAuditInput & {
  readonly auditId: string;
};

export type CapabilityGrantRegistryOptions = {
  readonly capabilityRegistry: Pick<
    CapabilityRegistry.CapabilityRegistry["Service"],
    "resolveRequired"
  >;
  readonly now?: () => number;
};

export interface CapabilityGrantRegistryShape {
  readonly issue: (
    input: CapabilityGrantIssueInput,
  ) => Effect.Effect<
    ReadonlyArray<CompositionCapabilityGrant>,
    | CapabilityGrantInvalidError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
    | CapabilityGrantPersistenceError
  >;
  readonly validate: (
    input: CapabilityGrantValidationInput,
  ) => Effect.Effect<
    CompositionCapabilityGrant,
    | CapabilityGrantNotFoundError
    | CapabilityGrantScopeMismatchError
    | CapabilityGrantExpiredError
    | CapabilityGrantRevokedError
    | CapabilityGrantPersistenceError
  >;
  /** 恢复路径除 grant 本身外，还会重新核验当前 capability descriptor。 */
  readonly validateForRecovery: (
    input: CapabilityGrantValidationInput,
  ) => Effect.Effect<
    CompositionCapabilityGrant,
    | CapabilityGrantNotFoundError
    | CapabilityGrantScopeMismatchError
    | CapabilityGrantExpiredError
    | CapabilityGrantRevokedError
    | CapabilityGrantPersistenceError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
    | CapabilityRegistry.CapabilityNotAvailableError
  >;
  readonly revoke: (input: {
    readonly grantId: string;
  }) => Effect.Effect<void, CapabilityGrantNotFoundError | CapabilityGrantPersistenceError>;
  readonly recordAudit: (
    input: CapabilityGrantAuditInput,
  ) => Effect.Effect<void, CapabilityGrantPersistenceError>;
  readonly recordAuditIfNew: (
    input: CapabilityGrantAuditIfNewInput,
  ) => Effect.Effect<boolean, CapabilityGrantPersistenceError>;
  readonly getAuditById: (input: {
    readonly auditId: string;
  }) => Effect.Effect<
    Option.Option<CompositionCapabilityAuditEvent>,
    CapabilityGrantPersistenceError
  >;
  readonly listAudit: (input: {
    readonly taskId: string;
  }) => Effect.Effect<
    ReadonlyArray<CompositionCapabilityAuditEvent>,
    CapabilityGrantPersistenceError
  >;
}

export class CapabilityGrantRegistry extends Context.Service<
  CapabilityGrantRegistry,
  CapabilityGrantRegistryShape
>()("codework/composition/CapabilityGrantRegistry") {}

export const makeCapabilityGrantRegistry = (
  options: CapabilityGrantRegistryOptions,
): CapabilityGrantRegistryShape => {
  const grants = new Map<string, CompositionCapabilityGrant>();
  const audit = new Map<string, CompositionCapabilityAuditEvent>();
  const now = options.now ?? Date.now;
  let grantSequence = 0;
  let auditSequence = 0;

  const issue: CapabilityGrantRegistryShape["issue"] = Effect.fn("CapabilityGrantRegistry.issue")(
    function* (input) {
      const normalized = yield* normalizeCapabilityGrantIssueInput(input, now());
      const { taskId, agentId, capabilityIds, issuedAtUnixMs, expiresAtUnixMs } = normalized;

      yield* options.capabilityRegistry
        .resolveRequired({ scope: "task", scopeId: taskId, capabilityIds })
        .pipe(
          Effect.catchTag("CapabilityNotAvailableError", (error) =>
            Effect.fail(
              new CapabilityGrantInvalidError({
                reason: `capability_not_available:${error.capabilityId}`,
              }),
            ),
          ),
        );

      const result: CompositionCapabilityGrant[] = [];
      for (const capabilityId of capabilityIds) {
        const existing = [...grants.values()].find(
          (grant) =>
            grant.taskId === taskId &&
            grant.agentId === agentId &&
            grant.capabilityId === capabilityId &&
            grant.revokedAtUnixMs === undefined &&
            grant.expiresAtUnixMs > issuedAtUnixMs + normalized.minimumRemainingMs,
        );
        if (existing !== undefined) {
          result.push(existing);
          continue;
        }
        grantSequence += 1;
        const grant = {
          grantId: `grant-${grantSequence}`,
          taskId,
          agentId,
          capabilityId,
          issuedAtUnixMs,
          expiresAtUnixMs,
        } satisfies CompositionCapabilityGrant;
        grants.set(grant.grantId, grant);
        result.push(grant);
      }
      return result;
    },
  );

  const validate: CapabilityGrantRegistryShape["validate"] = Effect.fn(
    "CapabilityGrantRegistry.validate",
  )(function* (input) {
    const grant = grants.get(input.grantId);
    if (grant === undefined) {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    if (
      grant.taskId !== input.taskId ||
      grant.agentId !== input.agentId ||
      grant.capabilityId !== input.capabilityId
    ) {
      return yield* new CapabilityGrantScopeMismatchError({ grantId: input.grantId });
    }
    if (grant.revokedAtUnixMs !== undefined) {
      return yield* new CapabilityGrantRevokedError({ grantId: input.grantId });
    }
    if (grant.expiresAtUnixMs <= now()) {
      return yield* new CapabilityGrantExpiredError({ grantId: input.grantId });
    }
    return grant;
  });

  const validateForRecovery: CapabilityGrantRegistryShape["validateForRecovery"] = Effect.fn(
    "CapabilityGrantRegistry.validateForRecovery",
  )(function* (input) {
    const grant = yield* validate(input);
    yield* options.capabilityRegistry.resolveRequired({
      scope: "task",
      scopeId: input.taskId,
      capabilityIds: [input.capabilityId],
    });
    return grant;
  });

  const revoke: CapabilityGrantRegistryShape["revoke"] = Effect.fn(
    "CapabilityGrantRegistry.revoke",
  )(function* (input) {
    const grant = grants.get(input.grantId);
    if (grant === undefined) {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    grants.set(input.grantId, { ...grant, revokedAtUnixMs: now() });
  });

  const recordAudit: CapabilityGrantRegistryShape["recordAudit"] = Effect.fn(
    "CapabilityGrantRegistry.recordAudit",
  )((input) =>
    Effect.sync(() => {
      auditSequence += 1;
      const event = {
        auditId: `audit-${auditSequence}`,
        grantId: input.grantId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        capabilityId: input.capabilityId,
        operation: input.operation,
        outcome: input.outcome,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        occurredAtUnixMs: now(),
      } satisfies CompositionCapabilityAuditEvent;
      audit.set(event.auditId, event);
    }),
  );

  const recordAuditIfNew: CapabilityGrantRegistryShape["recordAuditIfNew"] = Effect.fn(
    "CapabilityGrantRegistry.recordAuditIfNew",
  )((input) =>
    Effect.sync(() => {
      if (audit.has(input.auditId)) return false;
      audit.set(input.auditId, {
        auditId: input.auditId,
        grantId: input.grantId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        capabilityId: input.capabilityId,
        operation: input.operation,
        outcome: input.outcome,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        occurredAtUnixMs: now(),
      });
      return true;
    }),
  );

  return {
    issue,
    validate,
    validateForRecovery,
    revoke,
    recordAudit,
    recordAuditIfNew,
    getAuditById: (input) => Effect.succeed(Option.fromNullishOr(audit.get(input.auditId))),
    listAudit: (input) =>
      Effect.succeed([...audit.values()].filter((event) => event.taskId === input.taskId)),
  };
};

type SqlCapabilityGrantRegistryOptions = CapabilityGrantRegistryOptions & {
  readonly sql: SqlClient.SqlClient;
  readonly randomUUID?: () => string;
};

const GrantRowSchema = Schema.Struct({
  grantId: Schema.String,
  taskId: Schema.String,
  agentId: Schema.String,
  capabilityId: Schema.String,
  issuedAtUnixMs: Schema.Number,
  expiresAtUnixMs: Schema.Number,
  revokedAtUnixMs: Schema.NullOr(Schema.Number),
});

const AuditRowSchema = Schema.Struct({
  auditId: Schema.String,
  grantId: Schema.String,
  taskId: Schema.String,
  runId: Schema.String,
  agentId: Schema.String,
  capabilityId: Schema.String,
  operation: Schema.String,
  outcome: Schema.String,
  errorCode: Schema.NullOr(Schema.String),
  occurredAtUnixMs: Schema.Number,
});

const toGrant = (row: Schema.Schema.Type<typeof GrantRowSchema>): CompositionCapabilityGrant => ({
  grantId: row.grantId,
  taskId: row.taskId,
  agentId: row.agentId,
  capabilityId: row.capabilityId,
  issuedAtUnixMs: row.issuedAtUnixMs,
  expiresAtUnixMs: row.expiresAtUnixMs,
  ...(row.revokedAtUnixMs === null ? {} : { revokedAtUnixMs: row.revokedAtUnixMs }),
});

const toAudit = (
  row: Schema.Schema.Type<typeof AuditRowSchema>,
): CompositionCapabilityAuditEvent => ({
  auditId: row.auditId,
  grantId: row.grantId,
  taskId: row.taskId,
  runId: row.runId,
  agentId: row.agentId,
  capabilityId: row.capabilityId,
  operation: row.operation as CompositionCapabilityOperation,
  outcome: row.outcome as CompositionCapabilityAuditOutcome,
  ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  occurredAtUnixMs: row.occurredAtUnixMs,
});

const persistenceError = (operation: string, cause: unknown) =>
  new CapabilityGrantPersistenceError({
    operation,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
const isCapabilityGrantPersistenceError = Schema.is(CapabilityGrantPersistenceError);

export const makeSqliteCapabilityGrantRegistry = (
  options: SqlCapabilityGrantRegistryOptions,
): CapabilityGrantRegistryShape => {
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? NodeCrypto.randomUUID;
  const sql = options.sql;

  const findGrant = SqlSchema.findOneOption({
    Request: Schema.Struct({ grantId: Schema.String }),
    Result: GrantRowSchema,
    execute: ({ grantId }) => sql`
      SELECT
        grant_id AS "grantId", task_id AS "taskId", agent_id AS "agentId",
        capability_id AS "capabilityId", issued_at_unix_ms AS "issuedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", revoked_at_unix_ms AS "revokedAtUnixMs"
      FROM composition_capability_grants
      WHERE grant_id = ${grantId}
      LIMIT 1
    `,
  });

  const findActiveGrant = SqlSchema.findOneOption({
    Request: Schema.Struct({
      taskId: Schema.String,
      agentId: Schema.String,
      capabilityId: Schema.String,
      minimumExpiresAtUnixMs: Schema.Number,
    }),
    Result: GrantRowSchema,
    execute: ({ taskId, agentId, capabilityId, minimumExpiresAtUnixMs }) => sql`
      SELECT
        grant_id AS "grantId", task_id AS "taskId", agent_id AS "agentId",
        capability_id AS "capabilityId", issued_at_unix_ms AS "issuedAtUnixMs",
        expires_at_unix_ms AS "expiresAtUnixMs", revoked_at_unix_ms AS "revokedAtUnixMs"
      FROM composition_capability_grants
      WHERE task_id = ${taskId}
        AND agent_id = ${agentId}
        AND capability_id = ${capabilityId}
        AND revoked_at_unix_ms IS NULL
        AND expires_at_unix_ms > ${minimumExpiresAtUnixMs}
      ORDER BY issued_at_unix_ms DESC, grant_id ASC
      LIMIT 1
    `,
  });

  const insertGrant = SqlSchema.void({
    Request: Schema.Struct({
      grantId: Schema.String,
      taskId: Schema.String,
      agentId: Schema.String,
      capabilityId: Schema.String,
      issuedAtUnixMs: Schema.Number,
      expiresAtUnixMs: Schema.Number,
    }),
    execute: (grant) => sql`
      INSERT INTO composition_capability_grants (
        grant_id, task_id, agent_id, capability_id,
        issued_at_unix_ms, expires_at_unix_ms, revoked_at_unix_ms
      ) VALUES (
        ${grant.grantId}, ${grant.taskId}, ${grant.agentId}, ${grant.capabilityId},
        ${grant.issuedAtUnixMs}, ${grant.expiresAtUnixMs}, NULL
      )
    `,
  });

  const revokeGrant = SqlSchema.void({
    Request: Schema.Struct({ grantId: Schema.String, revokedAtUnixMs: Schema.Number }),
    execute: ({ grantId, revokedAtUnixMs }) => sql`
      UPDATE composition_capability_grants
      SET revoked_at_unix_ms = ${revokedAtUnixMs}
      WHERE grant_id = ${grantId} AND revoked_at_unix_ms IS NULL
    `,
  });

  const insertAudit = SqlSchema.void({
    Request: Schema.Struct({
      auditId: Schema.String,
      grantId: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      agentId: Schema.String,
      capabilityId: Schema.String,
      operation: Schema.String,
      outcome: Schema.String,
      errorCode: Schema.NullOr(Schema.String),
      occurredAtUnixMs: Schema.Number,
    }),
    execute: (event) => sql`
      INSERT INTO composition_capability_audit (
        audit_id, grant_id, task_id, run_id, agent_id, capability_id,
        operation, outcome, error_code, occurred_at_unix_ms
      ) VALUES (
        ${event.auditId}, ${event.grantId}, ${event.taskId}, ${event.runId},
        ${event.agentId}, ${event.capabilityId}, ${event.operation}, ${event.outcome},
        ${event.errorCode}, ${event.occurredAtUnixMs}
      )
    `,
  });

  const insertAuditIfNew = SqlSchema.findOneOption({
    Request: Schema.Struct({
      auditId: Schema.String,
      grantId: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      agentId: Schema.String,
      capabilityId: Schema.String,
      operation: Schema.String,
      outcome: Schema.String,
      errorCode: Schema.NullOr(Schema.String),
      occurredAtUnixMs: Schema.Number,
    }),
    Result: Schema.Struct({ auditId: Schema.String }),
    execute: (event) => sql`
      INSERT INTO composition_capability_audit (
        audit_id, grant_id, task_id, run_id, agent_id, capability_id,
        operation, outcome, error_code, occurred_at_unix_ms
      ) VALUES (
        ${event.auditId}, ${event.grantId}, ${event.taskId}, ${event.runId},
        ${event.agentId}, ${event.capabilityId}, ${event.operation}, ${event.outcome},
        ${event.errorCode}, ${event.occurredAtUnixMs}
      )
      ON CONFLICT (audit_id) DO NOTHING
      RETURNING audit_id AS "auditId"
    `,
  });

  const findAuditById = SqlSchema.findOneOption({
    Request: Schema.Struct({ auditId: Schema.String }),
    Result: AuditRowSchema,
    execute: ({ auditId }) => sql`
      SELECT
        audit_id AS "auditId", grant_id AS "grantId", task_id AS "taskId",
        run_id AS "runId", agent_id AS "agentId", capability_id AS "capabilityId",
        operation, outcome, error_code AS "errorCode", occurred_at_unix_ms AS "occurredAtUnixMs"
      FROM composition_capability_audit
      WHERE audit_id = ${auditId}
      LIMIT 1
    `,
  });

  const listAuditRows = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: Schema.String }),
    Result: AuditRowSchema,
    execute: ({ taskId }) => sql`
      SELECT
        audit_id AS "auditId", grant_id AS "grantId", task_id AS "taskId",
        run_id AS "runId", agent_id AS "agentId", capability_id AS "capabilityId",
        operation, outcome, error_code AS "errorCode", occurred_at_unix_ms AS "occurredAtUnixMs"
      FROM composition_capability_audit
      WHERE task_id = ${taskId}
      ORDER BY occurred_at_unix_ms ASC, audit_id ASC
    `,
  });

  const issue: CapabilityGrantRegistryShape["issue"] = Effect.fn(
    "CapabilityGrantRegistry.sqliteIssue",
  )(function* (input) {
    const normalized = yield* normalizeCapabilityGrantIssueInput(input, now());
    const { taskId, agentId, capabilityIds, issuedAtUnixMs, expiresAtUnixMs } = normalized;

    yield* options.capabilityRegistry
      .resolveRequired({ scope: "task", scopeId: taskId, capabilityIds })
      .pipe(
        Effect.catchTag("CapabilityNotAvailableError", (error) =>
          Effect.fail(
            new CapabilityGrantInvalidError({
              reason: `capability_not_available:${error.capabilityId}`,
            }),
          ),
        ),
      );

    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const result: CompositionCapabilityGrant[] = [];
          for (const capabilityId of capabilityIds) {
            const existing = yield* findActiveGrant({
              taskId,
              agentId,
              capabilityId,
              minimumExpiresAtUnixMs: issuedAtUnixMs + normalized.minimumRemainingMs,
            }).pipe(Effect.mapError((cause) => persistenceError("findActiveGrant", cause)));
            if (existing._tag === "Some") {
              result.push(toGrant(existing.value));
              continue;
            }
            const grant = {
              grantId: `grant-${randomUUID()}`,
              taskId,
              agentId,
              capabilityId,
              issuedAtUnixMs,
              expiresAtUnixMs,
            } satisfies CompositionCapabilityGrant;
            yield* insertGrant(grant).pipe(
              Effect.mapError((cause) => persistenceError("insertGrant", cause)),
            );
            result.push(grant);
          }
          return result;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isCapabilityGrantPersistenceError(cause)
            ? cause
            : persistenceError("issueTransaction", cause),
        ),
      );
  });

  const validate: CapabilityGrantRegistryShape["validate"] = Effect.fn(
    "CapabilityGrantRegistry.sqliteValidate",
  )(function* (input) {
    const row = yield* findGrant({ grantId: input.grantId }).pipe(
      Effect.mapError((cause) => persistenceError("findGrant", cause)),
    );
    if (row._tag === "None") {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    const grant = toGrant(row.value);
    if (
      grant.taskId !== input.taskId ||
      grant.agentId !== input.agentId ||
      grant.capabilityId !== input.capabilityId
    ) {
      return yield* new CapabilityGrantScopeMismatchError({ grantId: input.grantId });
    }
    if (grant.revokedAtUnixMs !== undefined) {
      return yield* new CapabilityGrantRevokedError({ grantId: input.grantId });
    }
    if (grant.expiresAtUnixMs <= now()) {
      return yield* new CapabilityGrantExpiredError({ grantId: input.grantId });
    }
    return grant;
  });

  const validateForRecovery: CapabilityGrantRegistryShape["validateForRecovery"] = Effect.fn(
    "CapabilityGrantRegistry.validateForRecovery",
  )(function* (input) {
    const grant = yield* validate(input);
    yield* options.capabilityRegistry.resolveRequired({
      scope: "task",
      scopeId: input.taskId,
      capabilityIds: [input.capabilityId],
    });
    return grant;
  });

  const revoke: CapabilityGrantRegistryShape["revoke"] = Effect.fn(
    "CapabilityGrantRegistry.sqliteRevoke",
  )(function* (input) {
    const existing = yield* findGrant({ grantId: input.grantId }).pipe(
      Effect.mapError((cause) => persistenceError("findGrantForRevoke", cause)),
    );
    if (existing._tag === "None") {
      return yield* new CapabilityGrantNotFoundError({ grantId: input.grantId });
    }
    yield* revokeGrant({ grantId: input.grantId, revokedAtUnixMs: now() }).pipe(
      Effect.mapError((cause) => persistenceError("revokeGrant", cause)),
    );
  });

  const recordAudit: CapabilityGrantRegistryShape["recordAudit"] = Effect.fn(
    "CapabilityGrantRegistry.sqliteRecordAudit",
  )(function* (input) {
    const event = {
      auditId: `audit-${randomUUID()}`,
      grantId: input.grantId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      operation: input.operation,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      occurredAtUnixMs: now(),
    };
    yield* insertAudit(event).pipe(
      Effect.mapError((cause) => persistenceError("insertAudit", cause)),
    );
  });

  const recordAuditIfNew: CapabilityGrantRegistryShape["recordAuditIfNew"] = Effect.fn(
    "CapabilityGrantRegistry.sqliteRecordAuditIfNew",
  )(function* (input) {
    const inserted = yield* insertAuditIfNew({
      auditId: input.auditId,
      grantId: input.grantId,
      taskId: input.taskId,
      runId: input.runId,
      agentId: input.agentId,
      capabilityId: input.capabilityId,
      operation: input.operation,
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
      occurredAtUnixMs: now(),
    }).pipe(Effect.mapError((cause) => persistenceError("insertAuditIfNew", cause)));
    return Option.isSome(inserted);
  });

  return {
    issue,
    validate,
    validateForRecovery,
    revoke,
    recordAudit,
    recordAuditIfNew,
    getAuditById: (input) =>
      findAuditById(input).pipe(
        Effect.map(Option.map(toAudit)),
        Effect.mapError((cause) => persistenceError("findAuditById", cause)),
      ),
    listAudit: (input) =>
      listAuditRows(input).pipe(
        Effect.map((rows) => rows.map(toAudit)),
        Effect.mapError((cause) => persistenceError("listAudit", cause)),
      ),
  } satisfies CapabilityGrantRegistryShape;
};

const live = Effect.gen(function* () {
  const capabilityRegistry = yield* CapabilityRegistry.CapabilityRegistry;
  const sql = yield* SqlClient.SqlClient;
  return CapabilityGrantRegistry.of(makeSqliteCapabilityGrantRegistry({ capabilityRegistry, sql }));
});

export const layer = Layer.effect(CapabilityGrantRegistry, live);
