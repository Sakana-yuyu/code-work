import * as NodeCrypto from "node:crypto";

import { CommandId, ORCHESTRATION_WS_METHODS, ThreadId } from "@codework/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";
import {
  planAgentKillCommand,
  type AgentKillIdentity,
  type AgentKillResult,
} from "./agentControlKillState.ts";

export interface AgentKillOptions extends ControlConnectionOptions {
  readonly agentId: string;
}

export type AgentKillIdentityFactory = () => Effect.Effect<AgentKillIdentity>;

export class AgentKillSnapshotUnavailableError extends Data.TaggedError(
  "AgentKillSnapshotUnavailableError",
)<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class AgentKillRejectedError extends Data.TaggedError("AgentKillRejectedError")<{
  readonly agentId: string;
  readonly reason: "no-active-turn";
  readonly message: string;
}> {}

const makeIdentity: AgentKillIdentityFactory = () =>
  DateTime.now.pipe(
    Effect.map((now) => ({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      createdAt: DateTime.formatIso(now),
    })),
  );

export const killAgent = (
  options: AgentKillOptions,
  open: ControlClientOpen = openControlClient,
  identityFactory: AgentKillIdentityFactory = makeIdentity,
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
                  new AgentKillSnapshotUnavailableError({
                    agentId: options.agentId,
                    message: `Agent '${options.agentId}' did not provide an orchestration snapshot.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const identity = yield* identityFactory();
        const plan = planAgentKillCommand(thread, identity);
        if (!plan.ok) {
          return yield* new AgentKillRejectedError({
            agentId: options.agentId,
            reason: plan.reason,
            message: plan.message,
          });
        }

        const receipt = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](plan.command);
        return {
          agentId: options.agentId,
          turnId: plan.turnId,
          commandId: identity.commandId,
          sequence: receipt.sequence,
          createdAt: identity.createdAt,
        } satisfies AgentKillResult;
      }),
  );
