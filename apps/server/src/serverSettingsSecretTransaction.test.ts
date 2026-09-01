import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import {
  makeServerSettingsSecretTransaction,
  ServerSettingsSecretCompensationError,
} from "./serverSettingsSecretTransaction.ts";

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

it.effect("Secret 准备中途失败时逆序恢复全部变更并保留首次原值", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([
      ["existing", bytes(1, 2, 3)],
      ["removed", bytes(4, 5, 6)],
    ]);
    const primaryFailure = new ServerSecretStore.SecretStorePersistError({
      resource: "secret prepare-failure",
      cause: new Error("prepare failed"),
    });
    const compensationOperations: string[] = [];
    let recordingCompensation = false;
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
      set: (name, value) => {
        if (name === "prepare-failure") {
          recordingCompensation = true;
          return Effect.fail(primaryFailure);
        }
        return Effect.sync(() => {
          if (recordingCompensation) compensationOperations.push(`set:${name}`);
          values.set(name, Uint8Array.from(value));
        });
      },
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

    const error = yield* transaction
      .withCompensationOnFailure(
        Effect.gen(function* () {
          yield* transaction.store.set("existing", bytes(7));
          yield* transaction.store.set("existing", bytes(8));
          yield* transaction.store.remove("removed");
          yield* transaction.store.set("created", bytes(9));
          yield* transaction.store.set("prepare-failure", bytes(10));
        }),
      )
      .pipe(Effect.flip);

    assert.strictEqual(error, primaryFailure);
    assert.deepEqual([...values.get("existing")!], [1, 2, 3]);
    assert.deepEqual([...values.get("removed")!], [4, 5, 6]);
    assert.isFalse(values.has("created"));
    assert.isFalse(values.has("prepare-failure"));
    assert.deepEqual(compensationOperations, [
      "remove:prepare-failure",
      "remove:created",
      "set:removed",
      "set:existing",
    ]);
  }),
);

it.effect("Secret 补偿失败时保留主失败与补偿失败并继续恢复其余项", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([
      ["first", bytes(1)],
      ["middle", bytes(2)],
      ["last", bytes(3)],
    ]);
    const primaryFailure = new ServerSecretStore.SecretStorePersistError({
      resource: "secret preparation",
      cause: new Error("primary failure"),
    });
    const compensationFailure = new ServerSecretStore.SecretStorePersistError({
      resource: "secret middle",
      cause: new Error("compensation failure"),
    });
    const compensationOperations: string[] = [];
    let recordingCompensation = false;
    const store = ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.succeed(values.has(name) ? Option.some(values.get(name)!) : Option.none()),
      set: (name, value) => {
        if (recordingCompensation) {
          compensationOperations.push(`set:${name}`);
          if (name === "middle") return Effect.fail(compensationFailure);
        }
        return Effect.sync(() => {
          values.set(name, Uint8Array.from(value));
        });
      },
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

    const error = yield* transaction
      .withCompensationOnFailure(
        Effect.gen(function* () {
          yield* transaction.store.set("first", bytes(11));
          yield* transaction.store.set("middle", bytes(12));
          yield* transaction.store.set("last", bytes(13));
          recordingCompensation = true;
          return yield* primaryFailure;
        }),
      )
      .pipe(Effect.flip);

    assert.instanceOf(error, ServerSettingsSecretCompensationError);
    assert.strictEqual(error.primaryFailure, primaryFailure);
    assert.strictEqual(error.compensationFailure, compensationFailure);
    assert.deepEqual(compensationOperations, ["set:last", "set:middle", "set:first"]);
    assert.deepEqual([...values.get("first")!], [1]);
    assert.deepEqual([...values.get("middle")!], [12]);
    assert.deepEqual([...values.get("last")!], [3]);
  }),
);

it.effect("新建 Secret 的补偿删除失败时继续恢复更早的已有项", () =>
  Effect.gen(function* () {
    const values = new Map<string, Uint8Array>([["existing", bytes(1)]]);
    const primaryFailure = new ServerSecretStore.SecretStorePersistError({
      resource: "secret preparation",
      cause: new Error("primary failure"),
    });
    const compensationFailure = new ServerSecretStore.SecretStoreRemoveError({
      resource: "secret created",
      cause: new Error("remove compensation failure"),
    });
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
      remove: (name) => {
        if (recordingCompensation) {
          compensationOperations.push(`remove:${name}`);
          if (name === "created") return Effect.fail(compensationFailure);
        }
        return Effect.sync(() => {
          values.delete(name);
        });
      },
    });
    const transaction = makeServerSettingsSecretTransaction(store);

    const error = yield* transaction
      .withCompensationOnFailure(
        Effect.gen(function* () {
          yield* transaction.store.set("existing", bytes(2));
          yield* transaction.store.set("created", bytes(3));
          recordingCompensation = true;
          return yield* primaryFailure;
        }),
      )
      .pipe(Effect.flip);

    assert.instanceOf(error, ServerSettingsSecretCompensationError);
    assert.strictEqual(error.primaryFailure, primaryFailure);
    assert.strictEqual(error.compensationFailure, compensationFailure);
    assert.deepEqual(compensationOperations, ["remove:created", "set:existing"]);
    assert.deepEqual([...values.get("existing")!], [1]);
    assert.deepEqual([...values.get("created")!], [3]);
  }),
);
