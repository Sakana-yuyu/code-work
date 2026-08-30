import * as NodeCrypto from "node:crypto";

import { CommandId, MessageId, ORCHESTRATION_WS_METHODS, ThreadId } from "@codework/contracts";
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
  planAgentSendCommand,
  type AgentSendIdentity,
  type AgentSendResult,
} from "./agentControlSendState.ts";

export interface AgentSendOptions extends ControlConnectionOptions {
  readonly agentId: string;
  readonly prompt: string;
}

export type AgentSendIdentityFactory = () => Effect.Effect<AgentSendIdentity>;

export class AgentSendSnapshotUnavailableError extends Data.TaggedError(
  "AgentSendSnapshotUnavailableError",
)<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class AgentSendRejectedError extends Data.TaggedError("AgentSendRejectedError")<{
  readonly agentId: string;
  readonly reason: "invalid-prompt" | "archived" | "busy";
  readonly message: string;
}> {}

const makeIdentity: AgentSendIdentityFactory = () =>
  DateTime.now.pipe(
    Effect.map((now) => ({
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      createdAt: DateTime.formatIso(now),
    })),
  );

export const sendToAgent = (
  options: AgentSendOptions,
  open: ControlClientOpen = openControlClient,
  identityFactory: AgentSendIdentityFactory = makeIdentity,
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
                  new AgentSendSnapshotUnavailableError({
                    agentId: options.agentId,
                    message: `Agent '${options.agentId}' did not provide an orchestration snapshot.`,
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const identity = yield* identityFactory();
        const plan = planAgentSendCommand(thread, options.prompt, identity);
        if (!plan.ok) {
          return yield* new AgentSendRejectedError({
            agentId: options.agentId,
            reason: plan.reason,
            message: plan.message,
          });
        }

        const receipt = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](plan.command);
        return {
          agentId: options.agentId,
          commandId: identity.commandId,
          messageId: identity.messageId,
          sequence: receipt.sequence,
          createdAt: identity.createdAt,
        } satisfies AgentSendResult;
      }),
  );
