import { describe, expect, it } from "vite-plus/test";

import {
  classifyCompositionFailure,
  toCompositionFailureInput,
  type CompositionFailureDisposition,
} from "./CompositionFailurePolicy.ts";

describe("CompositionFailurePolicy", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly run: Parameters<typeof classifyCompositionFailure>[0];
    readonly expected: CompositionFailureDisposition;
  }> = [
    {
      name: "取消终态不重试",
      run: { status: "cancelled" },
      expected: { code: "cancelled", category: "cancelled", recovery: "none", retryable: false },
    },
    {
      name: "权限错误交给人工处理",
      run: { status: "failed", failureCode: "operation_forbidden" },
      expected: {
        code: "operation_forbidden",
        category: "permission",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "配置缺失不重试",
      run: { status: "failed", failureCode: "byok_model_missing" },
      expected: {
        code: "byok_model_missing",
        category: "configuration",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "明确的限流错误可以重试",
      run: { status: "failed", failureCode: "rate-limited" },
      expected: {
        code: "rate-limited",
        category: "capacity",
        recovery: "retry",
        retryable: true,
      },
    },
    {
      name: "未列入白名单的额度耗尽只分类不重试",
      run: { status: "failed", failureCode: "quota_exhausted" },
      expected: {
        code: "quota_exhausted",
        category: "capacity",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "明确的容量不足错误可以重试",
      run: { status: "failed", failureCode: "capacity_exceeded" },
      expected: {
        code: "capacity_exceeded",
        category: "capacity",
        recovery: "retry",
        retryable: true,
      },
    },
    {
      name: "明确的 Provider 网络错误可以重试",
      run: { status: "failed", failureCode: "provider_network" },
      expected: {
        code: "provider_network",
        category: "transport",
        recovery: "retry",
        retryable: true,
      },
    },
    {
      name: "明确的 Provider 服务端错误可以重试",
      run: { status: "failed", failureCode: "provider_server_error" },
      expected: {
        code: "provider_server_error",
        category: "transport",
        recovery: "retry",
        retryable: true,
      },
    },
    {
      name: "标准传输错误可以重试",
      run: { status: "failed", failureCode: "transport_error" },
      expected: {
        code: "transport_error",
        category: "transport",
        recovery: "retry",
        retryable: true,
      },
    },
    {
      name: "未列入白名单的连接错误只分类不重试",
      run: { status: "failed", failureCode: "ide_socket_closed" },
      expected: {
        code: "ide_socket_closed",
        category: "transport",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "Runtime 离线进入重连恢复而不是普通重试",
      run: { status: "failed", failureCode: "runtime_offline" },
      expected: {
        code: "runtime_offline",
        category: "runtime_offline",
        recovery: "reconnect",
        retryable: false,
      },
    },
    {
      name: "Runtime 心跳过期进入重连恢复而不是普通重试",
      run: { status: "failed", failureCode: "runtime_heartbeat_stale" },
      expected: {
        code: "runtime_heartbeat_stale",
        category: "runtime_offline",
        recovery: "reconnect",
        retryable: false,
      },
    },
    {
      name: "Agent 作用域错误不重试",
      run: { status: "failed", failureCode: "runtime_agent_scope_mismatch" },
      expected: {
        code: "runtime_agent_scope_mismatch",
        category: "agent",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "普通超时不因状态本身自动重试",
      run: { status: "timed_out" },
      expected: {
        code: "timed_out",
        category: "transport",
        recovery: "manual",
        retryable: false,
      },
    },
    {
      name: "未知错误默认不重试",
      run: { status: "failed", failureCode: "child_failure" },
      expected: {
        code: "child_failure",
        category: "unknown",
        recovery: "manual",
        retryable: false,
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(classifyCompositionFailure(testCase.run)).toEqual(testCase.expected);
    });
  }

  it("持久化 Run 未记录 failureCode 时按终态回退", () => {
    const failureCode: string | undefined = undefined;

    expect(classifyCompositionFailure(toCompositionFailureInput("timed_out", failureCode))).toEqual(
      {
        code: "timed_out",
        category: "transport",
        recovery: "manual",
        retryable: false,
      },
    );
  });
});
