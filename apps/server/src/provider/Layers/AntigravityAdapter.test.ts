import * as NodeServices from "@effect/platform-node/NodeServices";
import { AntigravitySettings, ThreadId } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import { makeAntigravityAdapter, parseAntigravityStreamJson } from "./AntigravityAdapter.ts";
import { resolveConfiguredAntigravityModel } from "./AntigravityProvider.ts";

const decodeSettings = Schema.decodeUnknownEffect(AntigravitySettings);

describe("Antigravity stream-json", () => {
  it.effect("Windows cmd和exe超限在启动进程前返回统一可操作错误", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawner = ChildProcessSpawner.make(() => Effect.die("守卫前调用了spawner"));
        for (const [binaryPath, prompt] of [
          ["agy.cmd", "x".repeat(9_000)],
          ["agy.exe", '"'.repeat(16_400)],
        ] as const) {
          const settings = yield* decodeSettings({
            enabled: true,
            binaryPath,
          });
          const adapter = yield* makeAntigravityAdapter(settings, { environment: {} }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provide(
              ServerConfig.layerTest("/tmp/antigravity-prompt-guard", {
                prefix: "codework-argv-guard-",
              }).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          );
          const threadId = ThreadId.make("antigravity-prompt-guard");
          yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
          const result = yield* Effect.result(adapter.sendTurn({ threadId, input: prompt })).pipe(
            Effect.provideService(HostProcessPlatform, "win32"),
            Effect.provideService(SpawnExecutableResolution, (command) => command),
          );
          if (Result.isSuccess(result)) throw Error("超限应失败");
          expect(result.failure).toMatchObject({
            _tag: "ProviderAdapterValidationError",
            code: "AGENT_PROMPT_TOO_LARGE",
          });
          expect(result.failure.message).toContain("请缩短输入");
        }
      }),
    ),
  );
  it("extracts text deltas and ignores non-JSON diagnostics", () => {
    const events = parseAntigravityStreamJson(
      'diagnostic\n{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello "}}\n{"event":"result","result":{"response":"hello world"}}',
    );
    expect(events.map((event) => event.text).filter(Boolean)).toEqual(["hello "]);
  });

  it("only forwards configured models to avoid unknown-model failures", () => {
    const settings = { customModels: ["agy-fast"] };
    expect(resolveConfiguredAntigravityModel(settings, "agy-fast")).toBe("agy-fast");
    expect(resolveConfiguredAntigravityModel(settings, "gpt-5.6-sol")).toBeUndefined();
    expect(resolveConfiguredAntigravityModel(settings, undefined)).toBeUndefined();
  });

  it.effect("进程未退出时就向共用事件流发送正文，并保留最终会话标识", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const chunks = yield* Queue.unbounded<string>();
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Deferred.await(processExit),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.fromQueue(chunks).pipe(Stream.takeWhile((chunk) => chunk !== "__END__")),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        );
        const settings = yield* decodeSettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings, { environment: {} }).pipe(
          Effect.provide(ServerConfig.layerTest("/tmp/antigravity-test", "/tmp")),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const threadId = ThreadId.make("antigravity-stream-test");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const liveEvents = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.forkChild);

        yield* Queue.offer(
          chunks,
          '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"first","conversation_id":"conv-1"}}\n',
        );
        const eventsBeforeExit = yield* Fiber.join(liveEvents);
        expect(eventsBeforeExit.map((event) => event.type)).toEqual([
          "session.started",
          "thread.started",
          "turn.started",
          "content.delta",
        ]);
        expect(eventsBeforeExit[3]?.payload).toMatchObject({ delta: "first" });

        yield* Queue.offer(
          chunks,
          '{"event":"step_update","step_update":{"step_index":4,"step_type":"tool","state":"ACTIVE","tool_name":"run_command"}}\n',
        );
        yield* Queue.offer(
          chunks,
          '{"event":"step_update","step_update":{"step_index":4,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"name":"run_command","output":"hello"}}}\n',
        );
        const toolEvents = yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);
        expect(toolEvents.map((event) => event.type)).toEqual(["item.updated", "item.completed"]);
        expect(toolEvents[0]?.itemId).toBe(toolEvents[1]?.itemId);
        expect(toolEvents[0]?.payload).toMatchObject({ status: "inProgress" });
        expect(toolEvents[1]?.payload).toMatchObject({ status: "completed", detail: "hello" });
        expect(toolEvents.flatMap((event) => runtimeEventToActivities(event))).toMatchObject([
          { kind: "tool.updated", payload: { status: "inProgress" } },
          { kind: "tool.completed", payload: { status: "completed", detail: "hello" } },
        ]);

        yield* Queue.offer(
          chunks,
          '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"first"}}\n',
        );
        yield* Queue.offer(chunks, "__END__");
        yield* Deferred.succeed(processExit, ChildProcessSpawner.ExitCode(0));
        const result = yield* Fiber.join(turn);
        expect(result.resumeCursor).toMatchObject({ conversationId: "conv-1" });
        const completedEvents = yield* Stream.take(adapter.streamEvents, 2).pipe(Stream.runCollect);
        expect(completedEvents.map((event) => event.type)).toEqual([
          "item.completed",
          "turn.completed",
        ]);
        expect(completedEvents[0]?.payload).toMatchObject({ data: "first" });

        const failedTurn = yield* adapter
          .sendTurn({ threadId, input: "fail" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Queue.offer(
          chunks,
          '{"event":"step_update","step_update":{"step_index":1,"step_type":"tool","state":"DONE","tool_name":"run_command","tool_info":{"error":{"type":"exec","message":"permission denied"}}}}\n',
        );
        yield* Queue.offer(
          chunks,
          '{"event":"result","result":{"status":"ERROR","response":"","error":"model failed"}}\n',
        );
        yield* Queue.offer(chunks, "__END__");
        const failed = yield* Fiber.join(failedTurn);
        expect(Result.isFailure(failed)).toBe(true);
        const failedEvents = yield* Stream.take(adapter.streamEvents, 4).pipe(Stream.runCollect);
        expect(failedEvents.map((event) => event.type)).toEqual([
          "turn.started",
          "item.completed",
          "item.completed",
          "turn.completed",
        ]);
        expect(failedEvents[1]?.payload).toMatchObject({
          status: "failed",
          detail: "permission denied",
        });
        expect(runtimeEventToActivities(failedEvents[1]!)).toMatchObject([
          { kind: "tool.completed", payload: { status: "failed", detail: "permission denied" } },
        ]);
        expect(failedEvents[3]?.payload).toMatchObject({
          state: "failed",
          errorMessage: "model failed",
        });

        const terminalOnly = yield* adapter
          .sendTurn({ threadId, input: "final" })
          .pipe(Effect.forkChild);
        yield* Queue.offer(
          chunks,
          '{"event":"result","result":{"status":"SUCCESS","response":"terminal-only"}}\n',
        );
        yield* Queue.offer(chunks, "__END__");
        yield* Fiber.join(terminalOnly);
        const terminalOnlyEvents = yield* Stream.take(adapter.streamEvents, 4).pipe(
          Stream.runCollect,
        );
        expect(terminalOnlyEvents.map((event) => event.type)).toEqual([
          "turn.started",
          "content.delta",
          "item.completed",
          "turn.completed",
        ]);
        expect(terminalOnlyEvents[1]?.payload).toMatchObject({ delta: "terminal-only" });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("startSession 通过 resumeCursor 恢复 conversationId 并续接 provider 会话", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const spawnedArgs: Array<ReadonlyArray<string>> = [];
        const chunks = yield* Queue.unbounded<string>();
        const processExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const spawner = ChildProcessSpawner.make((command) => {
          // `Command` hides its fields; tests access them structurally.
          spawnedArgs.push(
            (command as unknown as { readonly args: ReadonlyArray<string> }).args.map(String),
          );
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(2),
              exitCode: Deferred.await(processExit),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(
                Stream.fromQueue(chunks).pipe(Stream.takeWhile((chunk) => chunk !== "__END__")),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const settings = yield* decodeSettings({ enabled: true });
        const adapter = yield* makeAntigravityAdapter(settings, { environment: {} }).pipe(
          Effect.provide(ServerConfig.layerTest("/tmp/antigravity-resume", "/tmp")),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        expect(adapter.capabilities.sessionModelSwitch).toBe("restart-continue");

        const threadId = ThreadId.make("antigravity-resume-test");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, conversationId: "conv-restored" },
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.forkChild);
        yield* Queue.offer(
          chunks,
          '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}\n',
        );
        yield* Queue.offer(chunks, "__END__");
        yield* Deferred.succeed(processExit, ChildProcessSpawner.ExitCode(0));
        yield* Fiber.join(turn);
        const argv = spawnedArgs.at(-1) ?? [];
        const flagIndex = argv.indexOf("--conversation");
        expect(flagIndex).toBeGreaterThanOrEqual(0);
        expect(argv[flagIndex + 1]).toBe("conv-restored");
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
