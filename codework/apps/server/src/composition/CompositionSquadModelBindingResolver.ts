import {
  ProviderInstanceId,
  type CompositionSquad,
  type CompositionSquadMember,
  type CompositionSquadModelBinding,
  type CompositionTaskRunModelSnapshot,
} from "@codework/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  CompositionAgentDriverRegistryService,
  type CompositionAgentDriverRegistry,
} from "./CompositionAgentDriverRegistry.ts";
import { compositionProviderAgentId } from "./CompositionProviderAgentDriverRegistry.ts";
import {
  ProviderInstanceRegistry,
  type ProviderInstanceRegistryShape,
} from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderCompositionModelDescriptor } from "../provider/ProviderDriver.ts";

export class CompositionSquadModelBindingError extends Schema.TaggedErrorClass<CompositionSquadModelBindingError>()(
  "CompositionSquadModelBindingError",
  {
    code: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Squad 模型绑定无效：${this.code}: ${this.detail}`;
  }
}

export interface ResolvedCompositionSquadMemberModel {
  readonly model?: string;
  readonly modelSnapshot?: CompositionTaskRunModelSnapshot;
}

export interface CompositionSquadModelBindingResolverShape {
  readonly resolveMember: (input: {
    readonly squad: CompositionSquad;
    readonly member: CompositionSquadMember;
  }) => Effect.Effect<ResolvedCompositionSquadMemberModel, CompositionSquadModelBindingError>;
  readonly validateByokRun: (input: {
    readonly agentId: string;
    readonly providerInstanceId: ProviderInstanceId | string;
    readonly model?: string;
    readonly modelSnapshot?: CompositionTaskRunModelSnapshot;
  }) => Effect.Effect<void, CompositionSquadModelBindingError>;
}

export class CompositionSquadModelBindingResolver extends Context.Service<
  CompositionSquadModelBindingResolver,
  CompositionSquadModelBindingResolverShape
>()("codework/composition/CompositionSquadModelBindingResolver") {}

export interface CompositionSquadModelBindingResolverOptions {
  readonly providerRegistry: Pick<ProviderInstanceRegistryShape, "getInstance" | "listInstances">;
  readonly agentDrivers: Pick<CompositionAgentDriverRegistry, "get">;
}

export const sameCompositionTaskRunModelSnapshot = (
  left: CompositionTaskRunModelSnapshot | undefined,
  right: CompositionTaskRunModelSnapshot | undefined,
): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "byok":
      return (
        right.kind === "byok" &&
        left.providerInstanceId === right.providerInstanceId &&
        left.adapterId === right.adapterId &&
        left.modelId === right.modelId &&
        left.adapterConfigDigest === right.adapterConfigDigest
      );
    case "runtime_native":
      return right.kind === "runtime_native" && left.modelId === right.modelId;
    case "legacy":
      return right.kind === "legacy" && left.modelId === right.modelId;
  }
};

const bindingError = (code: string, detail: string): CompositionSquadModelBindingError =>
  new CompositionSquadModelBindingError({ code, detail });

export const resolveCompositionSquadMemberModel = (
  resolver: Pick<CompositionSquadModelBindingResolverShape, "resolveMember"> | undefined,
  input: {
    readonly squad: CompositionSquad;
    readonly member: CompositionSquadMember;
  },
): Effect.Effect<ResolvedCompositionSquadMemberModel, CompositionSquadModelBindingError> => {
  if (resolver !== undefined) return resolver.resolveMember(input);
  if (input.member.modelBinding !== undefined) {
    return Effect.fail(
      bindingError(
        "squad_model_binding_resolver_unavailable",
        `成员 Agent '${input.member.agentId}' 使用结构化模型绑定，但当前未配置解析器。`,
      ),
    );
  }
  if (input.member.model === undefined) return Effect.succeed({});
  return Effect.succeed({
    model: input.member.model,
    modelSnapshot: { kind: "legacy", modelId: input.member.model },
  });
};

const loadByokDescriptor = (
  options: CompositionSquadModelBindingResolverOptions,
  input: {
    readonly agentId: string;
    readonly providerInstanceId: ProviderInstanceId | string;
    readonly adapterId: string;
    readonly modelId: string;
    readonly requireAgentDriver: boolean;
  },
): Effect.Effect<ProviderCompositionModelDescriptor, CompositionSquadModelBindingError> =>
  Effect.gen(function* () {
    const providerInstanceId = ProviderInstanceId.make(String(input.providerInstanceId));
    const expectedAgentId = compositionProviderAgentId(providerInstanceId);
    if (input.agentId !== expectedAgentId) {
      return yield* bindingError(
        "squad_model_agent_mismatch",
        `成员 Agent '${input.agentId}' 不属于 BYOK Provider '${providerInstanceId}'。`,
      );
    }
    if (
      input.requireAgentDriver &&
      (yield* options.agentDrivers.get(input.agentId)) === undefined
    ) {
      return yield* bindingError(
        "squad_model_agent_unavailable",
        `成员 Agent '${input.agentId}' 尚未注册可用 Driver。`,
      );
    }

    const instance = yield* options.providerRegistry.getInstance(providerInstanceId);
    if (instance === undefined) {
      return yield* bindingError(
        "squad_model_provider_not_found",
        `BYOK Provider '${providerInstanceId}' 不存在。`,
      );
    }
    if (!instance.enabled) {
      return yield* bindingError(
        "squad_model_provider_disabled",
        `BYOK Provider '${providerInstanceId}' 已禁用。`,
      );
    }
    if (instance.driverKind !== "byok") {
      return yield* bindingError(
        "squad_model_provider_not_byok",
        `Provider '${providerInstanceId}' 不是 BYOK Provider。`,
      );
    }
    if (instance.composition === undefined) {
      return yield* bindingError(
        "squad_model_provider_composition_unavailable",
        `BYOK Provider '${providerInstanceId}' 未提供 Composition 模型目录。`,
      );
    }
    const descriptor = instance.composition.modelDescriptors.find(
      (candidate) => candidate.adapterId === input.adapterId,
    );
    if (descriptor === undefined) {
      return yield* bindingError(
        "squad_model_adapter_not_found",
        `BYOK Adapter '${input.adapterId}' 不存在。`,
      );
    }
    if (descriptor.modelId !== input.modelId) {
      return yield* bindingError(
        "squad_model_id_mismatch",
        `BYOK Adapter '${input.adapterId}' 当前模型为 '${descriptor.modelId}'，不是 '${input.modelId}'。`,
      );
    }
    return descriptor;
  });

const resolveRuntimeNative = (
  options: CompositionSquadModelBindingResolverOptions,
  member: CompositionSquadMember,
  binding: Extract<CompositionSquadModelBinding, { readonly kind: "runtime_native" }>,
): Effect.Effect<ResolvedCompositionSquadMemberModel, CompositionSquadModelBindingError> =>
  Effect.gen(function* () {
    if ((yield* options.agentDrivers.get(member.agentId)) === undefined) {
      return yield* bindingError(
        "squad_model_agent_unavailable",
        `成员 Agent '${member.agentId}' 尚未注册可用 Driver。`,
      );
    }
    const instances = yield* options.providerRegistry.listInstances;
    const isByokAgent = instances.some(
      (instance) =>
        instance.driverKind === "byok" &&
        compositionProviderAgentId(instance.instanceId) === member.agentId,
    );
    if (isByokAgent) {
      return yield* bindingError(
        "squad_model_runtime_native_not_supported",
        `BYOK Agent '${member.agentId}' 必须使用结构化 BYOK 模型绑定。`,
      );
    }
    return {
      ...(binding.modelId === undefined ? {} : { model: binding.modelId }),
      modelSnapshot: {
        kind: "runtime_native",
        ...(binding.modelId === undefined ? {} : { modelId: binding.modelId }),
      },
    };
  });

const resolveBinding = (
  options: CompositionSquadModelBindingResolverOptions,
  member: CompositionSquadMember,
  binding: CompositionSquadModelBinding,
): Effect.Effect<ResolvedCompositionSquadMemberModel, CompositionSquadModelBindingError> => {
  if (binding.kind === "runtime_native") {
    return resolveRuntimeNative(options, member, binding);
  }
  return loadByokDescriptor(options, {
    agentId: member.agentId,
    providerInstanceId: binding.providerInstanceId,
    adapterId: binding.adapterId,
    modelId: binding.modelId,
    requireAgentDriver: true,
  }).pipe(
    Effect.map((descriptor) => ({
      model: descriptor.adapterId,
      modelSnapshot: {
        kind: "byok" as const,
        providerInstanceId: binding.providerInstanceId,
        adapterId: descriptor.adapterId,
        modelId: descriptor.modelId,
        adapterConfigDigest: descriptor.configurationDigest,
      },
    })),
  );
};

export const makeCompositionSquadModelBindingResolver = (
  options: CompositionSquadModelBindingResolverOptions,
): CompositionSquadModelBindingResolverShape => ({
  resolveMember: ({ squad, member }) => {
    if (member.model !== undefined) {
      return Effect.succeed({
        model: member.model,
        modelSnapshot: { kind: "legacy", modelId: member.model },
      });
    }
    const binding =
      member.modelBinding?.kind === "team_default"
        ? squad.defaultModelBinding
        : member.modelBinding;
    if (member.modelBinding?.kind === "team_default" && binding === undefined) {
      return Effect.fail(
        bindingError(
          "squad_model_team_default_missing",
          `成员 Agent '${member.agentId}' 请求继承团队默认模型，但 Squad 未配置默认模型。`,
        ),
      );
    }
    if (binding === undefined) return Effect.succeed({});
    return resolveBinding(options, member, binding);
  },
  validateByokRun: (input) => {
    const snapshot = input.modelSnapshot;
    if (snapshot === undefined || snapshot.kind === "legacy") return Effect.void;
    if (snapshot.kind === "runtime_native") {
      return Effect.fail(
        bindingError(
          "squad_model_runtime_native_not_supported",
          `BYOK Agent '${input.agentId}' 不能运行 runtime_native 模型快照。`,
        ),
      );
    }
    if (String(input.providerInstanceId) !== snapshot.providerInstanceId) {
      return Effect.fail(
        bindingError(
          "squad_model_provider_mismatch",
          `Run 快照 Provider '${snapshot.providerInstanceId}' 与 Driver Provider '${input.providerInstanceId}' 不一致。`,
        ),
      );
    }
    if (input.model !== undefined && input.model.trim() !== snapshot.adapterId) {
      return Effect.fail(
        bindingError(
          "squad_model_dispatch_mismatch",
          `Run 派发模型必须是快照 Adapter '${snapshot.adapterId}'。`,
        ),
      );
    }
    return loadByokDescriptor(options, {
      agentId: input.agentId,
      providerInstanceId: input.providerInstanceId,
      adapterId: snapshot.adapterId,
      modelId: snapshot.modelId,
      requireAgentDriver: false,
    }).pipe(
      Effect.flatMap((descriptor) =>
        descriptor.configurationDigest === snapshot.adapterConfigDigest
          ? Effect.void
          : Effect.fail(
              bindingError(
                "squad_model_configuration_changed",
                `BYOK Adapter '${snapshot.adapterId}' 配置已变化，拒绝静默复用旧 Run。`,
              ),
            ),
      ),
    );
  },
});

const live = Effect.gen(function* () {
  const providerRegistry = yield* ProviderInstanceRegistry;
  const agentDrivers = yield* CompositionAgentDriverRegistryService;
  return makeCompositionSquadModelBindingResolver({ providerRegistry, agentDrivers });
});

export const layer = Layer.effect(CompositionSquadModelBindingResolver, live);
