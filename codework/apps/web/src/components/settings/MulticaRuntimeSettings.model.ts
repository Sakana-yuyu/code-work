import type {
  CompositionMulticaRuntimeConfig,
  ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
} from "@codework/contracts";

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
