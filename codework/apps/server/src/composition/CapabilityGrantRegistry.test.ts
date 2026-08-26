import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeCapabilityGrantRegistry,
  makeSqliteCapabilityGrantRegistry,
} from "./CapabilityGrantRegistry.ts";
import { makeCompositionCapabilityRegistry } from "./CapabilityRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

describe("CapabilityGrantRegistry", () => {
  it("为 task/agent 签发幂等短期 grant，并校验作用域", async () => {
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => 1000,
    });

    const first = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      }),
    );
    const second = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      }),
    );

    expect(first).toHaveLength(1);
    expect(second[0]?.grantId).toBe(first[0]?.grantId);
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: first[0]!.grantId,
          taskId: "task-1",
          agentId: "agent-2",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantScopeMismatchError" });
  });

  it("拒绝过期或已撤销 grant", async () => {
    let now = 1000;
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => now,
    });
    const [grant] = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 100,
      }),
    );

    now = 1100;
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantExpiredError" });

    now = 1000;
    await Effect.runPromise(registry.revoke({ grantId: grant!.grantId }));
    await expect(
      Effect.runPromise(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "CapabilityGrantRevokedError" });
  });

  it("记录不包含 arguments 的工具审计事件", async () => {
    const registry = makeCapabilityGrantRegistry({
      capabilityRegistry: makeCompositionCapabilityRegistry(),
      now: () => 1000,
    });
    const [grant] = await Effect.runPromise(
      registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
      }),
    );

    await Effect.runPromise(
      registry.recordAudit({
        grantId: grant!.grantId,
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityId: "t3.workspace.read_file",
        operation: "read",
        outcome: "allowed",
      }),
    );
    const events = await Effect.runPromise(registry.listAudit({ taskId: "task-1" }));
    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).arguments).toBeUndefined();
  });

  it("SQLite Registry 在新实例中恢复 grant、撤销状态和审计记录", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const capabilityRegistry = makeCompositionCapabilityRegistry();
        let sequence = 0;
        const options = {
          capabilityRegistry,
          sql,
          now: () => 1000,
          randomUUID: () => `test-${++sequence}`,
        };
        const first = makeSqliteCapabilityGrantRegistry(options);
        const [grant] = yield* first.issue({
          taskId: "task-sqlite",
          agentId: "agent-sqlite",
          capabilityIds: ["t3.workspace.read_file"],
          ttlMs: 5000,
        });
        if (grant === undefined) throw new Error("测试预期已签发 grant。");

        const restarted = makeSqliteCapabilityGrantRegistry(options);
        const duplicate = yield* restarted.issue({
          taskId: "task-sqlite",
          agentId: "agent-sqlite",
          capabilityIds: ["t3.workspace.read_file"],
          ttlMs: 5000,
        });
        if (duplicate[0] === undefined) throw new Error("测试预期重复 issue 返回原 grant。");
        if (duplicate[0].grantId !== grant.grantId) {
          throw new Error("重复 issue 未复用现有未过期 grant。");
        }
        const restored = yield* restarted.validate({
          grantId: grant.grantId,
          taskId: grant.taskId,
          agentId: grant.agentId,
          capabilityId: grant.capabilityId,
        });
        yield* restarted.recordAudit({
          grantId: restored.grantId,
          taskId: restored.taskId,
          runId: "run-sqlite",
          agentId: restored.agentId,
          capabilityId: restored.capabilityId,
          operation: "read",
          outcome: "allowed",
        });
        const audit = yield* first.listAudit({ taskId: "task-sqlite" });
        yield* restarted.revoke({ grantId: restored.grantId });
        const afterRevoke = makeSqliteCapabilityGrantRegistry(options);
        const revoked = yield* Effect.flip(
          afterRevoke.validate({
            grantId: restored.grantId,
            taskId: restored.taskId,
            agentId: restored.agentId,
            capabilityId: restored.capabilityId,
          }),
        );
        return { restored, audit, revoked };
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    expect(result.restored.grantId).toBe("grant-test-1");
    expect(result.audit).toHaveLength(1);
    expect(result.audit[0]?.runId).toBe("run-sqlite");
    expect(result.revoked._tag).toBe("CapabilityGrantRevokedError");
  });
});
