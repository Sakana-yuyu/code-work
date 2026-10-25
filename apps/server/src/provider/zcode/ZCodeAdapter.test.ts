// @effect-diagnostics preferSchemaOverJson:off - 测试读取替身写下的 argv JSONL。
// @effect-diagnostics nodeBuiltinImport:off - 测试夹具直接用 node:fs/os/path。
/**
 * ZCodeAdapter e2e 测试（真实子进程 + scripts/zcode-mock-agent.mjs）。
 *
 * 覆盖：happy path（增量、工具、终态、续接游标）、二次回合带 `--resume`、
 * 每轮先写受管配置、模型 fail-closed、turn.failed、进程崩溃兜底、中断。
 * 等待全部走事件（Deferred），不睡眠不轮询。
 *
 * @module provider/zcode/ZCodeAdapter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  ZCodeAgentSettings,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makeZCodeAdapter } from "../Layers/ZCodeAdapter.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { SpawnExecutableResolution } from "@codework/shared/shell";

const decodeSettings = Schema.decodeSync(ZCodeAgentSettings);
const isProviderRuntimeEvent = Schema.is(ProviderRuntimeEvent);
const instanceId = ProviderInstanceId.make("zcode-adapter-test");

const routes: ReadonlyArray<PifamilyModelRoute> = [
  {
    adapterId: "mock-byok-adapter",
    protocol: "openai",
    displayName: "Mock",
    modelId: "gpt-mock",
    contextWindowTokens: 128_000,
  },
  {
    adapterId: "mock-byok-adapter-b",
    protocol: "openai",
    displayName: "Mock B",
    modelId: "gpt-mock-b",
    contextWindowTokens: 128_000,
  },
];

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/zcode-mock-agent.mjs");

async function makeMockAgentWrapper(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-zcode-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "zcode-mock.cmd" : "zcode-mock.sh");
  const script = isWindows
    ? `@echo off\r\n"${process.execPath}" "${mockAgentPath}" %*\r\nexit /b %ERRORLEVEL%\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

interface Recorder {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly waitFor: (
    predicate: (event: ProviderRuntimeEvent) => boolean,
    fromIndex?: number,
  ) => Effect.Effect<ProviderRuntimeEvent>;
}

const makeRecorder = (): Effect.Effect<Recorder> =>
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
      waitFor: (predicate, fromIndex = 0) =>
        Effect.gen(function* () {
          const seen = events.slice(fromIndex).find(predicate);
          if (seen !== undefined) return seen;
          const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
          waiters.push({ predicate, deferred });
          return yield* Deferred.await(deferred);
        }),
    };
  });

const runWithAdapter = (
  environment: Record<string, string>,
  body: (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly recorder: Recorder;
    readonly argvFile: string;
    readonly preparedModels: string[];
  }) => Effect.Effect<void, ProviderAdapterError, Scope.Scope>,
  spawnGate?: {
    readonly secondSpawnAttempted: Deferred.Deferred<void>;
    readonly releaseFile: string;
  },
) =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
    const argvFile = NodePath.join(
      yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-zcode-argv-")),
      ),
      "argv.jsonl",
    );
    const preparedModels: string[] = [];
    const baseSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let spawnCount = 0;
    let firstHandle: ChildProcessSpawner.ChildProcessHandle | undefined;
    const spawner =
      spawnGate === undefined
        ? baseSpawner
        : ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnCount += 1;
              const handle = yield* baseSpawner.spawn(command);
              if (spawnCount === 1) {
                firstHandle = handle;
              } else if (spawnCount === 2) {
                yield* Deferred.succeed(spawnGate.secondSpawnAttempted, undefined);
                yield* Effect.promise(() => NodeFSP.writeFile(spawnGate.releaseFile, "release\n"));
                if (firstHandle !== undefined) yield* firstHandle.exitCode;
              }
              return handle;
            }),
          );
    const adapter = yield* makeZCodeAdapter(
      decodeSettings({ enabled: true, binaryPath: wrapperPath, launchArgs: "" }),
      {
        instanceId,
        environment: { ...environment, MOCK_ZCODE_ARGV_FILE: argvFile },
        spawnTarget: {
          command: wrapperPath,
          argsPrefix: [],
          displayPath: wrapperPath,
          source: "configured" as const,
        },
        resolveRoutes: Effect.succeed(routes),
        prepareTurnConfig: (selected) =>
          Effect.sync(() => void preparedModels.push(selected.adapterId)),
      },
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    const recorder = yield* makeRecorder();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => recorder.record(event)),
      Effect.forkScoped,
    );
    yield* body({ adapter, recorder, argvFile, preparedModels });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "codework-zcode-adapter-test-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const readArgv = (argvFile: string) =>
  Effect.promise(async () =>
    (await NodeFSP.readFile(argvFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]),
  );

describe("makeZCodeAdapter", () => {
  it.effect("Windows argv超限不启动ZCode且失败终态保留统一错误", () =>
    runWithAdapter({}, ({ adapter, recorder, argvFile }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-prompt-too-large");
        yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
        yield* adapter.sendTurn({ threadId, input: "x".repeat(9_000) });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "failed" });
        expect(JSON.stringify(completed.payload)).toContain("AGENT_PROMPT_TOO_LARGE");
        const exists = yield* Effect.promise(() =>
          NodeFSP.stat(argvFile)
            .then(() => true)
            .catch((error: unknown) => {
              if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return false;
              throw error;
            }),
        );
        expect(exists).toBe(false);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }),
    ).pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:/guard/zcode.cmd"),
    ),
  );
  it.effect("happy path：增量、工具、终态与续接游标；二次回合带 --resume", () =>
    runWithAdapter({}, ({ adapter, recorder, argvFile, preparedModels }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-happy");
        const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        expect(session.model).toBe("mock-byok-adapter");

        yield* adapter.sendTurn({ threadId, input: "hello" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });

        const deltas = recorder.events.flatMap((event) =>
          event.type === "content.delta" ? [event.payload] : [],
        );
        expect(deltas).toEqual([
          { streamKind: "reasoning_text", delta: "thinking" },
          { streamKind: "assistant_text", delta: "hello " },
          { streamKind: "assistant_text", delta: "world" },
        ]);
        const toolItems = recorder.events.filter(
          (event) => event.type === "item.started" || event.type === "item.completed",
        );
        expect(toolItems.map((event) => [event.type, event.payload])).toMatchObject([
          ["item.started", { itemType: "command_execution", title: "Bash" }],
          ["item.completed", { itemType: "command_execution", status: "completed" }],
        ]);
        // 参数流：start 先开行，delta 拼出可解析 JSON 后才带出真命令，
        // scheduled 再补全入参——同一 toolCallId 只应该有一条 started。
        const toolUpdates = recorder.events.flatMap((event) =>
          event.type === "item.updated" ? [event.payload] : [],
        );
        expect(toolUpdates.some((payload) => payload.detail === "Bash: ls")).toBe(true);
        expect(
          recorder.events.filter(
            (event) => event.type === "item.started" && event.itemId === "tc1",
          ),
        ).toHaveLength(1);
        // 用量只在 `result` 帧落地（`turn.completed` 之后）：本回合明细与 projection
        // 的上下文占用合并成一条，多发一条会让「N 步」凭空翻倍。
        yield* recorder.waitFor((event) => event.type === "thread.token-usage.updated");
        expect(recorder.events.some((event) => !isProviderRuntimeEvent(event))).toBe(false);
        // 标题镜像：占位标题必须被丢掉，只有真正的标题到达线程元数据。
        expect(
          recorder.events.flatMap((event) =>
            event.type === "thread.metadata.updated" ? [event.payload.name] : [],
          ),
        ).toEqual(["Fixture session title"]);
        // 无头模式拒绝的审批只提示一次，绝不能开成可交互请求。
        const warnings = recorder.events.flatMap((event) =>
          event.type === "runtime.warning" ? [event.payload] : [],
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.message).toContain("Bash");
        expect(
          recorder.events.some(
            (event) => event.type === "request.opened" || event.type === "request.resolved",
          ),
        ).toBe(false);
        expect(preparedModels).toEqual(["mock-byok-adapter"]);

        const [listed] = yield* adapter.listSessions();
        expect(listed?.resumeCursor).toEqual({ zcodeSessionId: "zc-session-1" });

        const cutoff = recorder.events.length;
        yield* adapter.sendTurn({ threadId, input: "again" });
        const second = yield* recorder.waitFor((event) => event.type === "turn.completed", cutoff);
        expect(second.payload).toMatchObject({ state: "completed" });
        const argvs = yield* readArgv(argvFile);
        expect(argvs[0]).toEqual(
          expect.arrayContaining(["--prompt=hello", "--output-format", "stream-json"]),
        );
        expect(argvs[0]).not.toContain("--resume");
        expect(argvs[1]).toEqual(
          expect.arrayContaining(["--resume", "zc-session-1", "--mode", "yolo"]),
        );
      }),
    ),
  );

  it.effect("未知模型 fail-closed，不启动进程", () =>
    runWithAdapter({}, ({ adapter }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-unknown-model");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        const outcome = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "hi",
            modelSelection: { instanceId, model: "no-such-adapter" },
          }),
        );
        expect(outcome._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("回合用量按 ZCode usage 拆分到 Code Work 快照字段", () =>
    runWithAdapter({}, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-usage");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        // 用量在 `result` 帧才落地（`turn.completed` 已经结算），先等它。
        yield* recorder.waitFor((event) => event.type === "thread.token-usage.updated");
        yield* recorder.waitFor((event) => event.type === "turn.completed");
        const usages = recorder.events.flatMap((event) =>
          event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
        );
        // 每回合只发一条用量：`turn.completed` 的明细与 `result` 的上下文占用合并，
        // 多发一条会让「N 步」按行数统计时凭空翻倍。
        expect(usages).toHaveLength(1);
        expect(usages[0]).toMatchObject({
          // 上下文进度条读 contextUsed，而不是本回合计费的 token 总量。
          usedTokens: 1_024,
          maxTokens: 128_000,
          totalProcessedTokens: 42,
          lastUsedTokens: 42,
          inputTokens: 30,
          lastInputTokens: 30,
          outputTokens: 12,
          lastOutputTokens: 12,
          cachedInputTokens: 8,
          reasoningOutputTokens: 5,
          toolUses: 1,
          durationMs: 10,
        });
      }),
    ),
  );

  it.effect("会话已落地后换模型直接拒绝，不按旧模型静默跑一轮", () =>
    runWithAdapter({}, ({ adapter, recorder, argvFile, preparedModels }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-model-switch");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hello" });
        yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
          zcodeSessionId: "zc-session-1",
        });

        const outcome = yield* Effect.exit(
          adapter.sendTurn({
            threadId,
            input: "again",
            modelSelection: { instanceId, model: "mock-byok-adapter-b" },
          }),
        );
        expect(outcome._tag).toBe("Failure");
        const argvs = yield* readArgv(argvFile);
        // 第二次 sendTurn 没有启动进程：ZCode 的 --resume 只认会话库里的模型。
        expect(argvs).toHaveLength(1);
        expect(preparedModels).toEqual(["mock-byok-adapter"]);
      }),
    ),
  );

  it.effect("上一回合迟到的退出帧不会错杀下一回合", () =>
    Effect.gen(function* () {
      const secondSpawnAttempted = yield* Deferred.make<void>();
      const releaseFile = NodePath.join(
        yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-zcode-release-")),
        ),
        "release",
      );
      yield* runWithAdapter(
        { MOCK_ZCODE_MODE: "delayed-exit", MOCK_ZCODE_RELEASE_FILE: releaseFile },
        ({ adapter, recorder }) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("zcode-delayed-exit");
            yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
            yield* adapter.sendTurn({ threadId, input: "first" });
            yield* recorder.waitFor((event) => event.type === "turn.completed");
            const cutoff = recorder.events.length;
            const secondTurn = yield* adapter
              .sendTurn({ threadId, input: "second" })
              .pipe(Effect.forkScoped);
            yield* Deferred.await(secondSpawnAttempted);
            yield* Fiber.join(secondTurn);
            const second = yield* recorder.waitFor(
              (event) => event.type === "turn.completed",
              cutoff,
            );
            expect(second.payload).toMatchObject({ state: "completed" });
          }),
        { secondSpawnAttempted, releaseFile },
      );
    }),
  );

  it.effect("续接会话按会话库旧模型跑时只提醒一次，不静默", () =>
    runWithAdapter(
      { MOCK_ZCODE_MODE: "drift", MOCK_ZCODE_ACTUAL_MODEL: "stale-byok-adapter" },
      ({ adapter, recorder }) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("zcode-model-drift");
          yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
          yield* adapter.sendTurn({ threadId, input: "hello" });
          const warning = yield* recorder.waitFor((event) => event.type === "runtime.warning");
          expect(warning.payload).toMatchObject({
            message: expect.stringContaining("stale-byok-adapter"),
            detail: {
              providerId: "codework-openai",
              modelId: "stale-byok-adapter",
              expected: "mock-byok-adapter",
            },
          });
          yield* recorder.waitFor((event) => event.type === "turn.completed");
          const secondTurnStart = recorder.events.length;
          yield* adapter.sendTurn({ threadId, input: "again" });
          yield* recorder.waitFor((event) => event.type === "turn.completed", secondTurnStart);
          const warnings = recorder.events.filter((event) => event.type === "runtime.warning");
          expect(warnings).toHaveLength(1);
        }),
    ),
  );

  it.effect("turn.failed 以失败终态收尾并带上上游错误", () =>
    runWithAdapter({ MOCK_ZCODE_MODE: "fail" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-fail");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hi" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({
          state: "failed",
          errorMessage: "upstream said no",
        });
      }),
    ),
  );

  it.effect("进程崩溃兜底：失败终态而不是挂死", () =>
    runWithAdapter({ MOCK_ZCODE_MODE: "crash" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-crash");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hi" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "failed" });
        expect(JSON.stringify(completed.payload)).toContain("provider not ready");
      }),
    ),
  );

  it.effect("interruptTurn 发出 turn.aborted 并回收进程", () =>
    runWithAdapter({ MOCK_ZCODE_MODE: "hang" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("zcode-interrupt");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "hi" });
        yield* recorder.waitFor((event) => event.type === "turn.started");
        yield* adapter.interruptTurn(threadId);
        yield* recorder.waitFor((event) => event.type === "turn.aborted");
        const [listed] = yield* adapter.listSessions();
        expect(listed?.status).toBe("ready");
      }),
    ),
  );
});
