import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type CompositionSquad,
  type CompositionSquadMember,
  type CompositionTaskRunModelSnapshot,
} from "@codework/contracts";
import * as Effect from "effect/Effect";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { compositionProviderAgentId } from "./CompositionProviderAgentDriverRegistry.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import { makeCompositionSquadModelBindingResolver } from "./CompositionSquadModelBindingResolver.ts";

const providerInstanceId = ProviderInstanceId.make("byok-primary");
const byokAgentId = compositionProviderAgentId(providerInstanceId);

const modelDescriptor = {
  adapterId: "adapter-coder",
  modelId: "deepseek-coder-v3",
  protocol: "openai" as const,
  baseURL: "https://api.example.test/v1",
  configurationDigest: "sha256:adapter-coder-v1",
};

const member = (
  input: Partial<CompositionSquadMember> & Pick<CompositionSquadMember, "agentId" | "role">,
): CompositionSquadMember => ({
  order: input.role === "leader" ? 0 : 1,
  required: true,
  capabilityIds: [],
  maxConcurrentTasks: 1,
  ...input,
});

const squad = (
  members: ReadonlyArray<CompositionSquadMember>,
  defaultModelBinding?: CompositionSquad["defaultModelBinding"],
): CompositionSquad => ({
  squadId: "squad-model-bindings",
  name: "模型绑定团队",
  leaderAgentId: members[0]!.agentId,
  memberAgentIds: members.map((item) => item.agentId),
  revision: 1,
  collaborationMode: "leader_workers",
  members: [...members],
  ...(defaultModelBinding === undefined ? {} : { defaultModelBinding }),
  maxConcurrency: 2,
  maxRetries: 0,
  failurePolicy: "fail_fast",
  partialSuccessPolicy: "reject",
  approvalStages: [],
});

const driver = (agentId: string): CompositionAgentDriver => ({
  agentId,
  runtimeId: `runtime:${agentId}`,
  startTask: () => Effect.succeed({}),
  cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
});

const provider = (
  input: Omit<Partial<ProviderInstance>, "composition"> &
    Pick<ProviderInstance, "instanceId" | "driverKind"> & {
      readonly composition?: ProviderInstance["composition"] | undefined;
    },
): ProviderInstance =>
  ({
    enabled: true,
    composition: {
      modelDescriptors: [modelDescriptor],
      resolveModelDriver: () => Effect.die("测试不会解析真实模型驱动"),
    },
    ...input,
  }) as ProviderInstance;

const makeHarness = (input?: {
  readonly providers?: ReadonlyArray<ProviderInstance>;
  readonly agents?: ReadonlyArray<CompositionAgentDriver>;
}) => {
  const providers = input?.providers ?? [
    provider({ instanceId: providerInstanceId, driverKind: ProviderDriverKind.make("byok") }),
  ];
  const agents = input?.agents ?? [driver(byokAgentId), driver("multica:builder")];
  const providersById = new Map(providers.map((item) => [item.instanceId, item] as const));
  const agentsById = new Map(agents.map((item) => [item.agentId, item] as const));
  return makeCompositionSquadModelBindingResolver({
    providerRegistry: {
      getInstance: (instanceId) => Effect.succeed(providersById.get(instanceId)),
      listInstances: Effect.succeed(providers),
    },
    agentDrivers: {
      get: (agentId) => Effect.succeed(agentsById.get(agentId)),
    },
  });
};

it.effect("将 BYOK 绑定解析为 Adapter 派发值和非敏感 Run 快照", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const leader = member({
      agentId: byokAgentId,
      role: "leader",
      modelBinding: {
        kind: "byok",
        providerInstanceId,
        adapterId: modelDescriptor.adapterId,
        modelId: modelDescriptor.modelId,
      },
    });

    const resolved = yield* resolver.resolveMember({ squad: squad([leader]), member: leader });

    expect(resolved).toEqual({
      model: modelDescriptor.adapterId,
      modelSnapshot: {
        kind: "byok",
        providerInstanceId,
        adapterId: modelDescriptor.adapterId,
        modelId: modelDescriptor.modelId,
        adapterConfigDigest: modelDescriptor.configurationDigest,
      },
    });
    expect("apiKey" in resolved).toBe(false);
    expect(resolved.modelSnapshot).not.toHaveProperty("apiKey");
  }),
);

it.effect("让成员显式继承团队默认模型绑定", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const leader = member({
      agentId: byokAgentId,
      role: "leader",
      modelBinding: { kind: "team_default" },
    });
    const team = squad([leader], {
      kind: "byok",
      providerInstanceId,
      adapterId: modelDescriptor.adapterId,
      modelId: modelDescriptor.modelId,
    });

    const resolved = yield* resolver.resolveMember({ squad: team, member: leader });

    expect(resolved.model).toBe(modelDescriptor.adapterId);
    expect(resolved.modelSnapshot?.kind).toBe("byok");
  }),
);

it.effect("保留旧 model 字段并生成 legacy 快照", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const leader = member({
      agentId: "multica:leader",
      role: "leader",
      model: "legacy-model",
    });

    const resolved = yield* resolver.resolveMember({ squad: squad([leader]), member: leader });

    expect(resolved).toEqual({
      model: "legacy-model",
      modelSnapshot: { kind: "legacy", modelId: "legacy-model" },
    });
  }),
);

it.effect("没有旧模型或结构化绑定时保持 Driver 默认行为", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const leader = member({ agentId: "multica:leader", role: "leader" });

    const resolved = yield* resolver.resolveMember({ squad: squad([leader]), member: leader });

    expect(resolved).toEqual({});
  }),
);

it.effect("为非 BYOK Driver 解析 runtime_native 模型", () =>
  Effect.gen(function* () {
    const resolver = makeHarness({ agents: [driver("multica:builder")] });
    const builder = member({
      agentId: "multica:builder",
      role: "worker",
      modelBinding: { kind: "runtime_native", modelId: "multica-model" },
    });

    const resolved = yield* resolver.resolveMember({ squad: squad([builder]), member: builder });

    expect(resolved).toEqual({
      model: "multica-model",
      modelSnapshot: { kind: "runtime_native", modelId: "multica-model" },
    });
  }),
);

const byokFailureCases: ReadonlyArray<{
  readonly name: string;
  readonly expectedCode: string;
  readonly providers?: ReadonlyArray<ProviderInstance>;
  readonly agents?: ReadonlyArray<CompositionAgentDriver>;
  readonly agentId?: string;
  readonly binding?: {
    readonly kind: "byok";
    readonly providerInstanceId: string;
    readonly adapterId: string;
    readonly modelId: string;
  };
}> = [
  {
    name: "Provider 不存在",
    expectedCode: "squad_model_provider_not_found",
    providers: [],
  },
  {
    name: "Provider 已禁用",
    expectedCode: "squad_model_provider_disabled",
    providers: [
      provider({
        instanceId: providerInstanceId,
        driverKind: ProviderDriverKind.make("byok"),
        enabled: false,
      }),
    ],
  },
  {
    name: "Provider 不是 BYOK",
    expectedCode: "squad_model_provider_not_byok",
    providers: [
      provider({
        instanceId: providerInstanceId,
        driverKind: ProviderDriverKind.make("codex"),
      }),
    ],
  },
  {
    name: "Provider 没有 Composition 模型目录",
    expectedCode: "squad_model_provider_composition_unavailable",
    providers: [
      provider({
        instanceId: providerInstanceId,
        driverKind: ProviderDriverKind.make("byok"),
        composition: undefined,
      }),
    ],
  },
  {
    name: "Adapter 不存在",
    expectedCode: "squad_model_adapter_not_found",
    binding: {
      kind: "byok",
      providerInstanceId,
      adapterId: "adapter-missing",
      modelId: modelDescriptor.modelId,
    },
  },
  {
    name: "外部模型 ID 不匹配",
    expectedCode: "squad_model_id_mismatch",
    binding: {
      kind: "byok",
      providerInstanceId,
      adapterId: modelDescriptor.adapterId,
      modelId: "different-model",
    },
  },
  {
    name: "成员 Agent 不属于 Provider",
    expectedCode: "squad_model_agent_mismatch",
    agentId: "multica:builder",
  },
  {
    name: "BYOK Agent Driver 尚未注册",
    expectedCode: "squad_model_agent_unavailable",
    agents: [],
  },
];

for (const failureCase of byokFailureCases) {
  it.effect(`拒绝${failureCase.name}`, () =>
    Effect.gen(function* () {
      const resolver = makeHarness({
        ...(failureCase.providers === undefined ? {} : { providers: failureCase.providers }),
        ...(failureCase.agents === undefined ? {} : { agents: failureCase.agents }),
      });
      const leader = member({
        agentId: failureCase.agentId ?? byokAgentId,
        role: "leader",
        modelBinding: failureCase.binding ?? {
          kind: "byok",
          providerInstanceId,
          adapterId: modelDescriptor.adapterId,
          modelId: modelDescriptor.modelId,
        },
      });

      const error = yield* Effect.flip(
        resolver.resolveMember({ squad: squad([leader]), member: leader }),
      );

      expect(error.code).toBe(failureCase.expectedCode);
    }),
  );
}

it.effect("拒绝 BYOK Agent 使用 runtime_native 绑定", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const leader = member({
      agentId: byokAgentId,
      role: "leader",
      modelBinding: { kind: "runtime_native" },
    });

    const error = yield* Effect.flip(
      resolver.resolveMember({ squad: squad([leader]), member: leader }),
    );

    expect(error.code).toBe("squad_model_runtime_native_not_supported");
  }),
);

it.effect("BYOK Driver 启动时拒绝配置摘要漂移", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const snapshot: CompositionTaskRunModelSnapshot = {
      kind: "byok",
      providerInstanceId,
      adapterId: modelDescriptor.adapterId,
      modelId: modelDescriptor.modelId,
      adapterConfigDigest: "sha256:stale",
    };

    const error = yield* Effect.flip(
      resolver.validateByokRun({
        agentId: byokAgentId,
        providerInstanceId,
        model: modelDescriptor.adapterId,
        modelSnapshot: snapshot,
      }),
    );

    expect(error.code).toBe("squad_model_configuration_changed");
  }),
);

it.effect("BYOK Driver 拒绝错误派发值与 runtime_native 快照", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();
    const structuredSnapshot: CompositionTaskRunModelSnapshot = {
      kind: "byok",
      providerInstanceId,
      adapterId: modelDescriptor.adapterId,
      modelId: modelDescriptor.modelId,
      adapterConfigDigest: modelDescriptor.configurationDigest,
    };
    const modelError = yield* Effect.flip(
      resolver.validateByokRun({
        agentId: byokAgentId,
        providerInstanceId,
        model: "wrong-adapter",
        modelSnapshot: structuredSnapshot,
      }),
    );
    const nativeError = yield* Effect.flip(
      resolver.validateByokRun({
        agentId: byokAgentId,
        providerInstanceId,
        modelSnapshot: { kind: "runtime_native" },
      }),
    );

    expect(modelError.code).toBe("squad_model_dispatch_mismatch");
    expect(nativeError.code).toBe("squad_model_runtime_native_not_supported");
  }),
);

it.effect("BYOK Driver 兼容无快照和 legacy 快照", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();

    yield* resolver.validateByokRun({
      agentId: byokAgentId,
      providerInstanceId,
      model: modelDescriptor.adapterId,
    });
    yield* resolver.validateByokRun({
      agentId: byokAgentId,
      providerInstanceId,
      model: modelDescriptor.adapterId,
      modelSnapshot: { kind: "legacy", modelId: modelDescriptor.adapterId },
    });
  }),
);

it.effect("BYOK Driver 恢复时无需重传派发字符串，但仍校验持久化快照", () =>
  Effect.gen(function* () {
    const resolver = makeHarness();

    yield* resolver.validateByokRun({
      agentId: byokAgentId,
      providerInstanceId,
      modelSnapshot: {
        kind: "byok",
        providerInstanceId,
        adapterId: modelDescriptor.adapterId,
        modelId: modelDescriptor.modelId,
        adapterConfigDigest: modelDescriptor.configurationDigest,
      },
    });
  }),
);
