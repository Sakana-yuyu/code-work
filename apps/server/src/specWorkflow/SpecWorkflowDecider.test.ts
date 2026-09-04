import { ProjectId, ThreadId, type SpecWorkflowLoopConfig } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  SpecWorkflowTransitionError,
  startSpecWorkflow,
  transitionSpecWorkflowState,
} from "./SpecWorkflowDecider.ts";
import { replaySpecWorkflowEvents } from "./SpecWorkflowProjector.ts";

const start = startSpecWorkflow({
  workflowId: "workflow-1",
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  changeName: "native-spec-workflow",
  mode: "full",
  updatedAt: 1,
});

const advance = (state: typeof start.state, to: typeof state.stage, now: number) =>
  transitionSpecWorkflowState(
    state,
    { type: "advance", to, expectedRevision: state.revision },
    now,
  );

const applyEvent = (
  state: typeof start.state,
  event: ReturnType<typeof transitionSpecWorkflowState>,
) => replaySpecWorkflowEvents([{ type: "started", state }, event]);

describe("Spec Workflow state machine and projector", () => {
  it("按 TBD、方案确认、实施、验证和验收门禁推进到归档", () => {
    let state = start.state;
    const events = [start];
    const add = (event: ReturnType<typeof transitionSpecWorkflowState>) => {
      events.push(event);
      state = event.state;
    };

    add(
      transitionSpecWorkflowState(
        state,
        { type: "set-tbd-count", tbdCount: 1, expectedRevision: state.revision },
        2,
      ),
    );
    add(advance(state, "ask", 3));
    add(
      transitionSpecWorkflowState(
        state,
        { type: "set-tbd-count", tbdCount: 0, expectedRevision: state.revision },
        4,
      ),
    );
    add(advance(state, "research", 5));
    add(advance(state, "design", 6));
    add(advance(state, "propose", 7));
    add(advance(state, "awaitingApproval", 8));
    add(
      transitionSpecWorkflowState(
        state,
        { type: "approve-proposal", expectedRevision: state.revision },
        9,
      ),
    );
    add(advance(state, "apply", 10));
    add(
      transitionSpecWorkflowState(
        state,
        { type: "mark-implementation-complete", expectedRevision: state.revision },
        11,
      ),
    );
    add(advance(state, "verify", 12));
    add(
      transitionSpecWorkflowState(
        state,
        { type: "record-verification", passed: true, expectedRevision: state.revision },
        13,
      ),
    );
    add(advance(state, "acceptance", 14));
    add(
      transitionSpecWorkflowState(
        state,
        { type: "complete-acceptance", expectedRevision: state.revision },
        15,
      ),
    );
    add(advance(state, "archive", 16));

    const projected = replaySpecWorkflowEvents(events);
    expect(projected).toEqual(state);
    expect(state.stage).toBe("archive");
    expect(state.status).toBe("completed");
    expect(state.revision).toBe(16);
  });

  it("拒绝越过 TBD、未批准方案、未完成实施和未通过验收的非法跳转", () => {
    let state = start.state;
    const expectRejected = (command: Parameters<typeof transitionSpecWorkflowState>[1]) => {
      expect(() => transitionSpecWorkflowState(state, command, 2)).toThrow();
    };

    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        { type: "set-tbd-count", tbdCount: 2, expectedRevision: state.revision },
        2,
      ),
    )!;
    expectRejected({ type: "advance", to: "propose", expectedRevision: state.revision });
    expectRejected({ type: "advance", to: "design", expectedRevision: state.revision });

    const noTbd = transitionSpecWorkflowState(
      state,
      { type: "set-tbd-count", tbdCount: 0, expectedRevision: state.revision },
      3,
    );
    state = applyEvent(state, noTbd)!;
    state = applyEvent(state, advance(state, "design", 4))!;
    state = applyEvent(state, advance(state, "propose", 5))!;
    state = applyEvent(state, advance(state, "awaitingApproval", 6))!;
    expectRejected({ type: "advance", to: "apply", expectedRevision: state.revision });
    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        { type: "approve-proposal", expectedRevision: state.revision },
        7,
      ),
    )!;
    state = applyEvent(state, advance(state, "apply", 8))!;
    expectRejected({
      type: "advance",
      to: "verify",
      expectedRevision: state.revision,
    });
    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        { type: "mark-implementation-complete", expectedRevision: state.revision },
        9,
      ),
    )!;
    state = applyEvent(state, advance(state, "verify", 10))!;
    expectRejected({ type: "advance", to: "acceptance", expectedRevision: state.revision });
    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        { type: "record-verification", passed: false, expectedRevision: state.revision },
        11,
      ),
    )!;
    state = applyEvent(state, advance(state, "apply", 12))!;
    expect(state.stage).toBe("apply");
  });

  it("暂停期间仍允许已绑定 Task 的终态回写", () => {
    let state = start.state;
    state = applyEvent(state, advance(state, "design", 2))!;
    state = applyEvent(state, advance(state, "propose", 3))!;
    state = applyEvent(state, advance(state, "awaitingApproval", 4))!;
    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        { type: "approve-proposal", expectedRevision: state.revision },
        5,
      ),
    )!;
    state = applyEvent(
      state,
      transitionSpecWorkflowState(
        state,
        {
          type: "advance",
          to: "apply",
          activeTaskId: "task-paused-writeback",
          expectedRevision: state.revision,
        },
        6,
      ),
    )!;
    const paused = applyEvent(
      state,
      transitionSpecWorkflowState(state, { type: "pause", expectedRevision: state.revision }, 7),
    )!;
    const completed = transitionSpecWorkflowState(
      paused,
      {
        type: "record-task-result",
        taskId: "task-paused-writeback",
        status: "completed",
        expectedRevision: paused.revision,
      },
      8,
    );

    expect(completed.state.status).toBe("paused");
    expect(completed.state.activeTaskId).toBeNull();
    expect(completed.state.implementationCompleted).toBe(true);
  });

  it("允许 fix/loop 重试 apply，并在 Loop 终态清除预算配置", () => {
    const apply = {
      ...start.state,
      stage: "apply" as const,
      activeTaskId: null,
      implementationCompleted: false,
    };
    const retry = transitionSpecWorkflowState(
      apply,
      { type: "advance", to: "apply", expectedRevision: apply.revision },
      2,
    );
    expect(retry.state.stage).toBe("apply");
    expect(retry.state.revision).toBe(apply.revision + 1);

    const loopRunning = {
      ...apply,
      revision: retry.state.revision,
      activeTaskId: "spec-workflow:workflow-1:loop:3",
      loopConfig: { maxAttempts: 3 } as SpecWorkflowLoopConfig,
    };
    const cancelled = transitionSpecWorkflowState(
      loopRunning,
      {
        type: "record-task-result",
        taskId: loopRunning.activeTaskId,
        status: "cancelled",
        expectedRevision: loopRunning.revision,
      },
      3,
    );
    expect(cancelled.state.activeTaskId).toBeNull();
    expect(cancelled.state.loopConfig).toBeNull();
    expect(cancelled.state.lastError).toBe("Composition Task 已取消。");
  });

  it("fix 模式从 apply 起步，并可在同一批次累积下一项修复", () => {
    const fixStart = startSpecWorkflow({
      workflowId: "workflow-fix",
      projectId: ProjectId.make("project-fix"),
      threadId: ThreadId.make("thread-fix"),
      changeName: "fixes",
      mode: "fix",
      updatedAt: 1,
    });
    const first = transitionSpecWorkflowState(
      fixStart.state,
      {
        type: "advance",
        to: "apply",
        activeTaskId: "fix-task-1",
        expectedRevision: fixStart.state.revision,
      },
      2,
    );
    const completed = transitionSpecWorkflowState(
      first.state,
      {
        type: "record-task-result",
        taskId: first.state.activeTaskId ?? "missing",
        status: "completed",
        expectedRevision: first.state.revision,
      },
      3,
    );
    const next = transitionSpecWorkflowState(
      completed.state,
      { type: "advance", to: "apply", expectedRevision: completed.state.revision },
      4,
    );

    expect(fixStart.state.stage).toBe("apply");
    expect(completed.state.implementationCompleted).toBe(true);
    expect(next.state.implementationCompleted).toBe(false);
    expect(next.state.verificationStatus).toBe("pending");
  });

  it("projector 拒绝缺少 started 或跳 revision 的事件", () => {
    const changed = advance(start.state, "design", 2);
    expect(() => replaySpecWorkflowEvents([changed])).toThrow(SpecWorkflowTransitionError);
    expect(() =>
      replaySpecWorkflowEvents([start, { ...changed, state: { ...changed.state, revision: 3 } }]),
    ).toThrow(SpecWorkflowTransitionError);
  });
});
