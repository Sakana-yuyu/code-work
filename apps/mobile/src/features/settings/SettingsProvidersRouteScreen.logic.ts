import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type AcpRegistryCatalogEntry,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@codework/contracts";

export type MobileProviderFieldKind = "text" | "password" | "switch";

export interface MobileProviderField {
  readonly key: string;
  readonly labelKey:
    | "providersMobile.binaryPath"
    | "providersMobile.homePath"
    | "providersMobile.shadowHomePath"
    | "providersMobile.launchArgs"
    | "providersMobile.apiEndpoint"
    | "providersMobile.serverUrl"
    | "providersMobile.serverPassword"
    | "providersMobile.autoCompactWindow"
    | "providersMobile.fallbackModel"
    | "providersMobile.maxTurns"
    | "providersMobile.routeThroughByok"
    | "providersMobile.command"
    | "providersMobile.authMethod"
    | "providersMobile.injectMcpServers"
    | "providersMobile.approvalMode";
  readonly kind: MobileProviderFieldKind;
  readonly defaultBooleanValue?: boolean;
  readonly defaultStringValue?: string;
  readonly clearWhenEmpty?: "omit" | "persist";
  readonly placeholderKey:
    | "providersMobile.binaryPathPlaceholder"
    | "providersMobile.homePathPlaceholder"
    | "providersMobile.shadowHomePathPlaceholder"
    | "providersMobile.launchArgsPlaceholder"
    | "providersMobile.apiEndpointPlaceholder"
    | "providersMobile.serverUrlPlaceholder"
    | "providersMobile.serverPasswordPlaceholder"
    | "providersMobile.autoCompactWindowPlaceholder"
    | "providersMobile.fallbackModelPlaceholder"
    | "providersMobile.maxTurnsPlaceholder"
    | "providersMobile.commandPlaceholder"
    | "providersMobile.authMethodPlaceholder"
    | "providersMobile.approvalModePlaceholder"
    | null;
}

export const MOBILE_PROVIDER_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "kimi",
  "antigravity",
  "opencode",
  "piAgent",
  "ompAgent",
  "zcodeAgent",
  "acpAgent",
] as const;

export type MobileProviderDriver = (typeof MOBILE_PROVIDER_DRIVERS)[number];

const FIELD = (
  key: MobileProviderField["key"],
  labelKey: MobileProviderField["labelKey"],
  placeholderKey: MobileProviderField["placeholderKey"],
  kind: MobileProviderFieldKind = "text",
): MobileProviderField => ({ key, labelKey, placeholderKey, kind });

const PROVIDER_FIELDS: Readonly<Record<MobileProviderDriver, ReadonlyArray<MobileProviderField>>> =
  {
    codex: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("homePath", "providersMobile.homePath", "providersMobile.homePathPlaceholder"),
      FIELD(
        "shadowHomePath",
        "providersMobile.shadowHomePath",
        "providersMobile.shadowHomePathPlaceholder",
      ),
      FIELD("launchArgs", "providersMobile.launchArgs", "providersMobile.launchArgsPlaceholder"),
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
    ],
    claudeAgent: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("homePath", "providersMobile.homePath", "providersMobile.homePathPlaceholder"),
      FIELD(
        "autoCompactWindow",
        "providersMobile.autoCompactWindow",
        "providersMobile.autoCompactWindowPlaceholder",
      ),
      FIELD(
        "fallbackModel",
        "providersMobile.fallbackModel",
        "providersMobile.fallbackModelPlaceholder",
      ),
      FIELD("maxTurns", "providersMobile.maxTurns", "providersMobile.maxTurnsPlaceholder"),
      FIELD("launchArgs", "providersMobile.launchArgs", "providersMobile.launchArgsPlaceholder"),
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
    ],
    cursor: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("apiEndpoint", "providersMobile.apiEndpoint", "providersMobile.apiEndpointPlaceholder"),
    ],
    grok: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
    ],
    kimi: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
    ],
    antigravity: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
    ],
    opencode: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("serverUrl", "providersMobile.serverUrl", "providersMobile.serverUrlPlaceholder"),
      FIELD(
        "serverPassword",
        "providersMobile.serverPassword",
        "providersMobile.serverPasswordPlaceholder",
        "password",
      ),
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
    ],
    piAgent: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("launchArgs", "providersMobile.launchArgs", "providersMobile.launchArgsPlaceholder"),
    ],
    ompAgent: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("launchArgs", "providersMobile.launchArgs", "providersMobile.launchArgsPlaceholder"),
      FIELD(
        "approvalMode",
        "providersMobile.approvalMode",
        "providersMobile.approvalModePlaceholder",
      ),
    ],
    zcodeAgent: [
      FIELD("binaryPath", "providersMobile.binaryPath", "providersMobile.binaryPathPlaceholder"),
      FIELD("launchArgs", "providersMobile.launchArgs", "providersMobile.launchArgsPlaceholder"),
    ],
    acpAgent: [
      FIELD("command", "providersMobile.command", "providersMobile.commandPlaceholder"),
      {
        ...FIELD(
          "authMethodId",
          "providersMobile.authMethod",
          "providersMobile.authMethodPlaceholder",
        ),
        clearWhenEmpty: "persist",
        defaultStringValue: "login",
      },
      FIELD("routeThroughByok", "providersMobile.routeThroughByok", null, "switch"),
      {
        ...FIELD("supportsMcpServers", "providersMobile.injectMcpServers", null, "switch"),
        defaultBooleanValue: true,
      },
    ],
  };

export function providerFields(driver: string): ReadonlyArray<MobileProviderField> {
  return PROVIDER_FIELDS[driver as MobileProviderDriver] ?? [];
}

export function providerSupportsSharedRoute(driver: string): boolean {
  return (
    driver === "codex" ||
    driver === "claudeAgent" ||
    driver === "grok" ||
    driver === "opencode" ||
    driver === "kimi" ||
    driver === "acpAgent"
  );
}

/** Fields shown under Connection for agents that share the web gateway pattern. */
export function providerConnectionFields(driver: string): ReadonlyArray<MobileProviderField> {
  return providerFields(driver).filter((field) => field.key === "routeThroughByok");
}

/** Primary install/login fields (excludes connection + advanced). */
export function providerPrimaryFields(driver: string): ReadonlyArray<MobileProviderField> {
  return providerFields(driver).filter(
    (field) => field.key !== "routeThroughByok" && field.key !== "supportsMcpServers",
  );
}

/** Optional advanced toggles (MCP injection, etc.). */
export function providerAdvancedFields(driver: string): ReadonlyArray<MobileProviderField> {
  return providerFields(driver).filter((field) => field.key === "supportsMcpServers");
}

export function providerDisplayNameKey(
  driver: string,
): "codex" | "claude" | "cursor" | "grok" | "opencode" | null {
  switch (driver) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claude";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
    case "antigravity":
      return null;
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

export function readProviderConfigRecord(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === "object" && !Array.isArray(config)
    ? { ...(config as Record<string, unknown>) }
    : {};
}

export function readProviderConfigString(config: unknown, key: string, defaultValue = ""): string {
  const value = readProviderConfigRecord(config)[key];
  return typeof value === "string" ? value : defaultValue;
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  const value = readProviderConfigRecord(config)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

export function updateProviderConfig(
  config: unknown,
  field: MobileProviderField,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const next = readProviderConfigRecord(config);
  if (typeof value === "boolean") {
    if (value === (field.defaultBooleanValue ?? false)) delete next[field.key];
    else next[field.key] = value;
  } else if (value.trim().length === 0 && field.clearWhenEmpty !== "persist") {
    delete next[field.key];
  } else {
    next[field.key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export interface MobileProviderRow {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly instance: ProviderInstanceConfig;
  readonly isDefault: boolean;
  readonly known: boolean;
}

function legacyInstance(
  driver: MobileProviderDriver,
  legacy: unknown,
): ProviderInstanceConfig | undefined {
  if (legacy === null || typeof legacy !== "object" || Array.isArray(legacy)) return undefined;
  const config = { ...(legacy as Record<string, unknown>) };
  const enabled = config.enabled;
  delete config.enabled;
  return {
    driver: ProviderDriverKind.make(driver),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function buildMobileProviderRows(
  settings: ServerSettings,
): ReadonlyArray<MobileProviderRow> {
  const rows: MobileProviderRow[] = [];
  const seen = new Set<string>();

  // The legacy `providers` struct predates pi/omp/acp; those drivers only ever
  // exist as `providerInstances` entries, so their legacy lookup is undefined.
  const legacyProviders = settings.providers as Readonly<
    Partial<Record<MobileProviderDriver, unknown>>
  >;

  for (const driver of MOBILE_PROVIDER_DRIVERS) {
    const brandedDriver = ProviderDriverKind.make(driver);
    const instanceId = defaultInstanceIdForDriver(brandedDriver);
    const explicit = settings.providerInstances?.[instanceId];
    const instance = explicit ?? legacyInstance(driver, legacyProviders[driver]);
    if (instance === undefined) continue;
    rows.push({ instanceId, driver, instance, isDefault: true, known: true });
    seen.add(String(instanceId));
  }

  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (seen.has(rawId)) continue;
    rows.push({
      instanceId: ProviderInstanceId.make(rawId),
      driver: String(instance.driver),
      instance,
      isDefault: false,
      // BYOK 使用独立的移动端编辑页；这里仍标记为已知驱动，避免误报为缺失。
      known:
        String(instance.driver) === "byok" || providerFields(String(instance.driver)).length > 0,
    });
  }
  return rows;
}

export function makeMobileProviderInstance(
  driver: MobileProviderDriver,
  displayName: string,
): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
  };
}

/** 移动端一次显示的目录行数上限，其余条目通过搜索访问。 */
export const MOBILE_ACP_CATALOG_VISIBLE_LIMIT = 12;

/** 与网页添加向导一致的常用智能体快捷入口；选择后仍须在目录中确认版本/命令。 */
export const MOBILE_ACP_QUICK_ENTRIES = [
  {
    id: "github-copilot-cli",
    labelKey: "providersMobile.acpQuickCopilot",
    authMethodId: "copilot-login",
    search: "github-copilot-cli",
  },
  {
    id: "gemini",
    labelKey: "providersMobile.acpQuickGemini",
    authMethodId: "oauth-personal",
    search: "gemini",
  },
  {
    id: "cline",
    labelKey: "providersMobile.acpQuickCline",
    authMethodId: "",
    search: "cline",
  },
  {
    id: "qwen",
    labelKey: "providersMobile.acpQuickQwen",
    authMethodId: "openai",
    search: "qwen",
  },
] as const;

export function filterAcpCatalogEntries(
  entries: ReadonlyArray<AcpRegistryCatalogEntry>,
  query: string,
): ReadonlyArray<AcpRegistryCatalogEntry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter((entry) =>
    `${entry.name} ${entry.description} ${entry.id}`.toLowerCase().includes(needle),
  );
}

/**
 * 与网页保存相同的目录命令、认证方式和公开环境参数；仅显式关闭时存储 MCP 覆盖。
 */
export function makeMobileAcpCatalogInstance(
  entry: AcpRegistryCatalogEntry,
  displayName: string,
): ProviderInstanceConfig | undefined {
  if (entry.command === null) return undefined;
  const config: Record<string, unknown> = {
    command: entry.command,
    authMethodId: entry.authMethodId ?? "login",
  };
  if (entry.supportsMcpServers === false) config.supportsMcpServers = false;
  return {
    driver: ProviderDriverKind.make("acpAgent"),
    enabled: true,
    displayName: displayName.trim() || entry.name,
    config,
    ...(entry.environment && entry.environment.length > 0
      ? { environment: entry.environment }
      : {}),
  };
}

export function suggestAcpCatalogInstanceId(
  entryId: string,
  existingIds: ReadonlySet<string>,
): string {
  const slug = entryId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const base = `acp-${slug || "agent"}`;
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function materializeProviderInstances(
  settings: ServerSettings,
): Record<ProviderInstanceId, ProviderInstanceConfig> {
  return Object.fromEntries(
    buildMobileProviderRows(settings).map((row) => [row.instanceId, row.instance]),
  ) as Record<ProviderInstanceId, ProviderInstanceConfig>;
}

export function providerEnabled(instance: ProviderInstanceConfig): boolean {
  return resolveProviderInstanceEnabled(instance);
}
