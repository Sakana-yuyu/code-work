import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type CompositionAgentDriverProfile,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";

import type { ByokAgentTool } from "./ByokAgentLoop.ts";
import type { CompositionAgentServiceShape } from "./CompositionAgentService.ts";
import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";

export type CompositionByokAgentDriverOptions = {
  readonly agentId: string;
  readonly runtimeId: string;
  readonly providerInstanceId: ProviderInstanceId | string;
  readonly providerKind?: string;
  readonly displayName?: string;
  readonly defaultModel?: string;
  readonly agentService: CompositionAgentServiceShape;
  readonly listTools: () => Effect.Effect<ReadonlyArray<ByokAgentTool>, Error>;
};

type ActiveRun = {
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeTaskId: string;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  fiber: Fiber.Fiber<void, unknown>;
  readonly abortController: AbortController;
  terminalOwner: "completion" | "cancellation" | undefined;
};

type CompletedRun = Omit<ActiveRun, "fiber" | "abortController" | "terminalOwner">;

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const runtimeTaskIdFor = (runtimeId: string, taskId: string, runId: string): string =>
  `${runtimeId}:task:${taskId}:${runId}`;

const threadIdFor = (taskId: string, runId: string): ThreadId =>
  ThreadId.make(`composition-${taskId}-${runId}`);

const turnIdFor = (taskId: string, runId: string): TurnId =>
  TurnId.make(`composition-turn-${taskId}-${runId}`);

const nowIso = (): string => DateTime.formatIso(DateTime.nowUnsafe());

const claimTerminal = (
  active: ActiveRun,
  owner: NonNullable<ActiveRun["terminalOwner"]>,
): boolean => {
  if (active.terminalOwner !== undefined) return false;
  active.terminalOwner = owner;
  return true;
};

/** 只接受由本地 BYOK Loop 写入的关联元数据，禁止从 threadId 推测 Composition Run。 */
const persistedByokRuntimeCorrelation = (
  options: Pick<CompositionByokAgentDriverOptions, "runtimeId" | "providerInstanceId">,
  event: ProviderRuntimeEvent,
): { readonly runtimeId: string; readonly runtimeTaskId: string } | undefined => {
  const raw = event.raw;
  if (
    event.provider !== ProviderDriverKind.make("byok") ||
    event.providerInstanceId !== ProviderInstanceId.make(String(options.providerInstanceId)) ||
    raw?.source !== "composition.byok.agent-loop" ||
    raw.runtimeId !== options.runtimeId ||
    raw.runtimeTaskId === undefined
  ) {
    return undefined;
  }
  return { runtimeId: options.runtimeId, runtimeTaskId: raw.runtimeTaskId };
};

export const makeCompositionByokAgentDriver = (
  options: CompositionByokAgentDriverOptions,
): CompositionAgentDriver => {
  const events = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const activeRuns = new Map<string, ActiveRun>();
  const completedRuns = new Map<string, CompletedRun>();
  let eventSequence = 0;

  const publish = (
    event: Omit<ProviderRuntimeEvent, "eventId" | "createdAt">,
  ): Effect.Effect<void> => {
    eventSequence += 1;
    return PubSub.publish(events, {
      ...event,
      eventId: EventId.make(`byok-${options.runtimeId}-${eventSequence}`),
      createdAt: nowIso(),
    } as ProviderRuntimeEvent).pipe(Effect.asVoid);
  };

  const profile = (): Effect.Effect<CompositionAgentDriverProfile> =>
    Effect.gen(function* () {
      const tools = yield* options.listTools();
      const toolNames = new Set(tools.map((tool) => tool.canonicalToolName));
      const supportsWorkspace =
        toolNames.has("workspace.read_file") || toolNames.has("workspace.write_file");
      const supportsTerminal = [...toolNames].some((name) => name.startsWith("terminal."));
      const supportsGit = [...toolNames].some((name) => name.startsWith("git."));
      const supportsMcp = [...toolNames].some((name) => name.startsWith("mcp."));
      const supportsIde = toolNames.has("ide.invoke");
      const available: CompositionAgentDriverProfile = {
        schemaVersion: 1,
        agentId: options.agentId,
        runtimeId: options.runtimeId,
        driverKind: "provider" as const,
        providerKind: options.providerKind ?? "byok",
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        status: "available" as const,
        capabilities: [
          "model",
          "byok.agent_loop",
          "t3.toolbroker",
          ...(supportsWorkspace ? ["t3.workspace"] : []),
          ...(supportsTerminal ? ["t3.terminal"] : []),
          ...(supportsGit ? ["t3.git"] : []),
          ...(supportsMcp ? ["t3.mcp"] : []),
          ...(supportsIde ? ["t3.ide"] : []),
          "t3.provider_api",
        ],
        supportsToolBroker: true,
        supportsCapabilityHandshake: false,
        supportsWorkspace,
        supportsTerminal,
        supportsGit,
        supportsMcp,
        supportsBrowser: false,
        supportsIde,
        supportsProviderApi: true,
        supportsResume: false,
        supportsSquad: false,
        supportsLeader: false,
        supportsTaskGraph: false,
      };
      return available;
    }).pipe(
      Effect.orElseSucceed(
        (): CompositionAgentDriverProfile => ({
          schemaVersion: 1,
          agentId: options.agentId,
          runtimeId: options.runtimeId,
          driverKind: "provider" as const,
          providerKind: options.providerKind ?? "byok",
          ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
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
          reasonCode: "byok_tool_catalog_failed",
        }),
      ),
    );

  const startTask: CompositionAgentDriver["startTask"] = (input) =>
    Effect.gen(function* () {
      const prompt = input.prompt?.trim() ?? "";
      if (prompt.length === 0) {
        return yield* new CompositionAgentDriverFailure({
          code: "task_prompt_missing",
          detail: "BYOK Agent Driver 需要本次派发的完整 prompt。",
        });
      }
      const modelId = input.model?.trim() || options.defaultModel?.trim();
      if (modelId === undefined || modelId.length === 0) {
        return yield* new CompositionAgentDriverFailure({
          code: "byok_model_missing",
          detail: "BYOK Agent Driver 需要显式 model 或已配置的默认 model。",
        });
      }
      const workspaceRoot = input.workspaceRoot?.trim() ?? "";
      if (workspaceRoot.length === 0) {
        return yield* new CompositionAgentDriverFailure({
          code: "workspace_root_missing",
          detail: "BYOK Agent Driver 需要可信 workspaceRoot。",
        });
      }

      const existing = activeRuns.get(input.run.runId);
      if (existing !== undefined) {
        return { runtimeTaskId: existing.runtimeTaskId };
      }

      const threadId = threadIdFor(input.task.taskId, input.run.runId);
      const turnId = turnIdFor(input.task.taskId, input.run.runId);
      const runtimeTaskId = runtimeTaskIdFor(options.runtimeId, input.task.taskId, input.run.runId);
      const raw = {
        source: "composition.byok.agent-loop" as const,
        runtimeId: options.runtimeId,
        runtimeTaskId,
        payload: {},
      };
      const context = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(context);
      const completed = {
        taskId: input.task.taskId,
        runId: input.run.runId,
        runtimeTaskId,
        threadId,
        turnId,
      } satisfies CompletedRun;
      const abortController = new AbortController();
      const active: ActiveRun = {
        taskId: input.task.taskId,
        runId: input.run.runId,
        runtimeTaskId,
        threadId,
        turnId,
        fiber: undefined as unknown as Fiber.Fiber<void, unknown>,
        abortController,
        terminalOwner: undefined,
      };
      const run = Effect.gen(function* () {
        // 让 Orchestrator 先完成 running 投影，再接收本地 Loop 的第一条事件。
        yield* Effect.yieldNow;
        yield* publish({
          provider: ProviderDriverKind.make("byok"),
          providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
          threadId,
          turnId,
          type: "turn.started",
          payload: { model: modelId },
          raw,
        });
        const tools = yield* options.listTools();
        const result = yield* options.agentService.run({
          providerInstanceId: String(options.providerInstanceId),
          runtimeId: options.runtimeId,
          modelId,
          taskId: input.task.taskId,
          runId: input.run.runId,
          agentId: input.run.agentId,
          workspaceRoot,
          prompt,
          capabilityGrantIds: [...(input.run.capabilityGrantIds ?? [])],
          tools,
          signal: abortController.signal,
        });
        if (!claimTerminal(active, "completion")) return;
        if (result.text.length > 0) {
          yield* publish({
            provider: ProviderDriverKind.make("byok"),
            providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
            threadId,
            turnId,
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: result.text },
            raw,
          });
        }
        completedRuns.set(input.run.runId, completed);
        yield* publish({
          provider: ProviderDriverKind.make("byok"),
          providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
          threadId,
          turnId,
          type: "turn.completed",
          payload: { state: "completed", stopReason: "agent_loop_completed" },
          raw,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.gen(function* () {
                if (!claimTerminal(active, "completion")) return;
                const detail = errorDetail(cause);
                completedRuns.set(input.run.runId, completed);
                yield* publish({
                  provider: ProviderDriverKind.make("byok"),
                  providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
                  threadId,
                  turnId,
                  type: "runtime.error",
                  payload: { message: detail, class: "provider_error" },
                  raw,
                });
                yield* publish({
                  provider: ProviderDriverKind.make("byok"),
                  providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
                  threadId,
                  turnId,
                  type: "turn.completed",
                  payload: { state: "failed", errorMessage: detail },
                  raw,
                });
              }),
        ),
      );
      activeRuns.set(input.run.runId, active);
      const fiber = runFork(
        run.pipe(Effect.ensuring(Effect.sync(() => activeRuns.delete(input.run.runId)))),
      );
      active.fiber = fiber;
      return { runtimeTaskId };
    });

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const active = activeRuns.get(input.run.runId);
      if (active === undefined) {
        return { status: "already_terminal" as const };
      }
      if (!claimTerminal(active, "cancellation")) {
        return { status: "already_terminal" as const };
      }
      active.abortController.abort(input.reason);
      yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
      completedRuns.set(input.run.runId, {
        taskId: active.taskId,
        runId: active.runId,
        runtimeTaskId: active.runtimeTaskId,
        threadId: active.threadId,
        turnId: active.turnId,
      });
      yield* publish({
        provider: ProviderDriverKind.make("byok"),
        providerInstanceId: ProviderInstanceId.make(String(options.providerInstanceId)),
        threadId: active.threadId,
        turnId: active.turnId,
        type: "turn.aborted",
        payload: { reason: input.reason },
        raw: {
          source: "composition.byok.agent-loop",
          runtimeId: options.runtimeId,
          runtimeTaskId: active.runtimeTaskId,
          payload: {},
        },
      });
      activeRuns.delete(input.run.runId);
      return { status: "cancelled" as const };
    });

  return {
    agentId: options.agentId,
    runtimeId: options.runtimeId,
    getProfile: profile,
    startTask,
    cancelTask,
    streamEvents: () => Stream.fromPubSub(events),
    resolveRuntimeEvent: (event) => {
      if (
        event.providerInstanceId !== undefined &&
        event.providerInstanceId !== ProviderInstanceId.make(String(options.providerInstanceId))
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
      for (const completed of completedRuns.values()) {
        if (completed.threadId !== event.threadId) continue;
        if (event.turnId !== undefined && event.turnId !== completed.turnId) continue;
        return {
          taskId: completed.taskId,
          runId: completed.runId,
          runtimeTaskId: completed.runtimeTaskId,
        };
      }
      return undefined;
    },
    resolvePersistedRuntimeEvent: (event) => persistedByokRuntimeCorrelation(options, event),
  };
};
