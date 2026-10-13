import { OpenCodeSettings } from "@codework/contracts";
import { HostProcessEnvironment } from "@codework/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";

import { makeOpenCodeCatalog, type OpenCodeCatalogInput } from "./OpenCodeCatalog.ts";
import { ProviderCatalogForceRefresh } from "./ProviderCatalogCache.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "./Layers/OpenCodeProvider.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "./opencodeRuntime.ts";

const input: OpenCodeCatalogInput = {
  binaryPath: "fixture-opencode",
  serverUrl: "",
  serverPassword: "",
  cwd: "/fixture/project",
  environment: { PATH: "/fixture/bin", OPENCODE_CONFIG_CONTENT: "{}" },
};
const inventory = (connected = ["openai"]): OpenCodeInventory => ({
  providerList: { all: [], connected, default: {} },
  agents: [],
  skills: [],
});
const batchInventory = (batch: string, connected = ["openai"]) =>
  ({
    providerList: {
      connected,
      default: {},
      all: [
        {
          id: "openai",
          name: "OpenAI",
          models: { [batch]: { id: batch, name: batch, variants: { [batch]: {} } } },
        },
      ],
    },
    agents: [{ name: batch, hidden: false, mode: "primary" }],
    skills: [{ name: batch, location: `/skills/${batch}/SKILL.md` }],
  }) as unknown as OpenCodeInventory;
const makeRuntime = (overrides: Partial<OpenCodeRuntimeShape> = {}) => {
  const commands: Array<Parameters<OpenCodeRuntimeShape["runOpenCodeCommand"]>[0]> = [];
  const cli: Array<Parameters<OpenCodeRuntimeShape["loadInventoryFromCli"]>[0]> = [];
  const clients: Array<Parameters<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>[0]> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => Effect.die("目录不得启动本地服务器"),
    connectToOpenCodeServer: () => Effect.die("目录不得借用服务器生命周期"),
    runOpenCodeCommand: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { stdout: "opencode 1.14.19", stderr: "", code: 0 };
      }),
    loadInventoryFromCli: (request) =>
      Effect.sync(() => {
        cli.push(request);
        return inventory();
      }),
    createOpenCodeSdkClient: (request) => {
      clients.push(request);
      return {} as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>;
    },
    loadOpenCodeInventory: (_, signal) =>
      Effect.sync(() => {
        signals.push(signal);
        return inventory();
      }),
    ...overrides,
  };
  return { runtime, commands, cli, clients, signals };
};
const settings = Schema.decodeSync(OpenCodeSettings);
const makeSettings = (overrides: Partial<OpenCodeSettings> = {}) =>
  settings({ enabled: true, customModels: [], ...input, ...overrides });

describe("OpenCodeCatalog", () => {
  it.effect("等价本地检查共享版本与目录，完成后使用新运行时读取当前认证", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      const firstRuntime = makeRuntime({
        loadInventoryFromCli: () =>
          Effect.gen(function* () {
            loads += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return inventory();
          }),
      });
      const secondRuntime = makeRuntime({
        loadInventoryFromCli: () => Effect.succeed(inventory([])),
      });
      const first = yield* catalog
        .fetchCatalog(input)
        .pipe(
          Effect.provideService(OpenCodeRuntime, firstRuntime.runtime),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(entered);
      const second = yield* catalog
        .fetchCatalog(input)
        .pipe(
          Effect.provideService(OpenCodeRuntime, secondRuntime.runtime),
          Effect.provideService(ProviderCatalogForceRefresh, true),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second));
      assert.strictEqual(loads, 1);
      assert.strictEqual(firstRuntime.commands.length, 1);
      assert.strictEqual(secondRuntime.commands.length, 0);
      const next = yield* catalog
        .fetchCatalog(input)
        .pipe(Effect.provideService(OpenCodeRuntime, secondRuntime.runtime));
      assert.strictEqual(next.status, "ready");
      if (next.status === "ready")
        assert.deepStrictEqual(next.inventory.providerList.connected, []);
      assert.strictEqual(secondRuntime.commands.length, 1);
    }),
  );

  it.effect("远端身份只使用规范 URL、密码和目录，执行不启动 CLI 或服务器", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let loads = 0;
      const fixture = makeRuntime({
        loadOpenCodeInventory: (_, signal) =>
          Effect.gen(function* () {
            assert.isDefined(signal);
            loads += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return inventory();
          }),
      });
      const request = {
        ...input,
        serverUrl: "  https://server.test/prefix  ",
        serverPassword: " p ",
      };
      const first = yield* catalog
        .fetchCatalog(request)
        .pipe(
          Effect.provideService(OpenCodeRuntime, fixture.runtime),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(entered);
      const second = yield* catalog
        .fetchCatalog({
          ...request,
          serverUrl: "https://server.test/prefix",
          binaryPath: "unused-other-binary",
          environment: { UNRELATED: "different" },
        })
        .pipe(
          Effect.provideService(OpenCodeRuntime, fixture.runtime),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(yield* Fiber.join(first), yield* Fiber.join(second));
      assert.strictEqual(loads, 1);
      assert.deepStrictEqual(fixture.clients, [
        {
          baseUrl: "https://server.test/prefix",
          directory: input.cwd,
          serverPassword: " p ",
        },
      ]);
      assert.deepStrictEqual(fixture.commands, []);
      assert.deepStrictEqual(fixture.cli, []);
    }),
  );

  for (const remote of [false, true]) {
    it.effect(`${remote ? "远端" : "本地"}实际执行参数变化不会错误共享`, () =>
      Effect.gen(function* () {
        const catalog = yield* makeOpenCodeCatalog();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const firstRuntime = makeRuntime({
          loadInventoryFromCli: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(inventory()),
            ),
          loadOpenCodeInventory: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(inventory()),
            ),
        });
        const request = {
          ...input,
          ...(remote ? { serverUrl: "https://server.test", serverPassword: "one" } : {}),
        };
        const first = yield* catalog
          .fetchCatalog(request)
          .pipe(
            Effect.provideService(OpenCodeRuntime, firstRuntime.runtime),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(entered);
        const changes: ReadonlyArray<Partial<OpenCodeCatalogInput>> = remote
          ? [{ serverUrl: "https://other.test" }, { serverPassword: "two" }, { cwd: "/other" }]
          : [
              { binaryPath: "other" },
              { cwd: "/other" },
              { environment: { ...input.environment, PATH: "/other" } },
              { environment: { ...input.environment, OPENCODE_CONFIG_CONTENT: '{"provider":{}}' } },
            ];
        for (const change of changes) {
          const fixture = makeRuntime();
          yield* catalog
            .fetchCatalog({ ...request, ...change })
            .pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
          assert.strictEqual(remote ? fixture.clients.length : fixture.commands.length, 1);
        }
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
      }),
    );

    for (const cancelAll of [false, true]) {
      it.effect(
        `${remote ? "远端" : "本地"}${cancelAll ? "最后" : "首个"}等待者取消只影响所属加载生命周期`,
        () =>
          Effect.gen(function* () {
            const catalog = yield* makeOpenCodeCatalog();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const interrupted = yield* Deferred.make<void>();
            let signal: AbortSignal | undefined;
            const load = (currentSignal?: AbortSignal) =>
              Effect.gen(function* () {
                signal = currentSignal;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return inventory();
              }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)));
            const fixture = makeRuntime({
              loadInventoryFromCli: (request) => load(request.signal),
              loadOpenCodeInventory: (_, signal) => load(signal),
            });
            const request = { ...input, ...(remote ? { serverUrl: "https://server.test" } : {}) };
            const first = yield* catalog
              .fetchCatalog(request)
              .pipe(
                Effect.provideService(OpenCodeRuntime, fixture.runtime),
                Effect.forkChild({ startImmediately: true }),
              );
            yield* Deferred.await(entered);
            const second = yield* catalog
              .fetchCatalog(request)
              .pipe(
                Effect.provideService(OpenCodeRuntime, fixture.runtime),
                Effect.forkChild({ startImmediately: true }),
              );
            yield* Fiber.interrupt(first);
            assert.strictEqual(signal?.aborted, false);
            assert.isFalse(yield* Deferred.isDone(interrupted));
            if (cancelAll) {
              yield* Fiber.interrupt(second);
              yield* Deferred.await(interrupted);
            } else {
              yield* Deferred.succeed(release, undefined);
              assert.strictEqual((yield* Fiber.join(second)).status, "ready");
            }
            assert.strictEqual(signal?.aborted, true);
            if (!remote) assert.strictEqual(fixture.commands[0]?.signal, signal);
            const next = makeRuntime();
            yield* catalog
              .fetchCatalog(request)
              .pipe(Effect.provideService(OpenCodeRuntime, next.runtime));
            assert.strictEqual(remote ? next.clients.length : next.commands.length, 1);
          }),
      );
    }
  }

  it.effect("版本、重试等待与目录共用 15 秒预算，超时保留版本且结束信号", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const versionEntered = yield* Deferred.make<void>();
      const versionRelease = yield* Deferred.make<void>();
      const retryEntered = yield* Deferred.make<void>();
      const inventoryEntered = yield* Deferred.make<void>();
      let versionSignal: AbortSignal | undefined;
      let inventorySignal: AbortSignal | undefined;
      const fixture = makeRuntime({
        runOpenCodeCommand: (request) =>
          Effect.gen(function* () {
            versionSignal = request.signal;
            yield* Deferred.succeed(versionEntered, undefined);
            yield* Deferred.await(versionRelease);
            return { stdout: "opencode 1.14.19", stderr: "", code: 0 };
          }),
        loadInventoryFromCli: (request) =>
          Effect.gen(function* () {
            inventorySignal = request.signal;
            yield* Deferred.succeed(retryEntered, undefined);
            yield* Effect.sleep("1 second");
            yield* Deferred.succeed(inventoryEntered, undefined);
            return yield* Effect.never;
          }),
      });
      const fiber = yield* catalog
        .fetchCatalog(input)
        .pipe(
          Effect.provideService(OpenCodeRuntime, fixture.runtime),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(versionEntered);
      yield* TestClock.adjust("8 seconds");
      yield* Deferred.succeed(versionRelease, undefined);
      yield* Deferred.await(retryEntered);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(inventoryEntered);
      assert.strictEqual(inventorySignal, versionSignal);
      const later = yield* catalog.fetchCatalog(input).pipe(
        Effect.provideService(
          OpenCodeRuntime,
          makeRuntime({
            runOpenCodeCommand: () => Effect.die("后加入者不能重新获得完整预算"),
          }).runtime,
        ),
        Effect.result,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("5999 millis");
      assert.strictEqual(inventorySignal?.aborted, false);
      yield* TestClock.adjust("1 millis");
      const result = yield* Fiber.join(fiber);
      assert.deepStrictEqual(yield* Fiber.join(later), result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure.version, "1.14.19");
        assert.include(result.failure.detail, "timed out after 15 seconds");
      }
      assert.strictEqual(inventorySignal?.aborted, true);
    }),
  );

  it.effect("版本阶段也受同一预算约束，最低版本与非零退出不进入目录", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const slow = makeRuntime({
        runOpenCodeCommand: (request) =>
          Effect.gen(function* () {
            signal = request.signal;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
      });
      const fiber = yield* catalog
        .fetchCatalog(input)
        .pipe(
          Effect.provideService(OpenCodeRuntime, slow.runtime),
          Effect.result,
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      const timedOut = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(timedOut));
      if (Result.isFailure(timedOut)) assert.strictEqual(timedOut.failure.version, null);
      assert.strictEqual(signal?.aborted, true);
      assert.deepStrictEqual(slow.cli, []);
      const old = makeRuntime({
        runOpenCodeCommand: () => Effect.succeed({ stdout: "1.14.18", stderr: "", code: 0 }),
      });
      assert.deepStrictEqual(
        yield* catalog
          .fetchCatalog(input)
          .pipe(Effect.provideService(OpenCodeRuntime, old.runtime)),
        { status: "unsupported", version: "1.14.18" },
      );
      assert.deepStrictEqual(old.cli, []);
      const failed = makeRuntime({
        runOpenCodeCommand: () =>
          Effect.succeed({ stdout: "1.14.19", stderr: "version failed", code: 1 }),
      });
      const result = yield* catalog
        .fetchCatalog(input)
        .pipe(Effect.provideService(OpenCodeRuntime, failed.runtime), Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.detail, "version failed");
      assert.deepStrictEqual(failed.cli, []);
    }),
  );

  it.effect("远端超时中止同一信号，SDK 同步异常转成可恢复健康错误", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      let signal: AbortSignal | undefined;
      const slow = makeRuntime({
        loadOpenCodeInventory: (_, currentSignal) =>
          Effect.gen(function* () {
            signal = currentSignal;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
      });
      const remote = makeSettings({ serverUrl: "https://server.test" });
      const fiber = yield* checkOpenCodeProviderStatus(
        remote,
        input.cwd,
        input.environment,
        catalog,
      ).pipe(
        Effect.provideService(OpenCodeRuntime, slow.runtime),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust("15 seconds");
      const timedOut = yield* Fiber.join(fiber);
      assert.strictEqual(timedOut.status, "error");
      assert.strictEqual(timedOut.version, null);
      assert.strictEqual(timedOut.auth.status, "unknown");
      assert.strictEqual(signal?.aborted, true);
      for (const fixture of [
        makeRuntime({
          createOpenCodeSdkClient: () => {
            throw new TypeError("fixture SDK construction error");
          },
        }),
        makeRuntime({
          loadOpenCodeInventory: () => Effect.die(new TypeError("fixture SDK data error")),
        }),
      ]) {
        const failed = yield* checkOpenCodeProviderStatus(
          remote,
          input.cwd,
          input.environment,
          catalog,
        ).pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
        assert.strictEqual(failed.status, "error");
        assert.strictEqual(failed.auth.status, "unknown");
        assert.include(failed.message ?? "", "fixture SDK");
      }
      const recovered = yield* checkOpenCodeProviderStatus(
        remote,
        input.cwd,
        input.environment,
        catalog,
      ).pipe(Effect.provideService(OpenCodeRuntime, makeRuntime().runtime));
      assert.strictEqual(recovered.status, "ready");
    }),
  );

  it.effect("当前连接状态正反变化和失败会即时更新健康状态，不复用过去的认证", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      for (const connected of [["openai"], [], ["openai"]]) {
        const fixture = makeRuntime({
          loadInventoryFromCli: () => Effect.succeed(batchInventory("current", connected)),
        });
        const snapshot = yield* checkOpenCodeProviderStatus(
          makeSettings(),
          input.cwd,
          input.environment,
          catalog,
        ).pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
        assert.strictEqual(snapshot.auth.status, connected.length ? "authenticated" : "unknown");
        assert.strictEqual(snapshot.status, connected.length ? "ready" : "warning");
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          connected.length ? ["openai/current"] : [],
        );
      }
      const fixture = makeRuntime({
        loadInventoryFromCli: () =>
          Effect.fail(
            new OpenCodeRuntimeError({ operation: "inventory", detail: "fixture failure" }),
          ),
      });
      const failed = yield* checkOpenCodeProviderStatus(
        makeSettings(),
        input.cwd,
        input.environment,
        catalog,
      ).pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
      assert.strictEqual(failed.status, "error");
      assert.strictEqual(failed.auth.status, "unknown");
      assert.strictEqual(failed.version, "1.14.19");
      assert.deepStrictEqual(failed.models, []);
    }),
  );

  it.effect("每次发布的模型、variants、agent 模式和技能来自同一批目录", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      for (const batch of ["first", "second"]) {
        const fixture = makeRuntime({
          loadInventoryFromCli: () => Effect.succeed(batchInventory(batch)),
        });
        const snapshot = yield* checkOpenCodeProviderStatus(
          makeSettings(),
          input.cwd,
          input.environment,
          catalog,
        ).pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          [`openai/${batch}`],
        );
        for (const id of ["variant", "agent"]) {
          const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.find(
            (entry) => entry.id === id,
          );
          assert.isDefined(descriptor);
          if (descriptor?.type === "select")
            assert.deepStrictEqual(
              descriptor.options.map((option) => option.id),
              [batch],
            );
          else assert.fail("需要目录本批次的选项能力");
        }
        assert.deepStrictEqual(
          snapshot.skills.map((skill) => skill.name),
          [batch],
        );
      }
    }),
  );

  it.effect("调用方在版本等待中更改输入对象不会改变已匹配的实际执行参数", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let versionRequest: Parameters<OpenCodeRuntimeShape["runOpenCodeCommand"]>[0] | undefined;
      const fixture = makeRuntime({
        runOpenCodeCommand: (request) =>
          Effect.gen(function* () {
            versionRequest = request;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return { stdout: "1.14.19", stderr: "", code: 0 };
          }),
      });
      const mutable = { ...input, environment: { ...input.environment } };
      const fiber = yield* catalog
        .fetchCatalog(mutable)
        .pipe(
          Effect.provideService(OpenCodeRuntime, fixture.runtime),
          Effect.forkChild({ startImmediately: true }),
        );
      yield* Deferred.await(entered);
      mutable.binaryPath = "changed-binary";
      mutable.cwd = "/changed-directory";
      mutable.serverUrl = "https://changed.test";
      mutable.serverPassword = "changed-password";
      mutable.environment.OPENCODE_CONFIG_CONTENT = "changed-environment";
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.strictEqual(versionRequest?.binaryPath, input.binaryPath);
      assert.strictEqual(versionRequest?.extendEnv, false);
      assert.strictEqual(fixture.cli[0]?.binaryPath, input.binaryPath);
      assert.strictEqual(fixture.cli[0]?.cwd, input.cwd);
      assert.strictEqual(fixture.cli[0]?.extendEnv, false);
      assert.deepStrictEqual(fixture.cli[0]?.environment, input.environment);
      assert.deepStrictEqual(fixture.clients, []);
    }),
  );

  it.effect("实例自定义模型不进入共享目录身份，环境冻结且版本与目录使用同一参数", () =>
    Effect.gen(function* () {
      const catalog = yield* makeOpenCodeCatalog();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let captured: Parameters<OpenCodeRuntimeShape["loadInventoryFromCli"]>[0] | undefined;
      let loads = 0;
      const fixture = makeRuntime({
        loadInventoryFromCli: (request) =>
          Effect.gen(function* () {
            captured = request;
            loads += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return inventory();
          }),
      });
      const env = { OPENCODE_CONFIG_CONTENT: "fixture" };
      const check = (models: string[]) =>
        checkOpenCodeProviderStatus(
          makeSettings({ customModels: models }),
          input.cwd,
          env,
          catalog,
        ).pipe(
          Effect.provideService(OpenCodeRuntime, fixture.runtime),
          Effect.provideService(HostProcessEnvironment, { PATH: "host-path", HOME: "host-home" }),
        );
      const first = yield* check(["first"]).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(entered);
      const second = yield* check(["second"]).pipe(Effect.forkChild({ startImmediately: true }));
      env.OPENCODE_CONFIG_CONTENT = "later-mutation";
      yield* Deferred.succeed(release, undefined);
      assert.deepStrictEqual(
        (yield* Fiber.join(first)).models.map((model) => model.slug),
        ["first"],
      );
      assert.deepStrictEqual(
        (yield* Fiber.join(second)).models.map((model) => model.slug),
        ["second"],
      );
      assert.strictEqual(loads, 1);
      assert.strictEqual(fixture.commands.length, 1);
      assert.strictEqual(fixture.commands[0]?.cwd, input.cwd);
      assert.strictEqual(captured?.cwd, input.cwd);
      assert.strictEqual(captured?.signal, fixture.commands[0]?.signal);
      assert.deepStrictEqual(captured?.environment, {
        PATH: "host-path",
        HOME: "host-home",
        OPENCODE_CONFIG_CONTENT: "fixture",
      });
      assert.deepStrictEqual(fixture.commands[0]?.environment, captured?.environment);
    }),
  );

  it.effect("pending 与 disabled 保持纯配置，不执行目录入口", () =>
    Effect.gen(function* () {
      const fixture = makeRuntime();
      const catalog = { fetchCatalog: () => Effect.die("禁用入口不得刷新目录") };
      const disabled = yield* checkOpenCodeProviderStatus(
        makeSettings({ enabled: false, customModels: ["custom"] }),
        input.cwd,
        undefined,
        catalog,
      ).pipe(Effect.provideService(OpenCodeRuntime, fixture.runtime));
      const pending = yield* makePendingOpenCodeProvider(
        makeSettings({ customModels: ["custom"] }),
      );
      assert.deepStrictEqual(
        disabled.models.map((model) => model.slug),
        ["custom"],
      );
      assert.deepStrictEqual(
        pending.models.map((model) => model.slug),
        ["custom"],
      );
      assert.deepStrictEqual(fixture.commands, []);
      assert.deepStrictEqual(fixture.cli, []);
    }),
  );
});
