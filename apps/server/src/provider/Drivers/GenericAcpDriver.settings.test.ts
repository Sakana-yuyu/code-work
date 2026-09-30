// @effect-diagnostics nodeBuiltinImport:off - 使用已有协议夹具验证实例设置的实际请求。
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AcpAgentSettings, EnvironmentId, ProviderInstanceId, ThreadId } from "@codework/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { GenericAcpDriver } from "./GenericAcpDriver.ts";

const decodeSettings = Schema.decodeEffect(AcpAgentSettings);
const encodeLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(
        Schema.Struct({
          methodId: Schema.optional(Schema.String),
          mcpServers: Schema.optional(Schema.Array(Schema.Unknown)),
        }),
      ),
    }),
  ),
);
const layer = Layer.mergeAll(BackgroundPolicy.layer, ServerSecretStore.layer).pipe(
  Layer.provideMerge(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "acp-settings-test-" })),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("ACP 目录设置实际启动", (it) => {
  it.effect("空认证与 MCP 开关贯穿新建和恢复，缺省设置仍生效", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-settings-" });
      const mockAgent = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href;
      for (const [index, config] of [
        { supportsMcpServers: false, authMethodId: "" },
        {},
        { supportsMcpServers: true, authMethodId: "test" },
      ].entries()) {
        const log = NodePath.join(directory, `requests-${index}.ndjson`);
        const launcher = NodePath.join(directory, `fixture-${index}.mjs`);
        yield* fs.writeFileString(
          launcher,
          `process.env.CODEWORK_ACP_REQUEST_LOG_PATH = ${encodeLiteral(log)};\nawait import(${encodeLiteral(mockAgent)});\n`,
        );
        const instanceId = ProviderInstanceId.make(`acp-settings-${index}`);
        const threadId = ThreadId.make(`acp-settings-${index}`);
        const mcp = {
          environmentId: EnvironmentId.make("acp-settings-test"),
          threadId,
          providerSessionId: `session-${index}`,
          providerInstanceId: instanceId,
          endpoint: "http://127.0.0.1:12345/mcp",
          authorizationHeader: "Bearer test-only",
          capabilities: [],
        };
        setMcpProviderSession(mcp);
        yield* Effect.addFinalizer(() => Effect.sync(() => clearMcpProviderSession(threadId)));
        const instance = yield* GenericAcpDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: yield* decodeSettings({
            command: `"${process.execPath}" "${launcher}"`,
            ...config,
          }),
        });
        const input = {
          threadId,
          provider: GenericAcpDriver.driverKind,
          cwd: directory,
          runtimeMode: "approval-required" as const,
        };
        const session = yield* instance.adapter.startSession(input);
        yield* instance.adapter.stopSession(threadId);
        setMcpProviderSession(mcp);
        yield* instance.adapter.startSession({ ...input, resumeCursor: session.resumeCursor });
        yield* instance.adapter.stopSession(threadId);
        const requests = yield* Effect.forEach(
          (yield* fs.readFileString(log)).trim().split("\n"),
          (line) => decodeRequest(line),
        );
        const setup = requests.filter(
          (request) => request.method === "session/new" || request.method === "session/load",
        );
        expect(setup.map((request) => request.method)).toEqual(["session/new", "session/load"]);
        for (const request of setup) {
          expect(request.params?.mcpServers).toEqual(
            config.supportsMcpServers === false
              ? []
              : [
                  {
                    type: "http",
                    name: "code-work",
                    url: mcp.endpoint,
                    headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                  },
                ],
          );
        }
        const authentication = requests.filter((request) => request.method === "authenticate");
        expect(authentication.map((request) => request.params?.methodId)).toEqual(
          config.authMethodId === ""
            ? []
            : [config.authMethodId ?? "login", config.authMethodId ?? "login"],
        );
      }
    }),
  );
});
