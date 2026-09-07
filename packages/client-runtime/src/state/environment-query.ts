import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

export interface EnvironmentQueryStateInput {
  /** App label prefix for devtools atoms, e.g. "web" or "mobile". */
  readonly labelPrefix: string;
  /**
   * Catalog key for the fallback message when a failure carries no usable
   * error message. Deliberately injected: web and mobile catalogs still use
   * different ids for the same string.
   */
  readonly requestFailedKey: string;
  /** App translator; only called without params. */
  readonly t: (key: string) => string;
}

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function createEnvironmentQueryState(input: EnvironmentQueryStateInput) {
  const { labelPrefix, requestFailedKey, t } = input;

  const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
    Atom.withLabel(`${labelPrefix}-environment-query:empty`),
  );

  function formatEnvironmentQueryError(cause: Cause.Cause<unknown>): string {
    const error = Cause.squash(cause);
    return error instanceof Error && error.message.trim().length > 0
      ? error.message
      : t(requestFailedKey);
  }

  function useEnvironmentQuery<A, E>(
    atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
  ): EnvironmentQueryView<A> {
    const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
    const result = useAtomValue(selectedAtom);
    const refresh = useAtomRefresh(selectedAtom);
    return {
      data: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isPending: atom !== null && result.waiting,
      refresh,
    };
  }

  return { formatEnvironmentQueryError, useEnvironmentQuery };
}
