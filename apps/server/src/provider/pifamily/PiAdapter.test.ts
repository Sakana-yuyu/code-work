// @effect-diagnostics nodeBuiltinImport:off - 测试夹具直接用 node:fs/os/path。
/**
 * PiAdapter e2e 测试（真实子进程 + scripts/pi-mock-agent.mjs）。
 *
 * 覆盖：happy path（含工具事件与事件顺序）、中断、进程退出兜底、BYOK
 * 模型 fail-closed、stall 后的干净关闭、extension_ui 问答回路。所有等待
 * 都走事件（Deferred + Stream.tap），不睡眠不轮询。
 *
 * 看门狗（forkPifamilyWatchdog，默认 5 分钟不活跃超时）不做 e2e 验证：
 * 适配器不暴露超时参数，缩短超时需要注入时钟，收益不成比例；stall 路径
 * 由 "stall 后 stopSession 干净收尾" 用例覆盖同一终态收敛逻辑。
 *
 * @module provider/pifamily/PiAdapter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  PiAgentSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  ApprovalRequestId,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { PifamilyModelRoute } from "./byokProviderConfig.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);
const isProviderRuntimeEvent = Schema.is(ProviderRuntimeEvent);
const instanceId = ProviderInstanceId.make("pi-adapter-test");

const mockRoutes: ReadonlyArray<PifamilyModelRoute> = [
  {
    adapterId: "mock-byok-adapter",
    protocol: "openai",
    displayName: "Mock",
    modelId: "gpt-mock",
    contextWindowTokens: 128_000,
  },
];

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.mjs");

/**
 * 适配器把 `--mode rpc --model …` 追加在 binaryPath 之后，node 无法直接
 * 以这些 flags 启动脚本，所以按 CursorAdapterToolBroker.e2e 的惯例生成
 * 一个 shell wrapper（仅转发参数；MOCK_* 变量经 options.environment 注入）。
 */
async function makeMockAgentWrapper(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-pi-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "pi-mock.cmd" : "pi-mock.sh");
  const script = isWindows
    ? `@echo off
"${process.execPath}" "${mockAgentPath}" %*
exit /b %ERRORLEVEL%
`
    : `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

/**
 * 事件记录器：单一消费 streamEvents，按谓词挂起等待（Deferred 唤醒），
 * 保证测试永不轮询。
 */
interface PifamilyEventRecorder {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly waitFor: (
    predicate: (event: ProviderRuntimeEvent) => boolean,
  ) => Effect.Effect<ProviderRuntimeEvent>;
}

const makeEventRecorder = (): Effect.Effect<PifamilyEventRecorder> =>
  Effect.sync(() => {
    const events: ProviderRuntimeEvent[] = [];
    const waiters: Array<{
      readonly predicate: (event: ProviderRuntimeEvent) => boolean;
      readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];
    return {
      events,
      record: (event) =>
        Effect.gen(function* () {
          events.push(event);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index]!;
            if (!waiter.predicate(event)) continue;
            waiters.splice(index, 1);
            yield* Deferred.succeed(waiter.deferred, event);
          }
        }),
      waitFor: (predicate) =>
        Effect.gen(function* () {
          const seen = events.find(predicate);
          if (seen !== undefined) return seen;
          const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
          waiters.push({ predicate, deferred });
          return yield* Deferred.await(deferred);
        }),
    };
  });

const assertAllEventsDecode = (events: ReadonlyArray<ProviderRuntimeEvent>): void => {
  for (const event of events) {
    if (!isProviderRuntimeEvent(event)) {
      throw new Error(
        `Event does not decode against ProviderRuntimeEvent: ${JSON.stringify(event)}`,
      );
    }
  }
};

const runWithPiAdapter = (
  environment: Record<string, string>,
  body: (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly recorder: PifamilyEventRecorder;
  }) => Effect.Effect<void, ProviderAdapterError>,
  routes: ReadonlyArray<PifamilyModelRoute> = mockRoutes,
) =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
    const agentHome = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-pi-agent-home-")),
    );
    const adapter = yield* makePiAdapter(
      decodePiSettings({ enabled: true, binaryPath: wrapperPath, launchArgs: "" }),
      {
        instanceId,
        environment: { ...environment, PI_CODING_AGENT_DIR: agentHome },
        resolveRoutes: Effect.succeed(routes),
      },
    );
    const recorder = yield* makeEventRecorder();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => recorder.record(event)),
      Effect.forkScoped,
    );
    yield* body({ adapter, recorder });
  }).pipe(
    Effect.scoped,
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codework-pi-adapter-test-" })),
    Effect.provide(NodeServices.layer),
  );

describe("makePiAdapter", () => {
  it.effect("happy path: tools, deltas, ordered lifecycle, contract-valid events", () =>
    runWithPiAdapter(
      { MOCK_PI_TOOLS: "1", MOCK_SESSION_FILE: "/tmp/mock-pi-session.jsonl" },
      ({ adapter, recorder }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("pi-happy-path");
          const session = yield* adapter.startSession({
            threadId,
            runtimeMode: "full-access",
          });
          expect(session.model).toBe("mock-byok-adapter");
          expect(session.resumeCursor).toEqual({ piSessionFile: "/tmp/mock-pi-session.jsonl" });
          yield* recorder.waitFor((event) => event.type === "thread.started");

          yield* adapter.sendTurn({ threadId, input: "hello" });
          const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
          // agent_end(willRetry!==true) 先完成 turn；随后的 agent_settled 被
          // settled 检查安全丢弃。
          expect(completed.payload).toMatchObject({ state: "completed", stopReason: "agent_end" });

          // 事件顺序：turn.started → content.delta* → item.* → turn.completed。
          const types = recorder.events.map((event) => event.type);
          const turnStartedAt = types.indexOf("turn.started");
          const firstDeltaAt = types.indexOf("content.delta");
          const completedAt = types.indexOf("turn.completed");
          expect(turnStartedAt).toBeGreaterThanOrEqual(0);
          expect(firstDeltaAt).toBeGreaterThan(turnStartedAt);
          expect(completedAt).toBeGreaterThan(firstDeltaAt);
          expect(types).toContain("session.started");
          expect(types).toContain("thread.started");

          const text = recorder.events
            .filter(
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "assistant_text",
            )
            .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
            .join("");
          expect(text).toBe("Mock pi response.");

          // bash 工具 → command_execution item 生命周期。
          const toolStarted = recorder.events.find(
            (event) => event.type === "item.started" && event.itemId === "tool-1",
          );
          expect(toolStarted).toMatchObject({
            type: "item.started",
            payload: { itemType: "command_execution", status: "inProgress", title: "bash" },
          });
          const toolCompleted = recorder.events.find(
            (event) => event.type === "item.completed" && event.itemId === "tool-1",
          );
          expect(toolCompleted).toMatchObject({
            payload: { itemType: "command_execution", status: "completed" },
          });

          assertAllEventsDecode(recorder.events);
          yield* adapter.stopSession(threadId);
        }),
    ),
  );

  it.effect("interruptTurn emits turn.aborted", () =>
    runWithPiAdapter({ MOCK_PI_STALL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-interrupt");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "work" });
        yield* recorder.waitFor((event) => event.type === "turn.started");
        yield* adapter.interruptTurn(threadId);
        const aborted = yield* recorder.waitFor((event) => event.type === "turn.aborted");
        expect(aborted.payload).toMatchObject({ reason: "interrupted" });
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("process exit fails the turn and closes the session", () =>
    runWithPiAdapter({ MOCK_PI_EXIT_AFTER_PROMPT: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-process-exit");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* recorder.waitFor((event) => event.type === "session.exited");
        const completed = recorder.events.find((event) => event.type === "turn.completed");
        expect(completed?.payload).toMatchObject({ state: "failed" });
        const sessions = yield* adapter.listSessions();
        expect(sessions[0]?.status).toBe("closed");
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("model error path fails the turn with the provider message", () =>
    runWithPiAdapter({ MOCK_PI_ERROR: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-model-error");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({
          state: "failed",
          errorMessage: "Mock model failure",
        });
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("unknown model selection fails closed at startSession", () =>
    runWithPiAdapter({}, ({ adapter }) =>
      Effect.gen(function* () {
        const outcome = yield* adapter
          .startSession({
            threadId: ThreadId.make("pi-fail-closed"),
            runtimeMode: "full-access",
            modelSelection: { instanceId, model: "nonexistent-model" },
          })
          .pipe(Effect.result);
        if (!Result.isFailure(outcome)) {
          throw new Error("expected startSession to fail for an unknown model");
        }
        const failure = outcome.failure;
        // 模型解析发生在 spawn 之前：裸 ProviderAdapterValidationError。
        expect(failure._tag).toBe("ProviderAdapterValidationError");
        expect(failure.message).toContain(
          "No BYOK adapter is published as model 'nonexistent-model'",
        );
        // 进程从未启动：没有会话残留。
        const sessions = yield* adapter.listSessions();
        expect(sessions).toEqual([]);
      }),
    ),
  );

  it.effect("empty BYOK routes fail closed at startSession", () =>
    runWithPiAdapter(
      {},
      ({ adapter }) =>
        Effect.gen(function* () {
          const outcome = yield* adapter
            .startSession({
              threadId: ThreadId.make("pi-no-routes"),
              runtimeMode: "full-access",
            })
            .pipe(Effect.result);
          if (!Result.isFailure(outcome)) {
            throw new Error("expected startSession to fail without BYOK routes");
          }
          expect(outcome.failure._tag).toBe("ProviderAdapterValidationError");
          expect(outcome.failure.message).toContain("No BYOK model adapters are routable");
        }),
      [],
    ),
  );

  it.effect("stalled turn is aborted cleanly by stopSession", () =>
    runWithPiAdapter({ MOCK_PI_STALL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-stall-stop");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "stall" });
        yield* recorder.waitFor((event) => event.type === "turn.started");
        yield* adapter.stopSession(threadId);
        const aborted = yield* recorder.waitFor(
          (event) => event.type === "turn.aborted" || event.type === "turn.completed",
        );
        expect(aborted.type).toBe("turn.aborted");
        if (aborted.type === "turn.aborted") {
          expect(aborted.payload.reason).toBe("session stopped");
        }
        assertAllEventsDecode(recorder.events);
      }),
    ),
  );

  it.effect("extension_ui_request round-trips through respondToUserInput", () =>
    runWithPiAdapter({ MOCK_PI_INPUT: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("pi-user-input");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "ask me" });
        const requested = yield* recorder.waitFor((event) => event.type === "user-input.requested");
        if (requested.type !== "user-input.requested") {
          throw new Error(`unexpected event type ${requested.type}`);
        }
        expect(requested.payload.questions[0]?.question).toBe("Mock pi input request");

        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("ui-1"), {
          response: "Yes",
        });
        const resolved = yield* recorder.waitFor((event) => event.type === "user-input.resolved");
        if (resolved.type !== "user-input.resolved") {
          throw new Error(`unexpected event type ${resolved.type}`);
        }
        expect(resolved.payload.answers).toEqual({ response: "Yes" });

        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });
        const text = recorder.events
          .filter(
            (event) =>
              event.type === "content.delta" && event.payload.streamKind === "assistant_text",
          )
          .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
          .join("");
        expect(text).toBe("INPUT_RECEIVED:Yes");
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );
});
