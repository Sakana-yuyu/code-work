// @effect-diagnostics nodeBuiltinImport:off - 集成测试运行本机 ACP 子进程。
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
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
import { classifyAcpCommandProbe, GenericAcpDriver } from "./GenericAcpDriver.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";

const decodeAcpSettings = Schema.decodeEffect(AcpAgentSettings);
const encodeLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const decodeArgs = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const driverTestLayer = Layer.mergeAll(BackgroundPolicy.layer, ServerSecretStore.layer).pipe(
  Layer.provideMerge(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "acp-driver-test-" })),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(driverTestLayer)("ACP 命令实际启动", (it) => {
  it.effect("空认证配置贯穿驱动，新建和恢复不发送 authenticate", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-no-auth-" });
      const log = NodePath.join(directory, "requests.ndjson");
      const launcher = NodePath.join(directory, "fixture.mjs");
      const mockAgent = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href;
      yield* fs.writeFileString(
        launcher,
        `process.env.CODEWORK_ACP_REQUEST_LOG_PATH = ${encodeLiteral(log)};\nawait import(${encodeLiteral(mockAgent)});\n`,
      );
      const instanceId = ProviderInstanceId.make("acp-no-auth");
      const threadId = ThreadId.make("acp-no-auth");
      const instance = yield* GenericAcpDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: yield* decodeAcpSettings({
          command: `"${process.execPath}" "${launcher}"`,
          authMethodId: "",
        }),
      });
      const input = {
        threadId,
        provider: GenericAcpDriver.driverKind,
        cwd: directory,
        runtimeMode: "approval-required" as const,
        modelSelection: { instanceId, model: "default" },
      };
      const session = yield* instance.adapter.startSession(input);
      yield* instance.adapter.stopSession(threadId);
      yield* instance.adapter.startSession({ ...input, resumeCursor: session.resumeCursor });
      yield* instance.adapter.stopSession(threadId);
      const decodeRequest = Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
      );
      const requests = yield* Effect.forEach(
        (yield* fs.readFileString(log)).trim().split("\n"),
        (line) => decodeRequest(line),
      );
      expect(requests.some((request) => request.method === "authenticate")).toBe(false);
      expect(requests.filter((request) => request.method === "session/new")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "session/load")).toHaveLength(1);
      expect((yield* decodeAcpSettings({})).authMethodId).toBe("login");
    }),
  );
  it.effect("无模型广告时保留 CLI 默认入口，角色与权限原样往返并拒绝失效值", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-config-selection-" });
      const log = NodePath.join(directory, "requests.ndjson");
      const launcher = NodePath.join(directory, "fixture.mjs");
      const mockAgent = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href;
      yield* fs.writeFileString(
        launcher,
        `process.env.CODEWORK_ACP_COPILOT_CONFIG = "1";\nprocess.env.CODEWORK_ACP_REQUEST_LOG_PATH = ${encodeLiteral(log)};\nif (process.argv.includes("--version")) console.log("1.0.0"); else await import(${encodeLiteral(mockAgent)});\n`,
      );
      const instanceId = ProviderInstanceId.make("acp-config");
      const threadId = ThreadId.make("acp-config");
      const instance = yield* GenericAcpDriver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [],
        config: yield* decodeAcpSettings({
          command: `"${process.execPath}" "${launcher}"`,
          authMethodId: "test",
        }),
      });
      expect((yield* instance.snapshot.refresh).models).toMatchObject([
        { slug: "default", name: "CLI 默认模型", isCustom: false },
      ]);
      const started = yield* instance.adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "thread.started"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* instance.adapter.startSession({
        threadId,
        provider: GenericAcpDriver.driverKind,
        cwd: directory,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "default" },
      });
      const startup = Array.from(yield* Fiber.join(started)).find(
        (event) => event.type === "session.started",
      );
      expect(startup?.payload.models).toBeNull();
      expect(startup?.payload.configOptions).toMatchObject([
        { id: "acpConfig:agent", currentValue: "value:" },
        { id: "acpConfig:allow_all", currentValue: "value:off" },
      ]);
      for (const [agent, permission] of [
        ["reviewer", "on"],
        ["", "off"],
      ]) {
        const completed = yield* instance.adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* instance.adapter.sendTurn({
          threadId,
          input: "角色与权限配置验证",
          modelSelection: {
            instanceId,
            model: "default",
            options: [
              { id: "acpConfig:agent", value: `value:${agent}` },
              { id: "acpConfig:allow_all", value: `value:${permission}` },
            ],
          },
        });
        const events = Array.from(yield* Fiber.join(completed));
        expect(events.some((event) => event.type === "runtime.error")).toBe(false);
        const activity = events
          .flatMap((event) => runtimeEventToActivities(event))
          .findLast((activity) => activity.kind === "session.config-options.updated");
        expect(activity?.payload).toMatchObject({
          providerInstanceId: instanceId,
          configOptions: [
            { currentValue: `value:${agent}` },
            { currentValue: `value:${permission}` },
          ],
        });
      }
      for (const value of ["value:missing", true]) {
        expect(
          (yield* instance.adapter
            .sendTurn({
              threadId,
              input: "不得发送",
              modelSelection: {
                instanceId,
                model: "default",
                options: [{ id: "acpConfig:agent", value }],
              },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      yield* instance.adapter.stopSession(threadId);
      const decodeRequest = Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({ method: Schema.String, params: Schema.optional(Schema.Unknown) }),
        ),
      );
      const requests = yield* Effect.forEach(
        (yield* fs.readFileString(log)).trim().split("\n"),
        (line) => decodeRequest(line),
      );
      expect(
        requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => request.params),
      ).toEqual([
        { sessionId: "mock-session-1", configId: "agent", value: "reviewer" },
        { sessionId: "mock-session-1", configId: "allow_all", value: "on" },
        { sessionId: "mock-session-1", configId: "agent", value: "" },
        { sessionId: "mock-session-1", configId: "allow_all", value: "off" },
      ]);
      expect(requests.filter((request) => request.method === "session/prompt")).toHaveLength(2);
    }),
  );
  it.effect("实例关闭 MCP 后新建与恢复均不注入，其它实例保持默认开启", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-mcp-" });
      const mockAgent = NodeURL.pathToFileURL(
        NodeURL.fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
      ).href;
      const decodeRequest = Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            method: Schema.optional(Schema.String),
            params: Schema.optional(
              Schema.Struct({ mcpServers: Schema.optional(Schema.Array(Schema.Unknown)) }),
            ),
          }),
        ),
      );
      for (const [index, supportsMcpServers] of [false, undefined, true].entries()) {
        const log = NodePath.join(directory, `requests-${index}.ndjson`);
        const launcher = NodePath.join(directory, `fixture-${index}.mjs`);
        yield* fs.writeFileString(
          launcher,
          `process.env.CODEWORK_ACP_REQUEST_LOG_PATH = ${encodeLiteral(log)};\nawait import(${encodeLiteral(mockAgent)});\n`,
        );
        const instanceId = ProviderInstanceId.make(`acp-mcp-${index}`);
        const threadId = ThreadId.make(`acp-mcp-${index}`);
        const mcp = {
          environmentId: EnvironmentId.make("acp-mcp-test"),
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
          config: yield* decodeAcpSettings({
            command: `"${process.execPath}" "${launcher}"`,
            authMethodId: "test",
            ...(supportsMcpServers === undefined ? {} : { supportsMcpServers }),
          }),
        });
        const input = {
          threadId,
          provider: GenericAcpDriver.driverKind,
          cwd: directory,
          runtimeMode: "full-access" as const,
          modelSelection: { instanceId, model: "default" },
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
            supportsMcpServers === false
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
      }
    }),
  );
  it.effect("探测与会话共用带空格参数的原生命令及 Windows 批处理入口", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp launch " });
      const launcher = NodePath.join(directory, "fixture.mjs");
      const log = NodePath.join(directory, "args.json");
      const environmentLog = NodePath.join(directory, "environment.txt");
      const mockAgent = NodeURL.pathToFileURL(
        NodeURL.fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url)),
      ).href;
      yield* fs.writeFileString(
        launcher,
        `
import { writeFileSync } from "node:fs";
writeFileSync(${encodeLiteral(log)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${encodeLiteral(environmentLog)}, process.env.AUGMENT_DISABLE_AUTO_UPDATE ?? "missing");
if (process.argv.includes("--fail")) process.exit(2);
else if (process.argv.includes("--version")) console.log("1.0.0");
else await import(${encodeLiteral(mockAgent)});
`,
      );
      const args = '-y fixture@1.0.0 --label "two words" "value & text"';
      const commands = [`"${process.execPath}" "${launcher}" ${args}`];
      // oxlint-disable-next-line codework/no-global-process-runtime -- 批处理必须在真实 Windows 主机执行。
      if (process.platform === "win32") {
        const shim = NodePath.join(directory, "npx.cmd");
        yield* fs.writeFileString(shim, `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`);
        commands.push(`"${shim}" ${args}`, `npx ${args}`);
      }
      for (const [index, command] of commands.entries()) {
        const instanceId = ProviderInstanceId.make(`acp-launch-${index}`);
        const instance = yield* GenericAcpDriver.create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [
            { name: "AUGMENT_DISABLE_AUTO_UPDATE", value: "1", sensitive: false },
            {
              name: "PATH",
              value: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              sensitive: false,
            },
          ],
          config: yield* decodeAcpSettings({ command, authMethodId: "test" }),
        });
        const probe = yield* instance.snapshot.refresh;
        expect(probe.status, command).toBe("ready");
        expect(yield* fs.readFileString(environmentLog)).toBe("1");
        const expectedArgs = ["-y", "fixture@1.0.0", "--label", "two words", "value & text"];
        expect(yield* decodeArgs(yield* fs.readFileString(log))).toEqual([
          ...expectedArgs,
          "--version",
        ]);
        const threadId = ThreadId.make(`acp-launch-${index}`);
        yield* instance.adapter.startSession({
          threadId,
          provider: GenericAcpDriver.driverKind,
          cwd: directory,
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "default" },
        });
        expect(yield* decodeArgs(yield* fs.readFileString(log))).toEqual(expectedArgs);
        expect(yield* fs.readFileString(environmentLog)).toBe("1");
        yield* instance.adapter.stopSession(threadId);
        const failingInstance = yield* GenericAcpDriver.create({
          instanceId: ProviderInstanceId.make(`acp-fail-${index}`),
          displayName: undefined,
          enabled: true,
          environment: [
            {
              name: "PATH",
              value: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
              sensitive: false,
            },
          ],
          config: yield* decodeAcpSettings({ command: `${command} --fail` }),
        });
        expect((yield* failingInstance.snapshot.refresh).status).toBe("error");
      }
    }),
  );

  it.effect("Kiro 命令沿通用 ACP 实例归属返回结果和错误，普通实例不调用专有执行", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-kiro-routing-" });
      for (const native of [true, false]) {
        const id = native ? "acp-kiro-routing" : "acp-standard-routing";
        const instanceId = ProviderInstanceId.make(id);
        const threadId = ThreadId.make(id);
        const log = NodePath.join(directory, id + ".ndjson");
        const launcher = NodePath.join(directory, id + ".mjs");
        const mock = new URL("../../../scripts/acp-mock-agent.ts", import.meta.url).href;
        yield* fs.writeFileString(launcher,
          'process.env.CODEWORK_ACP_EMIT_KIRO_COMMANDS = ' + encodeLiteral(native ? "1" : "0") + ';\n' +
          'process.env.CODEWORK_ACP_REQUEST_LOG_PATH = ' + encodeLiteral(log) + ';\nawait import(' + encodeLiteral(mock) + ');\n');
        const instance = yield* GenericAcpDriver.create({ instanceId, displayName: undefined, enabled: true, environment: [],
          config: yield* decodeAcpSettings({ command: '"' + process.execPath + '" "' + launcher + '"', authMethodId: "test" }),
        });
        const startup = yield* instance.adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "thread.started"), Stream.runCollect, Effect.forkChild);
        yield* instance.adapter.startSession({ threadId, provider: GenericAcpDriver.driverKind, cwd: directory, runtimeMode: "full-access", modelSelection: { instanceId, model: "default" } });
        const initial = Array.from(yield* Fiber.join(startup)).find((event) => event.type === "session.started");
        expect(initial?.providerInstanceId).toBe(instanceId);
        if (native) expect(initial?.payload.slashCommands?.map((command) => command.name)).toEqual(["agent", "review"]);
        for (const input of native ? ["/agent swap chosen", "/agent reject"] : ["/agent swap chosen"]) {
          const completed = yield* instance.adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "turn.completed"), Stream.runCollect, Effect.forkChild);
          const sent = yield* instance.adapter.sendTurn({ threadId, input }).pipe(Effect.result);
          expect(sent._tag).toBe(input.endsWith("reject") ? "Failure" : "Success");
          const events = Array.from(yield* Fiber.join(completed));
          expect(events.every((event) => event.providerInstanceId === instanceId)).toBe(true);
          const failure = input.endsWith("reject");
          if (failure) expect(events.findLast((event) => event.type === "turn.completed")?.payload.errorMessage).toContain("命令被拒绝");
          if (!failure && native) {
            expect(events.filter((event) => event.type === "content.delta").map((event) => event.payload.delta).join("")).toContain("swap chosen");
          }
          expect(events.findLast((event) => event.type === "turn.completed")?.payload.state).toBe(failure ? "failed" : "completed");
        }
        yield* instance.adapter.stopSession(threadId);
        const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ method: Schema.String })));
        const requests = yield* Effect.forEach((yield* fs.readFileString(log)).trim().split("\n"), (line) => decodeRequest(line));
        expect(requests.filter((request) => request.method === "_kiro.dev/commands/execute")).toHaveLength(native ? 2 : 0);
        expect(requests.filter((request) => request.method === "session/prompt")).toHaveLength(native ? 0 : 1);
      }
    }),
  );
});

describe("GenericAcpDriver 命令探测", () => {
  it("退出码非零时不会把已启动的进程误报为就绪", () => {
    expect(classifyAcpCommandProbe({ stdout: "", stderr: "unknown option", exitCode: 2 })).toEqual({
      status: "error",
      message: "ACP Agent 探测返回退出码 2；请检查安装状态和启动参数。",
    });
  });

  it("仅成功退出时显示有界的诊断输出", () => {
    const outcome = classifyAcpCommandProbe({
      stdout: "v1.2.3".repeat(40),
      stderr: "",
      exitCode: 0,
    });
    expect(outcome.status).toBe("ready");
    expect(outcome.message.length).toBeLessThanOrEqual(135);
  });

  it("版本参数不受支持时仍允许进入实际握手", () => {
    expect(
      classifyAcpCommandProbe({
        stdout: "",
        stderr: "unknown option --version",
        exitCode: 2,
      }).status,
    ).toBe("ready");
    expect(
      classifyAcpCommandProbe({
        stdout: "",
        stderr: "unrecognized option: '--version'",
        exitCode: 2,
      }).status,
    ).toBe("ready");
    expect(
      classifyAcpCommandProbe({
        stdout: "try --version; unknown option --dangerous",
        stderr: "",
        exitCode: 2,
      }).status,
    ).toBe("error");
  });

  it("把常见包仓库错误归为可操作提示，不显示原始输出", () => {
    const outcome = classifyAcpCommandProbe({
      stdout: "",
      stderr: "npm ERR! code E404 token=private-example",
      exitCode: 1,
    });
    expect(outcome.status).toBe("error");
    expect(outcome.message).toContain("未找到指定版本");
    expect(outcome.message).not.toContain("private-example");
  });
});
