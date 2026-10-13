import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { GrokSettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { checkGrokProviderStatus } from "./GrokProvider.ts";

const decodeSettings = Schema.decodeSync(GrokSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeInvocation = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.String,
      method: Schema.optional(Schema.String),
      cwd: Schema.String,
      grokHome: Schema.String,
      route: Schema.String,
      referrer: Schema.String,
      config: Schema.String,
      fixtureFlag: Schema.String,
    }),
  ),
);

const makeCatalogFixture = Effect.fn("makeGrokCatalogFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "codework-grok-cache-" });
  const isWindows = (yield* HostProcessPlatform) === "win32";
  const binaryPath = path.join(dir, isWindows ? "grok.cmd" : "grok");
  const scriptPath = path.join(dir, "agent.cjs");
  const statePath = path.join(dir, "state.json");
  const logPath = path.join(dir, "calls.ndjson");
  const homeA = path.join(dir, "home-a");
  const homeB = path.join(dir, "home-b");
  yield* fs.makeDirectory(homeA);
  yield* fs.makeDirectory(homeB);
  const setState = (state: { version?: string; failed?: boolean; skillsFailed?: boolean }) =>
    fs.writeFileString(statePath, encodeJson({ version: "1.0.45", ...state }));
  yield* setState({});
  yield* fs.writeFileString(
    scriptPath,
    `const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const state = JSON.parse(fs.readFileSync(${encodeJson(statePath)}, "utf8"));
const grokHome = process.env.GROK_HOME || "";
const route = process.env.GROK_TEST_ROUTE || "default";
const configPath = path.join(grokHome, "config.toml");
const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
function log(kind, method) {
  fs.appendFileSync(${encodeJson(logPath)}, JSON.stringify({
    kind, method, cwd: process.cwd(), grokHome, route,
    referrer: process.env.GROK_OAUTH2_REFERRER || "", config,
    fixtureFlag: process.env.CODEWORK_ACP_CATALOG_TEST_FLAG || "",
  }) + "\\n");
}
if (process.argv.includes("--version")) {
  log("version");
  process.stdout.write("grok-cli " + state.version + "\\n");
} else if (process.argv.includes("inspect")) {
  log("skills");
  if (state.skillsFailed) process.exitCode = 2;
  else process.stdout.write('{"skills":[]}\\n');
} else {
  log("models");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const request = JSON.parse(line);
    log("request", request.method);
    let response;
    if (request.method === "initialize") {
      response = { result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } };
    } else if (request.method === "x.ai/models/list") {
      response = state.failed
        ? { error: { code: -32601, message: "目录暂不可用" } }
        : { result: { result: {
          currentModelId: "grok-" + route,
          availableModels: [{ modelId: "grok-" + route, name: config || "Grok " + route }],
        } } };
    } else {
      response = { error: { code: -32601, message: "目录不能执行会话或认证方法" } };
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
  if (!isWindows) yield* fs.chmod(binaryPath, 0o755);
  const catalog = yield* makeCliProviderCatalog();
  const environment = { ...process.env, GROK_HOME: homeA, GROK_TEST_ROUTE: "alpha" };
  const settings = decodeSettings({ enabled: true, binaryPath });
  const readCalls = fs.readFileString(logPath).pipe(
    Effect.map((lines) =>
      lines
        .trim()
        .split("\n")
        .map((line) => decodeInvocation(line)),
    ),
  );
  const writeConfig = (home: string, contents: string) =>
    fs.writeFileString(path.join(home, "config.toml"), contents);
  return { catalog, environment, settings, dir, homeA, homeB, setState, readCalls, writeConfig };
});

it.layer(NodeServices.layer)("Grok 共享目录缓存", (it) => {
  it.effect("部分环境继承宿主快照，相对二进制按宿主目录执行且隔离模拟开关", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      const path = yield* Path.Path;
      // Windows 外壳退出和子进程 cwd 释放之间存在间隙，宿主目录采用非清理目标的父目录。
      const hostWorkingDirectory = path.dirname(fixture.dir);
      const settings = {
        ...fixture.settings,
        binaryPath: `.${path.sep}${path.relative(hostWorkingDirectory, fixture.settings.binaryPath)}`,
      };
      const hostEnvironment = {
        ...process.env,
        GROK_TEST_ROUTE: "inherited",
        CODEWORK_ACP_CATALOG_TEST_FLAG: "must-not-leak",
      };
      const partialEnvironment = { GROK_HOME: fixture.homeA };
      const check = (environment: NodeJS.ProcessEnv) =>
        checkGrokProviderStatus(settings, environment, fixture.homeB, fixture.catalog).pipe(
          Effect.provideService(HostProcessEnvironment, hostEnvironment),
          Effect.provideService(HostProcessWorkingDirectory, hostWorkingDirectory),
        );
      const first = yield* check(partialEnvironment);
      yield* check(partialEnvironment);
      const explicit = yield* check({
        ...partialEnvironment,
        GROK_TEST_ROUTE: "explicit",
        CODEWORK_ACP_CATALOG_TEST_FLAG: "allowed",
      });
      expect(first.status).toBe("ready");
      expect(first.models.map((model) => model.slug)).toEqual(["grok-inherited"]);
      expect(explicit.models.map((model) => model.slug)).toEqual(["grok-explicit"]);
      const calls = yield* fixture.readCalls;
      expect(calls.filter((call) => call.kind === "version").map((call) => call.cwd)).toEqual([
        hostWorkingDirectory,
        hostWorkingDirectory,
        hostWorkingDirectory,
      ]);
      expect(
        calls
          .filter((call) => call.kind === "models")
          .map((call) => ({
            cwd: call.cwd,
            route: call.route,
            fixtureFlag: call.fixtureFlag,
          })),
      ).toEqual([
        { cwd: hostWorkingDirectory, route: "inherited", fixtureFlag: "" },
        { cwd: hostWorkingDirectory, route: "explicit", fixtureFlag: "allowed" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("等价配置共享探测，自定义模型各自合并且版本与技能每次检查", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      const firstSettings = { ...fixture.settings, customModels: ["grok-first"] };
      const secondSettings = { ...fixture.settings, customModels: ["grok-second"] };
      const [first, second] = yield* Effect.all(
        [
          checkGrokProviderStatus(
            firstSettings,
            { ...fixture.environment },
            fixture.dir,
            fixture.catalog,
          ),
          checkGrokProviderStatus(
            secondSettings,
            { ...fixture.environment },
            fixture.dir,
            fixture.catalog,
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(first.models.map((model) => model.slug)).toEqual(["grok-alpha", "grok-first"]);
      expect(second.models.map((model) => model.slug)).toEqual(["grok-alpha", "grok-second"]);
      const calls = yield* fixture.readCalls;
      expect(calls.filter((call) => call.kind === "models")).toHaveLength(1);
      expect(calls.filter((call) => call.kind === "version")).toHaveLength(2);
      expect(calls.filter((call) => call.kind === "skills")).toHaveLength(2);
      expect(calls.filter((call) => call.kind === "request").map((call) => call.method)).toEqual([
        "initialize",
        "x.ai/models/list",
      ]);
      expect(calls.find((call) => call.kind === "models")?.cwd).toBe(process.cwd());
      expect(calls.find((call) => call.kind === "skills")?.cwd).toBe(fixture.dir);
    }).pipe(Effect.scoped),
  );

  it.effect("命中后手动刷新和 CLI 版本更新都会重新发现目录", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      const check = checkGrokProviderStatus(
        fixture.settings,
        fixture.environment,
        fixture.dir,
        fixture.catalog,
      );
      yield* check;
      yield* check;
      yield* check.pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      yield* fixture.setState({ version: "1.0.46" });
      const latest = yield* check;
      expect(latest.version).toBe("1.0.46");
      const calls = yield* fixture.readCalls;
      expect(calls.filter((call) => call.kind === "models")).toHaveLength(3);
      expect(calls.filter((call) => call.kind === "version")).toHaveLength(4);
      expect(calls.filter((call) => call.kind === "skills")).toHaveLength(4);
    }).pipe(Effect.scoped),
  );

  it.effect("实际环境与 GROK_HOME 隔离目录，固定 referrer 覆盖不制造虚假缓存键", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      const check = (environment: NodeJS.ProcessEnv) =>
        checkGrokProviderStatus(fixture.settings, environment, fixture.dir, fixture.catalog);
      yield* check({ ...fixture.environment, GROK_OAUTH2_REFERRER: "caller-one" });
      yield* check({ ...fixture.environment, GROK_OAUTH2_REFERRER: "caller-two" });
      const beta = yield* check({ ...fixture.environment, GROK_TEST_ROUTE: "beta" });
      yield* check({ ...fixture.environment, GROK_HOME: fixture.homeB });
      expect(beta.models.map((model) => model.slug)).toEqual(["grok-beta"]);
      const models = (yield* fixture.readCalls).filter((call) => call.kind === "models");
      expect(models.map((call) => [call.grokHome, call.route, call.referrer])).toEqual([
        [fixture.homeA, "alpha", "codework"],
        [fixture.homeA, "beta", "codework"],
        [fixture.homeB, "alpha", "codework"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("同一环境路由配置文件变化不能复用旧目录", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      const check = (config: string) =>
        checkGrokProviderStatus(
          fixture.settings,
          fixture.environment,
          fixture.dir,
          fixture.catalog,
          config,
        );
      yield* fixture.writeConfig(fixture.homeA, 'model = "first"');
      const first = yield* check('model = "first"');
      yield* check('model = "first"');
      yield* fixture.writeConfig(fixture.homeA, 'model = "second"');
      const second = yield* check('model = "second"');
      expect(first.models[0]?.name).toBe('model = "first"');
      expect(second.models[0]?.name).toBe('model = "second"');
      expect(
        (yield* fixture.readCalls)
          .filter((call) => call.kind === "models")
          .map((call) => call.config),
      ).toEqual(['model = "first"', 'model = "second"']);
    }).pipe(Effect.scoped),
  );

  it.effect("失败目录不缓存成功，技能失败也不阻止下一次实时检查", () =>
    Effect.gen(function* () {
      const fixture = yield* makeCatalogFixture();
      yield* fixture.setState({ failed: true, skillsFailed: true });
      const check = checkGrokProviderStatus(
        fixture.settings,
        fixture.environment,
        fixture.dir,
        fixture.catalog,
      );
      expect((yield* check).status).toBe("error");
      yield* fixture.setState({});
      expect((yield* check).status).toBe("ready");
      const calls = yield* fixture.readCalls;
      expect(calls.filter((call) => call.kind === "models")).toHaveLength(2);
      expect(calls.filter((call) => call.kind === "skills")).toHaveLength(2);
    }).pipe(Effect.scoped),
  );
});
