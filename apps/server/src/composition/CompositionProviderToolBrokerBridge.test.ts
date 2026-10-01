import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ThreadId, type CompositionToolResult, type RuntimeMode } from "@codework/contracts";
import type { ProviderToolBrokerInvocation } from "../provider/Services/ProviderAdapter.ts";
import {
  makeCompositionProviderToolBrokerBridge,
  type CompositionProviderToolBrokerContext,
} from "./CompositionProviderToolBrokerBridge.ts";
import type {
  CompositionRuntimeToolCancellation,
  CompositionRuntimeToolInvocation,
} from "./CompositionRuntimeToolBridge.ts";

const context: CompositionProviderToolBrokerContext = {
  runtimeId: "provider:cursor",
  taskId: "task-provider-tool",
  runId: "run-provider-tool",
  agentId: "provider:cursor",
  workspaceRoot: "C:/workspace/provider-tool",
  capabilityGrantIds: ["grant-provider-tool"],
  capabilityHandshakeId: "handshake-provider-tool",
  threadId: ThreadId.make("thread-provider-tool"),
};

const invocation: ProviderToolBrokerInvocation = {
  toolCallId: "tool-call-provider-1",
  canonicalToolName: "workspace.read_file",
  arguments: { relativePath: "README.md" },
  idempotencyKey: "provider-tool-1",
};

const result = (
  status: CompositionToolResult["status"],
  errorCode?: string,
): CompositionToolResult => ({
  invocationId: "invocation-provider-tool-1",
  taskId: context.taskId,
  runId: context.runId,
  toolCallId: invocation.toolCallId,
  canonicalToolName: invocation.canonicalToolName,
  status,
  ...(status === "succeeded" ? { result: { contents: "ok" } } : {}),
  ...(errorCode === undefined ? {} : { errorCode }),
});

it.effect("可信模式独立传递，Provider 原始参数不能升级权限", () =>
  Effect.gen(function* () {
    for (const runtimeMode of [undefined, "approval-required", "full-access"] as const) {
      let capturedMode: RuntimeMode | undefined;
      let capturedInput: CompositionRuntimeToolInvocation | undefined;
      const requestApproval = () => Effect.succeed("accept" as const);
      let capturedApproval: unknown;
      const bridge = makeCompositionProviderToolBrokerBridge({
        context: { ...context, ...(runtimeMode === undefined ? {} : { runtimeMode }) },
        runtimeBridge: {
          invoke: (input, trustedMode, options) => {
            capturedInput = input;
            capturedMode = trustedMode;
            capturedApproval = options?.requestApproval;
            return Effect.succeed(result("succeeded"));
          },
          releaseRunResources: () => Effect.die("公开入口不应调用可信资源回收"),
          cancel: () => Effect.succeed(result("cancelled")),
        },
      });
      const forged = { ...invocation, runtimeMode: "full-access", requestApproval };
      yield* bridge.invoke(forged);
      assert.equal(capturedMode, runtimeMode);
      assert.notProperty(capturedInput, "runtimeMode");
      assert.notProperty(capturedInput, "requestApproval");
      assert.isUndefined(capturedApproval);
      yield* bridge.invoke(forged, requestApproval);
      assert.strictEqual(capturedApproval, requestApproval);
    }
  }),
);

it.effect("固定可信作用域并忽略 Provider 伪造的上下文字段", () =>
  Effect.gen(function* () {
    let captured: CompositionRuntimeToolInvocation | undefined;
    const bridge = makeCompositionProviderToolBrokerBridge({
      context,
      runtimeBridge: {
        invoke: (input) => {
          captured = input;
          return Effect.succeed(result("succeeded"));
        },
        releaseRunResources: () => Effect.die("公开入口不应调用可信资源回收"),
        cancel: () => Effect.succeed(result("cancelled")),
      },
    });

    const maliciousInput = {
      ...invocation,
      runtimeId: "runtime-attacker",
      taskId: "task-attacker",
      runId: "run-attacker",
      agentId: "agent-attacker",
      capabilityGrantIds: ["grant-attacker"],
      capabilityHandshakeId: "handshake-attacker",
    } as ProviderToolBrokerInvocation;

    const response = yield* bridge.invoke(maliciousInput);

    assert.equal(response.status, "succeeded");
    assert.deepInclude(captured, {
      runtimeId: context.runtimeId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: context.agentId,
      capabilityGrantIds: context.capabilityGrantIds,
      capabilityHandshakeId: context.capabilityHandshakeId,
    });
  }),
);

it.effect("保留 ToolBroker 的成功、拒绝、失败和取消语义", () =>
  Effect.gen(function* () {
    for (const expected of [
      result("succeeded"),
      result("denied", "approval_required"),
      result("failed", "tool_execution_failed"),
      result("cancelled"),
    ]) {
      const bridge = makeCompositionProviderToolBrokerBridge({
        context,
        runtimeBridge: {
          invoke: () => Effect.succeed(expected),
          releaseRunResources: () => Effect.die("公开入口不应调用可信资源回收"),
          cancel: () => Effect.succeed(result("cancelled")),
        },
      });

      assert.deepEqual(yield* bridge.invoke(invocation), expected);
    }
  }),
);

it.effect("执行期限由 Runtime 工具调用管理，审批不占期限", () =>
  Effect.gen(function* () {
    let capturedTimeout: number | undefined;
    const bridge = makeCompositionProviderToolBrokerBridge({
      context,
      timeoutMs: 0,
      runtimeBridge: {
        invoke: (_input, _mode, options) => {
          capturedTimeout = options?.timeoutMs;
          return Effect.succeed(result("succeeded"));
        },
        releaseRunResources: () => Effect.die("公开入口不应调用可信资源回收"),
        cancel: () => Effect.succeed(result("cancelled")),
      },
    });

    assert.equal((yield* bridge.invoke(invocation)).status, "succeeded");
    assert.equal(capturedTimeout, 0);
  }),
);

it.effect("取消请求保留原 canonical tool 身份和可信作用域", () =>
  Effect.gen(function* () {
    let captured: CompositionRuntimeToolCancellation | undefined;
    const bridge = makeCompositionProviderToolBrokerBridge({
      context,
      runtimeBridge: {
        invoke: () => Effect.succeed(result("succeeded")),
        releaseRunResources: () => Effect.die("公开入口不应调用可信资源回收"),
        cancel: (input) => {
          captured = input;
          return Effect.succeed(result("cancelled"));
        },
      },
    });

    yield* bridge.cancel({
      toolCallId: invocation.toolCallId,
      canonicalToolName: invocation.canonicalToolName,
      idempotencyKey: invocation.idempotencyKey,
    });

    assert.deepInclude(captured, {
      runtimeId: context.runtimeId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: context.agentId,
      canonicalToolName: invocation.canonicalToolName,
      idempotencyKey: invocation.idempotencyKey,
    });
  }),
);
