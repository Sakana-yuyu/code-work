import { OmpAgentSettings, PiAgentSettings, ZCodeAgentSettings } from "@codework/contracts";
import { HostProcessPlatform } from "@codework/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCliProviderCatalog, type CliProviderCatalog } from "../CliProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import type { PifamilyModelRoute } from "../pifamily/byokProviderConfig.ts";
import {
  buildInitialPifamilyProviderSnapshot,
  checkPifamilyProviderStatus,
  fetchPifamilyProviderCatalog,
} from "./PifamilyProvider.ts";

const providers = [
  { driverKind: "piAgent", settings: Schema.decodeSync(PiAgentSettings)({ enabled: true }) },
  { driverKind: "ompAgent", settings: Schema.decodeSync(OmpAgentSettings)({ enabled: true }) },
  { driverKind: "zcodeAgent", settings: Schema.decodeSync(ZCodeAgentSettings)({ enabled: true }) },
] as const;

const route = (overrides: Partial<PifamilyModelRoute> = {}): PifamilyModelRoute => ({
  adapterId: "gateway-alpha",
  displayName: "网关模型 A",
  modelId: "upstream-alpha",
  protocol: "openai",
  contextWindowTokens: 128_000,
  ...overrides,
});

const makeVersionSpawner = (
  getResult: () => { readonly version: string; readonly code: number },
) => {
  const commands: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("仅接受 CLI 版本探针。");
      expect(command.args).toEqual(["--version"]);
      commands.push(command);
      const result = getResult();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(`cli ${result.version}`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, commands };
};

for (const provider of providers) {
  describe(`${provider.driverKind} 配置目录`, () => {
    it.effect("初始与健康入口共享目录，路由的非展示字段不分裂缓存", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const input = { ...provider, catalog, routes: [route()] };
        const first = yield* buildInitialPifamilyProviderSnapshot(input);
        expect(first.showInteractionModeToggle).toBe(provider.driverKind === "zcodeAgent");
        const equivalentRoutes = [
          route({
            modelId: " upstream-alpha ",
            protocol: "anthropic",
            contextWindowTokens: 256_000,
            localProvider: "other-account",
          }),
        ];
        const direct = yield* fetchPifamilyProviderCatalog({ ...input, routes: equivalentRoutes });
        expect(direct.models).toBe(first.models);
        const { spawner, commands } = makeVersionSpawner(() => ({ version: "1.2.3", code: 0 }));
        const current = yield* checkPifamilyProviderStatus({
          ...input,
          settings: { ...provider.settings, binaryPath: "other-cli" },
          routes: equivalentRoutes,
          environment: { ACCOUNT: "other-account" },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcessPlatform, "linux"),
        );
        expect(current.models).toBe(first.models);
        expect(current.showInteractionModeToggle).toBe(provider.driverKind === "zcodeAgent");
        expect(current.models).toEqual([
          {
            slug: "gateway-alpha",
            name: "网关模型 A",
            subProvider: "upstream-alpha",
            isCustom: false,
            capabilities: null,
          },
        ]);
        expect(first.auth.status).toBe("unknown");
        expect(current.auth.status).toBe("authenticated");
        expect(commands.map((command) => command.command)).toEqual(["other-cli"]);
      }),
    );

    it.effect("展示字段及顺序变化失效，手动刷新与到期使用当前路由", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const input = { driverKind: provider.driverKind, catalog, routes: [route()] };
        const first = yield* fetchPifamilyProviderCatalog(input);
        for (const change of [
          { adapterId: "gateway-beta" },
          { displayName: "网关模型 B" },
          { modelId: "upstream-beta" },
        ]) {
          const changed = yield* fetchPifamilyProviderCatalog({
            ...input,
            routes: [route(change)],
          });
          expect(changed.models).not.toBe(first.models);
          expect(changed.models).not.toEqual(first.models);
        }
        const orderedRoutes = [route(), route({ adapterId: "gateway-beta" })];
        const ordered = yield* fetchPifamilyProviderCatalog({ ...input, routes: orderedRoutes });
        const reversed = yield* fetchPifamilyProviderCatalog({
          ...input,
          routes: orderedRoutes.toReversed(),
        });
        expect(reversed.models.map((model) => model.slug)).toEqual([
          "gateway-beta",
          "gateway-alpha",
        ]);
        expect(reversed.models).not.toBe(ordered.models);
        const forced = yield* fetchPifamilyProviderCatalog(input).pipe(
          Effect.provideService(ProviderCatalogForceRefresh, true),
        );
        expect(forced.models).toEqual(first.models);
        expect(forced.models).not.toBe(first.models);
        expect((yield* fetchPifamilyProviderCatalog(input)).models).toBe(forced.models);
        yield* TestClock.adjust("60 seconds");
        expect((yield* fetchPifamilyProviderCatalog(input)).models).not.toBe(forced.models);
      }),
    );

    it.effect("模型命中缓存时健康、版本、启用状态和时间仍实时更新", () =>
      Effect.gen(function* () {
        const catalog = yield* makeCliProviderCatalog();
        const input = { ...provider, catalog, routes: [route()] };
        let result = { version: "1.2.3", code: 0 };
        const { spawner, commands } = makeVersionSpawner(() => result);
        const check = (settings = provider.settings, assumeInstalled = false) =>
          checkPifamilyProviderStatus({ ...input, settings, assumeInstalled }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(HostProcessPlatform, "linux"),
          );
        const first = yield* check();
        result = { version: "2.3.4", code: 1 };
        yield* TestClock.adjust("1 second");
        const failed = yield* check();
        expect(failed.models).toBe(first.models);
        expect(failed.version).toBe("2.3.4");
        expect(failed.installed).toBe(false);
        expect(failed.status).toBe("error");
        expect(failed.checkedAt).not.toBe(first.checkedAt);
        const disabled = yield* check({ ...provider.settings, enabled: false });
        expect(disabled.models).toBe(first.models);
        expect(disabled.status).toBe("disabled");
        expect(disabled.auth.status).toBe("unknown");
        const bundled = yield* check(provider.settings, true);
        expect(bundled.models).toBe(first.models);
        expect(bundled.installed).toBe(true);
        expect(bundled.auth.status).toBe("authenticated");
        expect(commands).toHaveLength(2);
      }),
    );
  });
}

it.effect("路由加载使用快照，调用者后续修改不污染缓存键和模型", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const mutableRoute = { ...route() };
    const routes = [mutableRoute];
    const mutatingCatalog: CliProviderCatalog = {
      fetchCatalog: (input) =>
        catalog.fetchCatalog({
          ...input,
          load: Effect.sync(() => {
            mutableRoute.displayName = "稍后改名";
            routes.push(route({ adapterId: "later" }));
          }).pipe(Effect.andThen(input.load)),
        }),
    };
    const first = yield* fetchPifamilyProviderCatalog({
      driverKind: "piAgent",
      routes,
      catalog: mutatingCatalog,
    });
    expect(first.models).toHaveLength(1);
    expect(first.models[0]?.name).toBe("网关模型 A");
    const previous = yield* fetchPifamilyProviderCatalog({
      driverKind: "piAgent",
      routes: [route()],
      catalog,
    });
    expect(previous.models).toBe(first.models);
    const changed = yield* fetchPifamilyProviderCatalog({ driverKind: "piAgent", routes, catalog });
    expect(changed.models).toHaveLength(2);
    expect(changed.models[0]?.name).toBe("稍后改名");
  }),
);

it.effect("相同路由不会跨驱动复用目录", () =>
  Effect.gen(function* () {
    const catalog = yield* makeCliProviderCatalog();
    const results = yield* Effect.forEach(providers, ({ driverKind }) =>
      fetchPifamilyProviderCatalog({ driverKind, routes: [route()], catalog }),
    );
    expect(results[0]?.models).not.toBe(results[1]?.models);
    expect(results[1]?.models).not.toBe(results[2]?.models);
    expect(results[0]?.models).toEqual(results[2]?.models);
  }),
);
