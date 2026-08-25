import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ToolBroker from "./ToolBroker.ts";
import {
  ByokAgentLoopMaxRoundsError,
  ByokAgentLoopUnsupportedError,
  runByokAgentLoop,
  type ByokAgentModelDriver,
} from "./ByokAgentLoop.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeResult = (input: ToolBroker.ToolBrokerInput): ToolBroker.ToolBrokerResult => ({
  invocationId: `invocation-${input.idempotencyKey}`,
  taskId: input.taskId,
  runId: input.runId,
  toolCallId: input.toolCallId,
  canonicalToolName: input.canonicalToolName,
  status: "succeeded",
  result: { contents: "workspace result" },
  startedAtUnixMs: 1,
  finishedAtUnixMs: 2,
});

const baseInput = {
  taskId: "task-1",
  runId: "run-1",
  agentId: "agent-1",
  workspaceRoot: "C:/workspace",
  prompt: "inspect the workspace",
  capabilityGrantIds: ["t3.workspace.read_file"],
  tools: [
    {
      canonicalToolName: "workspace.read_file",
      description: "Read a text file",
      parameters: { type: "object" },
    },
  ],
};

describe("ByokAgentLoop", () => {
  it("executes one tool call, deduplicates its terminal replay, reinjects the result, and continues", async () => {
    const modelInputs: Array<Parameters<ByokAgentModelDriver["complete"]>[0]> = [];
    let brokerCalls = 0;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) =>
        Effect.sync(() => {
          brokerCalls += 1;
          return makeResult(input);
        }),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        modelInputs.push(input);
        return modelInputs.length === 1
          ? Stream.fromIterable([
              {
                type: "tool_call" as const,
                toolCallId: "call-1",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              },
              {
                type: "tool_call" as const,
                toolCallId: "call-1",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: "C:/workspace", relativePath: "README.md" },
              },
              { type: "model_completed" as const },
            ])
          : Stream.fromIterable([
              { type: "text_delta" as const, text: "done" },
              { type: "model_completed" as const },
            ]);
      },
    };

    const result = await Effect.runPromise(runByokAgentLoop(baseInput, model, broker));

    expect(result.text).toBe("done");
    expect(result.rounds).toBe(2);
    expect(brokerCalls).toBe(1);
    expect(modelInputs[1]?.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", toolCallId: "call-1" })]),
    );
  });

  it("reinjects a denied or failed broker result as an error tool message", async () => {
    let secondInput: Parameters<ByokAgentModelDriver["complete"]>[0] | undefined;
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) =>
        Effect.succeed({
          ...makeResult(input),
          status: "denied" as const,
          result: undefined,
          errorCode: "tool_approval_required",
        }),
      cancel: () => Effect.void,
    });
    const model: ByokAgentModelDriver = {
      complete: (input) => {
        if (input.turn === 2) {
          secondInput = input;
          return Stream.fromIterable([
            { type: "text_delta" as const, text: "approval needed" },
            { type: "model_completed" as const },
          ]);
        }
        return Stream.fromIterable([
          {
            type: "tool_call" as const,
            toolCallId: "call-denied",
            canonicalToolName: "workspace.write_file",
            arguments: { cwd: "C:/workspace", relativePath: "x.txt", contents: "x" },
          },
          { type: "model_completed" as const },
        ]);
      },
    };

    const result = await Effect.runPromise(
      runByokAgentLoop(
        {
          ...baseInput,
          capabilityGrantIds: ["t3.workspace.write_file"],
          tools: [
            {
              canonicalToolName: "workspace.write_file",
              description: "Write a text file",
              parameters: { type: "object" },
            },
          ],
        },
        model,
        broker,
      ),
    );

    expect(result.text).toBe("approval needed");
    expect(secondInput?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          content: encodeUnknownJson({
            status: "denied",
            errorCode: "tool_approval_required",
          }),
        }),
      ]),
    );
  });

  it("rejects unsupported BYOK agent-loop protocols explicitly", async () => {
    await expect(
      Effect.runPromise(
        runByokAgentLoop(
          { ...baseInput, protocol: "anthropic" },
          { complete: () => Stream.empty },
          ToolBroker.ToolBroker.of({
            invoke: () => Effect.die("unused"),
            cancel: () => Effect.void,
          }),
        ),
      ),
    ).rejects.toBeInstanceOf(ByokAgentLoopUnsupportedError);
  });

  it("stops before an unbounded model/tool loop", async () => {
    const model: ByokAgentModelDriver = {
      complete: (input) =>
        Stream.fromIterable([
          {
            type: "tool_call" as const,
            toolCallId: `call-loop-${input.turn}`,
            canonicalToolName: "workspace.read_file",
            arguments: { cwd: "C:/workspace", relativePath: "README.md" },
          },
          { type: "model_completed" as const },
        ]),
    };
    const broker = ToolBroker.ToolBroker.of({
      invoke: (input) => Effect.succeed(makeResult(input)),
      cancel: () => Effect.void,
    });

    await expect(
      Effect.runPromise(runByokAgentLoop({ ...baseInput, maxRounds: 2 }, model, broker)),
    ).rejects.toBeInstanceOf(ByokAgentLoopMaxRoundsError);
  });
});
