import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import { formatAgentRunResult } from "./agentControlRunOutput.ts";
import { AgentRunRejectedError, runAgent } from "./agentControlRunRpc.ts";
import { planAgentRunCommand } from "./agentControlRunState.ts";

const project = (
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: ProjectId.make("project-1"),
  title: "Code Work",
  workspaceRoot: "C:/repo",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex-work"),
    model: "gpt-5.6",
  },
  defaultThreadEnvMode: "local",
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  ...overrides,
});

const shellSnapshot = (
  projects: ReadonlyArray<OrchestrationProjectShell> = [project()],
): OrchestrationShellSnapshot => ({
  snapshotSequence: 11,
  projects,
  threads: [],
  updatedAt: "2026-08-30T00:00:00.000Z",
});

const identity = {
  threadId: ThreadId.make("thread-run-1"),
  commandId: CommandId.make("command-run-1"),
  messageId: MessageId.make("message-run-1"),
  createdAt: "2026-08-30T01:00:00.000Z",
};

describe("Agent run CLI", () => {
  it("纯规划使用项目默认模型并生成原子建线程命令", () => {
    const plan = planAgentRunCommand(
      shellSnapshot().projects,
      {
        projectId: "project-1",
        prompt: "  审计 CLI 控制能力  ",
      },
      identity,
    );

    expect(plan).toEqual({
      ok: true,
      command: {
        type: "thread.turn.start",
        commandId: "command-run-1",
        threadId: "thread-run-1",
        message: {
          messageId: "message-run-1",
          role: "user",
          text: "审计 CLI 控制能力",
          attachments: [],
        },
        modelSelection: {
          instanceId: "codex-work",
          model: "gpt-5.6",
        },
        titleSeed: "审计 CLI 控制能力",
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: "project-1",
            title: "审计 CLI 控制能力",
            modelSelection: {
              instanceId: "codex-work",
              model: "gpt-5.6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-08-30T01:00:00.000Z",
          },
        },
        createdAt: "2026-08-30T01:00:00.000Z",
      },
      modelSelection: {
        instanceId: "codex-work",
        model: "gpt-5.6",
      },
      projectId: "project-1",
    });
  });

  it("纯规划允许成对覆盖 provider 和 model", () => {
    const plan = planAgentRunCommand(
      shellSnapshot().projects,
      {
        projectId: "project-1",
        prompt: "使用指定模型",
        providerInstanceId: ProviderInstanceId.make("claude-team"),
        model: "claude-opus-4-1",
      },
      identity,
    );

    expect(plan).toMatchObject({
      ok: true,
      modelSelection: {
        instanceId: "claude-team",
        model: "claude-opus-4-1",
      },
      command: {
        modelSelection: {
          instanceId: "claude-team",
          model: "claude-opus-4-1",
        },
      },
    });
  });

  it("纯规划拒绝不成对参数、未知项目、缺少默认模型和空 prompt", () => {
    expect(
      planAgentRunCommand(
        shellSnapshot().projects,
        {
          projectId: "project-1",
          prompt: "开始",
          providerInstanceId: ProviderInstanceId.make("codex-work"),
        },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "provider-model-pair" });
    expect(
      planAgentRunCommand(
        shellSnapshot().projects,
        { projectId: "project-1", prompt: "开始", model: "gpt-5.6" },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "provider-model-pair" });
    expect(
      planAgentRunCommand(
        shellSnapshot().projects,
        {
          projectId: "project-1",
          prompt: "开始",
          providerInstanceId: ProviderInstanceId.make("codex-work"),
          model: "   ",
        },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "invalid-model" });
    expect(
      planAgentRunCommand(
        shellSnapshot().projects,
        { projectId: "missing-project", prompt: "开始" },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "project-not-found" });
    expect(
      planAgentRunCommand(
        shellSnapshot([project({ defaultModelSelection: null })]).projects,
        { projectId: "project-1", prompt: "开始" },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "model-unavailable" });
    expect(
      planAgentRunCommand(
        shellSnapshot().projects,
        { projectId: "project-1", prompt: "   " },
        identity,
      ),
    ).toMatchObject({ ok: false, reason: "invalid-prompt" });
  });

  it.effect("读取权威项目快照后原子创建 Agent，并返回结构化 receipt", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn(() => Effect.succeed({ sequence: 42 }));
      const subscribeShell = vi.fn(() =>
        Stream.fromIterable([
          {
            kind: "snapshot" as const,
            snapshot: shellSnapshot(),
          },
          { kind: "synchronized" as const },
        ]),
      );
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          [ORCHESTRATION_WS_METHODS.subscribeShell]: subscribeShell,
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: dispatch,
        } as never);
      };

      const result = yield* runAgent(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          projectId: "project-1",
          prompt: "启动 Agent",
        },
        open,
        () => Effect.succeed(identity),
      );

      expect(subscribeShell).toHaveBeenCalledWith({ requestCompletionMarker: true });
      expect(dispatch).toHaveBeenCalledOnce();
      expect(result).toEqual({
        agentId: "thread-run-1",
        projectId: "project-1",
        commandId: "command-run-1",
        messageId: "message-run-1",
        sequence: 42,
        providerInstanceId: "codex-work",
        model: "gpt-5.6",
        createdAt: "2026-08-30T01:00:00.000Z",
      });
      expect(connections).toEqual([
        { serverUrl: "https://codework.example.test", accessToken: "session-token" },
      ]);
    }),
  );

  it.effect("RPC 将纯规划拒绝映射为稳定 TaggedError", () =>
    Effect.gen(function* () {
      let openCalls = 0;
      const open: ControlClientOpen = () => {
        openCalls += 1;
        return Effect.die("参数错误不应打开 RPC");
      };

      const error = yield* runAgent(
        {
          serverUrl: "http://127.0.0.1:3773",
          projectId: "project-1",
          prompt: "开始",
          providerInstanceId: ProviderInstanceId.make("codex-work"),
        },
        open,
        () => Effect.succeed(identity),
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AgentRunRejectedError);
      expect(error).toMatchObject({
        _tag: "AgentRunRejectedError",
        reason: "provider-model-pair",
        projectId: "project-1",
      });
      expect(openCalls).toBe(0);
    }),
  );

  it("文本和 JSON 输出都保留模型与追踪标识", () => {
    const result = {
      agentId: "thread-run-1",
      projectId: "project-1",
      commandId: "command-run-1",
      messageId: "message-run-1",
      sequence: 42,
      providerInstanceId: "codex-work",
      model: "gpt-5.6",
      createdAt: "2026-08-30T01:00:00.000Z",
    };

    expect(formatAgentRunResult(result, false)).toContain("Agent: thread-run-1");
    expect(formatAgentRunResult(result, false)).toContain("Model: codex-work / gpt-5.6");
    expect(formatAgentRunResult(result, true)).toBe(JSON.stringify(result, null, 2));
  });
});
