import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as ToolBroker from "./ToolBroker.ts";

const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const CapabilityPolicyLayer = CapabilityPolicy.layer.pipe(Layer.provide(CapabilityRegistry.layer));

const TestLayer = Layer.mergeAll(
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer),
    Layer.provide(CapabilityRegistry.layer),
    Layer.provide(WorkspaceFileLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityRegistry.layer,
  WorkspaceFileLayer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  WorkspacePaths.layer,
  VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer)),
  ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-composition-tool-broker-test-",
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3-composition-tool-broker-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
  yield* fileSystem.writeFileString(absolutePath, contents);
});

const baseInput = (workspaceRoot: string) => ({
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  toolCallId: "tool-call-1",
  canonicalToolName: "workspace.read_file",
  arguments: {
    cwd: workspaceRoot,
    relativePath: "README.md",
  },
  idempotencyKey: "idempotency-1",
  capabilityGrantIds: ["t3.workspace.read_file"],
  workspaceRoot,
});

it.layer(TestLayer, { excludeTestServices: true })("ToolBrokerLive", (it) => {
  describe("CapabilityRegistry", () => {
    it.effect("discovers T3 workspace, MCP and runtime capabilities without secrets", () =>
      Effect.gen(function* () {
        const registry = yield* CapabilityRegistry.CapabilityRegistry;
        const capabilities = yield* registry.list({ scope: "workspace", scopeId: "workspace-1" });

        expect(capabilities.map((capability) => capability.capabilityId)).toEqual([
          "t3.workspace.read_file",
          "t3.workspace.write_file",
          "t3.mcp.preview",
          "t3.runtime.provider",
        ]);
        expect(capabilities.every((capability) => !Object.hasOwn(capability, "apiKey"))).toBe(true);
        expect(
          capabilities.find((capability) => capability.capabilityId === "t3.mcp.preview"),
        ).toMatchObject({
          kind: "mcp",
          source: "t3",
          status: "degraded",
        });
      }),
    );
  });

  describe("workspace tools", () => {
    it.effect("reads through the real workspace path and redacts sensitive values", () =>
      Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "README.md",
          "apiKey: do-not-leak\nAuthorization: Bearer do-not-leak\nhello\n",
        );

        const result = yield* broker.invoke(baseInput(cwd));

        expect(result.status).toBe("succeeded");
        expect(result.result).toMatchObject({
          relativePath: "README.md",
          truncated: false,
        });
        const readResult = result.result as { readonly contents: string };
        expect(readResult.contents).not.toContain("do-not-leak");
        expect(readResult.contents).toContain("[REDACTED]");
      }),
    );

    it.effect("requires approval before writing and writes only after approval", () =>
      Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const policy = yield* CapabilityPolicy.CapabilityPolicy;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const input = {
          ...baseInput(cwd),
          canonicalToolName: "workspace.write_file",
          arguments: {
            cwd,
            relativePath: "generated/output.txt",
            contents: "approved write",
          },
          idempotencyKey: "idempotency-write-1",
          capabilityGrantIds: ["t3.workspace.write_file"],
        };

        const approval = yield* broker.invoke(input);
        expect(approval).toMatchObject({
          status: "denied",
          errorCode: "tool_approval_required",
        });
        expect(approval.approvalRequestId).toBeDefined();
        expect(yield* fileSystem.exists(path.join(cwd, "generated/output.txt"))).toBe(false);

        yield* policy.approve({ approvalRequestId: approval.approvalRequestId! });
        const written = yield* broker.invoke({
          ...input,
          ...(approval.approvalRequestId ? { approvalRequestId: approval.approvalRequestId } : {}),
        });

        expect(written.status).toBe("succeeded");
        expect(yield* fileSystem.readFileString(path.join(cwd, "generated/output.txt"))).toBe(
          "approved write",
        );
      }),
    );

    it.effect("denies missing grants, rejects duplicate effects and honors cancellation", () =>
      Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "stable\n");

        const denied = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "idempotency-denied",
          capabilityGrantIds: [],
        });
        expect(denied).toMatchObject({
          status: "denied",
          errorCode: "capability_not_granted",
        });

        const first = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "idempotency-success",
        });
        expect(first.status).toBe("succeeded");
        const duplicate = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "idempotency-success",
        });
        expect(duplicate).toMatchObject({
          status: "denied",
          errorCode: "tool_duplicate_invocation",
        });

        yield* broker.cancel({ idempotencyKey: "idempotency-cancelled" });
        const cancelled = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "idempotency-cancelled",
        });
        expect(cancelled).toMatchObject({
          status: "cancelled",
          errorCode: "tool_cancelled",
        });
      }),
    );
  });
});
