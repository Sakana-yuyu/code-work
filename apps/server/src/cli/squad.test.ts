import type {
  CompositionSquad,
  CompositionSquadExecutionResult,
  CompositionSquadListResult,
  CompositionSquadPlanNode,
  CompositionSquadRevisionListResult,
  CompositionSquadResult,
  CompositionTaskStatus,
} from "@codework/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vite-plus/test";

import type { ControlClientOpen } from "./controlClient.ts";
import {
  formatSquadDetails,
  formatSquadExecutionResult,
  formatSquadList,
  formatSquadRevisions,
  decodeSquadPlanText,
  getSquad,
  listSquadRevisions,
  listSquads,
  runSquad,
} from "./squad.ts";

const squad: CompositionSquad = {
  squadId: "squad-build",
  name: "Build squad",
  leaderAgentId: "agent-lead",
  memberAgentIds: ["agent-lead", "agent-build"],
  instructions: "Build and review",
  createdAtUnixMs: 1_000,
  updatedAtUnixMs: 2_000,
  revision: 3,
  collaborationMode: "review_critic",
  maxConcurrency: 2,
  maxRetries: 1,
  failurePolicy: "continue_independent",
  partialSuccessPolicy: "require_review",
  approvalStages: ["before_finalize"],
  members: [
    {
      agentId: "agent-lead",
      role: "leader",
      order: 0,
      required: true,
      capabilityIds: ["fs.read"],
      maxConcurrentTasks: 1,
    },
    {
      agentId: "agent-build",
      role: "worker",
      order: 1,
      required: true,
      capabilityIds: ["fs.read", "fs.write"],
      maxConcurrentTasks: 1,
    },
  ],
};

const result: CompositionSquadListResult = { squads: [squad] };
const details: CompositionSquadResult = { squad };
const revisions: CompositionSquadRevisionListResult = {
  revisions: [
    {
      squadId: squad.squadId,
      revision: 3,
      configuration: squad,
      createdAtUnixMs: 2_000,
    },
    {
      squadId: squad.squadId,
      revision: 2,
      configuration: null,
      createdAtUnixMs: 1_000,
    },
  ],
};

const task = (taskId: string, status: CompositionTaskStatus) => ({
  taskId,
  projectId: "project-1",
  assigneeKind: "agent" as const,
  assigneeId: "agent-build",
  mode: "parallel" as const,
  status,
  promptDigest: `sha256:${taskId}`,
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 2,
});

const run = (runId: string, status: CompositionTaskStatus) => ({
  runId,
  taskId: runId.replace("run", "task"),
  agentId: "agent-build",
  runtimeId: "runtime-1",
  status,
  attempt: 2,
  capabilityGrantIds: [],
  ...(status === "completed"
    ? { resultSummary: "Implementation completed" }
    : { failureCode: "provider_timeout" }),
});

const plan: ReadonlyArray<CompositionSquadPlanNode> = [
  {
    nodeId: "build",
    agentId: "agent-build",
    prompt: "Implement the change",
    dependsOnNodeIds: [],
  },
];
const planJson =
  '[{"nodeId":"build","agentId":"agent-build","prompt":"Implement the change","dependsOnNodeIds":[]}]';

const executionResult: CompositionSquadExecutionResult = {
  executionId: "execution-1",
  squadId: squad.squadId,
  squadRevision: 3,
  graph: {
    leader: {
      task: {
        ...task("task-leader", "completed"),
        assigneeKind: "squad",
        assigneeId: squad.squadId,
        mode: "review",
      },
      run: {
        ...run("run-leader", "completed"),
        taskId: "task-leader",
        agentId: "agent-lead",
        attempt: 1,
      },
    },
    children: [
      {
        nodeId: "build",
        task: task("task-build", "completed"),
        run: { ...run("run-build", "completed"), taskId: "task-build" },
        attempts: 2,
        dispatches: [],
      },
    ],
    failures: [
      {
        nodeId: "review",
        kind: "failed",
        failureCode: "provider_timeout",
        detail: "Provider did not respond",
        task: task("task-review", "failed"),
        run: { ...run("run-review", "failed"), taskId: "task-review" },
      },
    ],
  },
};

describe("Squad CLI", () => {
  it.effect("通过 typed RPC 查询 Squad，并透传归档过滤", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(result));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          "server.listCompositionSquads": rpc,
        } as never);
      };

      const listed = yield* listSquads(
        {
          serverUrl: "http://127.0.0.1:3773",
          accessToken: "session-token",
          includeArchived: true,
        },
        open,
      );

      expect(listed).toEqual(result);
      expect(connections).toEqual([
        {
          serverUrl: "http://127.0.0.1:3773",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({ includeArchived: true });
    }),
  );

  it("输出稳定的 JSON 或紧凑的人类可读列表", () => {
    expect(formatSquadList(result, true)).toBe(JSON.stringify(result.squads, null, 2));
    expect(formatSquadList(result, false)).toBe(
      "Build squad  squad-build  r3  review_critic  2 members  active",
    );
    expect(formatSquadList({ squads: [] }, false)).toBe("No squads found.");
  });

  it.effect("查询 Squad 详情和不可变修订历史", () =>
    Effect.gen(function* () {
      const getRpc = vi.fn(() => Effect.succeed(details));
      const revisionsRpc = vi.fn(() => Effect.succeed(revisions));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({
          "server.getCompositionSquad": getRpc,
          "server.listCompositionSquadRevisions": revisionsRpc,
        } as never);
      };

      const fetched = yield* getSquad(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          squadId: squad.squadId,
        },
        open,
      );
      const history = yield* listSquadRevisions(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          squadId: squad.squadId,
        },
        open,
      );

      expect(fetched).toEqual(details);
      expect(history).toEqual(revisions);
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(getRpc).toHaveBeenCalledWith({ squadId: "squad-build" });
      expect(revisionsRpc).toHaveBeenCalledWith({ squadId: "squad-build" });
    }),
  );

  it("输出稳定的详情和修订历史", () => {
    expect(formatSquadDetails(details, true)).toBe(JSON.stringify(squad, null, 2));
    expect(formatSquadDetails(details, false)).toBe(
      [
        "Build squad (squad-build)",
        "Revision: 3",
        "Status: active",
        "Mode: review_critic",
        "Leader: agent-lead",
        "Members: 2",
        "Concurrency: 2",
        "Failure policy: continue_independent",
        "Partial success: require_review",
        "Approvals: before_finalize",
        "Instructions: Build and review",
      ].join("\n"),
    );
    expect(formatSquadRevisions(revisions, true)).toBe(
      JSON.stringify(revisions.revisions, null, 2),
    );
    expect(formatSquadRevisions(revisions, false)).toBe(
      [
        "r3  1970-01-01T00:00:02.000Z  Build squad  review_critic",
        "r2  1970-01-01T00:00:01.000Z  configuration unavailable",
      ].join("\n"),
    );
    expect(formatSquadRevisions({ revisions: [] }, false)).toBe("No squad revisions found.");
  });

  it.effect("使用稳定 execution id 发起 Squad 运行", () =>
    Effect.gen(function* () {
      const rpc = vi.fn(() => Effect.succeed(executionResult));
      const connections: Array<Parameters<ControlClientOpen>[0]> = [];
      const open: ControlClientOpen = (connection, use) => {
        connections.push(connection);
        return use({ "server.runCompositionSquad": rpc } as never);
      };

      const result = yield* runSquad(
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
          executionId: "execution-1",
          squadId: squad.squadId,
          squadRevision: 3,
          projectId: "project-1",
          threadId: "thread-1",
          goal: "Implement and review the change",
          workspaceRoot: "E:\\workspace\\project-1",
          workspaceRootDigest: "sha256:workspace",
          plan,
        },
        open,
      );

      expect(result).toEqual(executionResult);
      expect(connections).toEqual([
        {
          serverUrl: "https://codework.example.test",
          accessToken: "session-token",
        },
      ]);
      expect(rpc).toHaveBeenCalledWith({
        executionId: "execution-1",
        squadId: "squad-build",
        squadRevision: 3,
        projectId: "project-1",
        threadId: "thread-1",
        goal: "Implement and review the change",
        workspaceRoot: "E:\\workspace\\project-1",
        workspaceRootDigest: "sha256:workspace",
        plan,
      });
    }),
  );

  it.effect("校验显式 Squad 计划 JSON", () =>
    Effect.gen(function* () {
      expect(yield* decodeSquadPlanText(planJson)).toEqual(plan);
      const error = yield* decodeSquadPlanText('{"nodes":[]}').pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "SquadPlanInputError",
        message: "Squad plan file must contain a JSON array of valid plan nodes.",
      });
    }),
  );

  it("输出稳定的 Squad 运行结果", () => {
    expect(formatSquadExecutionResult(executionResult, true)).toBe(
      JSON.stringify(executionResult, null, 2),
    );
    expect(formatSquadExecutionResult(executionResult, false)).toBe(
      [
        "Execution: execution-1",
        "Squad: squad-build r3",
        "Leader: completed  agent-lead  attempt 1",
        "build: completed  agent-build  attempts 2  Implementation completed",
        "review: failed  provider_timeout  Provider did not respond",
        "Summary: 1 child result, 1 failure",
      ].join("\n"),
    );
  });
});
