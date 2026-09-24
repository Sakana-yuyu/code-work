import type { AcpRegistryCatalogEntry, AcpRegistryCatalogResult } from "@codework/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
    const args = npx?.args === undefined ? [] : npx.args;
    const env = record(npx?.env);
    const safePackage =
      typeof npx?.package === "string" &&
      /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(
        npx.package,
      );
    const safeArgs =
      Array.isArray(args) &&
      args.every((arg) => typeof arg === "string" && /^[a-z0-9_./:=@+-]+$/i.test(arg));
    const npxRunner = platform === "win32" ? "cmd.exe /d /s /c npx" : "npx";
    const command =
      safePackage && safeArgs && (env === null || Object.keys(env).length === 0)
        ? `${npxRunner} -y ${npx.package}${args.length > 0 ? ` ${args.join(" ")}` : ""}`
        : null;
    const binary = record(distribution?.binary);
    entries.push({
      id: agent.id.slice(0, 120),
      name: agent.name.slice(0, 160),
      description: typeof agent.description === "string" ? agent.description.slice(0, 500) : "",
      version: typeof agent.version === "string" ? agent.version.slice(0, 80) : null,
      command,
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
  const response = yield* client.execute(HttpClientRequest.get(REGISTRY_URL));
  if (
    response.status !== 200 ||
    Number(response.headers["content-length"] ?? 0) > MAX_REGISTRY_BYTES
  ) {
    return { entries: [], error: "unavailable" };
  }
  const body = yield* collectUint8StreamText({
    stream: response.stream,
    maxBytes: MAX_REGISTRY_BYTES,
  });
  if (body.truncated) return { entries: [], error: "unavailable" };
  const entries = yield* Effect.try(() =>
    parseAcpRegistryCatalog(decodeJson(body.text), platform, arch),
  );
  return { entries, error: null };
}).pipe(
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => ({ entries: [], error: "unavailable" })),
);
