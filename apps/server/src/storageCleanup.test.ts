import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@codework/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "./config.ts";
import * as GitManager from "./git/GitManager.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const NOW = Date.parse("2026-10-01T00:00:00.000Z");
// Service tests pin the test clock to WALL_CLOCK; pure helper tests use NOW.
const WALL_CLOCK = Date.parse("2026-11-01T00:00:00.000Z");
const isoDaysAgo = (days: number) =>
  DateTime.formatIso(
    DateTime.makeUnsafe(NOW - days * 86_400_000),
  ) as OrchestrationThreadShell["createdAt"];
const isoNow = (days: number) =>
  DateTime.formatIso(
    DateTime.makeUnsafe(WALL_CLOCK - days * 86_400_000),
  ) as OrchestrationThreadShell["createdAt"];

const makeThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat",
    worktreePath: "/tmp/wt",
    latestTurn: null,
    createdAt: isoDaysAgo(30),
    updatedAt: isoDaysAgo(30),
    session: {
      threadId: ThreadId.make(id),
      status: "stopped",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: isoDaysAgo(30),
    },
    latestUserMessageAt: isoDaysAgo(30),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    queuedMessages: [],
    ...overrides,
  }) as OrchestrationThreadShell;

describe("storageCleanupThreadIdle", () => {
  it("is idle when the thread has no live session, turn, queue, or pending input", () => {
    assert.isTrue(StorageCleanup.storageCleanupThreadIdle(makeThread("t1"), NOW));
  });

  it("rejects running sessions and active turns", () => {
    const running = makeThread("t2", {
      session: { ...makeThread("t2").session!, status: "running" },
    });
    assert.isFalse(StorageCleanup.storageCleanupThreadIdle(running, NOW));
  });

  it("rejects live sessions even without an active turn", () => {
    const ready = makeThread("t3", {
      session: { ...makeThread("t3").session!, status: "ready" },
    });
    assert.isFalse(StorageCleanup.storageCleanupThreadIdle(ready, NOW));
  });

  it("rejects a queued prompt newer than the last turn within the grace window", () => {
    const thread = makeThread("t4", {
      latestUserMessageAt: DateTime.formatIso(DateTime.makeUnsafe(NOW - 30_000)) as never,
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        requestedAt: isoDaysAgo(2),
        startedAt: isoDaysAgo(2),
        completedAt: isoDaysAgo(2),
        assistantMessageId: null,
      },
    });
    assert.isFalse(StorageCleanup.storageCleanupThreadIdle(thread, NOW));
  });

  it("rejects threads with pending approvals, user input, or background liveness", () => {
    assert.isFalse(
      StorageCleanup.storageCleanupThreadIdle(makeThread("t5", { hasPendingApprovals: true }), NOW),
    );
    assert.isFalse(
      StorageCleanup.storageCleanupThreadIdle(
        makeThread("t6", { backgroundLiveness: "monitoring" }),
        NOW,
      ),
    );
  });
});

describe("storageCleanupPullRequestMerged", () => {
  const worktree = {
    branch: "feat",
    defaultBranch: "main",
    headSha: "abc123",
    integrated: false,
  };
  const pullRequest = {
    state: "merged",
    headBranch: "feat",
    baseBranch: "main",
    headSha: "abc123",
  };

  it("removes when the PR merged and the remote branch still points at this head", () => {
    assert.isTrue(StorageCleanup.storageCleanupPullRequestMerged(pullRequest, worktree));
  });

  it("accepts an integrated head regardless of the remote tip", () => {
    assert.isTrue(
      StorageCleanup.storageCleanupPullRequestMerged(
        { ...pullRequest, headSha: "other" },
        { ...worktree, integrated: true },
      ),
    );
  });

  it("keeps worktrees with no PR, an open PR, or a moved remote tip", () => {
    assert.isFalse(StorageCleanup.storageCleanupPullRequestMerged(null, worktree));
    assert.isFalse(
      StorageCleanup.storageCleanupPullRequestMerged({ ...pullRequest, state: "open" }, worktree),
    );
    assert.isFalse(
      StorageCleanup.storageCleanupPullRequestMerged(
        { ...pullRequest, headSha: "def456" },
        worktree,
      ),
    );
    assert.isFalse(
      StorageCleanup.storageCleanupPullRequestMerged({ ...pullRequest, headSha: null }, worktree),
    );
  });
});

describe("StorageCleanup service", () => {
  const makeLayers = (
    settingsOverrides: Parameters<typeof ServerSettings.layerTest>[0],
    threads: ReadonlyArray<OrchestrationThreadShell>,
    deletedRows: ReadonlyArray<{
      threadId: string;
      projectId: string;
      title: string;
      branch: string | null;
      worktreePath: string | null;
      workspaceRoot: string;
    }>,
    removedPaths: string[],
    remoteHeadSha = "abc123",
    statusStdout = "",
  ) => {
    const project: OrchestrationProjectShell = {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: isoDaysAgo(100),
      updatedAt: isoDaysAgo(1),
    };
    const snapshot = {
      snapshotSequence: 1,
      projects: [project],
      threads,
      updatedAt: isoDaysAgo(0),
    };
    const sqlStub = ((strings: TemplateStringsArray, ..._values: unknown[]) =>
      strings.join("").includes("provider_session_runtime")
        ? Effect.succeed([])
        : Effect.succeed(deletedRows)) as never;
    const gitDriverStub = GitVcsDriver.GitVcsDriver.of({
      execute: (input: { args: ReadonlyArray<string> }) => {
        const args = input.args;
        if (args[0] === "rev-parse" && args[1] === "--git-path") {
          return Effect.succeed({
            exitCode: 0,
            stdout: ".git/index",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        if (args[0] === "symbolic-ref") {
          return Effect.succeed({
            exitCode: 0,
            stdout: "refs/heads/feat\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        if (args[0] === "status" || args[0] === "ls-files") {
          return Effect.succeed({
            exitCode: 0,
            stdout: args[0] === "status" ? statusStdout : "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        if (args[0] === "ls-remote") {
          return Effect.succeed({
            exitCode: 0,
            stdout: `${remoteHeadSha}\trefs/heads/feat\n`,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        if (args[0] === "merge-base") {
          return Effect.succeed({
            exitCode: 0,
            stdout: "",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        }
        return Effect.succeed({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      },
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed("main"),
      fetchRemoteTrackingBranch: () => Effect.void,
      removeWorktree: (input: { path: string }) =>
        Effect.sync(() => {
          removedPaths.push(input.path);
        }),
    } as never);
    const gitManagerStub = GitManager.GitManager.of({
      invalidateStatus: () => Effect.void,
      resolvePullRequest: () => Effect.die("unused"),
    } as never);
    const projectionsStub = ProjectionSnapshotQuery.of({
      getShellSnapshot: () => Effect.succeed(snapshot),
      getArchivedShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [],
          threads: [],
          updatedAt: snapshot.updatedAt,
        }),
    } as never);
    const engineStub = OrchestrationEngineService.of({
      streamDomainEvents: Stream.empty,
    } as never);
    const terminalsStub = TerminalManager.TerminalManager.of({
      subscribeMetadata: () => Effect.succeed(() => {}),
    } as never);

    return StorageCleanup.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sqlStub),
          Layer.succeed(GitVcsDriver.GitVcsDriver, gitDriverStub),
          Layer.succeed(GitManager.GitManager, gitManagerStub),
          Layer.succeed(ProjectionSnapshotQuery, projectionsStub),
          Layer.succeed(OrchestrationEngineService, engineStub),
          Layer.succeed(TerminalManager.TerminalManager, terminalsStub),
          ServerSettings.layerTest(settingsOverrides),
        ),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
  };

  it.effect("removes an eligible stale worktree and reports it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(WALL_CLOCK);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const worktreePath = path.join(config.worktreesDir, "wt-old");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /tmp/x");
      yield* fs.writeFileString(path.join(worktreePath, "file.txt"), "hello");

      const removedPaths: string[] = [];
      const thread = makeThread("t-old", {
        worktreePath,
        createdAt: isoNow(30),
        updatedAt: isoNow(30),
        latestUserMessageAt: isoNow(30),
        session: { ...makeThread("t-old").session!, updatedAt: isoNow(30) },
      });
      const layer = makeLayers(
        { storageCleanup: { worktreeAfterDays: 7 } },
        [thread],
        [],
        removedPaths,
      );
      const cleanup = yield* Effect.provide(
        Effect.gen(function* () {
          const svc = yield* StorageCleanup.StorageCleanup;
          const report = yield* svc.runNow;
          assert.strictEqual(yield* svc.latestReport, report);
          return report;
        }),
        layer,
      );
      assert.strictEqual(cleanup.counts.removed, 1);
      assert.strictEqual(cleanup.counts.failed, 0);
      assert.strictEqual(removedPaths.length, 1);
      assert.strictEqual(cleanup.trigger, "manual");
      assert.isTrue(cleanup.bytesFreed > 0);
      const entry = cleanup.entries.find((e) => e.outcome === "removed");
      assert.strictEqual(entry?.kind, "worktree");
      assert.match(entry?.reason ?? "", /inactive/i);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a worktree whose thread is still running", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(WALL_CLOCK);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const worktreePath = path.join(config.worktreesDir, "wt-busy");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /tmp/x");

      const removedPaths: string[] = [];
      const thread = makeThread("t-busy", {
        worktreePath,
        createdAt: isoNow(30),
        updatedAt: isoNow(30),
        latestUserMessageAt: isoNow(30),
        session: {
          ...makeThread("t-busy").session!,
          status: "running",
          updatedAt: isoNow(1),
        },
      });
      const layer = makeLayers(
        { storageCleanup: { worktreeAfterDays: 7 } },
        [thread],
        [],
        removedPaths,
      );
      const cleanup = yield* Effect.provide(
        Effect.gen(function* () {
          const svc = yield* StorageCleanup.StorageCleanup;
          return yield* svc.runNow;
        }),
        layer,
      );
      assert.strictEqual(cleanup.counts.removed, 0);
      assert.strictEqual(removedPaths.length, 0);
      const kept = cleanup.entries.find((e) => e.outcome === "kept");
      assert.match(kept?.reason ?? "", /running|pending/i);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("removes a deleted thread's worktree when the rule is on", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(WALL_CLOCK);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const worktreePath = path.join(config.worktreesDir, "wt-deleted");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /tmp/x");

      const removedPaths: string[] = [];
      const layer = makeLayers(
        { storageCleanup: { worktreeOnDelete: true } },
        [],
        [
          {
            threadId: "t-deleted",
            projectId: "project-1",
            title: "Deleted",
            branch: "feat",
            worktreePath,
            workspaceRoot: "/tmp/project",
          },
        ],
        removedPaths,
      );
      const cleanup = yield* Effect.provide(
        Effect.gen(function* () {
          const svc = yield* StorageCleanup.StorageCleanup;
          return yield* svc.runNow;
        }),
        layer,
      );
      assert.strictEqual(cleanup.counts.removed, 1);
      assert.strictEqual(removedPaths.length, 1);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a stale worktree that still has uncommitted changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(WALL_CLOCK);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const worktreePath = path.join(config.worktreesDir, "wt-dirty");
      yield* fs.makeDirectory(worktreePath, { recursive: true });
      yield* fs.writeFileString(path.join(worktreePath, ".git"), "gitdir: /tmp/x");

      const removedPaths: string[] = [];
      const thread = makeThread("t-dirty", {
        worktreePath,
        createdAt: isoNow(30),
        updatedAt: isoNow(30),
        latestUserMessageAt: isoNow(30),
        session: { ...makeThread("t-dirty").session!, updatedAt: isoNow(30) },
      });
      const layer = makeLayers(
        { storageCleanup: { worktreeAfterDays: 7 } },
        [thread],
        [],
        removedPaths,
        "abc123",
        " M file.ts\0",
      );
      const cleanup = yield* Effect.provide(
        Effect.gen(function* () {
          const svc = yield* StorageCleanup.StorageCleanup;
          return yield* svc.runNow;
        }),
        layer,
      );
      assert.strictEqual(cleanup.counts.removed, 0);
      assert.strictEqual(removedPaths.length, 0);
      const kept = cleanup.entries.find((e) => e.outcome === "kept");
      assert.match(kept?.reason ?? "", /uncommitted changes/);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "cleanup-test-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
