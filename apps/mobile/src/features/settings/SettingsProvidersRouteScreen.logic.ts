import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
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
    | "providersMobile.routeThroughByok";
  readonly kind: MobileProviderFieldKind;
  readonly placeholderKey:
    | "providersMobile.binaryPathPlaceholder"
    | "providersMobile.homePathPlaceholder"
    | "providersMobile.shadowHomePathPlaceholder"
    | "providersMobile.launchArgsPlaceholder"
    | "providersMobile.apiEndpointPlaceholder"
    | "providersMobile.serverUrlPlaceholder"
    | "providersMobile.serverPasswordPlaceholder"
    | "providersMobile.autoCompactWindowPlaceholder"
    | null;
}

export const MOBILE_PROVIDER_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
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
  };

export function providerFields(driver: string): ReadonlyArray<MobileProviderField> {
  return PROVIDER_FIELDS[driver as MobileProviderDriver] ?? [];
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

export function readProviderConfigString(config: unknown, key: string): string {
  const value = readProviderConfigRecord(config)[key];
  return typeof value === "string" ? value : "";
}

export function readProviderConfigBoolean(config: unknown, key: string): boolean {
  return readProviderConfigRecord(config)[key] === true;
}

export function updateProviderConfig(
  config: unknown,
  field: MobileProviderField,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const next = readProviderConfigRecord(config);
  if (typeof value === "boolean") {
    if (!value) delete next[field.key];
    else next[field.key] = true;
  } else if (value.trim().length === 0) {
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

  for (const driver of MOBILE_PROVIDER_DRIVERS) {
    const brandedDriver = ProviderDriverKind.make(driver);
    const instanceId = defaultInstanceIdForDriver(brandedDriver);
    const explicit = settings.providerInstances?.[instanceId];
    const instance = explicit ?? legacyInstance(driver, settings.providers[driver]);
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
