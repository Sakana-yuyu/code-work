import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL, ProjectId, ProviderInstanceId, ThreadId } from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  CompositionToolInvocationStartupRecovery,
  CompositionToolInvocationStartupRecoveryError,
} from "./composition/CompositionToolInvocationStartupRecovery.ts";
import {
  CompositionGoalLoopRetryStartupRecovery,
  CompositionGoalLoopRetryStartupRecoveryError,
} from "./composition/CompositionGoalLoopRetryStartupRecovery.ts";
import {
  CompositionAgentDriverRegistryService,
  makeCompositionAgentDriverRegistry,
} from "./composition/CompositionAgentDriverRegistry.ts";
import {
  CompositionIdeSessionRegistryService,
  makeCompositionIdeSessionRegistry,
} from "./composition/CompositionIdeSessionRegistry.ts";
import { makeInMemoryCompositionRuntimeAdapter } from "./composition/CompositionRuntimeAdapter.ts";
import {
  CompositionRuntimeAdapterRegistryService,
  makeCompositionRuntimeAdapterRegistry,
} from "./composition/CompositionRuntimeAdapterRegistry.ts";
import { CompositionRunStartStartupRecovery } from "./composition/CompositionRunStartStartupRecovery.ts";
import { CompositionRunStartStartupReconciliation } from "./composition/CompositionRunStartStartupRecovery.ts";
import type { CompositionRunStartRecoveryReconciliation } from "./composition/CompositionRunStartRecoveryPolicy.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it("uses the canonical Codex default for auto-bootstrapped model selection", () => {
  assert.deepStrictEqual(ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("tool invocation recovery gate waits for the shared startup recovery", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const recovery = CompositionToolInvocationStartupRecovery.of({
      awaitRecovered: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({
          type: "composition.tool_invocations.recovered" as const,
          recoveredAtUnixMs: 1,
          outcomeCode: "process_restarted_result_indeterminate",
          recoveredCount: 0,
          invocations: [],
        }),
      ),
    });

    const gate = yield* ServerRuntimeStartup.awaitToolInvocationRecovery.pipe(
      Effect.ensuring(Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
      Effect.provideService(CompositionToolInvocationStartupRecovery, recovery),
      Effect.forkChild,
    );

    yield* Deferred.await(entered);
    assert.isFalse(yield* Deferred.isDone(completed));

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(gate);
    assert.isTrue(yield* Deferred.isDone(completed));
  }),
);

it.effect("Run Start recovery gate waits for the shared startup recovery", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const recovery = CompositionRunStartStartupRecovery.of({
      awaitRecovered: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({
          type: "composition.run_starts.recovered" as const,
          recoveredAtUnixMs: 1,
          plans: [],
        }),
      ),
    });

    const gate = yield* ServerRuntimeStartup.awaitRunStartRecovery.pipe(
      Effect.ensuring(Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
      Effect.provideService(CompositionRunStartStartupRecovery, recovery),
      Effect.forkChild,
    );

    yield* Deferred.await(entered);
    assert.isFalse(yield* Deferred.isDone(completed));

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(gate);
    assert.isTrue(yield* Deferred.isDone(completed));
  }),
);

it.effect("Run Start watcher 补扫订阅窗口并串行响应后续 Driver 变化", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const drivers = makeCompositionAgentDriverRegistry();
      const firstRecovery = yield* Deferred.make<void>();
      const secondRecovery = yield* Deferred.make<void>();
      const reconciliations: Array<ReadonlySet<string>> = [];
      let recoveries = 0;
      const makeDriver = (suffix: string) => ({
        agentId: `agent-startup-watch-${suffix}`,
        runtimeId: `runtime-startup-watch-${suffix}`,
        startTask: () => Effect.succeed({ runtimeTaskId: `runtime-task-startup-watch-${suffix}` }),
        cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
      });

      // 模拟首次扫描结束后、Registry 订阅安装前发生且不会被 PubSub 重放的变化。
      yield* drivers.register(makeDriver("before-subscribe"));
      yield* ServerRuntimeStartup.watchRunStartRecoveryTargets(
        {
          type: "composition.run_starts.recovered",
          recoveredAtUnixMs: 1,
          plans: [],
        },
        Effect.succeed(true),
      ).pipe(
        Effect.provideService(CompositionAgentDriverRegistryService, drivers),
        Effect.provideService(
          CompositionRunStartStartupReconciliation,
          CompositionRunStartStartupReconciliation.of({
            get: Effect.succeed(new Set()),
            replace: (value) =>
              Effect.sync(() => {
                reconciliations.push(new Set(value));
              }),
          }),
        ),
        Effect.provideService(
          CompositionRunStartStartupRecovery,
          CompositionRunStartStartupRecovery.of({
            awaitRecovered: Effect.gen(function* () {
              recoveries += 1;
              yield* Deferred.succeed(recoveries === 1 ? firstRecovery : secondRecovery, undefined);
              return {
                type: "composition.run_starts.recovered" as const,
                recoveredAtUnixMs: recoveries + 1,
                plans: [],
              };
            }),
          }),
        ),
      );

      yield* Deferred.await(firstRecovery);
      yield* drivers.register(makeDriver("after-subscribe"));
      yield* Deferred.await(secondRecovery);

      assert.equal(recoveries, 2);
      assert.equal(reconciliations.length, 2);
      assert.isTrue(reconciliations.every((value) => value.has("provider-sessions")));
    }),
  ),
);

it.effect("Run Start 启动阶段严格先完成 Provider orphan 对账再恢复意图", () =>
  Effect.gen(function* () {
    const phases: string[] = [];
    const providerResults: boolean[] = [];

    const receipt = yield* ServerRuntimeStartup.runCompositionRunStartStartupSequence({
      reconcileProviderSessions: Effect.sync(() => {
        phases.push("provider");
        return true;
      }),
      reconcileTargets: (providerSessionsReconciled) =>
        Effect.sync(() => {
          phases.push("targets");
          providerResults.push(providerSessionsReconciled);
        }),
      recover: Effect.sync(() => {
        phases.push("recover");
        return {
          type: "composition.run_starts.recovered" as const,
          recoveredAtUnixMs: 1,
          plans: [],
        };
      }),
    });

    assert.deepEqual(phases, ["provider", "targets", "recover"]);
    assert.deepEqual(providerResults, [true]);
    assert.equal(receipt.type, "composition.run_starts.recovered");
  }),
);

it.effect("Provider orphan 对账失败时不得授予 Run Start provider-sessions 门禁", () =>
  Effect.gen(function* () {
    const reconciliation = yield* Ref.make<ReadonlySet<CompositionRunStartRecoveryReconciliation>>(
      new Set(),
    );
    const receipt = yield* ServerRuntimeStartup.runCompositionRunStartStartupSequence({
      reconcileProviderSessions: Effect.succeed(false),
      reconcileTargets: (providerSessionsReconciled) =>
        ServerRuntimeStartup.reconcileCompositionRunStartTargets(providerSessionsReconciled),
      recover: Effect.succeed({
        type: "composition.run_starts.recovered" as const,
        recoveredAtUnixMs: 1,
        plans: [],
      }),
    }).pipe(
      Effect.provideService(
        CompositionRunStartStartupReconciliation,
        CompositionRunStartStartupReconciliation.of({
          get: Ref.get(reconciliation),
          replace: (value) => Ref.set(reconciliation, new Set(value)),
        }),
      ),
    );

    assert.equal(receipt.type, "composition.run_starts.recovered");
    assert.isFalse((yield* Ref.get(reconciliation)).has("provider-sessions"));
  }),
);

it.effect("悬挂的 IDE 与 Runtime Adapter 探测不会阻塞其他启动目标", () =>
  Effect.gen(function* () {
    const ideSessions = makeCompositionIdeSessionRegistry();
    const runtimeAdapters = makeCompositionRuntimeAdapterRegistry();
    const healthyRuntime = makeInMemoryCompositionRuntimeAdapter({
      runtimeId: "runtime-startup-probe-healthy",
    });
    const hangingRuntime = {
      ...makeInMemoryCompositionRuntimeAdapter({ runtimeId: "runtime-startup-probe-hanging" }),
      probe: () => Effect.never,
    };
    yield* runtimeAdapters.register(healthyRuntime);
    yield* runtimeAdapters.register(hangingRuntime);
    yield* ideSessions.register({
      sessionId: "ide-startup-probe-healthy",
      profile: "cursor_ide",
      probe: () =>
        Effect.succeed({
          sessionId: "ide-startup-probe-healthy",
          profile: "cursor_ide" as const,
          verifiedOperations: [],
          status: "ready" as const,
        }),
      handshake: () => Effect.die("unused"),
      invoke: () => Effect.die("unused"),
    });
    yield* ideSessions.register({
      sessionId: "ide-startup-probe-hanging",
      profile: "cursor_ide",
      probe: () => Effect.never,
      handshake: () => Effect.die("unused"),
      invoke: () => Effect.die("unused"),
    });

    const reconcileFiber = yield* ServerRuntimeStartup.reconcileCompositionRunStartTargets(
      true,
    ).pipe(
      Effect.provideService(CompositionIdeSessionRegistryService, ideSessions),
      Effect.provideService(CompositionRuntimeAdapterRegistryService, runtimeAdapters),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    yield* Effect.yieldNow;
    yield* TestClock.adjust("5 seconds");
    const reconciled = yield* Fiber.join(reconcileFiber);

    assert.isTrue(reconciled.has("ide-session-known:ide-startup-probe-healthy"));
    assert.isTrue(reconciled.has("ide-session-ready:ide-startup-probe-healthy"));
    assert.isTrue(reconciled.has("ide-session-known:ide-startup-probe-hanging"));
    assert.isFalse(reconciled.has("ide-session-ready:ide-startup-probe-hanging"));
    assert.isTrue(reconciled.has("runtime-adapter-known:runtime-startup-probe-healthy"));
    assert.isTrue(reconciled.has("runtime-adapter-ready:runtime-startup-probe-healthy"));
    assert.isTrue(reconciled.has("runtime-adapter-known:runtime-startup-probe-hanging"));
    assert.isFalse(reconciled.has("runtime-adapter-ready:runtime-startup-probe-hanging"));
  }),
);

it.effect("tool invocation recovery failure fails command readiness and aborts startup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const abortError = yield* Deferred.make<ServerRuntimeStartup.ServerRuntimeStartupError>();
      const recoveryFailure = new CompositionToolInvocationStartupRecoveryError({
        cause: new Error("recovery unavailable"),
      });
      const startupExit = yield* ServerRuntimeStartup.awaitToolInvocationRecovery.pipe(
        Effect.provideService(
          CompositionToolInvocationStartupRecovery,
          CompositionToolInvocationStartupRecovery.of({
            awaitRecovered: Effect.fail(recoveryFailure),
          }),
        ),
        Effect.exit,
      );
      if (Exit.isSuccess(startupExit)) {
        return assert.fail("expected tool invocation recovery to fail");
      }

      yield* ServerRuntimeStartup.settleStartupExit(startupExit, {
        mode: "web",
        host: "127.0.0.1",
        port: 3773,
        failCommandReady: commandGate.failCommandReady,
        abort: (error) => Deferred.succeed(abortError, error).pipe(Effect.asVoid),
      });

      const readinessError = yield* commandGate.awaitCommandReady.pipe(Effect.flip);
      const abortedWith = yield* Deferred.await(abortError);
      assert.strictEqual(readinessError, abortedWith);
      assert.equal(readinessError.cause, startupExit.cause);
    }),
  ),
);

it.effect("goal loop retry recovery gate waits for the shared startup recovery", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const recovery = CompositionGoalLoopRetryStartupRecovery.of({
      awaitRecovered: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({
          type: "composition.goal_loop_retries.recovered" as const,
          recoveredAtUnixMs: 1,
          recoveredCount: 0,
          previousRunIds: [],
        }),
      ),
    });

    const gate = yield* ServerRuntimeStartup.awaitGoalLoopRetryRecovery.pipe(
      Effect.ensuring(Deferred.succeed(completed, undefined).pipe(Effect.asVoid)),
      Effect.provideService(CompositionGoalLoopRetryStartupRecovery, recovery),
      Effect.forkChild,
    );

    yield* Deferred.await(entered);
    assert.isFalse(yield* Deferred.isDone(completed));

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(gate);
    assert.isTrue(yield* Deferred.isDone(completed));
  }),
);

it.effect("goal loop retry recovery failure fails command readiness and aborts startup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const abortError = yield* Deferred.make<ServerRuntimeStartup.ServerRuntimeStartupError>();
      const recoveryFailure = new CompositionGoalLoopRetryStartupRecoveryError({
        cause: new Error("goal loop retry recovery unavailable"),
      });
      const startupExit = yield* ServerRuntimeStartup.awaitGoalLoopRetryRecovery.pipe(
        Effect.provideService(
          CompositionGoalLoopRetryStartupRecovery,
          CompositionGoalLoopRetryStartupRecovery.of({
            awaitRecovered: Effect.fail(recoveryFailure),
          }),
        ),
        Effect.exit,
      );
      if (Exit.isSuccess(startupExit)) {
        return assert.fail("expected goal loop retry recovery to fail");
      }

      yield* ServerRuntimeStartup.settleStartupExit(startupExit, {
        mode: "web",
        host: "127.0.0.1",
        port: 3773,
        failCommandReady: commandGate.failCommandReady,
        abort: (error) => Deferred.succeed(abortError, error).pipe(Effect.asVoid),
      });

      const readinessError = yield* commandGate.awaitCommandReady.pipe(Effect.flip);
      const abortedWith = yield* Deferred.await(abortError);
      assert.strictEqual(readinessError, abortedWith);
      assert.equal(readinessError.cause, startupExit.cause);
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* ServerRuntimeStartup.launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(AnalyticsService.AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            Option.some({
              id: bootstrapProjectId,
              title: "Startup Project",
              workspaceRoot: "/tmp/startup-project",
              defaultModelSelection: ServerRuntimeStartup.getAutoBootstrapDefaultModelSelection(),
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.some(bootstrapThreadId)),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect("resolveAutoBootstrapWelcomeTargets creates a project and thread when missing", () =>
  Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create", "thread.create"]);
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
