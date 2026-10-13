import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";

import {
  buildGrokModelCapabilities,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const encodeJsonFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAcpRequestLog = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String, params: Schema.Unknown })),
);

const catalogModelState = {
  currentModelId: "grok-current",
  availableModels: [
    {
      modelId: "grok-current",
      name: "Grok Current",
      description: "动态目录中的推理模型",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          { value: "high", label: "High", description: "深度推理", default: true },
          { value: "low", label: "Low" },
        ],
      },
    },
    { modelId: "grok-new-mode", name: "Grok New Mode" },
  ],
};

// 使用真实本地子进程与 ACP 管道；请求落盘后才返回回执，不轮询或等待固定时间。
const probeMockGrokCatalog = Effect.fn("probeMockGrokCatalog")(function* (
  response: { readonly result: unknown } | { readonly error: { code: number; message: string } },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-catalog-" });
  const isWindows = (yield* HostProcessPlatform) === "win32";
  const binaryPath = path.join(dir, isWindows ? "grok.cmd" : "grok");
  const scriptPath = path.join(dir, "agent.cjs");
  const requestLogPath = path.join(dir, "requests.ndjson");
  yield* fs.writeFileString(
    scriptPath,
    `const fs = require("node:fs");
const readline = require("node:readline");
if (process.argv.includes("--version")) {
  process.stdout.write("grok-cli 0.1.300\\n");
} else if (process.argv.includes("inspect")) {
  process.stdout.write('{"skills":[]}\\n');
} else {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    fs.appendFileSync(${encodeJsonFixture(requestLogPath)}, JSON.stringify(request) + "\\n");
    let response;
    if (request.method === "initialize") {
      response = { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
    } else if (request.method === "x.ai/models/list") {
      response = ${encodeJsonFixture(response)};
    } else {
      response = { error: { code: -32601, message: "禁止在目录探测中创建或操作会话" } };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...response }) + "\\n");
  });
}
`,
  );
  const quoteSh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  yield* fs.writeFileString(
    binaryPath,
    isWindows
      ? `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`
      : `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(scriptPath)} "$@"\n`,
  );
  if (!isWindows) {
    yield* fs.chmod(binaryPath, 0o755);
  }
  const snapshot = yield* checkGrokProviderStatus(
    decodeGrokSettings({ enabled: true, binaryPath, customModels: ["grok-custom"] }),
    { ...process.env, XAI_API_KEY: "mock-catalog-key-must-not-authenticate" },
  );
  const requests = (yield* fs.readFileString(requestLogPath))
    .trim()
    .split("\n")
    .map((line) => decodeAcpRequestLog(line));
  return { snapshot, requests };
}, Effect.scoped);

describe("buildGrokModelCapabilities", () => {
  it("preserves ACP-provided reasoning labels and the active default", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
          { value: "low", label: "Low Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
          { id: "low", label: "Low Effort" },
        ],
      },
    ]);
  });

  it("uses raw ACP values when option labels are omitted", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "xhigh",
        reasoningEfforts: [{ value: "xhigh" }, { value: "medium" }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "xhigh",
        options: [
          { id: "xhigh", label: "xhigh" },
          { id: "medium", label: "medium" },
        ],
      },
    ]);
  });

  it("keeps ACP current effort separate from its collapsed advertised default", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "medium",
        reasoningEfforts: [
          { value: "xhigh", label: "Extra High Effort", default: true },
          { value: "high", label: "High Effort", default: true },
          { value: "medium", label: "Medium Effort" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "medium",
        options: [
          { id: "xhigh", label: "Extra High Effort", isDefault: true },
          { id: "high", label: "High Effort" },
          { id: "medium", label: "Medium Effort" },
        ],
      },
    ]);
  });

  it("preserves ACP descriptions and falls back from invalid values to valid ids", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: [
          {
            id: "high",
            value: "not a token",
            label: "High Effort",
            description: "Higher implementation quality",
            default: true,
          },
          { id: "bad id", value: "also invalid", label: "Invalid" },
        ],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        currentValue: "high",
        options: [
          {
            id: "high",
            label: "High Effort",
            description: "Higher implementation quality",
            isDefault: true,
          },
        ],
      },
    ]);
  });

  it("accepts an advertised ACP menu when the support flag is omitted", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        reasoningEffort: "high",
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toHaveLength(1);
  });

  it("honors an explicit ACP opt-out even when a menu is present", () => {
    const capabilities = buildGrokModelCapabilities({
      modelId: "grok-4.6",
      name: "Grok 4.6",
      _meta: {
        supportsReasoningEffort: false,
        reasoningEfforts: [{ value: "high", label: "High Effort", default: true }],
      },
    });

    expect(capabilities.optionDescriptors).toEqual([]);
  });

  it("does not synthesize a reasoning menu when ACP omits it", () => {
    expect(
      buildGrokModelCapabilities({
        modelId: "grok-4.6",
        name: "Grok 4.6",
        _meta: { supportsReasoningEffort: true, reasoningEffort: "xhigh" },
      }).optionDescriptors,
    ).toEqual([]);
  });

  it("keeps non-reasoning Grok models free of reasoning controls", () => {
    expect(
      buildGrokModelCapabilities({ modelId: "grok-build", name: "Grok Build" }).optionDescriptors,
    ).toEqual([]);
  });
});

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Grok is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("目录发现只握手，并保留动态模型及推理参数", () =>
    Effect.gen(function* () {
      const { snapshot, requests } = yield* probeMockGrokCatalog({
        result: { result: catalogModelState },
      });

      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "grok-current",
        "grok-new-mode",
        "grok-custom",
      ]);
      expect(snapshot.models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          currentValue: "high",
          options: [
            { id: "high", label: "High", description: "深度推理", isDefault: true },
            { id: "low", label: "Low" },
          ],
        },
      ]);
      expect(snapshot.models[1]?.capabilities?.optionDescriptors).toEqual([]);
      expect(requests.map((request) => request.method)).toEqual(["initialize", "x.ai/models/list"]);
      expect(requests[1]?.params).toEqual({});
    }),
  );

  for (const [name, response] of [
    [
      "包装错误优先于同时返回的有效模型",
      { result: { result: catalogModelState, error: { message: "secret-catalog-error" } } },
    ],
    ["旧 CLI 未提供目录扩展", { error: { code: -32601, message: "secret-catalog-error" } }],
    ["模型清单畸形", { result: { result: { currentModelId: "model", availableModels: [{}] } } }],
    ["响应缺少结果", { result: {} }],
    ["响应结果为空", { result: { result: null } }],
  ] as const) {
    it.effect(`${name}时保留错误和配置模型且不创建会话`, () =>
      Effect.gen(function* () {
        const { snapshot, requests } = yield* probeMockGrokCatalog(response);
        expect(snapshot.status).toBe("error");
        expect(snapshot.installed).toBe(true);
        expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build", "grok-custom"]);
        expect(snapshot.message).toContain("x.ai/models/list");
        expect(snapshot.message).not.toContain("secret-catalog-error");
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "x.ai/models/list",
        ]);
      }),
    );
  }

  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-version-" });
          const isWindows = (yield* HostProcessPlatform) === "win32";
          const grokPath = path.join(dir, isWindows ? "grok.cmd" : "grok");
          yield* fs.writeFileString(
            grokPath,
            isWindows
              ? ["@echo off", `echo ${secretStderr} 1>&2`, "exit /b 2", ""].join("\r\n")
              : ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          if (!isWindows) {
            yield* fs.chmod(grokPath, 0o755);
          }

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-success-" });
          const isWindows = (yield* HostProcessPlatform) === "win32";
          const grokPath = path.join(dir, isWindows ? "grok.cmd" : "grok");
          yield* fs.writeFileString(
            grokPath,
            isWindows
              ? ["@echo off", "echo grok-cli 0.0.99", "exit /b 0", ""].join("\r\n")
              : ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          if (!isWindows) {
            yield* fs.chmod(grokPath, 0o755);
          }

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP model discovery failed");
    }),
  );
});
