import { type EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

export type CompositionBrowserScopeInput = {
  readonly environmentId: EnvironmentId;
  readonly taskId: string;
  readonly runId: string;
  readonly runtimeId: string;
  readonly threadId?: string;
  readonly issuedAt: number;
};

const compositionProviderInstanceId = (runtimeId: string): ProviderInstanceId =>
  ProviderInstanceId.make(
    `composition-${runtimeId.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-")}`,
  );

/**
 * 为 Composition Run 生成 Preview 专用 scope。
 *
 * sessionId 是 T3 自己的浏览器会话身份，不等同于 Provider MCP session；
 * providerSessionId 只由真正的 Provider MCP 凭据填充。
 */
export const makeCompositionBrowserScope = (
  input: CompositionBrowserScopeInput,
): McpInvocationScope => ({
  environmentId: input.environmentId,
  threadId: ThreadId.make(input.threadId ?? `composition-${input.taskId}`),
  sessionId: `composition-browser:${input.taskId}:${input.runId}`,
  providerInstanceId: compositionProviderInstanceId(input.runtimeId),
  capabilities: new Set(["preview"]),
  issuedAt: input.issuedAt,
});
