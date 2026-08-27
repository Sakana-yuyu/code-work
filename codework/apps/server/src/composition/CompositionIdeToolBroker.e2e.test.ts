// @effect-diagnostics nodeBuiltinImport:off - 本测试启动真实本地 IDE fixture 子进程。
// @effect-diagnostics globalTimers:off - 本测试等待真实子进程和 WebSocket 生命周期。

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as CompositionIdeSessionRegistry from "./CompositionIdeSessionRegistry.ts";
import { makeCompositionIdeJsonRpcAdapter } from "./CompositionIdeJsonRpcTransport.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const fixturePath = fileURLToPath(new URL("./CompositionIdeJsonRpcFixture.mjs", import.meta.url));

type FixtureProcess = {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly url: string;
};

const startFixture = async (): Promise<FixtureProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = NodeReadline.createInterface({ input: child.stdout });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const onLine = (line: string) => {
        try {
          const message = JSON.parse(line) as { readonly port?: unknown };
          if (typeof message.port === "number") resolve(message.port);
        } catch {
          // 忽略 fixture 启动阶段的非 JSON 输出，直到收到 ready 行。
        }
      };
      lines.on("line", onLine);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`IDE fixture 提前退出：${code ?? "unknown"}`)));
    });
    return { child, url: `ws://127.0.0.1:${port}/t3/ide` };
  } finally {
    lines.close();
  }
};

const stopFixture = async (fixture: FixtureProcess): Promise<void> => {
  if (fixture.child.exitCode !== null) return;
  fixture.child.stdin.write("close\n");
  await new Promise<void>((resolve) => fixture.child.once("exit", () => resolve()));
};

const workspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const capabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const capabilityRegistryLayer = Layer.succeed(
  CapabilityRegistry.CapabilityRegistry,
  capabilityRegistry,
);

const makeTestLayer = (
  registry: CompositionIdeSessionRegistry.CompositionIdeSessionRegistry,
  grantRegistry: CapabilityGrantRegistry.CapabilityGrantRegistryShape,
) => {
  const registryLayer = Layer.succeed(
    CompositionIdeSessionRegistry.CompositionIdeSessionRegistryService,
    registry,
  );
  const grantRegistryLayer = Layer.succeed(
    CapabilityGrantRegistry.CapabilityGrantRegistry,
    grantRegistry,
  );
  const capabilityPolicyLayer = Layer.succeed(
    CapabilityPolicy.CapabilityPolicy,
    CapabilityPolicy.makeCompositionCapabilityPolicy({ capabilityRegistry, grantRegistry }),
  );
  return Layer.mergeAll(
    ToolBroker.layer.pipe(
      Layer.provide(capabilityPolicyLayer),
      Layer.provide(grantRegistryLayer),
      Layer.provide(capabilityRegistryLayer),
      Layer.provide(workspaceFileLayer),
      Layer.provide(registryLayer),
    ),
    capabilityPolicyLayer,
    grantRegistryLayer,
    capabilityRegistryLayer,
    workspaceFileLayer,
    WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
    WorkspacePaths.layer,
    registryLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

describe("Composition IDE -> ToolBroker 本地跨进程 E2E", () => {
  it("通过 capability approval 后由 ToolBroker 调用真实 IDE 子进程", async () =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.promise(startFixture),
        (fixture) =>
          Effect.gen(function* () {
            const registry = CompositionIdeSessionRegistry.makeCompositionIdeSessionRegistry();
            const adapter = makeCompositionIdeJsonRpcAdapter({
              sessionId: "vscode-session-fixture",
              profile: "vscode_ide",
              url: fixture.url,
              headers: { Authorization: "Bearer fixture-ide-token" },
              openTimeoutMs: 5_000,
              requestTimeoutMs: 5_000,
            });
            yield* registry.register(adapter);
            const grantRegistry = CapabilityGrantRegistry.makeCapabilityGrantRegistry({
              capabilityRegistry,
            });
            const [grant] = yield* grantRegistry.issue({
              taskId: "task-toolbroker-1",
              agentId: "agent-toolbroker-1",
              capabilityIds: ["t3.ide.invoke"],
            });
            if (grant === undefined) throw new Error("IDE capability grant 缺少结果");
            const handshake = yield* registry.handshake({
              sessionId: "vscode-session-fixture",
              requestedProfile: "vscode_ide",
              taskId: "task-toolbroker-1",
              runId: "run-toolbroker-1",
              agentId: "agent-toolbroker-1",
              capabilityGrantIds: [grant.grantId],
              requestedOperations: ["editor.read"],
            });
            expect(handshake.status).toBe("accepted");
            if (handshake.handshakeId === undefined) throw new Error("IDE handshake 缺少 ID");

            yield* Effect.gen(function* () {
              const broker = yield* ToolBroker.ToolBroker;
              const input = {
                taskId: "task-toolbroker-1",
                runId: "run-toolbroker-1",
                agentId: "agent-toolbroker-1",
                toolCallId: "tool-call-toolbroker-1",
                canonicalToolName: "ide.invoke",
                arguments: {
                  sessionId: "vscode-session-fixture",
                  handshakeId: handshake.handshakeId,
                  operation: "editor.read",
                  arguments: { uri: "file:///workspace/app.ts" },
                },
                idempotencyKey: "ide-toolbroker-invoke-1",
                capabilityGrantIds: [grant.grantId],
                workspaceRoot: "C:/trusted/workspace",
              };

              const pendingApproval = yield* broker.invoke(input);
              expect(pendingApproval).toMatchObject({
                status: "denied",
                errorCode: "tool_approval_required",
              });
              const approvalRequestId = pendingApproval.approvalRequestId;
              if (approvalRequestId === undefined) throw new Error("IDE approval 缺少 request ID");
              const policy = yield* CapabilityPolicy.CapabilityPolicy;
              yield* policy.approve({ approvalRequestId });

              const result = yield* broker.invoke({ ...input, approvalRequestId });
              expect(result).toMatchObject({
                status: "succeeded",
                result: {
                  contents: "fixture editor response",
                  taskId: "task-toolbroker-1",
                  runId: "run-toolbroker-1",
                },
              });
            }).pipe(Effect.provide(makeTestLayer(registry, grantRegistry)));
            const audit = yield* grantRegistry.listAudit({ taskId: "task-toolbroker-1" });
            expect(audit).toHaveLength(2);
            expect(audit.map((event) => event.grantId)).toEqual([grant.grantId, grant.grantId]);
            expect(audit.map((event) => event.outcome)).toEqual(["approval_required", "allowed"]);
            yield* registry.unregister("vscode-session-fixture");
          }),
        (fixture) => Effect.promise(() => stopFixture(fixture)),
      ),
    ));
});
