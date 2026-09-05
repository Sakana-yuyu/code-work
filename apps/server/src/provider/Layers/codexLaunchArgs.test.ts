import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("把 API 配置同时传给探测、会话和辅助生成，不把密钥放入参数", () => {
    const args = resolveCodexLaunchArgs("--enable foo", {
      CODEWORK_CODEX_API_KEY: "fixture-secret",
      CODEWORK_CODEX_BASE_URL: "https://api.example/v1",
    });
    const app = codexAppServerArgs(args);
    const exec = codexExecLaunchArgs(args);
    NodeAssert.deepEqual(app.slice(1), exec);
    NodeAssert.ok(exec.includes('model_providers.codework_api.base_url="https://api.example/v1"'));
    NodeAssert.ok(exec.includes('model_providers.codework_api.env_key="CODEWORK_CODEX_API_KEY"'));
    NodeAssert.ok(exec.includes('model_providers.codework_api.wire_api="responses"'));
    NodeAssert.ok(!args.includes("fixture-secret"));
    NodeAssert.equal(
      resolveCodexLaunchArgs("--enable foo", { CODEWORK_CODEX_BASE_URL: "https://api.example/v1" }),
      "--enable foo",
    );
  });
  it("uses CODEWORK_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { CODEWORK_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when CODEWORK_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { CODEWORK_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { CODEWORK_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});
