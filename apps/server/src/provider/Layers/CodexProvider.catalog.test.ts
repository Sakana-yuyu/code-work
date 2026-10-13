import { CodexSettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { checkCodexProviderStatus, fetchCodexCatalog } from "./CodexProvider.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          cursor: Schema.optionalKey(Schema.String),
          cwds: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const account = (email: string): CodexSchema.V2GetAccountResponse => ({
  account: { type: "chatgpt", email, planType: "plus" },
  requiresOpenaiAuth: true,
});
const environment = { PATH: "/fixture/bin", CODEX_HOME: "/fixture/home", ROUTE: "first" };
const cwd = "/fixture/work";
const unstableAccounts: ReadonlyArray<{
  readonly label: string;
  readonly account: CodexSchema.V2GetAccountResponse;
}> = [
  { label: "API key", account: { account: { type: "apiKey" }, requiresOpenaiAuth: false } },
  {
    label: "Amazon Bedrock",
    account: { account: { type: "amazonBedrock" }, requiresOpenaiAuth: false },
  },
  { label: "无账户免认证", account: { account: null, requiresOpenaiAuth: false } },
  { label: "ChatGPT 空邮箱", account: account("") },
  { label: "ChatGPT 空白邮箱", account: account("   ") },
  {
    label: "ChatGPT null 邮箱",
    account: {
      account: { type: "chatgpt", email: null, planType: "plus" },
      requiresOpenaiAuth: true,
    },
  },
];

/** 保留真实 JSON-RPC 编解码，只替换子进程的字节流和生命周期。 */
const makeFixture = Effect.fn("makeCodexCatalogFixture")(function* () {
  const catalog = yield* makeCliProviderCatalog();
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const closed = yield* Deferred.make<void>();
  const state = {
    version: "1.0.0",
    account: account("first@example.test"),
    modelPrefix: "model",
    failMethod: "",
    blockModels: false,
  };
  const commands: ChildProcess.StandardCommand[] = [];
  const calls: Array<{ pid: number; method: string; cursor?: string }> = [];
  const finalized: number[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("需要普通命令");
      commands.push(command);
      const pid = commands.length;
      const processState = { ...state };
      const scope = yield* Scope.Scope;
      const output = yield* Queue.unbounded<Uint8Array>();
      const decoder = new TextDecoder();
      let pending = "";
      let running = true;
      const finish = Effect.gen(function* () {
        if (!running) return;
        running = false;
        finalized.push(pid);
        yield* Deferred.succeed(closed, undefined);
      });
      yield* Effect.addFinalizer(() => finish);
      const respond = Effect.fn("respondToCodexCatalogRequest")(function* (
        request: ReturnType<typeof decodeRequest>,
      ) {
        calls.push({
          pid,
          method: request.method,
          ...(request.params?.cursor ? { cursor: request.params.cursor } : {}),
        });
        if (request.id === undefined) return;
        if (
          request.method === "model/list" &&
          !request.params?.cursor &&
          processState.blockModels
        ) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        let result: unknown;
        if (request.method === "initialize") {
          result = {
            userAgent: `codex/${processState.version}`,
            codexHome: command.options.env?.CODEX_HOME ?? "",
            platformFamily: "unix",
            platformOs: "linux",
          };
        } else if (request.method === "account/read") {
          result = processState.account;
        } else if (request.method === "model/list") {
          const slug = `${processState.modelPrefix}-${request.params?.cursor ? "second" : "first"}`;
          result = {
            data: [
              {
                id: slug,
                model: slug,
                displayName: slug,
                description: "目录测试模型",
                hidden: false,
                isDefault: !request.params?.cursor,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "中等" }],
              },
            ],
            nextCursor: request.params?.cursor ? null : "next-page",
          };
        } else if (request.method === "skills/list") {
          result = {
            data: [
              {
                cwd: request.params?.cwds?.[0],
                errors: [],
                skills: [
                  {
                    name: "fixture-skill",
                    description: "目录测试技能",
                    path: "/fixture/skill/SKILL.md",
                    scope: "user",
                    enabled: true,
                  },
                ],
              },
            ],
          };
        }
        const response =
          result === undefined || request.method === processState.failMethod
            ? { id: request.id, error: { code: -32601, message: "目录请求失败或调用了会话方法" } }
            : { id: request.id, result };
        yield* Queue.offer(output, encoder.encode(`${encodeJson(response)}\n`));
      });
      const input = Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          pending += decoder.decode(chunk, { stream: true });
          let index: number;
          while ((index = pending.indexOf("\n")) !== -1) {
            const line = pending.slice(0, index);
            pending = pending.slice(index + 1);
            if (line.trim())
              yield* respond(decodeRequest(line)).pipe(
                Effect.forkIn(scope, { startImmediately: true }),
              );
          }
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        exitCode: Effect.never,
        isRunning: Effect.sync(() => running),
        kill: () => finish,
        unref: Effect.succeed(Effect.void),
        stdin: input,
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const settings = decodeSettings({
    enabled: true,
    binaryPath: "codex",
    homePath: environment.CODEX_HOME,
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.provideService(HostProcessWorkingDirectory, cwd),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
  const check = (customModels: readonly string[] = []) =>
    provide(
      checkCodexProviderStatus(
        { ...settings, customModels: [...customModels] },
        undefined,
        undefined,
        () => Effect.succeed(false),
        catalog,
      ),
    );
  const input = {
    binaryPath: "codex",
    cwd,
    environment,
    version: state.version,
    account: state.account,
    catalog,
  };
  const fetch = (overrides: Partial<Parameters<typeof fetchCodexCatalog>[0]> = {}) =>
    provide(fetchCodexCatalog({ ...input, ...overrides }));
  const count = (method: string) => calls.filter((call) => call.method === method).length;
  const assertNoSessions = () =>
    expect([...new Set(calls.map((call) => call.method))].sort()).toEqual(
      ["account/read", "initialize", "initialized", "model/list", "skills/list"]
        .filter((method) => count(method))
        .sort(),
    );
  return {
    catalog,
    state,
    commands,
    calls,
    finalized,
    entered,
    release,
    closed,
    check,
    fetch,
    provide,
    count,
    assertNoSessions,
  };
});

describe("Codex 共享模型与技能目录", () => {
  for (const unstable of unstableAccounts) {
    it.effect(`${unstable.label} 缺少稳定身份时不复用完成目录，并发仍共享在途加载`, () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture();
        fixture.state.account = unstable.account;
        expect((yield* fixture.check()).models[0]?.slug).toBe("model-first");
        fixture.state.modelPrefix = "updated";
        const second = yield* fixture.check();
        expect(second.models[0]?.slug).toBe("updated-first");
        expect(fixture.count("account/read")).toBe(2);
        expect(fixture.count("skills/list")).toBe(2);

        fixture.state.modelPrefix = "concurrent";
        fixture.state.blockModels = true;
        const firstWaiter = yield* fixture
          .fetch({ account: unstable.account })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(fixture.entered);
        const secondWaiter = yield* fixture
          .fetch({ account: unstable.account })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(fixture.release, undefined);
        const firstResult = yield* Fiber.join(firstWaiter);
        expect(yield* Fiber.join(secondWaiter)).toBe(firstResult);
        expect(firstResult.models[0]?.slug).toBe("concurrent-first");
        expect(fixture.count("skills/list")).toBe(3);
        expect(fixture.commands).toHaveLength(5);
        expect(fixture.finalized).toHaveLength(5);
        fixture.assertNoSessions();
      }),
    );
  }

  it.effect("引号和空白不同但实际 argv 相同的启动参数复用目录", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.fetch({ launchArgs: "--enable fixture_feature" });
      const second = yield* fixture.fetch({ launchArgs: '  --enable "fixture_feature"  ' });
      expect(second).toBe(first);
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.commands[0]?.args).toEqual(["app-server", "--enable", "fixture_feature"]);
      fixture.assertNoSessions();
    }),
  );

  it.effect("健康检查实时读取账户和版本，等价目录共享分页结果并各自合并自定义模型", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.check([" custom-a ", "model-first"]);
      const second = yield* fixture.check(["custom-b"]);
      expect(first.status).toBe("ready");
      expect(second.auth.email).toBe("first@example.test");
      expect(first.models.map((model) => model.slug)).toEqual([
        "model-first",
        "model-second",
        "custom-a",
      ]);
      expect(second.models.map((model) => model.slug)).toEqual([
        "model-first",
        "model-second",
        "custom-b",
      ]);
      expect(first.models[0]).toBe(second.models[0]);
      expect(first.skills).toEqual(second.skills);
      expect(first.skills?.[0]?.name).toBe("fixture-skill");
      expect(fixture.count("account/read")).toBe(2);
      expect(fixture.count("initialize")).toBe(3);
      expect(fixture.count("model/list")).toBe(2);
      expect(fixture.count("skills/list")).toBe(1);
      expect(
        fixture.calls.filter((call) => call.method === "model/list").map((call) => call.cursor),
      ).toEqual([undefined, "next-page"]);
      expect(
        fixture.commands.every(
          (command) => command.options.cwd === cwd && command.options.extendEnv === false,
        ),
      ).toBe(true);
      expect(fixture.commands.map((command) => command.options.env)).toEqual([
        environment,
        environment,
        environment,
      ]);
      expect(fixture.finalized).toHaveLength(3);
      fixture.assertNoSessions();
    }),
  );

  it.effect("退出登录不返回旧目录，切换账户或 CLI 版本会重新发现目录", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* fixture.check();
      fixture.state.account = { account: null, requiresOpenaiAuth: true };
      const loggedOut = yield* fixture.check(["offline-custom"]);
      expect(loggedOut.auth.status).toBe("unauthenticated");
      expect(loggedOut.models.map((model) => model.slug)).toEqual(["offline-custom"]);
      expect(fixture.count("skills/list")).toBe(1);
      fixture.state.account = account("second@example.test");
      fixture.state.modelPrefix = "second-account";
      const switched = yield* fixture.check();
      expect(switched.auth.email).toBe("second@example.test");
      expect(switched.models[0]?.slug).toBe("second-account-first");
      fixture.state.version = "2.0.0";
      fixture.state.modelPrefix = "new-version";
      const upgraded = yield* fixture.check();
      expect(upgraded.version).toBe("2.0.0");
      expect(upgraded.models[0]?.slug).toBe("new-version-first");
      expect(fixture.count("account/read")).toBe(4);
      expect(fixture.count("skills/list")).toBe(3);
      fixture.assertNoSessions();
    }),
  );

  it.effect("缓存键保留实际执行配置和账户身份，强制刷新绕过有效缓存", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const first = yield* fixture.fetch();
      expect(
        yield* fixture.fetch({
          environment: { ROUTE: "first", CODEX_HOME: "/fixture/home", PATH: "/fixture/bin" },
        }),
      ).toBe(first);
      for (const overrides of [
        { environment: { ...environment, ROUTE: "second" } },
        { launchArgs: "--enable fixture_feature" },
        { cwd: "/fixture/other" },
        { binaryPath: "another-codex" },
        { version: "2.0.0" },
        { account: account("another@example.test") },
      ])
        yield* fixture.fetch(overrides);
      expect(fixture.count("skills/list")).toBe(7);
      fixture.state.modelPrefix = "forced";
      const forced = yield* fixture
        .fetch()
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      expect(forced.models[0]?.slug).toBe("forced-first");
      expect(yield* fixture.fetch()).toBe(forced);
      expect(fixture.count("skills/list")).toBe(8);
      expect(fixture.count("account/read")).toBe(0);
      expect(fixture.commands[1]?.options.env?.ROUTE).toBe("second");
      expect(fixture.commands[2]?.args).toEqual(["app-server", "--enable", "fixture_feature"]);
      expect(fixture.commands[3]?.options.cwd).toBe("/fixture/other");
      expect(fixture.commands[4]?.command).toBe("another-codex");
      fixture.assertNoSessions();
    }),
  );

  it.effect("模型或技能任一失败不缓存残缺目录，重试重新创建并关闭目录进程", () =>
    Effect.gen(function* () {
      for (const method of ["model/list", "skills/list"]) {
        const fixture = yield* makeFixture();
        fixture.state.failMethod = method;
        expect(Result.isFailure(yield* fixture.fetch().pipe(Effect.result))).toBe(true);
        fixture.state.failMethod = "";
        const retried = yield* fixture.fetch();
        expect(retried.models).toHaveLength(2);
        expect(retried.skills).toHaveLength(1);
        expect(yield* fixture.fetch()).toBe(retried);
        expect(fixture.commands).toHaveLength(2);
        expect(fixture.finalized).toHaveLength(2);
        fixture.assertNoSessions();
      }
    }),
  );

  it.effect("首个等待者作用域结束后，另一实例继续共享同一目录进程", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.state.blockModels = true;
      const firstScope = yield* Scope.make();
      yield* fixture.fetch().pipe(Effect.forkIn(firstScope, { startImmediately: true }));
      yield* Deferred.await(fixture.entered);
      const second = yield* fixture.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Scope.close(firstScope, Exit.void);
      expect(fixture.finalized).toEqual([]);
      yield* Deferred.succeed(fixture.release, undefined);
      const result = yield* Fiber.join(second);
      expect(result.models).toHaveLength(2);
      expect(fixture.commands).toHaveLength(1);
      expect(fixture.finalized).toEqual([1]);
      expect(yield* fixture.fetch()).toBe(result);
      fixture.assertNoSessions();
    }),
  );

  it.effect("全部等待者取消会关闭目录进程，下次调用重新发现", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      fixture.state.blockModels = true;
      const first = yield* fixture.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(fixture.entered);
      const second = yield* fixture.fetch().pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);
      expect(fixture.finalized).toEqual([]);
      yield* Fiber.interrupt(second);
      yield* Deferred.await(fixture.closed);
      expect(fixture.finalized).toEqual([1]);
      fixture.state.blockModels = false;
      expect((yield* fixture.fetch()).models).toHaveLength(2);
      expect(fixture.commands).toHaveLength(2);
      fixture.assertNoSessions();
    }),
  );

  it.effect("到期加载采用当前调用者的执行服务，而不是首次加载时的进程工厂", () =>
    Effect.gen(function* () {
      const first = yield* makeFixture();
      const second = yield* makeFixture();
      const original = yield* first.fetch();
      second.state.modelPrefix = "current-loader";
      expect(yield* second.fetch({ catalog: first.catalog })).toBe(original);
      expect(second.commands).toHaveLength(0);
      yield* TestClock.adjust("60 seconds");
      const refreshed = yield* second.fetch({ catalog: first.catalog });
      expect(refreshed.models[0]?.slug).toBe("current-loader-first");
      expect(first.commands).toHaveLength(1);
      expect(second.commands).toHaveLength(1);
    }),
  );
});
