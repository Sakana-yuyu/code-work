import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

export class ServerSettingsSecretCompensationError extends Data.TaggedError(
  "ServerSettingsSecretCompensationError",
)<{
  readonly primaryFailure: unknown;
  readonly compensationFailure: unknown;
}> {}

export interface ServerSettingsSecretTransaction {
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly compensate: Effect.Effect<void, ServerSecretStore.SecretStoreError>;
  readonly withCompensationOnFailure: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServerSettingsSecretCompensationError, R>;
}

export const makeServerSettingsSecretTransaction = (
  delegate: ServerSecretStore.ServerSecretStore["Service"],
): ServerSettingsSecretTransaction => {
  const originalByName = new Map<string, Option.Option<Uint8Array>>();
  const mutationOrder: string[] = [];

  const captureOriginal = Effect.fn("ServerSettingsSecretTransaction.captureOriginal")(function* (
    name: string,
  ) {
    if (originalByName.has(name)) return;
    const original = yield* delegate.get(name);
    originalByName.set(
      name,
      Option.map(original, (value) => Uint8Array.from(value)),
    );
    mutationOrder.push(name);
  });

  const store = ServerSecretStore.ServerSecretStore.of({
    ...delegate,
    set: (name, value) =>
      captureOriginal(name).pipe(Effect.andThen(delegate.set(name, Uint8Array.from(value)))),
    remove: (name) => captureOriginal(name).pipe(Effect.andThen(delegate.remove(name))),
  });

  const compensate = Effect.uninterruptible(
    Effect.gen(function* () {
      let failureCause: Cause.Cause<ServerSecretStore.SecretStoreError> | undefined;
      for (const name of mutationOrder.toReversed()) {
        const original = originalByName.get(name);
        if (original === undefined) continue;
        const restored = yield* Effect.exit(
          Option.isSome(original)
            ? delegate.set(name, Uint8Array.from(original.value))
            : delegate.remove(name),
        );
        if (Exit.isFailure(restored)) {
          failureCause =
            failureCause === undefined
              ? restored.cause
              : Cause.combine(failureCause, restored.cause);
        }
      }
      if (failureCause !== undefined) {
        return yield* Effect.failCause(failureCause);
      }
    }),
  );

  const withCompensationOnFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.matchCauseEffect({
        onFailure: (primaryCause) =>
          compensate.pipe(
            Effect.matchCauseEffect({
              onFailure: (compensationCause) =>
                Effect.fail(
                  new ServerSettingsSecretCompensationError({
                    primaryFailure: Cause.squash(primaryCause),
                    compensationFailure: Cause.squash(compensationCause),
                  }),
                ),
              onSuccess: () => Effect.failCause(primaryCause),
            }),
          ),
        onSuccess: Effect.succeed,
      }),
    );

  return { store, compensate, withCompensationOnFailure };
};
