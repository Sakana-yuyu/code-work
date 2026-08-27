// @effect-diagnostics globalTimers:off - 本测试等待真实子进程与本地 HTTP 服务。
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalErrorInEffectCatch:off

import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import { describe, expect } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  makeMulticaDaemonProtocol,
  makeMulticaFetchHttpTransport,
} from "./MulticaDaemonProtocol.ts";
import { makeMulticaDaemonRuntimeAdapter } from "./MulticaDaemonRuntimeAdapter.ts";
import {
  auditMulticaQuickCreateIntents,
  settleStaleSendingIntent,
} from "./MulticaQuickCreateOutbox.ts";
import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";

const fixturePath = NodeURL.fileURLToPath(
  new NodeURL.URL("./MulticaQuickCreateHttpFixture.mjs", import.meta.url),
);

type FixtureProcess = {
  readonly child: NodeChildProcess.ChildProcess;
  readonly baseUrl: string;
};

const startFixture = async (): Promise<FixtureProcess> => {
  const child = NodeChildProcess.spawn(process.execPath, [fixturePath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const lines = NodeReadline.createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    const onLine = (line: string) => {
      try {
        const message = JSON.parse(line) as { readonly port?: unknown };
        if (typeof message.port === "number") resolve(message.port);
      } catch {
        // 忽略 fixture 启动阶段的非 JSON 输出。
      }
    };
    lines.on("line", onLine);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`quick-create fixture 提前退出：${code ?? "?"}`)),
    );
  });
  lines.close();
  // 等到 /__ready 返回，避免首请求竞态。
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__ready`);
      if (response.ok) break;
    } catch {
      // 继续等待。
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, baseUrl: `http://127.0.0.1:${port}` };
};

const stopFixture = async (fixture: FixtureProcess): Promise<void> => {
  if (fixture.child.exitCode !== null) return;
  fixture.child.kill();
};

const runtimeId = "multica:e2e:r1";

type InMemoryIntent = {
  readonly runId: string;
  readonly taskId: string;
  readonly runtimeId: string;
  readonly idempotencyKey: string;
  state: "prepared" | "sending" | "accepted";
  remoteTaskId?: string;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
};

/** 与 SQLite 账本同语义的内存实现：仅 prepared→sending→accepted 单向流转。 */
const makeIntentLedger = () => {
  const intents = new Map<string, InMemoryIntent>();
  const store = {
    createMulticaQuickCreateIntent: (intent: Omit<InMemoryIntent, "state">) =>
      Effect.sync(() => {
        if (
          intents.has(intent.runId) ||
          [...intents.values()].some(
            (existing) =>
              existing.runtimeId === intent.runtimeId &&
              existing.idempotencyKey === intent.idempotencyKey,
          )
        ) {
          return false;
        }
        intents.set(intent.runId, { ...intent, state: "prepared" });
        return true;
      }),
    getMulticaQuickCreateIntent: (runId: string) =>
      Effect.sync(() => {
        const intent = intents.get(runId);
        return intent === undefined
          ? Option.none<InMemoryIntent>()
          : Option.some<InMemoryIntent>(intent);
      }),
    getMulticaQuickCreateIntentByIdempotencyKey: (runtimeIdOf: string, key: string) =>
      Effect.sync(() => {
        const intent = [...intents.values()].find(
          (candidate) => candidate.runtimeId === runtimeIdOf && candidate.idempotencyKey === key,
        );
        return intent === undefined
          ? Option.none<InMemoryIntent>()
          : Option.some<InMemoryIntent>(intent);
      }),
    claimMulticaQuickCreateIntentForSend: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const existing = intents.get(input.runId);
        if (
          existing === undefined ||
          existing.runtimeId !== input.runtimeId ||
          existing.state !== "prepared"
        ) {
          return Option.none<InMemoryIntent>();
        }
        const claimed = { ...existing, state: "sending" as const, ...input };
        intents.set(input.runId, claimed);
        return Option.some(claimed);
      }),
    acceptMulticaQuickCreateIntent: (input: {
      readonly runId: string;
      readonly runtimeId: string;
      readonly remoteTaskId: string;
      readonly updatedAtUnixMs: number;
    }) =>
      Effect.sync(() => {
        const existing = intents.get(input.runId);
        if (
          existing === undefined ||
          existing.runtimeId !== input.runtimeId ||
          existing.state !== "sending"
        ) {
          return Option.none<InMemoryIntent>();
        }
        const accepted = { ...existing, state: "accepted" as const, ...input };
        intents.set(input.runId, accepted);
        return Option.some(accepted);
      }),
    listPendingMulticaQuickCreateIntents: (runtimeIdOf?: string) =>
      Effect.succeed(
        [...intents.values()].filter(
          (intent) =>
            (runtimeIdOf === undefined || intent.runtimeId === runtimeIdOf) &&
            intent.state !== "accepted",
        ),
      ),
  } satisfies Pick<
    CompositionTaskStoreShape,
    | "createMulticaQuickCreateIntent"
    | "getMulticaQuickCreateIntent"
    | "getMulticaQuickCreateIntentByIdempotencyKey"
    | "claimMulticaQuickCreateIntentForSend"
    | "acceptMulticaQuickCreateIntent"
    | "listPendingMulticaQuickCreateIntents"
  >;
  return { intents, store };
};

const makeAdapter = (
  fixture: FixtureProcess,
  ledgerStore: ReturnType<typeof makeIntentLedger>["store"],
  now: () => number,
  wrapFetch?: (next: MinimalFetch) => MinimalFetch,
) =>
  makeMulticaDaemonRuntimeAdapter({
    runtimeId,
    daemonId: "e2e",
    daemonRuntimeId: "runtime-1",
    baseUrl: fixture.baseUrl,
    protocol: makeMulticaDaemonProtocol({
      baseUrl: fixture.baseUrl,
      transport: makeMulticaFetchHttpTransport({
        baseUrl: fixture.baseUrl,
        headers: { authorization: "Bearer fixture-token" },
        ...(wrapFetch === undefined
          ? {}
          : {
              fetchImpl: wrapFetch(globalThis.fetch.bind(globalThis)) as unknown as typeof fetch,
            }),
      }),
    }),
    quickCreateIntentStore: ledgerStore,
    agents: [{ agentId: `${runtimeId}:agent`, runtimeId, status: "online", capabilities: [] }],
    taskAssigneeRoutes: [
      {
        codeworkAgentId: "agent-1",
        workspaceId: "workspace-1",
        multicaAgentId: "remote-agent-1",
      },
    ],
    now,
  });

const dispatchInput = {
  taskId: "task-e2e-1",
  runId: "run-e2e-1",
  agentId: "agent-1",
  projectId: "project-e2e",
  prompt: "跨进程集成验证",
  idempotencyKey: "run-e2e-1",
} as const;

/** 在 it.effect 中执行真实异步阶段；orDie 让错误通道保持 never 以满足 it.effect 合同。 */
const tryP = <A>(thunk: () => Promise<A>): Effect.Effect<A> =>
  Effect.orDie(Effect.tryPromise(thunk));

type MinimalFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const failureCodeOf = <A>(effect: Effect.Effect<A, { code: string }>): Effect.Effect<string, A> =>
  Effect.map(Effect.flip(effect), (failure) => failure.code);

describe("Multica quick-create 真实 HTTP 集成", () => {
  effectIt.live("happy path：POST 快建成功并原子绑定远端 task ID", () =>
    Effect.flatMap(tryP(startFixture), (fixture) =>
      Effect.gen(function* () {
        const clock = { value: 10_000 };
        const ledger = makeIntentLedger();
        const adapter = makeAdapter(fixture, ledger.store, () => clock.value);
        const result = yield* adapter.dispatchTask(dispatchInput);
        expect(result.status).toBe("accepted");
        expect(result.runtimeTaskId?.startsWith("remote-issue-")).toBe(true);

        const state = yield* tryP(async () => {
          const response = await fetch(`${fixture.baseUrl}/__state?key=run-e2e-1`);
          return (await response.json()) as { quickCreateRequests: number; prompt?: string };
        });
        expect(state.quickCreateRequests).toBe(1);
        expect(state.prompt).toBe(dispatchInput.prompt);

        const intentOption = yield* ledger.store.getMulticaQuickCreateIntent(dispatchInput.runId);
        expect(Option.isSome(intentOption)).toBe(true);
        if (Option.isSome(intentOption)) {
          expect(intentOption.value.state).toBe("accepted");
          expect(intentOption.value.remoteTaskId).toBe(result.runtimeTaskId);
        }
      }).pipe(Effect.ensuring(tryP(() => stopFixture(fixture)))),
    ),
  );

  effectIt.live("响应丢失后：拒绝重放 POST，经审计收口远端 ID，再派发不再重复创建", () =>
    Effect.flatMap(tryP(startFixture), (fixture) =>
      Effect.gen(function* () {
        const clock = { value: 20_000 };
        const ledger = makeIntentLedger();
        let dropped = false;
        const dropFirstPost =
          (next: MinimalFetch): MinimalFetch =>
          (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const headers = (init?.headers ?? {}) as Record<string, string>;
            if (!dropped && url.includes("/api/issues/quick-create")) {
              dropped = true;
              return next(`${url}`, {
                ...init,
                headers: { ...headers, "x-test-drop-response": "1" },
              });
            }
            return next(input, init);
          };

        // 远端已建档但响应被销毁 → 客户端失败必须转为恢复态而不是静默成功。
        const firstAdapter = makeAdapter(fixture, ledger.store, () => clock.value, dropFirstPost);
        const failure = yield* failureCodeOf(firstAdapter.dispatchTask(dispatchInput));
        expect(failure).toBe("quick_create_recovery_required");
        expect(dropped).toBe(true);
        const hungIntent = Option.getOrThrow(
          yield* ledger.store.getMulticaQuickCreateIntent(dispatchInput.runId),
        );
        expect(hungIntent.state).toBe("sending");

        // 审计发现悬挂 sending；重建后的 Adapter 自动重放仍被拒绝。
        const audit = yield* auditMulticaQuickCreateIntents(ledger.store, {
          staleBeforeUnixMs: clock.value + 1_000,
        });
        expect(audit.staleSending.map((intent) => intent.runId)).toEqual([dispatchInput.runId]);
        const rebuiltAdapter = makeAdapter(fixture, ledger.store, () => clock.value + 5_000);
        const replayFailure = yield* failureCodeOf(rebuiltAdapter.dispatchTask(dispatchInput));
        expect(replayFailure).toBe("quick_create_recovery_required");

        // 从真实 daemon 查回远端 task ID 后收口；随后派发命中 accepted 恢复路径。
        const remoteTaskId = yield* tryP(async () => {
          const lookup = await fetch(
            `${fixture.baseUrl}/api/issues/by-key/${encodeURIComponent(dispatchInput.idempotencyKey)}`,
          );
          return ((await lookup.json()) as { task_id: string }).task_id;
        });
        yield* settleStaleSendingIntent(ledger.store, {
          runId: dispatchInput.runId,
          runtimeId,
          remoteTaskId,
          updatedAtUnixMs: clock.value + 6_000,
        });

        const recovered = yield* rebuiltAdapter.dispatchTask(dispatchInput);
        expect(recovered).toEqual({ runtimeTaskId: remoteTaskId, status: "already_running" });
        const finalState = yield* tryP(async () => {
          const response = await fetch(
            `${fixture.baseUrl}/__state?key=${encodeURIComponent(dispatchInput.idempotencyKey)}`,
          );
          return (await response.json()) as { quickCreateRequests: number };
        });
        // 全流程只产生过一次 POST，证明重启与收口均未造成重复创建。
        expect(finalState.quickCreateRequests).toBe(1);
      }).pipe(Effect.ensuring(tryP(() => stopFixture(fixture)))),
    ),
  );
});
