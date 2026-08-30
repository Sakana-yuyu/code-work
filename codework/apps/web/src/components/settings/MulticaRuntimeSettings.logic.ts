import {
  CompositionMulticaRuntimeConfig,
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
    return {
      instanceId: normalizedInstanceId,
      originalInstanceId: normalizedInstanceId,
      runtimeId: config.runtimeId,
      daemonId: config.daemonId,
      daemonRuntimeId: config.daemonRuntimeId,
      baseUrl: config.baseUrl,
      headers: config.headers.map((header) => ({ ...header })),
      environment: (instance.environment ?? []).map((entry) =>
        entry.sensitive === true
          ? {
              ...entry,
              value: "",
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
