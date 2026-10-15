import { ClaudeSettings } from "@codework/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import {
  checkClaudeProviderStatus,
  fetchClaudeCatalog,
  makePendingClaudeProvider,
} from "./ClaudeProvider.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);

const makeNativeInput = () => {
  let account = "first@example.test";
  let command = "review";
  let failed = false;
  let probes = 0;
  let scans = 0;
  return {
    setAccount: (next: string) => {
      account = next;
    },
    setCommand: (next: string) => {
      command = next;
    },
    setFailed: (next: boolean) => {
      failed = next;
    },
    counts: () => ({ probes, scans }),
    input: {
      executablePath: "/bin/claude",
      environment: { CLAUDE_CONFIG_DIR: "/test/config" },
      cwd: "/test/workspace",
      capabilities: Effect.sync(() => {
        probes += 1;
        return failed
          ? undefined
          : {
              email: account,
              subscriptionType: "pro",
              tokenSource: "oauth",
              apiProvider: "firstParty",
              slashCommands: [{ name: command, description: "命令说明" }],
            };
      }),
      skills: Effect.sync(() => {
        scans += 1;
        return [];
      }),
    },
  };
};

it.effect("等价配置共享纯目录，但当前账号不进入缓存", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const fixture = makeNativeInput();
    const first = yield* fetchClaudeCatalog(
      { customModels: [" custom ", "custom", ""] },
      catalog,
      fixture.input,
    );
    fixture.setAccount("second@example.test");
    const second = yield* fetchClaudeCatalog({ customModels: ["custom"] }, catalog, fixture.input);
    expect(second.catalog).toBe(first.catalog);
    expect(first.account?.email).toBe("first@example.test");
    expect(second.account?.email).toBe("second@example.test");
    expect(second.catalog).not.toHaveProperty("account");
    expect(fixture.counts()).toEqual({ probes: 2, scans: 1 });
    expect(
      second.catalog.models.find((model) => model.slug === "claude-opus-5")?.capabilities
        ?.optionDescriptors,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: "effort" })]));
  }),
);

it.effect("手动刷新与到期重新读取技能，普通刷新复用目录", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const fixture = makeNativeInput();
    const read = fetchClaudeCatalog({ customModels: [] }, catalog, fixture.input);
    const first = yield* read;
    expect((yield* read).catalog).toBe(first.catalog);
    const forced = yield* read.pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
    expect(forced.catalog).not.toBe(first.catalog);
    yield* TestClock.adjust("61 seconds");
    expect((yield* read).catalog).not.toBe(forced.catalog);
    expect(fixture.counts()).toEqual({ probes: 4, scans: 3 });
  }),
);

it.effect("执行位置、配置目录、路由环境、命令和自定义模型改变时重建目录", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const fixture = makeNativeInput();
    const first = yield* fetchClaudeCatalog({ customModels: [] }, catalog, fixture.input);
    for (const patch of [
      { executablePath: "/another/claude" },
      { cwd: "/another/workspace" },
      { environment: { CLAUDE_CONFIG_DIR: "/another/config" } },
      {
        environment: { ...fixture.input.environment, ANTHROPIC_BASE_URL: "http://127.0.0.1:12345" },
      },
    ]) {
      const changed = yield* fetchClaudeCatalog({ customModels: [] }, catalog, {
        ...fixture.input,
        ...patch,
      });
      expect(changed.catalog).not.toBe(first.catalog);
    }
    fixture.setCommand("inspect");
    const commandChanged = yield* fetchClaudeCatalog({ customModels: [] }, catalog, fixture.input);
    expect(commandChanged.catalog.slashCommands?.map((command) => command.name)).toEqual([
      "compact",
      "inspect",
    ]);
    expect(commandChanged.catalog).not.toBe(first.catalog);
    const customChanged = yield* fetchClaudeCatalog(
      { customModels: ["custom"] },
      catalog,
      fixture.input,
    );
    expect(customChanged.catalog.models.at(-1)?.slug).toBe("custom");
    expect(fixture.counts()).toEqual({ probes: 7, scans: 7 });
  }),
);

it.effect("初始化失败不污染成功目录，也不延长旧成功值的有效期", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const fixture = makeNativeInput();
    const read = fetchClaudeCatalog({ customModels: [] }, catalog, fixture.input);
    const first = yield* read;
    yield* TestClock.adjust("30 seconds");
    fixture.setFailed(true);
    const failed = yield* read.pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
    expect(failed.account).toBeUndefined();
    expect(failed.catalog.slashCommands?.map((command) => command.name)).toEqual(["compact"]);
    fixture.setFailed(false);
    expect((yield* read).catalog).toBe(first.catalog);
    yield* TestClock.adjust("31 seconds");
    expect((yield* read).catalog).not.toBe(first.catalog);
    expect(fixture.counts()).toEqual({ probes: 4, scans: 3 });
  }),
);

it.effect("pending 目录不创建 SDK 会话，并且不吞掉随后原生目录", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const settings = decodeSettings({ customModels: ["custom"] });
    const fixture = makeNativeInput();
    const initial = yield* makePendingClaudeProvider(settings, catalog);
    const configured = yield* fetchClaudeCatalog(settings, catalog);
    expect(initial.models).toBe(configured.catalog.models);
    expect(initial.auth.status).toBe("unknown");
    expect(fixture.counts()).toEqual({ probes: 0, scans: 0 });
    const checked = yield* fetchClaudeCatalog(settings, catalog, fixture.input);
    expect(checked.catalog).not.toBe(configured.catalog);
    expect(checked.catalog.slashCommands?.map((command) => command.name)).toEqual([
      "compact",
      "review",
    ]);
  }),
);

it.effect("首个等待者取消不会关闭另一个实例仍在等待的目录加载", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const fixture = makeNativeInput();
    const scanning = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const joined = yield* Deferred.make<void>();
    let scans = 0;
    const skills = Effect.gen(function* () {
      scans += 1;
      yield* Deferred.succeed(scanning, undefined);
      yield* Deferred.await(release);
      return [];
    });
    const read = fetchClaudeCatalog({ customModels: [] }, catalog, { ...fixture.input, skills });
    const first = yield* read.pipe(Effect.forkChild);
    yield* Deferred.await(scanning);
    // 第二份账户已独立读取，随后才能进入共享目录等待。
    const second = yield* fetchClaudeCatalog({ customModels: [] }, catalog, {
      ...fixture.input,
      capabilities: fixture.input.capabilities.pipe(
        Effect.tap(() => Deferred.succeed(joined, undefined)),
      ),
      skills,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(joined);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(second);
    expect(result.catalog.slashCommands?.map((command) => command.name)).toEqual([
      "compact",
      "review",
    ]);
    expect(scans).toBe(1);
    expect((yield* read).catalog).toBe(result.catalog);
  }),
);

it.layer(NodeServices.layer)("Claude 状态入口", (it) => {
  it.effect("两个等价实例共享目录，版本、账户、禁用状态每次实时读取", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "claude-catalog-status-" });
      const settings = decodeSettings({ homePath: directory, binaryPath: "/test/claude" });
      const catalog = yield* makeCliProviderCatalog();
      const fixture = makeNativeInput();
      let version = "2.1.219";
      let versions = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("只接受普通版本命令。");
          expect(command.args).toEqual(["--version"]);
          expect(command.options.cwd).toBe(directory);
          expect(command.options.env?.PATH).toBe("/host/bin");
          expect(command.options.env?.SYSTEMROOT).toBe("host-system");
          expect(command.options.env?.CLAUDE_INSTANCE_FLAG).toBe("instance");
          versions += 1;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(version)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const read = (current = settings) =>
        checkClaudeProviderStatus(
          current,
          () => fixture.input.capabilities,
          { CLAUDE_INSTANCE_FLAG: "instance" },
          directory,
          catalog,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.provideService(HostProcessEnvironment, {
            PATH: "/host/bin",
            SYSTEMROOT: "host-system",
          }),
        );
      const first = yield* read();
      fixture.setAccount("next@example.test");
      const second = yield* read();
      expect(second.models).toBe(first.models);
      expect(second.skills).toEqual(first.skills);
      expect(second.auth.email).toBe("next@example.test");
      expect(first.auth.email).toBe("first@example.test");
      version = "2.1.111";
      const upgraded = yield* read();
      expect(upgraded.version).toBe(version);
      // Model gating moved to `applyModelManifest` at the driver boundary;
      // the status check itself returns the full catalog.
      expect(upgraded.models).toBe(first.models);
      const disabled = yield* read({ ...settings, enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(disabled.auth.status).toBe("unknown");
      expect(versions).toBe(3);
      expect(fixture.counts().probes).toBe(3);
      expect(yield* fs.exists(path.join(directory, "projects"))).toBe(false);
    }).pipe(Effect.scoped),
  );
});
