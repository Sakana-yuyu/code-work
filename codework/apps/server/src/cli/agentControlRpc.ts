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
import { toAgentLogsSnapshot, toAgentStatusSnapshot } from "./agentControlState.ts";

export interface AgentTargetOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export class AgentSnapshotUnavailableError extends Data.TaggedError(
  "AgentSnapshotUnavailableError",
)<{
  readonly agentId: string;
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
