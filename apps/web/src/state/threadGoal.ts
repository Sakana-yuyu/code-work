import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  ThreadGoal,
  ThreadGoalErrorCode,
  ThreadGoalEvent,
  ThreadGoalRpcError,
} from "@codework/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { createEnvironmentThreadGoalAtoms } from "@codework/client-runtime/state/thread-goal";

export const threadGoalEnvironment = createEnvironmentThreadGoalAtoms(connectionAtomRuntime);

const EMPTY_GOAL_RESULT_ATOM = Atom.make(AsyncResult.success<ThreadGoal | null, never>(null)).pipe(
  Atom.withLabel("web-thread-goal:empty"),
);
const EMPTY_GOAL_EVENT_ATOM = Atom.make(
  AsyncResult.success<ThreadGoalEvent, never>(null as never),
).pipe(Atom.withLabel("web-thread-goal-events:empty"));

export function resolveThreadGoalSnapshot(
  queryGoal: ThreadGoal | null,
  event: ThreadGoalEvent | null,
): ThreadGoal | null {
  if (event === null) return queryGoal;
  return event.type === "updated" ? event.goal : null;
}

function readThreadGoalErrorCode(cause: Cause.Cause<unknown>): ThreadGoalErrorCode | null {
  const error = Cause.squash(cause);
  return isThreadGoalRpcError(error) ? error.code : null;
}

function isThreadGoalRpcError(error: unknown): error is ThreadGoalRpcError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ThreadGoalRpcError" &&
    "code" in error
  );
}

export function useThreadGoal(threadRef: ScopedThreadRef | null): {
  readonly goal: ThreadGoal | null;
  readonly errorCode: ThreadGoalErrorCode | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
} {
  const target =
    threadRef === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        };
  const goalResult = useAtomValue(
    target === null ? EMPTY_GOAL_RESULT_ATOM : threadGoalEnvironment.get(target),
  );
  const eventResult = useAtomValue(
    target === null ? EMPTY_GOAL_EVENT_ATOM : threadGoalEnvironment.events(target),
  );
  const refreshGoal = useAtomRefresh(
    target === null ? EMPTY_GOAL_RESULT_ATOM : threadGoalEnvironment.get(target),
  );
  const queryGoal = Option.getOrNull(AsyncResult.value(goalResult));
  const event = Option.getOrNull(AsyncResult.value(eventResult));

  return {
    goal: resolveThreadGoalSnapshot(queryGoal, event),
    errorCode: goalResult._tag === "Failure" ? readThreadGoalErrorCode(goalResult.cause) : null,
    isPending: goalResult.waiting,
    refresh: refreshGoal,
  };
}
