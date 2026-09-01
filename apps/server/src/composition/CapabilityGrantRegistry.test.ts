import type { CompositionCapabilityDescriptor } from "@codework/contracts";
import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeCapabilityGrantRegistry,
  makeSqliteCapabilityGrantRegistry,
} from "./CapabilityGrantRegistry.ts";
import {
  CapabilityRegistryUnavailableError,
  makeCompositionCapabilityRegistry,
} from "./CapabilityRegistry.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const makeMcpCapability = (
  capabilityId: string,
  status: CompositionCapabilityDescriptor["status"] = "available",
): CompositionCapabilityDescriptor => ({
  capabilityId,
  kind: "mcp",
  version: "1",
  status,
  grants: { read: true, execute: true, mutate: false },
  approval: "never",
  source: "runtime",
});

describe("CapabilityGrantRegistry", () => {
  effectIt.effect("为 task/agent 签发幂等短期 grant，并校验作用域", () =>
    Effect.gen(function* () {
      const registry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => 1000,
      });

      const first = yield* registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      });
      const second = yield* registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      });

      expect(first).toHaveLength(1);
      expect(second[0]?.grantId).toBe(first[0]?.grantId);
      const error = yield* Effect.flip(
        registry.validate({
          grantId: first[0]!.grantId,
          taskId: "task-1",
          agentId: "agent-2",
          capabilityId: "t3.workspace.read_file",
        }),
      );
      expect(error).toMatchObject({ _tag: "CapabilityGrantScopeMismatchError" });
    }),
  );

  effectIt.effect("剩余有效期不足时签发新 grant，不复用即将过期的授权", () =>
    Effect.gen(function* () {
      let now = 1000;
      const registry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => now,
      });
      const [first] = yield* registry.issue({
        taskId: "task-minimum-remaining",
        agentId: "agent-minimum-remaining",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      });

      now = 4500;
      const [replacement] = yield* registry.issue({
        taskId: "task-minimum-remaining",
        agentId: "agent-minimum-remaining",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
        minimumRemainingMs: 2000,
      });

      expect(replacement?.grantId).not.toBe(first?.grantId);
      expect(replacement?.expiresAtUnixMs).toBe(9500);
    }),
  );

  effectIt.effect("剩余有效期恰好等于门槛时也签发新 grant", () =>
    Effect.gen(function* () {
      let now = 1000;
      const registry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => now,
      });
      const [first] = yield* registry.issue({
        taskId: "task-minimum-boundary",
        agentId: "agent-minimum-boundary",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      });

      now = 3999;
      const [stillReusable] = yield* registry.issue({
        taskId: "task-minimum-boundary",
        agentId: "agent-minimum-boundary",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
        minimumRemainingMs: 2000,
      });
      now = 4000;
      const [replacement] = yield* registry.issue({
        taskId: "task-minimum-boundary",
        agentId: "agent-minimum-boundary",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
        minimumRemainingMs: 2000,
      });

      expect(stillReusable?.grantId).toBe(first?.grantId);
      expect(replacement?.grantId).not.toBe(first?.grantId);
      expect(replacement?.expiresAtUnixMs).toBe(9000);
    }),
  );

  effectIt.effect("拒绝非有限、非整数或越界的 grant 时效输入", () =>
    Effect.gen(function* () {
      const invalidInputs = [
        { ttlMs: Number.NaN },
        { ttlMs: Number.POSITIVE_INFINITY },
        { ttlMs: -1 },
        { ttlMs: 1.5 },
        { ttlMs: Number.MAX_SAFE_INTEGER + 1 },
        { ttlMs: 5000, minimumRemainingMs: -1 },
        { ttlMs: 5000, minimumRemainingMs: 1.5 },
        { ttlMs: 5000, minimumRemainingMs: Number.POSITIVE_INFINITY },
        { ttlMs: 2000, minimumRemainingMs: 2000 },
      ];

      for (const [index, invalidInput] of invalidInputs.entries()) {
        const registry = makeCapabilityGrantRegistry({
          capabilityRegistry: makeCompositionCapabilityRegistry(),
          now: () => 1000,
        });
        const error = yield* Effect.flip(
          registry.issue({
            taskId: `task-invalid-duration-${index}`,
            agentId: "agent-invalid-duration",
            capabilityIds: ["t3.workspace.read_file"],
            ...invalidInput,
          }),
        );
        expect(error).toMatchObject({
          _tag: "CapabilityGrantInvalidError",
          reason: "grant_input_invalid",
        });
      }

      const overflowRegistry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => Number.MAX_SAFE_INTEGER - 10,
      });
      const overflow = yield* Effect.flip(
        overflowRegistry.issue({
          taskId: "task-duration-overflow",
          agentId: "agent-duration-overflow",
          capabilityIds: ["t3.workspace.read_file"],
          ttlMs: 20,
        }),
      );
      expect(overflow).toMatchObject({
        _tag: "CapabilityGrantInvalidError",
        reason: "grant_input_invalid",
      });
    }),
  );

  effectIt.effect("拒绝空值或重复的 capability grant 输入", () =>
    Effect.gen(function* () {
      const invalidCapabilityIds = [
        [] as ReadonlyArray<string>,
        [" "],
        ["t3.workspace.read_file", " "],
        ["t3.workspace.read_file", "t3.workspace.read_file"],
      ];

      for (const [index, capabilityIds] of invalidCapabilityIds.entries()) {
        const registry = makeCapabilityGrantRegistry({
          capabilityRegistry: makeCompositionCapabilityRegistry(),
          now: () => 1000,
        });
        const error = yield* Effect.flip(
          registry.issue({
            taskId: `task-invalid-capability-${index}`,
            agentId: "agent-invalid-capability",
            capabilityIds,
          }),
        );
        expect(error).toMatchObject({
          _tag: "CapabilityGrantInvalidError",
          reason: "grant_input_invalid",
        });
      }
    }),
  );

  effectIt.effect("恢复校验会重新读取当前 descriptor，移除后不再接受旧 grant", () =>
    Effect.gen(function* () {
      const capability = makeMcpCapability("t3.mcp.recovery_dynamic");
      let descriptors: ReadonlyArray<CompositionCapabilityDescriptor> = [capability];
      const capabilityRegistry = makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () => Effect.succeed(descriptors),
        },
      });
      const registry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => 1000 });
      const [grant] = yield* registry.issue({
        taskId: "task-recovery-dynamic",
        agentId: "agent-recovery-dynamic",
        capabilityIds: [capability.capabilityId],
      });
      if (grant === undefined) throw new Error("测试预期已签发 grant。");

      const first = yield* registry.validateForRecovery({
        grantId: grant.grantId,
        taskId: grant.taskId,
        agentId: grant.agentId,
        capabilityId: grant.capabilityId,
      });
      descriptors = [];
      const ordinary = yield* registry.validate({
        grantId: grant.grantId,
        taskId: grant.taskId,
        agentId: grant.agentId,
        capabilityId: grant.capabilityId,
      });
      const missing = yield* Effect.flip(
        registry.validateForRecovery({
          grantId: grant.grantId,
          taskId: grant.taskId,
          agentId: grant.agentId,
          capabilityId: grant.capabilityId,
        }),
      );

      expect(first.grantId).toBe(grant.grantId);
      expect(ordinary.grantId).toBe(grant.grantId);
      expect(missing).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId: capability.capabilityId,
        reason: "missing",
      });
    }),
  );

  effectIt.effect("grant 本身无效时恢复校验不会读取 descriptor", () =>
    Effect.gen(function* () {
      let listCalls = 0;
      const capabilityRegistry = makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            Effect.sync(() => {
              listCalls += 1;
              return [];
            }),
        },
      });
      const registry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => 1000 });

      const error = yield* Effect.flip(
        registry.validateForRecovery({
          grantId: "grant-missing",
          taskId: "task-missing",
          agentId: "agent-missing",
          capabilityId: "t3.mcp.missing",
        }),
      );

      expect(error).toMatchObject({ _tag: "CapabilityGrantNotFoundError" });
      expect(listCalls).toBe(0);
    }),
  );

  effectIt.effect("恢复校验原样传播 registry unavailable", () =>
    Effect.gen(function* () {
      const capability = makeMcpCapability("t3.mcp.recovery_registry_failure");
      const registryUnavailable = new CapabilityRegistryUnavailableError({
        reason: "mcp_registry_offline",
      });
      let unavailable = false;
      const capabilityRegistry = makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () =>
            unavailable ? Effect.fail(registryUnavailable) : Effect.succeed([capability]),
        },
      });
      const registry = makeCapabilityGrantRegistry({ capabilityRegistry, now: () => 1000 });
      const [grant] = yield* registry.issue({
        taskId: "task-recovery-registry-failure",
        agentId: "agent-recovery-registry-failure",
        capabilityIds: [capability.capabilityId],
      });
      if (grant === undefined) throw new Error("测试预期已签发 grant。");

      unavailable = true;
      const error = yield* Effect.flip(
        registry.validateForRecovery({
          grantId: grant.grantId,
          taskId: grant.taskId,
          agentId: grant.agentId,
          capabilityId: grant.capabilityId,
        }),
      );

      expect(error).toBe(registryUnavailable);
    }),
  );

  effectIt.effect("拒绝过期或已撤销 grant", () =>
    Effect.gen(function* () {
      let now = 1000;
      const registry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => now,
      });
      const [grant] = yield* registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 100,
      });

      now = 1100;
      const expired = yield* Effect.flip(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      );
      expect(expired).toMatchObject({ _tag: "CapabilityGrantExpiredError" });

      now = 1000;
      yield* registry.revoke({ grantId: grant!.grantId });
      const revoked = yield* Effect.flip(
        registry.validate({
          grantId: grant!.grantId,
          taskId: "task-1",
          agentId: "agent-1",
          capabilityId: "t3.workspace.read_file",
        }),
      );
      expect(revoked).toMatchObject({ _tag: "CapabilityGrantRevokedError" });
    }),
  );

  effectIt.effect("记录不包含 arguments 的工具审计事件", () =>
    Effect.gen(function* () {
      const registry = makeCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        now: () => 1000,
      });
      const [grant] = yield* registry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.workspace.read_file"],
      });

      yield* registry.recordAudit({
        grantId: grant!.grantId,
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        capabilityId: "t3.workspace.read_file",
        operation: "read",
        outcome: "allowed",
      });
      const events = yield* registry.listAudit({ taskId: "task-1" });
      expect(events).toHaveLength(1);
      expect((events[0] as Record<string, unknown>).arguments).toBeUndefined();
    }),
  );

  effectIt.effect("SQLite Registry 在新实例中恢复 grant、撤销状态和审计记录", () =>
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

      expect(restored.grantId).toBe("grant-test-1");
      expect(audit).toHaveLength(1);
      expect(audit[0]?.runId).toBe("run-sqlite");
      expect(revoked._tag).toBe("CapabilityGrantRevokedError");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("SQLite Registry 不复用剩余有效期不足的 grant", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      let now = 1000;
      let sequence = 0;
      const registry = makeSqliteCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        sql,
        now: () => now,
        randomUUID: () => `minimum-${++sequence}`,
      });
      const [first] = yield* registry.issue({
        taskId: "task-sqlite-minimum",
        agentId: "agent-sqlite-minimum",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
      });

      now = 3999;
      const [stillReusable] = yield* registry.issue({
        taskId: "task-sqlite-minimum",
        agentId: "agent-sqlite-minimum",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
        minimumRemainingMs: 2000,
      });
      now = 4000;
      const [replacement] = yield* registry.issue({
        taskId: "task-sqlite-minimum",
        agentId: "agent-sqlite-minimum",
        capabilityIds: ["t3.workspace.read_file"],
        ttlMs: 5000,
        minimumRemainingMs: 2000,
      });

      expect(stillReusable?.grantId).toBe(first?.grantId);
      expect(replacement?.grantId).not.toBe(first?.grantId);
      expect(replacement?.grantId).toBe("grant-minimum-2");
      expect(replacement?.expiresAtUnixMs).toBe(9000);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("SQLite Registry 在持久化前拒绝异常 grant 时效输入", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const registry = makeSqliteCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        sql,
        now: () => 1000,
        randomUUID: () => "invalid-duration",
      });

      for (const invalidInput of [
        { ttlMs: Number.NaN },
        { ttlMs: Number.POSITIVE_INFINITY },
        { ttlMs: -1 },
        { ttlMs: 1.5 },
        { ttlMs: Number.MAX_SAFE_INTEGER + 1 },
        { ttlMs: 5000, minimumRemainingMs: -1 },
        { ttlMs: 5000, minimumRemainingMs: 1.5 },
        { ttlMs: 5000, minimumRemainingMs: Number.POSITIVE_INFINITY },
        { ttlMs: 2000, minimumRemainingMs: 2000 },
      ]) {
        const error = yield* Effect.flip(
          registry.issue({
            taskId: "task-sqlite-invalid-duration",
            agentId: "agent-sqlite-invalid-duration",
            capabilityIds: ["t3.workspace.read_file"],
            ...invalidInput,
          }),
        );
        expect(error).toMatchObject({
          _tag: "CapabilityGrantInvalidError",
          reason: "grant_input_invalid",
        });
      }

      const overflowRegistry = makeSqliteCapabilityGrantRegistry({
        capabilityRegistry: makeCompositionCapabilityRegistry(),
        sql,
        now: () => Number.MAX_SAFE_INTEGER - 10,
        randomUUID: () => "overflow-duration",
      });
      const overflow = yield* Effect.flip(
        overflowRegistry.issue({
          taskId: "task-sqlite-duration-overflow",
          agentId: "agent-sqlite-duration-overflow",
          capabilityIds: ["t3.workspace.read_file"],
          ttlMs: 20,
        }),
      );
      expect(overflow).toMatchObject({
        _tag: "CapabilityGrantInvalidError",
        reason: "grant_input_invalid",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("SQLite 新实例恢复时重验 descriptor 当前状态", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capabilityId = "t3.mcp.sqlite_recovery_dynamic";
      let descriptors: ReadonlyArray<CompositionCapabilityDescriptor> = [
        makeMcpCapability(capabilityId),
      ];
      const capabilityRegistry = makeCompositionCapabilityRegistry({
        mcpToolRegistry: {
          listCapabilityDescriptors: () => Effect.succeed(descriptors),
        },
      });
      let sequence = 0;
      const options = {
        capabilityRegistry,
        sql,
        now: () => 1000,
        randomUUID: () => `recovery-${++sequence}`,
      };
      const first = makeSqliteCapabilityGrantRegistry(options);
      const [grant] = yield* first.issue({
        taskId: "task-sqlite-recovery",
        agentId: "agent-sqlite-recovery",
        capabilityIds: [capabilityId],
      });
      if (grant === undefined) throw new Error("测试预期已签发 grant。");

      descriptors = [makeMcpCapability(capabilityId, "unavailable")];
      const restarted = makeSqliteCapabilityGrantRegistry(options);
      const unavailable = yield* Effect.flip(
        restarted.validateForRecovery({
          grantId: grant.grantId,
          taskId: grant.taskId,
          agentId: grant.agentId,
          capabilityId: grant.capabilityId,
        }),
      );

      expect(unavailable).toMatchObject({
        _tag: "CapabilityNotAvailableError",
        capabilityId,
        reason: "unavailable",
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  effectIt.effect("SQLite 审计按确定性 ID 幂等写入并可跨实例读取", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const capabilityRegistry = makeCompositionCapabilityRegistry();
      const options = {
        capabilityRegistry,
        sql,
        now: () => 1000,
        randomUUID: () => "unused",
      };
      const first = makeSqliteCapabilityGrantRegistry(options);
      const input = {
        auditId: "capability-approval-requested:approval-stable",
        grantId: "grant-stable",
        taskId: "task-stable",
        runId: "run-stable",
        agentId: "agent-stable",
        capabilityId: "t3.workspace.write_file",
        operation: "mutate" as const,
        outcome: "approval_required" as const,
        errorCode: "capability_approval_requested",
      };

      const inserted = yield* first.recordAuditIfNew(input);
      const duplicate = yield* first.recordAuditIfNew(input);
      const restarted = makeSqliteCapabilityGrantRegistry(options);
      const restored = yield* restarted.getAuditById({ auditId: input.auditId });
      expect(inserted).toBe(true);
      expect(duplicate).toBe(false);
      expect(restored).toMatchObject({
        _tag: "Some",
        value: {
          auditId: "capability-approval-requested:approval-stable",
          taskId: "task-stable",
          outcome: "approval_required",
        },
      });
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
