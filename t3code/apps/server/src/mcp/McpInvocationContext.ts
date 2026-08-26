import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** T3 的通用浏览器 session 身份；Provider MCP 继续与旧字段兼容。 */
  readonly sessionId: string;
  readonly providerSessionId?: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const diagnosticProviderSessionId = (scope: McpInvocationScope): string =>
  scope.providerSessionId ?? scope.sessionId;

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      sessionId: invocation.sessionId,
      providerSessionId: diagnosticProviderSessionId(invocation),
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
