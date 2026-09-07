import type { EnvironmentId, ThreadId } from "@codework/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "./threads.ts";

type ShellFactoryInput = Parameters<typeof createEnvironmentThreadShellAtoms>[0];

export interface EnvironmentThreadViewInput<R, E> {
  /** The app's connection atom runtime. */
  readonly runtime: Atom.AtomRuntime<
    EnvironmentRegistry | Crypto.Crypto | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >;
  /** Shell inputs built from the app's environment catalog and shell state. */
  readonly catalogValueAtom: ShellFactoryInput["catalogValueAtom"];
  readonly snapshotAtom: ShellFactoryInput["snapshotAtom"];
  /** App label prefix for devtools atoms, e.g. "web" or "mobile". */
  readonly labelPrefix: string;
}

/**
 * One wiring point for the per-environment thread view every client app
 * mounts: the four atom bundles plus the fallback hook, so the apps cannot
 * drift in how they assemble them.
 */
export function createEnvironmentThreadView<R, E>(input: EnvironmentThreadViewInput<R, E>) {
  const threadEnvironment = createThreadEnvironmentAtoms(input.runtime);
  const environmentThreads = createEnvironmentThreadStateAtoms(input.runtime);
  const environmentThreadDetails = createEnvironmentThreadDetailAtoms(environmentThreads.stateAtom);
  const environmentThreadShells = createEnvironmentThreadShellAtoms({
    catalogValueAtom: input.catalogValueAtom,
    snapshotAtom: input.snapshotAtom,
  });

  const EMPTY_THREAD_STATE_ATOM = Atom.make(
    AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE),
  ).pipe(Atom.withLabel(`${input.labelPrefix}-environment-thread:empty`));

  function useEnvironmentThread(
    environmentId: EnvironmentId | null,
    threadId: ThreadId | null,
  ): EnvironmentThreadState {
    const result = useAtomValue(
      environmentId !== null && threadId !== null
        ? environmentThreads.stateAtom(environmentId, threadId)
        : EMPTY_THREAD_STATE_ATOM,
    );
    return Option.getOrElse(
      AsyncResult.value(result),
      () => EMPTY_ENVIRONMENT_THREAD_STATE,
    ) as EnvironmentThreadState;
  }

  return {
    threadEnvironment,
    environmentThreads,
    environmentThreadDetails,
    environmentThreadShells,
    useEnvironmentThread,
  };
}
