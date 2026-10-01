import type {
  AcpRegistryCatalogEntry,
  AcpRegistryCatalogResult,
  ProviderInstanceEnvironment,
  ServerProvider,
} from "@codework/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import bundledRegistry from "./registry-snapshot.json" with { type: "json" };
import sha256Overlay from "./registry-binary-sha256-overlay.json" with { type: "json" };
import { withManualAcpCatalog } from "./manual-agent-catalog.ts";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
// ponytail: 仅预填已核对的公开默认值；新环境参数须先核对上游用途再扩展此表。
const PUBLIC_ENVIRONMENT: Readonly<Record<string, string>> = {
  AUGMENT_DISABLE_AUTO_UPDATE: "1",
  DROID_DISABLE_AUTO_UPDATE: "true",
  FACTORY_DROID_AUTO_UPDATE_ENABLED: "false",
  FAST_AGENT_MODEL: "codexplan",
};
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const MAINTAINER_ARCHIVE_SHA256: Readonly<Record<string, string>> = sha256Overlay.byArchiveUrl;

type ConfiguredStatus = NonNullable<AcpRegistryCatalogEntry["configuredStatus"]>;

/** 目录项关联同环境、同命令且含必要环境参数的实例，不把缺参数或其它版本误标为可用。 */
export function withAcpRegistryDiagnostics(
  entries: ReadonlyArray<AcpRegistryCatalogEntry>,
  instances: Readonly<
    Record<
      string,
      {
        readonly driver: string;
        readonly config?: unknown;
        readonly environment?: ProviderInstanceEnvironment;
      }
    >
  >,
  providers: ReadonlyArray<
    Pick<ServerProvider, "instanceId" | "enabled" | "installed" | "status" | "availability">
  >,
): AcpRegistryCatalogEntry[] {
  const providerById = new Map<string, (typeof providers)[number]>(
    providers.map((provider) => [provider.instanceId, provider]),
  );
  const configured = new Map<
    string,
    { status: ConfiguredStatus; environment: Record<string, string> }[]
  >();
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.driver !== "acpAgent") continue;
    const command = record(instance.config)?.command;
    if (typeof command !== "string" || command.trim().length === 0) continue;
    const provider = providerById.get(instanceId);
    const status: ConfiguredStatus =
      provider === undefined
        ? "checking"
        : !provider.enabled
          ? "disabled"
          : !provider.installed
            ? "missing"
            : provider.availability === "unavailable" || provider.status === "error"
              ? "error"
              : provider.status === "ready"
                ? "ready"
                : "checking";
    const key = command.trim();
    configured.set(key, [
      ...(configured.get(key) ?? []),
      {
        status,
        environment: Object.fromEntries(
          (instance.environment ?? []).map((variable) => [variable.name, variable.value]),
        ),
      },
    ]);
  }
  const priority: ReadonlyArray<ConfiguredStatus> = [
    "ready",
    "checking",
    "error",
    "missing",
    "disabled",
  ];
  return entries.map((entry) => {
    const command = entry.command;
    return {
      ...entry,
      configuredStatus:
        command === null
          ? "not-configured"
          : (priority.find((status) =>
              configured
                .get(command)
                ?.some(
                  (instance) =>
                    instance.status === status &&
                    (entry.environment ?? []).every(
                      (variable) => instance.environment[variable.name] === variable.value,
                    ),
                ),
            ) ?? "not-configured"),
    };
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const ICON_URL =
  /^https:\/\/cdn\.agentclientprotocol\.com\/registry\/v1\/latest\/[a-z0-9._-]+\.svg$/i;
const SAFE_ARG = /^[a-z0-9_./:=@+-]+$/i;
const SAFE_CMD = /^(?:\.[\\/])?(?:[a-z0-9_+-][a-z0-9._+-]*[\\/])*[a-z0-9_+-][a-z0-9._+-]*$/i;

export type AcpArchiveFormat = "zip" | "tar" | "raw";

/** 仅接受已知归档格式；无扩展名时要求下载文件名与 cmd 同名，视为单文件二进制。 */
export function acpArchiveFormat(archiveUrl: string, cmd: string): AcpArchiveFormat | null {
  let pathname: string;
  try {
    pathname = new URL(archiveUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (pathname.endsWith(".zip")) return "zip";
  if (/\.(?:tar\.gz|tgz|tar\.bz2|tar\.xz)$/.test(pathname)) return "tar";
  const fileName = pathname.split("/").at(-1) ?? "";
  return fileName.length > 0 && cmd.toLowerCase().split(/[\\/]/).at(-1) === fileName ? "raw" : null;
}

/** 官方哈希缺省时仅补精确 URL 的维护者哈希，仍校验分发安全字段。 */
function binaryDistributionFor(
  binary: Record<string, unknown> | null,
  platformKey: string | null,
): AcpRegistryCatalogEntry["binaryDistribution"] {
  const target = platformKey ? record(binary?.[platformKey]) : null;
  if (!target || !platformKey) return undefined;
  const { archive, cmd } = target;
  const args = target.args === undefined ? [] : target.args;
  const sha256 =
    target.sha256 === undefined && typeof archive === "string"
      ? MAINTAINER_ARCHIVE_SHA256[archive]
      : target.sha256;
  if (
    typeof archive !== "string" ||
    !archive.startsWith("https://") ||
    archive.length > 2048 ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(sha256) ||
    typeof cmd !== "string" ||
    cmd.length > 300 ||
    !SAFE_CMD.test(cmd) ||
    !Array.isArray(args) ||
    !args.every((arg) => typeof arg === "string" && SAFE_ARG.test(arg)) ||
    acpArchiveFormat(archive, cmd) === null
  ) {
    return undefined;
  }
  return {
    platform: platformKey,
    archiveUrl: archive,
    sha256: sha256.toLowerCase(),
    cmd,
    args: args as string[],
  };
}

function hostPlatformKey(platform: NodeJS.Platform, arch: string): string | null {
  const os =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "darwin"
        : platform === "linux"
          ? "linux"
          : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

/** 目录内容只作为配置建议；安装须由用户选择后经现有 Provider 生命周期执行。 */
export function parseAcpRegistryCatalog(
  payload: unknown,
  platform: NodeJS.Platform,
  arch: string,
): AcpRegistryCatalogEntry[] {
  const agents = record(payload)?.agents;
  if (!Array.isArray(agents)) throw new Error("Invalid ACP registry payload");
  const platformKey = hostPlatformKey(platform, arch);
  const entries: AcpRegistryCatalogEntry[] = [];
  for (const raw of agents) {
    const agent = record(raw);
    if (!agent || typeof agent.id !== "string" || typeof agent.name !== "string") continue;
    const distribution = record(agent.distribution);
    const npx = record(distribution?.npx);
    const uvx = record(distribution?.uvx);
    const runner = npx ?? uvx;
    const args = runner?.args === undefined ? [] : runner.args;
    const env = record(runner?.env);
    const safeEnvironment =
      runner?.env === undefined ||
      (env !== null &&
        Object.entries(env).every(
          ([name, value]) =>
            typeof value === "string" &&
            Object.hasOwn(PUBLIC_ENVIRONMENT, name) &&
            PUBLIC_ENVIRONMENT[name] === value,
        ));
    const safePackage =
      typeof npx?.package === "string" &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(
        npx.package,
      );
    const packageVersion =
      typeof npx?.package === "string"
        ? npx.package.match(/@(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?)$/i)?.[1]
        : undefined;
    const matchingVersion = typeof agent.version === "string" && agent.version === packageVersion;
    const pythonPackage =
      typeof uvx?.package === "string"
        ? /^([a-z0-9][a-z0-9._-]*)(?:==|@)(\d+\.\d+\.\d+(?:[a-z0-9.-]+)?)$/i.exec(uvx.package)
        : null;
    const safeArgs =
      Array.isArray(args) && args.every((arg) => typeof arg === "string" && SAFE_ARG.test(arg));
    const npxRunner = platform === "win32" ? "cmd.exe /d /s /c npx" : "npx";
    const command =
      !safeArgs || !safeEnvironment
        ? null
        : safePackage && matchingVersion
          ? `${npxRunner} -y ${npx.package}${args.length > 0 ? ` ${args.join(" ")}` : ""}`
          : !npx && pythonPackage && pythonPackage[2] === agent.version
            ? `uvx --from ${pythonPackage[1]}==${pythonPackage[2]} ${pythonPackage[1]}${args.length > 0 ? ` ${args.join(" ")}` : ""}`
            : null;
    const binary = record(distribution?.binary);
    const binaryDistribution = command ? undefined : binaryDistributionFor(binary, platformKey);
    entries.push({
      id: agent.id.slice(0, 120),
      name: agent.name.slice(0, 160),
      description: typeof agent.description === "string" ? agent.description.slice(0, 500) : "",
      version: typeof agent.version === "string" ? agent.version.slice(0, 80) : null,
      command,
      ...(typeof agent.icon === "string" && ICON_URL.test(agent.icon)
        ? { iconUrl: agent.icon }
        : {}),
      ...(binaryDistribution ? { binaryDistribution } : {}),
      ...(agent.id === "qwen-code" ? { authMethodId: "openai" } : {}),
      ...(agent.id === "cline" ? { authMethodId: "" } : {}),
      ...(agent.id === "gemini" ? { authMethodId: "oauth-personal" } : {}),
      ...(agent.id === "github-copilot-cli" ? { authMethodId: "copilot-login" } : {}),
      ...(agent.id === "factory-droid" ? { supportsMcpServers: false } : {}),
      ...(command && env && Object.keys(env).length > 0
        ? {
            environment: Object.entries(env).map(([name, value]) => ({
              name,
              value: String(value),
              sensitive: false,
            })),
          }
        : {}),
      availability: command
        ? "installable"
        : binary && platformKey && !record(binary[platformKey])
          ? "unsupported-platform"
          : "manual",
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export const getAcpRegistryCatalog: Effect.Effect<
  AcpRegistryCatalogResult,
  never,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const result = yield* Effect.gen(function* () {
    const response = yield* client.execute(HttpClientRequest.get(REGISTRY_URL));
    if (
      response.status !== 200 ||
      Number(response.headers["content-length"] ?? 0) > MAX_REGISTRY_BYTES
    ) {
      return yield* Effect.fail("unavailable");
    }
    const body = yield* collectUint8StreamText({
      stream: response.stream,
      maxBytes: MAX_REGISTRY_BYTES,
    });
    if (body.truncated) return yield* Effect.fail("unavailable");
    const entries = yield* Effect.try(() =>
      parseAcpRegistryCatalog(decodeJson(body.text), platform, arch),
    );
    return { entries, error: null, source: "registry" as const };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.tapError(() =>
      Effect.logWarning("ACP 在线目录不可用，使用内置快照。", {
        snapshotDate: bundledRegistry.retrievedAt,
      }),
    ),
    Effect.orElseSucceed(() => ({
      entries: parseAcpRegistryCatalog(bundledRegistry, platform, arch),
      error: "unavailable",
      source: "bundled" as const,
      snapshotDate: bundledRegistry.retrievedAt,
    })),
  );
  return { ...result, entries: withManualAcpCatalog(result.entries, platform, arch) };
});
