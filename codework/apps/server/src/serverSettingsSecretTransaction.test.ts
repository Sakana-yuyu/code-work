import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { makeServerSettingsSecretTransaction } from "./serverSettingsSecretTransaction.ts";

const bytes = (...values: ReadonlyArray<number>) => Uint8Array.from(values);

it.effect("Secret 补偿逐字恢复原值与不存在状态", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([
      ["existing", bytes(0, 1, 2, 255)],
      ["removed", bytes(9, 8, 7)],
    ]);
    const originalExisting = values.get("existing")!;
    const compensationOperations: string[] = [];
    let recordingCompensation = false;
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
      set: (name, value) =>
        Effect.sync(() => {
          if (recordingCompensation) compensationOperations.push(`set:${name}`);
          values.set(name, Uint8Array.from(value));
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        }),
      getOrCreateRandom: () => Effect.succeed(bytes(1)),
      remove: (name) =>
        Effect.sync(() => {
          if (recordingCompensation) compensationOperations.push(`remove:${name}`);
          values.delete(name);
        }),
    });
    const transaction = makeServerSettingsSecretTransaction(store);

    yield* transaction.store.set("existing", bytes(3, 4));
    originalExisting[0] = 42;
    yield* transaction.store.set("existing", bytes(5, 6));
    yield* transaction.store.remove("removed");
    yield* transaction.store.set("created", bytes(7, 8));
    recordingCompensation = true;
    yield* transaction.compensate;

    assert.deepEqual([...values.get("existing")!], [0, 1, 2, 255]);
    assert.deepEqual([...values.get("removed")!], [9, 8, 7]);
    assert.isFalse(values.has("created"));
    assert.deepEqual(compensationOperations, ["remove:created", "set:removed", "set:existing"]);
  }),
);
