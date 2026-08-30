import { ORCHESTRATION_WS_METHODS, ThreadId } from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";
import {
  initialAgentAttachState,
  reduceAgentAttachState,
  type AgentAttachFrame,
} from "./agentControlAttachState.ts";

export interface AgentAttachOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export type AgentAttachFrameHandler = (
  frame: AgentAttachFrame,
) => Effect.Effect<unknown, never, never>;

export class AgentAttachUnavailableError extends Data.TaggedError("AgentAttachUnavailableError")<{
  readonly agentId: string;
  readonly reason: "deleted" | "missing-thread" | "missing-turn" | "stream-ended";
  readonly message: string;
}> {}

const unavailableMessage = (
  agentId: string,
  reason: AgentAttachUnavailableError["reason"],
): string => {
  switch (reason) {
    case "deleted":
      return `Agent '${agentId}' was deleted while attached.`;
    case "missing-thread":
      return `Agent '${agentId}' did not provide an orchestration snapshot.`;
    case "missing-turn":
      return `Agent '${agentId}' has no turn to attach to.`;
    case "stream-ended":
      return `Agent '${agentId}' stream ended before reaching a terminal state.`;
  }
};

const streamEnded = (agentId: string) =>
  new AgentAttachUnavailableError({
    agentId,
    reason: "stream-ended",
    message: unavailableMessage(agentId, "stream-ended"),
  });

export const attachToAgent = (
  options: AgentAttachOptions,
  onFrame: AgentAttachFrameHandler,
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
        Stream.mapAccum(
          () => initialAgentAttachState,
          (state, item) => {
            const reduction = reduceAgentAttachState(state, item);
            return [reduction.state, [reduction]] as const;
          },
        ),
        Stream.mapEffect((reduction) => {
          if (reduction.unavailableReason !== null) {
            return Effect.fail(
              new AgentAttachUnavailableError({
                agentId: options.agentId,
                reason: reduction.unavailableReason,
                message: unavailableMessage(options.agentId, reduction.unavailableReason),
              }),
            );
          }
          return Effect.forEach(reduction.frames, onFrame, { discard: true }).pipe(
            Effect.as(reduction),
          );
        }),
        Stream.takeUntil((reduction) => reduction.done),
        Stream.runLast,
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(streamEnded(options.agentId)),
            onSome: (reduction) =>
              reduction.done ? Effect.void : Effect.fail(streamEnded(options.agentId)),
          }),
        ),
      ),
  );
