import { GrokSettings, ServerSettingsError } from "@codework/contracts";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@codework/shared/hostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeNativeProviderCatalog, type NativeProviderCatalog } from "../NativeProviderCatalog.ts";
import { ProviderCatalogForceRefresh } from "../ProviderCatalogCache.ts";
import { fetchGrokCatalog } from "./GrokProvider.ts";

const stages = ["prepare", "version", "skills", "initialize", "models"] as const;
type Stage = (typeof stages)[number];
const decodeSettings = Schema.decodeSync(GrokSettings);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.Unknown, method: Schema.String })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const environment = { PATH: "/bin", GROK_HOME: "/home/grok", MARKER: "original" };

/** 使用真实 ACP 编解码，阶段只由收据控制，不创建供应商会话或访问账号。 */
const makeFixture = Effect.fn("makeGrokRefreshFixture")(function* () {
  const fixtureEnvironment = { ...environment };
  const native = yield* makeNativeProviderCatalog();
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
    if (!value) throw new Error("缺少阶段收据");
    return value;
  };
  const state = {
    model: "first",
    version: "1.0.45",
    revision: "same",
    blocks: new Set<Stage>(),
    failMethod: "",
    failSkills: false,
    prepareFailure: undefined as ServerSettingsError | undefined,
  };
  const wait = (stage: Stage, blocks = state.blocks) =>
    Effect.gen(function* () {
      if (!blocks.has(stage)) return;
      yield* Deferred.succeed(gate(stage).entered, undefined);
      yield* Deferred.await(gate(stage).release);
    });
  const controllers: AbortController[] = [];
  const prepareSignals: AbortSignal[] = [];
  const keys: string[] = [];
  const commands: ChildProcess.StandardCommand[] = [];
  const finalized: number[] = [];
  const requests: string[] = [];
  const observed: NativeProviderCatalog = {
    ...native,
    fetchCatalogWithError: (input) => {
      keys.push(input.key);
      return native.fetchCatalogWithError({
        ...input,
        load: (controller) => {
          controllers.push(controller);
          return input.load(controller);
        },
      });
    },
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("只接收普通探针命令");
      commands.push(command);
      const pid = commands.length;
      const current = { ...state, blocks: new Set(state.blocks) };
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      let running = true;
      const finish = Effect.gen(function* () {
        if (!running) return;
        running = false;
        finalized.push(pid);
        yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
      });
      yield* Effect.addFinalizer(() => finish);
      const output = yield* Queue.unbounded<Uint8Array>();
      let buffered = "";
      const write = Sink.forEach((bytes: Uint8Array) =>
        Effect.gen(function* () {
          buffered += new TextDecoder().decode(bytes);
          for (;;) {
            const next = buffered.indexOf("\n");
            if (next < 0) break;
            const line = buffered.slice(0, next);
            buffered = buffered.slice(next + 1);
            if (!line.trim()) continue;
            const request = decodeRequest(line);
            requests.push(request.method);
            const stage = request.method === "initialize" ? "initialize" : "models";
            yield* wait(stage, current.blocks);
            const result =
              request.method === "initialize"
                ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
                : {
                    result: {
                      currentModelId: current.model,
                      availableModels: [{ modelId: current.model, name: current.model }],
                    },
                  };
            const response =
              current.failMethod === request.method
                ? { error: { code: -32601, message: "本轮失败" } }
                : { result };
            yield* Queue.offer(
              output,
              new TextEncoder().encode(
                encodeJson({ jsonrpc: "2.0", id: request.id, ...response }) + "\n",
              ),
            );
          }
        }),
      );
      const shortStage =
        command.args[0] === "--version"
          ? "version"
          : command.args[0] === "inspect"
            ? "skills"
            : undefined;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pid),
        isRunning: Effect.sync(() => running),
        kill: () => finish,
        unref: Effect.succeed(Effect.void),
        exitCode: shortStage
          ? Effect.succeed(
              ChildProcessSpawner.ExitCode(shortStage === "skills" && current.failSkills ? 2 : 0),
            )
          : Deferred.await(exited),
        stdin: write,
        stdout: shortStage
          ? Stream.fromEffect(
              wait(shortStage, current.blocks).pipe(
                Effect.as(
                  new TextEncoder().encode(
                    shortStage === "version"
                      ? `grok-cli ${current.version}\n`
                      : encodeJson({
                          skills: [
                            {
                              name: "review",
                              source: { type: "project", path: "/skills/review/SKILL.md" },
                            },
                          ],
                        }),
                  ),
                ),
              ),
            )
          : Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const settings = decodeSettings({ enabled: true, binaryPath: "grok" });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HostProcessEnvironment, fixtureEnvironment),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessWorkingDirectory, "/models"),
      Effect.provide(NodeCrypto.layer),
    );
  const call = (customModels: string[] = [], revision = state.revision) =>
    provide(
      fetchGrokCatalog({
        settings: { ...settings, customModels },
        environment: fixtureEnvironment,
        skillsWorkingDirectory: "/skills",
        nativeCatalog: observed,
        preparationIdentity: { revision },
        prepare: (signal) =>
          Effect.gen(function* () {
            prepareSignals.push(signal);
            yield* wait("prepare");
            if (state.prepareFailure) return yield* state.prepareFailure;
            return { configFileContents: revision };
          }),
      }),
    );
  return {
    state,
    environment: fixtureEnvironment,
    commands,
    requests,
    finalized,
    controllers,
    prepareSignals,
    keys,
    call,
    entered: (stage: Stage) => Deferred.await(gate(stage).entered),
    release: (stage: Stage) => Deferred.succeed(gate(stage).release, undefined),
  };
});

describe("Grok 完整原生刷新", () => {
  it.effect("准备等待期间冻结调用输入，完成时间实时且技能失败不阻止模型目录", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const custom = ["original-custom"];
      f.state.blocks.add("prepare");
      f.state.failSkills = true;
      const task = yield* f
        .call(custom)
        .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* f.entered("prepare");
      custom.push("late-custom");
      f.environment.MARKER = "late";
      yield* TestClock.adjust("2 seconds");
      yield* f.release("prepare");
      const snapshot = yield* Fiber.join(task);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["first", "original-custom"]);
      expect(snapshot.skills).toEqual([]);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.checkedAt).toBe(DateTime.formatIso(yield* DateTime.now));
      expect(f.commands.every((command) => command.options.env?.MARKER === "original")).toBe(true);
    }),
  );
  it.effect("准备、版本、技能与模型共用十五秒，晚加入不续时且保留已知阶段", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks = new Set(["prepare", "version", "skills", "models"]);
      const first = yield* f
        .call(["one"])
        .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* f.entered("prepare");
      yield* TestClock.adjust("5 seconds");
      yield* f.release("prepare");
      yield* f.entered("version");
      yield* TestClock.adjust("3 seconds");
      yield* f.release("version");
      yield* f.entered("skills");
      const second = yield* f
        .call(["two"])
        .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("4 seconds");
      yield* f.release("skills");
      yield* f.entered("models");
      yield* TestClock.adjust("3 seconds");
      const a = yield* Fiber.join(first);
      const b = yield* Fiber.join(second);
      expect(a.message).toContain("15000ms");
      expect(a.version).toBe("1.0.45");
      expect(a.skills.map((skill) => skill.name)).toEqual(["review"]);
      expect(a.models.map((model) => model.slug)).toEqual(["grok-build", "one"]);
      expect(b.models.map((model) => model.slug)).toEqual(["grok-build", "two"]);
      expect(f.controllers).toHaveLength(1);
      expect(f.controllers[0]?.signal.aborted).toBe(true);
      expect(f.prepareSignals[0]).toBe(f.controllers[0]?.signal);
      expect(f.finalized).toEqual([1, 2, 3]);
    }),
  );

  for (const all of [false, true]) {
    it.effect(`${all ? "最后" : "首个"}等待者取消只终结自己拥有的等待`, () =>
      Effect.gen(function* () {
        const f = yield* makeFixture();
        f.state.blocks.add("models");
        const first = yield* f
          .call()
          .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
        yield* f.entered("models");
        const second = yield* f
          .call(["custom"])
          .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(first);
        expect(f.controllers[0]?.signal.aborted).toBe(false);
        if (all) yield* Fiber.interrupt(second);
        else {
          yield* f.release("models");
          expect((yield* Fiber.join(second)).models.map((model) => model.slug)).toEqual([
            "first",
            "custom",
          ]);
        }
        expect(f.controllers[0]?.signal.aborted).toBe(true);
        expect(f.finalized).toEqual([1, 2, 3]);
        expect(f.requests).toEqual(["initialize", "x.ai/models/list"]);
      }),
    );
  }

  it.effect("未知认证每次顺序重读模型与技能，所有执行使用实际两个cwd与冻结环境", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      yield* f.call().pipe(Effect.orDie);
      f.state.model = "next";
      expect((yield* f.call().pipe(Effect.orDie)).models[0]?.slug).toBe("next");
      expect(f.controllers).toHaveLength(2);
      expect(f.commands.map((command) => command.options.cwd)).toEqual([
        "/models",
        "/skills",
        "/models",
        "/models",
        "/skills",
        "/models",
      ]);
      expect(
        f.commands.every(
          (command) =>
            command.options.extendEnv === false && command.options.forceKillAfter === "2 seconds",
        ),
      ).toBe(true);
      expect(f.requests).toEqual([
        "initialize",
        "x.ai/models/list",
        "initialize",
        "x.ai/models/list",
      ]);
    }),
  );

  it.effect("新路由代次不加入旧在途检查，旧结果晚完成不污染新目录", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks.add("models");
      const old = yield* f
        .call([], "old")
        .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* f.entered("models");
      f.state.blocks.clear();
      f.state.model = "new";
      expect((yield* f.call([], "new").pipe(Effect.orDie)).models[0]?.slug).toBe("new");
      expect(f.controllers).toHaveLength(2);
      expect(f.keys[0]).not.toBe(f.keys[1]);
      yield* f.release("models");
      expect((yield* Fiber.join(old)).models[0]?.slug).toBe("first");
      expect((yield* f.call([], "new").pipe(Effect.orDie)).models[0]?.slug).toBe("new");
    }),
  );

  it.effect("准备错误保留原领域cause并可恢复，显式信号中断不降级为健康错误", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const failure = new ServerSettingsError({
        settingsPath: "/grok/config.toml",
        operation: "normalize",
        cause: "本轮配置失败",
      });
      f.state.prepareFailure = failure;
      const failed = yield* f.call().pipe(Effect.result);
      expect(Result.isFailure(failed)).toBe(true);
      if (Result.isFailure(failed)) expect(failed.failure.cause).toBe(failure);
      expect(f.commands).toHaveLength(0);
      f.state.prepareFailure = undefined;
      f.state.blocks.add("initialize");
      const interrupted = yield* f.call().pipe(Effect.forkChild({ startImmediately: true }));
      yield* f.entered("initialize");
      f.controllers[1]?.abort();
      const exit = yield* Fiber.await(interrupted);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(f.requests).toEqual(["initialize"]);
    }),
  );

  it.effect("手动强刷新不会加入旧普通加载，普通等待者可加入强加载", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      f.state.blocks.add("models");
      const old = yield* f.call().pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* f.entered("models");
      f.state.model = "strong";
      f.state.blocks = new Set(["initialize"]);
      const strong = yield* f
        .call()
        .pipe(
          Effect.provideService(ProviderCatalogForceRefresh, true),
          Effect.orDie,
          Effect.forkChild({ startImmediately: true }),
        );
      yield* f.entered("initialize");
      const joined = yield* f
        .call(["custom"])
        .pipe(Effect.orDie, Effect.forkChild({ startImmediately: true }));
      yield* f.release("initialize");
      expect((yield* Fiber.join(strong)).models[0]?.slug).toBe("strong");
      expect((yield* Fiber.join(joined)).models.map((model) => model.slug)).toEqual([
        "strong",
        "custom",
      ]);
      yield* f.release("models");
      expect((yield* Fiber.join(old)).models[0]?.slug).toBe("first");
      expect(f.controllers).toHaveLength(2);
    }),
  );
});
