import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ByokAgentModelDriver, ByokAgentTool, ByokAgentLoopResult } from "./ByokAgentLoop.ts";
import { runByokAgentLoop } from "./ByokAgentLoop.ts";
import * as ToolBroker from "./ToolBroker.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

export type CompositionAgentServiceInput = {
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly capabilityGrantIds: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<ByokAgentTool>;
  readonly maxRounds?: number | undefined;
};

export class CompositionAgentServiceError extends Schema.TaggedErrorClass<CompositionAgentServiceError>()(
  "CompositionAgentServiceError",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `组合 Agent 服务失败：${this.code}: ${this.detail}`;
  }
}

export interface CompositionAgentServiceShape {
  readonly run: (
    input: CompositionAgentServiceInput,
  ) => Effect.Effect<ByokAgentLoopResult, CompositionAgentServiceError>;
}

export class CompositionAgentService extends Context.Service<
  CompositionAgentService,
  CompositionAgentServiceShape
>()("t3/composition/CompositionAgentService") {}

export interface CompositionAgentServiceOptions {
  readonly broker: ToolBroker.ToolBroker["Service"];
  readonly resolveModelDriver: (input: {
    readonly providerInstanceId: string;
    readonly modelId: string;
  }) => Effect.Effect<ByokAgentModelDriver, CompositionAgentServiceError>;
}

const make = (options: CompositionAgentServiceOptions): CompositionAgentServiceShape => ({
  run: (input) =>
    Effect.gen(function* () {
      const model = yield* options.resolveModelDriver({
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
      });
      return yield* runByokAgentLoop(
        {
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          workspaceRoot: input.workspaceRoot,
          prompt: input.prompt,
          capabilityGrantIds: input.capabilityGrantIds,
          tools: input.tools,
          ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
        },
        model,
        options.broker,
      ).pipe(
        Effect.mapError(
          (error) =>
            new CompositionAgentServiceError({
              code: error._tag,
              detail: error.message,
            }),
        ),
      );
    }),
});

export const makeCompositionAgentService = (
  options: CompositionAgentServiceOptions,
): CompositionAgentServiceShape => make(options);

export const makeCompositionAgentServiceFromRegistry = (
  registry: ProviderInstanceRegistry["Service"],
  broker: ToolBroker.ToolBroker["Service"],
): CompositionAgentServiceShape =>
  make({
    broker,
    resolveModelDriver: (input) =>
      registry.getInstance(input.providerInstanceId as ProviderInstanceId).pipe(
        Effect.flatMap((instance) => {
          const driver = instance?.composition?.resolveModelDriver;
          return driver === undefined
            ? Effect.fail(
                new CompositionAgentServiceError({
                  code: "provider_composition_unavailable",
                  detail: `Provider instance '${input.providerInstanceId}' has no composition model driver.`,
                }),
              )
            : driver({ modelId: input.modelId });
        }),
      ),
  });

const live = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const broker = yield* ToolBroker.ToolBroker;
  return makeCompositionAgentServiceFromRegistry(registry, broker);
});

export const layer = Layer.effect(CompositionAgentService, live);
