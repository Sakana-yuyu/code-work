import {
  CompositionMulticaRuntimeConfig,
  isMulticaSecretName,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ServerSettings,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@codework/contracts";
import * as Schema from "effect/Schema";

export type MulticaRuntimeHeaderDraft = {
  readonly headerName: string;
  readonly environmentVariable: string;
};

export type MulticaRuntimeEnvironmentDraft = ProviderInstanceEnvironmentVariable & {
  /** 已保存 Secret 的原环境变量名；用于阻止脱敏占位在改名时丢失真实值。 */
  readonly originalName?: string;
};

export type MulticaRuntimeAssigneeRouteDraft = {
  readonly codeworkAgentId: string;
  readonly codeworkSquadId: string;
  readonly workspaceId: string;
  readonly multicaAgentId: string;
  readonly multicaSquadId: string;
  readonly codeworkMcpCredentialEnvironmentVariable: string;
};

export type MulticaTaskExecutionExtensionDraft = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: string;
};

export type MulticaRuntimeDraft = {
  readonly instanceId: string;
  /** 已保存 Secret 的原实例 ID；新建草稿为 null。 */
  readonly originalInstanceId: string | null;
  readonly runtimeId: string;
  readonly daemonId: string;
  readonly daemonRuntimeId: string;
  readonly baseUrl: string;
  readonly headers: ReadonlyArray<MulticaRuntimeHeaderDraft>;
  readonly environment: ReadonlyArray<MulticaRuntimeEnvironmentDraft>;
  readonly assigneeRoutes: ReadonlyArray<MulticaRuntimeAssigneeRouteDraft>;
  readonly enabled: boolean;
  readonly version: string;
  readonly capabilities: ReadonlyArray<string>;
  readonly supportsResume: boolean;
  readonly supportsMcp: boolean;
  readonly taskMcpEndpoint: string;
  readonly taskExecutionExtension: MulticaTaskExecutionExtensionDraft;
  readonly supportsSquad: boolean;
  readonly supportsLeader: boolean;
  readonly supportsTaskGraph: boolean;
};

export type MulticaRuntimeDraftIssueCode =
  | "invalid_instance_id"
  | "invalid_runtime_identity"
  | "invalid_base_url"
  | "invalid_environment"
  | "invalid_environment_secret"
  | "invalid_header_binding"
  | "invalid_assignee_route"
  | "invalid_task_mcp_endpoint"
  | "invalid_task_execution_extension"
  | "invalid_config";

export type MulticaRuntimeDraftIssue = {
  readonly code: MulticaRuntimeDraftIssueCode;
  readonly path: string;
};

export type MulticaRuntimeSave = {
  readonly instanceId: ProviderInstanceId;
  readonly config: CompositionMulticaRuntimeConfig;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
};

export type MulticaRuntimeDraftValidation =
  | { readonly ok: true; readonly value: MulticaRuntimeSave }
  | { readonly ok: false; readonly issue: MulticaRuntimeDraftIssue };

const decodeMulticaConfig = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);
const decodeProviderEnvironment = Schema.decodeUnknownSync(ProviderInstanceEnvironment);

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const RESERVED_PROTOCOL_HEADERS = new Set([
  "accept",
  "content-type",
  "x-workspace-id",
  "x-idempotency-key",
]);

export const isSafeMulticaRuntimeBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return (
      HTTP_PROTOCOLS.has(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
};

export const isSafeMulticaTaskMcpEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value.trim());
    return (
      HTTP_PROTOCOLS.has(url.protocol) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0 &&
      Array.from(url.searchParams.keys()).every((name) => !isMulticaSecretName(name))
    );
  } catch {
    return false;
  }
};

export const safeMulticaRuntimeUrlLabel = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (!HTTP_PROTOCOLS.has(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

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

/** 只比较非 Secret 字段和脱敏状态，绝不把凭据值写入指纹。 */
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

type ValidationFailure = Extract<MulticaRuntimeDraftValidation, { readonly ok: false }>;
type Normalization<T> = { readonly ok: true; readonly value: T } | ValidationFailure;

const invalid = (code: MulticaRuntimeDraftIssueCode, path: string): ValidationFailure => ({
  ok: false,
  issue: { code, path },
});

const normalizationSuccess = <T>(value: T): Normalization<T> => ({ ok: true, value });
const trimmedOptional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const normalizeEnvironment = (
  values: MulticaRuntimeDraft["environment"],
  instanceId: string,
  originalInstanceId: string | null,
): Normalization<ReadonlyArray<ProviderInstanceEnvironmentVariable>> => {
  const names = new Set<string>();
  const normalized: ProviderInstanceEnvironmentVariable[] = [];
  for (const [index, value] of values.entries()) {
    const name = value.name.trim();
    const isUnusedEmptyRow =
      name.length === 0 &&
      value.value.length === 0 &&
      value.valueRedacted !== true &&
      value.originalName === undefined;
    if (isUnusedEmptyRow) continue;
    if (name.length === 0 || names.has(name)) {
      return invalid("invalid_environment", `environment.${index}.name`);
    }
    names.add(name);
    const retainsExistingSecretIdentity =
      value.originalName !== undefined || value.valueRedacted === true;
    if (value.value.length === 0 && retainsExistingSecretIdentity) {
      if (
        value.sensitive !== true ||
        value.valueRedacted !== true ||
        originalInstanceId !== instanceId ||
        value.originalName !== name
      ) {
        return invalid("invalid_environment_secret", `environment.${index}.value`);
      }
      normalized.push({ name, value: "", sensitive: true, valueRedacted: true });
      continue;
    }
    normalized.push({ name, value: value.value, sensitive: value.sensitive });
  }
  try {
    return normalizationSuccess(decodeProviderEnvironment(normalized));
  } catch {
    return invalid("invalid_environment", "environment");
  }
};

const normalizeHeaders = (
  values: ReadonlyArray<MulticaRuntimeHeaderDraft>,
  environmentVariables: ReadonlyMap<string, ProviderInstanceEnvironmentVariable>,
): Normalization<ReadonlyArray<MulticaRuntimeHeaderDraft>> => {
  const names = new Set<string>();
  const normalized: MulticaRuntimeHeaderDraft[] = [];
  for (const [index, value] of values.entries()) {
    const headerName = value.headerName.trim();
    const environmentVariable = value.environmentVariable.trim();
    if (headerName.length === 0 && environmentVariable.length === 0) continue;
    if (headerName.length === 0) {
      return invalid("invalid_header_binding", `headers.${index}.headerName`);
    }
    const normalizedName = headerName.toLowerCase();
    if (RESERVED_PROTOCOL_HEADERS.has(normalizedName) || names.has(normalizedName)) {
      return invalid("invalid_header_binding", `headers.${index}.headerName`);
    }
    const variable = environmentVariables.get(environmentVariable);
    if (environmentVariable.length === 0 || variable === undefined) {
      return invalid("invalid_header_binding", `headers.${index}.environmentVariable`);
    }
    if (variable.value.length === 0 && variable.valueRedacted !== true) {
      return invalid("invalid_header_binding", `headers.${index}.environmentVariable`);
    }
    if (isMulticaSecretName(headerName) && variable.sensitive !== true) {
      return invalid("invalid_header_binding", `headers.${index}.environmentVariable`);
    }
    names.add(normalizedName);
    normalized.push({ headerName, environmentVariable });
  }
  return normalizationSuccess(normalized);
};

const normalizeAssigneeRoutes = (
  values: ReadonlyArray<MulticaRuntimeAssigneeRouteDraft>,
  environmentVariables: ReadonlyMap<string, ProviderInstanceEnvironmentVariable>,
  supportsMcp: boolean,
  taskMcpEndpoint: string | undefined,
): Normalization<CompositionMulticaRuntimeConfig["assigneeRoutes"]> => {
  const agentIds = new Set<string>();
  const squadIds = new Set<string>();
  const credentialOwners = new Map<string, string>();
  const agentCredentials = new Map<string, string>();
  const normalized: Array<CompositionMulticaRuntimeConfig["assigneeRoutes"][number]> = [];
  for (const [index, value] of values.entries()) {
    const codeworkAgentId = value.codeworkAgentId.trim();
    const codeworkSquadId = trimmedOptional(value.codeworkSquadId);
    const workspaceId = value.workspaceId.trim();
    const multicaAgentId = trimmedOptional(value.multicaAgentId);
    const multicaSquadId = trimmedOptional(value.multicaSquadId);
    const credentialEnvironmentVariable = trimmedOptional(
      value.codeworkMcpCredentialEnvironmentVariable,
    );
    const isEmpty =
      codeworkAgentId.length === 0 &&
      codeworkSquadId === undefined &&
      workspaceId.length === 0 &&
      multicaAgentId === undefined &&
      multicaSquadId === undefined &&
      credentialEnvironmentVariable === undefined;
    if (isEmpty) continue;
    if (
      codeworkAgentId.length === 0 ||
      workspaceId.length === 0 ||
      (multicaAgentId === undefined) === (multicaSquadId === undefined)
    ) {
      return invalid("invalid_assignee_route", `assigneeRoutes.${index}`);
    }
    if (credentialEnvironmentVariable !== undefined) {
      const credential = environmentVariables.get(credentialEnvironmentVariable);
      if (
        credential?.sensitive !== true ||
        (credential.value.trim().length === 0 && credential.valueRedacted !== true) ||
        !supportsMcp ||
        taskMcpEndpoint !== undefined
      ) {
        return invalid(
          "invalid_assignee_route",
          `assigneeRoutes.${index}.codeworkMcpCredentialEnvironmentVariable`,
        );
      }
      const existingOwner = credentialOwners.get(credentialEnvironmentVariable);
      if (existingOwner !== undefined && existingOwner !== codeworkAgentId) {
        return invalid(
          "invalid_assignee_route",
          `assigneeRoutes.${index}.codeworkMcpCredentialEnvironmentVariable`,
        );
      }
      const existingCredential = agentCredentials.get(codeworkAgentId);
      if (
        existingCredential !== undefined &&
        existingCredential !== credentialEnvironmentVariable
      ) {
        return invalid(
          "invalid_assignee_route",
          `assigneeRoutes.${index}.codeworkMcpCredentialEnvironmentVariable`,
        );
      }
      credentialOwners.set(credentialEnvironmentVariable, codeworkAgentId);
      agentCredentials.set(codeworkAgentId, credentialEnvironmentVariable);
    }
    if (codeworkSquadId === undefined) {
      if (agentIds.has(codeworkAgentId)) {
        return invalid("invalid_assignee_route", `assigneeRoutes.${index}.codeworkAgentId`);
      }
      agentIds.add(codeworkAgentId);
    } else {
      if (squadIds.has(codeworkSquadId)) {
        return invalid("invalid_assignee_route", `assigneeRoutes.${index}.codeworkSquadId`);
      }
      squadIds.add(codeworkSquadId);
      agentIds.add(codeworkAgentId);
    }
    normalized.push({
      codeworkAgentId,
      ...(codeworkSquadId === undefined ? {} : { codeworkSquadId }),
      workspaceId,
      ...(multicaAgentId === undefined ? {} : { multicaAgentId }),
      ...(multicaSquadId === undefined ? {} : { multicaSquadId }),
      ...(credentialEnvironmentVariable === undefined
        ? {}
        : { codeworkMcpCredentialEnvironmentVariable: credentialEnvironmentVariable }),
    });
  }
  return normalizationSuccess(normalized);
};

const normalizeTaskExecutionExtension = (
  value: MulticaTaskExecutionExtensionDraft,
): Normalization<CompositionMulticaRuntimeConfig["taskExecutionExtension"]> => {
  const command = value.command.trim();
  const cwd = trimmedOptional(value.cwd);
  const timeout = value.timeoutMs.trim();
  const isEmpty =
    command.length === 0 && value.args.length === 0 && cwd === undefined && timeout.length === 0;
  if (isEmpty) return normalizationSuccess(undefined);
  if (command.length === 0) {
    return invalid("invalid_task_execution_extension", "taskExecutionExtension.command");
  }
  let timeoutMs: number | undefined;
  if (timeout.length > 0) {
    const parsed = Number(timeout);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return invalid("invalid_task_execution_extension", "taskExecutionExtension.timeoutMs");
    }
    timeoutMs = parsed;
  }
  return normalizationSuccess({
    command,
    args: [...value.args],
    ...(cwd === undefined ? {} : { cwd }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
};

export const validateMulticaRuntimeDraft = (
  draft: MulticaRuntimeDraft,
): MulticaRuntimeDraftValidation => {
  let instanceId: ProviderInstanceId;
  try {
    instanceId = decodeProviderInstanceId(draft.instanceId);
  } catch {
    return invalid("invalid_instance_id", "instanceId");
  }
  const runtimeId = draft.runtimeId.trim();
  const daemonId = draft.daemonId.trim();
  const daemonRuntimeId = draft.daemonRuntimeId.trim();
  if (runtimeId.length === 0 || daemonId.length === 0 || daemonRuntimeId.length === 0) {
    return invalid("invalid_runtime_identity", "runtimeId");
  }
  const baseUrl = draft.baseUrl.trim();
  if (!isSafeMulticaRuntimeBaseUrl(baseUrl)) return invalid("invalid_base_url", "baseUrl");
  const taskMcpEndpoint = trimmedOptional(draft.taskMcpEndpoint);
  if (
    taskMcpEndpoint !== undefined &&
    (!isSafeMulticaTaskMcpEndpoint(taskMcpEndpoint) || !draft.supportsMcp)
  ) {
    return invalid("invalid_task_mcp_endpoint", "taskMcpEndpoint");
  }
  const environmentResult = normalizeEnvironment(
    draft.environment,
    instanceId,
    draft.originalInstanceId,
  );
  if (!environmentResult.ok) return environmentResult;
  const environment = environmentResult.value;
  const environmentVariables = new Map(environment.map((entry) => [entry.name, entry]));
  const headersResult = normalizeHeaders(draft.headers, environmentVariables);
  if (!headersResult.ok) return headersResult;
  const assigneeRoutesResult = normalizeAssigneeRoutes(
    draft.assigneeRoutes,
    environmentVariables,
    draft.supportsMcp,
    taskMcpEndpoint,
  );
  if (!assigneeRoutesResult.ok) return assigneeRoutesResult;
  const taskExecutionExtensionResult = normalizeTaskExecutionExtension(
    draft.taskExecutionExtension,
  );
  if (!taskExecutionExtensionResult.ok) return taskExecutionExtensionResult;
  const version = trimmedOptional(draft.version);
  const capabilities = Array.from(
    new Set(draft.capabilities.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
  try {
    const config = decodeMulticaConfig({
      schemaVersion: 1,
      enabled: draft.enabled,
      runtimeId,
      daemonId,
      daemonRuntimeId,
      baseUrl,
      headers: headersResult.value,
      assigneeRoutes: assigneeRoutesResult.value,
      ...(version === undefined ? {} : { version }),
      capabilities,
      supportsResume: draft.supportsResume,
      supportsMcp: draft.supportsMcp,
      ...(taskMcpEndpoint === undefined ? {} : { taskMcpEndpoint }),
      ...(taskExecutionExtensionResult.value === undefined
        ? {}
        : { taskExecutionExtension: taskExecutionExtensionResult.value }),
      supportsSquad: draft.supportsSquad,
      supportsLeader: draft.supportsLeader,
      supportsTaskGraph: draft.supportsTaskGraph,
    });
    return { ok: true, value: { instanceId, config, environment } };
  } catch {
    return invalid("invalid_config", "config");
  }
};

export type TeamRuntimeInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
};

export function teamRuntimeInstancesFromSettings(
  settings: Pick<UnifiedSettings, "providerInstances">,
): ReadonlyArray<TeamRuntimeInstance> {
  return Object.entries(settings.providerInstances ?? {})
    .filter(([, instance]) => instance.driver === "multica")
    .map(([instanceId, instance]) => ({
      instanceId: instanceId as ProviderInstanceId,
      instance,
    }))
    .toSorted((left, right) => String(left.instanceId).localeCompare(String(right.instanceId)));
}

export function buildTeamRuntimeSettingsPatch(
  settings: Pick<UnifiedSettings, "providerInstances">,
  originalInstanceId: string | null,
  save: MulticaRuntimeSave,
): Pick<UnifiedSettings, "providerInstances"> {
  const providerInstances = { ...settings.providerInstances };
  const original = originalInstanceId
    ? providerInstances[originalInstanceId as ProviderInstanceId]
    : undefined;
  if (originalInstanceId !== null)
    delete providerInstances[originalInstanceId as ProviderInstanceId];
  providerInstances[save.instanceId] = {
    ...(original?.driver === "multica" ? original : {}),
    driver: ProviderDriverKind.make("multica"),
    enabled: save.config.enabled,
    config: save.config,
    environment: save.environment,
  };
  return { providerInstances };
}

/** 仅提交本次团队修改，并携带打开编辑器时的版本，避免覆盖其它设备的配置。 */
export function buildTeamRuntimeSavePatch(
  settings: Pick<ServerSettings, "providerInstances">,
  originalInstanceId: string | null,
  expectedRevision: string | null,
  save: MulticaRuntimeSave,
): ServerSettingsPatch {
  const nextInstance = buildTeamRuntimeSettingsPatch(settings, originalInstanceId, save)
    .providerInstances[save.instanceId];
  if (nextInstance === undefined) throw new Error("未生成团队运行时实例。");
  return {
    providerInstances: { [save.instanceId]: nextInstance } as ServerSettings["providerInstances"],
    multicaProviderInstancePreconditions: [
      ...(originalInstanceId === null
        ? []
        : [{ instanceId: ProviderInstanceId.make(originalInstanceId), expectedRevision }]),
      ...(originalInstanceId === save.instanceId
        ? []
        : [{ instanceId: save.instanceId, expectedRevision: null }]),
    ],
  };
}
