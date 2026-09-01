import type { ProviderInstanceConfigMap } from "@codework/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applySupplierCredentialUpdate,
  buildSupplierProviderInstancePatch,
  setSupplierInstanceEnabled,
} from "./SupplierAdminCore.ts";

const byokId = ProviderInstanceId.make("byok-main");
const codexId = ProviderInstanceId.make("codex-work");
const multicaId = ProviderInstanceId.make("multica-work");
const missingId = ProviderInstanceId.make("missing");

const makeMap = (): ProviderInstanceConfigMap => ({
  [byokId]: {
    driver: ProviderDriverKind.make("byok"),
    displayName: "BYOK 主实例",
    enabled: true,
    config: {
      enabled: true,
      adapters: [
        {
          id: "adapter-1",
          displayName: "模型 A",
          protocol: "openai",
          baseURL: "https://byok.test/v1",
          apiKey: "sk-old-secret",
          apiKeyRedacted: true,
          modelId: "model-a",
          contextWindowTokens: 128000,
          balanceAccessToken: "old-balance-token",
          balanceAccessTokenRedacted: true,
        },
      ],
    },
  },
  [codexId]: {
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    environment: [
      { name: "CODEX_API_KEY", value: "env-old-secret", sensitive: true, valueRedacted: true },
      { name: "CODEX_REGION", value: "us", sensitive: false },
    ],
  },
});

describe("setSupplierInstanceEnabled", () => {
  it("同步翻转 envelope 与 config 内旧 enabled 标志，切换后生效状态一致", () => {
    const map = makeMap();
    const disabled = setSupplierInstanceEnabled(map, byokId, false);
    if (!disabled.ok) throw new Error(disabled.code);
    const disabledInstance = disabled.value.providerInstances[byokId];
    if (disabledInstance === undefined) throw new Error("missing disabled instance");
    expect(disabledInstance.enabled).toBe(false);
    expect((disabledInstance.config as { enabled?: boolean }).enabled).toBe(false);
    expect(resolveProviderInstanceEnabled(disabledInstance)).toBe(false);

    const enabled = setSupplierInstanceEnabled(disabled.value.providerInstances, byokId, true);
    if (!enabled.ok) throw new Error(enabled.code);
    const enabledInstance = enabled.value.providerInstances[byokId];
    if (enabledInstance === undefined) throw new Error("missing enabled instance");
    expect(resolveProviderInstanceEnabled(enabledInstance)).toBe(true);
    // 无 config.enabled 标志的实例只更新 envelope。
    const codexToggled = setSupplierInstanceEnabled(map, codexId, false);
    if (!codexToggled.ok) throw new Error(codexToggled.code);
    expect(codexToggled.value.providerInstances[codexId]?.enabled).toBe(false);
    expect(codexToggled.value.providerInstances[codexId]?.config).toBeUndefined();
    // 输入 map 不被原地修改。
    expect(map[byokId]?.enabled).toBe(true);
  });

  it("实例不存在时显式失败", () => {
    const outcome = setSupplierInstanceEnabled(makeMap(), missingId, true);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected failure");
    expect(outcome.code).toBe("supplier_instance_not_found");
  });
});

describe("buildSupplierProviderInstancePatch", () => {
  it("Multica 写入使用局部 CAS mutation，普通实例仍保留整图兼容路径", () => {
    const sentinel = "supplier-secret-must-not-enter-revision";
    const current = {
      ...makeMap(),
      [multicaId]: {
        driver: ProviderDriverKind.make("multica"),
        environment: [{ name: "UNBOUND_SECRET", value: sentinel, sensitive: true }],
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
        },
      },
    } satisfies ProviderInstanceConfigMap;
    const enabled = setSupplierInstanceEnabled(current, multicaId, false);
    if (!enabled.ok) throw new Error(enabled.code);
    const multicaPatch = buildSupplierProviderInstancePatch(
      current,
      enabled.value.providerInstances,
      multicaId,
    );

    expect(Object.keys(multicaPatch.providerInstances ?? {})).toEqual([multicaId]);
    expect(multicaPatch.multicaProviderInstancePreconditions).toHaveLength(1);
    expect(JSON.stringify(multicaPatch.multicaProviderInstancePreconditions)).not.toContain(
      sentinel,
    );

    const codexPatch = buildSupplierProviderInstancePatch(current, current, codexId);
    expect(codexPatch.providerInstances).toBe(current);
    expect(codexPatch.multicaProviderInstancePreconditions).toBeUndefined();
  });
});

describe("applySupplierCredentialUpdate", () => {
  it("更新 BYOK 适配器 apiKey 并清掉 redacted 标志，结果不回显凭据值", () => {
    const outcome = applySupplierCredentialUpdate(makeMap(), byokId, {
      kind: "byok_adapter",
      adapterId: "adapter-1",
      apiKey: "sk-new-secret",
    });
    if (!outcome.ok) throw new Error(outcome.code);
    const updatedInstance = outcome.value.providerInstances[byokId];
    if (updatedInstance === undefined) throw new Error("missing updated instance");
    const adapters = (
      updatedInstance.config as {
        adapters: ReadonlyArray<Record<string, unknown>>;
      }
    ).adapters;
    expect(adapters[0]?.["apiKey"]).toBe("sk-new-secret");
    expect(adapters[0]?.["apiKeyRedacted"]).toBeUndefined();
    // 未更新的 balance token 保持原样（含 redacted 标志）。
    expect(adapters[0]?.["balanceAccessToken"]).toBe("old-balance-token");
    expect(adapters[0]?.["balanceAccessTokenRedacted"]).toBe(true);
    expect(outcome.value.target).toBe("adapter-1");
    expect(outcome.value.updatedFields).toEqual(["apiKey"]);
    // outcome 除 providerInstances（写回设置的载体）外不携带凭据值。
    const { providerInstances: _map, ...visible } = outcome.value;
    expect(JSON.stringify(visible)).not.toContain("sk-new-secret");
  });

  it("更新实例敏感环境变量的值并清掉 valueRedacted", () => {
    const outcome = applySupplierCredentialUpdate(makeMap(), codexId, {
      kind: "environment_variable",
      name: "CODEX_API_KEY",
      value: "env-new-secret",
    });
    if (!outcome.ok) throw new Error(outcome.code);
    const environment = outcome.value.providerInstances[codexId]?.environment;
    const updated = environment?.find((variable) => variable.name === "CODEX_API_KEY");
    expect(updated?.value).toBe("env-new-secret");
    expect(updated?.sensitive).toBe(true);
    expect(updated?.valueRedacted).toBeUndefined();
    // 其他变量原样保留。
    expect(environment?.find((variable) => variable.name === "CODEX_REGION")?.value).toBe("us");
    expect(outcome.value.target).toBe("CODEX_API_KEY");
  });

  it("目标缺失/类型不匹配/空值分别显式失败，detail 不包含凭据值", () => {
    const map = makeMap();
    const missingInstance = applySupplierCredentialUpdate(map, missingId, {
      kind: "byok_adapter",
      adapterId: "adapter-1",
      apiKey: "sk-x",
    });
    expect(!missingInstance.ok && missingInstance.code).toBe("supplier_instance_not_found");

    const missingAdapter = applySupplierCredentialUpdate(map, byokId, {
      kind: "byok_adapter",
      adapterId: "nope",
      apiKey: "sk-value-should-not-leak",
    });
    expect(!missingAdapter.ok && missingAdapter.code).toBe("supplier_adapter_not_found");
    if (!missingAdapter.ok) {
      expect(missingAdapter.detail).not.toContain("sk-value-should-not-leak");
    }

    const wrongKind = applySupplierCredentialUpdate(map, codexId, {
      kind: "byok_adapter",
      adapterId: "adapter-1",
      apiKey: "sk-x",
    });
    expect(!wrongKind.ok && wrongKind.code).toBe("supplier_credential_not_supported");

    const missingVariable = applySupplierCredentialUpdate(map, byokId, {
      kind: "environment_variable",
      name: "NOPE",
      value: "value-should-not-leak",
    });
    expect(!missingVariable.ok && missingVariable.code).toBe(
      "supplier_environment_variable_not_found",
    );
    if (!missingVariable.ok) {
      expect(missingVariable.detail).not.toContain("value-should-not-leak");
    }

    const emptyByok = applySupplierCredentialUpdate(map, byokId, {
      kind: "byok_adapter",
      adapterId: "adapter-1",
    });
    expect(!emptyByok.ok && emptyByok.code).toBe("supplier_credential_empty");

    const emptyEnv = applySupplierCredentialUpdate(map, codexId, {
      kind: "environment_variable",
      name: "CODEX_API_KEY",
      value: "   ",
    });
    expect(!emptyEnv.ok && emptyEnv.code).toBe("supplier_credential_empty");
  });
});
