import { ThreadId } from "@t3tools/contracts";
import type {
  CompositionAgentDriverProfile,
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  ModelSelection,
  ProviderInstanceId,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  TurnId,
  RuntimeMode,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type { ProviderServiceError } from "../provider/Errors.ts";
import type {
  ProviderToolBrokerBridge,
  ProviderToolBrokerContext,
} from "../provider/Services/ProviderAdapter.ts";
import type { CompositionRuntimeToolBridgeShape } from "./CompositionRuntimeToolBridge.ts";
import { makeCompositionProviderToolBrokerBridge } from "./CompositionProviderToolBrokerBridge.ts";
import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";

export interface CompositionProviderSessionAdapter {
  readonly handshakeCapabilities?: (
    input: CompositionRuntimeCapabilityHandshakeRequest,
  ) => Effect.Effect<CompositionRuntimeCapabilityHandshakeResult, ProviderServiceError>;
  readonly revokeCapabilityHandshake?: (input: {
    readonly handshakeId: string;
  }) => Effect.Effect<void, ProviderServiceError>;
  readonly configureToolBroker?: (input: {
    readonly threadId: ThreadId;
    readonly bridge: ProviderToolBrokerBridge;
    readonly context: ProviderToolBrokerContext;
  }) => Effect.Effect<void, ProviderServiceError>;
  readonly clearToolBroker?: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;
  readonly interruptTurn: (
    threadId: ThreadId,
    turnId?: TurnId,
  ) => Effect.Effect<void, ProviderServiceError>;
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, ProviderServiceError>;
}

export interface CompositionProviderAgentDriverOptions {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly adapter: CompositionProviderSessionAdapter;
  readonly toolBrokerBridge?: CompositionRuntimeToolBridgeShape;
  readonly toolBrokerCanonicalTools?: ReadonlyArray<string>;
  readonly providerKind?: string;
  readonly displayName?: string;
  readonly getSnapshot?: () => Effect.Effect<{
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly status: "ready" | "warning" | "error" | "disabled";
    readonly availability?: "available" | "unavailable";
    readonly version: string | null;
  }>;
  readonly model?: string;
  readonly runtimeMode?: RuntimeMode;
}

type ProviderProfileSnapshot = {
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: "ready" | "warning" | "error" | "disabled";
  readonly availability?: "available" | "unavailable";
  readonly version: string | null;
};

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const taskThreadId = (taskId: string, runId: string, threadId?: string): ThreadId =>
  ThreadId.make(threadId === undefined ? `composition-${taskId}-${runId}` : threadId);

const makeFailure = (code: string, error: unknown) =>
  new CompositionAgentDriverFailure({ code, detail: errorDetail(error) });

const exactStringSetMatch = (
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean => {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
};

export const makeCompositionProviderAgentDriver = (
  options: CompositionProviderAgentDriverOptions,
): CompositionAgentDriver => {
  const activeRuns = new Map<
    string,
    {
      readonly taskId: string;
      readonly runId: string;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly runtimeTaskId: string;
      readonly capabilityHandshakeId?: string;
    }
  >();
  const runtimeMode = options.runtimeMode ?? "full-access";
  const toolBrokerCanonicalTools = options.toolBrokerCanonicalTools ?? [];

  const getProfile: NonNullable<CompositionAgentDriver["getProfile"]> = () => {
    const snapshotEffect: Effect.Effect<ProviderProfileSnapshot> =
      options.getSnapshot === undefined
        ? Effect.succeed({
            enabled: true,
            installed: true,
            status: "ready" as const,
            version: null,
          } satisfies ProviderProfileSnapshot)
        : options.getSnapshot();
    return snapshotEffect.pipe(
      Effect.map((snapshot): CompositionAgentDriverProfile => {
        const available =
          snapshot.enabled &&
          snapshot.installed &&
          snapshot.status === "ready" &&
          snapshot.availability !== "unavailable";
        const supportsCapabilityHandshake =
          options.adapter.handshakeCapabilities !== undefined &&
          options.adapter.revokeCapabilityHandshake !== undefined;
        const hasToolBrokerBridge =
          options.toolBrokerBridge !== undefined &&
          options.adapter.configureToolBroker !== undefined &&
          options.adapter.clearToolBroker !== undefined &&
          toolBrokerCanonicalTools.length > 0;
        const supportsToolBroker = supportsCapabilityHandshake && hasToolBrokerBridge;
        const canonicalTools = new Set(toolBrokerCanonicalTools);
        const supportsWorkspace =
          supportsToolBroker &&
          (canonicalTools.has("workspace.read_file") || canonicalTools.has("workspace.write_file"));
        const supportsTerminal =
          supportsToolBroker &&
          toolBrokerCanonicalTools.some((name) => name.startsWith("terminal."));
        const supportsGit =
          supportsToolBroker && toolBrokerCanonicalTools.some((name) => name.startsWith("git."));
        const supportsMcp =
          supportsToolBroker && toolBrokerCanonicalTools.some((name) => name.startsWith("mcp."));
        const supportsBrowser =
          supportsToolBroker &&
          toolBrokerCanonicalTools.some((name) => name.startsWith("browser."));
        const supportsIde =
          supportsToolBroker && toolBrokerCanonicalTools.some((name) => name.startsWith("ide."));
        const profileStatus = available
          ? supportsToolBroker
            ? "available"
            : "degraded"
          : snapshot.status === "warning"
            ? "degraded"
            : "unavailable";
        return {
          schemaVersion: 1,
          agentId: options.agentId,
          runtimeId: options.runtimeId,
          driverKind: "provider",
          ...(options.providerKind === undefined ? {} : { providerKind: options.providerKind }),
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          status: profileStatus,
          capabilities: [
            "model",
            "provider.session",
            "provider.turn",
            "provider.cancel",
            "t3.provider_api",
            ...(supportsToolBroker
              ? [
                  "t3.toolbroker",
                  ...(supportsWorkspace ? ["t3.workspace"] : []),
                  ...(supportsTerminal ? ["t3.terminal"] : []),
                  ...(supportsGit ? ["t3.git"] : []),
                  ...(supportsMcp ? ["t3.mcp"] : []),
                  ...(supportsBrowser ? ["t3.browser"] : []),
                  ...(supportsIde ? ["t3.ide"] : []),
                ]
              : []),
          ],
          supportsToolBroker,
          supportsCapabilityHandshake,
          supportsWorkspace,
          supportsTerminal,
          supportsGit,
          supportsMcp,
          supportsBrowser,
          supportsIde,
          supportsProviderApi: true,
          supportsResume: false,
          supportsSquad: false,
          supportsLeader: false,
          supportsTaskGraph: false,
          ...(profileStatus === "available"
            ? {}
            : {
                reasonCode: available
                  ? !hasToolBrokerBridge
                    ? "provider_toolbroker_bridge_unavailable"
                    : "provider_capability_handshake_unsupported"
                  : `provider_${snapshot.status}`,
              }),
        };
      }),
      Effect.orElseSucceed(
        () =>
          ({
            schemaVersion: 1,
            agentId: options.agentId,
            runtimeId: options.runtimeId,
            driverKind: "provider" as const,
            status: "unavailable" as const,
            capabilities: [],
            supportsToolBroker: false,
            supportsCapabilityHandshake: false,
            supportsWorkspace: false,
            supportsTerminal: false,
            supportsGit: false,
            supportsMcp: false,
            supportsBrowser: false,
            supportsIde: false,
            supportsProviderApi: false,
            supportsResume: false,
            supportsSquad: false,
            supportsLeader: false,
            supportsTaskGraph: false,
            reasonCode: "provider_profile_failed",
          }) satisfies CompositionAgentDriverProfile,
      ),
    );
  };

  const startTask: CompositionAgentDriver["startTask"] = (input) =>
    Effect.gen(function* () {
      const prompt = input.prompt?.trim() ?? "";
      if (prompt.length === 0) {
        return yield* new CompositionAgentDriverFailure({
          code: "task_prompt_missing",
          detail: "Composition Agent Driver 需要本次派发的完整 prompt。",
        });
      }
      const threadId = taskThreadId(input.task.taskId, input.run.runId, input.task.threadId);
      const model = input.model ?? options.model;
      const modelSelection: ModelSelection | undefined =
        model === undefined ? undefined : { instanceId: options.providerInstanceId, model };
      const capabilityGrantIds = [...(input.run.capabilityGrantIds ?? [])];
      let capabilityHandshakeId: string | undefined;
      if (capabilityGrantIds.length > 0) {
        const handshake = options.adapter.handshakeCapabilities;
        if (handshake === undefined) {
          return yield* new CompositionAgentDriverFailure({
            code: "provider_capability_handshake_unsupported",
            detail: "Provider 没有提供 capability handshake，拒绝派发带 grant 的任务。",
          });
        }
        const handshakeInput: CompositionRuntimeCapabilityHandshakeRequest = {
          runtimeId: options.runtimeId,
          taskId: input.task.taskId,
          runId: input.run.runId,
          agentId: input.run.agentId,
          capabilityGrantIds,
        };
        const result = yield* handshake(handshakeInput).pipe(
          Effect.mapError((error) => makeFailure("provider_capability_handshake_failed", error)),
        );
        const nowUnixMs = yield* Clock.currentTimeMillis;
        if (
          result.status !== "accepted" ||
          result.handshakeId === undefined ||
          result.runtimeId !== handshakeInput.runtimeId ||
          result.taskId !== handshakeInput.taskId ||
          result.runId !== handshakeInput.runId ||
          result.agentId !== handshakeInput.agentId ||
          !exactStringSetMatch(capabilityGrantIds, result.acceptedGrantIds) ||
          (result.expiresAtUnixMs !== undefined && result.expiresAtUnixMs <= nowUnixMs)
        ) {
          return yield* new CompositionAgentDriverFailure({
            code: result.reasonCode ?? "provider_capability_handshake_rejected",
            detail: "Provider 未接受全部 capability grant。",
          });
        }
        capabilityHandshakeId = result.handshakeId;
      }
      let toolBrokerConfigured = false;
      const cleanupProviderContext = () =>
        Effect.all([
          ...(toolBrokerConfigured && options.adapter.clearToolBroker !== undefined
            ? [options.adapter.clearToolBroker(threadId).pipe(Effect.ignore)]
            : []),
          ...(capabilityHandshakeId !== undefined &&
          options.adapter.revokeCapabilityHandshake !== undefined
            ? [
                options.adapter
                  .revokeCapabilityHandshake({ handshakeId: capabilityHandshakeId })
                  .pipe(Effect.ignore),
              ]
            : []),
        ]).pipe(Effect.asVoid);

      const sessionInput: ProviderSessionStartInput = {
        threadId,
        providerInstanceId: options.providerInstanceId,
        ...(input.workspaceRoot === undefined ? {} : { cwd: input.workspaceRoot }),
        ...(modelSelection === undefined ? {} : { modelSelection }),
        runtimeMode,
        ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
      };
      if (
        options.toolBrokerBridge !== undefined &&
        options.adapter.configureToolBroker !== undefined
      ) {
        if (capabilityHandshakeId === undefined || input.workspaceRoot === undefined) {
          yield* cleanupProviderContext();
          return yield* new CompositionAgentDriverFailure({
            code: "provider_toolbroker_context_missing",
            detail:
              "Provider ToolBroker bridge 要求 workspaceRoot 和已接受的 capability handshake。",
          });
        }
        const context = {
          runtimeId: options.runtimeId,
          taskId: input.task.taskId,
          runId: input.run.runId,
          agentId: input.run.agentId,
          workspaceRoot: input.workspaceRoot,
          capabilityGrantIds,
          capabilityHandshakeId,
          threadId,
        };
        const bridge = makeCompositionProviderToolBrokerBridge({
          runtimeBridge: options.toolBrokerBridge,
          context,
        });
        toolBrokerConfigured = true;
        yield* options.adapter.configureToolBroker({ threadId, bridge, context }).pipe(
          Effect.mapError((error) => makeFailure("provider_toolbroker_configure_failed", error)),
          Effect.tapError(() => cleanupProviderContext()),
        );
      }
      yield* options.adapter.startSession(sessionInput).pipe(
        Effect.mapError((error) => makeFailure("provider_session_start_failed", error)),
        Effect.tapError(() => cleanupProviderContext()),
      );
      const turnInput: ProviderSendTurnInput = {
        threadId,
        input: prompt,
        ...(modelSelection === undefined ? {} : { modelSelection }),
      };
      const turn = yield* options.adapter.sendTurn(turnInput).pipe(
        Effect.mapError((error) => makeFailure("provider_turn_start_failed", error)),
        Effect.tapError(() =>
          Effect.all([
            options.adapter.stopSession(threadId).pipe(Effect.ignore),
            cleanupProviderContext(),
          ]).pipe(Effect.asVoid),
        ),
      );
      const runtimeTaskId = `${options.runtimeId}:${threadId}:${turn.turnId}`;
      activeRuns.set(input.run.runId, {
        taskId: input.task.taskId,
        runId: input.run.runId,
        threadId,
        turnId: turn.turnId,
        runtimeTaskId,
        ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
      });
      return {
        runtimeTaskId,
        ...(capabilityHandshakeId === undefined ? {} : { capabilityHandshakeId }),
      };
    });

  const revokeCapabilityHandshake: CompositionAgentDriver["revokeCapabilityHandshake"] = ({
    task,
    run,
  }) => {
    const active = activeRuns.get(run.runId);
    const threadId = active?.threadId ?? taskThreadId(task.taskId, run.runId, task.threadId);
    const capabilityHandshakeId = active?.capabilityHandshakeId ?? run.capabilityHandshakeId;
    const clear =
      options.adapter.clearToolBroker === undefined
        ? Effect.void
        : options.adapter.clearToolBroker(threadId).pipe(Effect.ignore);
    const removeActiveRun = Effect.sync(() => activeRuns.delete(run.runId));
    if (capabilityHandshakeId === undefined) return clear.pipe(Effect.ensuring(removeActiveRun));
    if (options.adapter.revokeCapabilityHandshake === undefined) {
      return clear.pipe(
        Effect.andThen(
          Effect.fail(
            new CompositionAgentDriverFailure({
              code: "provider_capability_handshake_revoke_unsupported",
              detail: "Provider 没有提供 capability handshake 撤销接口。",
            }),
          ),
        ),
        Effect.ensuring(removeActiveRun),
      );
    }
    return clear.pipe(
      Effect.andThen(
        options.adapter.revokeCapabilityHandshake({ handshakeId: capabilityHandshakeId }),
      ),
      Effect.mapError((error) => makeFailure("provider_capability_handshake_revoke_failed", error)),
      Effect.ensuring(removeActiveRun),
    );
  };

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const active = activeRuns.get(input.run.runId);
      const threadId =
        active?.threadId ?? taskThreadId(input.task.taskId, input.run.runId, input.task.threadId);
      const cleanup = Effect.all([
        options.adapter.stopSession(threadId).pipe(Effect.ignore),
        ...(options.adapter.clearToolBroker === undefined
          ? []
          : [options.adapter.clearToolBroker(threadId).pipe(Effect.ignore)]),
        ...(active?.capabilityHandshakeId === undefined ||
        options.adapter.revokeCapabilityHandshake === undefined
          ? []
          : [
              options.adapter
                .revokeCapabilityHandshake({ handshakeId: active.capabilityHandshakeId })
                .pipe(Effect.ignore),
            ]),
      ]).pipe(Effect.asVoid);
      yield* options.adapter.interruptTurn(threadId, active?.turnId).pipe(
        Effect.mapError((error) => makeFailure("provider_turn_cancel_failed", error)),
        Effect.ensuring(cleanup),
        Effect.ensuring(Effect.sync(() => activeRuns.delete(input.run.runId))),
      );
      return { status: "cancelled" as const };
    });

  return {
    agentId: options.agentId,
    runtimeId: options.runtimeId,
    getProfile,
    startTask,
    revokeCapabilityHandshake,
    cancelTask,
    resolveRuntimeEvent: (event: ProviderRuntimeEvent) => {
      if (
        event.providerInstanceId !== undefined &&
        event.providerInstanceId !== options.providerInstanceId
      ) {
        return undefined;
      }
      for (const active of activeRuns.values()) {
        if (active.threadId !== event.threadId) continue;
        if (event.turnId !== undefined && event.turnId !== active.turnId) continue;
        return {
          taskId: active.taskId,
          runId: active.runId,
          runtimeTaskId: active.runtimeTaskId,
        };
      }
      return undefined;
    },
  };
};
