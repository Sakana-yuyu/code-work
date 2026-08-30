import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  makeCompositionRunStartDigests,
  normalizeCompositionRunStartRejectedOutcome,
  validateCompositionRunStartReceipt,
} from "./CompositionRunStartLifecycle.ts";

const identity = {
  taskId: "task-run-start-lifecycle",
  runId: "run-run-start-lifecycle",
  previousRunId: null,
  agentId: "agent-run-start-lifecycle",
  runtimeId: "runtime-run-start-lifecycle",
  attempt: 1,
  promptDigest: "sha256:prompt-run-start-lifecycle",
  workspaceRootDigest: "sha256:workspace-run-start-lifecycle",
  model: "model-run-start-lifecycle",
};

it.effect("payload 与 capability 摘要稳定且能区分真实启动输入", () =>
  Effect.sync(() => {
    const first = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: ["workspace.write", "workspace.read", "workspace.read"],
    });
    const reordered = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: ["workspace.read", "workspace.write"],
    });
    const changed = makeCompositionRunStartDigests({
      ...identity,
      model: "model-run-start-lifecycle-next",
      capabilityIds: ["workspace.read", "workspace.write"],
    });

    assert.equal(first.capabilityDigest, reordered.capabilityDigest);
    assert.equal(first.payloadDigest, reordered.payloadDigest);
    assert.notEqual(first.payloadDigest, changed.payloadDigest);
    assert.match(first.payloadDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(first.capabilityDigest, /^sha256:[0-9a-f]{64}$/);
  }),
);

it.effect("capability 摘要使用与 locale 无关的固定排序", () =>
  Effect.sync(() => {
    const first = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: ["ä", "z", "a", "A"],
    });
    const reordered = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: ["A", "a", "z", "ä"],
    });

    assert.equal(first.capabilityDigest, reordered.capabilityDigest);
    assert.equal(
      first.capabilityDigest,
      "sha256:d49d45861c2f4c1a0f9cd85d648a41f4c868818e852a3540c8e59f18e33d3142",
    );
  }),
);

it.effect("未知 capability 身份使用独立固定摘要而不是空集合摘要", () =>
  Effect.sync(() => {
    const unknown = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: null,
    });
    const empty = makeCompositionRunStartDigests({
      ...identity,
      capabilityIds: [],
    });

    assert.notEqual(unknown.capabilityDigest, empty.capabilityDigest);
    assert.equal(
      unknown.capabilityDigest,
      "sha256:6e49a45035ab8cd96322c08d2dde90872371eee1dc79660f265d9d2d719e420a",
    );
  }),
);

it.effect("持久错误截断不会留下半个 UTF-16 代理字符", () =>
  Effect.sync(() => {
    const normalized = normalizeCompositionRunStartRejectedOutcome({
      code: "driver_failure",
      detail: `${"x".repeat(1_023)}😀tail`,
    });

    assert.equal(normalized.outcomeDetail, "x".repeat(1_023));
    assert.equal(normalized.outcomeDetail.length, 1_023);
  }),
);

it.effect("缺少策略要求的 runtime task receipt 时返回类型化失败", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      validateCompositionRunStartReceipt({
        policy: {
          mode: "idempotent-replay",
          requiredReceipt: "runtime-task",
          capabilityGrantReplay: { mode: "none" },
        },
        startResult: {},
        capabilityGrantIds: [],
      }),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "run_start_runtime_task_receipt_missing");
    }
  }),
);

it.effect("已验证 grant 重放缺少 handshake receipt 时返回类型化失败", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      validateCompositionRunStartReceipt({
        policy: {
          mode: "idempotent-replay",
          requiredReceipt: "runtime-task",
          capabilityGrantReplay: { mode: "verified" },
        },
        startResult: { runtimeTaskId: "runtime-task-lifecycle" },
        capabilityGrantIds: ["grant-lifecycle"],
      }),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "run_start_capability_handshake_receipt_missing");
    }
  }),
);
