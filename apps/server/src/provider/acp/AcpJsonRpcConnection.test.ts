// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import type * as EffectAcpProtocol from "effect-acp/protocol";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath];
const decodeHostCapabilities = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

describe("AcpSessionRuntime", () => {
  it.effect("关闭不会启动会话，上游不回应时有界失败", () =>
    Effect.gen(function* () {
      const closeStarted = yield* Deferred.make<void>();
      const methods: string[] = [];
      yield* Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.close;
        expect(methods).toEqual([]);
        yield* runtime.start();
        const closing = yield* runtime.close.pipe(Effect.result, Effect.forkScoped);
        yield* Deferred.await(closeStarted);
        yield* TestClock.adjust("6 seconds");
        const result = yield* Fiber.join(closing);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: -32000, method: "session/close" },
        });
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { CODEWORK_ACP_CLOSE_BEHAVIOR: "hang" },
            },
            cwd: process.cwd(),
            authMethodId: "test",
            clientInfo: { name: "codework-test", version: "0.0.0" },
            requestLogger: (event) =>
              Effect.gen(function* () {
                if (event.status !== "started") return;
                methods.push(event.method);
                if (event.method === "session/close")
                  yield* Deferred.succeed(closeStarted, undefined);
              }),
          }),
        ),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  for (const resume of [false, true]) {
    it.effect(`旧式模型${resume ? "恢复" : "新建"}走 set_model，空配置不撤回独立目录`, () => {
      const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const models = yield* runtime.getAvailableModels;
        yield* runtime.setConfigOption("unrelated", "value");
        expect(yield* runtime.getAvailableModels).toEqual(models);
        yield* runtime.setModel("grok-mock-alt");
        expect((yield* runtime.getAvailableModels)?.find((model) => model.isDefault)?.slug).toBe(
          "grok-mock-alt",
        );
        expect(
          requests.filter(
            (event) => event.method === "session/set_model" && event.status === "succeeded",
          ),
        ).toHaveLength(1);
        const failed = yield* runtime.setModel("unknown-model").pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect((yield* runtime.getAvailableModels)?.find((model) => model.isDefault)?.slug).toBe(
          "grok-mock-alt",
        );
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { CODEWORK_ACP_LEGACY_MODELS: "1" },
            },
            cwd: process.cwd(),
            authMethodId: "test",
            clientInfo: { name: "codework-test", version: "0.0.0" },
            ...(resume ? { resumeSessionId: "mock-session-1" } : {}),
            requestLogger: (event) =>
              Effect.sync(() => {
                requests.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });
  }
  for (const decision of ["allow-native", "deny-native", "cancel"] as const) {
    it.effect(`仅审批的 ${decision} 终态不生成工具，真实执行和跨会话身份仍保留`, () =>
      Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        const events: AcpSessionRuntime.AcpSessionRuntimeEvent[] = [];
        const approvals: string[] = [];
        yield* runtime.handleRequestPermission((request) => {
          approvals.push(request.toolCall.toolCallId);
          return Effect.succeed({
            outcome:
              decision === "cancel"
                ? { outcome: "cancelled" as const }
                : { outcome: "selected" as const, optionId: decision },
          });
        });
        yield* runtime.start();
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier")
              return Deferred.succeed(event.acknowledge, undefined);
            events.push(event);
            return Effect.void;
          }),
          Effect.forkChild,
        );
        yield* runtime.prompt({ prompt: [{ type: "text", text: "first" }] });
        yield* runtime.drainEvents;
        const tools = events.flatMap((event) =>
          event._tag === "ToolCallUpdated" ? [event.toolCall] : [],
        );
        expect(approvals).toHaveLength(7);
        expect([...new Set(tools.map((tool) => tool.toolCallId))]).toEqual([
          "real-before",
          "real-after",
          "real-output",
          "mismatch",
          "foreign",
          "unknown",
        ]);
        expect(tools.find((tool) => tool.toolCallId === "real-output")?.detail).toBe(
          "实际执行结果",
        );
        expect(tools.find((tool) => tool.toolCallId === "mismatch")?.status).toBe(
          decision === "allow-native" ? "failed" : "completed",
        );
        yield* runtime.prompt({ prompt: [{ type: "text", text: "second" }] });
        yield* runtime.drainEvents;
        expect(events.at(-1)).toMatchObject({
          _tag: "ToolCallUpdated",
          toolCall: { toolCallId: "reused", status: "completed" },
        });
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { CODEWORK_ACP_PERMISSION_LIFECYCLE: "1" },
            },
            cwd: process.cwd(),
            authMethodId: "test",
            clientInfo: { name: "codework-test", version: "0.0.0" },
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      ),
    );
  }
  for (const failure of ["rpc", "malformed"]) {
    it.effect(`旧式模式 ${failure} 失败后同连接仍可成功切换模型`, () => {
      const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const modeFailure = yield* runtime.setMode("code").pipe(Effect.result);
        expect(modeFailure._tag).toBe("Failure");
        if (modeFailure._tag === "Failure" && failure === "rpc") {
          expect(modeFailure.failure).toMatchObject({ _tag: "AcpRequestError" });
        }
        expect((yield* runtime.getModeState)?.currentModeId).toBe("ask");
        yield* runtime.setModel("composer-2");
        expect((yield* runtime.getAvailableModels)?.find((model) => model.isDefault)?.slug).toBe(
          "composer-2",
        );
        expect(
          requests
            .filter(
              (event) => event.status === "started" && event.method.startsWith("session/set_"),
            )
            .map((event) => event.method),
        ).toEqual(["session/set_mode", "session/set_config_option"]);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { CODEWORK_ACP_MODE_FAILURE: failure },
            },
            cwd: process.cwd(),
            authMethodId: "test",
            clientInfo: { name: "codework-test", version: "0.0.0" },
            requestLogger: (event) =>
              Effect.sync(() => {
                requests.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });
  }
  for (const protocol of ["legacy", "config"]) {
    it.effect(`任意 URI 模式通过 ${protocol} 原生接口往返并拒绝未广告值`, () => {
      const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
      const modeId = "https://agentclientprotocol.com/protocol/session-modes#review";
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        yield* runtime.setMode(modeId);
        expect((yield* runtime.getModeState)?.currentModeId).toBe(modeId);
        yield* runtime.setMode(modeId);
        expect((yield* runtime.setMode("removed").pipe(Effect.result))._tag).toBe("Failure");
        const writes = requests.filter(
          (event) => event.status === "started" && event.method.startsWith("session/set_"),
        );
        expect(writes.map((event) => ({ method: event.method, payload: event.payload }))).toEqual([
          {
            method: protocol === "config" ? "session/set_config_option" : "session/set_mode",
            payload:
              protocol === "config"
                ? { sessionId: "mock-session-1", configId: "operation", value: modeId }
                : { sessionId: "mock-session-1", modeId },
          },
        ]);
        const updated = yield* runtime.getEvents().pipe(
          Stream.filter((event) => event._tag === "ModesUpdated"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(Array.from(updated)[0]?.mode?.currentValue).toBe(modeId);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: {
                CODEWORK_ACP_URI_MODES: "1",
                ...(protocol === "config" ? { CODEWORK_ACP_STARTUP_CONFIG: "missing" } : {}),
              },
            },
            cwd: process.cwd(),
            authMethodId: "test",
            clientInfo: { name: "codework-test", version: "0.0.0" },
            requestLogger: (event) =>
              Effect.sync(() => {
                requests.push(event);
              }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });
  }
  for (const resume of [false, true]) {
    for (const response of ["missing", "null", "empty", "explicit", "withdraw", "retry"]) {
      it.effect(`启动配置 ${resume ? "恢复" : "新建"}/${response} 保留正确快照`, () => {
        const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
        return Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          if (response === "retry")
            expect((yield* runtime.start().pipe(Effect.result))._tag).toBe("Failure");
          const started = yield* runtime.start();
          expect(yield* runtime.getAvailableCommands).toEqual(
            response === "retry" ? [] : [{ name: "startup" }],
          );
          const config = yield* runtime.getConfigOptions;
          expect(config).toEqual(started.sessionSetupResult.configOptions ?? []);
          if (response === "missing" || response === "null") {
            expect(config.map((option) => option.id)).toEqual(["engine", "operation", "fast"]);
            expect(started.modelConfigId).toBe("engine");
            expect((yield* runtime.getAvailableModels)?.map((model) => model.slug)).toEqual([
              "dynamic-default",
              "dynamic-next",
            ]);
            expect((yield* runtime.getModeState)?.currentModeId).toBe("plan");
            yield* runtime.setModel("dynamic-next");
            expect(
              requests
                .filter(
                  (request) =>
                    request.method === "session/set_config_option" && request.status === "started",
                )
                .map((request) => request.payload),
            ).toEqual([{ sessionId: "mock-session-1", configId: "engine", value: "dynamic-next" }]);
          } else if (response === "explicit") {
            expect(started.modelConfigId).toBe("model");
            expect(config.some((option) => option.id === "engine")).toBe(false);
          } else {
            expect(config).toEqual([]);
            expect(started.modelConfigId).toBeUndefined();
            expect(yield* runtime.getAvailableModels).toEqual(response === "retry" ? null : []);
            expect(yield* runtime.getModeState).toBeUndefined();
          }
        }).pipe(
          Effect.provide(
            AcpSessionRuntime.layer({
              spawn: {
                command: mockAgentCommand,
                args: mockAgentArgs,
                env: { CODEWORK_ACP_STARTUP_CONFIG: response },
              },
              cwd: process.cwd(),
              authMethodId: "test",
              clientInfo: { name: "codework-test", version: "0.0.0" },
              ...(resume ? { resumeSessionId: "mock-session-1" } : {}),
              requestLogger: (request) =>
                Effect.sync(() => {
                  requests.push(request);
                }),
            }),
          ),
          Effect.scoped,
          Effect.provide(NodeServices.layer),
        );
      });
    }
  }
  it.effect("恢复只有配置与命令通知且响应挂起时，空闲恢复保留最新元数据", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionSetupResult._meta).toMatchObject({
        codeworkSessionLoadReady: "replay_idle",
      });
      expect(started.modelConfigId).toBe("engine");
      expect((yield* runtime.getAvailableModels)?.map((model) => model.slug)).toEqual([
        "dynamic-default",
        "dynamic-next",
      ]);
      expect(yield* runtime.getAvailableCommands).toEqual([{ name: "startup" }]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { CODEWORK_ACP_STARTUP_CONFIG: "idle" },
          },
          cwd: process.cwd(),
          authMethodId: "test",
          clientInfo: { name: "codework-test", version: "0.0.0" },
          resumeSessionId: "mock-session-1",
          sessionLoadReplayIdleGap: "50 millis",
          sessionLoadTimeout: "1 second",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    ),
  );
  for (const action of ["cancel", "timeout"] as const) {
    it.effect(`Kiro 命令 ${action} 终止等待，不重新发送为模型消息`, () => {
      const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const pending = yield* runtime
          .prompt({ prompt: [{ type: "text", text: "/agent wait" }] })
          .pipe(Effect.result, Effect.forkChild);
        yield* runtime.getEvents().pipe(
          Stream.takeUntil((event) => event._tag === "ModeChanged"),
          Stream.runDrain,
        );
        if (action === "cancel") yield* runtime.cancel;
        else yield* TestClock.adjust("61 seconds");
        const result = yield* Fiber.join(pending);
        if (action === "cancel")
          expect(result).toMatchObject({ _tag: "Success", success: { stopReason: "cancelled" } });
        else
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { errorMessage: expect.stringContaining("60 秒") },
          });
        expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "/agent recover" }] })).toEqual({ stopReason: "end_turn" });
        expect(requests.filter((event) => event.method === "session/prompt")).toEqual([]);
        expect(requests.filter((event) => event.status === "started" && event.method === "_kiro.dev/commands/execute").map((event) => event.payload)).toEqual([
          { sessionId: "mock-session-1", command: { command: "agent", args: { value: "wait" } } },
          { sessionId: "mock-session-1", command: { command: "agent", args: { value: "recover" } } },
        ]);
      }).pipe(
        Effect.provide(
          AcpSessionRuntime.layer({
            spawn: {
              command: mockAgentCommand,
              args: mockAgentArgs,
              env: { CODEWORK_ACP_EMIT_KIRO_COMMANDS: "1" },
            },
            cwd: process.cwd(),
            clientInfo: { name: "codework-test", version: "0.0.0" },
            authMethodId: "test",
            requestLogger: (event) => Effect.sync(() => { requests.push(event); }),
          }),
        ),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
    });
  }

  it.effect("Kiro 内置命令走对象请求并展示结果，失败不转发模型", () => {
    const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      expect(
        yield* runtime.prompt({ prompt: [{ type: "text", text: "/agent swap my-agent" }] }),
      ).toEqual({ stopReason: "end_turn" });
      const events = Array.from(
        yield* runtime.getEvents().pipe(
          Stream.takeUntil((event) => event._tag === "AssistantItemCompleted"),
          Stream.runCollect,
        ),
      );
      const text = events
        .flatMap((event) => (event._tag === "ContentDelta" ? [event.text] : []))
        .join("");
      expect(text).toContain("命令执行完成");
      expect(text).toContain("swap my-agent");
      expect(
        requests
          .filter(
            (event) => event.status === "started" && event.method === "_kiro.dev/commands/execute",
          )
          .map((event) => event.payload),
      ).toEqual([
        {
          sessionId: "mock-session-1",
          command: { command: "agent", args: { value: "swap my-agent" } },
        },
      ]);
      yield* runtime.prompt({ prompt: [{ type: "text", text: "/agent" }] });
      expect(
        requests.findLast(
          (event) => event.status === "started" && event.method === "_kiro.dev/commands/execute",
        )?.payload,
      ).toEqual({ sessionId: "mock-session-1", command: { command: "agent", args: {} } });
      for (const argument of ["reject", "invalid", "rpc-error"]) {
        expect(
          (yield* runtime
            .prompt({ prompt: [{ type: "text", text: `/agent ${argument}` }] })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }
      expect(
        (yield* runtime
          .prompt({
            prompt: [
              { type: "text", text: "/agent swap ignored" },
              { type: "image", data: "AA==", mimeType: "image/png" },
            ],
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(requests.filter((event) => event.method === "session/prompt")).toEqual([]);
      for (const text of ["/review file.ts", "/help", "/compact", "普通消息"]) {
        yield* runtime.prompt({ prompt: [{ type: "text", text }] });
      }
      expect(
        requests
          .filter((event) => event.status === "started" && event.method === "session/prompt")
          .map((event) => event.payload),
      ).toEqual(
        ["/review file.ts", "/help", "/compact", "普通消息"].map((text) => ({
          sessionId: "mock-session-1",
          prompt: [{ type: "text", text }],
        })),
      );
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { CODEWORK_ACP_EMIT_KIRO_COMMANDS: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requests.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("Kiro 扩展命令复用启动缓存与异步快照，隔离无效通知和其它会话", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.getAvailableCommands).toEqual([
        { name: "agent", description: "选择代理", input: { hint: "swap <name>" } },
        { name: "review", description: "审查变更" },
      ]);
      const sendAndDrain = (params: unknown) =>
        Effect.gen(function* () {
          yield* runtime.request("_codework.test/kiro-commands", params);
          return Array.from(
            yield* runtime.getEvents().pipe(
              Stream.takeUntil((event) => event._tag === "ModeChanged"),
              Stream.runCollect,
            ),
          ).filter((event) => event._tag === "CommandsUpdated");
        });
      const commands = [{ name: "inspect", description: "检查文件", input: { hint: "文件路径" } }];
      const updates = yield* sendAndDrain({
        sessionId: "mock-session-1",
        commands: [
          { name: " /inspect ", description: " 检查文件 ", meta: { hint: " 文件路径 " } },
          { name: "///inspect", description: "重复项" },
          { name: "bad name" },
        ],
        prompts: [{ name: "inspect" }],
        tools: [{ name: "terminal" }],
      });
      expect(updates.map((event) => event.commands)).toEqual([commands]);
      expect(yield* runtime.getAvailableCommands).toEqual(commands);
      for (const params of [
        { sessionId: "child-session", commands: [] },
        { sessionId: "mock-session-1", _meta: { isReplay: true }, commands: [] },
        { commands: [] },
        { sessionId: "mock-session-1" },
        { sessionId: "mock-session-1", commands: "bad" },
        { sessionId: "mock-session-1", prompts: [{ name: 3 }] },
      ]) {
        expect(yield* sendAndDrain(params)).toEqual([]);
        expect(yield* runtime.getAvailableCommands).toEqual(commands);
      }
      expect(
        (yield* sendAndDrain({ sessionId: "mock-session-1", commands: [], prompts: [] })).map(
          (event) => event.commands,
        ),
      ).toEqual([[]]);
      expect(yield* runtime.getAvailableCommands).toEqual([]);
      expect(
        (yield* sendAndDrain({
          sessionId: "mock-session-1",
          prompts: [{ name: "skill-only" }],
        })).map((event) => event.commands),
      ).toEqual([[{ name: "skill-only" }]]);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { CODEWORK_ACP_EMIT_KIRO_COMMANDS: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("动态配置替换快照并驱动模型和模式写入，隔离重放及子会话", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      const promptAndDrain = Effect.gen(function* () {
        yield* runtime.prompt({ prompt: [{ type: "text", text: "更新配置" }] });
        yield* runtime.getEvents().pipe(
          Stream.takeUntil((event) => event._tag === "AssistantItemCompleted"),
          Stream.runDrain,
        );
      });
      yield* promptAndDrain;
      expect((yield* runtime.getConfigOptions).map((option) => option.id)).toEqual([
        "engine",
        "operation",
        "fast",
      ]);
      expect(yield* runtime.getModeState).toMatchObject({
        currentModeId: "plan",
        availableModes: [{ id: "plan" }, { id: "code" }],
      });
      yield* runtime.setModel("dynamic-default");
      yield* runtime.setMode("plan");
      expect(requestEvents.filter((event) => event.method === "session/set_config_option")).toEqual(
        [],
      );
      const invalidModel = yield* runtime.setModel("composer-2").pipe(Effect.result);
      expect(invalidModel._tag).toBe("Failure");
      const invalidMode = yield* runtime.setMode("ask").pipe(Effect.result);
      expect(invalidMode._tag).toBe("Failure");
      const invalidBoolean = yield* runtime.setConfigOption("fast", "true").pipe(Effect.result);
      expect(invalidBoolean._tag).toBe("Failure");
      expect(requestEvents.filter((event) => event.method === "session/set_config_option")).toEqual(
        [],
      );
      yield* runtime.setModel("dynamic-next");
      yield* runtime.setMode("code");
      yield* runtime.setConfigOption("fast", true);
      expect(
        requestEvents
          .filter(
            (event) => event.method === "session/set_config_option" && event.status === "started",
          )
          .map((event) => event.payload),
      ).toEqual([
        { sessionId: "mock-session-1", configId: "engine", value: "dynamic-next" },
        { sessionId: "mock-session-1", configId: "operation", value: "code" },
        { sessionId: "mock-session-1", configId: "fast", type: "boolean", value: true },
      ]);
      expect((yield* runtime.getConfigOptions).map((option) => option.currentValue)).toEqual([
        "dynamic-next",
        "code",
        true,
      ]);
      yield* runtime.request("session/mode/set", { sessionId: "mock-session-1", modeId: "plan" });
      yield* runtime.getEvents().pipe(
        Stream.takeUntil((event) => event._tag === "ModeChanged"),
        Stream.runDrain,
      );
      expect(
        (yield* runtime.getConfigOptions).find((option) => option.id === "operation")?.currentValue,
      ).toBe("plan");
      yield* runtime.setMode("code");
      expect(
        requestEvents.filter(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toHaveLength(4);
      yield* promptAndDrain;
      expect(yield* runtime.getConfigOptions).toEqual([]);
      expect(yield* runtime.getModeState).toBeUndefined();
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { CODEWORK_ACP_EMIT_CONFIG_UPDATES: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("merges custom initialize client capabilities into the ACP handshake", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const initializeStarted = requestEvents.find(
        (event) => event.method === "initialize" && event.status === "started",
      );
      expect(initializeStarted?.payload).toMatchObject({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientCapabilities: {
            _meta: {
              parameterizedModelPicker: true,
            },
          },
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();

      expect(started.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(started.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes).toHaveLength(4);
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }
      const assistantStart = notes[1];
      const assistantDelta = notes[2];
      if (
        assistantStart?._tag === "AssistantItemStarted" &&
        assistantDelta?._tag === "ContentDelta"
      ) {
        expect(assistantDelta.itemId).toBe(assistantStart.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("keeps assistant item IDs unique when a provider session restarts", () => {
    const collectFirstAssistantItemId = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      expect(started.sessionId).toBe("mock-session-1");

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      const events = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      const assistantStart = events.find((event) => event._tag === "AssistantItemStarted");
      expect(assistantStart?._tag).toBe("AssistantItemStarted");
      return assistantStart?._tag === "AssistantItemStarted" ? assistantStart.itemId : "";
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
    );

    return Effect.gen(function* () {
      const beforeRestart = yield* collectFirstAssistantItemId;
      const afterRestart = yield* collectFirstAssistantItemId;

      expect(afterRestart).not.toBe(beforeRestart);
    }).pipe(Effect.provide(NodeServices.layer));
  });

  it.effect("drops session updates emitted for a child ACP session", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(
        notes
          .filter((note) => note._tag === "ContentDelta")
          .map((note) => note.text)
          .join(""),
      ).toBe("root before child root after child");
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("supports successive standard ACP prompts", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const firstPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "first" }],
      });
      const secondPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      });

      expect(firstPromptResult).toMatchObject({ stopReason: "end_turn" });
      expect(secondPromptResult).toMatchObject({ stopReason: "end_turn" });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );


  it.effect("取消返回前通知必须入队，随后关闭不抢先", () =>
    Effect.gen(function* () {
      const notificationEntered = yield* Deferred.make<void>();
      const releaseNotification = yield* Deferred.make<void>();
      const cancelReturned = yield* Deferred.make<void>();
      const promptReturned = yield* Deferred.make<void>();
      const sawInProgress = yield* Deferred.make<void>();
      const methods: string[] = [];
      yield* Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            if (event._tag === "EventStreamBarrier")
              return Deferred.succeed(event.acknowledge, undefined);
            return event._tag === "ToolCallUpdated" && event.toolCall.status === "inProgress"
              ? Deferred.succeed(sawInProgress, undefined)
              : Effect.void;
          }), Effect.forkChild,
        );
        const prompt = yield* runtime.prompt({prompt:[{type:"text",text:"cancel enqueue"}]}).pipe(Effect.tap(() => Deferred.succeed(promptReturned, undefined)), Effect.forkChild);
        yield* Deferred.await(sawInProgress);
        const cancelling = yield* runtime.cancel.pipe(
          Effect.tap(() => Deferred.succeed(cancelReturned, undefined)), Effect.forkChild,
        );
        yield* Deferred.await(notificationEntered);
        expect(yield* Deferred.isDone(cancelReturned)).toBe(false);
        expect(yield* Deferred.isDone(promptReturned)).toBe(false);
        yield* Deferred.succeed(releaseNotification, undefined);
        yield* Fiber.join(cancelling);
        expect(yield* Fiber.join(prompt)).toMatchObject({stopReason:"cancelled"});
        yield* runtime.close;
        expect(methods).toEqual(["session/cancel", "session/close"]);
      }).pipe(
        Effect.provide(AcpSessionRuntime.layer({
          spawn:{command:mockAgentCommand,args:mockAgentArgs,env:{CODEWORK_ACP_EMIT_ACTIVE_TOOL_THEN_HANG:"1",CODEWORK_ACP_CLOSE_BEHAVIOR:"success"}},
          cwd:process.cwd(),clientInfo:{name:"codework-test",version:"0.0.0"},authMethodId:"test",
          protocolLogging:{logOutgoing:true,logger:(event)=>Effect.gen(function*(){
            if(event.stage!=="raw"||typeof event.payload!=="string")return;
            const raw = event.payload;
            const method=["session/cancel", "session/close"].find(method=>raw.includes('"method":"'+method+'"'));
            if(!method)return;
            methods.push(method);
            if(method==="session/cancel"){
              yield* Deferred.succeed(notificationEntered, undefined);
              yield* Deferred.await(releaseNotification);
            }
          })},
        })), Effect.ensuring(Deferred.succeed(releaseNotification, undefined)), Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  for (const codebuddy of [false, true]) {
    it.effect("取消后等待原 RPC 终结，重复/空闲取消不污染下一回合：" + codebuddy, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelReceived = yield* Deferred.make<void>();
        const wire: string[] = [];
        return yield* Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const first = yield* runtime.prompt({ prompt: [{ type: "text", text: "first" }] }).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Effect.all([runtime.cancel, runtime.cancel], { concurrency: "unbounded" });
        expect(yield* Fiber.join(first)).toMatchObject({ stopReason: "cancelled" });
        yield* Deferred.await(cancelReceived);
        const next = yield* runtime.prompt({ prompt: [{ type: "text", text: "second" }] }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
        expect(wire.filter((s) => s.includes('"method":"session/prompt"'))).toHaveLength(1);
        expect(wire.filter((s) => s.includes('"method":"session/cancel"'))).toHaveLength(1);
        yield* runtime.request("_codework/release_cancel", {});
        if (codebuddy) {
          expect(yield* Fiber.join(next)).toMatchObject({ _tag: "Failure", failure: {
            code: -32000, method: "session/prompt", errorMessage: expect.stringContaining("CodeBuddy 取消保护窗口"),
          }});
          expect(wire.filter((s) => s.includes('"method":"session/prompt"'))).toHaveLength(1);
          yield* TestClock.adjust("500 millis");
          expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "after window" }] })).toMatchObject({ stopReason: "end_turn" });
        } else expect(yield* Fiber.join(next)).toMatchObject({ _tag: "Success", success: { stopReason: "end_turn" } });
        yield* runtime.cancel;
        expect(wire.filter((s) => s.includes('"method":"session/cancel"'))).toHaveLength(1);
        expect(wire.some((s) => s.includes('"method":"@effect/rpc/Interrupt"'))).toBe(false);
      }).pipe(Effect.provide(AcpSessionRuntime.layer({
        spawn: { command: mockAgentCommand, args: mockAgentArgs, env: {
          CODEWORK_ACP_CANCEL_RESPONSE_BARRIER: "1", CODEWORK_ACP_CODEBUDDY_CANCEL_WINDOW: codebuddy ? "1" : "0",
        }}, cwd: process.cwd(), authMethodId: "test", clientInfo: { name: "codework-test", version: "0.0.0" },
        protocolLogging: { logIncoming: true, logOutgoing: true, logger: (event) => Effect.gen(function* () {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") wire.push(event.payload);
          else if (event.payload.includes('"title":"first-prompt-running"')) yield* Deferred.succeed(started, undefined);
          else if (event.payload.includes('"title":"cancel-awaiting-release"')) yield* Deferred.succeed(cancelReceived, undefined);
        })},
      })), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("取消结算正在等待的原生审批，远端回复后下一回合可继续", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const opened = yield* Deferred.make<void>();
      let waiting = true;
      yield* runtime.handleRequestPermission(() => waiting
        ? Deferred.succeed(opened, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "allow-once" } }));
      yield* runtime.start();
      const first = yield* runtime.prompt({ prompt: [{ type: "text", text: "waiting permission" }] }).pipe(Effect.forkChild);
      yield* Deferred.await(opened);
      yield* runtime.cancel;
      expect(yield* Fiber.join(first)).toMatchObject({ stopReason: "cancelled" });
      waiting = false;
      expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "continue" }] })).toMatchObject({ stopReason: "end_turn" });
    }).pipe(Effect.provide(AcpSessionRuntime.layer({
      spawn: { command: mockAgentCommand, args: mockAgentArgs, env: { CODEWORK_ACP_EMIT_TOOL_CALLS: "1" } },
      cwd: process.cwd(), authMethodId: "test", clientInfo: { name: "codework-test", version: "0.0.0" },
    })), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("静默回合可本地取消，未确认远端终结时不发送下一请求", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptFiber = yield* runtime
        .prompt({
          prompt: [{ type: "text", text: "hang forever" }],
        })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("500 millis");
      yield* runtime.cancel;

      const firstPromptResult = yield* Fiber.join(promptFiber);
      expect(firstPromptResult).toMatchObject({ stopReason: "cancelled" });

      const secondPrompt = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      }).pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("6 seconds");
      expect(yield* Fiber.join(secondPrompt)).toMatchObject({ _tag: "Failure", failure: {
        code: -32000, method: "session/prompt", errorMessage: expect.stringContaining("新请求未发送"),
      }});
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("cancels in-progress tools when the client interrupts a hung prompt", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const events: AcpSessionRuntime.AcpSessionRuntimeEvent[] = [];
      const sawInProgress = yield* Deferred.make<void>();
      yield* runtime.start();
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "EventStreamBarrier")
            return Deferred.succeed(event.acknowledge, undefined);
          events.push(event);
          if (
            event._tag === "ToolCallUpdated" &&
            event.toolCall.toolCallId === "tool-call-long-running-1" &&
            event.toolCall.status === "inProgress"
          ) {
            return Deferred.succeed(sawInProgress, undefined);
          }
          return Effect.void;
        }),
        Effect.forkChild,
      );

      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "long tool" }] })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(sawInProgress);
      yield* runtime.cancel;
      expect(yield* Fiber.join(promptFiber)).toMatchObject({ stopReason: "cancelled" });
      yield* runtime.drainEvents;

      const tools = events.flatMap((event) =>
        event._tag === "ToolCallUpdated" ? [event.toolCall] : [],
      );
      expect(tools.map((tool) => tool.status)).toEqual(["pending", "inProgress", "failed"]);
      expect(tools.at(-1)).toMatchObject({
        toolCallId: "tool-call-long-running-1",
        status: "failed",
      });
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: { CODEWORK_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("segments assistant text around ACP tool calls", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 7)));
      expect(notes.map((note) => note._tag)).toEqual([
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
        "ToolCallUpdated",
        "ToolCallUpdated",
        "AssistantItemStarted",
        "ContentDelta",
      ]);

      const firstStarted = notes[0];
      const firstDelta = notes[1];
      const firstCompleted = notes[2];
      const secondStarted = notes[5];
      const secondDelta = notes[6];
      expect(firstStarted?._tag).toBe("AssistantItemStarted");
      expect(firstCompleted?._tag).toBe("AssistantItemCompleted");
      expect(secondStarted?._tag).toBe("AssistantItemStarted");
      if (
        firstStarted?._tag === "AssistantItemStarted" &&
        firstDelta?._tag === "ContentDelta" &&
        firstCompleted?._tag === "AssistantItemCompleted" &&
        secondStarted?._tag === "AssistantItemStarted" &&
        secondDelta?._tag === "ContentDelta"
      ) {
        expect(firstDelta.itemId).toBe(firstStarted.itemId);
        expect(firstCompleted.itemId).toBe(firstStarted.itemId);
        expect(secondStarted.itemId).not.toBe(firstStarted.itemId);
        expect(secondDelta.itemId).toBe(secondStarted.itemId);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("emits status-only tool updates through completion", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 3)));
      expect(notes.map((note) => note._tag)).toEqual([
        "ToolCallUpdated",
        "ToolCallUpdated",
        "ToolCallUpdated",
      ]);
      const toolCalls = notes.flatMap((note) =>
        note._tag === "ToolCallUpdated" ? [note.toolCall] : [],
      );
      expect(toolCalls.map((toolCall) => toolCall.status)).toEqual([
        "pending",
        "inProgress",
        "completed",
      ]);
      for (const toolCall of toolCalls) {
        expect(toolCall.title).toBe("Read file");
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS: "1",
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          authMethodId: "test",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("logs ACP requests from the shared runtime", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setModel("composer-2");
      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "succeeded",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "started",
        ),
      ).toBe(true);
      expect(
        requestEvents.some(
          (event) => event.method === "session/prompt" && event.status === "succeeded",
        ),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("skips no-op session config writes when the requested value is already active", () => {
    const requestEvents: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.setConfigOption("model", "default");
      yield* runtime.setMode("ask");

      expect(
        requestEvents.some(
          (event) => event.method === "session/set_config_option" && event.status === "started",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          requestLogger: (event) =>
            Effect.sync(() => {
              requestEvents.push(event);
            }),
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("emits low-level ACP protocol logs for raw and decoded messages", () => {
    const protocolEvents: Array<EffectAcpProtocol.AcpProtocolLogEvent> = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "outgoing" && event.stage === "decoded"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "raw"),
      ).toBe(true);
      expect(
        protocolEvents.some((event) => event.direction === "incoming" && event.stage === "decoded"),
      ).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                protocolEvents.push(event);
              }),
          },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("fails session startup when session/load returns an error", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const error = yield* runtime.start().pipe(Effect.flip);

      expect(error._tag).toBe("AcpRequestError");
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_FAIL_LOAD_SESSION: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "stale-session-id",
          clientInfo: { name: "codework-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("ignores session/update replay notifications during session/load", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.getEvents(), 4)));
      expect(notes.map((note) => note._tag)).toEqual([
        "PlanUpdated",
        "AssistantItemStarted",
        "ContentDelta",
        "AssistantItemCompleted",
      ]);
      expect(notes.some((note) => note._tag === "ToolCallUpdated")).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_EMIT_LOAD_REPLAY: "1",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          clientInfo: { name: "codework-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("completes session/load after replay becomes idle while its RPC stays pending", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start().pipe(Effect.timeout("2 seconds"));

      expect(started.sessionId).toBe("mock-session-1");
      expect(started.sessionSetupResult._meta).toMatchObject({
        codeworkSessionLoadReady: "replay_idle",
      });

      const unexpectedReplayEvent = yield* Stream.runHead(runtime.getEvents()).pipe(
        Effect.timeoutOption("100 millis"),
      );
      expect(Option.isNone(unexpectedReplayEvent)).toBe(true);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_HANG_LOAD_SESSION_AFTER_REPLAY: "1",
              CODEWORK_ACP_LOAD_SESSION_DELAY_MS: "10000",
            },
          },
          cwd: process.cwd(),
          resumeSessionId: "mock-session-1",
          sessionLoadReplayIdleGap: "50 millis",
          sessionLoadTimeout: "1 second",
          clientInfo: { name: "codework-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      TestClock.withLive,
    ),
  );

  it.effect("rejects invalid config option values before sending session/set_config_option", () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "acp-runtime-"));
    const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();

      const error = yield* runtime.setModel("composer-2[fast=false]").pipe(Effect.flip);
      expect(error._tag).toBe("AcpRequestError");
      if (error._tag === "AcpRequestError") {
        expect(error.code).toBe(-32602);
        expect(error.message).toContain(
          'Invalid value "composer-2[fast=false]" for session config option "model"',
        );
        expect(error.message).toContain("composer-2[fast=true]");
      }

      const recordedRequests = NodeFS.readFileSync(requestLogPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: { value?: unknown } });
      expect(
        recordedRequests.some(
          (message) =>
            message.method === "session/set_config_option" &&
            message.params?.value === "composer-2[fast=false]",
        ),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          authMethodId: "test",
          spawn: {
            command: mockAgentCommand,
            args: mockAgentArgs,
            env: {
              CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" },
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  
  for (const [name, clientCapabilities, override] of [
    ["缺省能力", undefined, false],
    ["显式能力", { fs: { readTextFile: true, writeTextFile: false }, terminal: true }, false],
    ["调用方覆盖", undefined, true],
  ] as const) {
    it.effect("host/capabilities 复用初始化能力：" + name, () => {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codework-acp-host-caps-"));
      const resultLogPath = NodePath.join(tempDir, "host-capabilities.jsonl");
      const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        if (override) yield* runtime.handleExtRequest("host/capabilities", Schema.Unknown, () => Effect.succeed({ custom: true }));
        yield* runtime.start();
        const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "hello" }] });
        expect(response.stopReason).toBe("end_turn");
        const logged = yield* Effect.forEach(
          NodeFS.readFileSync(resultLogPath, "utf8").trim().split("\n"),
          (line) => decodeHostCapabilities(line),
        );
        expect(logged).toEqual([override ? { custom: true } : {
          fs: { readTextFile: clientCapabilities?.fs.readTextFile ?? false, writeTextFile: false },
          terminal: { create: clientCapabilities?.terminal ?? false },
        }]);
        expect(requests.find((e) => e.method === "initialize" && e.status === "started")?.payload)
          .toMatchObject({ clientCapabilities: clientCapabilities ?? { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
      }).pipe(Effect.provide(AcpSessionRuntime.layer({
        authMethodId: "test", spawn: { command: mockAgentCommand, args: mockAgentArgs, env: {
          CODEWORK_ACP_REQUEST_HOST_CAPABILITIES: "1",
          CODEWORK_ACP_HOST_CAPABILITIES_RESULT_LOG_PATH: resultLogPath,
          CODEWORK_ACP_PROMPT_RESPONSE_TEXT: "ok",
        }}, cwd: process.cwd(), clientInfo: { name: "codework-test", version: "0.0.0" },
        clientCapabilities, requestLogger: (event) => Effect.sync(() => { requests.push(event); }),
      })), Effect.scoped, Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))));
    });
  }

  for (const [name, agentName, environmentPolicy, expectedPolicy, resumeSessionId] of [
    ["Harn 缺省", "harn", undefined, { kind: "inherited" }, undefined],
    ["显式 isolated", "harn", { kind: "isolated" }, { kind: "isolated" }, undefined],
    ["显式 granted", "harn", { kind: "granted" }, { kind: "granted" }, undefined],
    ["其它 agent 缺省", "mock", undefined, undefined, undefined],
    ["其它 agent 显式", "mock", { kind: "isolated" }, { kind: "isolated" }, undefined],
    ["恢复已有 Harn 会话", "harn", undefined, undefined, "mock-session-1"],
  ] as const) {
    it.effect("建会话环境策略：" + name, () => {
      const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
      return Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
        yield* runtime.start();
        const created = requests.find((e) => e.method === "session/new" && e.status === "started");
        if (resumeSessionId) {
          expect(created).toBeUndefined();
          expect(requests.some((e) => e.method === "session/load" && e.status === "succeeded")).toBe(true);
        } else {
          expect(created?.payload).toEqual({ cwd: process.cwd(), mcpServers: [], ...(expectedPolicy ? { environmentPolicy: expectedPolicy } : {}) });
        }
      }).pipe(Effect.provide(AcpSessionRuntime.layer({
        spawn: { command: mockAgentCommand, args: mockAgentArgs, env: { CODEWORK_ACP_AGENT_NAME: agentName } },
        cwd: process.cwd(), authMethodId: "test", clientInfo: { name: "codework-test", version: "0.0.0" },
        environmentPolicy, ...(resumeSessionId ? { resumeSessionId } : {}),
        requestLogger: (event) => Effect.sync(() => { requests.push(event); }),
      })), Effect.scoped, Effect.provide(NodeServices.layer));
    });
  }

  it.effect("环境策略只接收 struct.kind 的已知枚举", () => Effect.sync(() => {
    const isRequest = Schema.is(AcpSchema.NewSessionRequest);
    const base = { cwd: process.cwd(), mcpServers: [] };
    expect(isRequest(base)).toBe(true);
    for (const kind of ["inherited", "isolated", "granted"]) expect(isRequest({ ...base, environmentPolicy: { kind } })).toBe(true);
    for (const policy of ["inherited", { kind: "unknown" }, {}, null]) expect(isRequest({ ...base, environmentPolicy: policy })).toBe(false);
  }));


  it.effect("Gajae 空闲只接受当前根会话阶段，下一回合等待同一串行入口", () => {
    const replied = Deferred.makeUnsafe<void>();
    const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
    return Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      const first = yield* runtime.prompt({ prompt: [{ type: "text", text: "late" }] }).pipe(Effect.forkChild);
      yield* Deferred.await(replied);
          // 请求日志回调仍在 RPC 完成栈上；冻结时钟先排空可运行 fiber，再取消空闲等待。
          yield* TestClock.adjust("0 millis");
      // RPC 回应与空闲阶段是两件事，原始回应日志是开始注入通知的屏障。
      yield* runtime.request("_codework.test/gajae-update", { sessionId: "child", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } } });
      yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runDrain);
      const second = yield* runtime.prompt({ prompt: [{ type: "text", text: "early" }] }).pipe(Effect.forkChild);
      for (const notification of [
        { sessionId: "child", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } } },
        { sessionId: "mock-session-1", _meta: { isReplay: true }, update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } } },
        { sessionId: "mock-session-1", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "working" } } },
        { sessionId: "mock-session-1", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: 3 } } },
        { sessionId: "mock-session-1", update: { sessionUpdate: "current_mode_update", currentModeId: "default", _meta: { gjcPhase: "idle" } } },
      ]) {
        yield* runtime.request("_codework.test/gajae-update", notification);
        yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runDrain);
      }
      yield* TestClock.adjust("59 seconds");
      expect(requests.filter((event) => event.method === "session/prompt" && event.status === "started")).toHaveLength(1);
      yield* runtime.request("_codework.test/gajae-update", { sessionId: "mock-session-1", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } } });
      expect(yield* Fiber.join(first)).toEqual({ stopReason: "end_turn" });
      expect(yield* Fiber.join(second)).toEqual({ stopReason: "end_turn" });
      expect(requests.filter((event) => event.method === "session/prompt" && event.status === "started")).toHaveLength(2);
    }).pipe(Effect.provide(AcpSessionRuntime.layer({ spawn: { command: mockAgentCommand, args: mockAgentArgs,
      env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1", CODEWORK_ACP_AGENT_NAME: "gajae-code" } }, cwd: process.cwd(),
      clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test",
      requestLogger: (event) => Effect.gen(function* () {
        requests.push(event);
        if (event.method === "session/prompt" && event.status === "succeeded") yield* Deferred.succeed(replied, undefined);
      }),
    })), Effect.scoped, Effect.provide(NodeServices.layer));
  });

  for (const action of ["cancel", "timeout"] as const) {
    it.effect("Gajae 等待空闲期间 " + action + " 可结束当前回合，随后恢复且不重试", () =>
      Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const requests: AcpSessionRuntime.AcpSessionRequestLogEvent[] = [];
        yield* Effect.gen(function* () {
          const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
          yield* runtime.start();
          const pending = yield* runtime.prompt({ prompt: [{ type: "text", text: "late" }] }).pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(replied);
          // 请求日志回调仍在 RPC 完成栈上；冻结时钟先排空可运行 fiber，再取消空闲等待。
          yield* TestClock.adjust("0 millis");
          if (action === "cancel") yield* runtime.cancel;
          yield* TestClock.adjust("61 seconds");
          const result = yield* Fiber.join(pending);
          if (action === "cancel") expect(result).toMatchObject({ _tag: "Success", success: { stopReason: "cancelled" } });
          else expect(result).toMatchObject({ _tag: "Failure", failure: { code: -32000, method: "session/prompt", errorMessage: expect.stringContaining("状态未知") } });
          expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "early" }] })).toEqual({ stopReason: "end_turn" });
          expect(requests.filter((event) => event.method === "session/prompt" && event.status === "started")).toHaveLength(2);
        }).pipe(Effect.provide(AcpSessionRuntime.layer({ spawn: { command: mockAgentCommand, args: mockAgentArgs,
          env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1", CODEWORK_ACP_AGENT_NAME: "gajae-code" } }, cwd: process.cwd(),
          clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test",
          requestLogger: (event) => Effect.gen(function* () {
            requests.push(event);
            if (event.method === "session/prompt" && event.status === "succeeded") yield* Deferred.succeed(replied, undefined);
          }),
        })), Effect.scoped);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("Gajae RPC 失败不等待空闲，下一回合接受提前到达的空闲", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "failure" }] }).pipe(Effect.result)).toMatchObject({ _tag: "Failure", failure: { code: -32603 } });
      expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "early" }] })).toEqual({ stopReason: "end_turn" });
    }).pipe(Effect.provide(AcpSessionRuntime.layer({ spawn: { command: mockAgentCommand, args: mockAgentArgs,
      env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1", CODEWORK_ACP_AGENT_NAME: "gajae-code" } }, cwd: process.cwd(),
      clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test",
    })), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("其它 ACP Agent 不增加 Gajae 空闲等待", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "late" }] })).toEqual({ stopReason: "end_turn" });
    }).pipe(Effect.provide(AcpSessionRuntime.layer({ spawn: { command: mockAgentCommand, args: mockAgentArgs,
      env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1", CODEWORK_ACP_AGENT_NAME: "other-agent" } }, cwd: process.cwd(),
      clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test",
    })), Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("协议子进程工具结果在元数据和 null 增量后保留到失败终态", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      yield* runtime.start();
      const seen: Array<AcpSessionRuntime.AcpSessionRuntimeEvent> = [];
      for (const update of [
        { sessionUpdate: "tool_call", toolCallId: "partial", title: "原命令", kind: "execute", status: "in_progress", rawInput: { command: "old" }, rawOutput: { content: [{ type: "text", text: "真实结果\n真实结果" }] } },
        { sessionUpdate: "tool_call_update", toolCallId: "partial", title: "更新命令", kind: "execute", rawInput: { command: "new" } },
        { sessionUpdate: "tool_call_update", toolCallId: "partial", kind: "execute", rawInput: null, rawOutput: null },
        { sessionUpdate: "tool_call_update", toolCallId: "partial", kind: "execute", status: "failed" },
      ]) {
        yield* runtime.request("_codework.test/gajae-update", { sessionId: "mock-session-1", update });
        yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runForEach((event) => Effect.sync(() => { seen.push(event); })));
      }
      const tools = seen.filter((event) => event._tag === "ToolCallUpdated");
      expect(tools).toHaveLength(2);
      expect(tools.at(-1)).toMatchObject({ toolCall: { toolCallId: "partial", kind: "execute", status: "failed", detail: "真实结果\n真实结果", command: "new", data: { rawInput: { command: "new" }, rawOutput: { content: [{ type: "text", text: "真实结果\n真实结果" }] } } } });
    }).pipe(Effect.provide(AcpSessionRuntime.layer({ spawn: { command: mockAgentCommand, args: mockAgentArgs, env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1" } }, cwd: process.cwd(), clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test" })), Effect.scoped, Effect.provide(NodeServices.layer)),
  );


  for (const status of ["completed", "failed"] as const) {
    it.effect(
      status + " 工具在本回合补充通知中保留结果，下一 prompt 同 ID 不继承终态",
      () => Effect.gen(function* () {
        const replied = yield* Deferred.make<void>();
        const runtime = yield* AcpSessionRuntime.make({
          spawn: { command: mockAgentCommand, args: mockAgentArgs, env: { CODEWORK_ACP_EMIT_GAJAE_IDLE: "1", CODEWORK_ACP_AGENT_NAME: "gajae-code" } },
          cwd: process.cwd(), clientInfo: { name: "codework-test", version: "0.0.0" }, authMethodId: "test",
          requestLogger: (event) => event.method === "session/prompt" && event.status === "succeeded" ? Deferred.succeed(replied, undefined).pipe(Effect.asVoid) : Effect.void,
        });
        yield* runtime.start();
        const firstPrompt = yield* runtime.prompt({ prompt: [{ type: "text", text: "late" }] }).pipe(Effect.forkChild);
        yield* Deferred.await(replied);
        yield* TestClock.adjust("0 millis");
        const seen: Array<AcpSessionRuntime.AcpSessionRuntimeEvent> = [];
        for (const update of [
          { sessionUpdate: "tool_call", toolCallId: "terminal-partial", title: "命令", kind: "execute", status, rawInput: { command: "check" }, rawOutput: { content: [{ type: "text", text: "FIRST_RESULT" }] } },
          { sessionUpdate: "tool_call_update", toolCallId: "terminal-partial", title: "补充标题", kind: "execute", rawInput: null, rawOutput: null },
          { sessionUpdate: "tool_call_update", toolCallId: "terminal-partial", rawOutput: { content: [{ type: "text", text: "SECOND_RESULT" }] } },
        ]) {
          yield* runtime.request("_codework.test/gajae-update", { sessionId: "mock-session-1", update });
          yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runForEach((event) => Effect.sync(() => { seen.push(event); })));
        }
        const tools = seen.filter((event) => event._tag === "ToolCallUpdated");
        expect(tools[1]).toMatchObject({ toolCall: { status, command: "check", detail: "FIRST_RESULT" } });
        expect(tools[2]).toMatchObject({ toolCall: { status, command: "check", detail: "SECOND_RESULT" } });
        expect(tools).toHaveLength(3);
        yield* runtime.request("_codework.test/gajae-update", { sessionId: "mock-session-1", update: { sessionUpdate: "session_info_update", _meta: { gjcPhase: "idle" } } });
        yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runDrain);
        expect(yield* Fiber.join(firstPrompt)).toEqual({ stopReason: "end_turn" });
        expect(yield* runtime.prompt({ prompt: [{ type: "text", text: "early" }] })).toEqual({ stopReason: "end_turn" });
        yield* runtime.request("_codework.test/gajae-update", { sessionId: "mock-session-1", update: { sessionUpdate: "tool_call", toolCallId: "terminal-partial", title: "新读取", kind: "read", status: "pending", rawInput: { path: "new.txt" } } });
        const nextEvents = yield* runtime.getEvents().pipe(Stream.takeUntil((event) => event._tag === "ModeChanged"), Stream.runCollect);
        const nextTool = nextEvents.find((event) => event._tag === "ToolCallUpdated");
        expect(nextTool).toMatchObject({ toolCall: { status: "pending", kind: "read" } });
        if (nextTool?._tag !== "ToolCallUpdated") throw new Error("缺少新工具事件");
        expect(nextTool.toolCall.command).toBeUndefined();
        expect(nextTool.toolCall.data.rawOutput).toBeUndefined();
        expect(nextTool.toolCall.detail).toBe("new.txt");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

});
