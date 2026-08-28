import type { CompositionControlCenterResult } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  projectionAtom: Symbol("projection"),
  redispatchCommand: Symbol("redispatch-command"),
  cancelCommand: Symbol("cancel-command"),
  reviewCommand: Symbol("review-command"),
  abandonCommand: Symbol("abandon-command"),
  byokResumeCommand: Symbol("byok-resume-command"),
  redispatch: vi.fn(),
  cancel: vi.fn(),
  review: vi.fn(),
  abandon: vi.fn(),
  byokResume: vi.fn(),
  projectionQuery: {
    data: null as CompositionControlCenterResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === mocks.projectionAtom) return mocks.projectionQuery;
    return {
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    controlCenterProjection: () => mocks.projectionAtom,
    controlCenterRedispatch: mocks.redispatchCommand,
    cancelCompositionTask: mocks.cancelCommand,
    reviewCompositionTask: mocks.reviewCommand,
    controlCenterAbandon: mocks.abandonCommand,
    controlCenterByokResumeRedispatch: mocks.byokResumeCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.redispatchCommand) return mocks.redispatch;
    if (command === mocks.cancelCommand) return mocks.cancel;
    if (command === mocks.reviewCommand) return mocks.review;
    if (command === mocks.abandonCommand) return mocks.abandon;
    if (command === mocks.byokResumeCommand) return mocks.byokResume;
    return vi.fn();
  },
}));

import {
  CompositionControlCenterPanel,
  buildByokResumeRedispatchInput,
  buildRedispatchInput,
  isByokResumeRedispatchable,
} from "./CompositionControlCenterPanel";

const goalLoop = (
  state: "not_started" | "running" | "converged" | "supervisor_settled" | "interrupted",
) => ({
  runId: `run-${state}`,
  state,
  completedRounds: 3,
  rejectedCompletions: 1,
  terminalStatuses: [],
  settledBySupervisor: state === "supervisor_settled",
});

const byokResume = (options: {
  readonly recoverable?: boolean;
  readonly redispatchSettled?: boolean;
}): NonNullable<CompositionControlCenterResult["tasks"][number]["byokResume"]> => ({
  runId: "run-byok",
  checkpointCount: 2,
  recoveredUtf8Bytes: options.recoverable === false ? 0 : 42,
  recoverable: options.recoverable ?? true,
  redispatchSettled: options.redispatchSettled ?? false,
  ...(options.recoverable === false
    ? { recoveryFailureCode: "byok_checkpoint_recovery_digest_mismatch" }
    : {}),
});

const taskWith = (options: {
  readonly taskId: string;
  readonly taskStatus?: "running" | "in_review" | "failed";
  readonly goalLoopState?: Parameters<typeof goalLoop>[0];
  readonly withLatestRun?: boolean;
  readonly latestRunStatus?: "running" | "failed" | "completed" | "cancelled" | "in_review";
  readonly latestRunFailureCode?: string;
  readonly byokResume?: Parameters<typeof byokResume>[0];
}): CompositionControlCenterResult["tasks"][number] => ({
  taskId: options.taskId,
  status: options.taskStatus ?? "running",
  agentId: "agent-1",
  updatedAtUnixMs: 2,
  dependsOnTaskIds: [],
  latestRun:
    options.withLatestRun === false
      ? undefined
      : {
          runId: `run-${options.taskId}`,
          status: options.latestRunStatus ?? "failed",
          attempt: 2,
          ...(options.latestRunFailureCode === undefined
            ? {}
            : { failureCode: options.latestRunFailureCode }),
        },
  goalLoop: options.goalLoopState === undefined ? undefined : goalLoop(options.goalLoopState),
  ...(options.byokResume === undefined ? {} : { byokResume: byokResume(options.byokResume) }),
});

const projection = (
  tasks: CompositionControlCenterResult["tasks"],
): CompositionControlCenterResult => ({
  generatedAtUnixMs: 1_000,
  tasks,
  squads: [
    {
      squadId: "squad-1",
      name: "控制中心小队",
      leaderAgentId: "agent-1",
      memberAgentIds: ["agent-1", "agent-2"],
    },
  ],
});

describe("CompositionControlCenterPanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: "env-1" };
    mocks.projectionQuery.data = null;
    mocks.projectionQuery.error = null;
    mocks.projectionQuery.isPending = false;
    mocks.projectionQuery.refresh = vi.fn();
    mocks.redispatch = vi.fn();
    mocks.cancel = vi.fn();
    mocks.review = vi.fn();
    mocks.abandon = vi.fn();
    mocks.byokResume = vi.fn();
  });

  it("渲染任务行：状态徽标、Goal Loop 徽标与轮次/拒绝/grant 摘要", () => {
    mocks.projectionQuery.data = projection([
      {
        taskId: "task-running",
        status: "running",
        agentId: "agent-1",
        updatedAtUnixMs: 2,
        dependsOnTaskIds: [],
        latestRun: { runId: "run-1", status: "running", attempt: 1 },
        goalLoop: goalLoop("running"),
        grants: {
          taskId: "task-running",
          totalEvents: 2,
          revokedEvents: 1,
          lastOutcome: "revoked",
          lastOccurredAtUnixMs: 20,
        },
      },
      {
        taskId: "task-queued",
        status: "queued",
        agentId: "agent-2",
        updatedAtUnixMs: 3,
        dependsOnTaskIds: ["task-running"],
      },
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-task-id="task-running"');
    expect(html).toContain('data-task-id="task-queued"');
    expect(html).toContain(">running</");
    expect(html).toContain(">queued</");
    // 活跃任务带轮次与拒绝摘要；无 Run 任务不渲染 goalLoop/grants 区块。
    const runningRow = html.split('data-task-id="task-running"')[1] ?? "";
    expect(runningRow).toContain("3");
    expect(runningRow).toContain("1");
    expect(html).toContain('data-squad-id="squad-1"');
  });

  it("渲染 Squad 名册：名称、队长与成员数", () => {
    mocks.projectionQuery.data = projection([taskWith({ taskId: "task-a" })]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    const squadRow = html.split('data-squad-id="squad-1"')[1] ?? "";
    expect(squadRow).toContain("agent-1");
    expect(squadRow).toContain("2");
  });

  it("仅 interrupted/supervisor_settled 且有最新 Run 的任务行渲染自动重派按钮", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-interrupted", goalLoopState: "interrupted" }),
      taskWith({ taskId: "task-settled", goalLoopState: "supervisor_settled" }),
      taskWith({ taskId: "task-running", goalLoopState: "running" }),
      taskWith({ taskId: "task-converged", goalLoopState: "converged" }),
      taskWith({ taskId: "task-no-run", goalLoopState: "interrupted", withLatestRun: false }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-testid="control-center-redispatch-task-interrupted"');
    expect(html).toContain('data-testid="control-center-redispatch-task-settled"');
    expect(html).not.toContain('data-testid="control-center-redispatch-task-running"');
    expect(html).not.toContain('data-testid="control-center-redispatch-task-converged"');
    // 无最新 Run 时无法确定重派基线，不提供操作入口。
    expect(html).not.toContain('data-testid="control-center-redispatch-task-no-run"');
    // 存在可操作行时渲染 capabilityIds 输入。
    expect(html).toContain("composition-control-center-capability-ids");
  });

  it("无可操作行时不渲染自动重派按钮与 capabilityIds 输入", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-running", goalLoopState: "running" }),
      taskWith({ taskId: "task-no-loop" }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).not.toContain("control-center-redispatch-");
    expect(html).not.toContain("composition-control-center-capability-ids");
  });

  it("仅活跃 Run 的任务行渲染取消按钮，终态与无 Run 行不渲染", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-active", latestRunStatus: "running" }),
      taskWith({ taskId: "task-queued", latestRunStatus: "running", goalLoopState: "running" }),
      taskWith({ taskId: "task-failed", latestRunStatus: "failed" }),
      taskWith({ taskId: "task-done", latestRunStatus: "completed" }),
      taskWith({ taskId: "task-stopped", latestRunStatus: "cancelled" }),
      taskWith({ taskId: "task-no-run", withLatestRun: false }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-testid="control-center-cancel-task-active"');
    expect(html).toContain('data-testid="control-center-cancel-task-queued"');
    expect(html).not.toContain('data-testid="control-center-cancel-task-failed"');
    expect(html).not.toContain('data-testid="control-center-cancel-task-done"');
    expect(html).not.toContain('data-testid="control-center-cancel-task-stopped"');
    expect(html).not.toContain('data-testid="control-center-cancel-task-no-run"');
  });

  it("仅 in_review 任务行渲染通过/驳回按钮，其他状态行不渲染", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-review", taskStatus: "in_review", latestRunStatus: "in_review" }),
      taskWith({ taskId: "task-active", latestRunStatus: "running" }),
      taskWith({ taskId: "task-review-no-run", taskStatus: "in_review", withLatestRun: false }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-testid="control-center-approve-task-review"');
    expect(html).toContain('data-testid="control-center-reject-task-review"');
    expect(html).not.toContain('data-testid="control-center-approve-task-active"');
    expect(html).not.toContain('data-testid="control-center-reject-task-active"');
    expect(html).not.toContain('data-testid="control-center-approve-task-review-no-run"');
    expect(html).not.toContain('data-testid="control-center-reject-task-review-no-run"');
    // in_review 属于活跃 Run 状态，取消入口仍然可用。
    expect(html).toContain('data-testid="control-center-cancel-task-review"');
  });

  it("仅 interrupted 行渲染放弃结算按钮，supervisor_settled 与其他行不渲染", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-interrupted", goalLoopState: "interrupted" }),
      taskWith({ taskId: "task-settled", goalLoopState: "supervisor_settled" }),
      taskWith({ taskId: "task-running", goalLoopState: "running", latestRunStatus: "running" }),
      taskWith({ taskId: "task-no-run", goalLoopState: "interrupted", withLatestRun: false }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-testid="control-center-abandon-task-interrupted"');
    // supervisor_settled 行已有结算行，放弃结算会被服务端拒绝，不提供入口。
    expect(html).not.toContain('data-testid="control-center-abandon-task-settled"');
    expect(html).not.toContain('data-testid="control-center-abandon-task-running"');
    expect(html).not.toContain('data-testid="control-center-abandon-task-no-run"');
    // interrupted 行同时提供自动重派与放弃结算两种收敛选择。
    expect(html).toContain('data-testid="control-center-redispatch-task-interrupted"');
  });

  it("恢复并重派按钮只对 byok_resume_interrupted 或 checkpoint 可恢复的行渲染", () => {
    mocks.projectionQuery.data = projection([
      // 最新 Run 被 BYOK 恢复中断（failureCode 门槛）。
      taskWith({
        taskId: "task-byok-interrupted",
        latestRunFailureCode: "byok_resume_interrupted",
      }),
      // 存在可恢复的 checkpoint 链（投影门槛）。
      taskWith({ taskId: "task-byok-recoverable", byokResume: {} }),
      // checkpoint 链损坏：服务端会零副作用拒绝，不提供入口。
      taskWith({ taskId: "task-byok-corrupt", byokResume: { recoverable: false } }),
      // 已有恢复重派结算行：服务端按 already_settled 拒绝，不提供入口。
      taskWith({ taskId: "task-byok-settled", byokResume: { redispatchSettled: true } }),
      // 已结算的行即使带中断 failureCode 也不提供入口。
      taskWith({
        taskId: "task-byok-settled-code",
        latestRunFailureCode: "byok_resume_interrupted",
        byokResume: { redispatchSettled: true },
      }),
      // 无 BYOK checkpoint 也无中断 failureCode。
      taskWith({ taskId: "task-plain", goalLoopState: "running", latestRunStatus: "running" }),
      // 无最新 Run 时无法确定恢复基线。
      taskWith({ taskId: "task-byok-no-run", withLatestRun: false, byokResume: {} }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).toContain('data-testid="control-center-byok-resume-task-byok-interrupted"');
    expect(html).toContain('data-testid="control-center-byok-resume-task-byok-recoverable"');
    expect(html).not.toContain('data-testid="control-center-byok-resume-task-byok-corrupt"');
    expect(html).not.toContain('data-testid="control-center-byok-resume-task-byok-settled"');
    expect(html).not.toContain('data-testid="control-center-byok-resume-task-byok-settled-code"');
    expect(html).not.toContain('data-testid="control-center-byok-resume-task-plain"');
    expect(html).not.toContain('data-testid="control-center-byok-resume-task-byok-no-run"');
    // 恢复并重派与自动重派共用 capabilityIds 输入，只有 BYOK 行也要渲染它。
    expect(html).toContain("composition-control-center-capability-ids");
    // BYOK 恢复摘要行：段数与恢复字节数/不可恢复提示。
    expect(html).not.toContain("undefined");
  });

  it("无 BYOK 恢复态且无 Goal Loop 可操作行时不渲染 capabilityIds 输入", () => {
    mocks.projectionQuery.data = projection([
      taskWith({ taskId: "task-running", goalLoopState: "running", latestRunStatus: "running" }),
      taskWith({ taskId: "task-byok-corrupt", byokResume: { recoverable: false } }),
    ]);
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).not.toContain("control-center-byok-resume-");
    expect(html).not.toContain("composition-control-center-capability-ids");
  });

  it("isByokResumeRedispatchable 门槛：failureCode 或可恢复 checkpoint，已结算一律拒绝", () => {
    expect(
      isByokResumeRedispatchable(
        taskWith({ taskId: "a", latestRunFailureCode: "byok_resume_interrupted" }),
      ),
    ).toBe(true);
    expect(isByokResumeRedispatchable(taskWith({ taskId: "b", byokResume: {} }))).toBe(true);
    expect(
      isByokResumeRedispatchable(taskWith({ taskId: "c", byokResume: { recoverable: false } })),
    ).toBe(false);
    expect(
      isByokResumeRedispatchable(
        taskWith({ taskId: "d", byokResume: { redispatchSettled: true } }),
      ),
    ).toBe(false);
    expect(isByokResumeRedispatchable(taskWith({ taskId: "e" }))).toBe(false);
    expect(
      isByokResumeRedispatchable(taskWith({ taskId: "f", withLatestRun: false, byokResume: {} })),
    ).toBe(false);
  });

  it("buildByokResumeRedispatchInput 复用 capabilityIds 拆分并带上结算说明", () => {
    expect(
      buildByokResumeRedispatchInput({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        newRunId: "t3-byok-resume-abc",
        capabilityIdsText: " shell.exec , fs.write ,, ",
        note: "恢复说明",
      }),
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      newRunId: "t3-byok-resume-abc",
      capabilityIds: ["shell.exec", "fs.write"],
      note: "恢复说明",
    });
  });

  it("buildRedispatchInput 拆分 capabilityIds 并保留客户端生成的新 RunId", () => {
    expect(
      buildRedispatchInput({
        taskId: "task-1",
        runId: "run-1",
        agentId: "agent-1",
        newRunId: "t3-redispatch-abc",
        capabilityIdsText: " shell.exec , fs.write ,, ",
      }),
    ).toEqual({
      taskId: "task-1",
      runId: "run-1",
      agentId: "agent-1",
      newRunId: "t3-redispatch-abc",
      capabilityIds: ["shell.exec", "fs.write"],
    });
  });

  it("无环境/加载中/错误/空数据四种状态均正常渲染且不输出 undefined", () => {
    mocks.environment = null;
    const noEnv = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(noEnv).not.toContain("data-task-id");
    expect(noEnv).not.toContain("undefined");

    mocks.environment = { environmentId: "env-1" };
    mocks.projectionQuery.isPending = true;
    const pending = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(pending).not.toContain("data-task-id");
    expect(pending).not.toContain("undefined");

    mocks.projectionQuery.isPending = false;
    mocks.projectionQuery.error = "boom";
    const errored = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(errored).not.toContain("data-task-id");
    expect(errored).not.toContain("undefined");

    mocks.projectionQuery.error = null;
    mocks.projectionQuery.data = { generatedAtUnixMs: 1_000, tasks: [], squads: [] };
    const empty = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(empty).not.toContain("data-task-id");
    expect(empty).not.toContain("data-squad-id");
  });

  it("投影为 null 且非 pending 时按空数据处理", () => {
    mocks.projectionQuery.data = null;
    const html = renderToStaticMarkup(<CompositionControlCenterPanel />);
    expect(html).not.toContain("data-task-id");
    expect(html).not.toContain("undefined");
  });
});
