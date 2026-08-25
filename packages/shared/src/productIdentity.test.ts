import { assert, describe, it } from "vite-plus/test";

import {
  isLegacyProductIdentity,
  PRODUCT_IDENTITY,
  resolveDataDirectoryCandidates,
  resolvePreferredEnv,
  resolveProductDisplayName,
  resolveProductSchemes,
  resolvePrefixedEnv,
} from "./productIdentity.js";

describe("product identity", () => {
  it("uses Code Work display names for every product stage", () => {
    assert.equal(resolveProductDisplayName("development"), "Code Work (Dev)");
    assert.equal(resolveProductDisplayName("nightly"), "Code Work (Nightly)");
    assert.equal(resolveProductDisplayName("preview"), "Code Work (Preview)");
    assert.equal(resolveProductDisplayName("production"), "Code Work (Alpha)");
  });

  it("returns canonical schemes before their legacy aliases", () => {
    assert.deepEqual(resolveProductSchemes("development"), ["codework-dev", "t3code-dev"]);
    assert.deepEqual(resolveProductSchemes("preview"), ["codework-preview", "t3code-preview"]);
    assert.deepEqual(resolveProductSchemes("production"), ["codework", "t3code"]);
    assert.deepEqual(PRODUCT_IDENTITY.legacySchemes, ["t3code", "t3code-dev", "t3code-preview"]);
  });

  it("prefers canonical environment variables and falls back to legacy names", () => {
    assert.equal(
      resolvePreferredEnv(
        { CODEWORK_PORT: " 1234 ", T3CODE_PORT: "5678" },
        "CODEWORK_PORT",
        "T3CODE_PORT",
      ),
      "1234",
    );
    assert.equal(resolvePrefixedEnv({ T3CODE_HOME: " C:/legacy " }, "HOME"), "C:/legacy");
    assert.isUndefined(resolvePrefixedEnv({ CODEWORK_HOME: "  " }, "HOME"));
  });

  it("returns canonical data paths with legacy fallback paths", () => {
    assert.deepEqual(
      resolveDataDirectoryCandidates({
        homeDirectory: "/home/alice",
        isDevelopment: false,
        joinPath: (first: string, ...segments: string[]) => [first, ...segments].join("/"),
      }),
      ["/home/alice/code-work", "/home/alice/t3code"],
    );
  });

  it("recognizes legacy product identity without treating Code Work as legacy", () => {
    assert.isTrue(isLegacyProductIdentity("T3 Code"));
    assert.isTrue(isLegacyProductIdentity("t3code-dev"));
    assert.isFalse(isLegacyProductIdentity("Code Work"));
  });
});
