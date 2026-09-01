import { assert, describe, it } from "@effect/vitest";

import type { CompositionAgentDriverProfile } from "@codework/contracts";

import { projectCompositionSupplierRegistry } from "./CompositionSupplierRegistryProjection.ts";

const profile = (
  overrides: Partial<CompositionAgentDriverProfile> = {},
): CompositionAgentDriverProfile => ({
  schemaVersion: 1,
  agentId: "provider:instance-byok-1",
  runtimeId: "byok:instance-byok-1",
  driverKind: "provider",
  providerKind: "byok",
  status: "available",
  capabilities: ["model", "byok.agent_loop"],
  supportsToolBroker: false,
  supportsCapabilityHandshake: false,
  supportsWorkspace: true,
  supportsTerminal: false,
  supportsGit: false,
  supportsMcp: false,
  supportsBrowser: false,
  supportsIde: false,
  supportsProviderApi: true,
  supportsResume: true,
  supportsSquad: false,
  supportsLeader: false,
  supportsTaskGraph: false,
  ...overrides,
});

describe("projectCompositionSupplierRegistry", () => {
  it("按 provider:<instanceId> 约定把档案挂到 Supplier 条目并透传账号锚点", () => {
    const result = projectCompositionSupplierRegistry({
      instances: [
        {
          instanceId: "instance-byok-1",
          driverKind: "byok",
          displayName: "BYOK OpenRouter",
          enabled: true,
          continuationKey: "byok:instance:instance-byok-1",
          defaultModelId: "openrouter/auto",
        },
        {
          instanceId: "instance-provider-1",
          driverKind: "provider",
          enabled: false,
          continuationKey: "provider:instance:instance-provider-1",
        },
      ],
      profiles: [
        profile(),
        profile({
          agentId: "provider:instance-provider-1",
          runtimeId: "provider:instance-provider-1",
          status: "degraded",
          supportsResume: false,
        }),
      ],
      nowUnixMs: 5_000,
    });

    assert.equal(result.generatedAtUnixMs, 5_000);
    assert.equal(result.suppliers.length, 2);
    assert.equal(result.orphanProfileAgentIds.length, 0);

    const byok = result.suppliers[0];
    assert.isDefined(byok);
    assert.equal(byok?.instanceId, "instance-byok-1");
    assert.equal(byok?.driverKind, "byok");
    assert.equal(byok?.displayName, "BYOK OpenRouter");
    assert.equal(byok?.enabled, true);
    assert.equal(byok?.continuationKey, "byok:instance:instance-byok-1");
    assert.equal(byok?.defaultModelId, "openrouter/auto");
    assert.deepEqual(byok?.profile, {
      agentId: "provider:instance-byok-1",
      runtimeId: "byok:instance-byok-1",
      status: "available",
      supportsResume: true,
    });

    const provider = result.suppliers[1];
    assert.isDefined(provider);
    assert.equal(provider?.displayName, undefined);
    assert.equal(provider?.defaultModelId, undefined);
    assert.equal(provider?.profile?.status, "degraded");
  });

  it("没有实例的 provider: 档案输出为孤儿，非实例派生档案不参与投影", () => {
    const result = projectCompositionSupplierRegistry({
      instances: [
        {
          instanceId: "instance-byok-live",
          driverKind: "byok",
          enabled: true,
          continuationKey: "byok:instance:instance-byok-live",
        },
      ],
      profiles: [
        profile({ agentId: "provider:instance-byok-live", runtimeId: "byok:instance-byok-live" }),
        // 实例已被移除但 Driver 档案仍在：多账号回滚关注的孤儿。
        profile({
          agentId: "provider:instance-byok-removed",
          runtimeId: "byok:instance-byok-removed",
        }),
        // 非 provider: 前缀的档案（acp/cli 等外部 Driver）不属于 Supplier 投影。
        profile({
          agentId: "agent-acp-1",
          runtimeId: "acp:session-1",
          driverKind: "acp",
        }),
      ],
      nowUnixMs: 6_000,
    });

    assert.equal(result.suppliers.length, 1);
    assert.equal(result.suppliers[0]?.instanceId, "instance-byok-live");
    assert.isDefined(result.suppliers[0]?.profile);
    assert.deepEqual(result.orphanProfileAgentIds, ["provider:instance-byok-removed"]);
  });

  it("实例没有派生档案时输出无 profile 条目且不计孤儿", () => {
    const result = projectCompositionSupplierRegistry({
      instances: [
        {
          instanceId: "instance-byok-fresh",
          driverKind: "byok",
          enabled: true,
          continuationKey: "byok:instance:instance-byok-fresh",
        },
      ],
      profiles: [],
      nowUnixMs: 7_000,
    });

    assert.equal(result.suppliers.length, 1);
    assert.equal(result.suppliers[0]?.profile, undefined);
    assert.deepEqual(result.orphanProfileAgentIds, []);
  });
});
