// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CompositionToolInvocationStore,
  CompositionToolInvocationStoreDomainError,
  type CompositionToolInvocationPrepareInput,
} from "../Services/CompositionToolInvocationStore.ts";
import { CompositionToolInvocationStoreLive } from "./CompositionToolInvocationStore.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CompositionToolInvocationStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const makePrepareInput = (
  idempotencyKey: string,
  overrides: Partial<CompositionToolInvocationPrepareInput> = {},
): CompositionToolInvocationPrepareInput => ({
  idempotencyKey,
  taskId: `task-${idempotencyKey}`,
  runId: `run-${idempotencyKey}`,
  agentId: `agent-${idempotencyKey}`,
  toolCallId: `tool-call-${idempotencyKey}`,
  canonicalToolName: "filesystem.read",
  operation: "read",
  argumentsDigest: "sha256:arguments",
  scopeDigest: "sha256:scope",
  createdAtUnixMs: 100,
  ...overrides,
});

const isDomainError = Schema.is(CompositionToolInvocationStoreDomainError);
const errorCode = (error: unknown): string | undefined =>
  isDomainError(error) ? error.code : undefined;

const makeFileStoreLayer = (dbPath: string) =>
  CompositionToolInvocationStoreLive.pipe(
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

layer("CompositionToolInvocationStore", (it) => {
  it.effect("prepare 对同一身份幂等，并拒绝幂等键或 run/tool-call 身份漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const input = makePrepareInput("tool-invocation-prepare");

      const prepared = yield* store.prepareInvocation(input);
      const replayed = yield* store.prepareInvocation({ ...input, createdAtUnixMs: 999 });
      const keyDrift = yield* store
        .prepareInvocation({ ...input, operation: "write" })
        .pipe(Effect.flip);
      const runToolDrift = yield* store
        .prepareInvocation(
          makePrepareInput("tool-invocation-other-key", {
            runId: input.runId,
            toolCallId: input.toolCallId,
          }),
        )
        .pipe(Effect.flip);

      assert.deepEqual(prepared, {
        ...input,
        status: "prepared",
        revision: 1,
        outcomeCode: null,
        updatedAtUnixMs: input.createdAtUnixMs,
        claimedAtUnixMs: null,
        finishedAtUnixMs: null,
      });
      assert.deepEqual(replayed, prepared);
      assert.equal(errorCode(keyDrift), "tool_invocation_identity_conflict");
      assert.equal(errorCode(runToolDrift), "tool_invocation_identity_conflict");
    }),
  );

  it.effect("claim 只推进 prepared，终态 CAS 可安全重放且拒绝终态漂移", () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const input = makePrepareInput("tool-invocation-terminal");
      yield* store.prepareInvocation(input);

      const claimed = yield* store.claimPrepared({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 110,
      });
      const repeatedClaim = yield* store.claimPrepared({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 111,
      });
      const terminalInput = {
        idempotencyKey: input.idempotencyKey,
        expectedRevision: 2,
        status: "succeeded" as const,
        outcomeCode: null,
        finishedAtUnixMs: 120,
      };
      const succeeded = yield* store.saveTerminal(terminalInput);
      const replayed = yield* store.saveTerminal(terminalInput);
      const drifted = yield* store
        .saveTerminal({
          ...terminalInput,
          status: "failed",
          outcomeCode: "tool_failed",
        })
        .pipe(Effect.flip);

      assert.isTrue(claimed.claimed);
      assert.equal(claimed.invocation.status, "executing");
      assert.equal(claimed.invocation.revision, 2);
      assert.isFalse(repeatedClaim.claimed);
      assert.deepEqual(repeatedClaim.invocation, claimed.invocation);
      assert.equal(succeeded.status, "succeeded");
      assert.equal(succeeded.revision, 3);
      assert.deepEqual(replayed, succeeded);
      assert.equal(errorCode(drifted), "tool_invocation_terminal_conflict");
    }),
  );

  it.effect("executing 与 unknown 均 fail-closed，unknown 可按稳定顺序有限列出", () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const older = makePrepareInput("tool-invocation-unknown-older", {
        createdAtUnixMs: 100,
      });
      const newer = makePrepareInput("tool-invocation-unknown-newer", {
        createdAtUnixMs: 200,
      });
      yield* store.prepareInvocation(older);
      yield* store.prepareInvocation(newer);
      yield* store.claimPrepared({
        idempotencyKey: older.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 110,
      });
      yield* store.claimPrepared({
        idempotencyKey: newer.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 210,
      });

      const executingReplay = yield* store.claimPrepared({
        idempotencyKey: newer.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 220,
      });
      const olderUnknown = yield* store.saveTerminal({
        idempotencyKey: older.idempotencyKey,
        expectedRevision: 2,
        status: "unknown",
        outcomeCode: "tool_result_indeterminate",
        finishedAtUnixMs: 120,
      });
      const newerUnknown = yield* store.saveTerminal({
        idempotencyKey: newer.idempotencyKey,
        expectedRevision: 2,
        status: "unknown",
        outcomeCode: "tool_result_indeterminate",
        finishedAtUnixMs: 220,
      });
      const unknownReplay = yield* store.claimPrepared({
        idempotencyKey: older.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 130,
      });
      const unknown = yield* store.listUnknownInvocations({ limit: 10 });
      const invalidLimit = yield* store.listUnknownInvocations({ limit: 201 }).pipe(Effect.flip);

      assert.isFalse(executingReplay.claimed);
      assert.equal(executingReplay.invocation.status, "executing");
      assert.equal(olderUnknown.status, "unknown");
      assert.equal(newerUnknown.status, "unknown");
      assert.isFalse(unknownReplay.claimed);
      assert.equal(unknownReplay.invocation.status, "unknown");
      assert.deepEqual(
        unknown.map((invocation) => invocation.idempotencyKey),
        [older.idempotencyKey, newer.idempotencyKey],
      );
      assert.equal(errorCode(invalidLimit), "tool_invocation_list_limit_invalid");
    }),
  );

  it.effect("持久化结构仅含身份摘要与受控结果码，不落原始参数或运行环境", () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      const sql = yield* SqlClient.SqlClient;
      const input = makePrepareInput("tool-invocation-redaction", {
        argumentsDigest: "sha256:redacted-arguments",
        scopeDigest: "sha256:redacted-scope",
      });
      yield* store.prepareInvocation(input);

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info('composition_tool_invocations')
      `;
      const rows = yield* sql<Record<string, unknown>>`
        SELECT *
        FROM composition_tool_invocations
        WHERE idempotency_key = ${input.idempotencyKey}
      `;
      const names = new Set(columns.map((column) => column.name));
      const serialized = Object.values(rows[0] ?? {}).join("\n");

      assert.isFalse(names.has("arguments"));
      assert.isFalse(names.has("arguments_json"));
      assert.isFalse(names.has("workspace_root"));
      assert.isFalse(names.has("environment_json"));
      assert.isFalse(names.has("secret"));
      assert.include(serialized, input.argumentsDigest);
      assert.include(serialized, input.scopeDigest);
      assert.notInclude(serialized, "sk-live-never-persist");
      assert.notInclude(serialized, "E:/private/workspace-root");
    }),
  );
});

it.effect("同一 SQLite 文件重建 Layer 后 prepared 仍可 claim，双连接竞争仅一个胜者", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-tool-invocation-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const input = makePrepareInput("tool-invocation-file-claim");
  const claimFromConnection = () =>
    Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      return yield* store.claimPrepared({
        idempotencyKey: input.idempotencyKey,
        expectedRevision: 1,
        claimedAtUnixMs: 110,
      });
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      yield* store.prepareInvocation(input);
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));

    const restored = yield* Effect.gen(function* () {
      const store = yield* CompositionToolInvocationStore;
      return Option.getOrThrow(yield* store.getInvocation(input.idempotencyKey));
    }).pipe(Effect.provide(makeFileStoreLayer(dbPath)));
    assert.equal(restored.status, "prepared");

    const claims = yield* Effect.all([claimFromConnection(), claimFromConnection()], {
      concurrency: "unbounded",
    });
    assert.deepEqual(claims.map((claim) => claim.claimed).sort(), [false, true]);
    assert.isTrue(claims.every((claim) => claim.invocation.status === "executing"));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
