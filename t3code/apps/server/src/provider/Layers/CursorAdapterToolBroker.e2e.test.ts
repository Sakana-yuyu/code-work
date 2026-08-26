// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CursorSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderSessionStartInput,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as CapabilityPolicy from "../../composition/CapabilityPolicy.ts";
import * as CapabilityRegistry from "../../composition/CapabilityRegistry.ts";
import { makeCompositionProviderToolBrokerBridge } from "../../composition/CompositionProviderToolBrokerBridge.ts";
import { makeCompositionRuntimeToolBridge } from "../../composition/CompositionRuntimeToolBridge.ts";
import * as ToolBroker from "../../composition/ToolBroker.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import type { CursorAdapterShape } from "../Services/CursorAdapter.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";

class CursorAdapter extends Context.Service<CursorAdapter, CursorAdapterShape>()(
  "t3/provider/Layers/CursorAdapterToolBroker.e2e.test/CursorAdapter",
) {}

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeCursorSettings = Schema.decodeSync(CursorSettings);

async function makeMockAgentWrapper(extraEnv: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-e2e-"));
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
  const script = isWindows
    ? `@echo off
${Object.entries(extraEnv)
  .map(([key, value]) => `set "${key}=${value.replaceAll('"', '""')}"`)
  .join("\n")}
"${process.execPath}" "${mockAgentPath}" %*
exit /b %ERRORLEVEL%
`
    : `#!/bin/sh
${Object.entries(extraEnv)
  .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
  .join("\n")}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const capabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const capabilityPolicy = CapabilityPolicy.makeCompositionCapabilityPolicy({
  capabilityRegistry,
});
const CapabilityRegistryLayer = Layer.succeed(
  CapabilityRegistry.CapabilityRegistry,
  capabilityRegistry,
);
const CapabilityPolicyLayer = Layer.succeed(CapabilityPolicy.CapabilityPolicy, capabilityPolicy);
const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const CursorAdapterLayer = Layer.effect(
  CursorAdapter,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    return yield* makeCursorAdapter(decodeCursorSettings({}), {
      resolveSettings: settings.getSettings.pipe(
        Effect.map((snapshot) => snapshot.providers.cursor),
        Effect.orDie,
      ),
    });
  }),
).pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-cursor-toolbroker-e2e-" }),
  ),
  Layer.provide(NodeServices.layer),
);

const TestLayer = Layer.mergeAll(
  CursorAdapterLayer,
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer),
    Layer.provide(CapabilityRegistryLayer),
    Layer.provide(WorkspaceFileLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityRegistryLayer,
  WorkspaceFileLayer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(TestLayer, { excludeTestServices: true })("Cursor ACP Provider ToolBroker E2E", (it) => {
  it.effect("真实子进程经 Runtime Bridge 和 T3 ToolBroker 读取工作区文件", () =>
    Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const settings = yield* ServerSettingsService;
      const toolBroker = yield* ToolBroker.ToolBroker;
      const workspaceRoot = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-toolbroker-real-workspace-")),
      );
      const requestedPath = NodePath.join(workspaceRoot, "notes.txt");
      const resultLogPath = NodePath.join(workspaceRoot, "tool-results.ndjson");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(requestedPath, "alpha\nbeta\ngamma\ndelta", "utf8"),
      );
      const wrapperPath = yield* Effect.promise(() =>
        makeMockAgentWrapper({
          T3_ACP_READ_TEXT_FILE_PATH: requestedPath,
          T3_ACP_CLIENT_TOOL_RESULT_LOG_PATH: resultLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { cursor: { binaryPath: wrapperPath } } });

      const threadId = ThreadId.make("cursor-runtime-toolbridge-e2e");
      const taskId = "task-cursor-runtime-toolbridge-e2e";
      const runId = "run-cursor-runtime-toolbridge-e2e";
      const runtimeId = "provider:cursor-e2e";
      const agentId = "provider:cursor-e2e";
      const capabilityGrantIds = ["t3.workspace.read_file"];
      const handshake = yield* adapter.handshakeCapabilities!({
        runtimeId,
        taskId,
        runId,
        agentId,
        capabilityGrantIds,
      });
      if (handshake.status !== "accepted" || handshake.handshakeId === undefined) {
        return yield* Effect.die(new Error("Cursor E2E capability handshake 未被接受。"));
      }
      const handshakeId = handshake.handshakeId;
      const task = {
        taskId,
        projectId: "project-cursor-e2e",
        threadId,
        assigneeKind: "agent" as const,
        assigneeId: agentId,
        mode: "serial" as const,
        status: "running" as const,
        promptDigest: "sha256:cursor-e2e",
        dependsOnTaskIds: [],
        createdAtUnixMs: 1,
        updatedAtUnixMs: 1,
      };
      const run = {
        runId,
        taskId,
        agentId,
        runtimeId,
        status: "running" as const,
        attempt: 1,
        capabilityGrantIds,
        capabilityHandshakeId: handshakeId,
      };
      const runtimeBridge = makeCompositionRuntimeToolBridge({
        taskStore: {
          getTask: (requestedTaskId) =>
            Effect.succeed(requestedTaskId === taskId ? Option.some(task) : Option.none()),
          getRun: (requestedRunId) =>
            Effect.succeed(requestedRunId === runId ? Option.some(run) : Option.none()),
        },
        inputStore: {
          get: (requestedTaskId) =>
            Effect.succeed(
              requestedTaskId === taskId
                ? Option.some({ taskId, prompt: "读取文件", workspaceRoot })
                : Option.none(),
            ),
        },
        toolBroker,
      });
      const context = {
        runtimeId,
        taskId,
        runId,
        agentId,
        workspaceRoot,
        capabilityGrantIds,
        capabilityHandshakeId: handshakeId,
        threadId,
      };
      yield* adapter.configureToolBroker!({
        threadId,
        context,
        bridge: makeCompositionProviderToolBrokerBridge({ runtimeBridge, context }),
      });
      const sessionInput: ProviderSessionStartInput = {
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: workspaceRoot,
        runtimeMode: "full-access",
        capabilityHandshakeId: handshakeId,
      };
      yield* adapter.startSession(sessionInput);
      yield* adapter.sendTurn({ threadId, input: "读取测试文件", attachments: [] });

      assert.deepStrictEqual(yield* Effect.promise(() => readJsonLines(resultLogPath)), [
        { method: "fs/read_text_file", result: { content: "beta\ngamma" } },
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );
});
