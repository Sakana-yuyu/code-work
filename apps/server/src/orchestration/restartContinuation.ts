/**
 * restartContinuation - shared predicates for continuing provider work that a
 * server restart or update cut short.
 *
 * The startup reconciler (`reconcileProviderSessions` in
 * `serverRuntimeStartup.ts`) marks a durable continuation intent on the
 * provider session binding (`runtimePayload.restartContinuation`) for sessions
 * that pass `evaluateRestartContinuationEligibility`, then parks the actual
 * recovery behind activation. The provider command reactor drains marked
 * bindings after it subscribes to the domain stream — and again whenever a
 * later reconcile marks another thread — so the intent survives a second
 * restart before provider startup.
 */
import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThread,
  ServerSettings,
  ThreadId,
  TurnId,
} from "@codework/contracts";
import { CommandId, MessageId } from "@codework/contracts";
import { resolveProjectContinueThreadsAfterServerUpdate } from "@codework/shared/projectSettings";

import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory.ts";

export const RESTART_CONTINUATION_PROMPT = "Continue where you left off.";

export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

/** Binding `runtimePayload` key carrying the durable continuation intent. */
export const RESTART_CONTINUATION_PAYLOAD_KEY = "restartContinuation";

export interface RestartContinuationIntent {
  readonly deadTurnId: TurnId | null;
  readonly requestedAt: string;
}

/** Read the durable continuation intent off a binding's runtime payload. */
export const readRestartContinuationIntent = (
  runtimePayload: unknown,
): RestartContinuationIntent | null => {
  if (
    typeof runtimePayload !== "object" ||
    runtimePayload === null ||
    Array.isArray(runtimePayload)
  ) {
    return null;
  }
  const intent = (runtimePayload as Record<string, unknown>)[RESTART_CONTINUATION_PAYLOAD_KEY];
  if (typeof intent !== "object" || intent === null || Array.isArray(intent)) {
    return null;
  }
  const record = intent as Record<string, unknown>;
  return {
    deadTurnId: typeof record.deadTurnId === "string" ? (record.deadTurnId as TurnId) : null,
    requestedAt: typeof record.requestedAt === "string" ? record.requestedAt : "",
  };
};

/**
 * Whether the session row describes work the dead server process was still
 * responsible for: a provider being spawned, a live provider session, or a
 * turn in flight.
 */
export const isRestartDeadProviderSession = (
  session: OrchestrationSession | null,
): session is OrchestrationSession =>
  session !== null &&
  (session.status === "starting" || session.status === "running" || session.activeTurnId !== null);

/** The turn that died with the server, when the rows still show one running. */
export const restartDeadTurnId = (
  session: OrchestrationSession,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): TurnId | null =>
  session.activeTurnId ?? (latestTurn?.state === "running" ? latestTurn.turnId : null);

/** Deterministic ids so a second restart or a retried dispatch stays a no-op. */
export const restartContinuationMessageId = (threadId: ThreadId, deadTurnId: TurnId | null) =>
  MessageId.make(`restart-continuation:${threadId}:${deadTurnId ?? "session"}`);

export const restartContinuationCommandId = (threadId: ThreadId, deadTurnId: TurnId | null) =>
  CommandId.make(`command:restart-continuation:${threadId}:${deadTurnId ?? "session"}`);

export const restartContinuationSessionSetCommandId = (
  threadId: ThreadId,
  deadTurnId: TurnId | null,
) => CommandId.make(`command:restart-continuation-session:${threadId}:${deadTurnId ?? "session"}`);

export type RestartContinuationRejection =
  | "preference-disabled"
  | "thread-archived-or-deleted"
  | "turn-user-stopped"
  | "no-resume-binding"
  | "provider-instance-mismatch";

export type RestartContinuationEligibility =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly rejection: RestartContinuationRejection };

/**
 * Suppression checks for continuing an orphaned session after a restart.
 * Mirrors the reference implementation: the preference must resolve on for
 * the thread's project, the thread must not be archived/deleted, the dead
 * turn must not have been stopped by the user, the persisted binding must
 * carry a native resume cursor, and the thread's selected provider instance
 * must still match the binding.
 */
export function evaluateRestartContinuationEligibility(input: {
  readonly settings: Pick<
    ServerSettings,
    "projectSettingsOverrides" | "continueThreadsAfterServerUpdate"
  >;
  readonly thread: Pick<
    OrchestrationThread,
    "id" | "projectId" | "archivedAt" | "deletedAt" | "modelSelection"
  >;
  readonly session: OrchestrationSession;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null | undefined;
  readonly binding: ProviderRuntimeBinding | undefined;
}): RestartContinuationEligibility {
  const { settings, thread, session, latestTurn, binding } = input;
  const reject = (rejection: RestartContinuationRejection): RestartContinuationEligibility => ({
    allowed: false,
    rejection,
  });

  if (!resolveProjectContinueThreadsAfterServerUpdate(settings, thread.projectId)) {
    return reject("preference-disabled");
  }
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    return reject("thread-archived-or-deleted");
  }
  // The projection marks the turn row interrupted the moment the interrupt
  // request lands, so a user stop recorded before the crash is still visible
  // here even when the session row never settled.
  if (session.status === "interrupted" || latestTurn?.state === "interrupted") {
    return reject("turn-user-stopped");
  }
  if (binding?.providerInstanceId === undefined || binding.resumeCursor == null) {
    return reject("no-resume-binding");
  }
  if (binding.providerInstanceId !== thread.modelSelection.instanceId) {
    return reject("provider-instance-mismatch");
  }
  return { allowed: true };
}
