// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - 测试等待真实 ACP 子进程调度。
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { createModelSelection } from "@codework/shared/model";

import {
  ApprovalRequestId,
  CursorSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  ProviderInstanceId,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { runtimeEventToActivities } from "../../orchestration/Layers/ProviderRuntimeIngestion.ts";
import type {
  ProviderToolBrokerBridge,
  ProviderToolBrokerInvocation,
} from "../Services/ProviderAdapter.ts";
import type { CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

// Test-local service tag so the rest of the file can keep using `yield* CursorAdapter`.
class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "codework/provider/Layers/CursorAdapter.test/CursorAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = "node";
const mockAgentArgs = [mockAgentPath] as const;

const acceptToolBrokerHandshake = Effect.fn("acceptToolBrokerHandshake")(function* (
  adapter: CursorAdapterShape,
  input: Parameters<NonNullable<CursorAdapterShape["handshakeCapabilities"]>>[0],
) {
  const result = yield* adapter.handshakeCapabilities!(input);
  if (result.status !== "accepted" || result.handshakeId === undefined) {
    return yield* Effect.die(new Error("Cursor 测试握手未被接受。"));
  }
  return result.handshakeId;
});

async function makeMockAgentWrapper(
  extraEnv?: Record<string, string>,
  options?: { initialDelaySeconds?: number },
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
  const script = isWindows
    ? await (async () => {
        // 环境通过 JSON 传入 Node 启动器，保留 Windows 路径并透传子进程退出码。
        const envPath = NodePath.join(dir, "mock-env.json");
        const bootstrapPath = NodePath.join(dir, "fake-agent-bootstrap.cjs");
        await NodeFSP.writeFile(envPath, JSON.stringify(extraEnv ?? {}), "utf8");
        await NodeFSP.writeFile(
          bootstrapPath,
          [
            'const { readFileSync } = require("node:fs");',
            'const { spawn } = require("node:child_process");',
            "const [envPath, agentPath, delayMs, ...args] = process.argv.slice(2);",
            'const extraEnv = JSON.parse(readFileSync(envPath, "utf8"));',
            "const delay = Number(delayMs);",
            "const start = () => {",
            "  const child = spawn(process.execPath, [agentPath, ...args], {",
            "    env: { ...process.env, ...extraEnv },",
            '    stdio: "inherit",',
            "  });",
            '  child.once("exit", (code) => process.exit(code ?? 1));',
            "};",
            "if (Number.isFinite(delay) && delay > 0) setTimeout(start, delay);",
            "else start();",
            "",
          ].join("\n"),
          "utf8",
        );
        const delayMs = options?.initialDelaySeconds
          ? String(Math.ceil(options.initialDelaySeconds * 1000))
          : "0";
        return [
          "@echo off",
          `"${process.execPath}" "${bootstrapPath}" "${envPath}" "${mockAgentPath}" ${delayMs} %*`,
          "exit /b %ERRORLEVEL%",
          "",
        ].join("\n");
      })()
    : `#!/bin/sh
${Object.entries(extraEnv ?? {})
  .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
  .join("\n")}
${options?.initialDelaySeconds ? `sleep ${JSON.stringify(String(options.initialDelaySeconds))}` : ""}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function makeProbeWrapper(
  requestLogPath: string,
  argvLogPath: string,
  extraEnv?: Record<string, string>,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-probe-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
  const script = isWindows
    ? `@echo off
for %%A in (%*) do <nul set /p="%%~A\t" >> "${argvLogPath}"
echo.>> "${argvLogPath}"
set "CODEWORK_ACP_REQUEST_LOG_PATH=${requestLogPath}"
${Object.entries(extraEnv ?? {})
  .map(([key, value]) => `set "${key}=${value.replaceAll('"', '""')}"`)
  .join("\n")}
"${process.execPath}" "${mockAgentPath}" %*
exit /b %ERRORLEVEL%
`
    : `#!/bin/sh
printf '%s\t' "$@" >> ${JSON.stringify(argvLogPath)}
printf '\n' >> ${JSON.stringify(argvLogPath)}
export CODEWORK_ACP_REQUEST_LOG_PATH=${JSON.stringify(requestLogPath)}
${Object.entries(extraEnv ?? {})
  .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
  .join("\n")}
exec ${JSON.stringify(mockAgentCommand)} ${mockAgentArgs.map((arg) => JSON.stringify(arg)).join(" ")} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFileContent(filePath: string, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const raw = await NodeFSP.readFile(filePath, "utf8");
      if (raw.trim().length > 0) {
        return raw;
      }
    } catch {}
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for file content at ${filePath}`);
}

function waitForJsonLogMatch(
  filePath: string,
  predicate: (entry: Record<string, unknown>) => boolean,
  attempts = 40,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requests = yield* Effect.promise(() => readJsonLines(filePath));
      if (requests.some(predicate)) {
        return requests;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.promise(() => readJsonLines(filePath));
  });
}

// Tests mutate `ServerSettingsService` mid-flight (e.g. setting
// `providers.cursor.binaryPath` to a mock ACP wrapper). The adapter
// captures `cursorSettings` once at construction, so without a resolver
// the mutation is invisible — sessions would spawn the constructor's
// (empty) binary path. Wiring `resolveSettings` through
// `ServerSettingsService.getSettings` makes each session read the latest
// snapshot, matching the old "always read live" behavior that these
// tests assumed.
const makeResolveCursorSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return yield* Effect.succeed(
    serverSettings.getSettings.pipe(
      Effect.map((snapshot) => snapshot.providers.cursor),
      Effect.orDie,
    ),
  );
});

const cursorAdapterTestLayer = it.layer(
  Layer.effect(
    CursorAdapter,
    Effect.gen(function* () {
      const cursorConfig = decodeCursorSettings({});
      const resolveSettings = yield* makeResolveCursorSettings;
      return yield* makeCursorAdapter(cursorConfig, { resolveSettings });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "codework-cursor-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

cursorAdapterTestLayer("CursorAdapterLive", (it) => {
  it.effect("ACP 用量归零更新投影，忽略其它会话与重放用量", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-usage-update");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_USAGE: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "用量测试" });
      const updates = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "thread.token-usage.updated",
      );
      assert.deepEqual(
        updates.map((event) => event.payload.usage),
        [
          { usedTokens: 320, maxTokens: 64_000 },
          { usedTokens: 0, maxTokens: 64_000 },
        ],
      );
      assert.isTrue(
        updates.every((event) => event.threadId === threadId && event.turnId === turn.turnId),
      );
      assert.deepEqual(
        updates
          .flatMap((event) => runtimeEventToActivities(event))
          .map((activity) => activity.payload),
        [
          { usedTokens: 320, maxTokens: 64_000 },
          { usedTokens: 0, maxTokens: 64_000 },
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ACP 思考独立传递，前后正文使用不同消息 ID", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-thought-segmentation");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_THOUGHTS: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "协议测试" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.deepEqual(
        deltas.map((event) => event.payload.streamKind),
        ["assistant_text", "reasoning_text", "assistant_text"],
      );
      assert.deepEqual(
        deltas.map((event) => event.payload.delta),
        ["before thought", "测试思考", "after thought"],
      );
      assert.isDefined(deltas[0]?.itemId);
      assert.isDefined(deltas[2]?.itemId);
      assert.notEqual(deltas[0]?.itemId, deltas[2]?.itemId);
      assert.deepEqual(runtimeEventToActivities(deltas[1]!), []);
      yield* adapter.stopSession(threadId);
    }),
  );
  for (const closeBehavior of ["success", "fail", "unsupported"]) {
    it.effect(`停止会话遵守关闭广告并报告 ${closeBehavior} 结果`, () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make(`cursor-close-${closeBehavior}`);
        const logDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-close-")),
        );
        const logPath = NodePath.join(logDir, "requests.jsonl");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            CODEWORK_ACP_REQUEST_LOG_PATH: logPath,
            ...(closeBehavior === "unsupported"
              ? {}
              : { CODEWORK_ACP_CLOSE_BEHAVIOR: closeBehavior }),
          }),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
        const exited = yield* Deferred.make<ProviderRuntimeEvent>();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            event.type === "session.exited" && event.threadId === threadId
              ? Deferred.succeed(exited, event).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.stopSession(threadId);
        const event = yield* Deferred.await(exited);
        assert.equal(event.type, "session.exited");
        if (event.type === "session.exited")
          assert.equal(event.payload.exitKind, closeBehavior === "fail" ? "error" : "graceful");
        const requests = yield* Effect.promise(() => readJsonLines(logPath));
        assert.equal(
          requests.filter((request) => request.method === "session/close").length,
          closeBehavior === "unsupported" ? 0 : 1,
        );
      }),
    );
  }
  it.effect("拒绝不支持的会话回退并保留本地历史", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-rollback-unsupported");
      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "保留这轮上下文" });
      const before = yield* adapter.readThread(threadId);
      const retainedTurns = [...before.turns];
      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(result.failure.message, /不支持.*回退/u);
      }
      assert.deepEqual((yield* adapter.readThread(threadId)).turns, retainedTurns);
      yield* adapter.stopSession(threadId);
    }),
  );

  for (const commandProtocol of ["标准"] as ReadonlyArray<string>) {
    it.effect(`${commandProtocol} ACP 命令在握手期间发现，后续替换及撤回，并原样发送参数`, () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("acp-command-menu");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-commands-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            ...(commandProtocol === "Kiro"
              ? { CODEWORK_ACP_EMIT_KIRO_COMMANDS: "1" }
              : { CODEWORK_ACP_EMIT_COMMANDS: "1" }),
            CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath,
          }),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
        const startup = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "thread.started"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        });
        const initial = Array.from(yield* Fiber.join(startup)).find(
          (event) => event.type === "session.started",
        );
        assert.deepEqual(
          initial?.payload.slashCommands,
          commandProtocol === "Kiro"
            ? [
                { name: "agent", description: "选择代理", input: { hint: "swap <name>" } },
                { name: "review", description: "审查变更" },
              ]
            : [{ name: "review", description: "审查变更", input: { hint: "文件路径" } }],
        );
        for (const [input, commands] of [
          ["/review src/main.ts", [{ name: "inspect", description: "检查文件" }]],
          ["/inspect src/main.ts", []],
        ] as const) {
          const completed = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* adapter.sendTurn({ threadId, input });
          const events = Array.from(yield* Fiber.join(completed));
          const updates = events.filter((event) => event.type === "session.configured");
          assert.equal(updates.length, 1);
          assert.deepEqual(updates[0]?.payload.slashCommands, commands);
          assert.deepEqual(
            updates
              .flatMap((event) => runtimeEventToActivities(event))
              .map((activity) => activity.payload),
            [{ providerInstanceId: "cursor", commands }],
          );
        }
        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        assert.deepEqual(
          requests
            .filter((entry) => entry.method === "session/prompt")
            .map((entry) => (entry.params as Record<string, unknown>).prompt),
          commandProtocol === "Kiro"
            ? [[{ type: "text", text: "/review src/main.ts" }]]
            : [
                [{ type: "text", text: "/review src/main.ts" }],
                [{ type: "text", text: "/inspect src/main.ts" }],
              ],
        );
        if (commandProtocol === "Kiro") {
          assert.deepEqual(
            requests
              .filter((entry) => entry.method === "_kiro.dev/commands/execute")
              .map((entry) => entry.params),
            [
              {
                sessionId: "mock-session-1",
                command: { command: "inspect", args: { value: "src/main.ts" } },
              },
            ],
          );
        }
        yield* adapter.stopSession(threadId);
      }),
    );
  }

  it.effect("ACP URI 模式在启动和下一回合优先于两态推断，坏值不提交 prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-uri-mode");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_URI_MODES: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const uri = "https://agentclientprotocol.com/protocol/session-modes#review";
      const selection = (value: string | boolean) => ({
        instanceId: ProviderInstanceId.make("cursor"),
        model: "default",
        options: [{ id: "acpMode", value }],
      });
      const startup = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "thread.started"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: selection(uri),
      });
      const initial = Array.from(yield* Fiber.join(startup)).find(
        (event) => event.type === "session.started",
      );
      assert.equal(initial?.payload.mode?.currentValue, uri);
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "模式验证",
        interactionMode: "plan",
        modelSelection: selection("ask"),
      });
      const activities = Array.from(yield* Fiber.join(events)).flatMap((event) =>
        runtimeEventToActivities(event),
      );
      assert.deepInclude(
        activities.findLast((activity) => activity.kind === "session.mode.updated")?.payload,
        { providerInstanceId: "cursor", mode: { ...initial?.payload.mode, currentValue: "ask" } },
      );
      for (const value of [true, "removed"]) {
        assert.equal(
          (yield* adapter
            .sendTurn({ threadId, input: "不能发送", modelSelection: selection(value) })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ACP 下一回合可选择通知新增的模型和模式", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-dynamic-config");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "acp-config-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          CODEWORK_ACP_EMIT_CONFIG_UPDATES: "1",
          CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      for (const model of ["default", "dynamic-next"]) {
        const completed = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.sendTurn({
          threadId,
          input: "配置测试",
          interactionMode: "default",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model },
        });
        const events = Array.from(yield* Fiber.join(completed));
        assert.isFalse(events.some((event) => event.type === "runtime.error"));
        const catalogs = events
          .flatMap((event) => runtimeEventToActivities(event))
          .filter((activity) => activity.kind === "session.models.updated");
        assert.deepEqual(catalogs.at(-1)?.payload, {
          providerInstanceId: "cursor",
          models:
            model === "default"
              ? [
                  {
                    slug: "dynamic-default",
                    name: "默认模型",
                    isDefault: true,
                    isCustom: false,
                    capabilities: null,
                  },
                  {
                    slug: "dynamic-next",
                    name: "新增模型",
                    isDefault: false,
                    isCustom: false,
                    capabilities: null,
                  },
                ]
              : [],
        });
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown>)?.configId === "engine" &&
            (entry.params as Record<string, unknown>)?.value === "dynamic-next",
        ),
      );
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown>)?.configId === "operation" &&
            (entry.params as Record<string, unknown>)?.value === "code",
        ),
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("握手前配置进入会话启动事件，命令快照同时保留", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-startup-config");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_STARTUP_CONFIG: "missing" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const started = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "session.started"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "dynamic-default" },
      });
      const [event] = Array.from(yield* Fiber.join(started));
      assert.isDefined(event);
      const activities = runtimeEventToActivities(event!);
      assert.deepEqual(
        activities.map((activity) => activity.kind),
        [
          "session.config-options.updated",
          "session.mode.updated",
          "session.commands.updated",
          "session.models.updated",
        ],
      );
      assert.deepEqual(event?.payload.slashCommands, [{ name: "startup" }]);
      assert.deepEqual(
        event?.payload.models?.map((model) => model.slug),
        ["dynamic-default", "dynamic-next"],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-mock-thread");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      assert.equal(session.provider, "cursor");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello mock",
        attachments: [],
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const types = runtimeEvents.map((e) => e.type);
      assert.isBelow(types.indexOf("item.completed"), types.indexOf("turn.completed"));

      for (const t of [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "turn.plan.updated",
        "item.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ] as const) {
        assert.include(types, t);
      }

      const assistantStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantStarted);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
        assert.match(String(delta.itemId), /^assistant:mock-session-1:runtime:[^:]+:segment:0$/);
      }

      const assistantCompleted = runtimeEvents.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      assert.isDefined(assistantCompleted);

      const planUpdate = runtimeEvents.find((event) => event.type === "turn.plan.updated");
      assert.isDefined(planUpdate);
      if (planUpdate?.type === "turn.plan.updated") {
        assert.deepStrictEqual(planUpdate.payload.plan, [
          { step: "Inspect mock ACP state", status: "completed" },
          { step: "Implement the requested change", status: "inProgress" },
        ]);
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("通过真实 ACP 子进程把文件读取回调路由到 Provider ToolBroker", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-read-e2e");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-workspace-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "notes.txt");
      const resultLogPath = NodePath.join(workspaceRoot, "tool-results.ndjson");
      const requestLogPath = NodePath.join(workspaceRoot, "requests.ndjson");
      const argvLogPath = NodePath.join(workspaceRoot, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, {
          CODEWORK_ACP_READ_TEXT_FILE_PATH: requestedPath,
          CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH: resultLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const invocations: ProviderToolBrokerInvocation[] = [];
      const bridge: ProviderToolBrokerBridge = {
        invoke: (invocation) =>
          Effect.sync(() => {
            invocations.push(invocation);
            return {
              status: "succeeded" as const,
              result: {
                relativePath: "notes.txt",
                contents: "alpha\nbeta\ngamma\ndelta",
                truncated: false,
              },
            };
          }),
        cancel: () => Effect.void,
      };
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-cursor-toolbroker",
        runId: "run-cursor-toolbroker",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge,
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-cursor-toolbroker",
          runId: "run-cursor-toolbroker",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-read"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });
      yield* adapter.sendTurn({ threadId, input: "读取测试文件", attachments: [] });

      const toolResults = yield* Effect.promise(() => readJsonLines(resultLogPath));
      assert.deepStrictEqual(toolResults, [
        { method: "fs/read_text_file", result: { content: "beta\ngamma" } },
      ]);
      assert.equal(invocations.length, 1);
      assert.equal(invocations[0]?.canonicalToolName, "workspace.read_file");
      assert.deepStrictEqual(invocations[0]?.arguments, {
        cwd: workspaceRoot,
        relativePath: "notes.txt",
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const initialize = requests.find((entry) => entry.method === "initialize");
      const clientCapabilities = (
        initialize?.params as { readonly clientCapabilities?: Record<string, unknown> } | undefined
      )?.clientCapabilities as
        | { readonly fs?: Record<string, unknown>; readonly terminal?: boolean }
        | undefined;
      assert.deepStrictEqual(clientCapabilities?.fs, {
        readTextFile: true,
        writeTextFile: true,
      });
      assert.equal(clientCapabilities?.terminal, true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ToolBroker 拒绝时向真实 ACP 子进程返回脱敏请求错误", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-denied-e2e");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-denied-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "denied.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_READ_TEXT_FILE_PATH: requestedPath }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-cursor-denied",
        runId: "run-cursor-denied",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-denied"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: () => Effect.succeed({ status: "denied", errorCode: "capability_not_granted" }),
          cancel: () => Effect.void,
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-cursor-denied",
          runId: "run-cursor-denied",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-denied"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });

      const error = yield* adapter
        .sendTurn({ threadId, input: "读取无权限文件", attachments: [] })
        .pipe(Effect.flip);
      assert.notInclude(String(error), requestedPath);
      assert.notInclude(String(error), "grant-denied");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("拒绝与当前 Cursor session 不匹配的 ACP 工具请求", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-session-mismatch");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-session-mismatch-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "notes.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          CODEWORK_ACP_READ_TEXT_FILE_PATH: requestedPath,
          CODEWORK_ACP_CLIENT_TOOL_SESSION_ID: "foreign-session",
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const invocations: ProviderToolBrokerInvocation[] = [];
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-cursor-session-mismatch",
        runId: "run-cursor-session-mismatch",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: (invocation) =>
            Effect.sync(() => {
              invocations.push(invocation);
              return { status: "succeeded" as const, result: { contents: "unexpected" } };
            }),
          cancel: () => Effect.void,
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-cursor-session-mismatch",
          runId: "run-cursor-session-mismatch",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-read"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });

      yield* adapter
        .sendTurn({ threadId, input: "尝试使用错误 sessionId", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(invocations.length, 0);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("撤销 capability handshake 后旧 ACP handler 不能继续调用 ToolBroker", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-revoked-handshake");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-revoked-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "notes.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_READ_TEXT_FILE_PATH: requestedPath }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const invocations: ProviderToolBrokerInvocation[] = [];
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-cursor-revoked",
        runId: "run-cursor-revoked",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: (invocation) =>
            Effect.sync(() => {
              invocations.push(invocation);
              return { status: "succeeded" as const, result: { contents: "unexpected" } };
            }),
          cancel: () => Effect.void,
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-cursor-revoked",
          runId: "run-cursor-revoked",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-read"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });
      yield* adapter.revokeCapabilityHandshake!({ handshakeId: capabilityHandshakeId });

      yield* adapter
        .sendTurn({ threadId, input: "撤销后读取文件", attachments: [] })
        .pipe(Effect.flip);
      assert.equal(invocations.length, 0);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clear 或 revoke 后拒绝使用旧 handshake 启动 Session", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const threadId = ThreadId.make("cursor-toolbroker-start-fail-closed");
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-start-fail-closed",
        runId: "run-start-fail-closed",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: { invoke: () => Effect.die("不应调用"), cancel: () => Effect.void },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-start-fail-closed",
          runId: "run-start-fail-closed",
          agentId: "provider:cursor",
          workspaceRoot: process.cwd(),
          capabilityGrantIds: ["grant-read"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.clearToolBroker!(threadId);

      const clearError = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          capabilityHandshakeId,
        })
        .pipe(Effect.flip);
      assert.include(String(clearError), "同一 Adapter 代次");

      const secondHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-start-fail-closed",
        runId: "run-start-fail-closed-2",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.revokeCapabilityHandshake!({ handshakeId: secondHandshakeId });
      const revokeError = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          capabilityHandshakeId: secondHandshakeId,
        })
        .pipe(Effect.flip);
      assert.include(String(revokeError), "同一 Adapter 代次");
    }),
  );

  it.effect("撤销 ToolBroker 时取消在途调用", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-cancel-inflight");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-inflight-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "notes.txt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_READ_TEXT_FILE_PATH: requestedPath }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const invocationStarted = yield* Deferred.make<void>();
      const invocationResult = yield* Deferred.make<{
        readonly status: "cancelled";
        readonly errorCode: string;
      }>();
      const cancellations: string[] = [];
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-inflight",
        runId: "run-inflight",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-read"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: (invocation) =>
            Deferred.succeed(invocationStarted, undefined).pipe(
              Effect.andThen(Deferred.await(invocationResult)),
            ),
          cancel: (invocation) =>
            Effect.sync(() => cancellations.push(invocation.toolCallId)).pipe(
              Effect.andThen(
                Deferred.succeed(invocationResult, {
                  status: "cancelled" as const,
                  errorCode: "binding_revoked",
                }),
              ),
              Effect.asVoid,
            ),
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-inflight",
          runId: "run-inflight",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-read"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "读取文件", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(invocationStarted);
      yield* adapter.clearToolBroker!(threadId);
      yield* Fiber.await(sendFiber);
      assert.lengthOf(cancellations, 1);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("撤销 ToolBroker 时关闭 ACP 已创建但未 release 的终端", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-owned-terminal-cleanup");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-terminal-cleanup-")),
      );
      const resultLogPath = NodePath.join(workspaceRoot, "terminal-results.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          CODEWORK_ACP_TERMINAL_COMMAND: "long-running-command",
          CODEWORK_ACP_TERMINAL_CWD: workspaceRoot,
          CODEWORK_ACP_TERMINAL_HANG_AFTER_CREATE: "1",
          CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH: resultLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const invocations: ProviderToolBrokerInvocation[] = [];
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-terminal-cleanup",
        runId: "run-terminal-cleanup",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-terminal"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: (invocation) =>
            Effect.sync(() => {
              invocations.push(invocation);
              return {
                status: "succeeded" as const,
                result:
                  invocation.canonicalToolName === "terminal.exec" ? { status: "running" } : {},
              };
            }),
          cancel: () => Effect.void,
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-terminal-cleanup",
          runId: "run-terminal-cleanup",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-terminal"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });
      const sendFiber = yield* adapter
        .sendTurn({ threadId, input: "启动长命令", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => waitForFileContent(resultLogPath, 400));
      yield* adapter.clearToolBroker!(threadId);
      assert.deepEqual(
        invocations.map((invocation) => invocation.canonicalToolName),
        ["terminal.exec", "terminal.close"],
      );
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(sendFiber);
    }),
  );

  it.effect("真实 ACP 子进程按 kill、output、wait、release 顺序使用终端 handle", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-toolbroker-terminal-lifecycle");
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-terminal-lifecycle-")),
      );
      const resultLogPath = NodePath.join(workspaceRoot, "terminal-results.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          CODEWORK_ACP_TERMINAL_COMMAND: "example-command",
          CODEWORK_ACP_TERMINAL_CWD: workspaceRoot,
          CODEWORK_ACP_TERMINAL_KILL_BEFORE_WAIT: "1",
          CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH: resultLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const invocations: ProviderToolBrokerInvocation[] = [];
      let terminalStatus = "running";
      const capabilityHandshakeId = yield* acceptToolBrokerHandshake(adapter, {
        runtimeId: "provider:cursor",
        taskId: "task-terminal-lifecycle",
        runId: "run-terminal-lifecycle",
        agentId: "provider:cursor",
        capabilityGrantIds: ["grant-terminal"],
      });
      yield* adapter.configureToolBroker!({
        threadId,
        bridge: {
          invoke: (invocation) =>
            Effect.sync(() => {
              invocations.push(invocation);
              if (invocation.canonicalToolName === "terminal.kill") terminalStatus = "exited";
              if (invocation.canonicalToolName === "terminal.snapshot") {
                return {
                  status: "succeeded" as const,
                  result: {
                    history: "terminal-output",
                    status: terminalStatus,
                    exitCode: terminalStatus === "exited" ? 143 : null,
                    exitSignal: null,
                  },
                };
              }
              return { status: "succeeded" as const, result: {} };
            }),
          cancel: () => Effect.void,
        },
        context: {
          runtimeId: "provider:cursor",
          taskId: "task-terminal-lifecycle",
          runId: "run-terminal-lifecycle",
          agentId: "provider:cursor",
          workspaceRoot,
          capabilityGrantIds: ["grant-terminal"],
          capabilityHandshakeId,
          threadId,
        },
      });
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId,
      });
      yield* adapter.sendTurn({ threadId, input: "执行终端生命周期", attachments: [] });

      assert.deepEqual(
        invocations.map((invocation) => invocation.canonicalToolName),
        [
          "terminal.exec",
          "terminal.kill",
          "terminal.snapshot",
          "terminal.snapshot",
          "terminal.close",
        ],
      );
      const results = yield* Effect.promise(() => readJsonLines(resultLogPath));
      assert.deepEqual(
        results.map((entry) => entry.method),
        [
          "terminal/create",
          "terminal/kill",
          "terminal/output",
          "terminal/wait_for_exit",
          "terminal/release",
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-steer-thread");

      // Keep the first prompt in flight long enough for the steer to land.
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_PROMPT_DELAY_MS: "1500" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run 5 commands",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      // Poll until the first prompt is in flight — sendTurn binds the active
      // turn id before prompting. The mock agent runs on the real clock, so
      // each TestClock.adjust just provides the scheduler hops for its stdio
      // responses to land.
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (session?.activeTurnId !== undefined) {
            return;
          }
          yield* TestClock.adjust("10 millis");
        }
        throw new Error("Timed out waiting for the first prompt to be in flight.");
      });

      // Steer: a second sendTurn while the first prompt is still in flight
      // continues the same turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        attachments: [],
      });
      const firstTurn = yield* Fiber.join(firstTurnFiber);
      assert.equal(String(steeredTurn.turnId), String(firstTurn.turnId));

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      const turnStartedEvents = runtimeEvents.filter((event) => event.type === "turn.started");
      const turnCompletedEvents = runtimeEvents.filter((event) => event.type === "turn.completed");

      // One turn boundary for the whole run: the superseded first prompt
      // resolving must not settle the merged turn.
      assert.equal(turnStartedEvents.length, 1);
      assert.equal(String(turnStartedEvents[0]?.turnId), String(firstTurn.turnId));
      assert.equal(turnCompletedEvents.length, 1);
      assert.equal(String(turnCompletedEvents[0]?.turnId), String(firstTurn.turnId));

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          CODEWORK_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      yield* adapter.stopSession(threadId);
      assert.isFalse(yield* adapter.hasSession(threadId));
      // oxlint-disable-next-line codework/no-global-process-runtime -- the assertion waits for a signal only on POSIX hosts.
      if (process.platform !== "win32") {
        const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
        assert.include(exitLog, "SIGTERM");
      }
    }),
  );

  it.effect(
    "serializes concurrent startSession calls for the same thread and closes the replaced ACP session",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const settings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-concurrent-start-session");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-adapter-concurrent-exit-log-")),
        );
        const exitLogPath = NodePath.join(tempDir, "exit.log");

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper(
            {
              CODEWORK_ACP_EXIT_LOG_PATH: exitLogPath,
            },
            { initialDelaySeconds: 0.2 },
          ),
        );
        yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

        const [firstSession, secondSession] = yield* Effect.all(
          [
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
            }),
            adapter.startSession({
              threadId,
              provider: ProviderDriverKind.make("cursor"),
              cwd: process.cwd(),
              runtimeMode: "full-access",
              modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(firstSession.threadId, threadId);
        assert.equal(secondSession.threadId, threadId);
        assert.equal(
          (yield* adapter.listSessions()).filter((session) => session.threadId === threadId).length,
          1,
        );

        yield* adapter.stopSession(threadId);
        assert.isFalse(yield* adapter.hasSession(threadId));
        // oxlint-disable-next-line codework/no-global-process-runtime -- the assertion waits for a signal only on POSIX hosts.
        if (process.platform !== "win32") {
          const exitLog = yield* Effect.promise(() => waitForFileContent(exitLogPath));
          assert.equal(exitLog.match(/SIGTERM/g)?.length ?? 0, 2);
        }
      }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const result = yield* adapter
        .startSession({
          threadId: ThreadId.make("bad-provider"),
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }),
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-plan-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === "session/set_mode" ||
            (entry.method === "session/set_config_option" &&
              (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
        );
      assert.isDefined(modeRequest);
      assert.equal(
        (modeRequest?.params as Record<string, unknown> | undefined)?.sessionId,
        "mock-session-1",
      );
      assert.include(
        ["architect", "plan"],
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
      );
    }),
  );

  it.effect(
    "applies initial model and mode configuration during startSession and skips repeating it on first send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-initial-config-probe");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const modelSelection = createModelSelection(ProviderInstanceId.make("cursor"), "gpt-5.4", [
          { id: "reasoning", value: "xhigh" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ]);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection,
        });

        yield* Effect.promise(() => waitForFileContent(requestLogPath));

        const requestsAfterStart = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const configIdsAfterStart = requestsAfterStart.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(configIdsAfterStart, [
          "model",
          "reasoning",
          "context",
          "fast",
          "mode",
        ]);

        yield* adapter.sendTurn({
          threadId,
          input: "hello mock",
          attachments: [],
          modelSelection,
          interactionMode: "default",
        });
        yield* adapter.stopSession(threadId);

        const finalRequests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const finalConfigIds = finalRequests.flatMap((entry) =>
          entry.method === "session/set_config_option" &&
          typeof (entry.params as Record<string, unknown> | undefined)?.configId === "string"
            ? [String((entry.params as Record<string, unknown>).configId)]
            : [],
        );
        assert.deepStrictEqual(finalConfigIds, ["model", "reasoning", "context", "fast", "mode"]);
        assert.equal(finalRequests.filter((entry) => entry.method === "session/prompt").length, 1);
      }),
  );

  it.effect(
    "streams ACP tool calls and approvals on the active turn in approval-required mode",
    () =>
      Effect.gen(function* () {
        const previousEmitToolCalls = process.env.CODEWORK_ACP_EMIT_TOOL_CALLS;
        process.env.CODEWORK_ACP_EMIT_TOOL_CALLS = "1";

        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-tool-call-probe");
        const approvalLogDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-approval-")),
        );
        const approvalLog = NodePath.join(approvalLogDir, "permissions.ndjson");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();

        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            CODEWORK_ACP_EMIT_TOOL_CALLS: "1",
            CODEWORK_ACP_ALLOW_ONCE_OPTION_ID: "cline_allow_once_original",
            CODEWORK_ACP_CLIENT_TOOL_RESULT_LOG_PATH: approvalLog,
          }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (event.type === "request.opened" && event.requestId) {
              yield* adapter.respondToRequest(
                threadId,
                ApprovalRequestId.make(String(event.requestId)),
                "accept",
              );
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        const program = Effect.gen(function* () {
          yield* adapter.startSession({
            threadId,
            provider: ProviderDriverKind.make("cursor"),
            cwd: process.cwd(),
            runtimeMode: "approval-required",
            modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
          });

          const turn = yield* adapter.sendTurn({
            threadId,
            input: "run a tool call",
            attachments: [],
          });
          yield* Deferred.await(settledEventsReady);

          assert.include(
            yield* Effect.promise(() => NodeFSP.readFile(approvalLog, "utf8")),
            '"optionId":"cline_allow_once_original"',
          );

          const threadEvents = runtimeEvents.filter(
            (event) => String(event.threadId) === String(threadId),
          );
          assert.includeMembers(
            threadEvents.map((event) => event.type),
            [
              "session.started",
              "session.state.changed",
              "thread.started",
              "turn.started",
              "request.opened",
              "request.resolved",
              "item.updated",
              "item.completed",
              "content.delta",
              "turn.completed",
            ],
          );

          const turnEvents = threadEvents.filter(
            (event) => String(event.turnId) === String(turn.turnId),
          );
          const toolUpdates = turnEvents.filter((event) => event.type === "item.updated");
          // ACP updates can arrive either as distinct pending + in-progress events
          // or as a single coalesced in-progress update before approval resolves.
          assert.isAtLeast(toolUpdates.length, 1);
          for (const toolUpdate of toolUpdates) {
            if (toolUpdate.type !== "item.updated") {
              continue;
            }
            assert.equal(toolUpdate.payload.itemType, "command_execution");
            assert.equal(toolUpdate.payload.status, "inProgress");
            assert.equal(toolUpdate.payload.detail, "cat server/package.json");
            assert.equal(String(toolUpdate.itemId), "tool-call-1");
          }

          const requestOpened = turnEvents.find((event) => event.type === "request.opened");
          assert.isDefined(requestOpened);
          if (requestOpened?.type === "request.opened") {
            assert.equal(String(requestOpened.turnId), String(turn.turnId));
            assert.equal(requestOpened.payload.requestType, "exec_command_approval");
            assert.equal(requestOpened.payload.detail, "cat server/package.json");
          }

          const requestResolved = turnEvents.find((event) => event.type === "request.resolved");
          assert.isDefined(requestResolved);
          if (requestResolved?.type === "request.resolved") {
            assert.equal(String(requestResolved.turnId), String(turn.turnId));
            assert.equal(requestResolved.payload.requestType, "exec_command_approval");
            assert.equal(requestResolved.payload.decision, "accept");
          }

          const toolCompleted = turnEvents.find(
            (event) =>
              event.type === "item.completed" && event.payload.itemType === "command_execution",
          );
          assert.isDefined(toolCompleted);
          if (toolCompleted?.type === "item.completed") {
            assert.equal(String(toolCompleted.turnId), String(turn.turnId));
            assert.equal(toolCompleted.payload.itemType, "command_execution");
            assert.equal(toolCompleted.payload.status, "completed");
            assert.equal(toolCompleted.payload.detail, "cat server/package.json");
            assert.equal(String(toolCompleted.itemId), "tool-call-1");
          }
          const toolActivities = turnEvents
            .flatMap((event) => runtimeEventToActivities(event))
            .filter((activity) => activity.kind.startsWith("tool."));
          assert.includeMembers(
            toolActivities.map((activity) => activity.kind),
            ["tool.updated", "tool.completed"],
          );
          assert.isTrue(
            toolActivities.every(
              (activity) =>
                (activity.payload as Record<string, unknown>).toolCallId === "tool-call-1",
            ),
          );

          const contentDelta = turnEvents.find((event) => event.type === "content.delta");
          assert.isDefined(contentDelta);
          if (contentDelta?.type === "content.delta") {
            assert.equal(String(contentDelta.turnId), String(turn.turnId));
            assert.equal(contentDelta.payload.delta, "hello from mock");
            assert.match(
              String(contentDelta.itemId),
              /^assistant:mock-session-1:runtime:[^:]+:segment:0$/,
            );
          }
        });

        yield* program.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousEmitToolCalls === undefined) {
                delete process.env.CODEWORK_ACP_EMIT_TOOL_CALLS;
              } else {
                process.env.CODEWORK_ACP_EMIT_TOOL_CALLS = previousEmitToolCalls;
              }
            }),
          ),
        );
      }).pipe(
        Effect.provide(
          Layer.effect(
            CursorAdapter,
            Effect.gen(function* () {
              const cursorConfig = decodeCursorSettings({});
              const resolveSettings = yield* makeResolveCursorSettings;
              return yield* makeCursorAdapter(cursorConfig, { resolveSettings });
            }),
          ).pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), {
                prefix: "codework-cursor-adapter-test-",
              }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "auto-approves ACP tool permissions in full-access mode without approval runtime events",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-full-access-auto-approve");
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const settledEventTypes = new Set<string>();
        const settledEventsReady = yield* Deferred.make<void>();
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath, { CODEWORK_ACP_EMIT_TOOL_CALLS: "1" }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.gen(function* () {
            runtimeEvents.push(event);
            if (String(event.threadId) !== String(threadId)) {
              return;
            }
            if (
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
              event.type === "content.delta"
            ) {
              settledEventTypes.add(event.type);
              if (settledEventTypes.size === 3) {
                yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
              }
            }
          }),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        });

        const turn = yield* adapter.sendTurn({
          threadId,
          input: "run a tool call",
          attachments: [],
        });

        yield* Deferred.await(settledEventsReady);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const turnEvents = runtimeEvents.filter(
          (event) =>
            String(event.threadId) === String(threadId) &&
            String(event.turnId) === String(turn.turnId),
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.opened",
        );
        assert.notInclude(
          turnEvents.map((event) => event.type),
          "request.resolved",
        );
        assert.includeMembers(
          turnEvents.map((event) => event.type),
          ["item.updated", "item.completed", "content.delta", "turn.completed"],
        );

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const permissionResponse = requests.find(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "outcome" in entry.result.outcome &&
            entry.result.outcome.outcome === "selected" &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "allow-always",
        );
        assert.isDefined(permissionResponse);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("segments assistant messages around ACP tool activity in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-assistant-tool-segmentation");
      const runtimeEvents: Array<ProviderRuntimeEvent> = [];
      const settledEventTypes = new Set<string>();
      const settledEventsReady = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      });

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (
            event.type === "content.delta" ||
            (event.type === "item.completed" && event.payload.itemType === "command_execution") ||
            event.type === "turn.completed"
          ) {
            if (event.type === "content.delta") {
              settledEventTypes.add(`delta:${event.payload.delta}`);
            } else {
              settledEventTypes.add(event.type);
            }
            if (
              settledEventTypes.has("delta:before tool") &&
              settledEventTypes.has("delta:after tool") &&
              settledEventTypes.has("item.completed") &&
              settledEventTypes.has("turn.completed")
            ) {
              yield* Deferred.succeed(settledEventsReady, undefined).pipe(Effect.orDie);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run an interleaved tool call",
        attachments: [],
      });

      yield* Deferred.await(settledEventsReady);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const turnEvents = runtimeEvents.filter(
        (event) =>
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turn.turnId),
      );
      const firstAssistantStartIndex = turnEvents.findIndex(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const firstAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "before tool",
      );
      const assistantBoundaryIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      const toolUpdateIndex = turnEvents.findIndex(
        (event) => event.type === "item.updated" && event.payload.itemType === "command_execution",
      );
      const toolCompletedIndex = turnEvents.findIndex(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      const secondAssistantStartIndex = turnEvents.findIndex(
        (event, index) =>
          index > toolCompletedIndex &&
          event.type === "item.started" &&
          event.payload.itemType === "assistant_message",
      );
      const secondAssistantDeltaIndex = turnEvents.findIndex(
        (event) => event.type === "content.delta" && event.payload.delta === "after tool",
      );

      assert.isAtLeast(firstAssistantStartIndex, 0);
      assert.isAtLeast(firstAssistantDeltaIndex, 0);
      assert.isAtLeast(assistantBoundaryIndex, 0);
      assert.isAtLeast(toolUpdateIndex, 0);
      assert.isAtLeast(toolCompletedIndex, 0);
      assert.isAtLeast(secondAssistantStartIndex, 0);
      assert.isAtLeast(secondAssistantDeltaIndex, 0);
      assert.isBelow(firstAssistantStartIndex, firstAssistantDeltaIndex);
      assert.isBelow(firstAssistantDeltaIndex, assistantBoundaryIndex);
      assert.isBelow(assistantBoundaryIndex, toolUpdateIndex);
      assert.isBelow(toolUpdateIndex, toolCompletedIndex);
      assert.isBelow(toolCompletedIndex, secondAssistantStartIndex);
      assert.isBelow(secondAssistantStartIndex, secondAssistantDeltaIndex);

      const assistantStarts = turnEvents.filter(
        (event) => event.type === "item.started" && event.payload.itemType === "assistant_message",
      );
      const assistantDeltas = turnEvents.filter((event) => event.type === "content.delta");
      assert.lengthOf(assistantStarts, 2);
      assert.lengthOf(assistantDeltas, 2);
      if (
        assistantStarts[0]?.type === "item.started" &&
        assistantStarts[1]?.type === "item.started" &&
        assistantDeltas[0]?.type === "content.delta" &&
        assistantDeltas[1]?.type === "content.delta"
      ) {
        assert.notEqual(String(assistantStarts[0].itemId), String(assistantStarts[1].itemId));
        assert.equal(String(assistantDeltas[0].itemId), String(assistantStarts[0].itemId));
        assert.equal(String(assistantDeltas[1].itemId), String(assistantStarts[1].itemId));
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("cancels pending ACP approvals and marks the turn cancelled when interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-cancel-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath, { CODEWORK_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const requestResolvedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      const turnCompletedReady = yield* Deferred.make<ProviderRuntimeEvent>();
      let interrupted = false;

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "request.opened" && event.requestId && !interrupted) {
            interrupted = true;
            yield* adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "cancel",
            );
            yield* adapter.interruptTurn(threadId);
            return;
          }
          if (event.type === "request.resolved") {
            yield* Deferred.succeed(requestResolvedReady, event).pipe(Effect.ignore);
            return;
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompletedReady, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel this turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestResolved = yield* Deferred.await(requestResolvedReady);
      const turnCompleted = yield* Deferred.await(turnCompletedReady);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(runtimeEventsFiber);

      assert.equal(requestResolved.type, "request.resolved");
      if (requestResolved.type === "request.resolved") {
        assert.equal(requestResolved.payload.decision, "cancel");
      }

      assert.equal(turnCompleted.type, "turn.completed");
      if (turnCompleted.type === "turn.completed") {
        assert.equal(turnCompleted.payload.state, "cancelled");
        assert.equal(turnCompleted.payload.stopReason, "cancelled");
      }

      const isCancelledApprovalResponse = (entry: Record<string, unknown>) =>
        !("method" in entry) &&
        typeof entry.result === "object" &&
        entry.result !== null &&
        "outcome" in entry.result &&
        typeof entry.result.outcome === "object" &&
        entry.result.outcome !== null &&
        "outcome" in entry.result.outcome &&
        entry.result.outcome.outcome === "cancelled";
      const approvalResponses = yield* waitForJsonLogMatch(
        requestLogPath,
        isCancelledApprovalResponse,
      );
      assert.isTrue(approvalResponses.some(isCancelledApprovalResponse));

      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("stopping a session settles pending approval waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-approval");
      const approvalRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "request.opened") {
          return Effect.void;
        }
        return Deferred.succeed(approvalRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "run a tool call and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(approvalRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect(
    "agent crash mid-approval settles pending request, fails the turn, and rejects late approval",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-crash-mid-approval");
        const approvalOpened = yield* Deferred.make<string>();
        const approvalResolved = yield* Deferred.make<ProviderRuntimeEvent>();
        const turnCompleted = yield* Deferred.make<ProviderRuntimeEvent>();
        const sessionExited = yield* Deferred.make<ProviderRuntimeEvent>();

        const childLogDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-crash-agent-")),
        );
        const childPidLogPath = NodePath.join(childLogDir, "agent.pid");
        // 只终止本次夹具启动时记录的 Agent；收到审批事件后触发，不靠定时猜测。
        const wrapperPath = yield* Effect.promise(() =>
          makeMockAgentWrapper({
            CODEWORK_ACP_EMIT_TOOL_CALLS: "1",
            CODEWORK_ACP_CHILD_PID_LOG_PATH: childPidLogPath,
          }),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
          if (String(event.threadId) !== String(threadId)) {
            return Effect.void;
          }
          if (event.type === "request.opened" && event.requestId) {
            return Deferred.succeed(approvalOpened, String(event.requestId)).pipe(Effect.ignore);
          }
          if (event.type === "request.resolved") {
            return Deferred.succeed(approvalResolved, event).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            return Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
          if (event.type === "session.exited") {
            return Deferred.succeed(sessionExited, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        });

        const sendTurnFiber = yield* adapter
          .sendTurn({
            threadId,
            input: "crash while waiting for approval",
            attachments: [],
          })
          .pipe(Effect.forkChild);

        const requestId = yield* Deferred.await(approvalOpened);
        const childPid = Number(
          yield* Effect.promise(() => NodeFSP.readFile(childPidLogPath, "utf8")),
        );
        assert.isTrue(Number.isSafeInteger(childPid) && childPid > 0);
        yield* Effect.sync(() => NodeProcess.kill(childPid));
        const completed = yield* Deferred.await(turnCompleted);
        const exited = yield* Deferred.await(sessionExited);
        const sendExit = yield* Fiber.await(sendTurnFiber);
        const resolved = yield* Deferred.await(approvalResolved);
        yield* Fiber.interrupt(runtimeEventsFiber);

        assert.equal(completed.type, "turn.completed");
        if (completed.type === "turn.completed") {
          assert.equal(completed.payload.state, "failed");
          assert.isTrue(Boolean(completed.payload.errorMessage));
        }
        assert.equal(exited.type, "session.exited");
        assert.equal(resolved.type, "request.resolved");
        if (resolved.type === "request.resolved") assert.equal(resolved.payload.decision, "cancel");
        assert.equal(sendExit._tag, "Failure");
        assert.equal(yield* adapter.hasSession(threadId), false);

        const lateApproval = yield* adapter
          .respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept")
          .pipe(Effect.result);
        assert.equal(lateApproval._tag, "Failure");
      }).pipe(TestClock.withLive),
    { timeout: 30_000 },
  );

  it.effect("late approval after stop fails once pending approval was settled by disconnect", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-late-approval-after-stop");
      const approvalOpened = yield* Deferred.make<string>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      yield* serverSettings.updateSettings({
        providers: { cursor: { binaryPath: wrapperPath } },
      });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "request.opened" && event.requestId) {
          return Deferred.succeed(approvalOpened, String(event.requestId)).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "approve after disconnect",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const requestId = yield* Deferred.await(approvalOpened);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);
      assert.equal(yield* adapter.hasSession(threadId), false);
      const lateApproval = yield* adapter
        .respondToRequest(threadId, ApprovalRequestId.make(requestId), "accept")
        .pipe(Effect.result);
      assert.equal(lateApproval._tag, "Failure");
    }).pipe(TestClock.withLive),
  );

  it.effect("stopping a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-stop-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then stop",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      yield* adapter.stopSession(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("interrupting a session settles pending user-input waits", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-interrupt-pending-user-input");
      const userInputRequested = yield* Deferred.make<void>();

      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_ASK_QUESTION: "1" }),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId) || event.type !== "user-input.requested") {
          return Effect.void;
        }
        return Deferred.succeed(userInputRequested, undefined).pipe(Effect.ignore);
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "ask me a question and then interrupt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(userInputRequested);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.await(sendTurnFiber);

      assert.equal(yield* adapter.hasSession(threadId), true);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("broadcasts runtime events to multiple stream consumers", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-runtime-event-broadcast");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const firstConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const secondConsumer = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });

      const firstEvents = Array.from(yield* Fiber.join(firstConsumer));
      const secondEvents = Array.from(yield* Fiber.join(secondConsumer));

      assert.deepStrictEqual(
        firstEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );
      assert.deepStrictEqual(
        secondEvents.map((event) => event.type),
        ["session.started", "session.state.changed", "thread.started"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("switches model in-session via session/set_config_option", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-model-switch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn after switching model",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: true },
        ]),
      });

      const argvRuns = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.lengthOf(argvRuns, 1, "session should not restart — only one spawn");
      assert.deepStrictEqual(argvRuns[0], ["acp"]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const setConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "model",
      );
      assert.isAbove(setConfigRequests.length, 0, "should call session/set_config_option");
      assert.equal((setConfigRequests[0]?.params as Record<string, unknown>)?.value, "composer-2");

      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAbove(fastConfigRequests.length, 0, "should apply fast mode as a separate config");
      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "true");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears prior fast mode in-session when the next turn sets fastMode: false", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const serverSettings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-fast-mode-reset");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const argvLogPath = NodePath.join(tempDir, "argv.txt");
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const wrapperPath = yield* Effect.promise(() =>
        makeProbeWrapper(requestLogPath, argvLogPath),
      );
      yield* serverSettings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "composer-2" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn with fast mode",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: true },
        ]),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "second turn without fast mode",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
          { id: "fastMode", value: false },
        ]),
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const fastConfigRequests = requests.filter(
        (entry) =>
          entry.method === "session/set_config_option" &&
          (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
      );
      assert.isAtLeast(fastConfigRequests.length, 2, "should set fast mode on and then off");

      const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
      assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "false");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "applies fast mode on the first turn when modelSelection uses a non-default instance id",
    () => {
      const customInstanceId = ProviderInstanceId.make("cursor_secondary");
      // Custom-instance cases can't share the suite-level `CursorAdapter`
      // layer because that one binds `instanceId: "cursor"`. We build a
      // fresh layer graph — including a fresh `ServerSettingsService` — so
      // mid-test `updateSettings` calls target the same service instance the
      // adapter's `resolveSettings` reads from, and so the outer
      // `yield* ServerSettingsService` sees the same snapshot as well.
      const customAdapterLayer = Layer.effect(
        CursorAdapter,
        Effect.gen(function* () {
          const cursorConfig = decodeCursorSettings({});
          const resolveSettings = yield* makeResolveCursorSettings;
          return yield* makeCursorAdapter(cursorConfig, {
            instanceId: customInstanceId,
            resolveSettings,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "codework-cursor-adapter-custom-instance-",
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* CursorAdapter;
        const serverSettings = yield* ServerSettingsService;
        const threadId = ThreadId.make("cursor-fast-mode-custom-instance");
        const tempDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-acp-")),
        );
        const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
        const argvLogPath = NodePath.join(tempDir, "argv.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
        const wrapperPath = yield* Effect.promise(() =>
          makeProbeWrapper(requestLogPath, argvLogPath),
        );
        yield* serverSettings.updateSettings({
          providers: { cursor: { binaryPath: wrapperPath } },
        });

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: customInstanceId,
            model: "composer-2",
          },
        });

        yield* adapter.sendTurn({
          threadId,
          input: "first turn with fast mode",
          attachments: [],
          modelSelection: {
            ...createModelSelection(ProviderInstanceId.make("cursor"), "composer-2", [
              { id: "fastMode", value: true },
            ]),
            instanceId: customInstanceId,
          },
        });

        const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
        const fastConfigRequests = requests.filter(
          (entry) =>
            entry.method === "session/set_config_option" &&
            (entry.params as Record<string, unknown> | undefined)?.configId === "fast",
        );
        assert.isAbove(
          fastConfigRequests.length,
          0,
          "fast mode should apply when instance id matches the adapter binding",
        );
        const lastFastConfig = fastConfigRequests[fastConfigRequests.length - 1];
        assert.equal((lastFastConfig?.params as Record<string, unknown>)?.value, "true");

        yield* adapter.stopSession(threadId);
      }).pipe(Effect.provide(customAdapterLayer));
    },
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. The other tests here call startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("cursor-consumer-outlives-start-session");

      const wrapperPath = yield* Effect.promise(() => makeMockAgentWrapper());
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const sawContentDelta = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "content.delta" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(sawContentDelta, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello mock", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sawContentDelta).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );

  it.effect("ACP 资源独立成段且排除重放和其它会话", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-resource-stream");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_RESOURCES: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "资源测试" });
      const deltas = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "content.delta",
      );
      assert.equal(deltas.length, 4);
      assert.isDefined(deltas[0]?.itemId);
      assert.equal(new Set(deltas.map((event) => event.itemId)).size, 4);
      const text = deltas.map((event) => event.payload.delta).join("");
      assert.include(text, "[资源报告](<https://example.com/report?q=1#section>)");
      assert.include(text, "报告说明");
      assert.include(text, "mcp://example/report");
      assert.include(
        text,
        "````text\n报告正文\n```\n![不是图片](https://example.com/test.png)\n```\n````",
      );
      assert.match(text, /^资源开始[\s\S]*资源结束$/);
      assert.notInclude(text, "不应出现");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("Cursor 图片独立成段且过滤重放和其它会话", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const threadId = ThreadId.make("acp-resource-stream");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({ CODEWORK_ACP_EMIT_IMAGES: "1" }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("cursor"), model: "default" },
      });
      yield* adapter.sendTurn({ threadId, input: "资源测试" });
      const deltas = Array.from(yield* Fiber.join(eventsFiber)).filter(
        (event) => event.type === "content.delta",
      );
      assert.equal(deltas.length, 5);
      assert.equal(new Set(deltas.map((event) => event.itemId)).size, 5);
      assert.deepEqual(
        deltas.map((event) => event.payload.delta),
        ["图片前文", "", "", "图片后文", ""],
      );
      assert.equal(deltas.filter((event) => event.payload.image).length, 3);
      assert.equal(deltas[1]?.payload.image?.mimeType, "image/png");
      assert.deepInclude(deltas[1]!.raw!.payload, {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", mimeType: "image/png", data: "[省略图片正文]" },
        },
      });
      yield* adapter.stopSession(threadId);
    }),
  );
});
