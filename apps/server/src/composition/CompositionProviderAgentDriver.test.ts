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
} from "@t3tools/contracts";

import { ProviderValidationError } from "../provider/Errors.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";

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
});
