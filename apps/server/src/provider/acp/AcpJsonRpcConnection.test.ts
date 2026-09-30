// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

describe("AcpSessionRuntime", () => {
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

  it.effect("releases a fully silent prompt when session/cancel is requested", () =>
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

      const secondPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      });
      expect(secondPromptResult).toMatchObject({ stopReason: "end_turn" });
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
});
