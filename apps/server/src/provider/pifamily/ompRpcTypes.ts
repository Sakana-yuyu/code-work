/**
 * OhMyPi (omp) CLI 的 `--mode rpc-ui` JSONL 协议类型。
 *
 * 与 Pi 同族 wire 格式（`{type,id}` 请求 / `{type:"response"}` 应答 / 其余为
 * 事件），但语义是独立超集，必须与 Pi 分开解析：
 *  - 协议 v2：`ready` 帧声明 chunked 能力后需 `negotiate_protocol` 确认；
 *  - host tools：客户端 `set_host_tools` 注册工具，omp 发 `host_tool_call` /
 *    `host_tool_cancel` 请求客户端执行，客户端回 `host_tool_result` / `host_tool_update`；
 *  - 审批：`--approval-mode yolo|write|always-ask` 管控内置工具，
 *    `extension_ui_request` 承载 Approve/Deny 与问答；
 *  - 子代理 / todo / goal / notice / auto-retry 等事件 Pi 均没有。
 *
 * @module provider/pifamily/ompRpcTypes
 */

import type {
  PiAgentMessage,
  PiImageContent,
  PiModel,
  PiSessionStats,
  PiThinkingLevel,
} from "./piRpcTypes.ts";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";

export interface OmpReadyFrame {
  readonly type: "ready";
  readonly protocolVersion?: number;
  readonly supportedProtocolVersions?: ReadonlyArray<number>;
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
}

export interface OmpNegotiateProtocolResponse {
  readonly protocolVersion?: number;
}

// ── host tools（客户端侧工具执行，Code Work ToolBroker 的接入点）──

export interface OmpHostToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly loadMode?: "essential" | "discoverable";
  readonly parameters: Record<string, unknown>;
  readonly label?: string;
  readonly hidden?: boolean;
}

export interface OmpHostToolCallRequest {
  readonly type: "host_tool_call";
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface OmpHostToolCancelRequest {
  readonly type: "host_tool_cancel";
  readonly id: string;
  readonly targetId: string;
}

export interface OmpAgentToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface OmpHostToolResult {
  readonly type: "host_tool_result";
  readonly id: string;
  readonly result: OmpAgentToolResult;
  readonly isError?: boolean;
}

export interface OmpHostToolUpdate {
  readonly type: "host_tool_update";
  readonly id: string;
  readonly partialResult: OmpAgentToolResult;
}

// ── 子代理 ──

export type OmpSubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface OmpSubagentLifecycleEvent {
  readonly type: "subagent_lifecycle";
  readonly payload: {
    readonly id: string;
    readonly agent: string;
    readonly agentSource?: string;
    readonly description?: string;
    readonly status: "started" | "completed" | "failed" | "aborted";
    readonly sessionFile?: string;
    readonly parentToolCallId?: string;
    readonly index: number;
    readonly detached?: boolean;
  };
}

export interface OmpSubagentProgressEvent {
  readonly type: "subagent_progress";
  readonly payload: {
    readonly index: number;
    readonly agent: string;
    readonly task: string;
    readonly parentToolCallId?: string;
    readonly progress: {
      readonly id: string;
      readonly status: OmpSubagentStatus;
      readonly description?: string;
      readonly currentTool?: unknown;
      readonly resolvedModel?: string;
    };
  };
}

// ── 会话事件（Pi 族公共部分 + OMP 扩展）──

export type OmpAgentSessionEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "turn_start" }
  | { readonly type: "message_start"; readonly message: PiAgentMessage }
  | { readonly type: "message_end"; readonly message: PiAgentMessage }
  | {
      readonly type: "message_update";
      readonly message?: PiAgentMessage;
      readonly assistantMessageEvent:
        | { readonly type: "text_delta"; readonly delta?: string }
        | { readonly type: "thinking_delta"; readonly delta?: string }
        | {
            readonly type:
              | "start"
              | "text_start"
              | "text_end"
              | "thinking_start"
              | "thinking_end"
              | "done";
          };
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
      readonly partialResult: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: unknown;
      readonly isError?: boolean;
    }
  | { readonly type: "compaction_start"; readonly reason?: string }
  | {
      readonly type: "compaction_end";
      readonly reason?: string;
      readonly errorMessage?: string;
      readonly aborted?: boolean;
    }
  | { readonly type: "agent_end"; readonly messages?: ReadonlyArray<PiAgentMessage> }
  | {
      readonly type: "auto_retry_start";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    }
  | {
      readonly type: "auto_retry_end";
      readonly success: boolean;
      readonly attempt: number;
      readonly finalError?: string;
    }
  | { readonly type: "auto_compaction_start"; readonly reason: string; readonly action: string }
  | {
      readonly type: "auto_compaction_end";
      readonly action?: string;
      readonly result?: unknown;
      readonly aborted: boolean;
      readonly willRetry: boolean;
      readonly errorMessage?: string;
    };

export interface OmpTodoItem {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface OmpTodoReminderEvent {
  readonly type: "todo_reminder";
  readonly todos: ReadonlyArray<OmpTodoItem>;
}

export interface OmpNoticeEvent {
  readonly type: "notice";
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly source?: string;
}

export interface OmpGoal {
  readonly id?: string;
  readonly objective?: string;
  readonly status?: string;
}

export interface OmpGoalUpdatedEvent {
  readonly type: "goal_updated";
  readonly goal?: OmpGoal | null;
  readonly state?: { readonly enabled?: boolean; readonly mode?: string; readonly reason?: string };
}

export interface OmpExtensionUiRequestEvent {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
  readonly options?: ReadonlyArray<string>;
  readonly placeholder?: string;
  readonly url?: string;
  readonly launchUrl?: string;
  readonly instructions?: string;
  [key: string]: unknown;
}

export type OmpRuntimeEvent =
  | OmpAgentSessionEvent
  | OmpExtensionUiRequestEvent
  | OmpHostToolCallRequest
  | OmpHostToolCancelRequest
  | OmpSubagentLifecycleEvent
  | OmpSubagentProgressEvent
  | OmpTodoReminderEvent
  | OmpNoticeEvent
  | OmpGoalUpdatedEvent
  | { readonly type: "command_output"; readonly text?: string }
  | { readonly type: "prompt_result"; readonly id?: string; readonly agentInvoked?: boolean }
  | { readonly type: "process_exit"; readonly error: string };

/** 客户端 → omp 的命令帧（id 由 JsonlRpcProcess 注入）。 */
export type OmpRpcCommand =
  | { readonly type: "negotiate_protocol"; readonly protocolVersion: number }
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
    }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "set_auto_compaction"; readonly enabled: boolean }
  | { readonly type: "abort" }
  | { readonly type: "get_state" }
  | { readonly type: "get_messages" }
  | { readonly type: "get_available_models" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly type: "get_session_stats" }
  | { readonly type: "get_available_commands" }
  | { readonly type: "set_host_tools"; readonly tools: ReadonlyArray<OmpHostToolDefinition> }
  | { readonly type: "set_subagent_subscription"; readonly level: "off" | "progress" | "events" };

export interface OmpSessionState {
  readonly model?: PiModel | null;
  readonly thinkingLevel?: PiThinkingLevel;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled?: boolean;
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly messageCount: number;
  readonly queuedMessageCount?: number;
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly contextWindow?: number | null;
    readonly percent?: number | null;
  };
}

export type { PiAgentMessage, PiImageContent, PiModel, PiSessionStats, PiThinkingLevel };

export function isOmpHostToolCallRequest(frame: unknown): frame is OmpHostToolCallRequest {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as Record<string, unknown>).type === "host_tool_call" &&
    typeof (frame as Record<string, unknown>).id === "string" &&
    typeof (frame as Record<string, unknown>).toolName === "string"
  );
}

export function isOmpHostToolCancelRequest(frame: unknown): frame is OmpHostToolCancelRequest {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as Record<string, unknown>).type === "host_tool_cancel" &&
    typeof (frame as Record<string, unknown>).targetId === "string"
  );
}
