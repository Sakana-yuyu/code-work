import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  createLocalGatewayKey,
  matchLocalGatewayKey,
  readLocalGatewayKeys,
  revokeLocalGatewayKey,
  rotateLocalGatewayKey,
} from "./LocalGatewayKey.ts";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const store = (): ServerSecretStore["Service"] => {
  const values = new Map<string, Uint8Array>();
  return {
    get: (name) =>
      Effect.yieldNow.pipe(
        Effect.map(() =>
          values.has(name) ? Option.some(Uint8Array.from(values.get(name)!)) : Option.none(),
        ),
      ),
    set: (name, value) =>
      Effect.yieldNow.pipe(
        Effect.andThen(
          Effect.sync(() => {
            values.set(name, Uint8Array.from(value));
          }),
        ),
      ),
    create: (name, value) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32)),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
};

describe("LocalGatewayKey", () => {
  it("creates, rotates and revokes keys without exposing them in the listing", async () => {
    const secretStore = store();
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    const created = await Effect.runPromise(createLocalGatewayKey(secretStore, "agent"));
    expect(created.record.key).toMatch(/^cwk_/u);
    expect(matchLocalGatewayKey(created.records, created.record.key)?.id).toBe(created.record.id);
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    const listed = await Effect.runPromise(readLocalGatewayKeys(secretStore));
    expect(listed[0]?.key).toBe(created.record.key);
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    const rotated = await Effect.runPromise(rotateLocalGatewayKey(secretStore, created.record.id));
    expect(rotated?.record.key).not.toBe(created.record.key);
    expect(matchLocalGatewayKey(rotated?.records ?? [], created.record.key)).toBeUndefined();
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    expect(await Effect.runPromise(revokeLocalGatewayKey(secretStore, created.record.id))).toBe(
      true,
    );
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    expect(await Effect.runPromise(readLocalGatewayKeys(secretStore))).toEqual([]);
  });

  it("serializes concurrent key-ring creations", async () => {
    const secretStore = store();
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    await Effect.runPromise(
      Effect.all(
        [createLocalGatewayKey(secretStore, "first"), createLocalGatewayKey(secretStore, "second")],
        { concurrency: "unbounded" },
      ),
    );
    // eslint-disable-next-line codework/no-manual-effect-runtime-in-tests
    const final = await Effect.runPromise(readLocalGatewayKeys(secretStore));
    expect(final).toHaveLength(2);
  });
});
