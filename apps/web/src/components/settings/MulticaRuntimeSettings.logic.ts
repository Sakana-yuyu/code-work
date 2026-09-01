import {
  CompositionMulticaRuntimeConfig,
  isMulticaSecretName,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import * as Schema from "effect/Schema";

import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import {
  isSafeMulticaRuntimeBaseUrl,
  isSafeMulticaTaskMcpEndpoint,
} from "./MulticaRuntimeSettings.url";

export * from "./MulticaRuntimeSettings.model";
export { validateMulticaRuntimeDraft } from "./MulticaRuntimeSettings.validation";

const decodeMulticaConfig = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

export const formFromMulticaRuntimeInstance = (
  instanceId: string,
  instance: ProviderInstanceConfig,
): MulticaRuntimeDraft | null => {
  if (instance.driver !== "multica") return null;
  try {
    const normalizedInstanceId = decodeProviderInstanceId(instanceId);
    const config = decodeMulticaConfig(instance.config);
    if (!isSafeMulticaRuntimeBaseUrl(config.baseUrl)) return null;
    if (
      config.taskMcpEndpoint !== undefined &&
      !isSafeMulticaTaskMcpEndpoint(config.taskMcpEndpoint)
    ) {
      return null;
    }
    const secretEnvironmentNames = new Set(
      config.headers.flatMap((header) =>
        isMulticaSecretName(header.headerName) ? [header.environmentVariable] : [],
      ),
    );
    return {
      instanceId: normalizedInstanceId,
      originalInstanceId: normalizedInstanceId,
      runtimeId: config.runtimeId,
      daemonId: config.daemonId,
      daemonRuntimeId: config.daemonRuntimeId,
      baseUrl: config.baseUrl,
      headers: config.headers.map((header) => ({ ...header })),
      environment: (instance.environment ?? []).map((entry) =>
        entry.sensitive === true || secretEnvironmentNames.has(entry.name)
          ? {
            ...entry,
            value: "",
            ...(secretEnvironmentNames.has(entry.name) ? { sensitive: true } : {}),
              valueRedacted: true,
              originalName: entry.name,
            }
          : {
              ...entry,
              ...(entry.valueRedacted === true ? { originalName: entry.name } : {}),
            },
      ),
      assigneeRoutes: config.assigneeRoutes.map((route) => ({
        codeworkAgentId: route.codeworkAgentId,
        codeworkSquadId: route.codeworkSquadId ?? "",
        workspaceId: route.workspaceId,
        multicaAgentId: route.multicaAgentId ?? "",
        multicaSquadId: route.multicaSquadId ?? "",
        codeworkMcpCredentialEnvironmentVariable:
          route.codeworkMcpCredentialEnvironmentVariable ?? "",
      })),
      enabled: instance.enabled ?? config.enabled,
      version: config.version ?? "",
      capabilities: [...config.capabilities],
      supportsResume: config.supportsResume,
      supportsMcp: config.supportsMcp,
      taskMcpEndpoint: config.taskMcpEndpoint ?? "",
      taskExecutionExtension: {
        command: config.taskExecutionExtension?.command ?? "",
        args: [...(config.taskExecutionExtension?.args ?? [])],
        cwd: config.taskExecutionExtension?.cwd ?? "",
        timeoutMs:
          config.taskExecutionExtension?.timeoutMs === undefined
            ? ""
            : String(config.taskExecutionExtension.timeoutMs),
      },
      supportsSquad: config.supportsSquad,
      supportsLeader: config.supportsLeader,
      supportsTaskGraph: config.supportsTaskGraph,
    };
  } catch {
    return null;
  }
};

export const emptyMulticaRuntimeDraft = (instanceId = "multica_local"): MulticaRuntimeDraft => ({
  instanceId,
  originalInstanceId: null,
  runtimeId: "",
  daemonId: "",
  daemonRuntimeId: "",
  baseUrl: "http://127.0.0.1:9000",
  headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
  environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true }],
  assigneeRoutes: [],
  enabled: true,
  version: "",
  capabilities: [],
  supportsResume: false,
  supportsMcp: false,
  taskMcpEndpoint: "",
  taskExecutionExtension: { command: "", args: [], cwd: "", timeoutMs: "" },
  supportsSquad: false,
  supportsLeader: false,
  supportsTaskGraph: false,
});

export const nextMulticaRuntimeInstanceId = (
  instances: Readonly<Record<string, ProviderInstanceConfig>>,
): string => {
  let index = 1;
  let candidate = "multica_local";
  while (instances[candidate] !== undefined) {
    index += 1;
    candidate = `multica_local_${index}`;
  }
  return candidate;
};

/** 用字段比较草稿，避免在每次输入时序列化整个嵌套配置。 */
export const multicaRuntimeDraftEquals = (
  left: MulticaRuntimeDraft,
  right: MulticaRuntimeDraft,
): boolean =>
  left.instanceId === right.instanceId &&
  left.originalInstanceId === right.originalInstanceId &&
  left.runtimeId === right.runtimeId &&
  left.daemonId === right.daemonId &&
  left.daemonRuntimeId === right.daemonRuntimeId &&
  left.baseUrl === right.baseUrl &&
  left.enabled === right.enabled &&
  left.version === right.version &&
  left.supportsResume === right.supportsResume &&
  left.supportsMcp === right.supportsMcp &&
  left.taskMcpEndpoint === right.taskMcpEndpoint &&
  left.supportsSquad === right.supportsSquad &&
  left.supportsLeader === right.supportsLeader &&
  left.supportsTaskGraph === right.supportsTaskGraph &&
  left.headers.length === right.headers.length &&
  left.headers.every(
    (value, index) =>
      value.headerName === right.headers[index]?.headerName &&
      value.environmentVariable === right.headers[index]?.environmentVariable,
  ) &&
  left.environment.length === right.environment.length &&
  left.environment.every(
    (value, index) =>
      value.name === right.environment[index]?.name &&
      value.originalName === right.environment[index]?.originalName &&
      value.value === right.environment[index]?.value &&
      value.sensitive === right.environment[index]?.sensitive &&
      value.valueRedacted === right.environment[index]?.valueRedacted,
  ) &&
  left.assigneeRoutes.length === right.assigneeRoutes.length &&
  left.assigneeRoutes.every(
    (value, index) =>
      value.codeworkAgentId === right.assigneeRoutes[index]?.codeworkAgentId &&
      value.codeworkSquadId === right.assigneeRoutes[index]?.codeworkSquadId &&
      value.workspaceId === right.assigneeRoutes[index]?.workspaceId &&
      value.multicaAgentId === right.assigneeRoutes[index]?.multicaAgentId &&
      value.multicaSquadId === right.assigneeRoutes[index]?.multicaSquadId &&
      value.codeworkMcpCredentialEnvironmentVariable ===
        right.assigneeRoutes[index]?.codeworkMcpCredentialEnvironmentVariable,
  ) &&
  left.capabilities.length === right.capabilities.length &&
  left.capabilities.every((value, index) => value === right.capabilities[index]) &&
  left.taskExecutionExtension.command === right.taskExecutionExtension.command &&
  left.taskExecutionExtension.cwd === right.taskExecutionExtension.cwd &&
  left.taskExecutionExtension.timeoutMs === right.taskExecutionExtension.timeoutMs &&
  left.taskExecutionExtension.args.length === right.taskExecutionExtension.args.length &&
  left.taskExecutionExtension.args.every(
    (value, index) => value === right.taskExecutionExtension.args[index],
  );

/** 只用于服务端快照冲突检测；不记录或显示凭据值。 */
export const multicaRuntimeDraftFingerprint = (draft: MulticaRuntimeDraft): string =>
  [
    draft.instanceId,
    draft.runtimeId,
    draft.daemonId,
    draft.daemonRuntimeId,
    draft.baseUrl,
    draft.enabled,
    draft.version,
    draft.supportsResume,
    draft.supportsMcp,
    draft.taskMcpEndpoint,
    draft.supportsSquad,
    draft.supportsLeader,
    draft.supportsTaskGraph,
    ...draft.headers.flatMap((value) => [value.headerName, value.environmentVariable]),
    ...draft.environment.flatMap((value) => [
      value.name,
      value.sensitive,
      value.valueRedacted === true,
    ]),
    ...draft.assigneeRoutes.flatMap((value) => [
      value.codeworkAgentId,
      value.codeworkSquadId,
      value.workspaceId,
      value.multicaAgentId,
      value.multicaSquadId,
      value.codeworkMcpCredentialEnvironmentVariable,
    ]),
    ...draft.capabilities,
    draft.taskExecutionExtension.command,
    ...draft.taskExecutionExtension.args,
    draft.taskExecutionExtension.cwd,
    draft.taskExecutionExtension.timeoutMs,
  ].join("\u001f");
