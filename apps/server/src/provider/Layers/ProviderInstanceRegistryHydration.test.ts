import { describe, expect, it } from "vite-plus/test";
import {
  ByokSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@codework/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const routedDrivers = ["codex", "claudeAgent", "grok", "opencode"] as const;
const sourceId = ProviderInstanceId.make("source");
const otherId = ProviderInstanceId.make("other");
const byokId = ProviderInstanceId.make("byok");
const decodeByok = Schema.decodeUnknownSync(ByokSettings);
const entry = (driver: string, config: unknown): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(driver),
  config,
});
const byokConfig = (patch: Record<string, unknown> = {}) => ({
  enabled: true,
  adapters: ["openai", "anthropic"].map((protocol) => ({
    id: `${protocol}-route`,
    displayName: "测试模型",
    protocol,
    baseURL: "https://relay.example/v1",
    apiKey: "test-secret-one",
    modelId: "model-one",
    ...patch,
  })),
});
const settings = (patch: Record<string, unknown> = {}): ServerSettings => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [sourceId]: entry("byok", byokConfig(patch)),
    [otherId]: entry("byok", byokConfig()),
    ...Object.fromEntries(
      routedDrivers.map((driver) => [
        ProviderInstanceId.make(driver),
        {
          ...entry(driver, { routeThroughByok: true, byokSourceInstanceId: sourceId }),
          settingsRevision: "persisted-revision",
        },
      ]),
    ),
    [ProviderInstanceId.make("official")]: entry("codex", {
      routeThroughByok: false,
      byokSourceInstanceId: sourceId,
    }),
    [ProviderInstanceId.make("cursor")]: entry("cursor", {
      routeThroughByok: true,
      byokSourceInstanceId: sourceId,
    }),
  },
});
const configFor = (value: ServerSettings, id: string) =>
  deriveProviderInstanceConfigMap(value)[ProviderInstanceId.make(id)];

describe("BYOK 来源驱动 CLI 配置更新", () => {
  it.each(["id", "modelId", "baseURL", "apiKey", "displayName", "groupName"])(
    "来源 %s 变化只更新接管 CLI，且不复制凭据或修改持久配置",
    (field) => {
      const initial = settings();
      const saved = JSON.stringify(initial);
      const before = deriveProviderInstanceConfigMap(initial);
      const after = deriveProviderInstanceConfigMap(settings({ [field]: "updated-value" }));
      for (const driver of routedDrivers) {
        const id = ProviderInstanceId.make(driver);
        expect(Equal.equals(before[id], after[id])).toBe(false);
        expect(before[id]?.settingsRevision).toBe("persisted-revision");
        expect(after[id]?.settingsRevision).toBe("persisted-revision");
        expect(JSON.stringify(before[id])).not.toContain("test-secret-one");
        expect(JSON.stringify(after[id])).not.toContain("updated-value");
      }
      expect(after[ProviderInstanceId.make("official")]).toEqual(
        before[ProviderInstanceId.make("official")],
      );
      expect(after[ProviderInstanceId.make("cursor")]).toEqual(
        before[ProviderInstanceId.make("cursor")],
      );
      expect(JSON.stringify(initial)).toBe(saved);
    },
  );

  it("相同设置、其他来源和不使用的协议不触发更新", () => {
    const initial = settings();
    const otherChanged = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [otherId]: entry("byok", byokConfig({ modelId: "unrelated" })),
      },
    };
    const anthropicChanged = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [sourceId]: entry("byok", {
          enabled: true,
          adapters: byokConfig().adapters.map((adapter) =>
            adapter.protocol === "anthropic" ? { ...adapter, modelId: "updated" } : adapter,
          ),
        }),
      },
    };
    for (const driver of routedDrivers) {
      expect(Equal.equals(configFor(settings(), driver), configFor(initial, driver))).toBe(true);
      expect(configFor(otherChanged, driver)).toEqual(configFor(initial, driver));
      expect(Equal.equals(configFor(anthropicChanged, driver), configFor(initial, driver))).toBe(
        driver !== "claudeAgent",
      );
    }
  });

  it("来源不存在、禁用与启用可区分，禁用期间的线路变化不更新 CLI", () => {
    const initial = settings();
    const { [sourceId]: omitted, ...remaining } = initial.providerInstances;
    expect(omitted).toBeDefined();
    const missing = { ...initial, providerInstances: remaining };
    const disabled = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [sourceId]: { ...entry("byok", byokConfig()), enabled: false },
      },
    };
    const configDisabled = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [sourceId]: {
          ...entry("byok", { ...byokConfig({ apiKey: "rotated" }), enabled: false }),
          enabled: true,
        },
      },
    };
    const defaultDisabled = {
      ...initial,
      providerInstances: {
        ...initial.providerInstances,
        [sourceId]: entry("byok", { adapters: byokConfig().adapters }),
      },
    };
    for (const driver of routedDrivers) {
      expect(configFor(missing, driver)).not.toEqual(configFor(initial, driver));
      expect(configFor(missing, driver)).not.toEqual(configFor(disabled, driver));
      expect(configFor(disabled, driver)).not.toEqual(configFor(initial, driver));
      expect(configFor(configDisabled, driver)).toEqual(configFor(disabled, driver));
      expect(configFor(defaultDisabled, driver)).toEqual(configFor(disabled, driver));
    }
  });

  it("legacy BYOK 与不指定来源的 CLI 同样跟随真实路由，显式来源优先", () => {
    const legacy = (modelId: string, explicit = false): ServerSettings => ({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        byok: decodeByok(byokConfig({ modelId })),
        codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, routeThroughByok: true },
      },
      providerInstances: {
        [ProviderInstanceId.make("bound")]: entry("grok", {
          routeThroughByok: true,
          byokSourceInstanceId: byokId,
        }),
        ...(explicit ? { [byokId]: { ...entry("byok", byokConfig()), enabled: false } } : {}),
      },
    });
    for (const id of ["bound", "codex"]) {
      expect(configFor(legacy("one"), id)).not.toEqual(configFor(legacy("two"), id));
      expect(configFor(legacy("one", true), id)).toEqual(configFor(legacy("two", true), id));
    }
  });

  it("driver 解码剥离来源摘要，未接管与非法配置保持原样", () => {
    const initial = settings();
    const derived = deriveProviderInstanceConfigMap(initial);
    for (const driver of BUILT_IN_DRIVERS) {
      if (!routedDrivers.some((kind) => kind === driver.driverKind)) continue;
      const id = ProviderInstanceId.make(driver.driverKind);
      const decode = Schema.decodeUnknownSync(driver.configSchema);
      expect(decode(derived[id]?.config)).toEqual(decode(initial.providerInstances[id]?.config));
      expect(JSON.stringify(decode(derived[id]?.config))).not.toContain("__byokSourceFingerprint");
    }
    for (const config of [undefined, null, [], "invalid", { routeThroughByok: false }]) {
      const invalid = {
        ...initial,
        providerInstances: { [sourceId]: entry("codex", config) },
      };
      expect(configFor(invalid, sourceId)).toBe(invalid.providerInstances[sourceId]);
    }
  });
});
