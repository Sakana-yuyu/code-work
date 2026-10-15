import type { OrchestrationEvent } from "@codework/contracts";
import { makeDrainableWorker } from "@codework/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadSettlementReactor,
  type ThreadSettlementReactorShape,
} from "../Services/ThreadSettlementReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const fileSystem = yield* FileSystem.FileSystem;

  /**
   * One settle cleanup per settledAt timestamp. A thread that settles again
   * after re-entry gets a new settledAt and runs its script again; a repeated
   * settled event for the same settle is a no-op.
   */
  const settleActionRunAt = new Map<string, number>();

  const toSettledAtMs = (settledAt: string | null): number | null => {
    if (settledAt === null) return null;
    const ms = Date.parse(settledAt);
    return Number.isNaN(ms) ? null : ms;
  };

  // Settling closes the thread's shells that sit at an idle prompt, so they
  // stop holding the worktree. A terminal running a command (a dev server, an
  // editor) stays for the user to close. Then the project's settle script runs
  // in the thread's own worktree; a thread in the shared checkout skips it,
  // because other threads may still be working there.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementReactor.cleanUpSettledThread")(function* (
    event: ThreadSettledEvent,
  ) {
    const threadId = event.payload.threadId;
    // A thread re-engaged before this event ran keeps its shells.
    const settled = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(settled) || settled.value.settledOverride !== "settled") return;
    yield* terminalManager.closeIdle({ threadId });
    const worktreePath = settled.value.worktreePath;
    if (
      worktreePath === null ||
      !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return;
    }
    // Closing and the worktree check wait on I/O. A thread re-engaged
    // meanwhile is working again, so its worktree is no place for cleanup.
    const thread = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    if (Option.isNone(thread) || thread.value.settledOverride !== "settled") return;
    const settledAtMs = toSettledAtMs(thread.value.settledAt);
    if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
    const run = yield* projectSetupScriptRunner.runForThread({
      threadId,
      projectId: thread.value.projectId,
      worktreePath,
      trigger: "settle",
      // A clean exit closes the script's shell so it does not hold the worktree.
      observeCompletion: {},
    });
    // Recorded after a successful start, so a failed start retries on the next event.
    settleActionRunAt.set(threadId, settledAtMs);
    if (run.status === "started" && run.completion) {
      yield* run.completion.pipe(Effect.forkDetach);
    }
  });

  const cleanUpSettledThreadSafely = (event: ThreadSettledEvent) =>
    cleanUpSettledThread(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("cleaning up a settled thread failed", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(cleanUpSettledThreadSafely);

  const start: ThreadSettlementReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.settled") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadSettlementReactorShape;
});

export const ThreadSettlementReactorLive = Layer.effect(ThreadSettlementReactor, make);
