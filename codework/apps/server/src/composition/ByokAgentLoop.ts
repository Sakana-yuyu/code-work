import {
  COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES,
  COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS,
  COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES,
  COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS,
} from "@codework/contracts";
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
  | ({ readonly type: "tool_call" } & ByokAgentToolCall)
  | { readonly type: "model_completed" };

export class ByokAgentModelError extends Schema.TaggedErrorClass<ByokAgentModelError>()(
  "ByokAgentModelError",
  {
    code: Schema.String,
    detail: Schema.String,
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

export class ByokAgentLoopMaxRoundsError extends Schema.TaggedErrorClass<ByokAgentLoopMaxRoundsError>()(
  "ByokAgentLoopMaxRoundsError",
  {
    maxRounds: Schema.Int,
  },
) {
  override get message(): string {
    return `BYOK agent loop exceeded the maximum of ${this.maxRounds} model rounds.`;
  }
}

export class ByokAgentLoopTerminalEventMissingError extends Schema.TaggedErrorClass<ByokAgentLoopTerminalEventMissingError>()(
  "ByokAgentLoopTerminalEventMissingError",
  {},
) {
  override get message(): string {
    return "BYOK agent model stream ended without a terminal event.";
  }
}

export type ByokAgentLoopInput = {
  readonly protocol?: "openai" | "anthropic" | "gemini";
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly runtimeId?: string;
  readonly threadId?: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ByokAgentTool>;
  readonly maxRounds?: number;
  /** 包含初始用户消息；工具调用与结果按两条完整消息计算。 */
  readonly maxContextMessages?: number;
  /** 单条成功工具结果重新注入模型时允许的最大字符数。 */
  readonly maxToolResultChars?: number;
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

const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(min, Math.min(max, Math.trunc(value)));

const completeToolRound = (
  assistant: ByokAgentMessage | undefined,
  tool: ByokAgentMessage | undefined,
): readonly [ByokAgentMessage, ByokAgentMessage] | undefined => {
  if (assistant?.role !== "assistant" || tool?.role !== "tool") return undefined;
  if (assistant.toolCalls?.some((toolCall) => toolCall.toolCallId === tool.toolCallId) !== true) {
    return undefined;
  }
  return [assistant, tool];
};

const compactContextMessages = (
  messages: ReadonlyArray<ByokAgentMessage>,
  maxContextMessages: number,
): ByokAgentMessage[] => {
  const initial = messages[0];
  if (initial?.role !== "user") return [];

  const completeRounds: Array<readonly [ByokAgentMessage, ByokAgentMessage]> = [];
  for (let index = 1; index < messages.length; index += 2) {
    const round = completeToolRound(messages[index], messages[index + 1]);
    if (round !== undefined) completeRounds.push(round);
  }

  const roundCapacity = Math.max(0, Math.floor((Math.max(1, maxContextMessages) - 1) / 2));
  const retainedRounds = roundCapacity === 0 ? [] : completeRounds.slice(-roundCapacity);
  return [initial, ...retainedRounds.flat()];
};

const contextOverflowRecoveryMessages = (
  messages: ReadonlyArray<ByokAgentMessage>,
): ByokAgentMessage[] => {
  const initial = messages[0];
  if (initial?.role !== "user") return [];

  for (let index = messages.length - 2; index >= 1; index -= 1) {
    const round = completeToolRound(messages[index], messages[index + 1]);
    if (round !== undefined) return [initial, ...round];
  }
  return [initial];
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
): string => {
  if (result.status !== "succeeded") {
    return encodeUnknownJson({
      status: result.status,
      errorCode: result.errorCode ?? "tool_failed",
    });
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
  ByokAgentLoopMaxRoundsError | ByokAgentLoopTerminalEventMissingError | ByokAgentModelError
> =>
  Effect.gen(function* () {
    const maxRounds = input.maxRounds ?? 8;
    const maxContextMessages = boundedInteger(
      input.maxContextMessages,
      DEFAULT_MAX_CONTEXT_MESSAGES,
      COMPOSITION_AGENT_LOOP_MIN_CONTEXT_MESSAGES,
      COMPOSITION_AGENT_LOOP_MAX_CONTEXT_MESSAGES,
    );
    const maxToolResultChars = boundedInteger(
      input.maxToolResultChars,
      DEFAULT_MAX_TOOL_RESULT_CHARS,
      COMPOSITION_AGENT_LOOP_MIN_TOOL_RESULT_CHARS,
      COMPOSITION_AGENT_LOOP_MAX_TOOL_RESULT_CHARS,
    );
    const messages: ByokAgentMessage[] = [{ role: "user", content: input.prompt }];
    const seenToolCallIds = new Set<string>();
    let text = "";
    let rounds = 0;
    let contextOverflowRecoveryUsed = false;

    while (true) {
      rounds += 1;
      if (rounds > maxRounds) {
        return yield* new ByokAgentLoopMaxRoundsError({ maxRounds });
      }

      const compactedMessages = compactContextMessages(messages, maxContextMessages);
      messages.splice(0, messages.length, ...compactedMessages);
      // 先完整收集模型流，再执行工具；溢出恢复不会重放已产生副作用的工具调用。
      const complete = (modelMessages: ReadonlyArray<ByokAgentMessage>) =>
        model.complete({ messages: modelMessages, tools: input.tools, turn: rounds }).pipe(
          Stream.runCollect,
          Effect.map((events) => ({ _tag: "succeeded" as const, events })),
          Effect.catchTag("ByokAgentModelError", (error) =>
            Effect.succeed({ _tag: "failed" as const, error }),
          ),
        );

      let completion = yield* complete(compactedMessages);
      if (
        completion._tag === "failed" &&
        completion.error.code === "context_overflow" &&
        !contextOverflowRecoveryUsed
      ) {
        contextOverflowRecoveryUsed = true;
        const recoveryMessages = contextOverflowRecoveryMessages(messages);
        messages.splice(0, messages.length, ...recoveryMessages);
        completion = yield* complete(recoveryMessages);
      }
      if (completion._tag === "failed") {
        return yield* completion.error;
      }

      const events = completion.events;
      let terminal = false;
      let acceptedToolCall = false;

      for (const event of events) {
        if (event.type === "text_delta") {
          text += event.text;
          continue;
        }
        if (event.type === "model_completed") {
          terminal = true;
          continue;
        }
        if (seenToolCallIds.has(event.toolCallId)) {
          continue;
        }

        seenToolCallIds.add(event.toolCallId);
        acceptedToolCall = true;
        messages.push({
          role: "assistant",
          content: "",
          toolCalls: [
            {
              toolCallId: event.toolCallId,
              canonicalToolName: event.canonicalToolName,
              arguments: event.arguments,
            },
          ],
        });

        const result = yield* broker.invoke({
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          ...(input.runtimeId === undefined ? {} : { runtimeId: input.runtimeId }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          toolCallId: event.toolCallId,
          canonicalToolName: event.canonicalToolName,
          arguments: event.arguments,
          idempotencyKey: `${input.runId}:${event.toolCallId}`,
          capabilityGrantIds: input.capabilityGrantIds,
          workspaceRoot: input.workspaceRoot,
        });
        messages.push({
          role: "tool",
          toolCallId: event.toolCallId,
          canonicalToolName: event.canonicalToolName,
          content: toolResultContent(result, maxToolResultChars),
        });
      }

      if (!terminal) {
        return yield* new ByokAgentLoopTerminalEventMissingError();
      }
      if (!acceptedToolCall) {
        return { text, messages, rounds };
      }
    }
  });
