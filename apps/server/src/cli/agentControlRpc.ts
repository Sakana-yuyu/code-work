import { ORCHESTRATION_WS_METHODS, ThreadId } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";
import {
  initialAgentStreamState,
  isAgentWaitComplete,
  reduceAgentStreamState,
} from "./agentControlStreamState.ts";
import { toAgentLogsSnapshot, toAgentStatusSnapshot } from "./agentControlState.ts";

export interface AgentTargetOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export interface AgentWaitOptions extends AgentTargetOptions {
  readonly timeoutSeconds?: number;
}

export class AgentSnapshotUnavailableError extends Data.TaggedError(
  "AgentSnapshotUnavailableError",
)<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class AgentWaitUnavailableError extends Data.TaggedError("AgentWaitUnavailableError")<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class AgentWaitTimeoutError extends Data.TaggedError("AgentWaitTimeoutError")<{
  readonly agentId: string;
  readonly timeoutSeconds: number;
  readonly message: string;
}> {}

export const getAgentThreadSnapshot = (
  options: AgentTargetOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: ThreadId.make(options.agentId),
        requestCompletionMarker: true,
      }).pipe(
        Stream.filter((item) => item.kind === "snapshot"),
        Stream.map((item) => item.snapshot.thread),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new AgentSnapshotUnavailableError({
                  agentId: options.agentId,
                  message: `Agent '${options.agentId}' did not provide an orchestration snapshot.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
  );

export const getAgentStatus = (
  options: AgentTargetOptions,
  open: ControlClientOpen = openControlClient,
) => getAgentThreadSnapshot(options, open).pipe(Effect.map(toAgentStatusSnapshot));

export const getAgentLogs = (
  options: AgentTargetOptions,
  open: ControlClientOpen = openControlClient,
) => getAgentThreadSnapshot(options, open).pipe(Effect.map(toAgentLogsSnapshot));

export const waitForAgent = (
  options: AgentWaitOptions,
  open: ControlClientOpen = openControlClient,
) => {
  const wait = open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({
        threadId: ThreadId.make(options.agentId),
        requestCompletionMarker: true,
      }).pipe(
        Stream.scan(initialAgentStreamState, reduceAgentStreamState),
        Stream.mapEffect((state) => {
          if (isAgentWaitComplete(state) && state.thread !== null) {
            return Effect.succeed(Option.some(toAgentStatusSnapshot(state.thread)));
          }
          if (state.deleted) {
            return Effect.fail(
              new AgentWaitUnavailableError({
                agentId: options.agentId,
                message: `Agent '${options.agentId}' was deleted while waiting.`,
              }),
            );
          }
          if (state.synchronized && state.thread?.latestTurn === null) {
            return Effect.fail(
              new AgentWaitUnavailableError({
                agentId: options.agentId,
                message: `Agent '${options.agentId}' has no turn to wait for.`,
              }),
            );
          }
          return Effect.succeed(Option.none());
        }),
        Stream.filter(Option.isSome),
        Stream.map((status) => status.value),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new AgentWaitUnavailableError({
                  agentId: options.agentId,
                  message: `Agent '${options.agentId}' stream ended before reaching a terminal state.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
  );
  if (options.timeoutSeconds === undefined) return wait;

  return wait.pipe(
    Effect.timeout(Duration.seconds(options.timeoutSeconds)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new AgentWaitTimeoutError({
          agentId: options.agentId,
          timeoutSeconds: options.timeoutSeconds!,
          message: `Agent '${options.agentId}' did not finish within ${String(options.timeoutSeconds)} seconds.`,
        }),
      ),
    ),
  );
};
