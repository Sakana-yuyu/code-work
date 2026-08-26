import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as CompositionRuntimeMcpSessionRegistry from "./CompositionRuntimeMcpSessionRegistry.ts";

const makeRegistry = (now: () => number) =>
  CompositionRuntimeMcpSessionRegistry.__testing
    .make({ now })
    .pipe(Effect.provide(NodeServices.layer));

const binding = (
  overrides: Partial<CompositionRuntimeMcpSessionRegistry.CompositionRuntimeMcpBindingRequest> = {},
) => ({
  rawToken: "runtime-agent-token",
  runtimeId: "multica:daemon-1:runtime-1",
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  capabilityGrantIds: ["grant-workspace"],
  expiresAtUnixMs: 2_000,
  ...overrides,
});

it.effect("只保存 token 哈希并把凭据绑定到唯一 Runtime/Task/Run/Agent", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const activated = yield* registry.activate(binding());

    expect(activated.capabilityHandshakeId).not.toBe("");
    expect(yield* registry.resolve("runtime-agent-token")).toEqual(activated);
    expect(yield* registry.resolve("wrong-token")).toBeUndefined();

    const repeated = yield* registry.activate(binding());
    expect(repeated.capabilityHandshakeId).toBe(activated.capabilityHandshakeId);
  }),
);

it.effect("同一 Agent token 在旧 Run 有效时拒绝绑定其他 Run", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    yield* registry.activate(binding());

    const error = yield* registry.activate(binding({ runId: "run-2" })).pipe(Effect.flip);
    expect(error.code).toBe("credential_in_use");
  }),
);

it.effect("拒绝重复 Grant、过期绑定并在撤销后释放 token", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);

    const duplicateGrantError = yield* registry
      .activate(binding({ capabilityGrantIds: ["grant-workspace", "grant-workspace"] }))
      .pipe(Effect.flip);
    expect(duplicateGrantError.code).toBe("invalid_binding");

    const expiredError = yield* registry
      .activate(binding({ expiresAtUnixMs: timestamp }))
      .pipe(Effect.flip);
    expect(expiredError.code).toBe("invalid_binding");

    const activated = yield* registry.activate(binding());
    yield* registry.revokeHandshake(activated.capabilityHandshakeId);
    expect(yield* registry.resolve("runtime-agent-token")).toBeUndefined();

    const rebound = yield* registry.activate(binding({ runId: "run-2" }));
    expect(rebound.runId).toBe("run-2");

    timestamp = 2_001;
    expect(yield* registry.resolve("runtime-agent-token")).toBeUndefined();
  }),
);

it.effect("两个 Agent 使用独立 token 和 Run，撤销其中一个不会影响另一个", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const first = yield* registry.activate(binding());
    const second = yield* registry.activate(
      binding({
        rawToken: "runtime-agent-token-2",
        taskId: "task-2",
        runId: "run-2",
        agentId: "agent-2",
        capabilityGrantIds: ["grant-terminal"],
      }),
    );

    expect(yield* registry.resolve("runtime-agent-token")).toEqual(first);
    expect(yield* registry.resolve("runtime-agent-token-2")).toEqual(second);

    yield* registry.revokeRun("run-1");
    expect(yield* registry.resolve("runtime-agent-token")).toBeUndefined();
    expect(yield* registry.resolve("runtime-agent-token-2")).toEqual(second);
  }),
);

it.effect("按 Runtime 撤销会释放 binding 并唤醒在途请求", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const activated = yield* registry.activate(binding());
    const watcher = yield* Effect.forkChild(
      registry.awaitRevocation(activated.capabilityHandshakeId),
    );

    yield* registry.revokeRuntime(binding().runtimeId);

    yield* Fiber.join(watcher);
    expect(yield* registry.resolve(binding().rawToken)).toBeUndefined();
  }),
);
