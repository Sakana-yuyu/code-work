import { describe, expect, it } from "vite-plus/test";

import { decodeAllowedLocalPluginManifest, LocalPluginPolicyError } from "./localPluginPolicy";

const baseManifest = {
  manifestVersion: 1,
  apiVersion: { major: 1, minor: 0 },
  id: "acme.policy",
  name: "策略测试",
  version: "1.0.0",
  permissions: [],
  contributions: {},
} as const;

describe("localPluginPolicy", () => {
  it("区分 schema、API 和语义拒绝", () => {
    expect(() => decodeAllowedLocalPluginManifest({ ...baseManifest, manifestVersion: 2 })).toThrow(
      expect.objectContaining<Partial<LocalPluginPolicyError>>({ code: "schema-invalid" }),
    );
    expect(() =>
      decodeAllowedLocalPluginManifest({ ...baseManifest, apiVersion: { major: 2, minor: 0 } }),
    ).toThrow(
      expect.objectContaining<Partial<LocalPluginPolicyError>>({ code: "api-incompatible" }),
    );
    expect(() =>
      decodeAllowedLocalPluginManifest({
        ...baseManifest,
        contributions: {
          commands: [
            {
              id: "write",
              title: "写入",
              action: { type: "composer.prompt.insert", text: "内容" },
            },
          ],
        },
      }),
    ).toThrow(
      expect.objectContaining<Partial<LocalPluginPolicyError>>({ code: "manifest-invalid" }),
    );
  });
});
