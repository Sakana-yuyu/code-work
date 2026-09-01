import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as CompositionMcpRuntimeService from "./composition/CompositionMcpRuntimeService.ts";
import * as CompositionGoalLoopRetryStartupRecovery from "./composition/CompositionGoalLoopRetryStartupRecovery.ts";
import * as CompositionToolInvocationStartupRecovery from "./composition/CompositionToolInvocationStartupRecovery.ts";
import * as CompositionRunStartStartupRecovery from "./composition/CompositionRunStartStartupRecovery.ts";
import { runCompositionRunStartRecoveryScheduler } from "./composition/CompositionRunStartRecoveryScheduler.ts";
import * as CompositionAgentDriverRegistry from "./composition/CompositionAgentDriverRegistry.ts";
import * as CompositionIdeSessionRegistry from "./composition/CompositionIdeSessionRegistry.ts";
import * as CompositionRuntimeAdapterRegistry from "./composition/CompositionRuntimeAdapterRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import { ThreadGoalStore } from "./persistence/Services/ThreadGoalStore.ts";
import { forkParked } from "./serverActivation.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedErrorClass<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("codework/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

export const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

export const launchStartupHeartbeat = recordStartupHeartbeat.pipe(
  Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
  Effect.withSpan("server.startup.heartbeat.record"),
  Effect.ignoreCause({ log: true }),
  Effect.forkScoped,
  Effect.asVoid,
);

export const getAutoBootstrapDefaultModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextProjectDefaultModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextProjectDefaultModelSelection = getAutoBootstrapDefaultModelSelection();
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          defaultModelSelection: nextProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        nextProjectId = existingProject.value.id;
        nextProjectDefaultModelSelection =
          existingProject.value.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();
      }

      const existingThreadId =
        yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
      if (Option.isNone(existingThreadId)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const createdThreadId = ThreadId.make(yield* randomUUID);
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* randomUUID),
          threadId: createdThreadId,
          projectId: nextProjectId,
          title: "New thread",
          modelSelection: nextProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = createdThreadId;
      } else {
        bootstrapProjectId = nextProjectId;
        bootstrapThreadId = existingThreadId.value;
      }
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
  } as const;
});

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

export const awaitToolInvocationRecovery = Effect.gen(function* () {
  const recovery =
    yield* CompositionToolInvocationStartupRecovery.CompositionToolInvocationStartupRecovery;
  return yield* runStartupPhase("tool-invocations.recover", recovery.awaitRecovered);
});

export const awaitGoalLoopRetryRecovery = Effect.gen(function* () {
  const recovery =
    yield* CompositionGoalLoopRetryStartupRecovery.CompositionGoalLoopRetryStartupRecovery;
  const outcome = yield* Effect.result(
    runStartupPhase("goal-loop-retries.recover", recovery.awaitRecovered),
  );
  if (outcome._tag === "Failure") {
    // 启动恢复是尽力而为的操作：失败只记录告警，不得阻塞服务启动（intent 仍在库中，下次启动重试）。
    yield* Effect.logWarning("Goal Loop retry 启动恢复失败，已跳过且不阻塞启动。");
  }
});

const RUN_START_TARGET_PROBE_TIMEOUT = Duration.seconds(5);
const RUN_START_TARGET_PROBE_CONCURRENCY = 4;

const probeRunStartTarget = <A, E, R>(input: {
  readonly targetType: "ide-session" | "runtime-adapter";
  readonly targetId: string;
  readonly probe: () => Effect.Effect<A, E, R>;
  readonly isReady: (result: A) => boolean;
}): Effect.Effect<boolean, E, R> =>
  Effect.suspend(input.probe).pipe(
    Effect.timeoutOption(RUN_START_TARGET_PROBE_TIMEOUT),
    Effect.exit,
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit)) {
        if (Cause.hasInterrupts(exit.cause)) return Effect.failCause(exit.cause);
        return Effect.logWarning("Run Start 启动目标探测失败，相关恢复项将延后", {
          targetType: input.targetType,
          targetId: input.targetId,
          cause: exit.cause,
        }).pipe(Effect.as(false));
      }
      if (Option.isNone(exit.value)) {
        return Effect.logWarning("Run Start 启动目标探测超时，相关恢复项将延后", {
          targetType: input.targetType,
          targetId: input.targetId,
        }).pipe(Effect.as(false));
      }
      return Effect.succeed(input.isReady(exit.value.value));
    }),
  );

export const reconcileCompositionRunStartTargets = (providerSessionsReconciled: boolean) =>
  Effect.gen(function* () {
    const reconciliation = yield* Effect.serviceOption(
      CompositionRunStartStartupRecovery.CompositionRunStartStartupReconciliation,
    );
    const reconciled = new Set<
      import("./composition/CompositionRunStartRecoveryPolicy.ts").CompositionRunStartRecoveryReconciliation
    >();
    if (providerSessionsReconciled) reconciled.add("provider-sessions");
    const ideSessions = yield* Effect.serviceOption(
      CompositionIdeSessionRegistry.CompositionIdeSessionRegistryService,
    );
    if (Option.isSome(ideSessions)) {
      const adapters = yield* ideSessions.value.list;
      reconciled.add("ide-sessions");
      const statuses = yield* Effect.forEach(
        adapters,
        (adapter) =>
          probeRunStartTarget({
            targetType: "ide-session",
            targetId: adapter.sessionId,
            probe: adapter.probe,
            isReady: (status) => status.status === "ready",
          }).pipe(Effect.map((ready) => ({ sessionId: adapter.sessionId, ready }))),
        { concurrency: RUN_START_TARGET_PROBE_CONCURRENCY },
      );
      for (const status of statuses) {
        reconciled.add(`ide-session-known:${status.sessionId}`);
        if (status.ready) reconciled.add(`ide-session-ready:${status.sessionId}`);
      }
    }
    const runtimeAdapters = yield* Effect.serviceOption(
      CompositionRuntimeAdapterRegistry.CompositionRuntimeAdapterRegistryService,
    );
    if (Option.isSome(runtimeAdapters)) {
      const adapters = yield* runtimeAdapters.value.list;
      reconciled.add("runtime-adapters");
      const statuses = yield* Effect.forEach(
        adapters,
        (adapter) =>
          probeRunStartTarget({
            targetType: "runtime-adapter",
            targetId: adapter.runtimeId,
            probe: adapter.probe,
            isReady: (status) => status.status === "online",
          }).pipe(Effect.map((ready) => ({ runtimeId: adapter.runtimeId, ready }))),
        { concurrency: RUN_START_TARGET_PROBE_CONCURRENCY },
      );
      for (const status of statuses) {
        reconciled.add(`runtime-adapter-known:${status.runtimeId}`);
        if (status.ready) reconciled.add(`runtime-adapter-ready:${status.runtimeId}`);
      }
    }
    if (Option.isSome(reconciliation)) yield* reconciliation.value.replace(reconciled);
    return reconciled;
  });

export const awaitRunStartRecovery = Effect.gen(function* () {
  const recovery = yield* Effect.serviceOption(
    CompositionRunStartStartupRecovery.CompositionRunStartStartupRecovery,
  );
  if (Option.isNone(recovery)) return;
  const outcome = yield* Effect.result(
    runStartupPhase("composition-run-starts.recover", recovery.value.awaitRecovered),
  );
  if (outcome._tag === "Failure") {
    // 启动恢复是尽力而为的操作：失败只记录告警，不得阻塞服务启动（intent 仍在库中，调度器会再次尝试）。
    yield* Effect.logWarning("Run Start 启动恢复失败，已跳过且不阻塞启动。");
    return;
  }
  return outcome.success;
});

export const runCompositionRunStartStartupSequence = <
  A,
  EProvider,
  RProvider,
  ETargets,
  RTargets,
  ERecovery,
  RRecovery,
>(input: {
  readonly reconcileProviderSessions: Effect.Effect<boolean, EProvider, RProvider>;
  readonly reconcileTargets: (
    providerSessionsReconciled: boolean,
  ) => Effect.Effect<unknown, ETargets, RTargets>;
  readonly recover: Effect.Effect<A, ERecovery, RRecovery>;
}) =>
  Effect.gen(function* () {
    const providerSessionsReconciled = yield* input.reconcileProviderSessions;
    yield* input.reconcileTargets(providerSessionsReconciled);
    return yield* input.recover;
  });

export const watchRunStartRecoveryTargets = <EProvider, RProvider>(
  initialReceipt:
    | CompositionRunStartStartupRecovery.CompositionRunStartStartupRecoveryReceipt
    | undefined,
  reconcileProviderSessionsEffect: Effect.Effect<boolean, EProvider, RProvider>,
) =>
  Effect.gen(function* () {
    const recovery = yield* Effect.serviceOption(
      CompositionRunStartStartupRecovery.CompositionRunStartStartupRecovery,
    );
    const reconciliation = yield* Effect.serviceOption(
      CompositionRunStartStartupRecovery.CompositionRunStartStartupReconciliation,
    );
    const drivers = yield* Effect.serviceOption(
      CompositionAgentDriverRegistry.CompositionAgentDriverRegistryService,
    );
    if (Option.isNone(recovery) || Option.isNone(reconciliation) || Option.isNone(drivers)) return;

    const ideSessions = yield* Effect.serviceOption(
      CompositionIdeSessionRegistry.CompositionIdeSessionRegistryService,
    );
    const runtimeAdapters = yield* Effect.serviceOption(
      CompositionRuntimeAdapterRegistry.CompositionRuntimeAdapterRegistryService,
    );
    const changes = yield* Queue.sliding<void>(1);
    const subscriptions = [yield* drivers.value.subscribeChanges];
    if (Option.isSome(ideSessions)) subscriptions.push(yield* ideSessions.value.subscribeChanges);
    if (Option.isSome(runtimeAdapters)) {
      subscriptions.push(yield* runtimeAdapters.value.subscribeChanges);
    }
    for (const subscription of subscriptions) {
      yield* Effect.forkScoped(
        Effect.forever(
          PubSub.take(subscription).pipe(
            Effect.flatMap(() => Queue.offer(changes, undefined)),
            Effect.asVoid,
          ),
        ),
      );
    }

    yield* runCompositionRunStartRecoveryScheduler({
      ...(initialReceipt === undefined ? {} : { initialReceipt }),
      changes,
      recover: runCompositionRunStartStartupSequence({
        reconcileProviderSessions: reconcileProviderSessionsEffect,
        reconcileTargets: reconcileCompositionRunStartTargets,
        recover: recovery.value.awaitRecovered,
      }),
    }).pipe(Effect.forkScoped);

    // 覆盖首次扫描完成到 Registry 订阅安装之间发生的目标变化。
    yield* Queue.offer(changes, undefined);
  });

const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const threadGoalStore = yield* Effect.serviceOption(ThreadGoalStore);
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  let reconciled = true;

  for (const thread of threads) {
    if (liveThreadIds.has(thread.id)) continue;

    const session = thread.session;
    const shouldReconcileSession =
      session !== null &&
      (session.status === "starting" ||
        session.status === "running" ||
        session.activeTurnId !== null);
    let shouldPauseGoal = false;

    if (Option.isSome(threadGoalStore)) {
      const goalExit = yield* Effect.exit(threadGoalStore.value.get(thread.id));
      if (Exit.isFailure(goalExit)) {
        if (Cause.hasInterrupts(goalExit.cause)) {
          return yield* Effect.failCause(goalExit.cause);
        }
        reconciled = false;
        yield* Effect.logWarning(
          "failed to read thread Goal during provider session reconciliation",
          {
            threadId: thread.id,
            cause: goalExit.cause,
          },
        );
      } else if (Option.isSome(goalExit.value) && goalExit.value.value.status === "active") {
        shouldPauseGoal = true;
      }
    }

    if (!shouldReconcileSession && !shouldPauseGoal) {
      continue;
    }

    let sessionReconciled = true;
    if (shouldReconcileSession) {
      const directoryExit = yield* Effect.exit(
        Effect.gen(function* () {
          const binding = yield* directory.getBinding(thread.id);
          if (Option.isSome(binding)) {
            yield* directory.upsert({
              ...binding.value,
              status: "stopped",
              runtimePayload: { activeTurnId: null },
            });
          }
        }),
      );
      if (Exit.isFailure(directoryExit)) {
        if (Cause.hasInterrupts(directoryExit.cause)) {
          return yield* Effect.failCause(directoryExit.cause);
        }
        reconciled = false;
        sessionReconciled = false;
        yield* Effect.logWarning(
          "failed to reconcile orphaned provider session directory binding",
          {
            threadId: thread.id,
            cause: directoryExit.cause,
          },
        );
      }

      if (sessionReconciled) {
        const projectionExit = yield* Effect.exit(
          Effect.gen(function* () {
            const reconciledAt = DateTime.formatIso(yield* DateTime.now);
            yield* orchestrationEngine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId: thread.id,
              session: {
                ...session,
                status: "error",
                activeTurnId: null,
                lastError: ORPHANED_PROVIDER_SESSION_ERROR,
                updatedAt: reconciledAt,
              },
              createdAt: reconciledAt,
            });
          }).pipe(Effect.retry({ times: 1 })),
        );
        if (Exit.isFailure(projectionExit)) {
          if (Cause.hasInterrupts(projectionExit.cause)) {
            return yield* Effect.failCause(projectionExit.cause);
          }
          reconciled = false;
          yield* Effect.logWarning("failed to settle orphaned provider session projection", {
            threadId: thread.id,
            cause: projectionExit.cause,
          });
        }
      }
    }

    if (shouldPauseGoal && Option.isSome(threadGoalStore)) {
      const goalExit = yield* Effect.exit(threadGoalStore.value.pause(thread.id));
      if (Exit.isFailure(goalExit)) {
        if (Cause.hasInterrupts(goalExit.cause)) {
          return yield* Effect.failCause(goalExit.cause);
        }
        reconciled = false;
        yield* Effect.logWarning(
          "failed to pause active thread Goal during provider session reconciliation",
          {
            threadId: thread.id,
            cause: goalExit.cause,
          },
        );
      }
    }
  }
  return reconciled;
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }).pipe(
          Effect.as(false),
        ),
  ),
);

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

interface StartupExitOptions {
  readonly mode: ServerConfig.RuntimeMode;
  readonly host: string | null;
  readonly port: number;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const settleStartupExit = <A, E>(
  startupExit: Exit.Exit<A, E>,
  options: StartupExitOptions,
) => {
  if (Exit.isSuccess(startupExit)) return Effect.void;

  const error = new ServerRuntimeStartupError({
    mode: options.mode,
    host: options.host,
    port: options.port,
    cause: startupExit.cause,
  });
  return Effect.logError("server runtime startup failed", {
    cause: startupExit.cause,
  }).pipe(
    Effect.andThen(options.failCommandReady(error)),
    Effect.andThen(options.abort?.(error) ?? Effect.void),
  );
};

export const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const mcpRuntime = yield* CompositionMcpRuntimeService.CompositionMcpRuntimeService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const reactorScope = yield* Scope.make("sequential");

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

    const startup = Effect.gen(function* () {
      yield* awaitToolInvocationRecovery;
      yield* awaitGoalLoopRetryRecovery;

      // 五个互不依赖的运行时根并行启动：任何一个失败都照旧中止启动序列
      // （Effect.all 默认 fail-fast），只是不再互相拖长串行等待。
      yield* Effect.all(
        [
          Effect.logDebug("startup phase: starting keybindings runtime").pipe(
            Effect.andThen(
              runStartupPhase(
                "keybindings.start",
                keybindings.start.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to start keybindings runtime", {
                      path: error.configPath,
                      detail: error.detail,
                      cause: error.cause,
                    }),
                  ),
                ),
              ),
            ),
          ),
          Effect.logDebug("startup phase: starting server settings runtime").pipe(
            Effect.andThen(
              runStartupPhase(
                "settings.start",
                serverSettings.start.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("failed to start server settings runtime", {
                      path: error.settingsPath,
                      operation: error.operation,
                      providerInstanceId: error.providerInstanceId,
                      environmentVariable: error.environmentVariable,
                      cause: error.cause,
                    }),
                  ),
                ),
              ),
            ),
          ),
          runStartupPhase("mcp-runtime.start", mcpRuntime.start),
          Effect.logDebug("startup phase: parking orchestration roots at activation").pipe(
            Effect.andThen(
              runStartupPhase(
                "reactors.start",
                Effect.gen(function* () {
                  yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
                  yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
                }),
              ),
            ),
          ),
          runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions),
        ],
        { concurrency: "unbounded" },
      );

      // 注意：orchestrationReactor/providerSessionReaper/mcpRuntime 已在上面
      // 的并行根里启动。这里的 start() 每调用一次就 fork 一份新的事件订阅
      // （ingestion/命令/checkpoint 反应器都会把每条 runtime 事件处理两次，
      // 表现为助手消息逐词重复），因此绝不能重复调用。

      const runStartRecoveryReceipt = yield* runCompositionRunStartStartupSequence({
        reconcileProviderSessions: runStartupPhase(
          "provider-sessions.reconcile",
          reconcileProviderSessions,
        ),
        reconcileTargets: (providerSessionsReconciled) =>
          runStartupPhase(
            "composition-run-start-targets.reconcile",
            reconcileCompositionRunStartTargets(providerSessionsReconciled),
          ),
        recover: awaitRunStartRecovery,
      });
      yield* watchRunStartRecoveryTargets(runStartRecoveryReceipt, reconcileProviderSessions);

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      yield* Effect.logDebug("startup phase: preparing welcome payload");

      if (serverConfig.autoBootstrapProjectFromCwd) {
        yield* forkParked(
          runStartupPhase(
            "welcome.autobootstrap",
            Effect.gen(function* () {
              const bootstrapTargets = yield* resolveAutoBootstrapWelcomeTargets.pipe(
                Effect.provideService(Crypto.Crypto, crypto),
              );
              if (!bootstrapTargets.bootstrapProjectId && !bootstrapTargets.bootstrapThreadId) {
                return;
              }

              yield* Effect.logDebug("startup phase: publishing bootstrapped welcome event", {
                environmentId: environment.environmentId,
                cwd: welcomeBase.cwd,
                projectName: welcomeBase.projectName,
                bootstrapProjectId: bootstrapTargets.bootstrapProjectId,
                bootstrapThreadId: bootstrapTargets.bootstrapThreadId,
              });
              yield* lifecycleEvents.publish({
                version: 1,
                type: "welcome",
                payload: {
                  environment,
                  ...welcomeBase,
                  ...bootstrapTargets,
                },
              });
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("startup auto-bootstrap welcome failed", {
                  cause,
                }),
              ),
            ),
          ),
        );
      }

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            const accessInfo = yield* issueHeadlessServeAccessInfo();
            yield* runStartupPhase(
              "headless.output",
              Console.log(formatHeadlessServeOutput(accessInfo)),
            );
          } else {
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop") {
              yield* Effect.logInfo(
                "Authentication required. Open Code Work using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      // This is the prepared boundary. Every dependency has been acquired and
      // every runtime root has confirmed that it is parked before this request.
      const updateOutcome = yield* launcher.prepareTrial;
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: { environment, ...welcomeBase },
        }),
      );
      yield* options?.activate ?? Effect.void;

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      yield* Effect.logDebug("startup phase: complete");
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) =>
          settleStartupExit(startupExit, {
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            failCommandReady: commandGate.failCommandReady,
            ...(options?.abort === undefined ? {} : { abort: options.abort }),
          }),
        ),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

export const layer = layerWithOptions();
