import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  CompositionTaskInputStore,
  CompositionTaskInputStoreError,
  type CompositionTaskInputStoreShape,
  type CompositionTaskRecoveryInput,
} from "../Services/CompositionTaskInputStore.ts";

const SECRET_NAME = "composition-task-input-key";
const ENCRYPTION_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;

const InputPayloadSchema = Schema.Struct({
  taskId: Schema.String,
  agentId: Schema.optional(Schema.String),
  prompt: Schema.String,
  promptDigest: Schema.optional(Schema.String),
  workspaceRoot: Schema.String,
  workspaceRootDigest: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  capabilityIds: Schema.optional(Schema.Array(Schema.String)),
  implementationAssigneeId: Schema.optional(Schema.String),
  independentVerifierId: Schema.optional(Schema.String),
});

const EncryptedPayloadSchema = Schema.Struct({
  version: Schema.Literal(ENCRYPTION_VERSION),
  iv: Schema.String,
  authTag: Schema.String,
  ciphertext: Schema.String,
});

const InputRowSchema = Schema.Struct({
  taskId: Schema.String,
  encryptedPayload: Schema.String,
});

const InputRequest = Schema.Struct({ taskId: Schema.String });

const encodeJson = (value: unknown): string => JSON.stringify(value);
const decodeJson = (value: string): unknown => JSON.parse(value) as unknown;

const makeError = (operation: string, error: unknown) =>
  new CompositionTaskInputStoreError({
    operation,
    detail: error instanceof Error ? error.message : String(error),
  });

const encryptPayload = (key: Uint8Array, input: CompositionTaskRecoveryInput): string => {
  const iv = NodeCrypto.randomBytes(IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(key), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(encodeJson(input), "utf8")),
    cipher.final(),
  ]);
  return encodeJson({
    version: ENCRYPTION_VERSION,
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
};

const decryptPayload = (
  key: Uint8Array,
  taskId: string,
  encryptedPayload: string,
): CompositionTaskRecoveryInput => {
  const payload = Schema.decodeUnknownSync(EncryptedPayloadSchema)(decodeJson(encryptedPayload));
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    Buffer.from(key),
    Buffer.from(payload.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const input = Schema.decodeUnknownSync(InputPayloadSchema)(decodeJson(plaintext));
  if (input.taskId !== taskId) throw new Error("加密输入的 taskId 不匹配。");
  return {
    taskId: input.taskId,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    prompt: input.prompt,
    ...(input.promptDigest === undefined ? {} : { promptDigest: input.promptDigest }),
    workspaceRoot: input.workspaceRoot,
    ...(input.workspaceRootDigest === undefined
      ? {}
      : { workspaceRootDigest: input.workspaceRootDigest }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.capabilityIds === undefined ? {} : { capabilityIds: [...input.capabilityIds] }),
    ...(input.implementationAssigneeId === undefined
      ? {}
      : { implementationAssigneeId: input.implementationAssigneeId }),
    ...(input.independentVerifierId === undefined
      ? {}
      : { independentVerifierId: input.independentVerifierId }),
  };
};

export const CompositionTaskInputStoreLive = Layer.effect(
  CompositionTaskInputStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const key = yield* secretStore.getOrCreateRandom(SECRET_NAME, KEY_BYTES);

    const upsertRow = SqlSchema.void({
      Request: Schema.Struct({
        taskId: Schema.String,
        encryptedPayload: Schema.String,
      }),
      execute: (input) => sql`
        INSERT INTO composition_task_inputs (
          task_id, encrypted_payload, created_at_unix_ms, updated_at_unix_ms
        ) VALUES (
          ${input.taskId}, ${input.encryptedPayload}, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000
        )
        ON CONFLICT (task_id) DO UPDATE SET
          encrypted_payload = excluded.encrypted_payload,
          updated_at_unix_ms = excluded.updated_at_unix_ms
      `,
    });
    const getRow = SqlSchema.findOneOption({
      Request: InputRequest,
      Result: InputRowSchema,
      execute: ({ taskId }) => sql`
        SELECT task_id AS "taskId", encrypted_payload AS "encryptedPayload"
        FROM composition_task_inputs
        WHERE task_id = ${taskId}
        LIMIT 1
      `,
    });
    const deleteRow = SqlSchema.void({
      Request: InputRequest,
      execute: ({ taskId }) => sql`
        DELETE FROM composition_task_inputs WHERE task_id = ${taskId}
      `,
    });
    const runSql = <A>(
      operation: string,
      effect: Effect.Effect<A, SqlError | Schema.SchemaError>,
    ) => effect.pipe(Effect.mapError((error) => makeError(operation, error)));

    const store: CompositionTaskInputStoreShape = {
      save: (input) =>
        Effect.try({
          try: () => encryptPayload(key, input),
          catch: (error) => makeError("encrypt", error),
        }).pipe(
          Effect.flatMap((encryptedPayload) =>
            runSql(
              "CompositionTaskInputStore.save",
              upsertRow({ taskId: input.taskId, encryptedPayload }),
            ),
          ),
          Effect.asVoid,
        ),
      get: (taskId) =>
        runSql("CompositionTaskInputStore.get", getRow({ taskId })).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (row) =>
                Effect.try({
                  try: () => Option.some(decryptPayload(key, taskId, row.encryptedPayload)),
                  catch: (error) => makeError("decrypt", error),
                }),
            }),
          ),
        ),
      remove: (taskId) =>
        runSql("CompositionTaskInputStore.remove", deleteRow({ taskId })).pipe(Effect.asVoid),
    };

    return store;
  }),
);
