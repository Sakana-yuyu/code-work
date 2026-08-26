import type { ProviderInstanceId } from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ByokAgentModelDriver, ByokAgentTool, ByokAgentLoopResult } from "./ByokAgentLoop.ts";
import { runByokAgentLoop } from "./ByokAgentLoop.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
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
  readonly signal?: AbortSignal | undefined;
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
>()("codework/composition/CompositionAgentService") {}

export interface CompositionAgentServiceOptions {
  readonly broker: ToolBroker.ToolBroker["Service"];
  readonly grantRegistry?: Pick<
    CapabilityGrantRegistry.CapabilityGrantRegistryShape,
    "issue" | "revoke"
  >;
  readonly resolveModelDriver: (input: {
    readonly providerInstanceId: string;
    readonly modelId: string;
    readonly signal?: AbortSignal | undefined;
  }) => Effect.Effect<ByokAgentModelDriver, CompositionAgentServiceError>;
}

const make = (options: CompositionAgentServiceOptions): CompositionAgentServiceShape => ({
  run: (input) =>
    Effect.gen(function* () {
      const model = yield* options.resolveModelDriver({
        providerInstanceId: input.providerInstanceId,
        modelId: input.modelId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const legacyCapabilityIds = input.capabilityGrantIds.filter(
        (grantId) => !grantId.startsWith("grant-"),
      );
      const issuedGrantIds =
        options.grantRegistry === undefined || legacyCapabilityIds.length === 0
          ? []
          : yield* options.grantRegistry
              .issue({
                taskId: input.taskId,
                agentId: input.agentId,
                capabilityIds: legacyCapabilityIds,
              })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new CompositionAgentServiceError({
                      code: "capability_grant_issue_failed",
                      detail: error.message,
                    }),
                ),
                Effect.map((grants) => grants.map((grant) => grant.grantId)),
              );
      const capabilityGrantIds =
        issuedGrantIds.length === 0
          ? input.capabilityGrantIds
          : [
              ...input.capabilityGrantIds.filter((grantId) => grantId.startsWith("grant-")),
              ...issuedGrantIds,
            ];
      return yield* runByokAgentLoop(
        {
          taskId: input.taskId,
          runId: input.runId,
          agentId: input.agentId,
          runtimeId: input.providerInstanceId,
          workspaceRoot: input.workspaceRoot,
          prompt: input.prompt,
          capabilityGrantIds,
          tools: input.tools,
          ...(input.maxRounds === undefined ? {} : { maxRounds: input.maxRounds }),
        },
        model,
        options.broker,
      ).pipe(
        Effect.ensuring(
          options.grantRegistry?.revoke === undefined || issuedGrantIds.length === 0
            ? Effect.void
            : Effect.forEach(issuedGrantIds, (grantId) =>
                options.grantRegistry!.revoke!({ grantId }).pipe(
                  Effect.catchTags({
                    CapabilityGrantNotFoundError: () => Effect.void,
                    CapabilityGrantPersistenceError: (error) =>
                      Effect.logError("Composition Agent 临时 capability grant 撤销失败", {
                        grantId,
                        error,
                      }),
                  }),
                ),
              ).pipe(Effect.asVoid),
        ),
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
  grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue" | "revoke">,
): CompositionAgentServiceShape =>
  make({
    broker,
    ...(grantRegistry === undefined ? {} : { grantRegistry }),
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
            : driver({
                modelId: input.modelId,
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              });
        }),
      ),
  });

const live = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const broker = yield* ToolBroker.ToolBroker;
  const grantRegistry = yield* Effect.serviceOption(
    CapabilityGrantRegistry.CapabilityGrantRegistry,
  );
  return makeCompositionAgentServiceFromRegistry(
    registry,
    broker,
    grantRegistry._tag === "Some" ? grantRegistry.value : undefined,
  );
});

export const layer = Layer.effect(CompositionAgentService, live);
