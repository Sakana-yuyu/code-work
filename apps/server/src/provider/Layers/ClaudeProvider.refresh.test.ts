import type {
  Options,
  Query,
  SDKControlInitializeResponse,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings } from "@codework/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { beforeEach, vi } from "vite-plus/test";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { checkClaudeProviderStatus, makePendingClaudeProvider } from "./ClaudeProvider.ts";
import { ProviderDriverKind } from "@codework/contracts";

const sdk = vi.hoisted(() => ({ query: vi.fn<typeof query>() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: sdk.query }));
beforeEach(() => {
  sdk.query.mockReset();
});
const settings = Schema.decodeSync(ClaudeSettings)({
  binaryPath: "/fixture/claude",
  homePath: "/fixture/home",
});

const makeFixture = Effect.fn("makeClaudeRefreshFixture")(function* () {
  const catalog = yield* makeCliProviderCatalog();
  const refreshes = yield* makeNativeProviderCatalog();
  const versionStarted = yield* Deferred.make<void>();
  const versionRelease = yield* Deferred.make<void>();
  const initialized = yield* Deferred.make<void>();
  const secondInitialized = yield* Deferred.make<void>();
  const scanStarted = yield* Deferred.make<void>();
  const scanRelease = yield* Deferred.make<void>();
  const secondRequested = yield* Deferred.make<void>();
  const thirdRequested = yield* Deferred.make<void>();
  const signalAborted = yield* Deferred.make<void>();
  const queryClosed = yield* Deferred.make<void>();
  const options: Array<Options> = [];
  const owners: Array<AbortController> = [];
  const resolveInitialization: Array<() => void> = [];
  const calls = { versions: 0, queriesClosed: 0, directories: 0, files: 0, refreshes: 0 };
  const state = {
    blockVersion: false,
    blockInitialization: false,
    blockScan: false,
    failInitialization: false,
    email: "first@example.test",
    version: "2.1.219",
  };
  const response = (): SDKControlInitializeResponse => ({
    commands: [{ name: "review", description: "检查", argumentHint: "[path]" }],
    agents: [],
    output_style: "default",
    available_output_styles: ["default"],
    models: [],
    account: { email: state.email, subscriptionType: "pro", tokenSource: "oauth" },
  });
  sdk.query.mockImplementation((input) => {
    options.push(input.options!);
    input.options!.abortController!.signal.addEventListener(
      "abort",
      () => {
        Deferred.doneUnsafe(signalAborted, Effect.void);
      },
      { once: true },
    );
    const index = options.length - 1;
    return {
      initializationResult: () => {
        Deferred.doneUnsafe(initialized, Effect.void);
        if (index === 1) Deferred.doneUnsafe(secondInitialized, Effect.void);
        if (state.failInitialization) return Promise.reject(new Error("当前账户初始化失败"));
        if (!state.blockInitialization) return Promise.resolve(response());
        return new Promise<SDKControlInitializeResponse>((resolve) => {
          resolveInitialization[index] = () => resolve(response());
        });
      },
      close: () => {
        calls.queriesClosed += 1;
        Deferred.doneUnsafe(queryClosed, Effect.void);
      },
    } as Query;
  });
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      expect(ChildProcess.isStandardCommand(command)).toBe(true);
      if (!ChildProcess.isStandardCommand(command)) throw new Error("测试只接受普通命令。");
      expect(command.args).toEqual(["--version"]);
      calls.versions += 1;
      yield* Deferred.succeed(versionStarted, undefined);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: (state.blockVersion ? Deferred.await(versionRelease) : Effect.void).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(0)),
        ),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(state.version)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const fileSystem = FileSystem.makeNoop({
    readDirectory: () =>
      Effect.gen(function* () {
        calls.directories += 1;
        yield* Deferred.succeed(scanStarted, undefined);
        if (state.blockScan) yield* Deferred.await(scanRelease);
        return ["review"];
      }),
    readFileString: () =>
      Effect.sync(() => {
        calls.files += 1;
        return "---\nname: review\ndescription: 检查\n---\n正文";
      }),
  });
  const observedRefreshes: NativeProviderCatalog = {
    ...refreshes,
    fetchCatalog: (input) =>
      Effect.gen(function* () {
        calls.refreshes += 1;
        if (calls.refreshes === 2) yield* Deferred.succeed(secondRequested, undefined);
        if (calls.refreshes === 3) yield* Deferred.succeed(thirdRequested, undefined);
        return yield* refreshes.fetchCatalog({
          ...input,
          load: (controller) =>
            Effect.sync(() => {
              owners.push(controller);
            }).pipe(Effect.andThen(input.load(controller))),
        });
      }),
  };
  const read = (customModels: ReadonlyArray<string> = [], enabled = true) =>
    checkClaudeProviderStatus(
      { ...settings, enabled, customModels },
      undefined,
      { INSTANCE_FLAG: "value" },
      "/fixture/workspace",
      catalog,
      observedRefreshes,
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provide(Path.layer),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, {
        PATH: "/host/bin",
        SYSTEMROOT: "host-system",
      }),
    );
  return {
    read,
    state,
    calls,
    options,
    resolveInitialization,
    versionStarted,
    versionRelease,
    initialized,
    secondInitialized,
    scanStarted,
    scanRelease,
    secondRequested,
    thirdRequested,
    signalAborted,
    queryClosed,
    owners,
    catalog,
  };
});

it.effect("版本、SDK 与技能扫描共同耗尽一次 30 秒预算，残缺目录不入缓存", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    fixture.state.blockVersion = true;
    fixture.state.blockInitialization = true;
    fixture.state.blockScan = true;
    fixture.state.version = "2.1.111";
    const startedAt = DateTime.toEpochMillis(yield* DateTime.now);
    const fiber = yield* fixture.read().pipe(Effect.forkChild);
    yield* Deferred.await(fixture.versionStarted);
    yield* TestClock.adjust("3 seconds");
    yield* Deferred.succeed(fixture.versionRelease, undefined);
    yield* Deferred.await(fixture.initialized);
    yield* TestClock.adjust("26 seconds");
    fixture.resolveInitialization[0]!();
    yield* Deferred.await(fixture.scanStarted);
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(false);
    expect(fixture.options[0]!.abortController).toBe(fixture.owners[0]);
    expect(fixture.calls.queriesClosed).toBe(0);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    expect(result.status).toBe("error");
    expect(result.installed).toBe(true);
    expect(result.version).toBe("2.1.111");
    // The degraded timeout draft carries the ungated built-in catalog; the
    // Claude driver still applies the manifest on top, and that gate — not the
    // probe — is what hides Opus 5 from an old CLI.
    const applied = ModelManifest.applyModelManifest(
      result,
      ModelManifest.BUNDLED_MODEL_MANIFEST,
      ProviderDriverKind.make("claudeAgent"),
    );
    expect(applied.models.some((model) => model.slug === "claude-opus-5")).toBe(false);
    expect(result.message).toContain("30 秒");
    expect(DateTime.toEpochMillis(yield* DateTime.now) - startedAt).toBe(30_000);
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(true);
    expect(fixture.calls).toMatchObject({
      versions: 1,
      queriesClosed: 1,
      directories: 1,
      files: 0,
    });
    fixture.state.blockVersion = false;
    fixture.state.blockInitialization = false;
    fixture.state.blockScan = false;
    expect((yield* fixture.read()).status).toBe("ready");
    expect(fixture.calls.directories).toBe(4);
    expect(fixture.options[1]!.abortController).not.toBe(fixture.options[0]!.abortController);
  }),
);

it.effect("晚到等待者不能续期，两份自定义模型各自合并超时结果", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    fixture.state.blockInitialization = true;
    const first = yield* fixture.read(["custom-a"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.initialized);
    yield* TestClock.adjust("20 seconds");
    const second = yield* fixture.read(["custom-b"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.secondRequested);
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");
    const [a, b] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    expect(a.message).toContain("30 秒");
    expect(b.message).toContain("30 秒");
    expect(a.models.at(-1)?.slug).toBe("custom-a");
    expect(b.models.at(-1)?.slug).toBe("custom-b");
    expect(fixture.options).toHaveLength(1);
    expect(fixture.calls.queriesClosed).toBe(1);
  }),
);

it.effect("首等待者取消保留同一个 SDK 信号，最后技能完成后才关闭 Query", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    fixture.state.blockScan = true;
    const first = yield* fixture.read(["custom-a"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.scanStarted);
    const second = yield* fixture.read(["custom-b"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.secondRequested);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    expect(fixture.options).toHaveLength(1);
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(false);
    expect(fixture.calls.queriesClosed).toBe(0);
    yield* Deferred.succeed(fixture.scanRelease, undefined);
    const result = yield* Fiber.join(second);
    expect(result.status).toBe("ready");
    expect(result.models.at(-1)?.slug).toBe("custom-b");
    expect(result.models.some((model) => model.slug === "custom-a")).toBe(false);
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(true);
    expect(fixture.calls.queriesClosed).toBe(1);
  }),
);

it.effect("最后等待者取消会中止 SDK，迟到 initialize 不得继续读取技能", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    fixture.state.blockInitialization = true;
    const fiber = yield* fixture.read().pipe(Effect.forkChild);
    yield* Deferred.await(fixture.initialized);
    yield* Fiber.interrupt(fiber);
    // 等待共享加载的真实释放收据，取消等待者本身不等于共享 finalizer 已排空。
    yield* Deferred.await(fixture.signalAborted);
    yield* Deferred.await(fixture.queryClosed);
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(true);
    expect(fixture.calls.queriesClosed).toBe(1);
    fixture.resolveInitialization[0]!();
    yield* Effect.yieldNow;
    expect(fixture.calls.directories).toBe(0);
  }),
);

it.effect("完成目录命中仍更新当前账户，认证失败和恢复都不复用旧认证", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const first = yield* fixture.read();
    const firstScans = fixture.calls.directories;
    yield* TestClock.adjust("1 second");
    fixture.state.email = "second@example.test";
    const second = yield* fixture.read();
    expect(first.auth.email).toBe("first@example.test");
    expect(second.auth.email).toBe("second@example.test");
    expect(second.checkedAt).not.toBe(first.checkedAt);
    expect(second.models).toBe(first.models);
    expect(fixture.calls.directories).toBe(firstScans);
    fixture.state.failInitialization = true;
    const failed = yield* fixture.read();
    expect(failed.auth.status).toBe("unknown");
    fixture.state.failInitialization = false;
    fixture.state.email = "third@example.test";
    const recovered = yield* fixture.read();
    expect(recovered.auth.email).toBe("third@example.test");
    const scannedAfterFailure = fixture.calls.directories;
    const forced = yield* fixture
      .read()
      .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
    expect(forced.auth.email).toBe("third@example.test");
    expect(fixture.calls.directories).toBe(scannedAfterFailure + 3);
    expect(fixture.calls.versions).toBe(5);
  }),
);

it.effect("pending 与禁用检查不创建版本进程或 SDK 查询", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    const pending = yield* makePendingClaudeProvider(settings, fixture.catalog);
    const disabled = yield* fixture.read(["custom-disabled"], false);
    expect(pending.auth.status).toBe("unknown");
    expect(disabled.enabled).toBe(false);
    expect(disabled.models.at(-1)?.slug).toBe("custom-disabled");
    expect(fixture.calls).toEqual({
      versions: 0,
      queriesClosed: 0,
      directories: 0,
      files: 0,
      refreshes: 0,
    });
    expect(sdk.query).not.toHaveBeenCalled();
  }),
);

it.effect("强刷新不加入普通检查，晚到普通等待者可以共享强刷新", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture();
    fixture.state.blockInitialization = true;
    const ordinary = yield* fixture.read(["ordinary-custom"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.initialized);
    const strong = yield* fixture
      .read(["strong-custom"])
      .pipe(Effect.provideService(ProviderCatalogForceRefresh, true), Effect.forkChild);
    yield* Deferred.await(fixture.secondInitialized);
    const late = yield* fixture.read(["late-custom"]).pipe(Effect.forkChild);
    yield* Deferred.await(fixture.thirdRequested);
    yield* Effect.yieldNow;
    expect(fixture.options).toHaveLength(2);
    fixture.state.email = "strong@example.test";
    fixture.resolveInitialization[1]!();
    const [strongResult, lateResult] = yield* Effect.all([Fiber.join(strong), Fiber.join(late)]);
    expect(strongResult.auth.email).toBe("strong@example.test");
    expect(lateResult.auth.email).toBe("strong@example.test");
    expect(strongResult.models.at(-1)?.slug).toBe("strong-custom");
    expect(lateResult.models.at(-1)?.slug).toBe("late-custom");
    expect(fixture.options[0]!.abortController!.signal.aborted).toBe(false);
    fixture.resolveInitialization[0]!();
    expect((yield* Fiber.join(ordinary)).models.at(-1)?.slug).toBe("ordinary-custom");
    expect(fixture.calls.versions).toBe(2);
    expect(fixture.calls.queriesClosed).toBe(2);
  }),
);
