import { AntigravitySettings, KimiSettings } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import {
  buildInitialAntigravityProviderSnapshot,
  checkAntigravityProviderStatus,
  fetchAntigravityCatalog,
} from "./AntigravityProvider.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  fetchKimiCatalog,
} from "./KimiProvider.ts";

const decodeKimi = Schema.decodeSync(KimiSettings);
const decodeAntigravity = Schema.decodeSync(AntigravitySettings);
interface ConfigInput {
  readonly enabled?: boolean;
  readonly binaryPath?: string;
  readonly customModels?: ReadonlyArray<string>;
}

const providers = [
  {
    name: "Kimi",
    fetch: fetchKimiCatalog,
    initial: (settings: ConfigInput, catalog?: CliProviderCatalog) =>
      buildInitialKimiProviderSnapshot(decodeKimi(settings), catalog),
    check: (settings: ConfigInput, catalog?: CliProviderCatalog) =>
      checkKimiProviderStatus(decodeKimi(settings), { ACCOUNT: settings.binaryPath }, catalog),
  },
  {
    name: "Antigravity",
    fetch: fetchAntigravityCatalog,
    initial: (settings: ConfigInput, catalog?: CliProviderCatalog) =>
      buildInitialAntigravityProviderSnapshot(decodeAntigravity(settings), catalog),
    check: (settings: ConfigInput, catalog?: CliProviderCatalog) =>
      checkAntigravityProviderStatus(
        decodeAntigravity(settings),
        { ACCOUNT: settings.binaryPath },
        catalog,
      ),
  },
] as const;

const makeVersionSpawner = (
  getVersion: () => { readonly code: number; readonly version: string },
) => {
  const commands: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("只接受版本检查命令。");
      commands.push(command);
      expect(command.args).toEqual(["--version"]);
      const current = getVersion();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(current.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(`cli ${current.version}`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { commands, spawner };
};

for (const provider of providers) {
  describe(`${provider.name} 配置目录`, () => {
    it.effect("去空去重后的等价配置共享目录并保留首见顺序", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const first = yield* provider.fetch(
          {
            customModels: [" model-b ", "model-a", "model-b", "", "  ", " model-a "],
          },
          catalog,
        );
        const equivalent = yield* provider.fetch({ customModels: ["model-b", "model-a"] }, catalog);
        expect(first.models.map((model) => model.slug)).toEqual(["model-b", "model-a"]);
        expect(equivalent).toBe(first);
        const reordered = yield* provider.fetch({ customModels: ["model-a", "model-b"] }, catalog);
        expect(reordered).not.toBe(first);
        expect(reordered.models.map((model) => model.slug)).toEqual(["model-a", "model-b"]);
      }),
    );

    it.effect("初始、直接目录和健康检查共用引用，纯目录不启动进程", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const customModels = ["model-a", "model-b"];
        const initial = yield* provider.initial({ customModels, binaryPath: "first-cli" }, catalog);
        const direct = yield* provider.fetch({ customModels: [...customModels] }, catalog);
        expect(initial.models).toBe(direct.models);
        const { spawner, commands } = makeVersionSpawner(() => ({ code: 0, version: "1.2.3" }));
        const checked = yield* provider
          .check(
            {
              enabled: true,
              customModels: [...customModels],
              binaryPath: "other-account-cli",
            },
            catalog,
          )
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, "linux"),
          );
        expect(checked.models).toBe(initial.models);
        expect(checked.models.map((model) => model.slug)).toEqual(customModels);
        expect(commands.map((command) => command.command)).toEqual(["other-account-cli"]);
      }),
    );

    it.effect("配置模型改变产生新目录，手动刷新重建当前配置", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const first = yield* provider.fetch({ customModels: ["model-a"] }, catalog);
        const changed = yield* provider.fetch({ customModels: ["model-b"] }, catalog);
        expect(changed.models.map((model) => model.slug)).toEqual(["model-b"]);
        expect(changed.models).not.toBe(first.models);
        const forced = yield* provider
          .fetch({ customModels: ["model-b"] }, catalog)
          .pipe(Effect.provideService(ProviderCatalogForceRefresh, true));
        expect(forced).not.toBe(changed);
        expect(forced).toEqual(changed);
      }),
    );

    it.effect("加载前修改调用者数组不会污染原键或已缓存结果", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const customModels = ["model-a"];
        const mutatingCatalog: CliProviderCatalog = {
          fetchCatalog: (input) =>
            catalog.fetchCatalog({
              ...input,
              load: Effect.sync(() => customModels.push("model-late")).pipe(
                Effect.andThen(input.load),
              ),
            }),
        };
        const first = yield* provider.fetch({ customModels }, mutatingCatalog);
        expect(customModels).toEqual(["model-a", "model-late"]);
        expect(first.models.map((model) => model.slug)).toEqual(["model-a"]);
        const original = yield* provider.fetch({ customModels: ["model-a"] }, catalog);
        expect(original).toBe(first);
        const changed = yield* provider.fetch({ customModels }, catalog);
        expect(changed.models.map((model) => model.slug)).toEqual(["model-a", "model-late"]);
        expect(first.models.map((model) => model.slug)).toEqual(["model-a"]);
      }),
    );

    it.effect("目录命中时版本安装和禁用状态仍实时检查", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        let current = { code: 0, version: "1.2.3" };
        const { spawner, commands } = makeVersionSpawner(() => current);
        const check = (enabled: boolean) =>
          provider
            .check(
              {
                enabled,
                customModels: ["model-a"],
                binaryPath: "current-cli",
              },
              catalog,
            )
            .pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(HostProcessPlatform, "linux"),
            );
        const first = yield* check(true);
        yield* TestClock.adjust("1 second");
        current = { code: 0, version: "2.3.4" };
        const second = yield* check(true);
        const disabledInstalled = yield* check(false);
        current = { code: 9009, version: "" };
        const disabledMissing = yield* check(false);
        const enabledMissing = yield* check(true);
        expect(first.version).toBe("1.2.3");
        expect(second.version).toBe("2.3.4");
        expect(second.checkedAt).not.toBe(first.checkedAt);
        expect(second.models).toBe(first.models);
        expect(disabledInstalled.status).toBe("disabled");
        expect(disabledInstalled.installed).toBe(true);
        expect(disabledMissing.status).toBe("disabled");
        expect(disabledMissing.installed).toBe(false);
        expect(enabledMissing.status).toBe("error");
        expect(enabledMissing.installed).toBe(false);
        expect(enabledMissing.auth.status).toBe("unknown");
        expect(enabledMissing.models).toBe(first.models);
        expect(commands).toHaveLength(5);
        expect(
          commands.every((command) => command.args.length === 1 && command.args[0] === "--version"),
        ).toBe(true);
      }),
    );
  });
}

it.effect("两种 provider 的配置目录相同也保持能力身份隔离", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const settings = { customModels: ["same-model"] };
    const kimi = yield* fetchKimiCatalog(settings, catalog);
    const antigravity = yield* fetchAntigravityCatalog(settings, catalog);
    expect(kimi).not.toBe(antigravity);
    expect(kimi).toEqual(antigravity);
  }),
);
