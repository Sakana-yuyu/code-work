import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import {
  makeCapabilityGrantRegistry,
  makeSqliteCapabilityGrantRegistry,
} from "./CapabilityGrantRegistry.ts";
import { CapabilityNotGrantedError, makeCompositionCapabilityPolicy } from "./CapabilityPolicy.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

describe("CapabilityPolicy", () => {
  it("只允许当前 task/agent 的有效 grant，并返回过期时间", async () => {
    let now = 1000;
    const capabilityRegistry = makeCompositionCapabilityRegistry();
    const grantRegistry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => now });
    const policy = makeCompositionCapabilityPolicy({ capabilityRegistry, grantRegistry });
    const [grant] = await Effect.runPromise(
      grantRegistry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 100,
      }),
    );

    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: [grant!.grantId],
          operation: "read",
          idempotencyKey: "read-1",
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow", expiresAtUnixMs: 1100 });

    now = 1100;
    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: [grant!.grantId],
          operation: "read",
          idempotencyKey: "read-1",
        }),
      ),
    ).rejects.toBeInstanceOf(CapabilityNotGrantedError);
  });

  it("在迁移期保留直接 capability ID，并标记 legacy 决策", async () => {
    const capabilityRegistry = makeCompositionCapabilityRegistry();
    const policy = makeCompositionCapabilityPolicy({
      capabilityRegistry,
    });

    await expect(
      Effect.runPromise(
        policy.evaluate({
          taskId: "task-1",
          runId: "run-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
          capabilityGrantIds: ["t3.workspace.read_file"],
          operation: "read",
          idempotencyKey: "legacy-read-1",
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow", reasonCode: "legacy_capability_grant" });
  });

  effectIt.effect("跨 Policy 重建恢复批准，并且已消费审批不能再次授权", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capabilityRegistry = makeCompositionCapabilityRegistry();
      let sequence = 0;
      const registryOptions = {
        capabilityRegistry,
        sql,
        now: () => 1000,
        randomUUID: () => `policy-${++sequence}`,
      };
      const grantRegistry = makeSqliteCapabilityGrantRegistry(registryOptions);
      const [grant] = yield* grantRegistry.issue({
        taskId: "task-restart",
        agentId: "agent-restart",
        capabilityIds: ["t3.workspace.write_file"],
      });
      const input = {
        taskId: "task-restart",
        runId: "run-restart",
        agentId: "agent-restart",
        capabilityId: "t3.workspace.write_file",
        capabilityGrantIds: [grant!.grantId],
        operation: "mutate" as const,
        idempotencyKey: "write-restart-1",
      };

      const firstPolicy = makeCompositionCapabilityPolicy({ capabilityRegistry, grantRegistry });
      const requested = yield* firstPolicy.evaluate(input);
      const repeated = yield* firstPolicy.evaluate(input);
      expect(requested).toMatchObject({ decision: "approval_required" });
      expect(repeated).toMatchObject({
        decision: "approval_required",
        approvalRequestId: requested.approvalRequestId,
      });

      yield* firstPolicy.approve({ approvalRequestId: requested.approvalRequestId! });
      yield* firstPolicy.approve({ approvalRequestId: requested.approvalRequestId! });

      const restartedGrantRegistry = makeSqliteCapabilityGrantRegistry(registryOptions);
      const restartedPolicy = makeCompositionCapabilityPolicy({
        capabilityRegistry,
        grantRegistry: restartedGrantRegistry,
      });
      const tampered = yield* Effect.flip(
        restartedPolicy.evaluate({
          ...input,
          idempotencyKey: "write-restart-tampered",
          approvalRequestId: requested.approvalRequestId,
        }),
      );
      expect(tampered).toMatchObject({
        _tag: "CapabilityPolicyInvalidError",
        reason: "approval_scope_mismatch",
      });

      const allowed = yield* restartedPolicy.evaluate({
        ...input,
        approvalRequestId: requested.approvalRequestId,
      });
      expect(allowed).toMatchObject({ decision: "allow", reasonCode: "approval_granted" });

      const secondRestart = makeCompositionCapabilityPolicy({
        capabilityRegistry,
        grantRegistry: makeSqliteCapabilityGrantRegistry(registryOptions),
      });
      const consumed = yield* Effect.flip(
        secondRestart.evaluate({
          ...input,
          approvalRequestId: requested.approvalRequestId,
        }),
      );
      expect(consumed).toMatchObject({
        _tag: "CapabilityPolicyInvalidError",
        reason: "approval_request_consumed",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
