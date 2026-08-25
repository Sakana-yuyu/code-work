import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import {
  compositionProviderAgentId,
  makeCompositionProviderAgentDriverProjection,
} from "./CompositionProviderAgentDriverRegistry.ts";

const makeProviderInstance = (instanceId: string): ProviderInstance =>
  ({ instanceId: ProviderInstanceId.make(instanceId) }) as ProviderInstance;

const makeProviderServiceHarness = () => {
  const calls: string[] = [];
  const session = {} as ProviderSession;
  const service: Pick<
    ProviderServiceShape,
    "startSession" | "sendTurn" | "interruptTurn" | "stopSession"
  > = {
    startSession: (threadId, input) => {
      calls.push(`start:${threadId}:${input.providerInstanceId ?? ""}:${input.cwd ?? ""}`);
      return Effect.succeed(session);
    },
    sendTurn: (input) => {
      calls.push(`send:${input.threadId}:${input.input ?? ""}`);
      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make("turn-1"),
      } satisfies ProviderTurnStartResult);
    },
    interruptTurn: (input) => {
      calls.push(`interrupt:${input.threadId}:${input.turnId ?? ""}`);
      return Effect.void;
    },
    stopSession: (input) => {
      calls.push(`stop:${input.threadId}`);
      return Effect.void;
    },
  };
  return { calls, service };
};

describe("CompositionProviderAgentDriverRegistry", () => {
  it("projects provider instances into stable Composition Agent Drivers", async () => {
    let instances = [makeProviderInstance("codex_personal")];
    const providerRegistry = {
      listInstances: Effect.sync(() => instances),
    } as Pick<ProviderInstanceRegistryShape, "listInstances">;
    const provider = makeProviderServiceHarness();
    const projection = makeCompositionProviderAgentDriverProjection({
      providerRegistry,
      providerService: provider.service,
    });

    await Effect.runPromise(projection.refresh);
    const driver = await Effect.runPromise(
      projection.registry.get(
        compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
      ),
    );
    expect(driver).toBeDefined();

    await Effect.runPromise(
      driver!.startTask({
        task: {
          taskId: "task-1",
          projectId: "project-1",
          threadId: "thread-1",
          assigneeKind: "agent",
          assigneeId: compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
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
          agentId: compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
          runtimeId: "provider:codex_personal",
          status: "queued",
          attempt: 1,
          capabilityGrantIds: [],
        },
        prompt: "检查工作区",
        workspaceRoot: "C:/workspace",
      }),
    );
    expect(provider.calls).toEqual([
      "start:thread-1:codex_personal:C:/workspace",
      "send:thread-1:检查工作区",
    ]);
  });

  it("removes stale provider drivers on refresh", async () => {
    let instances = [makeProviderInstance("codex_personal")];
    const providerRegistry = {
      listInstances: Effect.sync(() => instances),
    } as Pick<ProviderInstanceRegistryShape, "listInstances">;
    const projection = makeCompositionProviderAgentDriverProjection({
      providerRegistry,
      providerService: makeProviderServiceHarness().service,
    });

    await Effect.runPromise(projection.refresh);
    instances = [makeProviderInstance("claude_work")];
    await Effect.runPromise(projection.refresh);

    await expect(
      Effect.runPromise(
        projection.registry.get(
          compositionProviderAgentId(ProviderInstanceId.make("codex_personal")),
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        projection.registry.get(compositionProviderAgentId(ProviderInstanceId.make("claude_work"))),
      ),
    ).resolves.toBeDefined();
  });
});
