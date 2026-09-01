import type { TerminalSessionSnapshot } from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";

import { assessWorkspaceScriptStopRecovery } from "./WorkspaceScriptStopRecoveryState.ts";

const snapshot = (overrides: Partial<TerminalSessionSnapshot> = {}): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId: "workspace-script-operation-1",
  cwd: "E:/workspace/project-1",
  worktreePath: null,
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "pnpm dev",
  updatedAt: "2026-08-30T00:00:00.000Z",
  sequence: 1,
  ...overrides,
});

describe("WorkspaceScriptStopRecoveryState", () => {
  it("保留 owner-bound exited receipt 的真实退出结果", () => {
    assert.deepEqual(
      assessWorkspaceScriptStopRecovery({
        inspection: "inactive",
        snapshot: snapshot({ status: "exited", pid: null, exitCode: 17, exitSignal: null }),
      }),
      { _tag: "Confirmed", exitCode: 17, exitSignal: null },
    );
  });

  it("inactive error 仅在 PID 已清空时确认无进程", () => {
    assert.deepEqual(
      assessWorkspaceScriptStopRecovery({
        inspection: "inactive",
        snapshot: snapshot({ status: "error", pid: null }),
      }),
      { _tag: "Confirmed", exitCode: null, exitSignal: null },
    );
    assert.deepEqual(
      assessWorkspaceScriptStopRecovery({
        inspection: "inactive",
        snapshot: snapshot({ status: "error", pid: 4321 }),
      }),
      { _tag: "Unconfirmed", reason: "inactive" },
    );
  });

  it("active、quarantined 与 missing 均不能假报已终止", () => {
    assert.deepEqual(
      assessWorkspaceScriptStopRecovery({ inspection: "active", snapshot: snapshot() }),
      { _tag: "Unconfirmed", reason: "active" },
    );
    assert.deepEqual(
      assessWorkspaceScriptStopRecovery({ inspection: "quarantined", snapshot: snapshot() }),
      { _tag: "Unconfirmed", reason: "quarantined" },
    );
    assert.deepEqual(assessWorkspaceScriptStopRecovery({ inspection: "missing", snapshot: null }), {
      _tag: "Unconfirmed",
      reason: "missing",
    });
  });
});
