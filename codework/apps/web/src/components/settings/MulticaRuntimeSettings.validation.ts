import {
  CompositionMulticaRuntimeConfig,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  type ProviderInstanceEnvironmentVariable,
} from "@codework/contracts";
import * as Schema from "effect/Schema";

import type {
  MulticaRuntimeAssigneeRouteDraft,
  MulticaRuntimeDraft,
  MulticaRuntimeDraftIssueCode,
  MulticaRuntimeDraftValidation,
  MulticaRuntimeHeaderDraft,
  MulticaTaskExecutionExtensionDraft,
} from "./MulticaRuntimeSettings.model";

type ValidationFailure = Extract<MulticaRuntimeDraftValidation, { readonly ok: false }>;
type Normalization<T> = { readonly ok: true; readonly value: T } | ValidationFailure;

const RESERVED_PROTOCOL_HEADERS = new Set([
  "accept",
  "content-type",
  "x-workspace-id",
  "x-idempotency-key",
]);
const SERVER_CREDENTIAL_HEADER_PATTERN =
  /^(authorization|proxy-authorization|api[-_]?key|x[-_]?api[-_]?key|token)$/iu;
const EXTENDED_CREDENTIAL_HEADER_PATTERN = /^x[-_].*(?:auth[-_]?token|[-_](?:key|token))$/iu;

const decodeMulticaConfig = Schema.decodeUnknownSync(CompositionMulticaRuntimeConfig);
const decodeProviderEnvironment = Schema.decodeUnknownSync(ProviderInstanceEnvironment);
const decodeProviderInstanceId = Schema.decodeUnknownSync(ProviderInstanceId);

const invalid = (code: MulticaRuntimeDraftIssueCode, path: string): ValidationFailure => ({
  ok: false,
  issue: { code, path },
});

const normalizationSuccess = <T>(value: T): Normalization<T> => ({ ok: true, value });

const trimmedOptional = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const isHttpUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
};

const isCredentialHeader = (headerName: string): boolean =>
  SERVER_CREDENTIAL_HEADER_PATTERN.test(headerName) ||
  // 覆盖 Server 最小正则之外的常见自定义凭据名，避免 UI 将 token/key 明文持久化。
  EXTENDED_CREDENTIAL_HEADER_PATTERN.test(headerName);

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

    normalized.push({
      name,
      value: value.value,
      sensitive: value.sensitive,
    });
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
    if (isCredentialHeader(headerName) && variable.sensitive !== true) {
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
        (credential.value.trim().length === 0 && credential.valueRedacted !== true)
      ) {
        return invalid(
          "invalid_assignee_route",
          `assigneeRoutes.${index}.codeworkMcpCredentialEnvironmentVariable`,
        );
      }
      if (!supportsMcp || taskMcpEndpoint !== undefined) {
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
  if (runtimeId.length === 0) return invalid("invalid_runtime_identity", "runtimeId");
  if (daemonId.length === 0) return invalid("invalid_runtime_identity", "daemonId");
  if (daemonRuntimeId.length === 0) {
    return invalid("invalid_runtime_identity", "daemonRuntimeId");
  }

  const baseUrl = draft.baseUrl.trim();
  if (!isHttpUrl(baseUrl)) return invalid("invalid_base_url", "baseUrl");

  const taskMcpEndpoint = trimmedOptional(draft.taskMcpEndpoint);
  if (taskMcpEndpoint !== undefined && !isHttpUrl(taskMcpEndpoint)) {
    return invalid("invalid_task_mcp_endpoint", "taskMcpEndpoint");
  }
  if (taskMcpEndpoint !== undefined && !draft.supportsMcp) {
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
