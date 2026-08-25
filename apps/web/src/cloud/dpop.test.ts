import { verifyDpopProof } from "@t3tools/shared/dpop";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeJwt } from "jose";
import { vi } from "vite-plus/test";

import { createMemoryIndexedDbMigrationDatabase } from "../persistenceIndexedDb";
import {
  browserCryptoLayer,
  createBrowserDpopProof,
  generateBrowserDpopKey,
  migrateDpopDatabase,
} from "./dpop";

describe("browser DPoP storage migration", () => {
  it.effect("copies opaque key records without exposing their contents", () =>
    Effect.gen(function* () {
      const secretKey = yield* generateBrowserDpopKey.pipe(Effect.provide(browserCryptoLayer));
      const legacy = createMemoryIndexedDbMigrationDatabase({
        stores: { keys: [{ key: "relay-dpop-proof-key", value: secretKey }] },
      });
      const canonical = createMemoryIndexedDbMigrationDatabase();
      const report = yield* Effect.promise(() => migrateDpopDatabase({ legacy, canonical }));

      expect(report).toEqual({
        copiedRecords: 1,
        skippedExistingRecords: 0,
        skippedInvalidRecords: 0,
      });
      expect(yield* Effect.promise(() => canonical.listRecords("keys"))).toHaveLength(1);
      expect(report).not.toHaveProperty("privateKey");
    }),
  );

  it.effect("does not alter legacy data if canonical writing fails", () =>
    Effect.gen(function* () {
      const key = yield* generateBrowserDpopKey.pipe(Effect.provide(browserCryptoLayer));
      const legacy = createMemoryIndexedDbMigrationDatabase({
        stores: { keys: [{ key: "relay-dpop-proof-key", value: key }] },
      });
      const canonical = createMemoryIndexedDbMigrationDatabase({ failWrites: true });

      const failure = yield* Effect.promise(() =>
        migrateDpopDatabase({ legacy, canonical }).then(
          () => null,
          (cause) => cause,
        ),
      );
      expect(String(failure)).toContain("migration write failed");
      expect(yield* Effect.promise(() => legacy.listRecords("keys"))).toHaveLength(1);
    }),
  );
});

describe("browser DPoP proofs", () => {
  it.effect("signs relay resource proofs with an access-token hash", () =>
    Effect.gen(function* () {
      vi.stubGlobal("indexedDB", undefined);
      const proofKey = yield* generateBrowserDpopKey;
      const proof = yield* createBrowserDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?ignored=true",
        accessToken: "relay-access-token",
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer));
      const issuedAt = decodeJwt(proof.proof).iat;
      expect(issuedAt).toBeTypeOf("number");

      expect(
        verifyDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          expectedThumbprint: proof.thumbprint,
          expectedAccessToken: "relay-access-token",
          nowEpochSeconds: issuedAt!,
        }),
      ).toMatchObject({ ok: true });
    }),
  );
});
