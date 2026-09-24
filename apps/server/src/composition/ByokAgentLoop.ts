import {
  COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES,
  COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS,
  COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES,
  COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS,
  type RuntimeMode,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ToolBroker from "./ToolBroker.ts";

export type ByokAgentTool = {
  readonly canonicalToolName: string;
  readonly description: string;
  readonly parameters: unknown;
};

export type ByokAgentToolCall = {
  readonly toolCallId: string;
  readonly canonicalToolName: string;
  readonly arguments: unknown;
};

export type ByokAgentMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      /** 本轮模型思考内容，回放时随 assistant 消息回传（保留式思考网关要求）。 */
      readonly reasoningContent?: string;
      /** Anthropic 思考块签名，回放 thinking 块时必须原样带回。 */
      readonly reasoningSignature?: string;
      readonly toolCalls?: ReadonlyArray<ByokAgentToolCall>;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly canonicalToolName: string;
      readonly content: string;
    };

export type ByokAgentModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "reasoning_delta"; readonly text: string }
  | { readonly type: "reasoning_signature"; readonly signature: string }
  | ({ readonly type: "tool_call" } & ByokAgentToolCall)
  | ({ readonly type: "model_completed" } & ByokAgentModelUsage);

export type ByokAgentModelUsage = {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number;
};

export class ByokAgentModelError extends Schema.TaggedErrorClass<ByokAgentModelError>()(
  "ByokAgentModelError",
  {
    code: Schema.String,
    detail: Schema.String,
    reason: Schema.optional(Schema.String),
    retryable: Schema.optional(Schema.Boolean),
    retryAfterMs: Schema.optional(Schema.Int),
  },
) {
  override get message(): string {
    return `BYOK agent model failed: ${this.code}: ${this.detail}`;
  }
}

export interface ByokAgentModelDriver {
  readonly complete: (input: {
    readonly messages: ReadonlyArray<ByokAgentMessage>;
    readonly tools: ReadonlyArray<ByokAgentTool>;
    readonly turn: number;
  }) => Stream.Stream<ByokAgentModelEvent, ByokAgentModelError>;
}

export class ByokAgentLoopTerminalEventMissingError extends Schema.TaggedErrorClass<ByokAgentLoopTerminalEventMissingError>()(
  "ByokAgentLoopTerminalEventMissingError",
  {},
) {
  override get message(): string {
    return "BYOK agent model stream ended without a terminal event.";
  }
}

export type ByokAgentTextCheckpoint = {
  readonly turn: number;
  readonly chunkIndex: number;
  readonly delta: string;
  readonly cumulativeUtf8Bytes: number;
};

export class ByokAgentLoopCheckpointError extends Schema.TaggedErrorClass<ByokAgentLoopCheckpointError>()(
  "ByokAgentLoopCheckpointError",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `BYOK agent checkpoint failed: ${this.code}: ${this.detail}`;
  }
}

export type ByokAgentLoopInput = {
  readonly protocol?: "openai" | "anthropic" | "gemini";
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runtimeId?: string;
  readonly threadId?: string;
  /** 由服务端会话提供，不能从模型工具参数读取。 */
  readonly runtimeMode?: RuntimeMode;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ByokAgentTool>;
  /** 兼容旧调用方；BYOK Loop 不再按模型轮数截断。 */
  readonly maxRounds?: number;
  /**
   * 按字符数计的上下文预算：预算内全量重放（prompt cache 前缀跨轮稳定），
   * 超过时整体裁剪一次、保留最近完整工具轮次。主线程按模型上下文窗口的
   * ~80% 传入；缺省时退回按条数的滑窗（子 agent 语义）。
   */
  readonly maxContextChars?: number;
  /** 包含初始用户消息；一个工具轮次按一条 assistant 消息加每个调用一条结果计算。 */
  readonly maxContextMessages?: number;
  /** 单条工具结果及参数纠错提示重新注入模型时允许的最大字符数。 */
  readonly maxToolResultChars?: number;
  /**
   * 每轮模型请求前取走待注入的用户引导（运行中不中断的追加输入）；返回的
   * 文本按序作为 user 消息并入本轮上下文。会话侧负责去重与落盘。
   */
  readonly takePendingUserMessages?: () => ReadonlyArray<string>;
  readonly onTextCheckpoint?: (
    checkpoint: ByokAgentTextCheckpoint,
  ) => Effect.Effect<void, ByokAgentLoopCheckpointError>;
  /** 思考流的增量检查点；不设置时思考内容仅用于上下文回放。 */
  readonly onReasoningCheckpoint?: (
    checkpoint: ByokAgentTextCheckpoint,
  ) => Effect.Effect<void, ByokAgentLoopCheckpointError>;
  /** 每个工具调用开始执行时回调一次，用于向用户展示工具活动。 */
  readonly onToolStarted?: (
    toolCall: ByokAgentToolCall,
    activityItemId: string,
  ) => Effect.Effect<void, ByokAgentLoopCheckpointError>;
  /** 将内部 ToolBroker 调用回写成统一的 Provider Runtime 活动。 */
  readonly onToolCompleted?: (
    toolCall: ByokAgentToolCall,
    result: ToolBroker.ToolBrokerResult,
    activityItemId: string,
  ) => Effect.Effect<void, ByokAgentLoopCheckpointError>;
  readonly onModelUsage?: (
    usage: ByokAgentModelUsage,
  ) => Effect.Effect<void, ByokAgentLoopCheckpointError>;
};

export type ByokAgentLoopResult = {
  readonly text: string;
  /** 最后一次模型调用使用的有界上下文，不作为完整执行审计记录。 */
  readonly messages: ReadonlyArray<ByokAgentMessage>;
  readonly rounds: number;
};

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_MAX_CONTEXT_MESSAGES = 17;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 12_000;
/** 字符预算触发裁剪后把历史压回到预算的这一比例，留出增长空间以摊薄裁剪频率。 */
const COMPACTION_RETAIN_RATIO = 0.5;
/**
 * 同一响应里视为只读、可在轮内并发执行的工具；其余工具可能互相依赖或
 * 修改状态（终端、写入、浏览器操控等），一律在屏障点保序串行。
 */
const CONCURRENT_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "workspace.read_file",
  "workspace.list_files",
  "workspace.search_files",
  "workspace.search_contents",
  "terminal.snapshot",
  "ssh.status",
  "ssh.list_files",
  "ssh.read_file",
  "git.status",
  "git.diff",
  "preview_status",
  "preview_snapshot",
  "skills.load",
]);
/** 只读批量的并发上限，避免同一批读把文件系统或上游打满。 */
const READ_ONLY_TOOL_CONCURRENCY = 4;
const OUTPUT_TRUNCATION_CONTINUATION_PROMPT =
  "Continue exactly where the previous response stopped. Do not repeat prior text.";
/** 断流后的同一模型轮次最多重连次数；普通错误不进入该路径。 */
const MAX_STREAM_DISCONNECT_RETRIES = 10;
const STREAM_DISCONNECT_RETRY_BASE_MS = 250;
const STREAM_DISCONNECT_RETRY_MAX_MS = 2_000;
const utf8Encoder = new TextEncoder();

const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.trunc(value)));

type ByokAgentToolRound = {
  readonly assistant: Extract<ByokAgentMessage, { readonly role: "assistant" }>;
  readonly toolMessages: ReadonlyArray<Extract<ByokAgentMessage, { readonly role: "tool" }>>;
};

/**
 * 把消息序列切成「完整工具轮次」：一条带 toolCalls 的 assistant 消息加上
 * 其全部连续 tool 结果。DeepSeek/Kimi 的保留式思考要求整轮 tool_calls 与
 * reasoning_content 同处一条 assistant 消息，因此一轮只产生一条 assistant
 * 消息；残缺轮次（工具结果未齐）与游离消息被丢弃。
 */
const collectToolRounds = (
  messages: ReadonlyArray<ByokAgentMessage>,
): ReadonlyArray<ByokAgentToolRound> => {
  const rounds: ByokAgentToolRound[] = [];
  let index = 1;
  while (index < messages.length) {
    const assistant = messages[index];
    if (assistant?.role !== "assistant" || assistant.toolCalls === undefined) {
      index += 1;
      continue;
    }
    const toolMessages: Array<Extract<ByokAgentMessage, { readonly role: "tool" }>> = [];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const tool = messages[cursor];
      if (
        tool?.role !== "tool" ||
        assistant.toolCalls.some((toolCall) => toolCall.toolCallId === tool.toolCallId) !== true
      ) {
        break;
      }
      toolMessages.push(tool);
      cursor += 1;
    }
    if (toolMessages.length === assistant.toolCalls.length) {
      rounds.push({ assistant, toolMessages });
    }
    index = cursor;
  }
  return rounds;
};

/**
 * 最后一个完整工具轮次结束后的下标：其后的游离 user 消息是运行中到达的
 * 引导（尚未参与任何工具轮次），压缩时必须原样保留，否则引导会被裁掉。
 */
const indexAfterLastToolRound = (messages: ReadonlyArray<ByokAgentMessage>): number => {
  const last = collectToolRounds(messages).at(-1);
  const lastTool = last?.toolMessages.at(-1);
  if (lastTool === undefined) return 1;
  return messages.lastIndexOf(lastTool) + 1;
};

const compactContextMessages = (
  messages: ReadonlyArray<ByokAgentMessage>,
  maxContextMessages: number,
): ByokAgentMessage[] => {
  const initial = messages[0];
  if (initial?.role !== "user") return [];

  // 从最新轮次向旧保留，直到预算装不下下一整轮；单调用轮次退化为
  // 旧的 floor((N-1)/2) 条容量，行为与拆分式回放完全一致。
  const budget = Math.max(1, maxContextMessages) - 1;
  const retained: ByokAgentMessage[] = [];
  let used = 0;
  const rounds = collectToolRounds(messages);
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined) continue;
    const size = 1 + round.toolMessages.length;
    if (used + size > budget) break;
    retained.unshift(round.assistant, ...round.toolMessages);
    used += size;
  }
  const trailing = messages.slice(indexAfterLastToolRound(messages));
  return [initial, ...retained, ...trailing];
};

/** 消息在请求里的近似字符开销：正文加思考回放与工具调用参数。 */
const messageChars = (message: ByokAgentMessage): number => {
  let size = message.content.length;
  if (message.role !== "assistant") return size;
  size += message.reasoningContent?.length ?? 0;
  for (const toolCall of message.toolCalls ?? []) {
    size += JSON.stringify(toolCall.arguments ?? {}).length + 64;
  }
  return size;
};

const historyChars = (messages: ReadonlyArray<ByokAgentMessage>): number =>
  messages.reduce((sum, message) => sum + messageChars(message), 0);

/**
 * 字符预算触发的整体裁剪：预算内原样返回，超过时保留初始消息与最近的
 * 完整工具轮次、压回预算的一半。与按条数滑窗不同，预算内不动历史——
 * 请求前缀跨轮稳定，prompt cache 能持续命中；裁剪只在逼近模型窗口上限
 * 时发生，之后前缀重新稳定，频率随窗口大小摊薄。
 */
const compactContextByChars = (
  messages: ReadonlyArray<ByokAgentMessage>,
  maxContextChars: number,
): ReadonlyArray<ByokAgentMessage> => {
  // 始终返回新数组：交给模型的数组是当轮快照，后续追加不得改写它。
  if (historyChars(messages) <= maxContextChars) return [...messages];
  const initial = messages[0];
  if (initial?.role !== "user") return [...messages];
  const retainChars = maxContextChars * COMPACTION_RETAIN_RATIO;
  const retained: ByokAgentMessage[] = [];
  let used = 0;
  const rounds = collectToolRounds(messages);
  for (let index = rounds.length - 1; index >= 0; index -= 1) {
    const round = rounds[index];
    if (round === undefined) continue;
    const size = historyChars([round.assistant, ...round.toolMessages]);
    // 最近一轮无条件保留：预算再小也不能让模型失去进行中的工作。
    if (retained.length > 0 && used + size > retainChars) break;
    retained.unshift(round.assistant, ...round.toolMessages);
    used += size;
  }
  const trailing = messages.slice(indexAfterLastToolRound(messages));
  return [initial, ...retained, ...trailing];
};

const contextOverflowRecoveryMessages = (
  messages: ReadonlyArray<ByokAgentMessage>,
): ByokAgentMessage[] => {
  const initial = messages[0];
  if (initial?.role !== "user") return [];

  const lastRound = collectToolRounds(messages).at(-1);
  return lastRound === undefined
    ? [initial]
    : [initial, lastRound.assistant, ...lastRound.toolMessages];
};

const truncatedToolResultContent = (
  fullContent: string,
  resultJson: string,
  maxToolResultChars: number,
): string => {
  const encodePreview = (previewChars: number): string =>
    encodeUnknownJson({
      status: "succeeded",
      truncated: true,
      truncationReason: "max_tool_result_chars",
      originalCharCount: fullContent.length,
      resultPreview: resultJson.slice(0, previewChars),
    });

  let low = 0;
  let high = resultJson.length;
  let bounded = encodePreview(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = encodePreview(middle);
    if (candidate.length <= maxToolResultChars) {
      bounded = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return bounded;
};

const toolResultContent = (
  result: ToolBroker.ToolBrokerResult,
  maxToolResultChars: number,
  input: Pick<ByokAgentLoopInput, "tools" | "workspaceRoot">,
): string => {
  if (result.status !== "succeeded") {
    const error = {
      status: result.status,
      errorCode: result.errorCode ?? "tool_failed",
    };
    if (result.errorCode === "tool_arguments_invalid") {
      const tool = input.tools.find((tool) => tool.canonicalToolName === result.canonicalToolName);
      if (tool !== undefined) {
        const feedback = encodeUnknownJson({
          ...error,
          parameters: tool.parameters,
          workspaceRoot: input.workspaceRoot,
          hint: "请按本轮工具签名修正参数；cwd（如有）必须等于 workspaceRoot。不要原样重复失败调用。",
        });
        if (feedback.length <= maxToolResultChars) return feedback;
      }
    }
    return encodeUnknownJson(error);
  }

  const fullContent = encodeUnknownJson({ status: result.status, result: result.result });
  if (fullContent.length <= maxToolResultChars) return fullContent;
  return truncatedToolResultContent(
    fullContent,
    encodeUnknownJson(result.result),
    maxToolResultChars,
  );
};

export const runByokAgentLoop = (
  input: ByokAgentLoopInput,
  model: ByokAgentModelDriver,
  broker: ToolBroker.ToolBroker["Service"],
): Effect.Effect<
  ByokAgentLoopResult,
  ByokAgentLoopTerminalEventMissingError | ByokAgentLoopCheckpointError | ByokAgentModelError
> =>
  Effect.gen(function* () {
    const maxContextMessages = boundedInteger(
      input.maxContextMessages,
      DEFAULT_MAX_CONTEXT_MESSAGES,
      COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES,
      COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES,
    );
    // 字符预算优先：设置时不再按条数滑窗，前缀稳定由预算内全量重放保证。
    const contextCharsBudget =
      input.maxContextChars !== undefined &&
      Number.isFinite(input.maxContextChars) &&
      input.maxContextChars >= 1
        ? Math.trunc(input.maxContextChars)
        : undefined;
    const maxToolResultChars = boundedInteger(
      input.maxToolResultChars,
      DEFAULT_MAX_TOOL_RESULT_CHARS,
      COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS,
      COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS,
    );
    const messages: ByokAgentMessage[] = [{ role: "user", content: input.prompt }];
    const usedActivityItemIds = new Set<string>();
    let text = "";
    let rounds = 0;
    let checkpointChunkIndex = 0;
    let cumulativeUtf8Bytes = 0;
    let reasoningChunkIndex = 0;
    let cumulativeReasoningUtf8Bytes = 0;
    let contextOverflowRecoveryUsed = false;
    let outputTruncationRecoveryUsed = false;

    while (true) {
      rounds += 1;
      const turnTextStart = text.length;

      // 运行中到达的用户引导在下一轮请求前并入上下文：不中断当前输出，
      // 模型据此自行判断是否调整方向。
      for (const steer of input.takePendingUserMessages?.() ?? []) {
        messages.push({ role: "user", content: steer });
      }

      const compactedMessages =
        contextCharsBudget === undefined
          ? compactContextMessages(messages, maxContextMessages)
          : compactContextByChars(messages, contextCharsBudget);
      messages.splice(0, messages.length, ...compactedMessages);
      let modelMessages: ReadonlyArray<ByokAgentMessage> = compactedMessages;
      const modelStartedAt = yield* Clock.currentTimeMillis;
      // 先完整收集模型流，再执行工具；溢出恢复不会重放已产生副作用的工具调用。
      const complete = (modelMessages: ReadonlyArray<ByokAgentMessage>) => {
        let sawOutput = false;
        let sawToolCall = false;
        const textStart = text.length;
        return model.complete({ messages: modelMessages, tools: input.tools, turn: rounds }).pipe(
          Stream.tap((event) =>
            Effect.gen(function* () {
              if (event.type === "tool_call") {
                sawOutput = true;
                sawToolCall = true;
                return;
              }
              if (event.type === "model_completed") {
                if (input.onModelUsage !== undefined) {
                  const modelCompletedAt = yield* Clock.currentTimeMillis;
                  yield* input.onModelUsage({
                    ...event,
                    durationMs: Math.max(0, modelCompletedAt - modelStartedAt),
                  });
                }
                return;
              }
              if (event.type === "reasoning_delta") {
                if (event.text.length === 0) return;
                cumulativeReasoningUtf8Bytes += utf8Encoder.encode(event.text).byteLength;
                const reasoningCheckpoint = {
                  turn: rounds,
                  chunkIndex: reasoningChunkIndex,
                  delta: event.text,
                  cumulativeUtf8Bytes: cumulativeReasoningUtf8Bytes,
                } satisfies ByokAgentTextCheckpoint;
                reasoningChunkIndex += 1;
                if (input.onReasoningCheckpoint !== undefined) {
                  yield* input.onReasoningCheckpoint(reasoningCheckpoint);
                }
                return;
              }
              if (event.type !== "text_delta" || event.text.length === 0) return;
              sawOutput = true;
              text += event.text;
              cumulativeUtf8Bytes += utf8Encoder.encode(event.text).byteLength;
              const checkpoint = {
                turn: rounds,
                chunkIndex: checkpointChunkIndex,
                delta: event.text,
                cumulativeUtf8Bytes,
              } satisfies ByokAgentTextCheckpoint;
              checkpointChunkIndex += 1;
              if (input.onTextCheckpoint !== undefined) {
                yield* input.onTextCheckpoint(checkpoint);
              }
            }),
          ),
          Stream.runCollect,
          Effect.map((events) => ({
            _tag: "succeeded" as const,
            events,
            sawOutput,
            sawToolCall,
            partialText: text.slice(textStart),
          })),
          Effect.catchTag("ByokAgentModelError", (error) =>
            Effect.succeed({
              _tag: "failed" as const,
              error,
              sawOutput,
              sawToolCall,
              partialText: text.slice(textStart),
            }),
          ),
        );
      };

      let streamDisconnectRetryCount = 0;
      let completion = yield* complete(modelMessages);
      while (completion._tag === "failed") {
        if (
          completion.error.code === "context_overflow" &&
          !contextOverflowRecoveryUsed &&
          !outputTruncationRecoveryUsed &&
          !completion.sawOutput
        ) {
          contextOverflowRecoveryUsed = true;
          modelMessages = contextOverflowRecoveryMessages(messages);
          messages.splice(0, messages.length, ...modelMessages);
          completion = yield* complete(modelMessages);
          continue;
        }
        if (
          completion.error.reason === "output_truncated" &&
          !outputTruncationRecoveryUsed &&
          completion.sawOutput &&
          !completion.sawToolCall &&
          completion.partialText.trim().length > 0
        ) {
          outputTruncationRecoveryUsed = true;
          modelMessages = [
            ...modelMessages,
            { role: "assistant", content: completion.partialText },
            { role: "user", content: OUTPUT_TRUNCATION_CONTINUATION_PROMPT },
          ];
          completion = yield* complete(modelMessages);
          continue;
        }
        const canceled =
          completion.error.reason === "canceled" || completion.error.code === "canceled";
        const terminalFailure =
          completion.error.code === "context_overflow" ||
          completion.error.reason === "output_truncated" ||
          completion.error.reason === "terminal_event_missing";
        if (
          completion.error.reason === "transport_error" &&
          !completion.sawOutput &&
          streamDisconnectRetryCount < MAX_STREAM_DISCONNECT_RETRIES &&
          !canceled &&
          !terminalFailure
        ) {
          streamDisconnectRetryCount += 1;
          yield* Effect.sleep(
            Duration.millis(
              Math.min(
                STREAM_DISCONNECT_RETRY_MAX_MS,
                STREAM_DISCONNECT_RETRY_BASE_MS * 2 ** (streamDisconnectRetryCount - 1),
              ),
            ),
          );
          completion = yield* complete(modelMessages);
          continue;
        }
        break;
      }
      if (completion._tag === "failed") {
        return yield* completion.error;
      }

      const events = completion.events;
      let terminal = false;
      let roundReasoning = "";
      let roundReasoningSignature = "";
      const roundToolCalls: ByokAgentToolCall[] = [];
      const roundToolCallIds = new Set<string>();
      const activityItemIds = new Map<string, string>();

      for (const event of events) {
        if (event.type === "reasoning_signature") {
          roundReasoningSignature = event.signature;
          continue;
        }
        if (event.type === "reasoning_delta") {
          roundReasoning += event.text;
          continue;
        }
        if (event.type === "text_delta") {
          continue;
        }
        if (event.type === "model_completed") {
          terminal = true;
          continue;
        }
        if (roundToolCallIds.has(event.toolCallId)) {
          continue;
        }
        roundToolCallIds.add(event.toolCallId);
        let activityItemId = event.toolCallId;
        if (usedActivityItemIds.has(activityItemId)) {
          activityItemId = `${event.toolCallId}:round:${rounds}`;
          let collision = 1;
          while (usedActivityItemIds.has(activityItemId)) {
            activityItemId = `${event.toolCallId}:round:${rounds}:${collision}`;
            collision += 1;
          }
        }
        usedActivityItemIds.add(activityItemId);
        activityItemIds.set(event.toolCallId, activityItemId);
        roundToolCalls.push({
          toolCallId: event.toolCallId,
          canonicalToolName: event.canonicalToolName,
          arguments: event.arguments,
        });
      }

      if (roundToolCalls.length > 0) {
        // 一轮模型响应对应一条 assistant 消息：保留式思考端点（DeepSeek/Kimi）
        // 要求带工具的请求把整轮 reasoning_content 与 tool_calls 一起回传，
        // 拆成多条消息会被逐条校验拒掉。
        messages.push({
          role: "assistant",
          content: text.slice(turnTextStart),
          ...(roundReasoning.length > 0 ? { reasoningContent: roundReasoning } : {}),
          ...(roundReasoning.length > 0 && roundReasoningSignature.length > 0
            ? { reasoningSignature: roundReasoningSignature }
            : {}),
          toolCalls: roundToolCalls,
        });
        // 相邻只读调用并为一批并发执行；带副作用的调用自成屏障，单独保序执行。
        const segments: Array<{
          readonly parallel: boolean;
          readonly calls: ByokAgentToolCall[];
        }> = [];
        for (const toolCall of roundToolCalls) {
          const parallel = CONCURRENT_READ_ONLY_TOOLS.has(toolCall.canonicalToolName);
          const last = segments.at(-1);
          if (parallel && last !== undefined && last.parallel) {
            last.calls.push(toolCall);
          } else {
            segments.push({ parallel, calls: [toolCall] });
          }
        }
        const invokeToolCall = (toolCall: ByokAgentToolCall) =>
          Effect.gen(function* () {
            const activityItemId = activityItemIds.get(toolCall.toolCallId) ?? toolCall.toolCallId;
            if (input.onToolStarted !== undefined) {
              yield* input.onToolStarted(toolCall, activityItemId);
            }
            const result = yield* broker.invoke({
              taskId: input.taskId,
              runId: input.runId,
              agentId: input.agentId,
              ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
              toolCallId: toolCall.toolCallId,
              canonicalToolName: toolCall.canonicalToolName,
              arguments: toolCall.arguments,
              idempotencyKey: `${input.runId}:${activityItemId}`,
              capabilityGrantIds: input.capabilityGrantIds,
              workspaceRoot: input.workspaceRoot,
            });
            if (input.onToolCompleted !== undefined) {
              yield* input.onToolCompleted(toolCall, result, activityItemId);
            }
            return [toolCall, result] as const;
          });
        for (const segment of segments) {
          const executed = yield* Effect.forEach(segment.calls, invokeToolCall, {
            concurrency: segment.parallel ? READ_ONLY_TOOL_CONCURRENCY : 1,
          });
          // 工具结果消息按原始调用顺序回填，保持与 assistant.toolCalls 对齐。
          for (const [toolCall, result] of executed) {
            messages.push({
              role: "tool",
              toolCallId: toolCall.toolCallId,
              canonicalToolName: toolCall.canonicalToolName,
              content: toolResultContent(result, maxToolResultChars, input),
            });
          }
        }
      }

      if (!terminal) {
        return yield* new ByokAgentLoopTerminalEventMissingError();
      }
      if (roundToolCalls.length === 0) {
        return { text, messages, rounds };
      }
    }
  });
