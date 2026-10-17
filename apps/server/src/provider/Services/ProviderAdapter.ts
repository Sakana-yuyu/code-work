/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  CompositionRuntimeCapabilityHandshakeRequest,
  CompositionRuntimeCapabilityHandshakeResult,
  McpAppCallToolResult,
  McpAppReadResourceResult,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
  RuntimeMode,
  TurnId,
} from "@codework/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderAdapterError, ProviderAdapterRequestError } from "../Errors.ts";

/**
 * A tool as one MCP server declares it (ext-apps spec 2026-01-26). The host
 * sends `tool` verbatim as `toolInfo`; `annotations`/`_meta` drive the
 * read-only and app-visibility gates.
 */
export interface ProviderAdapterMcpTool {
  readonly name: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: unknown;
  readonly _meta?: unknown;
}

/**
 * The MCP client surface a live provider session exposes for MCP App bridge
 * requests: every call rides the session's own connection and credentials and
 * reaches only the named server. A stopped session never restarts for an app.
 */
export interface ProviderAdapterMcpApps {
  readonly listTools: (input: {
    readonly server: string;
  }) => Effect.Effect<ReadonlyArray<ProviderAdapterMcpTool>, ProviderAdapterError>;
  readonly callTool: (input: {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Record<string, unknown>;
  }) => Effect.Effect<McpAppCallToolResult, ProviderAdapterError>;
  readonly readResource: (input: {
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<McpAppReadResourceResult, ProviderAdapterError>;
}

export type ProviderToolBrokerContext = {
  /** 仅由服务端会话配置绑定，不接受 Provider 工具参数声明。 */
  readonly runtimeMode?: RuntimeMode;
  readonly runtimeId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly capabilityHandshakeId: string;
  readonly threadId: ThreadId;
};

export type ProviderToolBrokerInvocation = {
  readonly toolCallId: string;
  readonly canonicalToolName: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
};

export type ProviderToolBrokerCancellation = Pick<
  ProviderToolBrokerInvocation,
  "toolCallId" | "canonicalToolName" | "idempotencyKey"
>;

export type ProviderToolBrokerResult = {
  readonly status: "succeeded" | "denied" | "failed" | "cancelled";
  readonly result?: unknown;
  readonly errorCode?: string | undefined;
};

export type ProviderToolBrokerBridge = {
  readonly invoke: (
    input: ProviderToolBrokerInvocation,
    requestApproval?: ProviderToolBrokerApprovalHandler,
  ) => Effect.Effect<ProviderToolBrokerResult>;
  readonly cancel: (input: ProviderToolBrokerCancellation) => Effect.Effect<void>;
};

/** 仅在服务端回调中等待现有审批入口，外部工具参数不能提供处理器。 */
export type ProviderToolBrokerApprovalHandler = (
  approvalRequestId: string,
) => Effect.Effect<ProviderApprovalDecision, ProviderAdapterRequestError>;

// "in-session" applies the model on the live session, "restart-continue"
// restarts the provider session but continues the conversation through its
// resume cursor, "unsupported" restarts into a fresh conversation.
export type ProviderSessionModelSwitchMode = "in-session" | "restart-continue" | "unsupported";

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** 只有真正恢复模型对话上下文的实现才能声明；未声明时拒绝回退。 */
  readonly threadRollback?: boolean;
  /** 只有真实注册宿主工具回调的 Adapter 才能声明这些 canonical tools。 */
  readonly toolBrokerCanonicalTools?: ReadonlyArray<string>;
  /** Emits incremental assistant `content.delta` events during a turn. */
  readonly streaming?: boolean;
  /** Emits reasoning deltas (`reasoning_text` / `reasoning_summary_text`). */
  readonly reasoningStream?: boolean;
  /** Session injects the Code Work-managed MCP bridge (McpProviderSession). */
  readonly mcp?: boolean;
  /** Session state survives restarts through a resumeCursor. */
  readonly persistence?: boolean;
  /**
   * A `sendTurn` while a turn is running delivers the input into the live
   * turn (provider-side queue or fold-in). Without it the orchestrator holds
   * queued turn starts until the turn ends; an explicit steer then falls back
   * to interrupt-then-replace instead of being dropped or retried.
   */
  readonly steer?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  readonly configureToolBroker?: (input: {
    readonly threadId: ThreadId;
    readonly bridge: ProviderToolBrokerBridge;
    readonly context: ProviderToolBrokerContext;
  }) => Effect.Effect<void, TError>;

  readonly clearToolBroker?: (threadId: ThreadId) => Effect.Effect<void, TError>;

  readonly handshakeCapabilities?: (
    input: CompositionRuntimeCapabilityHandshakeRequest,
  ) => Effect.Effect<CompositionRuntimeCapabilityHandshakeResult, TError>;

  readonly revokeCapabilityHandshake?: (input: {
    readonly handshakeId: string;
  }) => Effect.Effect<void, TError>;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session. Resolves only after the provider process has
   * fully exited — callers use that guarantee to order restarts, reverts,
   * and instance switches so nothing can still write session files
   * afterwards. A fire-and-forget signal does not satisfy the contract.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * The live session's MCP Apps surface (ext-apps spec 2026-01-26), for
   * `McpAppRequests` to resolve bridge calls through. Undefined both when the
   * provider does not implement MCP Apps and when the thread has no live
   * session — never starts one.
   */
  readonly mcpApps?: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderAdapterMcpApps | undefined, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
