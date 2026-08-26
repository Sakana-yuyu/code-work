import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import type { CompositionAgentServiceShape } from "./CompositionAgentService.ts";
import { CompositionAgentService } from "./CompositionAgentService.ts";
import {
  compositionByokAgentId,
  CompositionByokAgentDriverProjectionService,
  layer as compositionByokAgentDriverProjectionLayer,
  makeCompositionByokAgentDriverProjection,
} from "./CompositionByokAgentDriverRegistry.ts";
import {
  CompositionAgentDriverRegistryService,
  makeCompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";

const makeByokInstance = (instanceId: string): ProviderInstance =>
  ({
    instanceId: ProviderInstanceId.make(instanceId),
    driverKind: ProviderDriverKind.make("byok"),
    snapshot: {
      getSnapshot: Effect.succeed({
        enabled: true,
        installed: true,
        status: "ready",
        availability: "available",
        version: null,
      } as unknown as ServerProvider),
    },
    composition: {
      defaultModelId: "openai/gpt-5",
      resolveModelDriver: () => Effect.die("not used by projection test"),
    },
  }) as unknown as ProviderInstance;

describe("CompositionByokAgentDriverRegistry", () => {
  it("只把 BYOK ProviderInstance 投影成真正使用 ToolBroker 的 Agent Driver", async () => {
    const calls: Array<Parameters<CompositionAgentServiceShape["run"]>[0]> = [];
    const agentService: CompositionAgentServiceShape = {
      run: (input) => {
        calls.push(input);
        return Effect.succeed({ text: "完成", messages: [], rounds: 1 });
      },
    };
    const instances = [makeByokInstance("byok-personal")];
    const providerRegistry = {
      listInstances: Effect.succeed(instances),
    } satisfies Pick<ProviderInstanceRegistryShape, "listInstances">;
    const projection = makeCompositionByokAgentDriverProjection({
      providerRegistry,
      agentService,
    });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(
      projection.registry.get(compositionByokAgentId("byok-personal")),
    );
    expect(driver).toBeDefined();
    await expect(Effect.runPromise(driver!.getProfile!())).resolves.toMatchObject({
      driverKind: "provider",
      providerKind: "byok",
      status: "available",
      supportsToolBroker: true,
      supportsWorkspace: true,
    });

    await Effect.runPromise(
      driver!.startTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          assigneeKind: "agent",
          assigneeId: compositionByokAgentId("byok-personal"),
          mode: "serial",
          status: "queued",
          promptDigest: "sha256:prompt",
          dependsOnTaskIds: [],
          createdAtUnixMs: 1,
          updatedAtUnixMs: 1,
        },
        run: {
          runId: "run-1",
          taskId: "task-1",
          agentId: compositionByokAgentId("byok-personal"),
          runtimeId: "byok:byok-personal",
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
        prompt: "检查工作区",
        workspaceRoot: "C:/workspace",
      }),
    );
    expect(calls[0]).toMatchObject({
      providerInstanceId: "byok-personal",
      modelId: "openai/gpt-5",
      tools: expect.arrayContaining([
        expect.objectContaining({ canonicalToolName: "workspace.read_file" }),
      ]),
    });
  });

  it("刷新时移除已经删除的 BYOK ProviderInstance", async () => {
    let instances = [makeByokInstance("byok-personal")];
    const projection = makeCompositionByokAgentDriverProjection({
      providerRegistry: { listInstances: Effect.sync(() => instances) },
      agentService: {
        run: () => Effect.succeed({ text: "", messages: [], rounds: 1 }),
      },
    });

    await Effect.runPromise(projection.refresh);
    instances = [];
    await Effect.runPromise(projection.refresh);
    await expect(
      Effect.runPromise(projection.registry.get(compositionByokAgentId("byok-personal"))),
    ).resolves.toBeUndefined();
  });

  it("可以在真实 Effect Layer 中创建 BYOK projection 并完成初始注册", async () => {
    const changes = Effect.runSync(PubSub.unbounded<void>());
    const providerRegistry = {
      getInstance: () => Effect.succeed(void 0),
      listInstances: Effect.succeed([makeByokInstance("byok-layer")]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    } satisfies ProviderInstanceRegistryShape;
    const agentService: CompositionAgentServiceShape = {
      run: () => Effect.succeed({ text: "", messages: [], rounds: 1 }),
    };
    const registry = makeCompositionAgentDriverRegistry();
    const layer = compositionByokAgentDriverProjectionLayer.pipe(
      Layer.provideMerge(Layer.succeed(ProviderInstanceRegistry, providerRegistry)),
      Layer.provideMerge(Layer.succeed(CompositionAgentService, agentService)),
      Layer.provideMerge(Layer.succeed(CompositionAgentDriverRegistryService, registry)),
    );

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const projection = yield* CompositionByokAgentDriverProjectionService;
            return yield* projection.registry.get(compositionByokAgentId("byok-layer"));
          }),
        ).pipe(Effect.provide(layer)),
      ),
    ).resolves.toBeDefined();
  });
});
