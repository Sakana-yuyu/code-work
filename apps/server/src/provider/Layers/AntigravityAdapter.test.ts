import { describe, expect, it } from "@effect/vitest";
import { parseAntigravityStreamJson } from "./AntigravityAdapter.ts";
import { resolveConfiguredAntigravityModel } from "./AntigravityProvider.ts";

describe("Antigravity stream-json", () => {
  it("extracts text deltas and ignores non-JSON diagnostics", () => {
    const events = parseAntigravityStreamJson(
      'diagnostic\n{"type":"step_update","text_delta":"hello "}\n{"type":"result","response":"world"}',
    );
    expect(events.map((event) => event.text).filter(Boolean)).toEqual(["hello ", "world"]);
  });

  it("only forwards configured models to avoid unknown-model failures", () => {
    const settings = { customModels: ["agy-fast"] };
    expect(resolveConfiguredAntigravityModel(settings, "agy-fast")).toBe("agy-fast");
    expect(resolveConfiguredAntigravityModel(settings, "gpt-5.6-sol")).toBeUndefined();
    expect(resolveConfiguredAntigravityModel(settings, undefined)).toBeUndefined();
  });
});
