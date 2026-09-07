import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AccountQuotaRequest, AccountQuotaResult } from "./accountQuota.ts";

const decodeRequest = Schema.decodeUnknownSync(AccountQuotaRequest);
const decodeResult = Schema.decodeUnknownSync(AccountQuotaResult);

describe("AccountQuota contracts", () => {
  it("decodes the empty read-only request", () => {
    expect(decodeRequest({})).toEqual({});
  });

  it("decodes a provider state with optional fields absent", () => {
    const result = decodeResult({
      generatedAtUnixMs: 1_767_225_600_000,
      providers: [
        {
          provider: "codex",
          windows: [{ id: "primary", label: "5 hours", status: "ok" }],
          updatedAtUnixMs: 1_767_225_600_000,
        },
      ],
    });
    expect(result.providers[0]?.windows[0]?.status).toBe("ok");
    expect(result.providers[0]?.planName).toBeUndefined();
    expect(result.providers[0]?.windows[0]?.usedFraction).toBeUndefined();
  });

  it("rejects unknown window statuses and negative timestamps", () => {
    expect(() =>
      decodeResult({
        generatedAtUnixMs: 0,
        providers: [
          {
            provider: "codex",
            windows: [{ id: "primary", label: "x", status: "fine" }],
            updatedAtUnixMs: 0,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeResult({
        generatedAtUnixMs: -1,
        providers: [],
      }),
    ).toThrow();
  });
});
