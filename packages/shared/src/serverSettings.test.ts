import {
  DEFAULT_SERVER_SETTINGS,
  CompositionMcpServerId,
  LocalAccountId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectId,
  type ServerProvider,
} from "@codework/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  extractPersistedServerObservabilitySettings,
  isModelSelectionProviderEnabled,
  modelPreferencesMigrationPatch,
  normalizePersistedServerSettingString,
  parsePersistedServerObservabilitySettings,
  resolveModelPreferences,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

describe("serverSettings helpers", () => {
  it("replaces the MCP server map instead of deep-merging deleted entries", () => {
    const serverId = CompositionMcpServerId.make("local_tools");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      mcpServers: {
        [serverId]: {
          schemaVersion: 1 as const,
          name: "Local Tools",
          transport: "stdio" as const,
          command: "node",
          args: [],
          headers: [],
          environment: [],
          enabled: true,
          trusted: false,
        },
      },
    };

    const next = applyServerSettingsPatch(current, { mcpServers: {} });

    expect(next.mcpServers).toEqual({});
  });

  it("preserves local account secret references from a redacted settings snapshot", () => {
    const accountId = "codex-test" as LocalAccountId;
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      localAccountPool: {
        ...DEFAULT_SERVER_SETTINGS.localAccountPool,
        accounts: {
          [accountId]: {
            id: accountId,
            provider: "codex" as const,
            displayName: "Codex Test",
            credentialRef: "local-account-secret-ref",
            enabled: true,
            models: ["gpt-5.4"],
          },
        },
      },
    };
    const next = applyServerSettingsPatch(current, {
      localAccountPool: {
        ...current.localAccountPool,
        accounts: {
          [accountId]: { ...current.localAccountPool.accounts[accountId]!, credentialRef: "" },
        },
      },
    });
    expect(next.localAccountPool.accounts[accountId]?.credentialRef).toBe(
      "local-account-secret-ref",
    );
    const withoutSecret = applyServerSettingsPatch(current, {
      localAccountPool: {
        ...current.localAccountPool,
        accounts: {
          ...current.localAccountPool.accounts,
          ["untrusted-empty" as LocalAccountId]: {
            id: "untrusted-empty" as LocalAccountId,
            provider: "codex",
            displayName: "Untrusted",
            credentialRef: "",
            enabled: true,
            models: ["gpt-5.4"],
          },
        },
      },
    });
    expect(
      withoutSecret.localAccountPool.accounts["untrusted-empty" as LocalAccountId],
    ).toBeUndefined();
  });

  it("replaces the local account map so deleted accounts stay deleted", () => {
    const accountId = LocalAccountId.make("codex-delete");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      localAccountPool: {
        ...DEFAULT_SERVER_SETTINGS.localAccountPool,
        accounts: {
          [accountId]: {
            id: accountId,
            provider: "codex" as const,
            displayName: "Codex Delete",
            credentialRef: "secret-ref",
            enabled: true,
            models: [],
          },
        },
      },
    };
    const next = applyServerSettingsPatch(current, {
      localAccountPool: {
        ...current.localAccountPool,
        accounts: {},
      },
    });
    expect(next.localAccountPool.accounts).toEqual({});
  });

  it("normalizes optional persisted strings", () => {
    expect(normalizePersistedServerSettingString(undefined)).toBeUndefined();
    expect(normalizePersistedServerSettingString("   ")).toBeUndefined();
    expect(normalizePersistedServerSettingString("  http://localhost:4318/v1/traces  ")).toBe(
      "http://localhost:4318/v1/traces",
    );
  });

  it("extracts persisted observability settings", () => {
    expect(
      extractPersistedServerObservabilitySettings({
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      }),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("parses lenient persisted settings JSON", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "http://localhost:4318/v1/traces",
            otlpMetricsUrl: "http://localhost:4318/v1/metrics",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
    });
  });

  it("replaces text generation selection when provider/model are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("accepts array-based text generation selection patches", () => {
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
          options: [
            { id: "variant", value: "prod" },
            { id: "agent", value: "build" },
          ],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
      options: [
        { id: "variant", value: "prod" },
        { id: "agent", value: "build" },
      ],
    });
  });

  it("replaces source control writer selection without retaining stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [{ id: "reasoningEffort", value: "high" }],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).sourceControlWriterModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("clears source control writer selection with null", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        sourceControlWriterModelSelection: null,
      }).sourceControlWriterModelSelection,
    ).toBeNull();
  });

  it("falls back from a disabled source control writer provider without clearing its selection", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };

    expect(isModelSelectionProviderEnabled(settings, sourceControlWriterModelSelection)).toBe(
      false,
    );
    expect(resolveSourceControlWriterModelSelection(settings)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from an unavailable source control writer provider", () => {
    const instanceId = ProviderInstanceId.make("missing_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "missing-model");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("missing-driver"),
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const unavailableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("missing-driver"),
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "unavailable",
      unavailableReason: "This provider driver is not available in this build.",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [unavailableProvider])).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("stores background activity profiles as a versioned object and syncs legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(
      Duration.toMillis(Duration.minutes(15)),
    );
  });

  it("turns legacy interval patches into custom background activity overrides", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
    expect(resolveServerBackgroundActivitySettings(next).profile).toBe("balanced");
    expect(
      Duration.toMillis(resolveServerBackgroundActivitySettings(next).automaticGitFetchInterval),
    ).toBe(15_000);
  });

  it("preserves legacy background activity settings when applying an unrelated patch", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivityProfile: "performance" as const,
      automaticGitFetchInterval: Duration.seconds(7),
      providerHealthRefreshInterval: Duration.minutes(4),
    };

    const next = applyServerSettingsPatch(current, {
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(7),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
    expect(next.backgroundActivityProfile).toBe("performance");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(7_000);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(240_000);
  });

  it("does not reactivate dormant overrides from a concrete profile", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "battery-saver" as const,
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    };

    const next = applyServerSettingsPatch(current, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
  });

  it("prefers structured background activity settings over legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
      automaticGitFetchInterval: Duration.seconds(5),
      backgroundActivityProfile: "performance",
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
  });

  it("reconciles custom background activity back to a preset when overrides match the preset", () => {
    const custom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });
    const next = applyServerSettingsPatch(custom, {
      automaticGitFetchInterval: Duration.seconds(30),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("balanced");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(30_000);
  });

  it("drops custom overrides that duplicate the base profile", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(30),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
  });

  it("replaces the complete background override record", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(15),
          providerHealthRefreshInterval: Duration.minutes(3),
        },
      },
    });

    const next = applyServerSettingsPatch(current, {
      backgroundActivity: {
        overrides: {
          automaticGitFetchInterval: Duration.seconds(10),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(10),
      },
    });
  });

  it("keeps interval overrides supplied with a profile patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivityProfile: "performance",
      automaticGitFetchInterval: Duration.seconds(0),
      providerHealthRefreshInterval: Duration.minutes(4),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(0),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
  });

  it("ignores overrides attached to a concrete background profile", () => {
    const resolved = resolveServerBackgroundActivitySettings({
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1,
        profile: "balanced",
        overrides: {
          pauseWhenOnBattery: true,
        },
      },
    });

    expect(resolved.pauseWhenOnBattery).toBe(false);
  });

  it("replaces a project's override entry wholesale and deletes it on null", () => {
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const seeded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      projectSettingsOverrides: {
        [projectA]: { defaultRuntimeMode: "full-access", worktreeSubmodules: "none" },
      },
    });
    expect(seeded.projectSettingsOverrides[projectA]).toEqual({
      defaultRuntimeMode: "full-access",
      worktreeSubmodules: "none",
    });

    // A listed entry replaces wholesale: the omitted key does not survive.
    const replaced = applyServerSettingsPatch(seeded, {
      projectSettingsOverrides: {
        [projectA]: { worktreeSubmodules: "top-level" },
        [projectB]: { defaultRuntimeMode: "auto" },
      },
    });
    expect(replaced.projectSettingsOverrides[projectA]).toEqual({
      worktreeSubmodules: "top-level",
    });
    expect(replaced.projectSettingsOverrides[projectB]).toEqual({
      defaultRuntimeMode: "auto",
    });

    // null deletes only the listed project's entry.
    const deleted = applyServerSettingsPatch(replaced, {
      projectSettingsOverrides: { [projectA]: null },
    });
    expect(deleted.projectSettingsOverrides[projectA]).toBeUndefined();
    expect(deleted.projectSettingsOverrides[projectB]).toEqual({
      defaultRuntimeMode: "auto",
    });

    // A patch that never mentions the key leaves the map untouched.
    const untouched = applyServerSettingsPatch(replaced, {
      defaultRuntimeMode: "auto-accept-edits",
    });
    expect(untouched.projectSettingsOverrides).toEqual(replaced.projectSettingsOverrides);
  });
});

describe("synchronized model preferences", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const legacy = {
    favorites: [{ provider, model: "sol" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
  };

  it("keeps concurrent adds and removes of the same favorite idempotent", () => {
    const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] };
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, add);
    expect(applyServerSettingsPatch(first, add).favorites).toEqual([{ provider, model: "sol" }]);
    const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] };
    const removed = applyServerSettingsPatch(first, remove);
    expect(applyServerSettingsPatch(removed, remove).favorites).toEqual([]);
  });

  it("preserves unrelated models and providers during bulk visibility and order edits", () => {
    const otherProvider = ProviderInstanceId.make("claude_work");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: {
        ...legacy.providerModelPreferences,
        [otherProvider]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] },
      },
    });
    const mobile = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    const web = applyServerSettingsPatch(mobile, {
      setModelsHidden: [
        { provider, model: "astra", hidden: false },
        { provider, model: "sol", hidden: true },
      ],
      setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
    });
    expect(web.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["luna", "sol"],
      modelOrder: ["sol", "luna", "astra"],
    });
    expect(web.providerModelPreferences?.[otherProvider]).toEqual(
      initial.providerModelPreferences?.[otherProvider],
    );
    expect(
      applyServerSettingsPatch(web, {
        setProviderModelOrder: { provider, modelOrder: [] },
      }).providerModelPreferences?.[provider],
    ).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
  });

  it("migrates saved lists independently without claiming empty legacy lists", () => {
    expect(modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, {})).toBeNull();
    const patch = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const migrated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(resolveModelPreferences(migrated)).toEqual(legacy);
    expect(modelPreferencesMigrationPatch(migrated, legacy)).toBeNull();
    const favoritesOnly = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { favorites: [] });
    expect(modelPreferencesMigrationPatch(favoritesOnly, legacy)).toEqual({
      migrateModelPreferences: { providerModelPreferences: legacy.providerModelPreferences },
    });
  });

  it("keeps explicit clears when a delayed migration arrives from another device", () => {
    const staleMigration = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      favorites: [],
      providerModelPreferences: {},
    });
    expect(
      resolveModelPreferences(applyServerSettingsPatch(cleared, staleMigration), legacy),
    ).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });

  it("replaces visibility records so showing every model clears removed entries", () => {
    const migrated = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!,
    );
    const cleared = applyServerSettingsPatch(migrated, { providerModelPreferences: {} });
    expect(cleared.providerModelPreferences).toEqual({});
    expect(cleared.favorites).toEqual(legacy.favorites);
  });

  it("sets favorites without losing changes from other clients", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider, model: "astra", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider, model: "astra" },
    ]);
    const removed = applyServerSettingsPatch(second, {
      setModelFavorites: [{ provider, model: "sol", favorite: false }],
    });
    expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
    expect(
      applyServerSettingsPatch(removed, {
        setModelFavorites: [{ provider, model: "astra", favorite: false }],
      }).favorites,
    ).toEqual([]);
  });

  it("sets visibility against the latest state without replacing other models or their order", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: legacy.providerModelPreferences,
    });
    const first = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "sol", hidden: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    expect(second.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "sol", "luna"],
      modelOrder: ["sol"],
    });
    const restored = applyServerSettingsPatch(second, {
      setModelsHidden: [{ provider, model: "sol", hidden: false }],
    });
    expect(restored.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["astra", "luna"],
      modelOrder: ["sol"],
    });
    expect(
      applyServerSettingsPatch(restored, {
        setModelsHidden: [{ provider, model: "sol", hidden: false }],
      }).providerModelPreferences,
    ).toEqual(restored.providerModelPreferences);
    expect(
      applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        setModelsHidden: [{ provider, model: "sol", hidden: true }],
      }).providerModelPreferences?.[provider]?.hiddenModels,
    ).toEqual(["sol"]);
  });

  it("keeps the same model on different provider instances as separate favorites", () => {
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider: otherProvider, model: "sol", favorite: true }],
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider: otherProvider, model: "sol" },
    ]);
    expect(
      applyServerSettingsPatch(second, {
        setModelFavorites: [{ provider, model: "sol", favorite: false }],
      }).favorites,
    ).toEqual([{ provider: otherProvider, model: "sol" }]);
  });

  it("keeps explicit edits when the same patch also carries a legacy migration", () => {
    const edited = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      ...modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy),
      favorites: [],
      providerModelPreferences: {},
    });
    expect(resolveModelPreferences(edited, legacy)).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });
});

describe("worktreeCleanup patch merging", () => {
  const baseRules = {
    worktreeKeepWhen: "tracked-changes" as const,
    worktreeAfterDays: 60,
    worktreeOnMerge: true,
    worktreeOnDelete: true,
    worktreeUnchanged: false,
  };

  it("merges a partial custom rules patch over environment defaults", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeCleanup: {
        mode: "custom",
        rules: { worktreeAfterDays: 14, worktreeUnchanged: true },
      },
    });
    expect(next.worktreeCleanup).toEqual({
      mode: "custom",
      rules: {
        ...(baseRules === undefined ? {} : {}),
        worktreeKeepWhen: DEFAULT_SERVER_SETTINGS.storageCleanup.worktreeKeepWhen,
        worktreeAfterDays: 14,
        worktreeOnMerge: DEFAULT_SERVER_SETTINGS.storageCleanup.worktreeOnMerge,
        worktreeOnDelete: DEFAULT_SERVER_SETTINGS.storageCleanup.worktreeOnDelete,
        worktreeUnchanged: true,
      },
    });
  });

  it("merges a partial custom rules patch over an existing custom policy", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeCleanup: { mode: "custom", rules: baseRules },
    });
    const next = applyServerSettingsPatch(current, {
      worktreeCleanup: { mode: "custom", rules: { worktreeOnMerge: false } },
    });
    expect(next.worktreeCleanup).toEqual({
      mode: "custom",
      rules: { ...baseRules, worktreeOnMerge: false },
    });
  });

  it("replaces the policy with off or inherit", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeCleanup: { mode: "custom", rules: baseRules },
    });
    expect(
      applyServerSettingsPatch(current, { worktreeCleanup: { mode: "off" } }).worktreeCleanup,
    ).toEqual({ mode: "off" });
    expect(applyServerSettingsPatch(current, { worktreeCleanup: null }).worktreeCleanup).toBeNull();
  });

  it("leaves the policy untouched when the patch omits the key", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      worktreeCleanup: { mode: "custom", rules: baseRules },
    });
    const next = applyServerSettingsPatch(current, {
      storageCleanup: { worktreeAfterDays: 99 },
    });
    expect(next.worktreeCleanup).toEqual({ mode: "custom", rules: baseRules });
    expect(next.storageCleanup.worktreeAfterDays).toBe(99);
  });
});
