import {
  CompositionIdeRuntimeConfig,
  type CompositionIdeRuntimeProfile,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@codework/contracts";
import * as Schema from "effect/Schema";
import { t } from "~/i18n/runtime";

export type IdeSessionHeaderDraft = {
  readonly headerName: string;
  readonly environmentVariable: string;
};

export type IdeSessionDraft = {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly profile: CompositionIdeRuntimeProfile;
  readonly url: string;
  readonly headers: ReadonlyArray<IdeSessionHeaderDraft>;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly enabled: boolean;
  readonly openTimeoutMs: string;
  readonly requestTimeoutMs: string;
  readonly reconnectDelaysMs: string;
};

export const IDE_SESSION_PROFILES: ReadonlyArray<{
  readonly value: CompositionIdeRuntimeProfile;
  readonly label: string;
}> = [
  {
    value: "cursor_ide",
    get label() {
      return t("cursorIde");
    },
  },
  {
    value: "vscode_ide",
    get label() {
      return t("vsCode");
    },
  },
  {
    value: "browser_mcp",
    get label() {
      return t("browserMcp");
    },
  },
];

const IDE_INSTANCE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const decodeIdeConfig = Schema.decodeUnknownSync(CompositionIdeRuntimeConfig);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const parseOptionalPositiveInteger = (value: string): number | undefined | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const parseReconnectDelays = (value: string): ReadonlyArray<number> | undefined | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(/[\s,]+/).filter(Boolean);
  const parsed = parts.map((part) => Number(part));
  return parsed.every((delay) => Number.isSafeInteger(delay) && delay >= 0) ? parsed : null;
};

const validWebSocketUrl = (value: string): boolean => {
  try {
    const protocol = new URL(value.trim()).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
};

const normalizeEnvironment = (
  values: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> | null => {
  const names = new Set<string>();
  const normalized: ProviderInstanceEnvironmentVariable[] = [];
  for (const value of values) {
    const name = value.name.trim();
    if (name.length === 0) continue;
    if (!ENVIRONMENT_VARIABLE_PATTERN.test(name) || names.has(name)) return null;
    names.add(name);
    normalized.push({
      ...value,
      name,
      value: value.value,
      ...(value.valueRedacted === undefined ? {} : { valueRedacted: value.valueRedacted }),
    });
  }
  return normalized;
};

const normalizeHeaders = (
  values: ReadonlyArray<IdeSessionHeaderDraft>,
): ReadonlyArray<IdeSessionHeaderDraft> | null => {
  const names = new Set<string>();
  const normalized: IdeSessionHeaderDraft[] = [];
  for (const value of values) {
    const headerName = value.headerName.trim();
    const environmentVariable = value.environmentVariable.trim();
    if (headerName.length === 0 && environmentVariable.length === 0) continue;
    if (headerName.length === 0 || environmentVariable.length === 0) return null;
    const normalizedName = headerName.toLowerCase();
    if (names.has(normalizedName)) return null;
    names.add(normalizedName);
    normalized.push({ headerName, environmentVariable });
  }
  return normalized;
};

export type IdeSessionSave = {
  readonly instanceId: string;
  readonly config: typeof CompositionIdeRuntimeConfig.Type;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
};

export const configFromIdeSessionDraft = (draft: IdeSessionDraft): IdeSessionSave | null => {
  const instanceId = draft.instanceId.trim();
  const sessionId = draft.sessionId.trim();
  const url = draft.url.trim();
  if (!IDE_INSTANCE_ID_PATTERN.test(instanceId) || sessionId.length === 0) return null;
  if (!validWebSocketUrl(url)) return null;

  const headers = normalizeHeaders(draft.headers);
  const environment = normalizeEnvironment(draft.environment);
  if (headers === null || environment === null) return null;
  const environmentNames = new Set(environment.map((entry) => entry.name));
  if (headers.some((header) => !environmentNames.has(header.environmentVariable.trim()))) {
    return null;
  }

  const openTimeoutMs = parseOptionalPositiveInteger(draft.openTimeoutMs);
  const requestTimeoutMs = parseOptionalPositiveInteger(draft.requestTimeoutMs);
  const reconnectDelaysMs = parseReconnectDelays(draft.reconnectDelaysMs);
  if (openTimeoutMs === null || requestTimeoutMs === null || reconnectDelaysMs === null)
    return null;

  return {
    instanceId,
    config: {
      schemaVersion: 1,
      enabled: draft.enabled,
      sessionId,
      profile: draft.profile,
      url,
      headers,
      ...(openTimeoutMs === undefined ? {} : { openTimeoutMs }),
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
      ...(reconnectDelaysMs === undefined ? {} : { reconnectDelaysMs }),
    },
    environment,
  };
};

export const formFromIdeInstance = (
  instanceId: string,
  instance: ProviderInstanceConfig,
): IdeSessionDraft | null => {
  const record = asRecord(instance.config);
  if (record === undefined) return null;
  try {
    const config = decodeIdeConfig(record);
    return {
      instanceId,
      sessionId: config.sessionId,
      profile: config.profile,
      url: config.url,
      headers: config.headers,
      environment: instance.environment ?? [],
      enabled: instance.enabled ?? config.enabled,
      openTimeoutMs: config.openTimeoutMs === undefined ? "" : String(config.openTimeoutMs),
      requestTimeoutMs:
        config.requestTimeoutMs === undefined ? "" : String(config.requestTimeoutMs),
      reconnectDelaysMs:
        config.reconnectDelaysMs === undefined ? "" : config.reconnectDelaysMs.join(", "),
    };
  } catch {
    return null;
  }
};

export const emptyIdeSessionDraft = (instanceId = "ide_local"): IdeSessionDraft => ({
  instanceId,
  sessionId: "",
  profile: "cursor_ide",
  url: "ws://127.0.0.1:4111/t3/ide",
  headers: [{ headerName: "Authorization", environmentVariable: "IDE_TOKEN" }],
  environment: [{ name: "IDE_TOKEN", value: "", sensitive: true }],
  enabled: true,
  openTimeoutMs: "15000",
  requestTimeoutMs: "10000",
  reconnectDelaysMs: "250, 1000, 3000",
});
