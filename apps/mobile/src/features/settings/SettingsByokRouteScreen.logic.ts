import {
  ProviderDriverKind,
  ProviderInstanceId as ProviderInstanceIdSchema,
  type ByokDelegationConfig,
  type ByokModelAdapter,
  type ByokPromptTemplateConfig,
  type ByokSupplierCatalogEntry,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@codework/contracts";
import { canRetainByokAdapterCredentials } from "@codework/client-runtime/byok/credential-scope";
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

export const DEFAULT_BYOK_DELEGATION: ByokDelegationConfig = {
  enabled: false,
  maxConcurrency: 4,
  queueTimeoutMs: 30_000,
  executionTimeoutMs: 120_000,
  modelGroups: [],
  executorCommand: "",
  executorEnvironmentVariables: [],
  executors: [],
  executorFailoverLimit: 3,
  visionDelegation: { enabled: false, visionModelId: "", mode: "auto" },
  supervision: {
    enabled: false,
    supervisorModelId: "",
    reviewerModelId: "",
    maxCorrections: 2,
    maxRetries: 1,
    maxRounds: 8,
    allowReassign: true,
    allowEscalate: true,
    strictUnavailable: false,
  },
  subagentProfiles: [],
};

export const DEFAULT_BYOK_PROMPT_TEMPLATE: ByokPromptTemplateConfig = {
  enabled: false,
  softwareChineseEnabled: false,
  mode: "append",
  selectedTemplate: "",
  customEnabled: false,
  customContent: "",
  sourceUrl: "",
};

export type MobileByokAdapterForm = {
  readonly displayName: string;
  readonly groupName: string;
  readonly supplierID: string;
  readonly protocol: ByokModelAdapter["protocol"];
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly balanceProfile: NonNullable<ByokModelAdapter["balanceProfile"]>;
  readonly balanceAccessToken: string;
  readonly balanceUserID: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stringValue = (value: unknown): string => (typeof value === "string" ? value : "");

const optionalString = (value: unknown): string | undefined => {
  const normalized = stringValue(value).trim();
  return normalized.length > 0 ? normalized : undefined;
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function readByokConfigRecord(config: unknown): Record<string, unknown> {
  return isRecord(config) ? config : {};
}

export function readByokModelAdapters(config: unknown): ReadonlyArray<ByokModelAdapter> {
  const entries = readByokConfigRecord(config)["adapters"];
  if (!Array.isArray(entries)) return [];

  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = stringValue(entry["id"]).trim();
    const protocol = entry["protocol"];
    const baseURL = stringValue(entry["baseURL"]).trim();
    const modelId = stringValue(entry["modelId"]).trim();
    if (
      id.length === 0 ||
      baseURL.length === 0 ||
      modelId.length === 0 ||
      (protocol !== "openai" && protocol !== "anthropic" && protocol !== "gemini")
    ) {
      return [];
    }

    const adapter: ByokModelAdapter = {
      id,
      displayName: stringValue(entry["displayName"]),
      ...(optionalString(entry["groupName"]) === undefined
        ? {}
        : { groupName: optionalString(entry["groupName"]) }),
      protocol,
      baseURL,
      apiKey: stringValue(entry["apiKey"]),
      ...(entry["apiKeyRedacted"] === true ? { apiKeyRedacted: true } : {}),
      ...(optionalString(entry["apiKeySourceAdapterId"]) === undefined
        ? {}
        : { apiKeySourceAdapterId: optionalString(entry["apiKeySourceAdapterId"]) }),
      modelId,
      contextWindowTokens:
        optionalNumber(entry["contextWindowTokens"]) ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      ...(typeof entry["maxOutputTokens"] === "number" &&
      Number.isSafeInteger(entry["maxOutputTokens"]) &&
      entry["maxOutputTokens"] > 0
        ? { maxOutputTokens: entry["maxOutputTokens"] }
        : {}),
      ...(optionalString(entry["supplierID"]) === undefined
        ? {}
        : { supplierID: optionalString(entry["supplierID"]) }),
      ...(optionalString(entry["modelCatalogURL"]) === undefined
        ? {}
        : { modelCatalogURL: optionalString(entry["modelCatalogURL"]) }),
      ...(Array.isArray(entry["modelCatalogURLs"])
        ? {
            modelCatalogURLs: entry["modelCatalogURLs"].flatMap((value) =>
              typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [],
            ),
          }
        : {}),
      ...(entry["modelCatalogStatus"] === "openai_models" ||
      entry["modelCatalogStatus"] === "gemini_models" ||
      entry["modelCatalogStatus"] === "custom_url" ||
      entry["modelCatalogStatus"] === "manual_only"
        ? { modelCatalogStatus: entry["modelCatalogStatus"] }
        : {}),
      ...(typeof entry["appendModelCatalogCandidates"] === "boolean"
        ? { appendModelCatalogCandidates: entry["appendModelCatalogCandidates"] }
        : {}),
      ...(entry["balanceProfile"] === "auto" ||
      entry["balanceProfile"] === "general" ||
      entry["balanceProfile"] === "newapi" ||
      entry["balanceProfile"] === "none"
        ? { balanceProfile: entry["balanceProfile"] }
        : {}),
      balanceAccessToken: stringValue(entry["balanceAccessToken"]),
      ...(entry["balanceAccessTokenRedacted"] === true ? { balanceAccessTokenRedacted: true } : {}),
      ...(optionalString(entry["balanceUserID"]) === undefined
        ? {}
        : { balanceUserID: optionalString(entry["balanceUserID"]) }),
      // 自定义请求头是服务端密钥：仅回传空串与标记，编辑时原样保留。
      customHeaders: stringValue(entry["customHeaders"]),
      ...(entry["customHeadersRedacted"] === true ? { customHeadersRedacted: true } : {}),
    };
    return [adapter];
  });
}

export function byokBenchmarkFingerprint(
  adapter: Pick<ByokModelAdapter, "protocol" | "baseURL" | "modelId">,
): string {
  return `${adapter.protocol}\u0000${adapter.baseURL.trim()}\u0000${adapter.modelId.trim()}`;
}

export function readByokPromptTemplate(config: unknown): ByokPromptTemplateConfig {
  const value = readByokConfigRecord(config)["promptTemplate"];
  if (!isRecord(value)) return DEFAULT_BYOK_PROMPT_TEMPLATE;
  return {
    ...DEFAULT_BYOK_PROMPT_TEMPLATE,
    enabled: value["enabled"] === true,
    softwareChineseEnabled: value["softwareChineseEnabled"] === true,
    mode: value["mode"] === "replace" ? "replace" : "append",
    selectedTemplate: stringValue(value["selectedTemplate"]),
    customEnabled: value["customEnabled"] === true,
    customContent: stringValue(value["customContent"]),
    sourceUrl: stringValue(value["sourceUrl"]),
  };
}

export function readByokDelegation(config: unknown): ByokDelegationConfig {
  const value = readByokConfigRecord(config)["delegation"];
  if (!isRecord(value)) return DEFAULT_BYOK_DELEGATION;
  const maxConcurrency = Number(value["maxConcurrency"]);
  return {
    ...DEFAULT_BYOK_DELEGATION,
    enabled: value["enabled"] === true,
    maxConcurrency: Number.isInteger(maxConcurrency)
      ? Math.max(1, Math.min(16, maxConcurrency))
      : DEFAULT_BYOK_DELEGATION.maxConcurrency,
    queueTimeoutMs: Number.isInteger(Number(value["queueTimeoutMs"]))
      ? Math.max(1_000, Number(value["queueTimeoutMs"]))
      : DEFAULT_BYOK_DELEGATION.queueTimeoutMs,
    executionTimeoutMs: Number.isInteger(Number(value["executionTimeoutMs"]))
      ? Math.max(1_000, Number(value["executionTimeoutMs"]))
      : DEFAULT_BYOK_DELEGATION.executionTimeoutMs,
    modelGroups: Array.isArray(value["modelGroups"])
      ? (value["modelGroups"] as ByokDelegationConfig["modelGroups"])
      : [],
    executorCommand: stringValue(value["executorCommand"]),
    executorEnvironmentVariables: Array.isArray(value["executorEnvironmentVariables"])
      ? value["executorEnvironmentVariables"].flatMap((item) =>
          typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
        )
      : [],
    executors: Array.isArray(value["executors"])
      ? (value["executors"] as ByokDelegationConfig["executors"])
      : [],
    executorFailoverLimit: Number.isInteger(Number(value["executorFailoverLimit"]))
      ? Math.max(1, Math.min(5, Number(value["executorFailoverLimit"])))
      : DEFAULT_BYOK_DELEGATION.executorFailoverLimit,
    visionDelegation: isRecord(value["visionDelegation"])
      ? {
          ...DEFAULT_BYOK_DELEGATION.visionDelegation,
          enabled: value["visionDelegation"]["enabled"] === true,
          visionModelId: stringValue(value["visionDelegation"]["visionModelId"]),
          mode:
            value["visionDelegation"]["mode"] === "describe" ||
            value["visionDelegation"]["mode"] === "ocr"
              ? value["visionDelegation"]["mode"]
              : "auto",
        }
      : DEFAULT_BYOK_DELEGATION.visionDelegation,
    supervision: isRecord(value["supervision"])
      ? { ...DEFAULT_BYOK_DELEGATION.supervision, ...value["supervision"] }
      : DEFAULT_BYOK_DELEGATION.supervision,
    subagentProfiles: Array.isArray(value["subagentProfiles"])
      ? (value["subagentProfiles"] as ByokDelegationConfig["subagentProfiles"])
      : [],
  };
}

export function adapterFormFromAdapter(adapter?: ByokModelAdapter): MobileByokAdapterForm {
  return {
    displayName: adapter?.displayName ?? "",
    groupName: adapter?.groupName ?? "",
    supplierID: adapter?.supplierID ?? "",
    protocol: adapter?.protocol ?? "openai",
    baseURL: adapter?.baseURL ?? "",
    apiKey: "",
    modelId: adapter?.modelId ?? "",
    contextWindowTokens: String(adapter?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens: adapter?.maxOutputTokens !== undefined ? String(adapter.maxOutputTokens) : "",
    balanceProfile: adapter?.balanceProfile ?? "auto",
    balanceAccessToken: "",
    balanceUserID: adapter?.balanceUserID ?? "",
  };
}

/** 切换渠道后须重新选择模型，避免把旧供应商的模型请求路由到新地址。 */
export function supplierSelectionPatch(
  supplier: Pick<ByokSupplierCatalogEntry, "id" | "protocol" | "defaultBaseURL">,
): Partial<MobileByokAdapterForm> {
  return {
    supplierID: supplier.id === "custom" ? "" : supplier.id,
    protocol: supplier.protocol,
    baseURL: supplier.defaultBaseURL,
    apiKey: "",
    modelId: "",
    displayName: "",
    contextWindowTokens: String(DEFAULT_CONTEXT_WINDOW_TOKENS),
    maxOutputTokens: "",
    balanceProfile: "auto",
    balanceAccessToken: "",
    balanceUserID: "",
  };
}

export function buildByokAdapter(
  form: MobileByokAdapterForm,
  adapterId: string,
  existing?: ByokModelAdapter,
): ByokModelAdapter {
  const {
    groupName: _oldGroupName,
    supplierID: _oldSupplierID,
    apiKeyRedacted: _oldApiKeyRedacted,
    apiKeySourceAdapterId: _oldApiKeySourceAdapterId,
    balanceProfile: _oldBalanceProfile,
    balanceAccessTokenRedacted: _oldBalanceAccessTokenRedacted,
    balanceUserID: _oldBalanceUserID,
    maxOutputTokens: _oldMaxOutputTokens,
    customHeaders: _oldCustomHeaders,
    customHeadersRedacted: _oldCustomHeadersRedacted,
    modelCatalogURL: _oldModelCatalogURL,
    modelCatalogURLs: _oldModelCatalogURLs,
    modelCatalogStatus: _oldModelCatalogStatus,
    appendModelCatalogCandidates: _oldAppendModelCatalogCandidates,
    ...preserved
  } = existing ?? {};
  const apiKey = form.apiKey.trim();
  const balanceAccessToken = form.balanceAccessToken.trim();
  const maxOutputTokensRaw = form.maxOutputTokens.trim();
  const maxOutputTokens = maxOutputTokensRaw === "" ? undefined : Number(maxOutputTokensRaw);
  const retainsStoredCredentials = canRetainByokAdapterCredentials(existing, {
    ...(form.supplierID.trim() ? { supplierID: form.supplierID.trim() } : {}),
    protocol: form.protocol,
    baseURL: form.baseURL,
  });
  return {
    ...preserved,
    id: adapterId,
    displayName: form.displayName.trim() || form.modelId.trim(),
    ...(form.groupName.trim() ? { groupName: form.groupName.trim() } : {}),
    protocol: form.protocol,
    baseURL: form.baseURL.trim(),
    apiKey,
    ...(apiKey.length === 0 && retainsStoredCredentials && existing?.apiKeyRedacted === true
      ? { apiKeyRedacted: true }
      : {}),
    ...(apiKey.length === 0 && retainsStoredCredentials && _oldApiKeySourceAdapterId
      ? { apiKeySourceAdapterId: _oldApiKeySourceAdapterId }
      : {}),
    modelId: form.modelId.trim(),
    contextWindowTokens: Number(form.contextWindowTokens.trim()),
    // 移动端不编辑自定义请求头：编辑已有通道时原样保留（密钥不出服务端）。
    customHeaders: retainsStoredCredentials ? (_oldCustomHeaders ?? "") : "",
    ...(retainsStoredCredentials && _oldCustomHeadersRedacted
      ? { customHeadersRedacted: true }
      : {}),
    ...(maxOutputTokens !== undefined && Number.isInteger(maxOutputTokens) && maxOutputTokens > 0
      ? { maxOutputTokens }
      : {}),
    ...(form.supplierID.trim() ? { supplierID: form.supplierID.trim() } : {}),
    ...(retainsStoredCredentials && _oldModelCatalogURL
      ? { modelCatalogURL: _oldModelCatalogURL }
      : {}),
    ...(retainsStoredCredentials && _oldModelCatalogURLs
      ? { modelCatalogURLs: _oldModelCatalogURLs }
      : {}),
    ...(retainsStoredCredentials && _oldModelCatalogStatus
      ? { modelCatalogStatus: _oldModelCatalogStatus }
      : {}),
    ...(retainsStoredCredentials && _oldAppendModelCatalogCandidates !== undefined
      ? { appendModelCatalogCandidates: _oldAppendModelCatalogCandidates }
      : {}),
    ...(form.balanceProfile !== "auto" ? { balanceProfile: form.balanceProfile } : {}),
    balanceAccessToken,
    ...(balanceAccessToken.length === 0 &&
    retainsStoredCredentials &&
    existing?.balanceAccessTokenRedacted === true
      ? { balanceAccessTokenRedacted: true }
      : {}),
    ...(form.balanceUserID.trim() ? { balanceUserID: form.balanceUserID.trim() } : {}),
  };
}

export function createByokProviderInstance(
  instanceId: string,
  displayName: string,
): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make("byok"),
    displayName: displayName.trim() || instanceId,
    enabled: true,
    config: {
      enabled: true,
      adapters: [],
      promptTemplate: DEFAULT_BYOK_PROMPT_TEMPLATE,
      delegation: DEFAULT_BYOK_DELEGATION,
    },
  };
}

export function normalizeByokInstanceId(value: string): ProviderInstanceId | null {
  const normalized = value.trim();
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(normalized)
    ? ProviderInstanceIdSchema.make(normalized)
    : null;
}

export function patchByokConfig(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  return { ...readByokConfigRecord(config), [key]: value };
}
