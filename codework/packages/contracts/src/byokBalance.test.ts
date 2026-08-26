import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ByokBalanceRequest, ByokBalanceResult } from "./byokBalance.ts";

const decodeRequest = Schema.decodeUnknownSync(ByokBalanceRequest);
const decodeResult = Schema.decodeUnknownSync(ByokBalanceResult);

describe("ByokBalance contracts", () => {
  it("decodes a minimal request without optional fields", () => {
    expect(decodeRequest({ instanceId: "instance-1", adapterId: "adapter-1" })).toEqual({
      instanceId: "instance-1",
      adapterId: "adapter-1",
    });
  });

  it("accepts forceRefresh", () => {
    expect(
      decodeRequest({ instanceId: "instance-1", adapterId: "adapter-1", forceRefresh: true }),
    ).toMatchObject({ forceRefresh: true });
  });

  it("decodes a normalized success result and rejects unknown error codes", () => {
    const success = decodeResult({
      instanceId: "instance-1",
      adapterId: "adapter-1",
      supported: true,
      source: "newapi",
      currency: "USD",
      unlimited: false,
      remaining: 12.5,
      windows: [{ id: "w", label: "Window", unit: "USD", status: "ok" }],
      message: "ok",
      transient: false,
    });
    expect(success.remaining).toBe(12.5);

    expect(() =>
      decodeResult({
        instanceId: "instance-1",
        adapterId: "adapter-1",
        supported: false,
        source: "manual",
        currency: "",
        unlimited: false,
        windows: [],
        message: "failed",
        transient: false,
        error: { code: "totally_unknown", message: "boom" },
      }),
    ).toThrow();
  });
});
