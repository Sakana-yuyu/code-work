// @effect-diagnostics nodeBuiltinImport:off - 集成测试运行本机 ACP 子进程。
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AcpAgentSettings, ProviderInstanceId, ThreadId } from "@codework/contracts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { classifyAcpCommandProbe, GenericAcpDriver } from "./GenericAcpDriver.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";

const decodeAcpSettings = Schema.decodeEffect(AcpAgentSettings);
const encodeLiteral = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const driverTestLayer = Layer.mergeAll(BackgroundPolicy.layer, ServerSecretStore.layer).pipe(
  Layer.provideMerge(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "acp-driver-test-" })),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(driverTestLayer)("ACP 命令实际启动", (it) => {
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
