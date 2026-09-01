import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ProviderInstanceId,
} from "@codework/contracts";
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
  type AgentRunIdentity,
  type AgentRunRejectionReason,
  type AgentRunResult,
  planAgentRunCommand,
  validateAgentRunInput,
} from "./agentControlRunState.ts";

export interface AgentRunOptions extends ControlConnectionOptions {
  readonly projectId: string;
  readonly prompt: string;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly model?: string;
}

export type AgentRunIdentityFactory = () => Effect.Effect<AgentRunIdentity>;

export class AgentRunSnapshotUnavailableError extends Data.TaggedError(
  "AgentRunSnapshotUnavailableError",
)<{
  readonly projectId: string;
  readonly message: string;
}> {}

export class AgentRunRejectedError extends Data.TaggedError("AgentRunRejectedError")<{
  readonly projectId: string;
  readonly reason: AgentRunRejectionReason;
  readonly message: string;
}> {}

const makeIdentity: AgentRunIdentityFactory = () =>
  DateTime.now.pipe(
    Effect.map((now) => ({
      threadId: ThreadId.make(NodeCrypto.randomUUID()),
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      messageId: MessageId.make(NodeCrypto.randomUUID()),
      createdAt: DateTime.formatIso(now),
    })),
  );

export const runAgent = (
  options: AgentRunOptions,
  open: ControlClientOpen = openControlClient,
  identityFactory: AgentRunIdentityFactory = makeIdentity,
) => {
  const validation = validateAgentRunInput(options);
  if (!validation.ok) {
    return Effect.fail(
      new AgentRunRejectedError({
        projectId: options.projectId,
        reason: validation.reason,
        message: validation.message,
      }),
    );
  }

  return open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      Effect.gen(function* () {
        const snapshot = yield* rpc[ORCHESTRATION_WS_METHODS.subscribeShell]({
          requestCompletionMarker: true,
        }).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.map((item) => item.snapshot),
          Stream.runHead,
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new AgentRunSnapshotUnavailableError({
                    projectId: options.projectId,
                    message: "The server did not provide an orchestration shell snapshot.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
        );
        const identity = yield* identityFactory();
        const plan = planAgentRunCommand(snapshot.projects, options, identity);
        if (!plan.ok) {
          return yield* new AgentRunRejectedError({
            projectId: options.projectId,
            reason: plan.reason,
            message: plan.message,
          });
        }

        const receipt = yield* rpc[ORCHESTRATION_WS_METHODS.dispatchCommand](plan.command);
        return {
          agentId: identity.threadId,
          projectId: plan.projectId,
          commandId: identity.commandId,
          messageId: identity.messageId,
          sequence: receipt.sequence,
          providerInstanceId: plan.modelSelection.instanceId,
          model: plan.modelSelection.model,
          createdAt: identity.createdAt,
        } satisfies AgentRunResult;
      }),
  );
};
