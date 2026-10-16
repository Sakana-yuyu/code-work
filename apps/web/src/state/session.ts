import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@codework/client-runtime/state/session";
import {
  sessionGrantsScope,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type EnvironmentId,
} from "@codework/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

/**
 * Non-hook variant of `useEnvironmentScope` for upload-queue and other
 * imperative call sites: whether this client's session on one environment
 * carries the given scope, denied until the session state resolves and
 * grants it.
 */
export function readEnvironmentScope(
  environmentId: EnvironmentId,
  scope: AuthEnvironmentScope,
): boolean {
  const session = appAtomRegistry.get(environmentSession.sessionStateValueAtom(environmentId));
  return session !== null && sessionGrantsScope(session, scope);
}

/**
 * This client's authenticated session on one environment, as reported by that
 * environment's `/api/auth/session` endpoint. `data` stays populated across
 * SWR revalidations; `isPending` is only meaningful before the first resolve.
 */
export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}

const EMPTY_SESSION_STATE_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>()).pipe(
  Atom.withLabel("web-session-state:empty"),
);

/**
 * Whether this client's session on one environment carries the given scope.
 * Denied until the session state resolves and grants it, so scope-gated
 * controls stay inert instead of flashing enabled.
 */
export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_SESSION_STATE_ATOM
      : environmentSession.sessionStateAtom(environmentId),
  );
  if (result._tag === "Failure") return false;
  const session = Option.getOrNull(AsyncResult.value(result));
  return session !== null && sessionGrantsScope(session, scope);
}
