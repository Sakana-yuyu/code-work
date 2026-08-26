import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as CompositionIdeSessionRegistry from "./CompositionIdeSessionRegistry.ts";
import * as ToolBroker from "./ToolBroker.ts";

const previewInvocations: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
const ideInvocations: CompositionIdeSessionRegistry.CompositionIdeInvocation[] = [];

const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const testCapabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const CapabilityRegistryLayer = Layer.succeed(
  CapabilityRegistry.CapabilityRegistry,
  testCapabilityRegistry,
);
const testCapabilityGrantRegistry = CapabilityGrantRegistry.makeCapabilityGrantRegistry({
  capabilityRegistry: testCapabilityRegistry,
});
const CapabilityGrantLayer = Layer.succeed(
  CapabilityGrantRegistry.CapabilityGrantRegistry,
  testCapabilityGrantRegistry,
);
const CapabilityPolicyLayer = CapabilityPolicy.layer.pipe(
  Layer.provideMerge(CapabilityGrantLayer),
  Layer.provide(CapabilityRegistryLayer),
);

const ToolTestServicesLayer = Layer.mergeAll(
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-composition-test")),
    getDescriptor: Effect.die("unused"),
  }),
  Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
    connect: () => Effect.die("unused"),
    focusHost: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
    invoke: <A = unknown>(request: PreviewAutomationBroker.PreviewAutomationInvokeInput) => {
      previewInvocations.push(request);
      return Effect.succeed({
        available: true,
        visible: true,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      } as A);
    },
  }),
  Layer.mock(CompositionIdeSessionRegistry.CompositionIdeSessionRegistryService)({
    register: () => Effect.void,
    unregister: () => Effect.succeed(false),
    get: () => Effect.succeed(undefined),
    list: Effect.succeed([]),
    resolve: (input) =>
      Effect.succeed({
        sessionId: input.sessionId,
        profile: "unknown" as const,
        verifiedOperations: [],
        status: "unavailable" as const,
      }),
    handshake: (input) =>
      Effect.succeed({
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        agentId: input.agentId,
        profile: "vscode_ide" as const,
        status: "accepted" as const,
        acceptedGrantIds: [...input.capabilityGrantIds],
        verifiedOperations: [...input.requestedOperations],
        handshakeId: "ide-handshake-test",
      }),
    invoke: (input) => {
      ideInvocations.push(input);
      return Effect.succeed({ accepted: true, operation: input.operation });
    },
  }),
  Layer.mock(TerminalManager.TerminalManager)({
    open: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: null,
        status: "running" as const,
        pid: 123,
        history: "ready",
        exitCode: null,
        exitSignal: null,
        label: "shell",
        updatedAt: "2026-08-25T00:00:00.000Z",
        sequence: 1,
      }),
    write: () => Effect.void,
  }),
  Layer.mock(GitVcsDriver.GitVcsDriver)({
    statusDetailsLocal: (cwd) =>
      Effect.succeed({
        isRepo: true,
        hasOriginRemote: false,
        isDefaultBranch: true,
        branch: "main",
        upstreamRef: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        observedCwd: cwd,
      }),
  }),
);

const TestLayer = Layer.mergeAll(
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer.pipe(Layer.provideMerge(CapabilityGrantLayer))),
    Layer.provideMerge(CapabilityGrantLayer),
    Layer.provide(CapabilityRegistryLayer),
    Layer.provide(WorkspaceFileLayer),
    Layer.provide(ToolTestServicesLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityGrantLayer,
  CapabilityRegistryLayer,
  WorkspaceFileLayer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  WorkspacePaths.layer,
  ToolTestServicesLayer,
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

it.layer(TestLayer, { excludeTestServices: true })("shared canonical tools", (it) => {
  it.effect("routes terminal.open through the task-scoped terminal session", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const policy = yield* CapabilityPolicy.CapabilityPolicy;
      const input = {
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "terminal.open",
        arguments: {
          terminalId: "term-agent",
          cwd: "C:/trusted/workspace",
          cols: 80,
          rows: 24,
        },
        idempotencyKey: "terminal-open-1",
        capabilityGrantIds: ["t3.terminal.open"],
      };

      const approval = yield* broker.invoke(input);
      expect(approval).toMatchObject({ status: "denied", errorCode: "tool_approval_required" });
      yield* policy.approve({ approvalRequestId: approval.approvalRequestId! });
      const result = yield* broker.invoke({
        ...input,
        ...(approval.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: approval.approvalRequestId }),
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toMatchObject({
        threadId: "task-1",
        terminalId: "term-agent",
        cwd: "C:/trusted/workspace",
      });
    }),
  );

  it.effect("routes git.status through the trusted workspace root", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "git.status",
        arguments: { cwd: "C:/trusted/workspace" },
        idempotencyKey: "git-status-1",
        capabilityGrantIds: ["t3.git.status"],
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toMatchObject({
        isRepo: true,
        observedCwd: "C:/trusted/workspace",
      });
    }),
  );

  it.effect("routes preview.status through a Composition-owned browser session", () =>
    Effect.gen(function* () {
      previewInvocations.length = 0;
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "preview_status",
        arguments: {},
        idempotencyKey: "preview-status-1",
        capabilityGrantIds: ["t3.preview_status"],
        runtimeId: "multica:daemon-1",
        threadId: "thread-browser-1",
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toMatchObject({ available: true });
      expect(previewInvocations).toHaveLength(1);
      expect(previewInvocations[0]?.scope.sessionId).toBe("composition-browser:task-1:run-1");
      expect(previewInvocations[0]?.scope.providerSessionId).toBeUndefined();
      expect(previewInvocations[0]?.scope.threadId).toBe("thread-browser-1");
    }),
  );

  it.effect("缺少 runtime scope 时明确拒绝 preview 调用", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "preview_status",
        arguments: {},
        idempotencyKey: "preview-status-missing-scope",
        capabilityGrantIds: ["t3.preview_status"],
      });

      expect(result).toMatchObject({
        status: "failed",
        errorCode: "tool_scope_missing",
      });
    }),
  );
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
          "t3.terminal.open",
          "t3.terminal.write",
          "t3.git.status",
          "t3.git.diff",
          "t3.preview_status",
          "t3.preview_open",
          "t3.preview_navigate",
          "t3.preview_snapshot",
          "t3.ide.invoke",
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

    it.effect("validates task-scoped grants and audits revoked calls", () =>
      Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const grantRegistry = yield* CapabilityGrantRegistry.CapabilityGrantRegistry;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "README.md", "stable\n");
        const [grant] = yield* grantRegistry.issue({
          taskId: "task-1",
          agentId: "agent-1",
          capabilityIds: ["t3.workspace.read_file"],
        });

        const allowed = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "grant-invocation-1",
          capabilityGrantIds: [grant!.grantId],
        });
        expect(allowed.status).toBe("succeeded");

        yield* grantRegistry.revoke({ grantId: grant!.grantId });
        const denied = yield* broker.invoke({
          ...baseInput(cwd),
          idempotencyKey: "grant-invocation-2",
          capabilityGrantIds: [grant!.grantId],
        });
        expect(denied).toMatchObject({ status: "denied", errorCode: "capability_not_granted" });

        const audit = yield* grantRegistry.listAudit({ taskId: "task-1" });
        const grantAudit = audit.filter((event) => event.grantId === grant!.grantId);
        expect(grantAudit.map((event) => event.outcome)).toEqual(["allowed", "denied"]);
        expect(grantAudit.every((event) => !(event as Record<string, unknown>).arguments)).toBe(
          true,
        );
      }),
    );
  });

  it.effect("routes ide.invoke through the verified IDE session registry", () =>
    Effect.gen(function* () {
      ideInvocations.length = 0;
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "ide.invoke",
        arguments: {
          sessionId: "vscode-session-1",
          handshakeId: "ide-handshake-test",
          operation: "editor.read",
          arguments: { path: "src/App.tsx" },
        },
        idempotencyKey: "ide-invoke-1",
        capabilityGrantIds: ["t3.ide.invoke"],
      });

      expect(result).toMatchObject({ status: "denied", errorCode: "tool_approval_required" });
      const policy = yield* CapabilityPolicy.CapabilityPolicy;
      yield* policy.approve({ approvalRequestId: result.approvalRequestId! });
      const approved = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "ide.invoke",
        arguments: {
          sessionId: "vscode-session-1",
          handshakeId: "ide-handshake-test",
          operation: "editor.read",
          arguments: { path: "src/App.tsx" },
        },
        idempotencyKey: "ide-invoke-1-approved",
        capabilityGrantIds: ["t3.ide.invoke"],
        approvalRequestId: result.approvalRequestId,
      });

      expect(approved.status).toBe("succeeded");
      expect(approved.result).toMatchObject({ accepted: true, operation: "editor.read" });
      expect(ideInvocations).toHaveLength(1);
      expect(ideInvocations[0]).toMatchObject({
        sessionId: "vscode-session-1",
        handshakeId: "ide-handshake-test",
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
      });
    }),
  );
});
