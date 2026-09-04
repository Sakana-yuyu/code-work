import type {
  CompositionMcpRuntimeServerConfig,
  CompositionMcpSecretValue,
  CompositionMcpServerId,
  CompositionMcpTransport,
} from "@codework/contracts";

export type MobileMcpSecretDraft = CompositionMcpSecretValue;

export interface MobileMcpForm {
  readonly serverId: string;
  readonly name: string;
  readonly transport: CompositionMcpTransport;
  readonly command: string;
  readonly args: string;
  readonly cwd: string;
  readonly url: string;
  readonly headers: ReadonlyArray<MobileMcpSecretDraft>;
  readonly environment: ReadonlyArray<MobileMcpSecretDraft>;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly trustFingerprint: string;
}

const MCP_SERVER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const MCP_TRANSPORTS: ReadonlyArray<CompositionMcpTransport> = ["stdio", "http", "sse"];

export function emptyMcpForm(): MobileMcpForm {
  return {
    serverId: "",
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    headers: [],
    environment: [],
    enabled: true,
    trusted: false,
    trustFingerprint: "",
  };
}

export function formFromMcpConfig(
  serverId: string,
  config: CompositionMcpRuntimeServerConfig,
): MobileMcpForm {
  return {
    serverId,
    name: config.name,
    transport: config.transport,
    command: config.command ?? "",
    args: config.args.join("\n"),
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: config.headers.map((entry) => ({ ...entry })),
    environment: config.environment.map((entry) => ({ ...entry })),
    enabled: config.enabled,
    trusted: config.trusted,
    trustFingerprint: config.trustFingerprint ?? "",
  };
}

export function isValidMcpServerId(value: string): value is CompositionMcpServerId {
  return MCP_SERVER_ID_PATTERN.test(value.trim());
}

function normalizeSecrets(entries: ReadonlyArray<MobileMcpSecretDraft>) {
  return entries.flatMap((entry) => {
    const name = entry.name.trim();
    if (name.length === 0) return [];
    const value = entry.value.trim();
    const { valueRedacted: _oldValueRedacted, ...preserved } = entry;
    return [
      {
        ...preserved,
        name,
        value,
        ...(value.length === 0 && entry.valueRedacted === true ? { valueRedacted: true } : {}),
      },
    ];
  });
}

export function configFromMcpForm(form: MobileMcpForm): CompositionMcpRuntimeServerConfig | null {
  const serverId = form.serverId.trim();
  const name = form.name.trim();
  const command = form.command.trim();
  const url = form.url.trim();
  if (!isValidMcpServerId(serverId) || name.length === 0) return null;
  if (form.transport === "stdio" ? command.length === 0 : url.length === 0) return null;

  const args = form.args
    .split(/\r?\n/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
  return {
    schemaVersion: 1,
    name,
    transport: form.transport,
    args,
    ...(form.transport === "stdio"
      ? { command, ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}) }
      : { url }),
    headers: normalizeSecrets(form.headers),
    environment: normalizeSecrets(form.environment),
    enabled: form.enabled,
    trusted: form.trusted,
    ...(form.trustFingerprint.trim() ? { trustFingerprint: form.trustFingerprint.trim() } : {}),
  };
}
