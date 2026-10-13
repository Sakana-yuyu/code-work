import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { CliProviderCatalog } from "../CliProviderCatalog.ts";
import type { OpenCodeCatalog } from "../OpenCodeCatalog.ts";
import type { NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const driverKind = ProviderDriverKind.make("catalog-test");
const firstId = ProviderInstanceId.make("first");
const secondId = ProviderInstanceId.make("second");
const catalogData = {
  models: [{ slug: "shared-model", name: "共享模型", isCustom: false, capabilities: null }],
};

const makeFixture = () => {
  const created: Array<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string | undefined;
    readonly catalog: CliProviderCatalog;
    readonly openCodeCatalog: OpenCodeCatalog;
    readonly nativeCatalog: NativeProviderCatalog;
    readonly catalogRevision: string | undefined;
    readonly scope: Scope.Scope;
    stopCalls: number;
    closed: boolean;
  }> = [];
  let loadCalls = 0;
  const driver: ProviderDriver<{ command: string }> = {
    driverKind,
    metadata: { displayName: "目录测试" },
    configSchema: Schema.Struct({ command: Schema.String }),
    defaultConfig: () => ({ command: "test-cli" }),
    create: Effect.fn("catalogTestDriver.create")(function* (
      input: ProviderDriverCreateInput<{ command: string }>,
    ) {
      const { instanceId, displayName, config, catalog, openCodeCatalog, nativeCatalog } = input;
      if (!catalog || !openCodeCatalog || !nativeCatalog)
        return yield* Effect.die("注册表没有传入目录缓存");
      const entry = {
        instanceId,
        displayName,
        catalog,
        openCodeCatalog,
        nativeCatalog,
        catalogRevision: input.catalogRevision,
        scope: yield* Scope.Scope,
        stopCalls: 0,
        closed: false,
      };
      created.push(entry);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          entry.closed = true;
        }),
      );
      const data = yield* catalog
        .fetchCatalog({
          key: config.command,
          load: Effect.sync(() => {
            loadCalls += 1;
            return catalogData;
          }),
        })
        .pipe(Effect.orDie);
      const snapshot: ServerProvider = {
        instanceId,
        driver: driverKind,
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-13T00:00:00.000Z",
        models: data.models,
        skills: [],
        slashCommands: [],
      };
      return {
        instanceId,
        driverKind,
        displayName,
        enabled: true,
        continuationIdentity: { driverKind, continuationKey: instanceId },
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: driverKind,
            packageName: null,
          }),
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
        },
        adapter: {
          provider: driverKind,
          capabilities: { sessionModelSwitch: "unsupported" },
          startSession: () => Effect.die("此测试不启动会话"),
          sendTurn: () => Effect.die("此测试不发送轮次"),
          interruptTurn: () => Effect.void,
          respondToRequest: () => Effect.void,
          respondToUserInput: () => Effect.void,
          stopSession: () => Effect.void,
          listSessions: () => Effect.succeed([]),
          hasSession: () => Effect.succeed(false),
          readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
          rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
          stopAll: () =>
            Effect.sync(() => {
              entry.stopCalls += 1;
            }),
          streamEvents: Stream.empty,
        },
        textGeneration: {
          generateCommitMessage: () => Effect.die("此测试不生成文本"),
          generatePrContent: () => Effect.die("此测试不生成文本"),
          generateBranchName: () => Effect.die("此测试不生成文本"),
          generateThreadTitle: () => Effect.die("此测试不生成文本"),
        },
      } satisfies ProviderInstance;
    }),
  };
  return { driver, created, loadCalls: () => loadCalls };
};

const entry = (displayName: string) => ({
  driver: driverKind,
  displayName,
  config: { command: "test-cli" },
});

it.effect("同注册表的多实例与替代实例复用目录，但adapter和作用域独立", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const secondEntry = entry("第二个");
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [fixture.driver],
          configMap: { [firstId]: entry("第一个"), [secondId]: secondEntry },
        });
        const first = yield* registry.getInstance(firstId);
        const second = yield* registry.getInstance(secondId);
        assert.isDefined(first);
        assert.isDefined(second);
        assert.strictEqual(fixture.created.length, 2);
        const [firstCreated, secondCreated] = fixture.created;
        assert.isDefined(firstCreated);
        assert.isDefined(secondCreated);
        assert.strictEqual(firstCreated.catalog, secondCreated.catalog);
        assert.strictEqual(firstCreated.openCodeCatalog, secondCreated.openCodeCatalog);
        assert.strictEqual(firstCreated.nativeCatalog, secondCreated.nativeCatalog);
        assert.notStrictEqual(firstCreated.scope, secondCreated.scope);
        assert.notStrictEqual(first.adapter, second.adapter);
        assert.strictEqual(fixture.loadCalls(), 1);
        yield* first.adapter.stopAll();
        assert.strictEqual(firstCreated.stopCalls, 1);
        assert.strictEqual(secondCreated.stopCalls, 0);

        yield* mutator.reconcile({ [firstId]: entry("第一个改名"), [secondId]: secondEntry });
        const replacement = yield* registry.getInstance(firstId);
        assert.isDefined(replacement);
        assert.strictEqual(fixture.created.length, 3);
        const replacementCreated = fixture.created[2];
        assert.isDefined(replacementCreated);
        assert.strictEqual(replacementCreated.catalog, firstCreated.catalog);
        assert.strictEqual(replacementCreated.openCodeCatalog, firstCreated.openCodeCatalog);
        assert.strictEqual(replacementCreated.nativeCatalog, firstCreated.nativeCatalog);
        assert.notStrictEqual(replacementCreated.scope, firstCreated.scope);
        assert.notStrictEqual(replacement.adapter, first.adapter);
        assert.strictEqual(yield* registry.getInstance(secondId), second);
        assert.isTrue(firstCreated.closed);
        assert.isFalse(secondCreated.closed);
        assert.isFalse(replacementCreated.closed);
        assert.strictEqual(fixture.loadCalls(), 1);
        assert.deepStrictEqual(
          (yield* replacement.snapshot.getSnapshot).models,
          catalogData.models,
        );
        yield* replacement.adapter.stopAll();
        assert.strictEqual(replacementCreated.stopCalls, 1);
        assert.strictEqual(firstCreated.stopCalls, 1);
        assert.strictEqual(secondCreated.stopCalls, 0);
      }),
    );
    assert.isTrue(fixture.created.every((created) => created.closed));
  }),
);

it.effect("不同注册表持有独立目录缓存，关闭其中一个不会关闭另一个实例", () =>
  Effect.gen(function* () {
    const fixture = makeFixture();
    const firstScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
    const secondScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
    const input = { drivers: [fixture.driver], configMap: { [firstId]: entry("同一配置") } };
    yield* makeProviderInstanceRegistry(input).pipe(Effect.provideService(Scope.Scope, firstScope));
    const second = yield* makeProviderInstanceRegistry(input).pipe(
      Effect.provideService(Scope.Scope, secondScope),
    );
    const [firstCreated, secondCreated] = fixture.created;
    assert.isDefined(firstCreated);
    assert.isDefined(secondCreated);
    assert.notStrictEqual(firstCreated.catalog, secondCreated.catalog);
    assert.notStrictEqual(firstCreated.openCodeCatalog, secondCreated.openCodeCatalog);
    assert.notStrictEqual(firstCreated.nativeCatalog, secondCreated.nativeCatalog);
    assert.strictEqual(fixture.loadCalls(), 2);
    yield* Scope.close(firstScope, Exit.void);
    assert.isTrue(firstCreated.closed);
    assert.isFalse(secondCreated.closed);
    const surviving = yield* second.registry.getInstance(firstId);
    assert.isDefined(surviving);
    assert.deepStrictEqual((yield* surviving.snapshot.getSnapshot).models, catalogData.models);
    yield* surviving.adapter.stopAll();
    assert.strictEqual(firstCreated.stopCalls, 0);
    assert.strictEqual(secondCreated.stopCalls, 1);
  }),
);

it.effect("解码剥离路由摘要后仍传给driver，重建保留当前代次", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = makeFixture();
      const withRevision = (revision: string) => ({
        ...entry("路由"),
        config: { command: "test-cli", __byokSourceFingerprint: revision },
      });
      const { mutator } = yield* makeProviderInstanceRegistry({
        drivers: [fixture.driver],
        configMap: { [firstId]: withRevision("first") },
      });
      assert.strictEqual(fixture.created[0]?.catalogRevision, "first");
      yield* mutator.reconcile({ [firstId]: withRevision("next") });
      assert.strictEqual(fixture.created[1]?.catalogRevision, "next");
      assert.strictEqual(fixture.created[0]?.nativeCatalog, fixture.created[1]?.nativeCatalog);
    }),
  ),
);
