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
  | { readonly role: "tool"; readonly toolCallId: string; readonly content: string };

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

export class ByokAgentLoopUnsupportedError extends Schema.TaggedErrorClass<ByokAgentLoopUnsupportedError>()(
  "ByokAgentLoopUnsupportedError",
  {
    protocol: Schema.String,
  },
) {
  override get message(): string {
    return `BYOK agent loop is unsupported for protocol '${this.protocol}'.`;
  }
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
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ByokAgentTool>;
  readonly maxRounds?: number;
};

export type ByokAgentLoopResult = {
  readonly text: string;
  readonly messages: ReadonlyArray<ByokAgentMessage>;
  readonly rounds: number;
};

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const toolResultContent = (result: ToolBroker.ToolBrokerResult): string =>
  encodeUnknownJson(
    result.status === "succeeded"
      ? { status: result.status, result: result.result }
      : { status: result.status, errorCode: result.errorCode ?? "tool_failed" },
  );

export const runByokAgentLoop = (
  input: ByokAgentLoopInput,
  model: ByokAgentModelDriver,
  broker: ToolBroker.ToolBroker["Service"],
): Effect.Effect<
  ByokAgentLoopResult,
  | ByokAgentLoopUnsupportedError
  | ByokAgentLoopMaxRoundsError
  | ByokAgentLoopTerminalEventMissingError
  | ByokAgentModelError
> =>
  Effect.gen(function* () {
    if (input.protocol !== undefined && input.protocol !== "openai") {
      return yield* new ByokAgentLoopUnsupportedError({ protocol: input.protocol });
    }

    const maxRounds = input.maxRounds ?? 8;
    const messages: ByokAgentMessage[] = [{ role: "user", content: input.prompt }];
    const seenToolCallIds = new Set<string>();
    let text = "";
    let rounds = 0;

    while (true) {
      rounds += 1;
      if (rounds > maxRounds) {
        return yield* new ByokAgentLoopMaxRoundsError({ maxRounds });
      }

      const events = yield* model
        .complete({ messages, tools: input.tools, turn: rounds })
        .pipe(Stream.runCollect);
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
          content: toolResultContent(result),
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
