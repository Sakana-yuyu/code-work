import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

export interface ServerSettingsSecretTransaction {
  readonly store: ServerSecretStore.ServerSecretStore["Service"];
  readonly compensate: Effect.Effect<void, ServerSecretStore.SecretStoreError>;
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

  const compensate = Effect.gen(function* () {
    for (const name of mutationOrder.toReversed()) {
      const original = originalByName.get(name);
      if (original === undefined) continue;
      if (Option.isSome(original)) {
        yield* delegate.set(name, Uint8Array.from(original.value));
      } else {
        yield* delegate.remove(name);
      }
    }
  });

  return { store, compensate };
};
