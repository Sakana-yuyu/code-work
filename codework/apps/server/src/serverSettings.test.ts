import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CompositionMcpServerId,
  DEFAULT_SERVER_SETTINGS,
  multicaProviderInstanceRevision,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  ServerSettings,
  ServerSettingsPatch,
} from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  applySupplierCredentialUpdate,
  buildSupplierProviderInstancePatch,
  setSupplierInstanceEnabled,
} from "./provider/SupplierAdminCore.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

// Record 键是品牌化的 CompositionMcpServerId，普通字面量需显式收窄。
const localToolsKey = "local_tools" as CompositionMcpServerId;
const decodeSettingsPatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "codework-server-settings-test-",
        }),
      ),
    ),
  );

const makeFailingSecretStoreLayer = (cause: ServerSecretStore.SecretStoreError) =>
  Layer.succeed(
    ServerSecretStore.ServerSecretStore,
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.fail(cause),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
      remove: () => Effect.void,
    }),
  );

const recordProviderUsage = (provider: string, instanceId: string | null = provider) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_sessions (
        thread_id,
        status,
        provider_name,
        provider_instance_id,
        updated_at
      )
      VALUES (
        ${`thread-${instanceId ?? provider}`},
        ${"ready"},
        ${provider},
        ${instanceId},
        ${"2026-08-25T00:00:00.000Z"}
      )
    `;
  });

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("stores MCP sensitive values outside settings and redacts client snapshots", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        mcpServers: {
          [localToolsKey]: {
            schemaVersion: 1,
            enabled: true,
            trusted: false,
            name: "Local Tools",
            transport: "stdio",
            command: "node",
            args: ["server.mjs"],
            environment: [
              {
                name: "MCP_TOKEN",
                value: "mcp-secret-value",
                sensitive: true,
              },
            ],
            headers: [
              {
                name: "Authorization",
                value: "Bearer mcp-secret-value",
                sensitive: true,
              },
            ],
          },
        },
      });

      const persisted = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(persisted, "mcp-secret-value");
      assert.include(persisted, '"valueRedacted": true');

      const materialized = yield* serverSettings.getSettings;
      assert.strictEqual(
        materialized.mcpServers[localToolsKey]?.environment[0]?.value,
        "mcp-secret-value",
      );
      assert.strictEqual(
        materialized.mcpServers[localToolsKey]?.headers[0]?.value,
        "Bearer mcp-secret-value",
      );

      const clientSnapshot = ServerSettingsModule.redactServerSettingsForClient(materialized);
      assert.strictEqual(clientSnapshot.mcpServers[localToolsKey]?.environment[0]?.value, "");
      assert.strictEqual(clientSnapshot.mcpServers[localToolsKey]?.headers[0]?.value, "");
      assert.strictEqual(
        clientSnapshot.mcpServers[localToolsKey]?.environment[0]?.valueRedacted,
        true,
      );

      const rotated = yield* serverSettings.updateSettings({
        mcpServers: {
          [localToolsKey]: {
            schemaVersion: 1,
            enabled: true,
            trusted: false,
            name: "Local Tools",
            transport: "stdio",
            command: "node",
            args: ["server.mjs"],
            environment: [
              {
                name: "MCP_TOKEN",
                value: "mcp-rotated-value",
                sensitive: true,
                valueRedacted: true,
              },
            ],
            headers: [
              {
                name: "Authorization",
                value: "Bearer mcp-rotated-value",
                sensitive: true,
                valueRedacted: true,
              },
            ],
          },
        },
      });
      assert.strictEqual(
        rotated.mcpServers[localToolsKey]?.environment[0]?.value,
        "mcp-rotated-value",
      );
      assert.strictEqual(
        rotated.mcpServers[localToolsKey]?.headers[0]?.value,
        "Bearer mcp-rotated-value",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves context when reading a provider environment secret fails", () => {
    const platformCause = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFile",
      pathOrDescriptor: "provider environment secret",
      description: "Secret backend unavailable.",
    });
    const cause = new ServerSecretStore.SecretStoreReadError({
      resource: "provider environment secret",
      cause: platformCause,
    });
    const configLayer = Layer.fresh(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "codework-server-settings-secret-failure-test-",
      }),
    );
    const settingsLayer = ServerSettingsModule.layer.pipe(
      Layer.provide(makeFailingSecretStoreLayer(cause)),
      Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
      Layer.provideMerge(configLayer),
    );

    return Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"codex_personal":{"driver":"codex","environment":[{"name":"OPENROUTER_API_KEY","value":"","sensitive":true,"valueRedacted":true}],"config":{}}}}',
      );

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-secret",
        providerInstanceId: "codex_personal",
        environmentVariable: "OPENROUTER_API_KEY",
      });
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(settingsLayer));
  });

  it.effect("identifies provider history query failures", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_thread_sessions`;

      const error = yield* Effect.flip(serverSettings.getSettings);

      assert.deepInclude(error, {
        _tag: "ServerSettingsError",
        operation: "read-provider-history",
        settingsPath: serverConfig.settingsPath,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("decodes nested settings patches", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* decodeSettingsPatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }),
        {
          providers: { codex: { binaryPath: "/tmp/codex" } },
        },
      );

      assert.deepEqual(
        yield* decodeSettingsPatch({
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        }),
        {
          textGenerationModelSelection: {
            options: [{ id: "fastMode", value: false }],
          },
        },
      );
    }),
  );

  it.effect(
    "decodes legacy object-shaped textGenerationModelSelection.options from settings.json",
    () =>
      Effect.gen(function* () {
        const decoded = yield* decodeServerSettings({
          textGenerationModelSelection: {
            provider: ProviderDriverKind.make("codex"),
            model: "gpt-5.4-mini",
            options: { reasoningEffort: "low" },
          },
        });

        assert.deepEqual(decoded.textGenerationModelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4-mini",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
      }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        homePath: "",
        customModels: ["claude-custom"],
        launchArgs: "",
        autoCompactWindow: "",
      });
      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(
          ProviderInstanceId.make("codex"),
          DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: false },
          ],
        ),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("buffers changes after a subscription is acquired but before it is consumed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const changes = yield* serverSettings.subscribeChanges;

        yield* serverSettings.updateSettings({
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex-next",
            },
          },
        });

        const firstChange = yield* changes.pipe(Stream.runHead, Effect.timeout("1 second"));
        assert.equal(
          Option.getOrUndefined(firstChange)?.providers.codex.binaryPath,
          "/usr/local/bin/codex-next",
        );
      }),
    ).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves model when switching providers via textGenerationModelSelection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      // Start with Claude text generation selection
      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
          options: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-sonnet-4-6",
            [{ id: "effort", value: "high" }],
          ).options!,
        },
      });

      // Switch to Codex — the stale Claude "effort" in options must not
      // cause the update to lose the selected model.
      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "high" },
          ]).options!,
        },
      });

      assert.deepEqual(
        next.textGenerationModelSelection,
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
          { id: "reasoningEffort", value: "high" },
        ]),
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves custom provider instance text generation selections", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [ProviderInstanceId.make("claude_openrouter")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("claude_openrouter"),
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "uses explicit provider instance enabled state over legacy provider enabled state",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const instanceId = ProviderInstanceId.make("claude_openrouter");

        const next = yield* serverSettings.updateSettings({
          providers: {
            claudeAgent: {
              enabled: false,
            },
          },
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              config: { customModels: ["openai/gpt-5.5"] },
            },
          },
          textGenerationModelSelection: {
            instanceId,
            model: "openai/gpt-5.5",
          },
        });

        assert.deepEqual(next.textGenerationModelSelection, {
          instanceId,
          model: "openai/gpt-5.5",
        });
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves enabled text generation selections for non-built-in drivers", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("openrouter_text");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("openrouter"),
            enabled: true,
            config: { customModels: ["openai/gpt-5.5"] },
          },
        },
        textGenerationModelSelection: {
          instanceId,
          model: "openai/gpt-5.5",
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId,
        model: "openai/gpt-5.5",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect(
    "preserves the source control writer selection when its provider instance is disabled",
    () =>
      Effect.gen(function* () {
        const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
        const serverConfig = yield* ServerConfig.ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const instanceId = ProviderInstanceId.make("codex_writer");
        const sourceControlWriterModelSelection = {
          instanceId,
          model: "gpt-5.4-mini",
        };

        yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
          sourceControlWriterModelSelection,
        });

        const next = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: {},
            },
          },
        });

        assert.deepEqual(next.sourceControlWriterModelSelection, sourceControlWriterModelSelection);
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(next),
          next.textGenerationModelSelection,
        );
        assert.deepEqual(
          (yield* serverSettings.getSettings).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
        assert.deepEqual(
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.parse(raw).sourceControlWriterModelSelection,
          sourceControlWriterModelSelection,
        );

        const restored = yield* serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              config: {},
            },
          },
        });
        assert.deepEqual(
          ServerSettingsModule.resolveSourceControlWriterModelSelection(restored),
          sourceControlWriterModelSelection,
        );
      }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("drops stale text generation options when resetting model selection", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: createModelSelection(
            ProviderInstanceId.make("codex"),
            DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ).options!,
        },
      });

      const next = yield* serverSettings.updateSettings({
        textGenerationModelSelection: {
          instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        },
      });

      assert.deepEqual(next.textGenerationModelSelection, {
        instanceId: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.instanceId,
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("replaces provider instance maps when clearing optional fields", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex");

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            accentColor: "#7c3aed",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[codexId], {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Work",
        enabled: true,
        config: { homePath: "~/.codex" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("enables previously used providers from sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"opencode":{"serverUrl":"http://127.0.0.1:4096"}}}',
      );
      yield* recordProviderUsage("opencode");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.equal(settings.providers.opencode.serverUrl, "http://127.0.0.1:4096");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves existing provider instances without explicit enabled flags", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"cursor_work":{"driver":"cursor","config":{}},"grok":{"driver":"grok","config":{}},"opencode_work":{"driver":"opencode","config":{"serverUrl":"http://127.0.0.1:4096"}},"opencode_unused":{"driver":"opencode","config":{}}}}',
      );
      yield* recordProviderUsage("cursor", "cursor_work");
      yield* recordProviderUsage("grok", null);
      yield* recordProviderUsage("opencode", "opencode_work");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("cursor_work")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isTrue(settings.providerInstances[ProviderInstanceId.make("opencode_work")]?.enabled);
      const unused = settings.providerInstances[ProviderInstanceId.make("opencode_unused")];
      assert.isDefined(unused);
      assert.isFalse(resolveProviderInstanceEnabled(unused));
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves explicit provider disables in existing settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providers":{"grok":{"enabled":false},"opencode":{"enabled":false},"cursor":{"enabled":false}},"providerInstances":{"grok":{"driver":"grok","enabled":false,"config":{}},"opencode":{"driver":"opencode","config":{"enabled":false}},"cursor":{"driver":"cursor","enabled":false,"config":{}}}}',
      );
      yield* recordProviderUsage("grok");
      yield* recordProviderUsage("opencode");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("grok")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("opencode")]?.enabled);
      assert.isFalse(settings.providerInstances[ProviderInstanceId.make("cursor")]?.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps unused providers disabled in existing sparse settings files", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{}");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when no settings file exists", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves provider history when the settings file is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(serverConfig.settingsPath, "{invalid json");
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isTrue(settings.providers.cursor.enabled);
      assert.isFalse(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("preserves valid provider flags when another settings field is invalid", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"addProjectBaseDirectory":42,"providers":{"cursor":{"enabled":false},"grok":{"enabled":true}}}',
      );
      yield* recordProviderUsage("cursor");

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.cursor.enabled);
      assert.isTrue(settings.providers.grok.enabled);
      assert.isFalse(settings.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("restores providers from persisted runtime sessions", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          status,
          last_seen_at
        )
        VALUES (
          ${"thread-opencode-runtime"},
          ${"opencode"},
          ${"opencode"},
          ${"opencode"},
          ${"ready"},
          ${"2026-08-25T00:00:00.000Z"}
        )
      `;

      const settings = yield* serverSettings.getSettings;

      assert.isFalse(settings.providers.grok.enabled);
      assert.isTrue(settings.providers.opencode.enabled);
      assert.isFalse(settings.providers.cursor.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit disables after a provider has been used", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      yield* recordProviderUsage("grok");

      assert.isTrue((yield* serverSettings.getSettings).providers.grok.enabled);

      const settings = yield* serverSettings.updateSettings({
        providers: { grok: { enabled: false } },
      });
      assert.isFalse(settings.providers.grok.enabled);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.isFalse(JSON.parse(raw).providers.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists explicit provider enables before their first use", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          cursor: { enabled: true },
          grok: { enabled: true },
          opencode: { enabled: true },
        },
      });
      yield* serverSettings.updateSettings({ addProjectBaseDirectory: "~/Development" });

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isTrue(persisted.providers.cursor.enabled);
      assert.isTrue(persisted.providers.grok.enabled);
      assert.isTrue(persisted.providers.opencode.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("keeps optional providers disabled after a new installation writes settings", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const initial = yield* serverSettings.getSettings;
      assert.isFalse(initial.providers.grok.enabled);
      assert.isFalse(initial.providers.opencode.enabled);
      assert.isFalse(initial.providers.cursor.enabled);

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        providerInstances: {
          [ProviderInstanceId.make("grok")]: {
            driver: ProviderDriverKind.make("grok"),
            config: {},
          },
        },
      });

      assert.isFalse(next.providers.grok.enabled);
      assert.isFalse(next.providers.opencode.enabled);
      assert.isFalse(next.providers.cursor.enabled);
      const grok = next.providerInstances[ProviderInstanceId.make("grok")];
      assert.isDefined(grok);
      assert.isFalse(resolveProviderInstanceEnabled(grok));

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw);
      assert.isFalse(persisted.providers.cursor.enabled);
      assert.isFalse(persisted.providers.grok.enabled);
      assert.isFalse(persisted.providers.opencode.enabled);
      assert.isUndefined(persisted.providerInstances.grok.enabled);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds a legacy in-config enabled flag into the envelope on load", () =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable sticks.
      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"grok":{"driver":"grok","enabled":true,"config":{"enabled":false}},"codex_work":{"driver":"codex","config":{"enabled":true,"homePath":"~/.codex"}},"cursor":{"driver":"cursor","config":{"enabled":"nope"}}}}',
      );

      const settings = yield* serverSettings.getSettings;

      const grokId = ProviderInstanceId.make("grok");
      const codexWorkId = ProviderInstanceId.make("codex_work");
      assert.deepEqual(settings.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: {},
      });
      // A lone in-config flag is lifted to the envelope and stripped.
      assert.deepEqual(settings.providerInstances[codexWorkId], {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: { homePath: "~/.codex" },
      });
      // A malformed flag is left alone so driver schema validation can
      // surface it instead of the fold silently repairing the config.
      assert.deepEqual(settings.providerInstances[ProviderInstanceId.make("cursor")], {
        driver: ProviderDriverKind.make("cursor"),
        config: { enabled: "nope" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("folds in-config enabled flags arriving through updates", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const grokId = ProviderInstanceId.make("grok");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [grokId]: {
            driver: ProviderDriverKind.make("grok"),
            enabled: true,
            config: { enabled: false, binaryPath: "/opt/grok" },
          },
        },
      });

      assert.deepEqual(next.providerInstances[grokId], {
        driver: ProviderDriverKind.make("grok"),
        enabled: false,
        config: { binaryPath: "/opt/grok" },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
          opencode: {
            binaryPath: "  /opt/homebrew/bin/opencode  ",
            serverUrl: "  http://127.0.0.1:4096  ",
            serverPassword: "  secret-password  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        shadowHomePath: "",
        launchArgs: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        homePath: "",
        customModels: [],
        launchArgs: "",
        autoCompactWindow: "",
      });
      assert.deepEqual(next.providers.opencode, {
        // OpenCode is disabled by default; this update only touches paths.
        enabled: false,
        binaryPath: "/opt/homebrew/bin/opencode",
        serverUrl: "http://127.0.0.1:4096",
        serverPassword: "secret-password",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims observability settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "  ~/Development  ",
        observability: {
          otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
          otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
        },
      });

      assert.equal(next.addProjectBaseDirectory, "~/Development");
      assert.deepEqual(next.observability, {
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes non-default settings and explicit optional provider defaults to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          opencode: {
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        automaticGitFetchInterval: Duration.seconds(10),
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw), {
        addProjectBaseDirectory: "~/Development",
        observability: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
          cursor: {
            enabled: false,
          },
          grok: {
            enabled: false,
          },
          opencode: {
            enabled: false,
            serverUrl: "http://127.0.0.1:4096",
            serverPassword: "secret-password",
          },
        },
        backgroundActivity: {
          schemaVersion: 1,
          profile: "custom",
          baseProfile: "balanced",
          overrides: {
            automaticGitFetchInterval: 10_000,
          },
        },
        automaticGitFetchInterval: 10_000,
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores BYOK API keys outside settings.json and redacts client settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("byok_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            config: {
              adapters: [
                {
                  id: "deepseek-chat",
                  displayName: "DeepSeek Chat",
                  protocol: "openai",
                  baseURL: "https://api.deepseek.com/v1",
                  apiKey: "sk-deepseek-secret",
                  modelId: "deepseek-chat",
                  contextWindowTokens: 128000,
                },
              ],
            },
          },
        },
      });

      const materializedAdapter = (
        next.providerInstances[instanceId]?.config as
          | { adapters: Array<Record<string, unknown>> }
          | undefined
      )?.adapters[0];
      assert.equal(materializedAdapter?.apiKey, "sk-deepseek-secret");
      assert.equal(materializedAdapter?.apiKeyRedacted, true);

      const clientSettings = ServerSettingsModule.redactServerSettingsForClient(next);
      const clientAdapter = (
        clientSettings.providerInstances[instanceId]?.config as
          | {
              adapters: Array<Record<string, unknown>>;
            }
          | undefined
      )?.adapters[0];
      assert.equal(clientAdapter?.apiKey, "");
      assert.equal(clientAdapter?.apiKeyRedacted, true);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-deepseek-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persistedAdapter = JSON.parse(raw).providerInstances.byok_personal.config.adapters[0];
      assert.equal(persistedAdapter.apiKey, "");
      assert.equal(persistedAdapter.apiKeyRedacted, true);

      yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            displayName: "Personal BYOK",
            config: {
              adapters: [{ ...persistedAdapter, apiKey: "", apiKeyRedacted: true }],
            },
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores NewAPI balance access tokens in the secret store", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("byok_newapi");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            config: {
              adapters: [
                {
                  id: "newapi-model",
                  displayName: "NewAPI Model",
                  protocol: "openai",
                  baseURL: "https://newapi.example.com/v1",
                  apiKey: "sk-newapi-secret",
                  balanceProfile: "newapi",
                  balanceAccessToken: "napi-balance-secret",
                  balanceUserID: "42",
                  modelId: "newapi-model",
                  contextWindowTokens: 128000,
                },
              ],
            },
          },
        },
      });

      const materializedAdapter = (
        next.providerInstances[instanceId]?.config as
          | { adapters: Array<Record<string, unknown>> }
          | undefined
      )?.adapters[0];
      assert.equal(materializedAdapter?.balanceAccessToken, "napi-balance-secret");
      assert.equal(materializedAdapter?.balanceAccessTokenRedacted, true);
      assert.equal(materializedAdapter?.balanceUserID, "42");

      const clientSettings = ServerSettingsModule.redactServerSettingsForClient(next);
      const clientAdapter = (
        clientSettings.providerInstances[instanceId]?.config as
          | {
              adapters: Array<Record<string, unknown>>;
            }
          | undefined
      )?.adapters[0];
      assert.equal(clientAdapter?.balanceAccessToken, "");
      assert.equal(clientAdapter?.balanceAccessTokenRedacted, true);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "napi-balance-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persistedAdapter = JSON.parse(raw).providerInstances.byok_newapi.config.adapters[0];
      assert.equal(persistedAdapter.balanceAccessToken, "");
      assert.equal(persistedAdapter.balanceAccessTokenRedacted, true);
      assert.equal(persistedAdapter.balanceUserID, "42");

      // An unrelated save that round-trips the redacted token must not lose it.
      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            displayName: "NewAPI instance",
            config: {
              adapters: [{ ...persistedAdapter, balanceAccessToken: "" }],
            },
          },
        },
      });
      const roundTrippedAdapter = (
        roundTripped.providerInstances[instanceId]?.config as
          | {
              adapters: Array<Record<string, unknown>>;
            }
          | undefined
      )?.adapters[0];
      assert.equal(roundTrippedAdapter?.balanceAccessToken, "napi-balance-secret");

      // Explicitly clearing the token drops the secret and the redacted flag.
      const { balanceAccessTokenRedacted: _omitFlag, ...clearedInput } =
        roundTrippedAdapter as Record<string, unknown>;
      const cleared = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            config: {
              adapters: [{ ...clearedInput, balanceAccessToken: "" }],
            },
          },
        },
      });
      const clearedAdapter =
        (
          cleared.providerInstances[instanceId]?.config as
            | {
                adapters: Array<Record<string, unknown>>;
              }
            | undefined
        )?.adapters[0] ?? {};
      assert.equal(clearedAdapter.balanceAccessToken, "");
      assert.equal(clearedAdapter.balanceAccessTokenRedacted, undefined);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("reuses a stored BYOK key for discovered adapters without persisting the key", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("byok_discovery");

      const sourceAdapter = {
        id: "source-model",
        displayName: "Source model",
        protocol: "openai" as const,
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-source-secret",
        modelId: "source-model",
        contextWindowTokens: 128000,
      };
      const first = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            config: { adapters: [sourceAdapter] },
          },
        },
      });
      const persistedSource = (
        first.providerInstances[instanceId]?.config as
          | { adapters: Array<Record<string, unknown>> }
          | undefined
      )?.adapters[0];

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("byok"),
            config: {
              adapters: [
                persistedSource,
                {
                  id: "discovered-model",
                  displayName: "Discovered model",
                  protocol: "openai" as const,
                  baseURL: sourceAdapter.baseURL,
                  apiKey: "",
                  apiKeyRedacted: true,
                  apiKeySourceAdapterId: sourceAdapter.id,
                  modelId: "discovered-model",
                  contextWindowTokens: 128000,
                },
              ],
            },
          },
        },
      });

      const materialized =
        (
          next.providerInstances[instanceId]?.config as
            | { adapters: Array<Record<string, unknown>> }
            | undefined
        )?.adapters ?? [];
      assert.equal(materialized[1]?.apiKey, "sk-source-secret");
      assert.equal(materialized[1]?.apiKeySourceAdapterId, sourceAdapter.id);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-source-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const persisted = JSON.parse(raw).providerInstances.byok_discovery.config.adapters;
      assert.equal(persisted[1].apiKey, "");
      assert.equal(persisted[1].apiKeyRedacted, true);
      assert.equal(persisted[1].apiKeySourceAdapterId, sourceAdapter.id);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("stores sensitive provider instance environment values outside settings.json", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("codex_personal");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            environment: [
              { name: "OPENROUTER_API_KEY", value: "sk-or-secret", sensitive: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "sk-or-secret",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "sk-or-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.codex_personal.environment, [
        {
          name: "OPENROUTER_API_KEY",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
      ]);

      const roundTripped = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Personal",
            environment: [
              { name: "OPENROUTER_API_KEY", value: "", sensitive: true, valueRedacted: true },
              { name: "ANTHROPIC_BASE_URL", value: "https://openrouter.ai/api", sensitive: false },
            ],
            config: {},
          },
        },
      });

      assert.equal(
        roundTripped.providerInstances[instanceId]?.environment?.[0]?.value,
        "sk-or-secret",
      );
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("迁移历史 Multica 非敏感凭据并保留显式清除语义", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("multica_legacy");

      yield* fileSystem.writeFileString(
        serverConfig.settingsPath,
        '{"providerInstances":{"multica_legacy":{"driver":"multica","environment":[{"name":"MULTICA_TOKEN","value":"legacy-secret","sensitive":false}],"config":{"runtimeId":"multica:daemon-1:runtime-1","daemonId":"daemon-1","daemonRuntimeId":"runtime-1","baseUrl":"http://127.0.0.1:9000","headers":[{"headerName":"Private-Token","environmentVariable":"MULTICA_TOKEN"}],"assigneeRoutes":[]}}}}',
      );
      const legacySettings = yield* serverSettings.getSettings;

      const rawLegacySettings = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.include(rawLegacySettings, "legacy-secret");

      const clientSnapshot = ServerSettingsModule.redactServerSettingsForClient(legacySettings);
      assert.deepEqual(clientSnapshot.providerInstances[instanceId]?.environment, [
        { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
      ]);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.notInclude(JSON.stringify(clientSnapshot), "legacy-secret");

      const migrated = yield* serverSettings.updateSettings({
        providerInstances: clientSnapshot.providerInstances,
        multicaProviderInstancePreconditions: [
          {
            instanceId,
            expectedRevision: multicaProviderInstanceRevision(
              instanceId,
              clientSnapshot.providerInstances[instanceId],
            ),
          },
        ],
      });
      assert.equal(
        migrated.providerInstances[instanceId]?.environment?.[0]?.value,
        "legacy-secret",
      );

      const rawAfterMigration = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(rawAfterMigration, "legacy-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rawAfterMigration).providerInstances.multica_legacy.environment, [
        { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
      ]);

      const clientInstance = clientSnapshot.providerInstances[instanceId]!;
      const cleared = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...clientInstance,
            environment: (clientInstance.environment ?? []).map((variable) =>
              variable.name === "MULTICA_TOKEN"
                ? { name: variable.name, value: "", sensitive: true }
                : variable,
            ),
          },
        },
        multicaProviderInstancePreconditions: [
          {
            instanceId,
            expectedRevision: multicaProviderInstanceRevision(
              instanceId,
              migrated.providerInstances[instanceId],
            ),
          },
        ],
      });
      assert.deepEqual(cleared.providerInstances[instanceId]?.environment, [
        { name: "MULTICA_TOKEN", value: "", sensitive: true },
      ]);

      const rawAfterClear = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(rawAfterClear, "legacy-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(rawAfterClear).providerInstances.multica_legacy.environment, [
        { name: "MULTICA_TOKEN", value: "", sensitive: true },
      ]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("将 Multica Secret Header 环境变量强制存入 secret store", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("multica_secret_header");

      const next = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            driver: ProviderDriverKind.make("multica"),
            environment: [{ name: "MULTICA_TOKEN", value: "direct-secret", sensitive: false }],
            config: {
              runtimeId: "multica:daemon-1:runtime-1",
              daemonId: "daemon-1",
              daemonRuntimeId: "runtime-1",
              baseUrl: "http://127.0.0.1:9000",
              headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
              assigneeRoutes: [],
            },
          },
        },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: null }],
      });

      assert.deepEqual(next.providerInstances[instanceId]?.environment, [
        { name: "MULTICA_TOKEN", value: "direct-secret", sensitive: true, valueRedacted: true },
      ]);
      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.notInclude(raw, "direct-secret");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      assert.deepEqual(JSON.parse(raw).providerInstances.multica_secret_header.environment, [
        { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
      ]);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("在持久化前拒绝不安全的 Multica URL", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const instanceId = ProviderInstanceId.make("multica_safe");
      const instance = {
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
        },
      };
      const persisted = yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: instance },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: null }],
      });
      const before = yield* fileSystem.readFileString(serverConfig.settingsPath);

      for (const config of [
        { ...instance.config, baseUrl: "https://operator:secret@multica.test/api" },
        { ...instance.config, baseUrl: "file:///tmp/multica" },
        {
          ...instance.config,
          taskMcpEndpoint: "https://operator:secret@codework.test/mcp",
        },
        {
          ...instance.config,
          taskMcpEndpoint: "https://codework.test/mcp?authorizationCode=secret",
        },
        { ...instance.config, taskMcpEndpoint: "file:///tmp/mcp" },
      ]) {
        const error = yield* Effect.flip(
          serverSettings.updateSettings({
            providerInstances: { [instanceId]: { ...instance, config } },
            multicaProviderInstancePreconditions: [
              {
                instanceId,
                expectedRevision: multicaProviderInstanceRevision(
                  instanceId,
                  persisted.providerInstances[instanceId],
                ),
              },
            ],
          }),
        );
        if (error._tag !== "ServerSettingsError") {
          throw new Error("不安全 URL 不应产生 Multica 并发冲突。");
        }
        assert.equal(error.operation, "normalize");
        assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), before);
      }
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("以服务端 revision 拒绝并发的 Multica 保存和删除", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("multica_concurrent");
      const instance = {
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
          version: "v1",
        },
      };
      const versionOne = yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: instance },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: null }],
      });
      const clientA = ServerSettingsModule.redactServerSettingsForClient(versionOne);
      const clientB = ServerSettingsModule.redactServerSettingsForClient(versionOne);
      const expectedVersionOne = multicaProviderInstanceRevision(
        instanceId,
        clientA.providerInstances[instanceId],
      );

      const versionTwo = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: {
            ...clientB.providerInstances[instanceId]!,
            config: { ...instance.config, version: "v2" },
          },
        },
        multicaProviderInstancePreconditions: [
          {
            instanceId,
            expectedRevision: multicaProviderInstanceRevision(
              instanceId,
              clientB.providerInstances[instanceId],
            ),
          },
        ],
      });
      assert.notEqual(
        multicaProviderInstanceRevision(instanceId, versionTwo.providerInstances[instanceId]),
        expectedVersionOne,
      );

      const staleSave = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              ...clientA.providerInstances[instanceId]!,
              config: { ...instance.config, version: "v3" },
            },
          },
          multicaProviderInstancePreconditions: [
            { instanceId, expectedRevision: expectedVersionOne },
          ],
        }),
      );
      assert.equal(staleSave._tag, "ServerSettingsConflictError");

      const staleDelete = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {},
          multicaProviderInstancePreconditions: [
            { instanceId, expectedRevision: expectedVersionOne },
          ],
        }),
      );
      assert.equal(staleDelete._tag, "ServerSettingsConflictError");

      const missingPrecondition = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: {
              ...versionTwo.providerInstances[instanceId]!,
              config: { ...instance.config, version: "v4" },
            },
          },
        }),
      );
      assert.equal(missingPrecondition._tag, "ServerSettingsConflictError");

      const revisionTwo = multicaProviderInstanceRevision(
        instanceId,
        versionTwo.providerInstances[instanceId],
      );
      const { settingsRevision: _ignoredRevision, ...legacyClientInstance } =
        versionTwo.providerInstances[instanceId]!;
      const revisionPreserved = yield* serverSettings.updateSettings({
        providerInstances: {
          [instanceId]: { ...legacyClientInstance, settingsRevision: "forged-by-client" },
        },
      });
      assert.equal(
        multicaProviderInstanceRevision(
          instanceId,
          revisionPreserved.providerInstances[instanceId],
        ),
        revisionTwo,
      );

      const unrelatedUpdate = yield* serverSettings.updateSettings({
        enableAgentBrowserAccess: false,
      });
      assert.equal(
        multicaProviderInstanceRevision(instanceId, unrelatedUpdate.providerInstances[instanceId]),
        revisionTwo,
      );

      const current = yield* serverSettings.getSettings;
      const currentInstance = current.providerInstances[instanceId]!;
      assert.equal((currentInstance.config as { readonly version?: string }).version, "v2");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("逐条校验 Multica CAS precondition，不允许未变指纹绕过", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const noOpId = ProviderInstanceId.make("multica_stale_noop");
      const sourceId = ProviderInstanceId.make("multica_same_fingerprint_source");
      const targetId = ProviderInstanceId.make("multica_same_fingerprint_target");
      const multica = (version: string) => ({
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
          version,
        },
      });

      const versionOne = yield* serverSettings.updateSettings({
        providerInstances: { [noOpId]: multica("v1") },
        multicaProviderInstancePreconditions: [{ instanceId: noOpId, expectedRevision: null }],
      });
      const revisionOne = multicaProviderInstanceRevision(
        noOpId,
        versionOne.providerInstances[noOpId],
      );
      const versionTwo = yield* serverSettings.updateSettings({
        providerInstances: { [noOpId]: multica("v2") },
        multicaProviderInstancePreconditions: [
          { instanceId: noOpId, expectedRevision: revisionOne },
        ],
      });
      const revisionTwo = multicaProviderInstanceRevision(
        noOpId,
        versionTwo.providerInstances[noOpId],
      );

      const staleNoOp = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: { [noOpId]: versionTwo.providerInstances[noOpId]! },
          multicaProviderInstancePreconditions: [
            { instanceId: noOpId, expectedRevision: revisionOne },
          ],
        }),
      );
      assert.equal(staleNoOp._tag, "ServerSettingsConflictError");

      yield* serverSettings.updateSettings({
        providerInstances: {},
        multicaProviderInstancePreconditions: [
          { instanceId: noOpId, expectedRevision: revisionTwo },
        ],
      });
      const staleDelete = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {},
          multicaProviderInstancePreconditions: [
            { instanceId: noOpId, expectedRevision: revisionTwo },
          ],
        }),
      );
      assert.equal(staleDelete._tag, "ServerSettingsConflictError");

      const source = yield* serverSettings.updateSettings({
        providerInstances: { [sourceId]: multica("same") },
        multicaProviderInstancePreconditions: [{ instanceId: sourceId, expectedRevision: null }],
      });
      yield* serverSettings.updateSettings({
        providerInstances: { [targetId]: multica("same") },
        multicaProviderInstancePreconditions: [{ instanceId: targetId, expectedRevision: null }],
      });
      const renameConflict = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: { [targetId]: multica("same") },
          multicaProviderInstancePreconditions: [
            {
              instanceId: sourceId,
              expectedRevision: multicaProviderInstanceRevision(
                sourceId,
                source.providerInstances[sourceId],
              ),
            },
            { instanceId: targetId, expectedRevision: null },
          ],
        }),
      );
      assert.equal(renameConflict._tag, "ServerSettingsConflictError");

      const current = yield* serverSettings.getSettings;
      assert.equal(current.providerInstances[sourceId]?.driver, "multica");
      assert.equal(current.providerInstances[targetId]?.driver, "multica");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("拒绝创建或重命名覆盖已存在的非 Multica 实例", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const sourceId = ProviderInstanceId.make("multica_source");
      const targetId = ProviderInstanceId.make("shared_target");
      const multica = {
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
        },
      };
      yield* serverSettings.updateSettings({
        providerInstances: {
          [targetId]: { driver: ProviderDriverKind.make("codex"), config: {} },
        },
      });
      const initial = yield* serverSettings.updateSettings({
        providerInstances: { [sourceId]: multica },
        multicaProviderInstancePreconditions: [{ instanceId: sourceId, expectedRevision: null }],
      });
      const sourceRevision = multicaProviderInstanceRevision(
        sourceId,
        initial.providerInstances[sourceId],
      );

      const createConflict = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [targetId]: multica,
          },
          multicaProviderInstancePreconditions: [{ instanceId: targetId, expectedRevision: null }],
        }),
      );
      assert.equal(createConflict._tag, "ServerSettingsConflictError");

      const renameConflict = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: { [targetId]: multica },
          multicaProviderInstancePreconditions: [
            { instanceId: sourceId, expectedRevision: sourceRevision },
            { instanceId: targetId, expectedRevision: null },
          ],
        }),
      );
      assert.equal(renameConflict._tag, "ServerSettingsConflictError");

      const duplicateConflict = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [sourceId]: {
              ...initial.providerInstances[sourceId]!,
              config: { ...multica.config, version: "v2" },
            },
          },
          multicaProviderInstancePreconditions: [
            { instanceId: sourceId, expectedRevision: sourceRevision },
            { instanceId: sourceId, expectedRevision: sourceRevision },
          ],
        }),
      );
      assert.equal(duplicateConflict._tag, "ServerSettingsConflictError");

      const current = yield* serverSettings.getSettings;
      assert.equal(current.providerInstances[sourceId]?.driver, "multica");
      assert.equal(current.providerInstances[targetId]?.driver, "codex");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("Multica 局部 CAS mutation 保留并发实例更新并拒绝混合整图意图", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex_parallel");
      const firstMulticaId = ProviderInstanceId.make("multica_first");
      const secondMulticaId = ProviderInstanceId.make("multica_second");
      const multica = (version: string) => ({
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: `multica:daemon-1:runtime-${version}`,
          daemonId: "daemon-1",
          daemonRuntimeId: `runtime-${version}`,
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
          version,
        },
      });

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v1" } },
        },
      });
      yield* serverSettings.updateSettings({
        providerInstances: { [firstMulticaId]: multica("v1") },
        multicaProviderInstancePreconditions: [
          { instanceId: firstMulticaId, expectedRevision: null },
        ],
      });
      const before = yield* serverSettings.updateSettings({
        providerInstances: { [secondMulticaId]: multica("v1") },
        multicaProviderInstancePreconditions: [
          { instanceId: secondMulticaId, expectedRevision: null },
        ],
      });
      const firstRevision = multicaProviderInstanceRevision(
        firstMulticaId,
        before.providerInstances[firstMulticaId],
      );
      const secondRevision = multicaProviderInstanceRevision(
        secondMulticaId,
        before.providerInstances[secondMulticaId],
      );

      const concurrentCodex = yield* serverSettings.updateSettings({
        providerInstances: {
          ...before.providerInstances,
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v2" } },
        },
      });
      const saved = yield* serverSettings.updateSettings({
        providerInstances: { [firstMulticaId]: multica("v2") },
        multicaProviderInstancePreconditions: [
          { instanceId: firstMulticaId, expectedRevision: firstRevision },
        ],
      });
      const savedCodex = saved.providerInstances[codexId];
      const savedSecondMultica = saved.providerInstances[secondMulticaId];
      if (savedCodex === undefined || savedSecondMultica === undefined) {
        return yield* Effect.die("missing saved provider instance");
      }
      assert.equal((savedCodex.config as { readonly version?: string }).version, "v2");
      assert.equal((savedSecondMultica.config as { readonly version?: string }).version, "v1");
      assert.equal(
        multicaProviderInstanceRevision(secondMulticaId, savedSecondMultica),
        secondRevision,
      );
      const concurrentCodexInstance = concurrentCodex.providerInstances[codexId];
      if (concurrentCodexInstance === undefined) {
        return yield* Effect.die("missing concurrent Codex instance");
      }
      assert.equal((concurrentCodexInstance.config as { readonly version?: string }).version, "v2");

      const mixedIntent = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [firstMulticaId]: multica("v3"),
            [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v3" } },
          },
          multicaProviderInstancePreconditions: [
            {
              instanceId: firstMulticaId,
              expectedRevision: multicaProviderInstanceRevision(
                firstMulticaId,
                saved.providerInstances[firstMulticaId],
              ),
            },
          ],
        }),
      );
      assert.equal(mixedIntent._tag, "ServerSettingsConflictError");

      const nonMulticaMutation = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v3" } },
          },
          multicaProviderInstancePreconditions: [{ instanceId: codexId, expectedRevision: null }],
        }),
      );
      assert.equal(nonMulticaMutation._tag, "ServerSettingsConflictError");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("Supplier 的 Multica enable 与凭据写入保留其它实例并拒绝同实例并发", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const codexId = ProviderInstanceId.make("codex_supplier_parallel");
      const multicaId = ProviderInstanceId.make("multica_supplier_parallel");
      const multica = (version: string) => ({
        driver: ProviderDriverKind.make("multica"),
        enabled: true,
        environment: [{ name: "MULTICA_TOKEN", value: "supplier-secret-v1", sensitive: true }],
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
          assigneeRoutes: [],
          version,
        },
      });

      yield* serverSettings.updateSettings({
        providerInstances: {
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v1" } },
        },
      });
      yield* serverSettings.updateSettings({
        providerInstances: { [multicaId]: multica("v1") },
        multicaProviderInstancePreconditions: [{ instanceId: multicaId, expectedRevision: null }],
      });
      const beforeEnable = yield* serverSettings.getSettings;
      const enableOutcome = setSupplierInstanceEnabled(
        beforeEnable.providerInstances,
        multicaId,
        false,
      );
      if (!enableOutcome.ok) return yield* Effect.die(enableOutcome.code);
      const enablePatch = buildSupplierProviderInstancePatch(
        beforeEnable.providerInstances,
        enableOutcome.value.providerInstances,
        multicaId,
      );
      yield* serverSettings.updateSettings({
        providerInstances: {
          ...beforeEnable.providerInstances,
          [codexId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v2" } },
        },
      });
      const enabled = yield* serverSettings.updateSettings(enablePatch);
      const enabledMultica = enabled.providerInstances[multicaId];
      const enabledCodex = enabled.providerInstances[codexId];
      if (enabledMultica === undefined || enabledCodex === undefined) {
        return yield* Effect.die("missing enabled provider instance");
      }
      assert.equal(enabledMultica.enabled, false);
      assert.equal((enabledCodex.config as { readonly version?: string }).version, "v2");

      const beforeCredential = yield* serverSettings.getSettings;
      const credentialOutcome = applySupplierCredentialUpdate(
        beforeCredential.providerInstances,
        multicaId,
        { kind: "environment_variable", name: "MULTICA_TOKEN", value: "supplier-secret-v2" },
      );
      if (!credentialOutcome.ok) return yield* Effect.die(credentialOutcome.code);
      const credentialPatch = buildSupplierProviderInstancePatch(
        beforeCredential.providerInstances,
        credentialOutcome.value.providerInstances,
        multicaId,
      );
      yield* serverSettings.updateSettings({
        providerInstances: {
          [multicaId]: {
            ...beforeCredential.providerInstances[multicaId]!,
            config: { ...multica("v1").config, version: "v2" },
          },
        },
        multicaProviderInstancePreconditions: [
          {
            instanceId: multicaId,
            expectedRevision: multicaProviderInstanceRevision(
              multicaId,
              beforeCredential.providerInstances[multicaId],
            ),
          },
        ],
      });
      const credentialConflict = yield* Effect.flip(serverSettings.updateSettings(credentialPatch));
      assert.equal(credentialConflict._tag, "ServerSettingsConflictError");
      const current = yield* serverSettings.getSettings;
      const currentMultica = current.providerInstances[multicaId];
      if (currentMultica === undefined)
        return yield* Effect.die("missing current Multica instance");
      assert.equal((currentMultica.config as { readonly version?: string }).version, "v2");
      assert.equal(currentMultica.environment?.[0]?.value, "supplier-secret-v1");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("显式敏感环境变量的新值推进 Multica revision 并拒绝过期 CAS", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("multica_unbound_sensitive");
      const multica = (value: string) => ({
        driver: ProviderDriverKind.make("multica"),
        environment: [{ name: "UNBOUND_SECRET", value, sensitive: true }],
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
        },
      });

      const initial = yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: multica("secret-v1") },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: null }],
      });
      const initialRevision = multicaProviderInstanceRevision(
        instanceId,
        initial.providerInstances[instanceId],
      );
      const before = yield* serverSettings.getSettings;
      const stalePatch = (value: string) => ({
        providerInstances: {
          [instanceId]: {
            ...before.providerInstances[instanceId]!,
            environment: multica(value).environment,
          },
        },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: initialRevision }],
      });

      const first = yield* serverSettings.updateSettings(stalePatch("secret-a"));
      assert.notEqual(
        multicaProviderInstanceRevision(instanceId, first.providerInstances[instanceId]),
        initialRevision,
      );

      const stale = yield* Effect.flip(serverSettings.updateSettings(stalePatch("secret-b")));
      assert.equal(stale._tag, "ServerSettingsConflictError");
      const current = yield* serverSettings.getSettings;
      assert.equal(current.providerInstances[instanceId]?.environment?.[0]?.value, "secret-a");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("Multica 局部 mutation 只接受专属顶层字段，并禁止驱动降级", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const instanceId = ProviderInstanceId.make("multica_partial_contract");
      const multica = (version: string) => ({
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: "multica:daemon-1:runtime-1",
          daemonId: "daemon-1",
          daemonRuntimeId: "runtime-1",
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
          version,
        },
      });

      const created = yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: multica("v1") },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: null }],
      });
      const revision = multicaProviderInstanceRevision(
        instanceId,
        created.providerInstances[instanceId],
      );
      const mixedTopLevel = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: { [instanceId]: multica("v2") },
          multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: revision }],
          enableAgentBrowserAccess: false,
        }),
      );
      assert.equal(mixedTopLevel._tag, "ServerSettingsConflictError");

      const driverDowngrade = yield* Effect.flip(
        serverSettings.updateSettings({
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("codex"), config: { version: "v2" } },
          },
          multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: revision }],
        }),
      );
      assert.equal(driverDowngrade._tag, "ServerSettingsConflictError");

      const updated = yield* serverSettings.updateSettings({
        providerInstances: { [instanceId]: multica("v2") },
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: revision }],
      });
      const updatedRevision = multicaProviderInstanceRevision(
        instanceId,
        updated.providerInstances[instanceId],
      );
      const deleted = yield* serverSettings.updateSettings({
        providerInstances: {},
        multicaProviderInstancePreconditions: [{ instanceId, expectedRevision: updatedRevision }],
      });
      assert.equal(deleted.providerInstances[instanceId], undefined);
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("不同 Multica 实例可基于同一快照交错局部更新", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
      const firstId = ProviderInstanceId.make("multica_interleave_first");
      const secondId = ProviderInstanceId.make("multica_interleave_second");
      const multica = (runtime: string, version: string) => ({
        driver: ProviderDriverKind.make("multica"),
        config: {
          runtimeId: `multica:daemon-1:${runtime}`,
          daemonId: "daemon-1",
          daemonRuntimeId: runtime,
          baseUrl: "http://127.0.0.1:9000",
          headers: [],
          assigneeRoutes: [],
          version,
        },
      });

      yield* serverSettings.updateSettings({
        providerInstances: { [firstId]: multica("first", "v1") },
        multicaProviderInstancePreconditions: [{ instanceId: firstId, expectedRevision: null }],
      });
      const snapshot = yield* serverSettings.updateSettings({
        providerInstances: { [secondId]: multica("second", "v1") },
        multicaProviderInstancePreconditions: [{ instanceId: secondId, expectedRevision: null }],
      });
      const firstRevision = multicaProviderInstanceRevision(
        firstId,
        snapshot.providerInstances[firstId],
      );
      const secondRevision = multicaProviderInstanceRevision(
        secondId,
        snapshot.providerInstances[secondId],
      );

      yield* serverSettings.updateSettings({
        providerInstances: { [firstId]: multica("first", "v2") },
        multicaProviderInstancePreconditions: [
          { instanceId: firstId, expectedRevision: firstRevision },
        ],
      });
      const saved = yield* serverSettings.updateSettings({
        providerInstances: { [secondId]: multica("second", "v2") },
        multicaProviderInstancePreconditions: [
          { instanceId: secondId, expectedRevision: secondRevision },
        ],
      });
      const savedFirst = saved.providerInstances[firstId];
      const savedSecond = saved.providerInstances[secondId];
      if (savedFirst === undefined || savedSecond === undefined) {
        return yield* Effect.die("missing interleaved Multica instance");
      }
      assert.equal((savedFirst.config as { readonly version?: string }).version, "v2");
      assert.equal((savedSecond.config as { readonly version?: string }).version, "v2");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
