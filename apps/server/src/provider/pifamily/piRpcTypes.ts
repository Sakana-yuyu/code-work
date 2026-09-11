/**
 * Pi CLI 的 `--mode rpc` JSONL 协议类型。
 *
 * 依据 pi-mono 的 RPC 契约（Paseo origin/main 2026-09-10 参考实现核对）：
 * 请求带自增 `id`，响应 `{type:"response", id, success, data, error}`，
 * 其余 JSON 帧全部是事件通知。协议允许版本漂移，因此事件联合保留
 * `{type: string}` 兜底——未识别帧丢弃并计数，不中断会话。
 *
 * @module provider/pifamily/piRpcTypes
 */

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface PiThinkingContent {
  readonly type: "thinking";
  readonly thinking: string;
}

export interface PiToolCallContent {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCallContent;

export type PiAgentMessage =
  | { readonly role: "user"; readonly content: string | ReadonlyArray<unknown> }
  | { readonly role: "custom"; readonly content: string | ReadonlyArray<unknown> }
  | {
      readonly role: "assistant";
      readonly content: ReadonlyArray<PiAssistantContent>;
      readonly provider?: string;
      readonly model?: string;
      readonly responseId?: string;
      readonly responseModel?: string;
      readonly errorMessage?: string | null;
      readonly stopReason?: string;
      readonly usage?: {
        readonly input?: number;
        readonly output?: number;
        readonly cacheRead?: number;
        readonly cacheWrite?: number;
        readonly total?: number;
      };
    }
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: unknown;
      readonly isError?: boolean;
    }
  | {
      readonly role: "bashExecution";
      readonly command: string;
      readonly output?: string;
      readonly exitCode?: number | null;
      readonly cancelled?: boolean;
    };

export interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly api?: string;
  readonly baseUrl?: string;
  readonly input?: ReadonlyArray<string>;
}

export interface PiSessionState {
  readonly model?: PiModel | null;
  readonly thinkingLevel: PiThinkingLevel;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled?: boolean;
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly contextWindow?: number | null;
    readonly percent?: number | null;
  };
}

export interface PiSessionStats {
  readonly tokens?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
    readonly total?: number;
  };
  readonly cost?: number;
  readonly contextUsage?: {
    readonly tokens?: number | null;
    readonly contextWindow?: number | null;
    readonly percent?: number | null;
  };
}

/** 客户端 → Pi 的命令帧（id 由 JsonlRpcProcess 注入）。 */
export type PiRpcCommand =
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
    }
  | {
      readonly type: "steer";
      readonly message: string;
      readonly images?: ReadonlyArray<PiImageContent>;
    }
  | { readonly type: "clear_queue" }
  | { readonly type: "compact"; readonly customInstructions?: string }
  | { readonly type: "set_auto_compaction"; readonly enabled: boolean }
  | { readonly type: "abort" }
  | { readonly type: "get_state" }
  | { readonly type: "get_messages" }
  | { readonly type: "get_available_models" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: PiThinkingLevel }
  | { readonly type: "get_session_stats" }
  | { readonly type: "get_commands" };

export interface PiRpcResponse {
  readonly type: "response";
  readonly id?: string;
  readonly command?: string;
  readonly success?: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiPromptAck {
  readonly requestId?: string;
  readonly agentInvoked?: boolean;
}

export type PiAssistantMessageEvent =
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

export type PiAgentSessionEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "turn_start" }
  | { readonly type: "message_start"; readonly message: PiAgentMessage }
  | { readonly type: "message_end"; readonly message: PiAgentMessage }
  | {
      readonly type: "message_update";
      readonly message?: PiAgentMessage;
      readonly assistantMessageEvent: PiAssistantMessageEvent;
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
  | {
      readonly type: "compaction_start";
      readonly reason?: "manual" | "threshold" | "overflow" | string;
    }
  | {
      readonly type: "compaction_end";
      readonly reason?: string;
      readonly errorMessage?: string;
      readonly aborted?: boolean;
    }
  | {
      readonly type: "agent_end";
      readonly messages?: ReadonlyArray<PiAgentMessage>;
      readonly willRetry?: boolean;
    }
  | { readonly type: "agent_settled" }
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
    };

/** rpc-ui 模式下的宿主 UI 请求（select/input/confirm/editor 等）。 */
export interface PiExtensionUiRequestEvent {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
  readonly options?: ReadonlyArray<string>;
  readonly placeholder?: string;
  readonly notifyType?: string;
  [key: string]: unknown;
}

export type PiRuntimeEvent =
  | PiAgentSessionEvent
  | PiExtensionUiRequestEvent
  | { readonly type: "command_output"; readonly text?: string }
  | { readonly type: "prompt_result"; readonly id?: string; readonly agentInvoked?: boolean }
  | { readonly type: "process_exit"; readonly error: string };

export type PiExtensionUiResponse = {
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: boolean;
};

/** 判别辅助：response 帧走请求关联，其余都当事件。 */
export function isPiRpcResponse(frame: unknown): frame is PiRpcResponse {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as Record<string, unknown>).type === "response"
  );
}
