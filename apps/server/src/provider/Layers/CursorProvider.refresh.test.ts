import { CursorSettings } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import {
  buildInitialCursorProviderSnapshot,
  checkCursorProviderStatus,
  discoverCursorModelsViaAcp,
} from "./CursorProvider.ts";

const decodeSettings = Schema.decodeSync(CursorSettings);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.String,
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const environment = { PATH: "/fixture/bin", HOME: "/fixture/home", ROUTE: "original" };
const cwd = "/fixture/project";
const stages = [
  "about",
  "channel",
  "initialize",
  "authenticate",
  "cursor/list_available_models",
] as const;
type Stage = (typeof stages)[number];

/** 保留真实 ACP 编解码与 Scope，仅以收据控制本地子进程响应。 */
const makeFixture = Effect.fn("makeCursorRefreshFixture")(function* () {
  const native = yield* makeNativeProviderCatalog();
  const catalog = yield* makeCliProviderCatalog();
  const controllers: AbortController[] = [];
  const catalogCalls: Array<{ key: string; shareInFlight?: boolean }> = [];
  const sharedCatalog: CliProviderCatalog = {
    fetchCatalog: (input) => {
      catalogCalls.push({
        key: input.key,
        ...(input.shareInFlight === undefined ? {} : { shareInFlight: input.shareInFlight }),
      });
      return catalog.fetchCatalog(input);
    },
  };
  const nativeCatalog: NativeProviderCatalog = {
    ...native,
    fetchCatalog: (input) =>
      native.fetchCatalog({
        ...input,
        load: (controller) => {
          controllers.push(controller);
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
    version: "2026.04.09-first" as string | null,
    email: "first@example.test" as string | null | undefined,
    subscriptionTier: "pro",
    channel: "lab",
    model: "first",
    failMethod: "",
    blocks: new Set<Stage>(),
    preAbort: false,
  };
  const waitAt = (stage: Stage, blocks: Set<Stage>) =>
    Effect.gen(function* () {
      if (!blocks.has(stage)) return;
      yield* Deferred.succeed(gate(stage).entered, undefined);
      yield* Deferred.await(gate(stage).release);
    });
  const commands: ChildProcess.StandardCommand[] = [];
  const requests: Array<{ pid: number; method: string }> = [];
  const finalized: number[] = [];
  const channelReads: string[] = [];
  const fileSystem = FileSystem.makeNoop({
    readFileString: (filePath) =>
      Effect.gen(function* () {
        channelReads.push(filePath);
        yield* waitAt("channel", state.blocks);
        return encodeJson({ channel: state.channel });
      }),
  });
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
      if (command.args[0] === "about") {
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(pid),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.sync(() => running),
          kill: () => finish,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.fromEffect(
            waitAt("about", current.blocks).pipe(
              Effect.as(
                encoder.encode(
                  encodeJson({
                    cliVersion: current.version,
                    ...(current.email === undefined ? {} : { userEmail: current.email }),
                    subscriptionTier: current.subscriptionTier,
                  }),
                ),
              ),
            ),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }
      const respond = Effect.fn("respondToCursorRefreshRequest")(function* (
        request: ReturnType<typeof decodeRequest>,
      ) {
        requests.push({ pid, method: request.method });
        if (request.id === undefined) return;
        if (stages.includes(request.method as Stage))
          yield* waitAt(request.method as Stage, current.blocks);
        let result: unknown;
        if (request.method === "initialize")
          result = { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
        else if (request.method === "authenticate") result = {};
        else if (request.method === "cursor/list_available_models")
          result = { models: [{ value: current.model, name: current.model }] };
        const response =
          result === undefined || current.failMethod === request.method
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
  const settings = decodeSettings({ enabled: true, binaryPath: "cursor-agent" });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, cwd),
      Effect.provide(Layer.merge(NodeCrypto.layer, Path.layer)),
    );
  const check = (customModels: string[] = [], overrides: Partial<CursorSettings> = {}) =>
    provide(
      checkCursorProviderStatus(
        { ...settings, customModels, ...overrides },
        undefined,
        sharedCatalog,
        state.preAbort
          ? {
              ...nativeCatalog,
              fetchCatalog: (input) =>
                nativeCatalog.fetchCatalog({
                  ...input,
                  load: (controller) => {
                    controller.abort();
                    return input.load(controller);
                  },
                }),
            }
          : nativeCatalog,
      ),
    );
  const count = (method: string) => requests.filter((request) => request.method === method).length;
  const assertNoSessions = () =>
    expect([...new Set(requests.map((request) => request.method))].sort()).toEqual(
      ["initialize", "authenticate", "cursor/list_available_models"]
        .filter((method) => count(method))
        .sort(),
    );
  return {
    state,
    controllers,
    commands,
    requests,
    finalized,
    channelReads,
    catalogCalls,
    check,
    provide,
    settings,
    checkSettings: (input: CursorSettings) =>
      provide(checkCursorProviderStatus(input, undefined, sharedCatalog, nativeCatalog)),
    count,
    assertNoSessions,
    entered: (stage: Stage) => Deferred.await(gate(stage).entered),
    release: (stage: Stage) => Deferred.succeed(gate(stage).release, undefined),
  };
});

describe("Cursor 整次原生刷新", () => {
  it.effect("独立目录登记后配置变化不改变已确定的 key 与实际启动参数", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const catalog = yield* makeCliProviderCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const gatedCatalog: CliProviderCatalog = {
        fetchCatalog: (input) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* catalog.fetchCatalog(input);
          }),
      };
      const settings = { ...f.settings, apiEndpoint: "https://original.invalid" };
      const fiber = yield* f
        .provide(discoverCursorModelsViaAcp(settings, undefined, gatedCatalog))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      settings.binaryPath = "changed-agent";
      settings.apiEndpoint = "https://changed.invalid";
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fiber))[0]?.slug).toBe("first");
      expect(f.commands).toHaveLength(1);
      expect(f.commands[0]?.command).toBe("cursor-agent");
      expect(f.commands[0]?.args).toEqual(["-e", "https://original.invalid", "acp"]);
      expect(f.finalized).toEqual([1]);
      f.assertNoSessions();
    }),
  );

  it.effect("等待期间配置变更不改本轮 key、启动参数和自定义模型，检查时间取返回时刻", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks.add("about");
      const firstSettings = {
        ...f.settings,
        apiEndpoint: "https://original.invalid",
        customModels: ["one"],
      };
      const first = yield* f
        .checkSettings(firstSettings)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("about");
      yield* TestClock.adjust("3 seconds");
      const secondSettings = {
        ...f.settings,
        apiEndpoint: "https://original.invalid",
        customModels: ["two"],
      };
      const second = yield* f
        .checkSettings(secondSettings)
        .pipe(Effect.forkChild({ startImmediately: true }));
      firstSettings.binaryPath = "changed-agent";
      firstSettings.apiEndpoint = "https://changed.invalid";
      firstSettings.customModels.push("changed-one");
      secondSettings.customModels.push("changed-two");
      yield* TestClock.adjust("2 seconds");
      yield* f.release("about");
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      const completedAt = DateTime.formatIso(yield* DateTime.now);
      expect(a.checkedAt).toBe(completedAt);
      expect(b.checkedAt).toBe(completedAt);
      expect(a.models.map((model) => model.slug)).toEqual(["first", "one"]);
      expect(b.models.map((model) => model.slug)).toEqual(["first", "two"]);
      expect(f.controllers).toHaveLength(1);
      expect(f.commands.map((command) => command.command)).toEqual([
        "cursor-agent",
        "cursor-agent",
      ]);
      expect(f.commands[1]?.args).toEqual(["-e", "https://original.invalid", "acp"]);
      expect(f.catalogCalls).toHaveLength(1);
    }),
  );

  for (const stage of ["channel", "authenticate", "cursor/list_available_models"] as const) {
    it.effect(`${stage} 等待共享 about 已消耗的总预算，晚加入不续时`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blocks = new Set(["about", stage]);
        const first = yield* f.check(["one"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* f.entered("about");
        yield* TestClock.adjust("5 seconds");
        yield* f.release("about");
        yield* f.entered(stage);
        const second = yield* f.check(["two"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("9999 millis");
        expect(f.controllers).toHaveLength(1);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        yield* TestClock.adjust("1 millis");
        const a = yield* Fiber.join(first);
        const b = yield* Fiber.join(second);
        expect(a.message).toContain("15000ms");
        expect(a.auth).toMatchObject({ status: "authenticated", email: "first@example.test" });
        expect(a.version).toBe("2026.04.09-first");
        expect(a.models.map((model) => model.slug)).toEqual(["one"]);
        expect(b.models.map((model) => model.slug)).toEqual(["two"]);
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual(f.commands.map((_, index) => index + 1));
        f.state.blocks.clear();
        f.state.model = "recovered";
        expect((yield* f.check()).models[0]?.slug).toBe("recovered");
        expect(f.controllers).toHaveLength(2);
        expect(f.controllers[1]).not.toBe(f.controllers[0]);
        f.assertNoSessions();
      }),
    );
  }

  for (const cancelAll of [false, true]) {
    it.effect(`${cancelAll ? "最后" : "首个"}等待者取消遵守共同探针所有权`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blocks.add("cursor/list_available_models");
        const first = yield* f.check(["one"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* f.entered("cursor/list_available_models");
        const second = yield* f.check(["two"]).pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        expect(f.finalized).toEqual([1]);
        if (cancelAll) yield* Fiber.interrupt(second);
        else {
          yield* f.release("cursor/list_available_models");
          expect((yield* Fiber.join(second)).models.map((model) => model.slug)).toEqual([
            "first",
            "two",
          ]);
        }
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual([1, 2]);
        expect(f.count("initialize")).toBe(1);
        expect(f.catalogCalls.every((call) => call.shareInFlight === false)).toBe(true);
        f.assertNoSessions();
      }),
    );
  }

  it.effect("稳定身份只缓存纯目录，版本、账号、套餐和渠道变化都重新探测", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.check(["one"]);
      const cached = yield* f.check(["two"]);
      expect(cached.models.map((model) => model.slug)).toEqual(["first", "two"]);
      expect(f.count("cursor/list_available_models")).toBe(1);
      expect(f.channelReads).toHaveLength(2);
      f.state.version = "2026.04.10-next";
      yield* f.check();
      f.state.email = "second@example.test";
      yield* f.check();
      f.state.subscriptionTier = "business";
      yield* f.check();
      f.state.channel = "";
      yield* f.check();
      expect(f.count("cursor/list_available_models")).toBe(5);
      f.state.email = undefined;
      yield* f.check();
      yield* f.check();
      expect(f.count("cursor/list_available_models")).toBe(7);
      f.state.email = "second@example.test";
      f.state.version = null;
      yield* f.check();
      yield* f.check();
      expect(f.count("cursor/list_available_models")).toBe(9);
      expect(f.catalogCalls).toHaveLength(6);
      expect(
        f.commands.every(
          (command) => command.options.cwd === cwd && command.options.extendEnv === false,
        ),
      ).toBe(true);
      expect(f.commands.every((command) => command.options.forceKillAfter === "2 seconds")).toBe(
        true,
      );
      expect(
        f.commands.every(
          (command) => JSON.stringify(command.options.env) === JSON.stringify(environment),
        ),
      ).toBe(true);
      expect(f.controllers.every((controller) => controller.signal.aborted)).toBe(true);
      f.assertNoSessions();
    }),
  );

  it.effect("显式共享 signal 中断不会降级为目录 warning，预取消不启动进程", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks.add("authenticate");
      const fiber = yield* f.check().pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("authenticate");
      f.controllers[0]?.abort();
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(f.count("cursor/list_available_models")).toBe(0);
      expect(f.finalized).toEqual([1, 2]);
      f.state.preAbort = true;
      expect(Exit.isFailure(yield* f.check().pipe(Effect.exit))).toBe(true);
      expect(f.commands).toHaveLength(2);
    }),
  );

  it.effect("强刷新与普通加载独立，晚普通等待者加入强刷新且旧结果不覆盖完成目录", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks.add("cursor/list_available_models");
      const old = yield* f.check().pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("cursor/list_available_models");
      f.state.blocks = new Set(["initialize"]);
      f.state.model = "strong";
      const strong = yield* f
        .check(["strong-custom"])
        .pipe(
          Effect.provideService(ProviderCatalogForceRefresh, true),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* f.entered("initialize");
      const ordinary = yield* f
        .check(["ordinary-custom"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.release("initialize");
      expect((yield* Fiber.join(strong)).models.map((model) => model.slug)).toEqual([
        "strong",
        "strong-custom",
      ]);
      expect((yield* Fiber.join(ordinary)).models.map((model) => model.slug)).toEqual([
        "strong",
        "ordinary-custom",
      ]);
      yield* f.release("cursor/list_available_models");
      expect((yield* Fiber.join(old)).models[0]?.slug).toBe("first");
      f.state.blocks.clear();
      expect((yield* f.check()).models[0]?.slug).toBe("strong");
      expect(f.count("cursor/list_available_models")).toBe(2);
      expect(f.controllers).toHaveLength(3);
    }),
  );

  it.effect("原生失败可重试，禁用、未登录与 pending 不创建草稿会话", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.failMethod = "cursor/list_available_models";
      expect((yield* f.check(["custom"])).status).toBe("warning");
      f.state.failMethod = "";
      expect((yield* f.check()).status).toBe("ready");
      expect(f.count("cursor/list_available_models")).toBe(2);
      f.state.email = null;
      expect((yield* f.check()).auth.status).toBe("unauthenticated");
      expect(f.count("cursor/list_available_models")).toBe(2);
      const before = f.commands.length;
      expect(
        (yield* f.check(["custom"], { enabled: false })).models.map((model) => model.slug),
      ).toEqual(["custom"]);
      const pending = yield* buildInitialCursorProviderSnapshot({
        ...f.settings,
        customModels: ["custom"],
      });
      expect(pending.models.map((model) => model.slug)).toEqual(["custom"]);
      expect(f.commands).toHaveLength(before);
      f.assertNoSessions();
    }),
  );
});
