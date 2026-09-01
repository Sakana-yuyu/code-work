import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ByokDelegationSnapshot } from "@codework/contracts";
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
import * as CompositionMcpToolRegistry from "./CompositionMcpToolRegistry.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as ByokDelegationService from "../provider/byok/ByokDelegationService.ts";

const previewInvocations: PreviewAutomationBroker.PreviewAutomationInvokeInput[] = [];
const ideInvocations: CompositionIdeSessionRegistry.CompositionIdeInvocation[] = [];
const executedCommands: Array<{ threadId: string; terminalId: string; command: string }> = [];
const killedTerminals: string[] = [];
const closedTerminals: string[] = [];

const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);

const testMcpToolRegistry = CompositionMcpToolRegistry.makeCompositionMcpToolRegistry();
const testCapabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry({
  mcpToolRegistry: testMcpToolRegistry,
});
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
const McpToolRegistryLayer = Layer.succeed(
  CompositionMcpToolRegistry.CompositionMcpToolRegistry,
  testMcpToolRegistry,
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
    runCommand: (input) =>
      Effect.sync(() => {
        executedCommands.push({
          threadId: input.threadId,
          terminalId: input.terminalId,
          command: input.command,
        });
        return {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd,
          worktreePath: null,
          status: "running" as const,
          pid: 456,
          history: "",
          exitCode: null,
          exitSignal: null,
          label: input.command,
          updatedAt: "2026-08-26T00:00:00.000Z",
          sequence: 1,
        };
      }),
    attachStream: (input, listener) =>
      listener({
        type: "snapshot",
        snapshot: {
          threadId: input.threadId,
          terminalId: input.terminalId,
          cwd: input.cwd ?? "C:/trusted/workspace",
          worktreePath: null,
          status: "exited" as const,
          pid: null,
          history: "terminal output",
          exitCode: 0,
          exitSignal: null,
          label: "shell",
          updatedAt: "2026-08-25T00:00:00.000Z",
          sequence: 2,
        },
      }).pipe(Effect.as(() => undefined)),
    close: (input) =>
      Effect.sync(() => {
        closedTerminals.push(`${input.threadId}:${input.terminalId ?? "*"}`);
      }),
    kill: (input) =>
      Effect.sync(() => {
        killedTerminals.push(`${input.threadId}:${input.terminalId}`);
      }),
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
    Layer.provide(McpToolRegistryLayer),
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
  McpToolRegistryLayer,
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
        threadId: "run-1",
        terminalId: "term-agent",
        cwd: "C:/trusted/workspace",
      });
    }),
  );

  it.effect("通过 ToolBroker 读取并关闭任务作用域终端", () =>
    Effect.gen(function* () {
      closedTerminals.length = 0;
      const broker = yield* ToolBroker.ToolBroker;
      const policy = yield* CapabilityPolicy.CapabilityPolicy;
      const snapshot = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "terminal.snapshot",
        arguments: { terminalId: "term-agent" },
        idempotencyKey: "terminal-snapshot-1",
        capabilityGrantIds: ["t3.terminal.snapshot"],
      });
      expect(snapshot).toMatchObject({
        status: "succeeded",
        result: { threadId: "run-1", terminalId: "term-agent", history: "terminal output" },
      });

      const closeInput = {
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "terminal.close",
        arguments: { terminalId: "term-agent" },
        idempotencyKey: "terminal-close-1",
        capabilityGrantIds: ["t3.terminal.close"],
      };
      const approval = yield* broker.invoke(closeInput);
      expect(approval).toMatchObject({ status: "denied", errorCode: "tool_approval_required" });
      yield* policy.approve({ approvalRequestId: approval.approvalRequestId! });
      const closed = yield* broker.invoke({
        ...closeInput,
        ...(approval.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: approval.approvalRequestId }),
      });
      expect(closed).toMatchObject({ status: "succeeded", result: { closed: true } });
      expect(closedTerminals).toEqual(["run-1:term-agent"]);
    }),
  );

  it.effect("按 Run 作用域执行并终止命令进程", () =>
    Effect.gen(function* () {
      executedCommands.length = 0;
      killedTerminals.length = 0;
      const broker = yield* ToolBroker.ToolBroker;
      const policy = yield* CapabilityPolicy.CapabilityPolicy;
      const execInput = {
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "terminal.exec",
        arguments: {
          terminalId: "term-command",
          cwd: "C:/trusted/workspace",
          command: "node",
          args: ["--version"],
        },
        idempotencyKey: "terminal-exec-1",
        capabilityGrantIds: ["t3.terminal.exec"],
      };
      const execApproval = yield* broker.invoke(execInput);
      yield* policy.approve({ approvalRequestId: execApproval.approvalRequestId! });
      const executed = yield* broker.invoke({
        ...execInput,
        ...(execApproval.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: execApproval.approvalRequestId }),
      });
      expect(executed).toMatchObject({ status: "succeeded", result: { status: "running" } });
      expect(executedCommands).toEqual([
        { threadId: "run-1", terminalId: "term-command", command: "node" },
      ]);

      const killInput = {
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "terminal.kill",
        arguments: { terminalId: "term-command" },
        idempotencyKey: "terminal-kill-1",
        capabilityGrantIds: ["t3.terminal.kill"],
      };
      const killApproval = yield* broker.invoke(killInput);
      yield* policy.approve({ approvalRequestId: killApproval.approvalRequestId! });
      const killed = yield* broker.invoke({
        ...killInput,
        ...(killApproval.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: killApproval.approvalRequestId }),
      });
      expect(killed).toMatchObject({ status: "succeeded", result: { killed: true } });
      expect(killedTerminals).toEqual(["run-1:term-command"]);
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

  it.effect("routes browser actions through the same Composition-owned browser session", () =>
    Effect.gen(function* () {
      previewInvocations.length = 0;
      const broker = yield* ToolBroker.ToolBroker;
      const inputs = [
        {
          canonicalToolName: "preview_click",
          arguments: { locator: "role=button[name='Continue']", timeoutMs: 1_000 },
          idempotencyKey: "preview-click-1",
          capabilityGrantIds: ["t3.preview_click"],
        },
        {
          canonicalToolName: "preview_type",
          arguments: {
            tabId: "preview-tab-1",
            locator: "textarea[placeholder='Message']",
            text: "hello",
            clear: true,
            timeoutMs: 1_000,
          },
          idempotencyKey: "preview-type-1",
          capabilityGrantIds: ["t3.preview_type"],
        },
        {
          canonicalToolName: "preview_press",
          arguments: { key: "Enter", modifiers: ["Meta"] },
          idempotencyKey: "preview-press-1",
          capabilityGrantIds: ["t3.preview_press"],
        },
        {
          canonicalToolName: "preview_scroll",
          arguments: { deltaY: 480 },
          idempotencyKey: "preview-scroll-1",
          capabilityGrantIds: ["t3.preview_scroll"],
        },
        {
          canonicalToolName: "preview_evaluate",
          arguments: { expression: "document.title" },
          idempotencyKey: "preview-evaluate-1",
          capabilityGrantIds: ["t3.preview_evaluate"],
        },
        {
          canonicalToolName: "preview_wait_for",
          arguments: { text: "Ready", timeoutMs: 1_000 },
          idempotencyKey: "preview-wait-1",
          capabilityGrantIds: ["t3.preview_wait_for"],
        },
      ] as const;

      for (const input of inputs) {
        const invocation = {
          ...baseInput("C:/trusted/workspace"),
          ...input,
          runtimeId: "multica:daemon-1",
          threadId: "thread-browser-1",
        };
        const initial = yield* broker.invoke(invocation);
        const result =
          initial.status === "denied" && initial.errorCode === "tool_approval_required"
            ? yield* Effect.gen(function* () {
                const policy = yield* CapabilityPolicy.CapabilityPolicy;
                yield* policy.approve({ approvalRequestId: initial.approvalRequestId! });
                return yield* broker.invoke({
                  ...invocation,
                  ...(initial.approvalRequestId === undefined
                    ? {}
                    : { approvalRequestId: initial.approvalRequestId }),
                });
              })
            : initial;
        expect(result.status).toBe("succeeded");
      }

      expect(previewInvocations.map((invocation) => invocation.operation)).toEqual([
        "click",
        "type",
        "press",
        "scroll",
        "evaluate",
        "waitFor",
      ]);
      expect(previewInvocations[0]).toMatchObject({
        operation: "click",
        input: { locator: "role=button[name='Continue']", timeoutMs: 1_000 },
        timeoutMs: 1_000,
      });
      expect(previewInvocations[1]).toMatchObject({
        operation: "type",
        tabId: "preview-tab-1",
        input: {
          locator: "textarea[placeholder='Message']",
          text: "hello",
          clear: true,
          timeoutMs: 1_000,
        },
        timeoutMs: 1_000,
      });
      expect(previewInvocations[2]).toMatchObject({
        operation: "press",
        input: { key: "Enter", modifiers: ["Meta"] },
      });
      expect(previewInvocations[3]).toMatchObject({
        operation: "scroll",
        input: { deltaY: 480 },
      });
      expect(previewInvocations[4]).toMatchObject({
        operation: "evaluate",
        input: { expression: "document.title" },
      });
      expect(previewInvocations[5]).toMatchObject({
        operation: "waitFor",
        input: { text: "Ready", timeoutMs: 1_000 },
        timeoutMs: 1_000,
      });
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
    it.effect("discovers Code Work workspace, MCP and runtime capabilities without secrets", () =>
      Effect.gen(function* () {
        const registry = yield* CapabilityRegistry.CapabilityRegistry;
        const capabilities = yield* registry.list({ scope: "workspace", scopeId: "workspace-1" });

        expect(capabilities.map((capability) => capability.capabilityId)).toEqual([
          "t3.workspace.read_file",
          "t3.workspace.write_file",
          "t3.terminal.open",
          "t3.terminal.write",
          "t3.terminal.exec",
          "t3.terminal.snapshot",
          "t3.terminal.kill",
          "t3.terminal.close",
          "t3.git.status",
          "t3.git.diff",
          "t3.preview_status",
          "t3.preview_open",
          "t3.preview_navigate",
          "t3.preview_snapshot",
          "t3.preview_click",
          "t3.preview_type",
          "t3.preview_press",
          "t3.preview_scroll",
          "t3.preview_evaluate",
          "t3.preview_wait_for",
          "t3.ide.invoke",
          "t3.delegate_task",
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

  it.effect("通过统一 Grant/Policy/Audit 链路调用受信 MCP 工具", () =>
    Effect.gen(function* () {
      const registry = yield* CompositionMcpToolRegistry.CompositionMcpToolRegistry;
      yield* registry.register({
        serverId: "github",
        toolName: "fetch_pr",
        description: "读取 Pull Request",
        inputSchema: { type: "object", properties: { number: { type: "integer" } } },
        operation: "read",
        trusted: true,
        invoke: (input) =>
          Effect.succeed({
            serverId: input.serverId,
            body: "apiKey: must-be-redacted",
            number: (input.arguments as { readonly number: number }).number,
          }),
      });
      const grantRegistry = yield* CapabilityGrantRegistry.CapabilityGrantRegistry;
      const [grant] = yield* grantRegistry.issue({
        taskId: "task-1",
        agentId: "agent-1",
        capabilityIds: ["t3.mcp.github.fetch_pr"],
      });
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "mcp.github.fetch_pr",
        arguments: { number: 42 },
        idempotencyKey: "mcp-fetch-pr-1",
        capabilityGrantIds: [grant!.grantId],
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toEqual({
        serverId: "github",
        body: "apiKey: [REDACTED]",
        number: 42,
      });
      const audit = yield* grantRegistry.listAudit({ taskId: "task-1" });
      expect(audit.at(-1)).toMatchObject({
        capabilityId: "t3.mcp.github.fetch_pr",
        outcome: "allowed",
      });
    }),
  );

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
        idempotencyKey: "ide-invoke-1",
        capabilityGrantIds: ["t3.ide.invoke"],
        ...(result.approvalRequestId === undefined
          ? {}
          : { approvalRequestId: result.approvalRequestId }),
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

const delegationSubmits: Array<{
  instanceId: string;
  task: string;
  subagentType?: string | undefined;
}> = [];
let nextDelegationSnapshot: ByokDelegationSnapshot = {
  id: "delegation-tool-1",
  status: "succeeded",
  taskPreview: "子任务文本",
  resultPreview: "delegated result",
  submittedAt: 1,
};

const FakeByokDelegationLayer = Layer.succeed(ByokDelegationService.ByokDelegationServiceTag, {
  submit: (input) =>
    Effect.sync(() => {
      delegationSubmits.push(input);
      return nextDelegationSnapshot;
    }),
  list: () => Effect.succeed([]),
  cancel: () => Effect.succeed(null),
  cancelCompositionTask: () => Effect.succeed(undefined),
  probeExecutor: () => Effect.succeed(null),
} satisfies ByokDelegationService.ByokDelegationService);

// Replicates TestLayer's ToolBroker wiring but provides the fake delegation
// service INTO the broker layer — merging it alongside would not inject the
// service into an already-constructed broker.
const DelegateTestLayer = Layer.mergeAll(
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer.pipe(Layer.provideMerge(CapabilityGrantLayer))),
    Layer.provideMerge(CapabilityGrantLayer),
    Layer.provide(CapabilityRegistryLayer),
    Layer.provide(McpToolRegistryLayer),
    Layer.provide(WorkspaceFileLayer),
    Layer.provide(ToolTestServicesLayer),
    Layer.provideMerge(FakeByokDelegationLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityGrantLayer,
  CapabilityRegistryLayer,
  WorkspaceFileLayer,
  ToolTestServicesLayer,
  McpToolRegistryLayer,
  ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-composition-delegate-tool-test-",
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(DelegateTestLayer, { excludeTestServices: true })("delegate_task tool", (it) => {
  it.effect("routes delegate_task to the instance delegation service and waits for terminal", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        agentId: "provider:instance-1",
        canonicalToolName: "delegate_task",
        arguments: { task: "子任务文本", subagentType: "explore" },
        idempotencyKey: "delegate-route-1",
        capabilityGrantIds: ["t3.delegate_task"],
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toMatchObject({
        delegationId: "delegation-tool-1",
        delegationStatus: "succeeded",
        result: "delegated result",
      });
      expect(delegationSubmits).toEqual([
        { instanceId: "instance-1", task: "子任务文本", subagentType: "explore" },
      ]);
    }),
  );

  it.effect("carries a failed delegation as a succeeded tool observation", () =>
    Effect.gen(function* () {
      nextDelegationSnapshot = {
        id: "delegation-tool-2",
        status: "failed",
        taskPreview: "failing task",
        errorCode: "EXECUTOR_EXIT",
        errorMessage: "Executor exited with code 3.",
        submittedAt: 2,
      };
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        agentId: "provider:instance-1",
        canonicalToolName: "delegate_task",
        arguments: { task: "failing task" },
        idempotencyKey: "delegate-fail-1",
        capabilityGrantIds: ["t3.delegate_task"],
      });

      expect(result.status).toBe("succeeded");
      expect(result.result).toMatchObject({
        delegationStatus: "failed",
        errorCode: "EXECUTOR_EXIT",
        errorMessage: "Executor exited with code 3.",
      });
    }),
  );

  it.effect("denies delegate_task without a capability grant", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        agentId: "provider:instance-1",
        canonicalToolName: "delegate_task",
        arguments: { task: "子任务文本" },
        idempotencyKey: "delegate-ungranted-1",
        capabilityGrantIds: [],
      });

      expect(result.status).toBe("denied");
    }),
  );

  it.effect("rejects invalid arguments with tool_arguments_invalid", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        agentId: "provider:instance-1",
        canonicalToolName: "delegate_task",
        arguments: {},
        idempotencyKey: "delegate-invalid-1",
        capabilityGrantIds: ["t3.delegate_task"],
      });

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("tool_arguments_invalid");
    }),
  );

  it.effect("rejects delegate_task for agents outside the provider prefix", () =>
    Effect.gen(function* () {
      const broker = yield* ToolBroker.ToolBroker;
      const result = yield* broker.invoke({
        ...baseInput("C:/trusted/workspace"),
        canonicalToolName: "delegate_task",
        arguments: { task: "子任务文本" },
        idempotencyKey: "delegate-scope-1",
        capabilityGrantIds: ["t3.delegate_task"],
      });

      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("tool_scope_missing");
    }),
  );
});
