import * as NodeCrypto from "node:crypto";

import { CommandId, ORCHESTRATION_WS_METHODS, ThreadId } from "@codework/contracts";
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
  planAgentArchiveCommand,
  planAgentUnarchiveCommand,
  type AgentArchiveResult,
} from "./agentControlArchiveState.ts";

export interface AgentArchiveOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export interface AgentUnarchiveOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export type AgentArchiveCommandIdFactory = () => CommandId;

export class AgentArchiveSnapshotUnavailableError extends Data.TaggedError(
  "AgentArchiveSnapshotUnavailableError",
)<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class AgentArchiveRejectedError extends Data.TaggedError("AgentArchiveRejectedError")<{
  readonly agentId: string;
  readonly reason: "already-archived";
  readonly message: string;
}> {}

export class AgentUnarchiveRejectedError extends Data.TaggedError("AgentUnarchiveRejectedError")<{
  readonly agentId: string;
  readonly reason: "not-archived";
  readonly message: string;
}> {}

const makeCommandId: AgentArchiveCommandIdFactory = () => CommandId.make(NodeCrypto.randomUUID());

export const archiveAgent = (
  options: AgentArchiveOptions,
  open: ControlClientOpen = openControlClient,
  commandIdFactory: AgentArchiveCommandIdFactory = makeCommandId,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      Effect.gen(function* () {
        const thread = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeThread]({
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
                  new AgentArchiveSnapshotUnavailableError({
                    agentId: options.agentId,
                    message: `Agent '${options.agentId}' did not provide an orchestration snapshot.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const commandId = commandIdFactory();
        const plan = planAgentArchiveCommand(thread, commandId);
        if (!plan.ok) {
          return yield* new AgentArchiveRejectedError({
            agentId: options.agentId,
            reason: plan.reason,
            message: plan.message,
          });
        }

        const receipt = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](plan.command);
        return {
          agentId: options.agentId,
          commandId,
          sequence: receipt.sequence,
        } satisfies AgentArchiveResult;
      }),
  );

export const unarchiveAgent = (
  options: AgentUnarchiveOptions,
  open: ControlClientOpen = openControlClient,
  commandIdFactory: AgentArchiveCommandIdFactory = makeCommandId,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      Effect.gen(function* () {
        const archivedSnapshot = yield* rpc[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({});
        const thread = archivedSnapshot.threads.find(
          (candidate) => candidate.id === options.agentId,
        );
        if (!thread) {
          return yield* new AgentUnarchiveRejectedError({
            agentId: options.agentId,
            reason: "not-archived",
            message: `Agent '${options.agentId}' is not archived.`,
          });
        }
        const commandId = commandIdFactory();
        const plan = planAgentUnarchiveCommand(thread, commandId);
        if (!plan.ok) {
          return yield* new AgentUnarchiveRejectedError({
            agentId: options.agentId,
            reason: plan.reason,
            message: plan.message,
          });
        }

        const receipt = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](plan.command);
        return {
          agentId: options.agentId,
          commandId,
          sequence: receipt.sequence,
        } satisfies AgentArchiveResult;
      }),
  );
