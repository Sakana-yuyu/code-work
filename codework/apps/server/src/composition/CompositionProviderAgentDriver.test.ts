import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  EventId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
} from "@codework/contracts";

import { ProviderValidationError } from "../provider/Errors.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";
import type { CompositionRuntimeToolBridgeShape } from "./CompositionRuntimeToolBridge.ts";

const unusedRuntimeToolBridge = {
  invoke: () => Effect.die("测试不应调用 Runtime Tool Bridge"),
  cancel: () => Effect.die("测试不应取消 Runtime Tool Bridge"),
} satisfies CompositionRuntimeToolBridgeShape;

const makeAdapter = (options?: { readonly failTurn?: boolean }) => {
  const calls: string[] = [];
  const sessionInputs: ProviderSessionStartInput[] = [];
  const session = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex-local"),
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make("composition-thread-1"),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ProviderSession;

  return {
    calls,
    adapter: {
      startSession: (input: ProviderSessionStartInput) => {
        sessionInputs.push(input);
        calls.push(`start:${input.threadId}`);
        return Effect.succeed(session);
      },
      sendTurn: (
        input: ProviderSendTurnInput,
      ): Effect.Effect<ProviderTurnStartResult, ProviderValidationError> => {
        calls.push(`send:${input.threadId}:${input.input ?? ""}`);
        if (options?.failTurn === true) {
          return Effect.fail(
            new ProviderValidationError({ operation: "sendTurn", issue: "测试失败" }),
          );
        }
        return Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("turn-1") });
      },
      interruptTurn: (threadId: ThreadId, turnId?: TurnId) => {
        calls.push(`interrupt:${threadId}:${turnId ?? ""}`);
        return Effect.void;
      },
      stopSession: (threadId: ThreadId) => {
        calls.push(`stop:${threadId}`);
        return Effect.void;
      },
    },
    sessionInputs,
  };
};

describe("CompositionProviderAgentDriver", () => {
  it("starts a provider session and sends the transient task prompt", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-1",
            projectId: "project-1",
            threadId: "thread-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:prompt",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-1",
            taskId: "task-1",
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
          prompt: "检查工作区",
          workspaceRoot: "C:/workspace",
        }),
      ),
    ).resolves.toMatchObject({ runtimeTaskId: "codex-local:thread-1:turn-1" });
    expect(fake.calls).toEqual(["start:thread-1", "send:thread-1:检查工作区"]);

    const binding = driver.resolveRuntimeEvent?.({
      eventId: EventId.make("event-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      threadId: ThreadId.make("thread-1"),
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-25T00:00:00.000Z",
      type: "turn.completed",
      payload: { state: "completed" },
    } satisfies ProviderRuntimeEvent);
    expect(binding).toEqual({
      taskId: "task-1",
      runId: "run-1",
      runtimeTaskId: "codex-local:thread-1:turn-1",
    });
  });

  it("清理活动 Provider Run 后仍能解析带 turnId 的迟到事件", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });
    const task = {
      taskId: "task-late-provider",
      projectId: "project-1",
      threadId: "thread-late-provider",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:late-provider",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-late-provider",
      taskId: task.taskId,
      agentId: "agent-codex",
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };
    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "检查", workspaceRoot: "C:/workspace" }),
    );
    await Effect.runPromise(driver.revokeCapabilityHandshake!({ task, run }));

    expect(
      driver.resolveRuntimeEvent?.({
        eventId: EventId.make("event-late-provider"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-local"),
        threadId: ThreadId.make("thread-late-provider"),
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-08-26T00:00:00.000Z",
        type: "turn.completed",
        payload: { state: "completed" },
      } satisfies ProviderRuntimeEvent),
    ).toEqual({
      taskId: task.taskId,
      runId: run.runId,
      runtimeTaskId: "codex-local:thread-late-provider:turn-1",
    });
  });

  it("Provider 没有 capability handshake 时拒绝带 grant 的任务", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-grant",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:grant",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-grant",
            taskId: "task-grant",
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-1"],
          },
          prompt: "检查工作区",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_capability_handshake_unsupported" });
    expect(fake.sessionInputs).toHaveLength(0);
  });

  it("把已接受的 Provider capability handshake ID 传入 Session", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-1",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
      },
    });

    const started = await Effect.runPromise(
      driver.startTask({
        task: {
          taskId: "task-provider-grant",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: "agent-codex",
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:provider-grant",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-provider-grant",
          taskId: "task-provider-grant",
          agentId: "agent-codex",
          runtimeId: "codex-local",
          status: "queued",
          attempt: 1,
          capabilityGrantIds: ["grant-provider-1"],
        },
        prompt: "检查工作区",
      }),
    );

    expect(started.capabilityHandshakeId).toBe("provider-handshake-1");
    expect(fake.sessionInputs[0]).toMatchObject({
      runtimeMode: "full-access",
      capabilityHandshakeId: "provider-handshake-1",
    });
  });

  it.each([
    ["错绑 runtime", { runtimeId: "other-runtime" }],
    ["错绑 task", { taskId: "other-task" }],
    ["错绑 run", { runId: "other-run" }],
    ["错绑 agent", { agentId: "other-agent" }],
    ["额外 grant", { acceptedGrantIds: ["grant-provider-1", "grant-extra"] }],
    ["重复 grant", { acceptedGrantIds: ["grant-provider-1", "grant-provider-1"] }],
    ["已过期", { expiresAtUnixMs: 1 }],
  ])("拒绝%s的 capability handshake", async (_label, override) => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-invalid",
            acceptedGrantIds: [...input.capabilityGrantIds],
            ...override,
          }),
      },
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-provider-grant",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:provider-grant",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-provider-grant",
            taskId: "task-provider-grant",
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-provider-1"],
          },
          prompt: "检查工作区",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_capability_handshake_rejected" });
    expect(fake.sessionInputs).toHaveLength(0);
  });

  it("interrupts the provider turn when the composition task is cancelled", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });
    const task = {
      taskId: "task-1",
      projectId: "project-1",
      threadId: "thread-1",
      assigneeKind: "agent" as const,
      assigneeId: "agent-codex",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:prompt",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-codex",
      runtimeId: "codex-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: [],
    };

    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "继续", workspaceRoot: "C:/workspace" }),
    );
    await expect(
      Effect.runPromise(driver.cancelTask({ task, run, reason: "用户取消" })),
    ).resolves.toEqual({ status: "cancelled" });
    expect(fake.calls).toContain("interrupt:thread-1:turn-1");
  });

  it("stops the provider session when starting the turn fails", async () => {
    const fake = makeAdapter({ failTurn: true });
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-codex",
      runtimeId: "codex-local",
      providerInstanceId: ProviderInstanceId.make("codex-local"),
      adapter: fake.adapter,
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-1",
            projectId: "project-1",
            threadId: "thread-1",
            assigneeKind: "agent",
            assigneeId: "agent-codex",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:prompt",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-1",
            taskId: "task-1",
            agentId: "agent-codex",
            runtimeId: "codex-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: [],
          },
          prompt: "失败测试",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "CompositionAgentDriverFailure",
      code: "provider_turn_start_failed",
    });
    expect(fake.calls).toEqual(["start:thread-1", "send:thread-1:失败测试", "stop:thread-1"]);
  });

  it("只在可信 ToolBroker 和 handshake 都可用时投影真实工具能力", async () => {
    const fake = makeAdapter();
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: [
        "workspace.read_file",
        "terminal.open",
        "git.status",
        "mcp.example.search",
        "ide.invoke",
      ],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-profile",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: () => Effect.void,
        configureToolBroker: () => Effect.void,
        clearToolBroker: () => Effect.void,
      },
    });

    await expect(Effect.runPromise(driver.getProfile!())).resolves.toMatchObject({
      status: "available",
      supportsToolBroker: true,
      supportsCapabilityHandshake: true,
      supportsWorkspace: true,
      supportsTerminal: true,
      supportsGit: true,
      supportsMcp: true,
      supportsIde: true,
      supportsProviderApi: true,
    });
    const profile = await Effect.runPromise(driver.getProfile!());
    expect(profile.reasonCode).toBeUndefined();
    expect(profile.capabilities).toEqual(
      expect.arrayContaining([
        "t3.toolbroker",
        "t3.workspace",
        "t3.terminal",
        "t3.git",
        "t3.mcp",
        "t3.ide",
        "t3.provider_api",
      ]),
    );
  });

  it("ToolBroker 缺少 workspace 时撤销已接受的 handshake", async () => {
    const fake = makeAdapter();
    const calls: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-missing-workspace",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => calls.push(`revoke:${handshakeId}`)),
        configureToolBroker: () => Effect.void,
        clearToolBroker: () => Effect.void,
      },
    });

    await expect(
      Effect.runPromise(
        driver.startTask({
          task: {
            taskId: "task-missing-workspace",
            projectId: "project-1",
            assigneeKind: "agent",
            assigneeId: "agent-cursor",
            mode: "serial",
            status: "queued",
            promptDigest: "sha256:missing-workspace",
            dependsOnTaskIds: [],
            createdAtUnixMs: 1,
            updatedAtUnixMs: 1,
          },
          run: {
            runId: "run-missing-workspace",
            taskId: "task-missing-workspace",
            agentId: "agent-cursor",
            runtimeId: "provider:cursor-local",
            status: "queued",
            attempt: 1,
            capabilityGrantIds: ["grant-workspace"],
          },
          prompt: "读取文件",
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_toolbroker_context_missing" });
    expect(calls).toEqual(["revoke:provider-handshake-missing-workspace"]);
  });

  it("取消中断失败时仍停止会话并清理 ToolBroker 与 handshake", async () => {
    const fake = makeAdapter();
    const cleanupCalls: string[] = [];
    const driver = makeCompositionProviderAgentDriver({
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      providerInstanceId: ProviderInstanceId.make("cursor-local"),
      toolBrokerBridge: unusedRuntimeToolBridge,
      toolBrokerCanonicalTools: ["workspace.read_file"],
      adapter: {
        ...fake.adapter,
        handshakeCapabilities: (input) =>
          Effect.succeed({
            ...input,
            status: "accepted" as const,
            handshakeId: "provider-handshake-cancel",
            acceptedGrantIds: [...input.capabilityGrantIds],
          }),
        revokeCapabilityHandshake: ({ handshakeId }) =>
          Effect.sync(() => cleanupCalls.push(`revoke:${handshakeId}`)),
        configureToolBroker: ({ threadId }) =>
          Effect.sync(() => cleanupCalls.push(`configure:${threadId}`)),
        clearToolBroker: (threadId) => Effect.sync(() => cleanupCalls.push(`clear:${threadId}`)),
        interruptTurn: () =>
          Effect.fail(
            new ProviderValidationError({ operation: "interruptTurn", issue: "测试中断失败" }),
          ),
        stopSession: (threadId) => Effect.sync(() => cleanupCalls.push(`stop:${threadId}`)),
      },
    });
    const task = {
      taskId: "task-cancel-cleanup",
      projectId: "project-1",
      threadId: "thread-cancel-cleanup",
      assigneeKind: "agent" as const,
      assigneeId: "agent-cursor",
      mode: "serial" as const,
      status: "queued" as const,
      promptDigest: "sha256:cancel-cleanup",
      dependsOnTaskIds: [],
      createdAtUnixMs: 1,
      updatedAtUnixMs: 1,
    };
    const run = {
      runId: "run-cancel-cleanup",
      taskId: task.taskId,
      agentId: "agent-cursor",
      runtimeId: "provider:cursor-local",
      status: "queued" as const,
      attempt: 1,
      capabilityGrantIds: ["grant-workspace"],
    };

    await Effect.runPromise(
      driver.startTask({ task, run, prompt: "读取文件", workspaceRoot: "C:/workspace" }),
    );
    await expect(
      Effect.runPromise(driver.cancelTask({ task, run, reason: "用户取消" })),
    ).rejects.toMatchObject({ code: "provider_turn_cancel_failed" });
    expect(cleanupCalls).toEqual([
      "configure:thread-cancel-cleanup",
      "stop:thread-cancel-cleanup",
      "clear:thread-cancel-cleanup",
      "revoke:provider-handshake-cancel",
    ]);
  });
});
