import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CapabilityPolicy from "./CapabilityPolicy.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import { makeCompositionAgentService } from "./CompositionAgentService.ts";
import { makeCompositionByokAgentDriver } from "./CompositionByokAgentDriver.ts";
import { makeCompositionProviderAgentDriver } from "./CompositionProviderAgentDriver.ts";
import { makeCompositionRuntimeToolBridge } from "./CompositionRuntimeToolBridge.ts";
import type { CompositionProviderSessionAdapter } from "./CompositionProviderAgentDriver.ts";
import * as ToolBroker from "./ToolBroker.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CompositionTaskStore } from "../persistence/Services/CompositionTaskStore.ts";
import { CompositionTaskStoreLive } from "../persistence/Layers/CompositionTaskStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const capabilityRegistry = CapabilityRegistry.makeCompositionCapabilityRegistry();
const capabilityPolicy = CapabilityPolicy.makeCompositionCapabilityPolicy({
  capabilityRegistry,
});
const CapabilityRegistryLayer = Layer.succeed(
  CapabilityRegistry.CapabilityRegistry,
  capabilityRegistry,
);
const CapabilityPolicyLayer = Layer.succeed(CapabilityPolicy.CapabilityPolicy, capabilityPolicy);
const WorkspaceFileLayer = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer))),
);
const TestLayer = Layer.mergeAll(
  ToolBroker.layer.pipe(
    Layer.provide(CapabilityPolicyLayer),
    Layer.provide(CapabilityRegistryLayer),
    Layer.provide(WorkspaceFileLayer),
  ),
  CapabilityPolicyLayer,
  CapabilityRegistryLayer,
  WorkspaceFileLayer,
  WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer)),
  WorkspacePaths.layer,
  CompositionTaskStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeTask = (suffix: string, runtimeId: string) => ({
  taskId: `task-multi-driver-${suffix}`,
  projectId: "project-multi-driver",
  assigneeKind: "agent" as const,
  assigneeId: `agent-${suffix}`,
  mode: "serial" as const,
  status: "running" as const,
  promptDigest: `sha256:${suffix}`,
  dependsOnTaskIds: [],
  createdAtUnixMs: 1,
  updatedAtUnixMs: 1,
  runtimeId,
});

it.layer(TestLayer, { excludeTestServices: true })(
  "Composition Multi Driver ToolBroker E2E",
  (it) => {
    it.effect("BYOK Driver 和 Provider Driver 通过同一 ToolBroker 读取真实工作区文件", () =>
      Effect.gen(function* () {
        const broker = yield* ToolBroker.ToolBroker;
        const checkpointStore = yield* CompositionTaskStore;
        const sharedToolBroker = broker;
        const workspaceRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-multi-driver-toolbroker-")),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(workspaceRoot, "shared.txt"),
            "shared-driver-content",
            "utf8",
          ),
        );

        const byokTask = makeTask("byok", "runtime-byok-e2e");
        const byokRun = {
          runId: "run-multi-driver-byok",
          taskId: byokTask.taskId,
          agentId: byokTask.assigneeId,
          runtimeId: byokTask.runtimeId,
          status: "running" as const,
          attempt: 1,
          capabilityGrantIds: ["t3.workspace.read_file"],
        };
        let byokToolResultContent: string | undefined;
        const byokService = makeCompositionAgentService({
          broker: sharedToolBroker,
          resolveModelDriver: () =>
            Effect.succeed({
              complete: ({
                messages,
                turn,
              }: {
                readonly messages: ReadonlyArray<{
                  readonly role: string;
                  readonly content: string;
                }>;
                readonly turn: number;
              }) => {
                if (turn === 1) {
                  return Stream.fromIterable([
                    {
                      type: "tool_call" as const,
                      toolCallId: "byok-read-shared",
                      canonicalToolName: "workspace.read_file",
                      arguments: { cwd: workspaceRoot, relativePath: "shared.txt" },
                    },
                    { type: "model_completed" as const },
                  ]);
                }
                byokToolResultContent = messages.at(-1)?.content;
                return Stream.fromIterable([
                  { type: "text_delta" as const, text: "BYOK 已读取" },
                  { type: "model_completed" as const },
                ]);
              },
            }),
        });
        const byokDriver = makeCompositionByokAgentDriver({
          agentId: byokTask.assigneeId,
          runtimeId: byokTask.runtimeId,
          providerInstanceId: "byok-e2e",
          agentService: byokService,
          checkpointStore,
          listTools: () =>
            Effect.succeed([
              {
                canonicalToolName: "workspace.read_file",
                description: "读取工作区文件",
                parameters: { type: "object" },
              },
            ]),
        });
        const byokEvents = yield* Stream.runCollect(
          Stream.take(
            byokDriver.streamEvents!().pipe(
              Stream.tap((event) =>
                event.type === "turn.completed" ? Effect.succeed(undefined) : Effect.void,
              ),
            ),
            3,
          ),
        ).pipe(Effect.forkChild);
        yield* byokDriver.startTask({
          task: byokTask,
          run: byokRun,
          prompt: "读取 shared.txt",
          workspaceRoot,
          model: "test-model",
        });
        const collectedByokEvents = yield* Fiber.join(byokEvents);
        assert.equal(collectedByokEvents[collectedByokEvents.length - 1]?.type, "turn.completed");
        assert.isTrue(byokToolResultContent?.includes("shared-driver-content") ?? false);

        const providerTask = makeTask("provider", "runtime-provider-e2e");
        const providerRun = {
          runId: "run-multi-driver-provider",
          taskId: providerTask.taskId,
          agentId: providerTask.assigneeId,
          runtimeId: providerTask.runtimeId,
          capabilityHandshakeId: "provider-handshake-multi-driver",
          status: "running" as const,
          attempt: 1,
          capabilityGrantIds: ["t3.workspace.read_file"],
        };
        let providerResult: ToolBroker.ToolBrokerResult | undefined;
        let configuredBridge:
          | Parameters<NonNullable<CompositionProviderSessionAdapter["configureToolBroker"]>>[0]
          | undefined;
        const providerAdapter: CompositionProviderSessionAdapter = {
          handshakeCapabilities: (input) =>
            Effect.succeed({
              ...input,
              status: "accepted" as const,
              handshakeId: "provider-handshake-multi-driver",
              acceptedGrantIds: [...input.capabilityGrantIds],
            }),
          configureToolBroker: (input) => Effect.sync(() => void (configuredBridge = input)),
          startSession: (input: ProviderSessionStartInput) =>
            Effect.succeed({
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: input.providerInstanceId,
              status: "ready" as const,
              runtimeMode: "full-access" as const,
              threadId: input.threadId,
              createdAt: "2026-08-26T00:00:00.000Z",
              updatedAt: "2026-08-26T00:00:00.000Z",
            } satisfies ProviderSession),
          sendTurn: (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult, never> =>
            Effect.gen(function* () {
              if (configuredBridge === undefined)
                return yield* Effect.die("Provider bridge 未配置");
              providerResult = yield* configuredBridge.bridge.invoke({
                toolCallId: "provider-read-shared",
                canonicalToolName: "workspace.read_file",
                arguments: { cwd: workspaceRoot, relativePath: "shared.txt" },
                idempotencyKey: "provider-read-shared-idempotency",
              });
              return {
                threadId: input.threadId,
                turnId: TurnId.make("provider-turn-multi-driver"),
              };
            }),
          interruptTurn: () => Effect.void,
          stopSession: () => Effect.void,
          revokeCapabilityHandshake: () => Effect.void,
          clearToolBroker: () => Effect.void,
        };
        const runtimeBridge = makeCompositionRuntimeToolBridge({
          taskStore: {
            getTask: (taskId) =>
              Effect.succeed(
                taskId === providerTask.taskId ? Option.some(providerTask) : Option.none(),
              ),
            getRun: (runId) =>
              Effect.succeed(
                runId === providerRun.runId ? Option.some(providerRun) : Option.none(),
              ),
          },
          inputStore: {
            get: (taskId) =>
              Effect.succeed(
                taskId === providerTask.taskId
                  ? Option.some({ taskId, prompt: "读取 shared.txt", workspaceRoot })
                  : Option.none(),
              ),
          },
          toolBroker: sharedToolBroker,
        });
        const providerDriver = makeCompositionProviderAgentDriver({
          agentId: providerTask.assigneeId,
          runtimeId: providerTask.runtimeId,
          providerInstanceId: ProviderInstanceId.make("provider-e2e"),
          adapter: providerAdapter,
          toolBrokerBridge: runtimeBridge,
          toolBrokerCanonicalTools: ["workspace.read_file"],
        });

        yield* providerDriver.startTask({
          task: providerTask,
          run: providerRun,
          prompt: "读取 shared.txt",
          workspaceRoot,
        });

        assert.equal(providerResult?.status, "succeeded");
        assert.equal(
          (providerResult?.result as { readonly contents?: string } | undefined)?.contents,
          "shared-driver-content",
        );
        assert.equal(sharedToolBroker, broker);
      }),
    );
  },
);
