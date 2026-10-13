import { CodexSettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import {
  checkCodexProviderStatus,
  CODEX_INSTALLATION_DAMAGED_MESSAGE,
  makePendingCodexProvider,
} from "./CodexProvider.ts";

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
const environment = { PATH: "/fixture/bin", CODEX_HOME: "/fixture/home", ROUTE: "original" };
const cwd = "/fixture/project";
const account = (email: string): CodexSchema.V2GetAccountResponse => ({
  account: { type: "chatgpt", email, planType: "plus" },
  requiresOpenaiAuth: true,
});
const stages = [
  "initialize",
  "account/read",
  "model/list",
  "model/list:next-page",
  "skills/list",
  "collaborationMode/list",
  "diagnosis",
] as const;
type Stage = (typeof stages)[number];

/** 真实 RPC 编解码与 child Scope 保留，仅用收据控制子进程响应时机。 */
const makeFixture = Effect.fn("makeCodexRefreshFixture")(function* () {
  const catalog = yield* makeCliProviderCatalog();
  const native = yield* makeNativeProviderCatalog();
  const signals: AbortSignal[] = [];
  const nativeCatalog: NativeProviderCatalog = {
    ...native,
    fetchCatalog: (input) =>
      native.fetchCatalog({
        ...input,
        load: (controller) => {
          signals.push(controller.signal);
          return input.load(controller);
        },
      }),
  };
  const gates = new Map(
    yield* Effect.forEach(stages, (stage) =>
      Effect.gen(function* () {
        return [
          stage,
          { entered: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() },
        ] as const;
      }),
    ),
  );
  const gate = (stage: Stage) => {
    const value = gates.get(stage);
    if (!value) throw new Error("缺少固定阶段收据");
    return value;
  };
  const state = {
    version: "1.0.0",
    account: account("first@example.test"),
    modelPrefix: "first",
    failMethod: "",
    blocks: new Set<Stage>(),
    damaged: false,
  };
  const commands: ChildProcess.StandardCommand[] = [];
  const requests: Array<{ pid: number; method: string; cursor?: string }> = [];
  const finalized: number[] = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("需要普通命令");
      commands.push(command);
      const pid = commands.length;
      const current = { ...state, blocks: new Set(state.blocks) };
      const scope = yield* Scope.Scope;
      const output = yield* Queue.unbounded<Uint8Array>();
      let running = true;
      const finish = Effect.sync(() => {
        if (!running) return;
        running = false;
        finalized.push(pid);
      });
      yield* Effect.addFinalizer(() => finish);
      const waitAt = (stage: Stage) =>
        Effect.gen(function* () {
          if (!current.blocks.has(stage)) return;
          yield* Deferred.succeed(gate(stage).entered, undefined);
          yield* Deferred.await(gate(stage).release);
        });
      if (command.args.includes("--version")) {
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          exitCode: waitAt("diagnosis").pipe(Effect.as(ChildProcessSpawner.ExitCode(1))),
          isRunning: Effect.sync(() => running),
          kill: () => finish,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(
            encoder.encode(
              current.damaged
                ? "Missing optional dependency @openai/codex-win32-x64"
                : "ordinary failure",
            ),
          ),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }
      const respond = Effect.fn("respondToCodexRefreshRequest")(function* (
        request: ReturnType<typeof decodeRequest>,
      ) {
        requests.push({
          pid,
          method: request.method,
          ...(request.params?.cursor ? { cursor: request.params.cursor } : {}),
        });
        if (request.id === undefined) return;
        const stage =
          request.method === "model/list" && request.params?.cursor
            ? "model/list:next-page"
            : request.method;
        if (stages.includes(stage as Stage)) yield* waitAt(stage as Stage);
        let result: unknown;
        if (request.method === "collaborationMode/list")
          result = {
            data: [
              { name: "原生默认", mode: "default", model: null },
              { name: "原生计划", mode: "plan", model: null },
            ],
          };
        if (request.method === "initialize")
          result = {
            userAgent: `codex/${current.version}`,
            codexHome: command.options.env?.CODEX_HOME ?? "",
            platformFamily: "unix",
            platformOs: "linux",
          };
        else if (request.method === "account/read") result = current.account;
        else if (request.method === "model/list") {
          const slug = `${current.modelPrefix}-${request.params?.cursor ? "second" : "first"}`;
          result = {
            data: [
              {
                id: slug,
                model: slug,
                displayName: slug,
                description: "刷新测试模型",
                hidden: false,
                isDefault: !request.params?.cursor,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "中等" }],
              },
            ],
            nextCursor: request.params?.cursor ? null : "next-page",
          };
        } else if (request.method === "skills/list")
          result = {
            data: [
              {
                cwd: request.params?.cwds?.[0],
                errors: [],
                skills: [
                  {
                    name: `${current.modelPrefix}-skill`,
                    description: "刷新测试技能",
                    path: "/fixture/skill/SKILL.md",
                    enabled: true,
                    scope: "user",
                  },
                ],
              },
            ],
          };
        const response =
          result === undefined || request.method === current.failMethod
            ? { id: request.id, error: { code: -32601, message: "探针受控失败或越过会话边界" } }
            : { id: request.id, result };
        yield* Queue.offer(output, encoder.encode(`${encodeJson(response)}\n`));
      });
      const decoder = new TextDecoder();
      let pending = "";
      const stdin = Sink.forEach((chunk: Uint8Array) =>
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
        stdin,
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
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, cwd),
    );
  const check = (customModels: string[] = [], overrides: Partial<CodexSettings> = {}) =>
    provide(
      checkCodexProviderStatus(
        { ...settings, customModels, ...overrides },
        undefined,
        undefined,
        undefined,
        catalog,
        nativeCatalog,
      ),
    );
  const count = (method: string) => requests.filter((request) => request.method === method).length;
  const assertNoSessions = () =>
    expect([...new Set(requests.map((request) => request.method))].sort()).toEqual(
      [
        "initialize",
        "initialized",
        "account/read",
        "model/list",
        "skills/list",
        "collaborationMode/list",
      ]
        .filter((method) => count(method))
        .sort(),
    );
  return {
    state,
    signals,
    commands,
    requests,
    finalized,
    check,
    provide,
    settings,
    count,
    assertNoSessions,
    catalog,
    nativeCatalog,
    entered: (stage: Stage) => Deferred.await(gate(stage).entered),
    release: (stage: Stage) => Deferred.succeed(gate(stage).release, undefined),
  };
});

describe("Codex 整次原生刷新", () => {
  for (const pendingStage of [
    "model/list:next-page",
    "skills/list",
    "collaborationMode/list",
  ] as const) {
    it.effect(`${pendingStage} 阻塞时整轮十秒截止，晚加入不续预算且无残缺目录`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blocks = new Set(["initialize", "account/read", pendingStage]);
        const first = yield* f
          .check(["custom-one"])
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* f.entered("initialize");
        yield* TestClock.adjust("3 seconds");
        yield* f.release("initialize");
        yield* f.entered("account/read");
        yield* TestClock.adjust("4 seconds");
        yield* f.release("account/read");
        yield* f.entered(pendingStage);
        const second = yield* f
          .check(["custom-two"])
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(f.signals).toHaveLength(1);
        yield* TestClock.adjust("2999 millis");
        expect(f.signals[0]?.aborted).toBe(false);
        yield* TestClock.adjust("1 millis");
        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);
        expect(firstResult.message).toBe(
          "Timed out while checking Codex app-server provider status.",
        );
        expect(secondResult.message).toBe(firstResult.message);
        expect(firstResult.auth.status).toBe("unknown");
        expect(firstResult.models.map((model) => model.slug)).toEqual(["custom-one"]);
        expect(secondResult.models.map((model) => model.slug)).toEqual(["custom-two"]);
        expect(f.signals[0]?.aborted).toBe(true);
        expect(f.finalized).toEqual([1]);
        expect(f.count("account/read")).toBe(1);
        expect(new Set(f.requests.map((request) => request.pid))).toEqual(new Set([1]));
        f.state.blocks.clear();
        f.state.modelPrefix = "recovered";
        const recovered = yield* f.check();
        expect(recovered.models[0]?.slug).toBe("recovered-first");
        expect(f.count("skills/list")).toBe(2);
        expect(f.signals).toHaveLength(2);
        expect(f.signals[1]).not.toBe(f.signals[0]);
        f.assertNoSessions();
      }),
    );
  }

  for (const cancelAll of [false, true]) {
    it.effect(`${cancelAll ? "最后" : "首个"}等待者取消遵守共同进程所有权`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blocks.add("model/list");
        const first = yield* f.check(["one"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* f.entered("model/list");
        const second = yield* f.check(["two"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        expect(f.signals[0]?.aborted).toBe(false);
        expect(f.finalized).toEqual([]);
        if (cancelAll) yield* Fiber.interrupt(second);
        else {
          yield* f.release("model/list");
          const result = yield* Fiber.join(second);
          expect(result.models.map((model) => model.slug)).toEqual([
            "first-first",
            "first-second",
            "two",
          ]);
          expect(result.status).toBe("ready");
        }
        expect(f.signals[0]?.aborted).toBe(true);
        expect(f.finalized).toEqual([1]);
        expect(f.count("account/read")).toBe(1);
        f.state.blocks.clear();
        yield* f.check();
        expect(f.count("account/read")).toBe(2);
        expect(f.commands).toHaveLength(2);
        f.assertNoSessions();
      }),
    );
  }

  it.effect("损坏诊断只使用剩余预算，并继承本轮实际 cwd 与环境", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.failMethod = "account/read";
      f.state.blocks = new Set(["account/read", "diagnosis"]);
      const fiber = yield* f.check().pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("account/read");
      yield* TestClock.adjust("9 seconds");
      yield* f.release("account/read");
      yield* f.entered("diagnosis");
      expect(f.commands).toHaveLength(2);
      expect(f.commands[1]?.args).toEqual(["--version"]);
      expect(f.commands[1]?.options.cwd).toBe(cwd);
      expect(f.commands[1]?.options.env).toEqual(environment);
      expect(f.commands[1]?.options.extendEnv).toBe(false);
      expect(f.signals).toHaveLength(1);
      yield* TestClock.adjust("999 millis");
      expect(f.signals[0]?.aborted).toBe(false);
      yield* TestClock.adjust("1 millis");
      expect((yield* Fiber.join(fiber)).message).toBe(
        "Timed out while checking Codex app-server provider status.",
      );
      expect(f.signals[0]?.aborted).toBe(true);
      expect(f.finalized).toEqual([1, 2]);
      f.assertNoSessions();
    }),
  );

  it.effect("主探针预算耗尽不另起诊断，损坏签名仍显示修复入口", () =>
    Effect.gen(function* () {
      const slow = yield* makeFixture();
      slow.state.blocks.add("account/read");
      slow.state.failMethod = "account/read";
      const fiber = yield* slow.check().pipe(Effect.forkChild({ startImmediately: true }));
      yield* slow.entered("account/read");
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(fiber);
      expect(slow.commands).toHaveLength(1);
      const broken = yield* makeFixture();
      broken.state.failMethod = "account/read";
      broken.state.damaged = true;
      const result = yield* broken.check(["offline-model"]);
      expect(result.installed).toBe(false);
      expect(result.message).toBe(CODEX_INSTALLATION_DAMAGED_MESSAGE);
      expect(result.models.map((model) => model.slug)).toEqual(["offline-model"]);
      expect(broken.commands).toHaveLength(2);
      broken.assertNoSessions();
    }),
  );

  it.effect("顺序检查不缓存认证，稳定身份命中纯目录且匿名身份重新发现", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.check();
      yield* TestClock.adjust("1 second");
      const warm = yield* f.check();
      expect(f.count("account/read")).toBe(2);
      expect(f.count("skills/list")).toBe(1);
      expect(warm.checkedAt).toBe("1970-01-01T00:00:01.000Z");
      f.state.account = { account: null, requiresOpenaiAuth: true };
      expect((yield* f.check()).auth.status).toBe("unauthenticated");
      expect((yield* f.check()).models).toEqual([]);
      f.state.account = account("second@example.test");
      f.state.modelPrefix = "other-account";
      expect((yield* f.check()).models[0]?.slug).toBe("other-account-first");
      f.state.account = { account: { type: "apiKey" }, requiresOpenaiAuth: false };
      f.state.modelPrefix = "key-one";
      expect((yield* f.check()).models[0]?.slug).toBe("key-one-first");
      f.state.modelPrefix = "key-two";
      expect((yield* f.check()).models[0]?.slug).toBe("key-two-first");
      f.assertNoSessions();
    }),
  );

  it.effect("手动强刷新不被正在读取旧目录的普通刷新吞掉，普通可加入强刷新", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.check();
      f.state.blocks.add("account/read");
      const weak = yield* f.check(["weak"]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("account/read");
      f.state.blocks.clear();
      f.state.modelPrefix = "forced";
      const strong = yield* f
        .check(["strong"])
        .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
      expect(strong.models[0]?.slug).toBe("forced-first");
      yield* f.release("account/read");
      yield* Fiber.join(weak);
      expect(f.count("account/read")).toBe(3);
      expect(f.count("skills/list")).toBe(2);
      const next = yield* makeFixture();
      next.state.blocks.add("model/list");
      const first = yield* next
        .check(["strong"])
        .pipe(
          Effect.provideService(ProviderCatalogForceRefresh, true),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* next.entered("model/list");
      const follower = yield* next
        .check(["ordinary"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* next.release("model/list");
      yield* Fiber.join(first);
      expect((yield* Fiber.join(follower)).models.at(-1)?.slug).toBe("ordinary");
      expect(next.commands).toHaveLength(1);
      next.assertNoSessions();
    }),
  );

  it.effect("禁用和 pending 仅合并配置模型，不取得刷新信号或创建进程", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const disabled = yield* f.check(["custom"], { enabled: false });
      const pending = yield* makePendingCodexProvider({ ...f.settings, customModels: ["custom"] });
      expect(disabled.models.map((model) => model.slug)).toEqual(["custom"]);
      expect(pending.models.map((model) => model.slug)).toEqual(["custom"]);
      expect(f.signals).toEqual([]);
      expect(f.commands).toEqual([]);
    }),
  );
});
