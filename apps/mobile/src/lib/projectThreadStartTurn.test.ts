import { describe, expect, it, vi } from "vite-plus/test";

import { ProjectId, ProviderInstanceId } from "@codework/contracts";

vi.mock("./composerImages", () => ({
  toUploadChatImageAttachments: (attachments: ReadonlyArray<unknown>) => attachments,
}));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

const baseSpec = {
  projectId: ProjectId.make("project-1"),
  projectCwd: "/repo",
  threadId: "thread-1",
  commandId: "command-1",
  messageId: "message-1",
  createdAt: "2026-09-03T00:00:00.000Z",
  text: "Inspect this pull request",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  startFromOrigin: true,
  worktreeBranchName: "codework/thread-1",
};

describe("buildProjectThreadStartTurnInput", () => {
  it("uses a prepared PR worktree instead of creating a second worktree", () => {
    const input = buildProjectThreadStartTurnInput({
      ...baseSpec,
      workspaceMode: "worktree",
      branch: "feature/pull-request",
      worktreePath: "/repo/.t3/worktrees/pull-request",
    });

    expect(input.bootstrap.createThread.worktreePath).toBe("/repo/.t3/worktrees/pull-request");
    expect("prepareWorktree" in input.bootstrap).toBe(false);
    expect("runSetupScript" in input.bootstrap).toBe(false);
  });

  it("keeps the normal bootstrap for a new worktree", () => {
    const input = buildProjectThreadStartTurnInput({
      ...baseSpec,
      workspaceMode: "worktree",
      branch: "main",
      worktreePath: null,
    });

    expect(input.bootstrap.createThread.worktreePath).toBeNull();
    expect(input.bootstrap).toMatchObject({
      prepareWorktree: {
        baseBranch: "main",
        branch: "codework/thread-1",
      },
      runSetupScript: true,
    });
  });
});
