import { ProviderInstanceId } from "@codework/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ByokCatalog } from "../byok/ByokCatalog.ts";
import { makeNativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ByokDriver } from "./ByokDriver.ts";

const driverLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "codework-byok-directory-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  ServerSettingsService.layerTest({ enableProviderUpdateChecks: false }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    shouldRunScopeWork: () => Effect.succeed(false),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("目录不得调用推理接口")),
  ),
  Layer.succeed(
    ByokCatalog,
    ByokCatalog.of({ fetchCatalog: () => Effect.die("空配置不得请求模型目录") }),
  ),
);

it.layer(driverLayer)("BYOK Driver 刷新入口", (it) => {
  it.effect("技能目录挂起仍发布初始配置且不创建会话，关闭实例等待读取退出", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      let created = false;
      let closed = 0;
      const pending = yield* ByokDriver.create({
        instanceId: ProviderInstanceId.make("bounded"),
        displayName: "独立实例",
        enabled: true,
        environment: [],
        config: ByokDriver.defaultConfig(),
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readDirectory: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  closed++;
                }),
              ),
            ),
        }),
        Effect.tap(() =>
          Effect.sync(() => {
            created = true;
          }),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(0);
      expect(created).toBe(true);
      const instance = yield* Fiber.join(pending);
      expect((yield* instance.snapshot.getSnapshot).instanceId).toBe("bounded");
      expect(yield* instance.adapter.listSessions()).toEqual([]);
      yield* Scope.close(scope, Exit.void);
      expect(closed).toBe(1);
    }),
  );
  it.effect("等价实例刷新恢复各自身份，技能变化在下一轮读取且始终没有会话", () =>
    Effect.gen(function* () {
      const native = yield* makeNativeProviderCatalog();
      const fs = yield* FileSystem.FileSystem;
      let name = "first";
      const make = (id: string) =>
        ByokDriver.create({
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          enabled: true,
          environment: [],
          nativeCatalog: native,
          config: ByokDriver.defaultConfig(),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readDirectory: () => Effect.succeed(["skill"]),
            readFileString: () => Effect.sync(() => `---\nname: ${name}\n---\n正文`),
          }),
        );
      const a = yield* make("a");
      const b = yield* make("b");
      const first = yield* Effect.all([a.snapshot.refresh, b.snapshot.refresh], {
        concurrency: "unbounded",
      });
      expect(first.map((s) => s.instanceId)).toEqual(["a", "b"]);
      expect(first.map((s) => s.skills.map((skill) => skill.name))).toEqual([["first"], ["first"]]);
      name = "next";
      expect((yield* a.snapshot.refresh).skills.map((skill) => skill.name)).toEqual(["next"]);
      expect(yield* a.adapter.listSessions()).toEqual([]);
      expect(yield* b.adapter.listSessions()).toEqual([]);
    }),
  );
});
