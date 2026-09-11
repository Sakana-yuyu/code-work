// @effect-diagnostics nodeBuiltinImport:off - 测试夹具直接用 node:fs/os/path。
/**
 * OmpAdapter e2e 测试（真实子进程 + scripts/omp-mock-agent.mjs）。
 *
 * 覆盖：v2 协议协商（argv 与 negotiate_protocol 经 MOCK_OMP_LOG 断言）、
 * happy path、ToolBroker host-tool 闭环（成功/拒绝）、Allow tool 审批回路
 * （Approve/Deny）、中断、子代理事件映射。所有等待都走事件
 * （Deferred + Stream.tap），不睡眠不轮询。
 *
 * @module provider/pifamily/OmpAdapter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  OmpAgentSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@codework/contracts";

import { ServerConfig } from "../../config.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderToolBrokerBridge,
  ProviderToolBrokerContext,
  ProviderToolBrokerInvocation,
} from "../Services/ProviderAdapter.ts";
import type { PifamilyModelRoute } from "./byokProviderConfig.ts";

const decodeOmpSettings = Schema.decodeSync(OmpAgentSettings);
const isProviderRuntimeEvent = Schema.is(ProviderRuntimeEvent);
const instanceId = ProviderInstanceId.make("omp-adapter-test");

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
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/omp-mock-agent.mjs");

/** 与 PiAdapter.test 相同：适配器在 binaryPath 后追加协议 flags，经 wrapper 转发。 */
async function makeMockAgentWrapper(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-omp-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "omp-mock.cmd" : "omp-mock.sh");
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

const assistantText = (events: ReadonlyArray<ProviderRuntimeEvent>): string =>
  events
    .filter(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    )
    .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
    .join("");

const brokerContext = (threadId: ThreadId): ProviderToolBrokerContext => ({
  runtimeId: "provider:omp-e2e",
  taskId: "task-omp-e2e",
  runId: "run-omp-e2e",
  agentId: "provider:omp-e2e",
  workspaceRoot: NodeOS.tmpdir(),
  capabilityGrantIds: ["t3.workspace.read_file"],
  capabilityHandshakeId: "handshake-omp-e2e",
  threadId,
});

interface OmpLogEntry {
  readonly kind: "argv" | "frame";
  readonly value: unknown;
}

const readOmpLog = async (logPath: string): Promise<ReadonlyArray<OmpLogEntry>> => {
  const raw = await NodeFSP.readFile(logPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OmpLogEntry);
};

const runWithOmpAdapter = (
  environment: Record<string, string>,
  body: (input: {
    readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
    readonly recorder: PifamilyEventRecorder;
    readonly logPath: string;
  }) => Effect.Effect<void, ProviderAdapterError>,
) =>
  Effect.gen(function* () {
    const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
    const agentHome = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-omp-agent-home-")),
    );
    const logDir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-omp-log-")),
    );
    const logPath = NodePath.join(logDir, "omp-log.ndjson");
    const adapter = yield* makeOmpAdapter(
      decodeOmpSettings({ enabled: true, binaryPath: wrapperPath, launchArgs: "" }),
      {
        instanceId,
        environment: {
          ...environment,
          PI_CODING_AGENT_DIR: agentHome,
          MOCK_OMP_LOG: logPath,
        },
        resolveRoutes: Effect.succeed(mockRoutes),
      },
    );
    const recorder = yield* makeEventRecorder();
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => recorder.record(event)),
      Effect.forkScoped,
    );
    yield* body({ adapter, recorder, logPath });
  }).pipe(
    Effect.scoped,
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codework-omp-adapter-test-" })),
    Effect.provide(NodeServices.layer),
  );

describe("makeOmpAdapter", () => {
  it.effect("v2 negotiation + happy path", () =>
    runWithOmpAdapter({}, ({ adapter, recorder, logPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-happy-path");
        const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        expect(session.model).toBe("mock-byok-adapter");
        yield* recorder.waitFor((event) => event.type === "thread.started");

        yield* adapter.sendTurn({ threadId, input: "hello" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed", stopReason: "agent_end" });
        expect(assistantText(recorder.events)).toBe("Mock omp response.");

        const log = yield* Effect.promise(() => readOmpLog(logPath));
        // spawn 参数：--mode rpc-ui --approval-mode（runtimeMode 映射）+ 模型。
        const argv = (log.find((entry) => entry.kind === "argv")?.value ??
          []) as ReadonlyArray<string>;
        expect(argv).toContain("--mode");
        expect(argv).toContain("rpc-ui");
        expect(argv).toContain("--approval-mode");
        // approvalMode 默认 "auto"：full-access → yolo。
        expect(argv).toContain("yolo");
        expect(argv).toContain("codework-openai/mock-byok-adapter");
        // ready 帧 → negotiate_protocol v2。
        const negotiate = log
          .map((entry) => (entry.kind === "frame" ? entry.value : undefined))
          .find(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              (frame as Record<string, unknown>).type === "negotiate_protocol",
          ) as Record<string, unknown> | undefined;
        expect(negotiate?.protocolVersion).toBe(2);

        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("host tool call closes the loop through the ToolBroker bridge", () =>
    runWithOmpAdapter({ MOCK_OMP_HOST_TOOL: "1" }, ({ adapter, recorder, logPath }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-host-tool");
        expect(adapter.capabilities.toolBrokerCanonicalTools).toEqual([
          "workspace.read_file",
          "workspace.write_file",
          "terminal.exec",
          "terminal.snapshot",
          "terminal.kill",
          "terminal.close",
        ]);
        const invocations: ProviderToolBrokerInvocation[] = [];
        const bridge: ProviderToolBrokerBridge = {
          invoke: (input) =>
            Effect.sync(() => {
              invocations.push(input);
              return { status: "succeeded", result: { content: "hello from broker" } };
            }),
          cancel: () => Effect.void,
        };
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.configureToolBroker!({
          threadId,
          bridge,
          context: brokerContext(threadId),
        });

        yield* adapter.sendTurn({ threadId, input: "read the file" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });

        expect(invocations).toHaveLength(1);
        expect(invocations[0]).toMatchObject({
          toolCallId: "omp-host-ht-1",
          canonicalToolName: "workspace.read_file",
          idempotencyKey: "run-omp-e2e:omp-host-ht-1",
          arguments: { path: "/workspace/hello.txt" },
        });
        // 桥结果（JSON 字符串）作为 host_tool_result 文本回到 agent，并进入
        // 最终 assistant 文本。
        const text = assistantText(recorder.events);
        expect(text).toContain("HOST_TOOL_DONE:");
        expect(text).toContain('"hello from broker"');

        // set_host_tools 注册了 6 个 canonical 工具。
        const log = yield* Effect.promise(() => readOmpLog(logPath));
        const setHostTools = log
          .map((entry) => (entry.kind === "frame" ? entry.value : undefined))
          .find(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              (frame as Record<string, unknown>).type === "set_host_tools",
          ) as { tools?: ReadonlyArray<{ name?: string }> } | undefined;
        expect(setHostTools?.tools?.map((tool) => tool.name)).toEqual([
          "workspace.read_file",
          "workspace.write_file",
          "terminal.exec",
          "terminal.snapshot",
          "terminal.kill",
          "terminal.close",
        ]);

        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("denied host tool reports isError and the turn still completes", () =>
    runWithOmpAdapter({ MOCK_OMP_HOST_TOOL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-host-denied");
        const invocations: ProviderToolBrokerInvocation[] = [];
        const bridge: ProviderToolBrokerBridge = {
          invoke: (input) =>
            Effect.sync(() => {
              invocations.push(input);
              return { status: "denied", errorCode: "tool_approval_required" };
            }),
          cancel: () => Effect.void,
        };
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.configureToolBroker!({
          threadId,
          bridge,
          context: brokerContext(threadId),
        });

        yield* adapter.sendTurn({ threadId, input: "read the file" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });
        expect(invocations).toHaveLength(1);
        const text = assistantText(recorder.events);
        expect(text).toContain("HOST_TOOL_DONE:");
        expect(text).toContain("denied by Code Work (tool_approval_required)");
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("Allow tool approval round-trips an accept decision", () =>
    runWithOmpAdapter({ MOCK_OMP_APPROVAL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-approval-accept");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "run it" });

        const opened = yield* recorder.waitFor((event) => event.type === "request.opened");
        expect(opened.requestId).toBe("perm-1");
        if (opened.type !== "request.opened") {
          throw new Error(`unexpected event type ${opened.type}`);
        }
        expect(opened.payload).toMatchObject({
          requestType: "command_execution_approval",
          detail: "Allow tool: bash",
          options: [
            { decision: "decline", label: "Deny" },
            { decision: "accept", label: "Approve" },
          ],
        });

        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("perm-1"), "accept");
        const resolved = yield* recorder.waitFor((event) => event.type === "request.resolved");
        if (resolved.type !== "request.resolved") {
          throw new Error(`unexpected event type ${resolved.type}`);
        }
        expect(resolved.payload).toMatchObject({
          requestType: "command_execution_approval",
          decision: "accept",
        });

        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });
        expect(assistantText(recorder.events)).toContain("APPROVED");
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("Allow tool approval declines cancel the tool and finish the turn", () =>
    runWithOmpAdapter({ MOCK_OMP_APPROVAL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-approval-decline");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "run it" });

        yield* recorder.waitFor((event) => event.type === "request.opened");
        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("perm-1"), "decline");
        const resolved = yield* recorder.waitFor((event) => event.type === "request.resolved");
        if (resolved.type !== "request.resolved") {
          throw new Error(`unexpected event type ${resolved.type}`);
        }
        expect(resolved.payload).toMatchObject({ decision: "decline" });

        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });
        expect(assistantText(recorder.events)).toContain("DENIED");
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  it.effect("interruptTurn emits turn.aborted", () =>
    runWithOmpAdapter({ MOCK_OMP_STALL: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-interrupt");
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

  it.effect("subagent lifecycle maps to task events", () =>
    runWithOmpAdapter({ MOCK_OMP_SUBAGENT: "1" }, ({ adapter, recorder }) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("omp-subagent");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "delegate" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        expect(completed.payload).toMatchObject({ state: "completed" });

        const started = recorder.events.find(
          (event) => event.type === "task.started" && event.payload.taskId === "omp-subagent-sub-1",
        );
        expect(started).toMatchObject({
          type: "task.started",
          payload: { taskType: "provider_subagent", description: "Mock subagent task" },
        });
        const progress = recorder.events.find(
          (event) =>
            event.type === "task.progress" && event.payload.taskId === "omp-subagent-sub-1",
        );
        expect(progress).toMatchObject({
          payload: { status: "running", taskType: "provider_subagent" },
        });
        const taskCompleted = recorder.events.find(
          (event) =>
            event.type === "task.completed" && event.payload.taskId === "omp-subagent-sub-1",
        );
        expect(taskCompleted).toMatchObject({
          payload: { status: "completed", taskType: "provider_subagent" },
        });
        assertAllEventsDecode(recorder.events);
        yield* adapter.stopSession(threadId);
      }),
    ),
  );
});
