import { ThreadId } from "@t3tools/contracts";
import type {
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
import * as Effect from "effect/Effect";

import type { ProviderServiceError } from "../provider/Errors.ts";
import {
  CompositionAgentDriverFailure,
  type CompositionAgentDriver,
} from "./CompositionOrchestrator.ts";

export interface CompositionProviderSessionAdapter {
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
  readonly model?: string;
  readonly runtimeMode?: RuntimeMode;
}

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const taskThreadId = (taskId: string, runId: string, threadId?: string): ThreadId =>
  ThreadId.make(threadId === undefined ? `composition-${taskId}-${runId}` : threadId);

const makeFailure = (code: string, error: unknown) =>
  new CompositionAgentDriverFailure({ code, detail: errorDetail(error) });

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
    }
  >();
  const runtimeMode = options.runtimeMode ?? "full-access";

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
      const sessionInput: ProviderSessionStartInput = {
        threadId,
        providerInstanceId: options.providerInstanceId,
        ...(input.workspaceRoot === undefined ? {} : { cwd: input.workspaceRoot }),
        ...(modelSelection === undefined ? {} : { modelSelection }),
        runtimeMode,
      };
      yield* options.adapter
        .startSession(sessionInput)
        .pipe(Effect.mapError((error) => makeFailure("provider_session_start_failed", error)));
      const turnInput: ProviderSendTurnInput = {
        threadId,
        input: prompt,
        ...(modelSelection === undefined ? {} : { modelSelection }),
      };
      const turn = yield* options.adapter.sendTurn(turnInput).pipe(
        Effect.mapError((error) => makeFailure("provider_turn_start_failed", error)),
        Effect.tapError(() => options.adapter.stopSession(threadId).pipe(Effect.ignore)),
      );
      const runtimeTaskId = `${options.runtimeId}:${threadId}:${turn.turnId}`;
      activeRuns.set(input.run.runId, {
        taskId: input.task.taskId,
        runId: input.run.runId,
        threadId,
        turnId: turn.turnId,
        runtimeTaskId,
      });
      return { runtimeTaskId };
    });

  const cancelTask: CompositionAgentDriver["cancelTask"] = (input) =>
    Effect.gen(function* () {
      const active = activeRuns.get(input.run.runId);
      const threadId =
        active?.threadId ?? taskThreadId(input.task.taskId, input.run.runId, input.task.threadId);
      yield* options.adapter
        .interruptTurn(threadId, active?.turnId)
        .pipe(Effect.mapError((error) => makeFailure("provider_turn_cancel_failed", error)));
      yield* options.adapter.stopSession(threadId).pipe(Effect.ignore);
      activeRuns.delete(input.run.runId);
      return { status: "cancelled" as const };
    });

  return {
    agentId: options.agentId,
    runtimeId: options.runtimeId,
    startTask,
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
