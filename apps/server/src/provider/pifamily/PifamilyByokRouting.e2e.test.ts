// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - 测试夹具直接断言上游 JSON 线格式。
/**
 * pi-family BYOK 路由 e2e —— 本任务的核心验收。
 *
 * 端到端链路：pi mock agent（MOCK_PI_MODEL_HTTP=1）→ 真实 BYOK 网关路由层
 * （byokGatewayRouteLayer 挂在 node http 服务器上）→ 假上游 OpenAI 服务。
 * 断言网关把 adapter id 改写成真实上游模型名、把网关 token 换成上游密钥、
 * 网关 token 不泄漏进上游请求或任何 ProviderRuntimeEvent；未知 adapter id
 * 走 404 fail-closed，turn 收敛到 failed 终态而不是挂死。
 *
 * @module provider/pifamily/PifamilyByokRouting.e2e.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";

import {
  DEFAULT_SERVER_SETTINGS,
  PiAgentSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  type ServerSettings,
} from "@codework/contracts";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { layerTest as layerTestSettings } from "../../serverSettings.ts";
import { byokGatewayRouteLayer } from "../byok/modelGateway.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import type { PifamilyModelRoute } from "./byokProviderConfig.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);
const isProviderRuntimeEvent = Schema.is(ProviderRuntimeEvent);
const instanceId = ProviderInstanceId.make("pi-byok-routing-e2e");

/** 网关 token：32 字节 0x07（与 ServerSecretStore 桩的 getOrCreateRandom 对应）。 */
const GATEWAY_TOKEN_BYTES = Buffer.alloc(32, 7);
const GATEWAY_TOKEN = GATEWAY_TOKEN_BYTES.toString("hex");
const UPSTREAM_API_KEY = "upstream-secret-key";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.mjs");

async function makeMockAgentWrapper(): Promise<string> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-pi-routing-mock-"));
  // oxlint-disable-next-line codework/no-global-process-runtime -- wrapper generation must follow the real host shell.
  const isWindows = process.platform === "win32";
  const wrapperPath = NodePath.join(dir, isWindows ? "pi-mock.cmd" : "pi-mock.sh");
  const script = isWindows
    ? `@echo off
"${process.execPath}" "${mockAgentPath}" %*
exit /b %ERRORLEVEL%
`
    : `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  if (!isWindows) await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

interface UpstreamCall {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

interface HttpServerFixture {
  readonly port: number;
  readonly close: () => Promise<void>;
}

const closeServer = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });

/** 假上游：记录每个请求（路径/鉴权头/改写后的 body），返回 chat completion JSON。 */
const startUpstream = (): Promise<HttpServerFixture & { readonly calls: UpstreamCall[] }> =>
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
        response.end(JSON.stringify({ choices: [{ message: { content: "ROUTED_OK" } }] }));
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("upstream 端口未绑定");
      }
      resolve({ calls, port: address.port, close: () => closeServer(server) });
    });
  });

/** 把网关 web handler 挂到真实 TCP 端口上，供子进程里的 mock agent 访问。 */
const startGatewayHttpServer = (
  handler: (request: Request) => Promise<Response>,
): Promise<HttpServerFixture> =>
  new Promise((resolve) => {
    const server = NodeHttp.createServer((request, response) => {
      void (async () => {
        try {
          const chunks: Buffer[] = [];
          if (request.method !== "GET" && request.method !== "HEAD") {
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
          }
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            if (typeof value === "string") headers[name] = value;
            else if (Array.isArray(value)) headers[name] = value.join(", ");
          }
          const requestInit: RequestInit = {
            method: request.method ?? "GET",
            headers,
          };
          if (chunks.length > 0) {
            requestInit.body = new Uint8Array(Buffer.concat(chunks));
          }
          const webRequest = new Request(`http://127.0.0.1${request.url ?? "/"}`, requestInit);
          const webResponse = await handler(webRequest);
          const body = Buffer.from(await webResponse.arrayBuffer());
          response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
          response.end(body);
        } catch (error) {
          response.writeHead(502, { "content-type": "text/plain" });
          response.end(String(error));
        }
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("gateway 端口未绑定");
      }
      resolve({ port: address.port, close: () => closeServer(server) });
    });
  });

interface PifamilyEventRecorder {
  readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  readonly record: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly waitFor: (
    predicate: (event: ProviderRuntimeEvent) => boolean,
  ) => Effect.Effect<ProviderRuntimeEvent>;
}

const makeEventRecorder = (): Effect.Effect<PifamilyEventRecorder> =>
  Effect.sync(() => {
    const events: ProviderRuntimeEvent[] = [];
    const waiters: Array<{
      readonly predicate: (event: ProviderRuntimeEvent) => boolean;
      readonly deferred: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];
    return {
      events,
      record: (event) =>
        Effect.gen(function* () {
          events.push(event);
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index]!;
            if (!waiter.predicate(event)) continue;
            waiters.splice(index, 1);
            yield* Deferred.succeed(waiter.deferred, event);
          }
        }),
      waitFor: (predicate) =>
        Effect.gen(function* () {
          const seen = events.find(predicate);
          if (seen !== undefined) return seen;
          const deferred = yield* Deferred.make<ProviderRuntimeEvent>();
          waiters.push({ predicate, deferred });
          return yield* Deferred.await(deferred);
        }),
    };
  });

const assistantText = (events: ReadonlyArray<ProviderRuntimeEvent>): string =>
  events
    .filter(
      (event) => event.type === "content.delta" && event.payload.streamKind === "assistant_text",
    )
    .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
    .join("");

const settingsWithInstances = (
  instances: Record<string, { driver: string; enabled: boolean; config: unknown }>,
): ServerSettings =>
  ({
    providerInstances: instances,
  }) as unknown as ServerSettings;

const unused = () => Effect.die("不应调用此密钥操作");

describe("pi-family BYOK routing", () => {
  it.effect("agent → real gateway → upstream: model rewrite + auth substitution", () =>
    Effect.gen(function* () {
      // (i) 假上游。
      const upstream = yield* Effect.acquireRelease(Effect.promise(startUpstream), (fixture) =>
        Effect.promise(() => fixture.close()),
      );

      // (ii) BYOK 实例设置：唯一的 openai adapter 指向假上游。
      const settings = settingsWithInstances({
        "pi-byok-source": {
          driver: "byok",
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              {
                id: "mock-byok-adapter",
                displayName: "Mock Upstream",
                groupName: "",
                protocol: "openai",
                baseURL: `http://127.0.0.1:${upstream.port}/v1`,
                apiKey: UPSTREAM_API_KEY,
                apiKeyRedacted: false,
                modelId: "gpt-mock-upstream",
                contextWindowTokens: 128_000,
                supplierID: "custom",
              },
            ],
          },
        },
      });

      // (iii) 真实网关路由层 → web handler → TCP。
      const { handler, dispose } = HttpRouter.toWebHandler(
        byokGatewayRouteLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              FetchHttpClient.layer,
              layerTestSettings({ ...DEFAULT_SERVER_SETTINGS, ...settings }),
              Layer.succeed(ServerSecretStore, {
                get: unused,
                set: unused,
                create: unused,
                remove: unused,
                getOrCreateRandom: () => Effect.succeed(GATEWAY_TOKEN_BYTES),
              }),
            ),
          ),
        ),
        { disableLogger: true },
      );
      const gateway = yield* Effect.acquireRelease(
        Effect.promise(() => startGatewayHttpServer(handler)),
        (fixture) => Effect.promise(() => fixture.close()),
      );
      yield* Effect.acquireRelease(Effect.void, () => Effect.promise(() => dispose()));

      // (iv) pi adapter + mock agent：模型请求发往网关。
      const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
      const agentHome = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-pi-routing-home-")),
      );
      const routes: ReadonlyArray<PifamilyModelRoute> = [
        {
          adapterId: "mock-byok-adapter",
          protocol: "openai",
          displayName: "Mock Upstream",
          modelId: "gpt-mock-upstream",
          contextWindowTokens: 128_000,
        },
      ];
      const adapter = yield* makePiAdapter(
        decodePiSettings({ enabled: true, binaryPath: wrapperPath, launchArgs: "" }),
        {
          instanceId,
          environment: {
            MOCK_PI_MODEL_HTTP: "1",
            MOCK_MODEL_BASE_URL: `http://127.0.0.1:${gateway.port}/byok-gw/openai/v1`,
            MOCK_MODEL_ID: "mock-byok-adapter",
            MOCK_MODEL_API_KEY: GATEWAY_TOKEN,
            PI_CODING_AGENT_DIR: agentHome,
          },
          resolveRoutes: Effect.succeed(routes),
        },
      );
      const recorder = yield* makeEventRecorder();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => recorder.record(event)),
        Effect.forkScoped,
      );

      const threadId = ThreadId.make("pi-byok-routing");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "route me" });
      const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");

      // 上游恰好收到一次请求：模型名改写 + 鉴权替换。
      expect(upstream.calls).toHaveLength(1);
      const upstreamCall = upstream.calls[0];
      expect(upstreamCall?.url).toBe("/v1/chat/completions");
      expect(upstreamCall?.body.model).toBe("gpt-mock-upstream");
      expect(upstreamCall?.authorization).toBe(`Bearer ${UPSTREAM_API_KEY}`);
      expect(upstreamCall?.authorization).not.toContain(GATEWAY_TOKEN);

      // 回复经 agent 流回，turn 完成且事件契约成立。
      expect(completed.payload).toMatchObject({ state: "completed" });
      expect(assistantText(recorder.events)).toBe("ROUTED_OK");
      for (const event of recorder.events) {
        if (!isProviderRuntimeEvent(event)) {
          throw new Error(
            `Event does not decode against ProviderRuntimeEvent: ${JSON.stringify(event)}`,
          );
        }
      }
      // 网关 token 不出现在任何事件序列化里。
      expect(JSON.stringify(recorder.events)).not.toContain(GATEWAY_TOKEN);

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codework-pi-routing-e2e-" })),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect(
    "unknown adapter id fails closed at the gateway and the turn reaches a terminal state",
    () =>
      Effect.gen(function* () {
        const upstream = yield* Effect.acquireRelease(Effect.promise(startUpstream), (fixture) =>
          Effect.promise(() => fixture.close()),
        );
        const settings = settingsWithInstances({
          "pi-byok-source": {
            driver: "byok",
            enabled: true,
            config: {
              enabled: true,
              adapters: [
                {
                  id: "mock-byok-adapter",
                  displayName: "Mock Upstream",
                  groupName: "",
                  protocol: "openai",
                  baseURL: `http://127.0.0.1:${upstream.port}/v1`,
                  apiKey: UPSTREAM_API_KEY,
                  apiKeyRedacted: false,
                  modelId: "gpt-mock-upstream",
                  contextWindowTokens: 128_000,
                  supplierID: "custom",
                },
              ],
            },
          },
        });
        const { handler, dispose } = HttpRouter.toWebHandler(
          byokGatewayRouteLayer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                FetchHttpClient.layer,
                layerTestSettings({ ...DEFAULT_SERVER_SETTINGS, ...settings }),
                Layer.succeed(ServerSecretStore, {
                  get: unused,
                  set: unused,
                  create: unused,
                  remove: unused,
                  getOrCreateRandom: () => Effect.succeed(GATEWAY_TOKEN_BYTES),
                }),
              ),
            ),
          ),
          { disableLogger: true },
        );
        const gateway = yield* Effect.acquireRelease(
          Effect.promise(() => startGatewayHttpServer(handler)),
          (fixture) => Effect.promise(() => fixture.close()),
        );
        yield* Effect.acquireRelease(Effect.void, () => Effect.promise(() => dispose()));

        const wrapperPath = yield* Effect.promise(makeMockAgentWrapper);
        const agentHome = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-pi-routing-home-")),
        );
        // adapter 侧路由解析通过（模型在实例路由内），但 agent 请求了一个
        // 网关不认识的模型 id —— 网关必须 404，turn 必须落到 failed 终态。
        const routes: ReadonlyArray<PifamilyModelRoute> = [
          {
            adapterId: "mock-byok-adapter",
            protocol: "openai",
            displayName: "Mock Upstream",
            modelId: "gpt-mock-upstream",
            contextWindowTokens: 128_000,
          },
        ];
        const adapter = yield* makePiAdapter(
          decodePiSettings({ enabled: true, binaryPath: wrapperPath, launchArgs: "" }),
          {
            instanceId,
            environment: {
              MOCK_PI_MODEL_HTTP: "1",
              MOCK_MODEL_BASE_URL: `http://127.0.0.1:${gateway.port}/byok-gw/openai/v1`,
              MOCK_MODEL_ID: "unknown-adapter-id",
              MOCK_MODEL_API_KEY: GATEWAY_TOKEN,
              PI_CODING_AGENT_DIR: agentHome,
            },
            resolveRoutes: Effect.succeed(routes),
          },
        );
        const recorder = yield* makeEventRecorder();
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => recorder.record(event)),
          Effect.forkScoped,
        );

        const threadId = ThreadId.make("pi-byok-fail-closed");
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        yield* adapter.sendTurn({ threadId, input: "route me" });
        const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
        if (completed.type !== "turn.completed") {
          throw new Error(`unexpected event type ${completed.type}`);
        }

        expect(completed.payload.state).toBe("failed");
        expect(completed.payload.errorMessage).toContain("status 404");
        // 网关 404 在转发之前发生：上游零请求。
        expect(upstream.calls).toHaveLength(0);
        for (const event of recorder.events) {
          if (!isProviderRuntimeEvent(event)) {
            throw new Error(
              `Event does not decode against ProviderRuntimeEvent: ${JSON.stringify(event)}`,
            );
          }
        }

        yield* adapter.stopSession(threadId);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "codework-pi-routing-e2e-" }),
        ),
        Effect.provide(NodeServices.layer),
      ),
  );
});
