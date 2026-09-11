// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - 需要真实二进制、TCP 上游与文件系统探测；夹具直接断言 JSON 线格式。
/**
 * 真实 omp 二进制的 env-gated e2e（默认跳过）。
 *
 * 运行条件：`PI_FAMILY_REAL_E2E=1` 且 omp 可解析（PATH 或
 * `%LOCALAPPDATA%/omp/omp.exe`；可用 OMP_BIN 显式指定）。复刻 2026-09-10
 * 的手工探针：受管 PI_CODING_AGENT_DIR 里只有一份指向假上游的 models.json
 * （provider `codework-test`），断言 get_available_models 只暴露该 provider
 * （凭据物理隔离）、v2 协商成功、prompt 经假上游完成 agent_end 往返。
 *
 * 本地运行：`PI_FAMILY_REAL_E2E=1 npx vp test run
 * src/provider/pifamily/OmpReal.e2e.test.ts`
 *
 * @module provider/pifamily/OmpReal.e2e.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveSpawnCommand } from "@codework/shared/shell";

import { ServerConfig } from "../../config.ts";
import { makeJsonlRpcProcess, JsonlRpcProcessError } from "./jsonlRpcProcess.ts";
import { supportsJsonlRpcProtocolV2 } from "./jsonlFrameDecoder.ts";
import { scrubPifamilyEnvironment } from "./byokProviderConfig.ts";

/** 定位真实 omp：显式 OMP_BIN > 常见安装位 > PATH。 */
const resolveOmpBinary = (): string | undefined => {
  const candidates: ReadonlyArray<string> = [
    process.env.OMP_BIN ?? "",
    process.env.LOCALAPPDATA ? NodePath.join(process.env.LOCALAPPDATA, "omp", "omp.exe") : "",
    process.env.APPDATA ? NodePath.join(process.env.APPDATA, "npm", "omp.cmd") : "",
    ...(process.env.PATH ?? "")
      .split(NodePath.delimiter)
      .flatMap((entry) =>
        entry.trim().length === 0
          ? []
          : [
              NodePath.join(entry, "omp.exe"),
              NodePath.join(entry, "omp.cmd"),
              NodePath.join(entry, "omp"),
            ],
      ),
  ];
  for (const candidate of candidates) {
    if (candidate.length > 0 && NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
};

const ompBinary = process.env.PI_FAMILY_REAL_E2E === "1" ? (resolveOmpBinary() ?? null) : null;

interface UpstreamCall {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

/** 假上游：记录请求，返回非流式 chat completion（与路由 e2e 同一形状）。 */
const startUpstream = (): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
  readonly calls: UpstreamCall[];
}> =>
  new Promise((resolve) => {
    const calls: UpstreamCall[] = [];
    const server = NodeHttp.createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        calls.push({
          url: request.url ?? "",
          authorization: request.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "REAL_PROBE_OK" } }] }));
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("upstream 端口未绑定");
      }
      resolve({
        port: address.port,
        calls,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.closeAllConnections();
            server.close((error) => {
              if (error === undefined) {
                resolveClose();
                return;
              }
              rejectClose(error);
            });
          }),
      });
    });
  });

interface FrameRecorder {
  readonly frames: ReadonlyArray<unknown>;
  readonly record: (frame: unknown) => Effect.Effect<void>;
  readonly waitFor: (predicate: (frame: unknown) => boolean) => Effect.Effect<unknown>;
}

const makeFrameRecorder = (): Effect.Effect<FrameRecorder> =>
  Effect.sync(() => {
    const frames: unknown[] = [];
    const waiters: Array<{
      readonly predicate: (frame: unknown) => boolean;
      readonly deferred: Deferred.Deferred<unknown>;
    }> = [];
    return {
      frames,
      record: (frame) =>
        Effect.gen(function* () {
          frames.push(frame);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index]!;
            if (!waiter.predicate(frame)) continue;
            waiters.splice(index, 1);
            yield* Deferred.succeed(waiter.deferred, frame);
          }
        }),
      waitFor: (predicate) =>
        Effect.gen(function* () {
          const seen = frames.find(predicate);
          if (seen !== undefined) return seen;
          const deferred = yield* Deferred.make<unknown>();
          waiters.push({ predicate, deferred });
          return yield* Deferred.await(deferred);
        }),
    };
  });

const frameType = (frame: unknown): string | undefined =>
  typeof frame === "object" && frame !== null
    ? String((frame as Record<string, unknown>).type ?? "")
    : undefined;

/** 真实探针主体：由下方 it.skip/it.effect 按二进制可用性注册。 */
const realProbe = (): Effect.Effect<void, JsonlRpcProcessError | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const binaryPath = ompBinary ?? "";

    // 假上游：记录请求，返回非流式 chat completion。
    const upstream = yield* Effect.acquireRelease(Effect.promise(startUpstream), (fixture) =>
      Effect.promise(() => fixture.close()),
    );

    // 受管 agent 目录：只注册指向假上游的 codework-test provider。
    const agentHome = yield* Effect.promise(() =>
      NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-omp-real-home-")),
    );
    const modelsJson = {
      providers: {
        "codework-test": {
          name: "Code Work Test",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          api: "openai-completions",
          apiKey: "probe-dummy",
          models: [
            {
              id: "probe-model",
              name: "Probe Model",
              input: ["text"],
              contextWindow: 128_000,
              reasoning: false,
            },
          ],
        },
      },
    };
    yield* Effect.promise(() =>
      NodeFS.promises.writeFile(
        NodePath.join(agentHome, "models.json"),
        `${JSON.stringify(modelsJson, null, 2)}\n`,
        "utf8",
      ),
    );

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const environment: Record<string, string> = {
      ...scrubPifamilyEnvironment(process.env),
      PI_CODING_AGENT_DIR: agentHome,
    };
    const ompArgs = [
      "--mode",
      "rpc-ui",
      "--approval-mode",
      "yolo",
      "--model",
      "codework-test/probe-model",
    ];
    // 不直接 `yield* spawnPifamilyProcess(...)`：它是一个零 yield 的
    // Effect.fn 生成器，vite-plus 的测试期转换会把它编译成普通函数，
    // 测试文件里的 yield* 调用点不会被同步改写。这里按同一逻辑内联
    // （resolveSpawnCommand + ChildProcess.make + spawner.spawn）。
    const spawnOmp = (
      scope: Scope.Scope,
    ): Effect.Effect<ChildProcessSpawner.ChildProcessHandle, Error> =>
      Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand(binaryPath, ompArgs, {
          env: environment,
          extendEnv: true,
        });
        return yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              env: environment,
              extendEnv: true,
              shell: resolved.shell,
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
      });
    const sessionScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(sessionScope, Exit.void));
    const rpc = yield* makeJsonlRpcProcess({
      diagnosticName: "OmpReal",
      spawn: spawnOmp,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Scope.Scope, sessionScope),
    );

    const recorder = yield* makeFrameRecorder();
    yield* rpc.streamEvents.pipe(
      Stream.runForEach((frame) => recorder.record(frame)),
      Effect.forkScoped,
    );

    // ready 帧 → v2 协商。
    const ready = yield* recorder.waitFor((frame) => frameType(frame) === "ready");
    expect(supportsJsonlRpcProtocolV2(ready)).toBe(true);
    const negotiated = (yield* rpc.request(
      { type: "negotiate_protocol", protocolVersion: 2 },
      20_000,
    )) as { readonly protocolVersion?: number } | undefined;
    expect(negotiated?.protocolVersion).toBe(2);

    // 凭据隔离：受管目录里只有 codework-test provider。
    const models = (yield* rpc.request({ type: "get_available_models" }, 20_000)) as
      | { readonly models?: ReadonlyArray<{ readonly provider?: unknown }> }
      | undefined;
    const modelList = models?.models ?? [];
    expect(modelList.length).toBeGreaterThan(0);
    const providers = new Set(
      modelList.map((model) => String(model.provider ?? "")).filter((value) => value.length > 0),
    );
    expect([...providers]).toEqual(["codework-test"]);
    expect(
      modelList.some((model) => (model as { readonly id?: unknown }).id === "probe-model"),
    ).toBe(true);

    // prompt 往返：真实 omp 经假上游出 agent_end。
    yield* rpc.request({ type: "prompt", message: "Say OK." }, 120_000);
    yield* recorder.waitFor((frame) => frameType(frame) === "agent_end");

    expect(upstream.calls.length).toBeGreaterThan(0);
    expect(upstream.calls.every((call) => call.body.model === "probe-model")).toBe(true);

    yield* rpc.close("probe complete");
  }).pipe(
    Effect.scoped,
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codework-omp-real-e2e-" })),
    Effect.provide(NodeServices.layer),
  );

describe("OmpReal (real omp binary)", () => {
  const testName = "managed agent dir isolates credentials and completes a prompt round-trip";
  if (ompBinary === null) {
    it.skip(testName, realProbe);
  } else {
    it.effect(testName, realProbe);
  }
});
