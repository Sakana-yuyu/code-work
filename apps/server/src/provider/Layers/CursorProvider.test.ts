import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/schema";
import type { CursorSettings } from "@codework/contracts";
import { createModelCapabilities } from "@codework/shared/model";
import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@codework/shared/hostProcess";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";

import {
  buildCursorProviderSnapshot,
  buildCursorCapabilitiesFromConfigOptions,
  checkCursorProviderStatus,
  discoverCursorModelsViaAcp,
  getCursorFallbackModels,
  getCursorParameterizedModelPickerUnsupportedMessage,
  parseCursorAboutOutput,
  parseCursorCliConfigChannel,
  parseCursorVersionDate,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "./CursorProvider.ts";

const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const decodeRequestMethod = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ method: Schema.String })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeProbeExecution = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      args: Schema.Array(Schema.String),
      cwd: Schema.String,
      marker: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    }),
  ),
);

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string, currentValue?: boolean) {
  return {
    id,
    label,
    type: "boolean" as const,
    ...(typeof currentValue === "boolean" ? { currentValue } : {}),
  };
}

const makeMockAgentWrapper = Effect.fn("makeMockAgentWrapper")(function* (
  extraEnv?: Record<string, string>,
  withAbout = false,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mockAgentPath = yield* resolveMockAgentPath();
  const dir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-mock-",
  });
  // oxlint-disable-next-line codework/no-global-process-runtime -- 测试启动器必须匹配实际宿主 shell。
  const isWindows = process.platform === "win32";
  const wrapperPath = path.join(dir, isWindows ? "fake-agent.cmd" : "fake-agent.sh");
  const bootstrapPath = path.join(dir, "fake-agent-bootstrap.mjs");
  yield* fileSystem.writeFileString(
    bootstrapPath,
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      `Object.assign(process.env, ${encodeJson(extraEnv ?? {})});`,
      'if (process.env.CODEWORK_CURSOR_PROBE_LOG_PATH) appendFileSync(process.env.CODEWORK_CURSOR_PROBE_LOG_PATH, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.CODEWORK_CURSOR_PROBE_MARKER, path: process.env.PATH ?? process.env.Path }) + "\\n");',
      ...(withAbout
        ? [
            `if (process.argv[2] === "about") {`,
            `  console.log(process.env.CODEWORK_CURSOR_ABOUT_PATH ? readFileSync(process.env.CODEWORK_CURSOR_ABOUT_PATH, "utf8") : "CLI Version         2026.04.09-f2b0fcd\\nUser Email          cursor@example.com");`,
            `  process.exit(0);`,
            `}`,
          ]
        : []),
      `await import(${encodeJson((yield* path.toFileUrl(mockAgentPath)).href)});`,
      "",
    ].join("\n"),
  );
  const script = isWindows
    ? `@echo off\n"${process.execPath}" "${bootstrapPath}" %*\nexit /b %ERRORLEVEL%\n`
    : `#!/bin/sh\nexec ${encodeJson(process.execPath)} ${encodeJson(bootstrapPath)} "$@"\n`;
  yield* fileSystem.writeFileString(wrapperPath, script);
  if (!isWindows) yield* fileSystem.chmod(wrapperPath, 0o755);
  return wrapperPath;
});

const makeProviderStatusEnvFixture = Effect.fn("makeProviderStatusEnvFixture")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fileSystem.makeTempDirectory({
    directory: NodeOS.tmpdir(),
    prefix: "cursor-provider-status-env-",
  });
  return {
    requestLogPath: path.join(tempDir, "requests.ndjson"),
    wrapperPath: yield* makeMockAgentWrapper(undefined, true),
  };
});

const makeCatalogFixture = Effect.fn("makeCatalogFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cursor-catalog-cache-" });
  const firstCwd = path.join(dir, "first");
  const secondCwd = path.join(dir, "second");
  yield* fs.makeDirectory(firstCwd);
  yield* fs.makeDirectory(secondCwd);
  const requestLogPath = path.join(dir, "requests.ndjson");
  const executionLogPath = path.join(dir, "executions.ndjson");
  const aboutPath = path.join(dir, "about.json");
  yield* fs.writeFileString(requestLogPath, "");
  yield* fs.writeFileString(executionLogPath, "");
  yield* fs.writeFileString(
    aboutPath,
    encodeJson({ cliVersion: "2026.04.09-first", userEmail: "first@example.com" }),
  );
  const environment = {
    ...(yield* HostProcessEnvironment),
    CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath,
    CODEWORK_CURSOR_PROBE_LOG_PATH: executionLogPath,
    CODEWORK_CURSOR_ABOUT_PATH: aboutPath,
    CODEWORK_CURSOR_PROBE_MARKER: "first",
  };
  const settings: CursorSettings = {
    enabled: true,
    binaryPath: yield* makeMockAgentWrapper(undefined, true),
    apiEndpoint: "",
    customModels: [],
  };
  return {
    fs,
    firstCwd,
    secondCwd,
    requestLogPath,
    executionLogPath,
    aboutPath,
    environment,
    settings,
  };
});

const readCatalogMethods = Effect.fn("readCatalogMethods")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(filePath);
  return yield* Effect.forEach(text.trim().split("\n").filter(Boolean), (line) =>
    decodeRequestMethod(line).pipe(Effect.map((request) => request.method)),
  );
});

const parameterizedGpt54ConfigOptions = [
  {
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ name: "GPT-5.4", value: "gpt-5.4-medium-fast" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "medium",
    options: [
      { name: "None", value: "none" },
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Extra High", value: "extra-high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "272k",
    options: [
      { name: "272K", value: "272k" },
      { name: "1M", value: "1m" },
    ],
    category: "model_config",
    id: "context",
    name: "Context",
  },
  {
    type: "select",
    currentValue: "false",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeConfigOptions = [
  {
    type: "select",
    currentValue: "claude-4.6-opus-high-thinking",
    options: [{ name: "Opus 4.6", value: "claude-4.6-opus-high-thinking" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "boolean",
    currentValue: true,
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const parameterizedClaudeModelOptionConfigOptions = [
  {
    type: "select",
    currentValue: "claude-opus-4-6",
    options: [{ name: "Opus 4.6", value: "claude-opus-4-6" }],
    category: "model",
    id: "model",
    name: "Model",
  },
  {
    type: "select",
    currentValue: "high",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
    ],
    category: "thought_level",
    id: "reasoning",
    name: "Reasoning",
  },
  {
    type: "select",
    currentValue: "max",
    options: [
      { name: "Low", value: "low" },
      { name: "Medium", value: "medium" },
      { name: "High", value: "high" },
      { name: "Max", value: "max" },
    ],
    category: "model_option",
    id: "effort",
    name: "Effort",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: "Fast", value: "true" },
    ],
    category: "model_config",
    id: "fast",
    name: "Fast",
  },
  {
    type: "select",
    currentValue: "true",
    options: [
      { name: "Off", value: "false" },
      { name: ":icon-brain:", value: "true" },
    ],
    category: "model_config",
    id: "thinking",
    name: "Thinking",
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

const baseCursorSettings: CursorSettings = {
  enabled: true,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
};
const cursorAcpDiscoveryFailedMessage = [
  "Cursor ACP model discovery failed.",
  "Cursor CLI setup may be incomplete; install or enable the Cursor CLI, restart Code Work, and try again.",
  "See https://cursor.com/docs/cli/installation.",
  "Check server logs for ACP details.",
].join(" ");
const missingCursorBinaryPath = "/definitely/not/installed/codework-cursor-agent";
const cursorCliCommandMissingMessage = [
  `Cursor CLI command \`${missingCursorBinaryPath}\` was not found.`,
  `Install or enable the Cursor CLI, make sure \`${missingCursorBinaryPath}\` is on PATH, then restart Code Work.`,
  "See https://cursor.com/docs/cli/installation.",
].join(" ");

describe("getCursorFallbackModels", () => {
  it("does not publish any built-in cursor models before ACP discovery", () => {
    expect(
      getCursorFallbackModels({
        customModels: ["internal/cursor-model"],
      }).map((model) => model.slug),
    ).toEqual(["internal/cursor-model"]);
  });
});

describe("buildCursorProviderSnapshot", () => {
  it("downgrades ready status to warning when ACP model discovery times out", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: baseCursorSettings,
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "ready",
          auth: { status: "authenticated", type: "Team", label: "Cursor Team Subscription" },
        },
        discoveryWarning: "Cursor ACP model discovery timed out after 15000ms.",
      }),
    ).toMatchObject({
      status: "warning",
      message: "Cursor ACP model discovery timed out after 15000ms.",
      models: [],
    });
  });

  it("preserves provider error state while appending discovery warnings", () => {
    expect(
      buildCursorProviderSnapshot({
        checkedAt: "2026-01-01T00:00:00.000Z",
        cursorSettings: {
          ...baseCursorSettings,
          customModels: ["claude-sonnet-4-6"],
        },
        parsed: {
          version: "2026.04.09-f2b0fcd",
          status: "error",
          auth: { status: "unauthenticated" },
          message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
        },
        discoveryWarning: cursorAcpDiscoveryFailedMessage,
      }),
    ).toMatchObject({
      status: "error",
      message: `Cursor Agent is not authenticated. Run \`agent login\` and try again. ${cursorAcpDiscoveryFailedMessage}`,
      models: [
        {
          slug: "claude-sonnet-4-6",
          isCustom: true,
        },
      ],
    });
  });
});

describe("buildCursorCapabilitiesFromConfigOptions", () => {
  it("derives model capabilities from parameterized Cursor ACP config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedGpt54ConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra High" },
          ]),
          selectDescriptor("contextWindow", "Context", [
            { id: "272k", label: "272K", isDefault: true },
            { id: "1m", label: "1M" },
          ]),
          booleanDescriptor("fastMode", "Fast", false),
        ],
      }),
    );
  });

  it("detects boolean thinking toggles from model_config options", () => {
    expect(buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeConfigOptions)).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Reasoning", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
          ]),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });

  it("prefers the newer model_option effort control over legacy thought_level", () => {
    expect(
      buildCursorCapabilitiesFromConfigOptions(parameterizedClaudeModelOptionConfigOptions),
    ).toEqual(
      createModelCapabilities({
        optionDescriptors: [
          selectDescriptor("reasoning", "Effort", [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "max", label: "Max", isDefault: true },
          ]),
          booleanDescriptor("fastMode", "Fast", true),
          booleanDescriptor("thinking", "Thinking", true),
        ],
      }),
    );
  });
});

describe("checkCursorProviderStatus", () => {
  it("reports the install docs when the Cursor CLI command is missing", async () => {
    const provider = await runNode(
      checkCursorProviderStatus({
        enabled: true,
        binaryPath: missingCursorBinaryPath,
        apiEndpoint: "",
        customModels: [],
      }),
    );

    expect(provider).toMatchObject({
      installed: false,
      status: "error",
      auth: { status: "unknown" },
      message: cursorCliCommandMissingMessage,
    });
  });

  it("passes the injected environment to ACP model discovery", async () => {
    const { requestLogPath, wrapperPath } = await runNode(makeProviderStatusEnvFixture());

    const provider = await runNode(
      checkCursorProviderStatus(
        {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        },
        {
          ...process.env,
          CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath,
        },
      ),
    );

    expect(provider.models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);
    await expect(
      runNode(FileSystem.FileSystem.use((fs) => fs.readFileString(requestLogPath))),
    ).resolves.toContain("initialize");
  });
});

describe("discoverCursorModelsViaAcp", () => {
  it("部分显式环境覆盖宿主快照，继承的 PATH 和标记同时用于缓存与执行", async () => {
    await runNode(
      Effect.gen(function* () {
        const fixture = yield* makeCatalogFixture();
        const catalog = yield* makeCliProviderCatalog();
        const host = yield* HostProcessEnvironment;
        const inheritedPath = host.PATH ?? host.Path ?? "";
        const baseEnvironment = {
          ...Object.fromEntries(
            Object.entries(host).filter(([key]) => !key.startsWith("CODEWORK_ACP_")),
          ),
          PATH: inheritedPath,
          CODEWORK_CURSOR_PROBE_MARKER: "inherited",
        };
        const override = {
          CODEWORK_ACP_REQUEST_LOG_PATH: fixture.requestLogPath,
          CODEWORK_CURSOR_PROBE_LOG_PATH: fixture.executionLogPath,
        };
        yield* discoverCursorModelsViaAcp(fixture.settings, override, catalog).pipe(
          Effect.provideService(HostProcessEnvironment, baseEnvironment),
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
        );
        yield* discoverCursorModelsViaAcp(
          fixture.settings,
          { ...baseEnvironment, ...override },
          catalog,
        ).pipe(
          Effect.provideService(HostProcessEnvironment, baseEnvironment),
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
        );
        expect(yield* readCatalogMethods(fixture.requestLogPath)).toEqual([
          "initialize",
          "authenticate",
          "cursor/list_available_models",
          "initialize",
          "authenticate",
          "cursor/list_available_models",
        ]);
        const executionText = yield* fixture.fs.readFileString(fixture.executionLogPath);
        const executions = yield* Effect.forEach(executionText.trim().split("\n"), (line) =>
          decodeProbeExecution(line),
        );
        expect(executions).toEqual([
          { args: ["acp"], cwd: fixture.firstCwd, marker: "inherited", path: inheritedPath },
          { args: ["acp"], cwd: fixture.firstCwd, marker: "inherited", path: inheritedPath },
        ]);
      }).pipe(Effect.scoped),
    );
  });

  it("公开目录入口让等价配置共享同一探测，自定义模型不进入目录缓存", async () => {
    await runNode(
      Effect.gen(function* () {
        const fixture = yield* makeCatalogFixture();
        const catalog = yield* makeCliProviderCatalog();
        const [first, second] = yield* Effect.all(
          [
            discoverCursorModelsViaAcp(fixture.settings, undefined, catalog),
            discoverCursorModelsViaAcp(
              { ...fixture.settings, customModels: ["custom-second"] },
              { ...fixture.environment },
              catalog,
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.provideService(HostProcessEnvironment, fixture.environment),
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
        );
        expect(second).toBe(first);
        expect(first.map((model) => model.slug)).toEqual([
          "default",
          "composer-2",
          "gpt-5.4",
          "claude-opus-4-6",
        ]);
        expect(yield* readCatalogMethods(fixture.requestLogPath)).toEqual([
          "initialize",
          "authenticate",
          "cursor/list_available_models",
        ]);
      }).pipe(Effect.scoped),
    );
  });

  it("强制刷新和环境、端点、目录变更使用本次参数重新探测", async () => {
    await runNode(
      Effect.gen(function* () {
        const fixture = yield* makeCatalogFixture();
        const catalog = yield* makeCliProviderCatalog();
        const first = discoverCursorModelsViaAcp(fixture.settings, fixture.environment, catalog);
        yield* first.pipe(Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd));
        yield* first.pipe(Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd));
        yield* first.pipe(
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
          Effect.provideService(ProviderCatalogForceRefresh, true),
        );
        const nextEnvironment = { ...fixture.environment, CODEWORK_CURSOR_PROBE_MARKER: "second" };
        yield* discoverCursorModelsViaAcp(fixture.settings, nextEnvironment, catalog).pipe(
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
        );
        const nextSettings = { ...fixture.settings, apiEndpoint: "https://catalog.invalid" };
        yield* discoverCursorModelsViaAcp(nextSettings, nextEnvironment, catalog).pipe(
          Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
        );
        yield* discoverCursorModelsViaAcp(nextSettings, nextEnvironment, catalog).pipe(
          Effect.provideService(HostProcessWorkingDirectory, fixture.secondCwd),
        );
        const methods = yield* readCatalogMethods(fixture.requestLogPath);
        expect(methods).toEqual(
          Array.from({ length: 6 }, () => [
            "initialize",
            "authenticate",
            "cursor/list_available_models",
          ]).flat(),
        );
        const executionText = yield* fixture.fs.readFileString(fixture.executionLogPath);
        const executions = yield* Effect.forEach(executionText.trim().split("\n"), (line) =>
          decodeProbeExecution(line),
        );
        expect(executions).toMatchObject([
          { args: ["acp"], cwd: fixture.firstCwd, marker: "first" },
          { args: ["acp"], cwd: fixture.firstCwd, marker: "first" },
          { args: ["acp"], cwd: fixture.firstCwd, marker: "first" },
          { args: ["acp"], cwd: fixture.firstCwd, marker: "second" },
          {
            args: ["-e", "https://catalog.invalid", "acp"],
            cwd: fixture.firstCwd,
            marker: "second",
          },
          {
            args: ["-e", "https://catalog.invalid", "acp"],
            cwd: fixture.secondCwd,
            marker: "second",
          },
        ]);
      }).pipe(Effect.scoped),
    );
  });

  it("实时版本和账号变化刷新目录，并按各自设置合并自定义模型", async () => {
    await runNode(
      Effect.gen(function* () {
        const fixture = yield* makeCatalogFixture();
        const catalog = yield* makeCliProviderCatalog();
        let channel = "lab";
        const check = (customModels: string[]) =>
          checkCursorProviderStatus(
            { ...fixture.settings, customModels },
            fixture.environment,
            catalog,
          ).pipe(
            Effect.provideService(HostProcessWorkingDirectory, fixture.firstCwd),
            Effect.provideService(FileSystem.FileSystem, {
              ...fixture.fs,
              readFileString: (...args) =>
                args[0].endsWith("cli-config.json")
                  ? Effect.succeed(encodeJson({ channel }))
                  : fixture.fs.readFileString(...args),
            }),
          );
        const first = yield* check(["custom-first"]);
        yield* fixture.fs.writeFileString(
          fixture.aboutPath,
          encodeJson({ cliVersion: "2026.04.10-second", userEmail: "second@example.com" }),
        );
        const second = yield* check(["custom-second"]);
        expect(first.version).toBe("2026.04.09-first");
        expect(second.version).toBe("2026.04.10-second");
        expect(first.auth).toMatchObject({ status: "authenticated", email: "first@example.com" });
        expect(second.auth).toMatchObject({ status: "authenticated", email: "second@example.com" });
        expect(first.models.filter((model) => model.isCustom).map((model) => model.slug)).toEqual([
          "custom-first",
        ]);
        expect(second.models.filter((model) => model.isCustom).map((model) => model.slug)).toEqual([
          "custom-second",
        ]);
        yield* fixture.fs.writeFileString(
          fixture.aboutPath,
          encodeJson({ cliVersion: "2026.04.10-second", userEmail: "Not logged in" }),
        );
        expect((yield* check(["custom-second"])).auth.status).toBe("unauthenticated");
        channel = "stable";
        expect((yield* check(["custom-second"])).message).toContain("lab channel");
        expect(yield* readCatalogMethods(fixture.requestLogPath)).toEqual([
          "initialize",
          "authenticate",
          "cursor/list_available_models",
          "initialize",
          "authenticate",
          "cursor/list_available_models",
        ]);
        const executionText = yield* fixture.fs.readFileString(fixture.executionLogPath);
        const executions = yield* Effect.forEach(executionText.trim().split("\n"), (line) =>
          decodeProbeExecution(line),
        );
        expect(executions.filter((entry) => entry.args[0] === "about")).toHaveLength(4);
      }).pipe(Effect.scoped),
    );
  });

  it("草稿模型目录只握手、认证并查询扩展，不创建原生会话", async () => {
    const { requestLogPath, wrapperPath } = await runNode(makeProviderStatusEnvFixture());
    const models = await runNode(
      discoverCursorModelsViaAcp(
        {
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        },
        { ...process.env, CODEWORK_ACP_REQUEST_LOG_PATH: requestLogPath },
      ),
    );
    const methods = await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const requests = yield* fs.readFileString(requestLogPath);
        return yield* Effect.forEach(requests.trim().split("\n"), (line) =>
          decodeRequestMethod(line).pipe(Effect.map((request) => request.method)),
        );
      }),
    );
    expect(methods).toEqual(["initialize", "authenticate", "cursor/list_available_models"]);
    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);
  });

  it("keeps the ACP probe runtime alive long enough to discover models", async () => {
    const wrapperPath = await runNode(makeMockAgentWrapper());

    const models = await runNode(
      discoverCursorModelsViaAcp({
        enabled: true,
        binaryPath: wrapperPath,
        apiEndpoint: "",
        customModels: [],
      }).pipe(Effect.scoped),
    );

    expect(models.map((model) => model.slug)).toEqual([
      "default",
      "composer-2",
      "gpt-5.4",
      "claude-opus-4-6",
    ]);
  });

  it("closes the ACP probe runtime after discovery completes", async () => {
    const stillRunning = await runNode(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const handles: ChildProcessSpawner.ChildProcessHandle[] = [];
        const wrapperPath = yield* makeMockAgentWrapper();
        yield* discoverCursorModelsViaAcp({
          enabled: true,
          binaryPath: wrapperPath,
          apiEndpoint: "",
          customModels: [],
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner.spawn(command).pipe(
                Effect.tap((handle) =>
                  Effect.sync(() => {
                    handles.push(handle);
                  }),
                ),
              ),
            ),
          ),
        );
        // Windows 的可执行文件解析也会创建短进程；所有捕获句柄都必须结束。
        expect(handles.length).toBeGreaterThan(0);
        return yield* Effect.forEach(handles, (handle) => handle.isRunning);
      }),
    );
    expect(stillRunning.every((running) => !running)).toBe(true);
  });
});

describe("parseCursorAboutOutput", () => {
  it("parses json about output and forwards subscription metadata", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "jmarminge@gmail.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "jmarminge@gmail.com",
        type: "Team",
        label: "Cursor Team Subscription",
      },
    });
  });

  it("treats json about output with a logged-out email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: "Team",
          userEmail: "Not logged in",
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });

  it("treats json about output with a null email as unauthenticated", () => {
    expect(
      parseCursorAboutOutput({
        code: 0,
        stdout: JSON.stringify({
          cliVersion: "2026.04.09-f2b0fcd",
          subscriptionTier: null,
          userEmail: null,
        }),
        stderr: "",
      }),
    ).toEqual({
      version: "2026.04.09-f2b0fcd",
      status: "error",
      auth: {
        status: "unauthenticated",
      },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    });
  });
});

describe("Cursor parameterized model picker preview gating", () => {
  it("parses Cursor CLI version dates from build versions", () => {
    expect(parseCursorVersionDate("2026.04.08-c4e73a3")).toBe(20260408);
    expect(parseCursorVersionDate("2026.04.09")).toBe(20260409);
    expect(parseCursorVersionDate("not-a-version")).toBeUndefined();
  });

  it("parses the Cursor CLI channel from cli-config.json", () => {
    expect(parseCursorCliConfigChannel('{ "channel": "lab" }')).toBe("lab");
    expect(parseCursorCliConfigChannel('{ "channel": "stable" }')).toBe("stable");
    expect(parseCursorCliConfigChannel('{ "version": 1 }')).toBeUndefined();
    expect(parseCursorCliConfigChannel("not-json")).toBeUndefined();
  });

  it("returns no warning when the preview requirements are met", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "lab",
      }),
    ).toBeUndefined();
  });

  it("explains when the Cursor Agent version is too old", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.07-c4e73a3",
        channel: "lab",
      }),
    ).toContain("too old");
  });

  it("explains when the Cursor Agent channel is not lab", () => {
    expect(
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: "2026.04.08-c4e73a3",
        channel: "stable",
      }),
    ).toContain("lab channel");
  });
});

describe("resolveCursorAcpBaseModelId", () => {
  it("drops bracket traits without rewriting raw ACP model ids", () => {
    expect(resolveCursorAcpBaseModelId("gpt-5.4[reasoning=medium,context=272k]")).toBe("gpt-5.4");
    expect(resolveCursorAcpBaseModelId("gpt-5.4-medium-fast")).toBe("gpt-5.4-medium-fast");
    expect(resolveCursorAcpBaseModelId("claude-4.6-opus-high-thinking")).toBe(
      "claude-4.6-opus-high-thinking",
    );
    expect(resolveCursorAcpBaseModelId("composer-2")).toBe("composer-2");
    expect(resolveCursorAcpBaseModelId("auto")).toBe("auto");
  });
});

describe("resolveCursorAcpConfigUpdates", () => {
  it("maps Cursor model options onto separate ACP config option updates", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "reasoning", value: "xhigh" },
        { id: "fastMode", value: true },
        { id: "contextWindow", value: "1m" },
      ]),
    ).toEqual([
      { configId: "reasoning", value: "extra-high" },
      { configId: "context", value: "1m" },
      { configId: "fast", value: "true" },
    ]);
  });

  it("maps boolean thinking toggles when the model exposes them separately", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeConfigOptions, [
        { id: "thinking", value: false },
      ]),
    ).toEqual([{ configId: "thinking", value: false }]);
  });

  it("maps explicit fastMode: false so the adapter can clear a prior fast selection", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedGpt54ConfigOptions, [
        { id: "fastMode", value: false },
      ]),
    ).toEqual([{ configId: "fast", value: "false" }]);
  });

  it("writes Cursor effort changes through the newer model_option config when available", () => {
    expect(
      resolveCursorAcpConfigUpdates(parameterizedClaudeModelOptionConfigOptions, [
        { id: "reasoning", value: "max" },
        { id: "thinking", value: false },
      ]),
    ).toEqual([
      { configId: "effort", value: "max" },
      { configId: "thinking", value: "false" },
    ]);
  });
});
