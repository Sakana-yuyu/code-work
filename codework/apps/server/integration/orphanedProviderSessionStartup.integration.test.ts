import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@codework/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "../src/cloud/serviceLauncherClient.ts";
import * as CompositionMcpRuntimeService from "../src/composition/CompositionMcpRuntimeService.ts";
import * as CompositionRunStartStartupRecovery from "../src/composition/CompositionRunStartStartupRecovery.ts";
import * as CompositionToolInvocationStartupRecovery from "../src/composition/CompositionToolInvocationStartupRecovery.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as Keybindings from "../src/keybindings.ts";
import { OrchestrationLayerLive } from "../src/orchestration/runtimeLayer.ts";
import * as OrchestrationEngine from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "../src/orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import * as ExternalLauncher from "../src/process/externalLauncher.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderService from "../src/provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../src/provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "../src/provider/Services/ProviderSessionReaper.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import * as ServerLifecycleEvents from "../src/serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as AnalyticsService from "../src/telemetry/AnalyticsService.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-startup-orphan");
const threadId = ThreadId.make("thread-startup-orphan");
const stoppedBindingThreadId = ThreadId.make("thread-startup-orphan-stopped-binding");
const resumeCursor = { schemaVersion: 1, sessionId: "provider-session-before-restart" };
const stoppedBindingResumeCursor = {
  schemaVersion: 1,
  sessionId: "provider-session-stopped-before-restart",
};

const makePersistedRuntimeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestration = OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
  );
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
    Layer.provide(persistence),
  );
  return Layer.mergeAll(orchestration, directory);
};

const makeStartupDependencies = (
  awaitRecovered: CompositionToolInvocationStartupRecovery.CompositionToolInvocationStartupRecoveryShape["awaitRecovered"],
  awaitRunStartsRecovered: CompositionRunStartStartupRecovery.CompositionRunStartStartupRecoveryShape["awaitRecovered"],
) =>
  Layer.mergeAll(
    Layer.mock(Keybindings.Keybindings)({
      start: Effect.void,
    }),
    ServerSettings.layerTest(),
    Layer.succeed(OrchestrationReactor.OrchestrationReactor, {
      start: () => Effect.void,
    }),
    Layer.succeed(ProviderSessionReaper.ProviderSessionReaper, {
      start: () => Effect.void,
    }),
    ServerLifecycleEvents.layer,
    Layer.succeed(CompositionMcpRuntimeService.CompositionMcpRuntimeService, {
      reconcile: () => Effect.void,
      start: Effect.void,
      listServers: () => Effect.succeed([]),
      connectServer: () => Effect.die("unused"),
      disconnectServer: () => Effect.succeed(false),
      refreshServer: () => Effect.die("unused"),
    }),
    Layer.succeed(
      CompositionToolInvocationStartupRecovery.CompositionToolInvocationStartupRecovery,
      CompositionToolInvocationStartupRecovery.CompositionToolInvocationStartupRecovery.of({
        awaitRecovered,
      }),
    ),
    Layer.succeed(
      CompositionRunStartStartupRecovery.CompositionRunStartStartupRecovery,
      CompositionRunStartStartupRecovery.CompositionRunStartStartupRecovery.of({
        awaitRecovered: awaitRunStartsRecovered,
      }),
    ),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-startup-orphan")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment-startup-orphan"),
        label: "Startup orphan test",
        version: "test",
        platform: { os: "linux", arch: "x64" },
        capabilities: {},
      } as never),
    }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      issueStartupPairingUrl: (baseUrl: string) => Effect.succeed(`${baseUrl}/pair`),
    }),
    Layer.mock(ExternalLauncher.ExternalLauncher)({
      launchBrowser: () => Effect.void,
    }),
    Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
      managed: false,
      requestUpdate: () => Effect.die("unused"),
      prepareTrial: Effect.sync(() => undefined),
    }),
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 3773 },
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    AnalyticsService.layerTest,
    Layer.succeed(ProviderService.ProviderService, {
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      handshakeCapabilities: () => Effect.die("unused"),
      revokeCapabilityHandshake: () => Effect.die("unused"),
      configureToolBroker: () => Effect.die("unused"),
      clearToolBroker: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      uploadFeedback: () => Effect.die("unused"),
      streamEvents: Stream.empty,
    }),
  );

it.effect(
  "recovers a persisted starting session before opening the command gate after restart",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const recoveryEntered = yield* Deferred.make<void>();
      const releaseRecovery = yield* Deferred.make<void>();
      const runStartRecoveryObserved = yield* Deferred.make<string>();
      const releaseRunStartRecovery = yield* Deferred.make<void>();
      const firstRuntime = makePersistedRuntimeLayer(config.dbPath);
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("command-create-project"),
          projectId,
          title: "Startup orphan project",
          workspaceRoot: "/tmp/startup-orphan-project",
          defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-thread"),
          threadId,
          projectId,
          title: "Startup orphan thread",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-pending-turn"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-before-restart"),
            role: "user",
            text: "Persist this queued turn before restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-session-starting"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running",
          resumeCursor,
          runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
          runtimeMode: "full-access",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-stopped-binding-thread"),
          threadId: stoppedBindingThreadId,
          projectId,
          title: "Startup orphan with stopped binding",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-stopped-binding-pending-turn"),
          threadId: stoppedBindingThreadId,
          message: {
            messageId: MessageId.make("message-stopped-binding-pending-before-restart"),
            role: "user",
            text: "Persist another queued turn before restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-stopped-binding-session-starting"),
          threadId: stoppedBindingThreadId,
          session: {
            threadId: stoppedBindingThreadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId: stoppedBindingThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "stopped",
          resumeCursor: stoppedBindingResumeCursor,
          runtimePayload: { activeTurnId: "stale", unrelated: "also-preserve-me" },
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstRuntime));

      const secondRuntime = makePersistedRuntimeLayer(config.dbPath);
      // 回执 mock 必须以 R=never 的纯服务注入；提前构建一份独立 Runtime 供其
      // 在启动阶段读取已提交的投影（与 startupLayer 的实例共用同一 sqlite 文件）。
      // 使用专用 Scope 在启动断言结束后立即释放，避免 Windows 下 sqlite 句柄
      // 阻塞临时目录清理。
      const secondRuntimeScope = yield* Scope.make();
      const secondRuntimeServices = yield* Layer.build(secondRuntime).pipe(
        Scope.provide(secondRuntimeScope),
      );
      const awaitRunStartsRecovered = Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        // 模拟恢复回执不允许失败：投影读取异常按缺陷处理，保持回执形状纯净。
        const restartedThread = Option.getOrThrow(
          yield* query.getThreadDetailById(threadId).pipe(Effect.orDie),
        );
        yield* Deferred.succeed(
          runStartRecoveryObserved,
          restartedThread.session?.status ?? "missing",
        );
        yield* Deferred.await(releaseRunStartRecovery);
        return {
          type: "composition.run_starts.recovered" as const,
          recoveredAtUnixMs: 2,
          recoveredCount: 0,
          runIds: [],
        };
      }).pipe(Effect.provideContext(secondRuntimeServices));
      const startupLayer = ServerRuntimeStartup.layer.pipe(
        Layer.provideMerge(secondRuntime),
        Layer.provideMerge(
          makeStartupDependencies(
            Deferred.succeed(recoveryEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRecovery)),
              Effect.as({
                type: "composition.tool_invocations.recovered" as const,
                recoveredAtUnixMs: 1,
                outcomeCode: "process_restarted_result_indeterminate",
                recoveredCount: 0,
                invocations: [],
              }),
            ),
            awaitRunStartsRecovered,
          ),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;

        yield* startup.markHttpListening;
        const commandReadyCompleted = yield* Deferred.make<void>();
        const commandReadyFiber = yield* startup.awaitCommandReady.pipe(
          Effect.ensuring(Deferred.succeed(commandReadyCompleted, undefined).pipe(Effect.asVoid)),
          Effect.forkChild,
        );
        yield* Deferred.await(recoveryEntered);
        assert.isFalse(yield* Deferred.isDone(commandReadyCompleted));

        yield* Deferred.succeed(releaseRecovery, undefined);
        const boundary = yield* Effect.race(
          Deferred.await(runStartRecoveryObserved).pipe(
            Effect.map((status) => ({ _tag: "Recovery" as const, status })),
          ),
          Fiber.join(commandReadyFiber).pipe(Effect.as({ _tag: "CommandReady" as const })),
        );
        assert.equal(boundary._tag, "Recovery");
        if (boundary._tag === "Recovery") {
          assert.equal(boundary.status, "error");
        }
        assert.isFalse(yield* Deferred.isDone(commandReadyCompleted));
        yield* Deferred.succeed(releaseRunStartRecovery, undefined);
        yield* Fiber.join(commandReadyFiber);
        assert.isTrue(yield* Deferred.isDone(commandReadyCompleted));

        const restartedThread = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        const restartedStoppedBindingThread = Option.getOrThrow(
          yield* query.getThreadDetailById(stoppedBindingThreadId),
        );
        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE thread_id IN (${threadId}, ${stoppedBindingThreadId})
            AND turn_id IS NULL
            AND state = 'pending'
        `;
        const settleExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command-settle-after-restart"),
            threadId,
          }),
        );
        const snoozeExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("command-snooze-after-restart"),
            threadId,
            snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
          }),
        );
        const newTurnExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("command-new-turn-after-restart"),
            threadId,
            message: {
              messageId: MessageId.make("message-new-turn-after-restart"),
              role: "user",
              text: "Continue immediately after restart",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt,
          }),
        );
        const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
        const stoppedBinding = Option.getOrThrow(
          yield* directory.getBinding(stoppedBindingThreadId),
        );

        return {
          sessionStatus: restartedThread.session?.status,
          activeTurnId: restartedThread.session?.activeTurnId,
          latestTurn: restartedThread.latestTurn,
          pendingTurnCount: pendingRows.length,
          settleSucceeded: Exit.isSuccess(settleExit),
          snoozeSucceeded: Exit.isSuccess(snoozeExit),
          newTurnSucceeded: Exit.isSuccess(newTurnExit),
          bindingStatus: binding.status,
          resumeCursor: binding.resumeCursor,
          runtimePayload: binding.runtimePayload,
          stoppedBindingSessionStatus: restartedStoppedBindingThread.session?.status,
          stoppedBindingStatus: stoppedBinding.status,
          stoppedBindingResumeCursor: stoppedBinding.resumeCursor,
          stoppedBindingRuntimePayload: stoppedBinding.runtimePayload,
        };
      }).pipe(
        Effect.provide(startupLayer),
        // 启动断言完成后立即释放 mock 专用 Runtime，保证临时目录可被清理。
        Effect.ensuring(Scope.close(secondRuntimeScope, Exit.void)),
      );

      assert.deepStrictEqual(result, {
        sessionStatus: "error",
        activeTurnId: null,
        latestTurn: null,
        pendingTurnCount: 0,
        settleSucceeded: true,
        snoozeSucceeded: true,
        newTurnSucceeded: true,
        bindingStatus: "stopped",
        resumeCursor,
        runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
        stoppedBindingSessionStatus: "error",
        stoppedBindingStatus: "stopped",
        stoppedBindingResumeCursor,
        stoppedBindingRuntimePayload: {
          activeTurnId: null,
          unrelated: "also-preserve-me",
        },
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-orphaned-provider-session-startup-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);
