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
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

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
  }) => Effect.Effect<void, ProviderAdapterError>,
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
    );
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
        expect(recorder.events.some((event) => event.type === "thread.token-usage.updated")).toBe(
          true,
        );
        expect(recorder.events.every((event) => isProviderRuntimeEvent(event))).toBe(true);
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
