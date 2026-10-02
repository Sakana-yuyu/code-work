import { describe, expect, it } from "@effect/vitest";
import { HostProcessArchitecture, HostProcessPlatform } from "@codework/shared/hostProcess";
import { ProviderInstanceId } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

import {
  getAcpRegistryCatalog,
  parseAcpRegistryCatalog,
  withAcpRegistryDiagnostics,
} from "./AcpRegistryCatalog.ts";
import bundledRegistry from "./registry-snapshot.json" with { type: "json" };
import sha256Overlay from "./registry-binary-sha256-overlay.json" with { type: "json" };
import { withManualAcpCatalog } from "./manual-agent-catalog.ts";

const runCatalog = (fetchImplementation: typeof globalThis.fetch) =>
  getAcpRegistryCatalog.pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchImplementation)),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "win32"),
    Effect.provideService(HostProcessArchitecture, "x64"),
  );

const asFetch = (
  implementation: (input: string | URL) => Promise<Response>,
): typeof globalThis.fetch => implementation as unknown as typeof globalThis.fetch;

describe("ACP registry catalog", () => {
  it("为已核对的官方 CLI 提供原生认证方法而非通用 login", () => {
    const entries = parseAcpRegistryCatalog(bundledRegistry, "win32", "x64");
    for (const [id, authMethodId] of [
      ["qwen-code", "openai"],
      ["gemini", "oauth-personal"],
      ["github-copilot-cli", "copilot-login"],
    ]) {
      expect(entries.find((entry) => entry.id === id)).toMatchObject({ authMethodId });
    }
    expect(entries.find((entry) => entry.id === "cline")).toMatchObject({ authMethodId: "" });
  });

  it("builds a pinned npx command from safe registry fields", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          {
            id: "cline",
            name: "Cline",
            version: "3.0.64",
            distribution: { npx: { package: "cline@3.0.64", args: ["--acp"] } },
          },
        ],
      },
      "win32",
      "x64",
    );

    expect(entries).toMatchObject([
      {
        id: "cline",
        command: "cmd.exe /d /s /c npx -y cline@3.0.64 --acp",
        availability: "installable",
      },
    ]);
    expect(
      parseAcpRegistryCatalog(
        {
          agents: [
            {
              id: "cline",
              name: "Cline",
              version: "3.0.64",
              distribution: { npx: { package: "cline@3.0.64" } },
            },
          ],
        },
        "linux",
        "x64",
      )[0]?.command,
    ).toBe("npx -y cline@3.0.64");
  });

  it("does not make untrusted package and argument text executable", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          { id: "one", name: "One", distribution: { npx: { package: "x@1.0.0; rm", args: [] } } },
          {
            id: "two",
            name: "Two",
            distribution: { npx: { package: "x@1.0.0", args: ["$(bad)"] } },
          },
          {
            id: "three",
            name: "Three",
            distribution: { npx: { package: "x@1.0.0", env: { TOKEN: "secret" } } },
          },
          { id: "four", name: "Four", distribution: { npx: { package: "x@latest" } } },
          { id: "five", name: "Five", distribution: { npx: { package: "--help@1.0.0" } } },
        ],
      },
      "linux",
      "x64",
    );

    expect(
      entries.every((entry) => entry.command === null && entry.availability === "manual"),
    ).toBe(true);
  });

  it("refuses a package whose pinned version differs from the registry entry", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          {
            id: "cline",
            name: "Cline",
            version: "3.0.64",
            distribution: { npx: { package: "cline@3.0.63" } },
          },
        ],
      },
      "linux",
      "x64",
    );
    expect(entries[0]).toMatchObject({ command: null, availability: "manual" });
  });

  it("uses the server platform when a registry entry has only a binary distribution", () => {
    const payload = {
      agents: [
        {
          id: "binary",
          name: "Binary",
          distribution: { binary: { "linux-x86_64": { archive: "https://example.com/a.tar.gz" } } },
        },
      ],
    };

    expect(parseAcpRegistryCatalog(payload, "win32", "x64")[0]?.availability).toBe(
      "unsupported-platform",
    );
    expect(parseAcpRegistryCatalog(payload, "linux", "x64")[0]?.availability).toBe("manual");
  });

  it("rejects a malformed registry response", () => {
    expect(() => parseAcpRegistryCatalog({ agents: {} }, "linux", "x64")).toThrow(
      "Invalid ACP registry payload",
    );
  });

  it("reports the matching configured instance without confusing package versions", () => {
    const entries = parseAcpRegistryCatalog(
      {
        agents: [
          {
            id: "cline",
            name: "Cline",
            version: "3.0.64",
            distribution: { npx: { package: "cline@3.0.64" } },
          },
          {
            id: "other",
            name: "Other",
            version: "1.0.0",
            distribution: { npx: { package: "other@1.0.0" } },
          },
        ],
      },
      "linux",
      "x64",
    );
    const instances = {
      acp_cline: { driver: "acpAgent", config: { command: "npx -y cline@3.0.64" } },
      acp_older: { driver: "acpAgent", config: { command: "npx -y cline@3.0.63" } },
    };
    const provider = {
      instanceId: ProviderInstanceId.make("acp_cline"),
      enabled: true,
      installed: true,
      status: "ready" as const,
      availability: "available" as const,
    };
    expect(withAcpRegistryDiagnostics(entries, instances, [provider])).toMatchObject([
      { id: "cline", configuredStatus: "ready" },
      { id: "other", configuredStatus: "not-configured" },
    ]);
    expect(
      withAcpRegistryDiagnostics(entries, instances, [
        { ...provider, installed: false, status: "error" },
      ])[0]?.configuredStatus,
    ).toBe("missing");
  });

  it.effect("reads the official registry URL through the server HTTP client", () =>
    Effect.gen(function* () {
      let requestedUrl = "";
      const result = yield* runCatalog(
        asFetch(async (input) => {
          requestedUrl = String(input);
          return new Response(
            JSON.stringify({
              agents: [
                {
                  id: "cline",
                  name: "Cline",
                  version: "3.0.64",
                  distribution: { npx: { package: "cline@3.0.64" } },
                },
              ],
            }),
            { status: 200 },
          );
        }),
      );

      expect(requestedUrl).toBe(
        "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
      );
      expect(result.error).toBeNull();
      expect(result.source).toBe("registry");
      expect(result.snapshotDate).toBeUndefined();
      expect(result.entries[0]?.command).toBe("cmd.exe /d /s /c npx -y cline@3.0.64");
    }),
  );

  it.effect("官方目录失败时显式返回同平台离线快照，恢复后优先在线目录", () =>
    Effect.gen(function* () {
      for (const response of [
        () => new Response("offline", { status: 503 }),
        () => new Response("invalid JSON", { status: 200 }),
        () => new Response("{}", { status: 200 }),
        () => new Response("{}", { status: 200, headers: { "content-length": "3000000" } }),
        () => new Response(" ".repeat(2 * 1024 * 1024 + 1)),
      ]) {
        const result = yield* runCatalog(asFetch(async () => response()));
        expect(result).toEqual({
          entries: withManualAcpCatalog(
            parseAcpRegistryCatalog(bundledRegistry, "win32", "x64"),
            "win32",
            "x64",
          ),
          error: "unavailable",
          source: "bundled",
          snapshotDate: bundledRegistry.retrievedAt,
        });
        // win32 离线快照必须带可校验二进制分发，否则客户端只能显示「需手动安装」。
        expect(result.entries.some((entry) => entry.binaryDistribution !== undefined)).toBe(true);
        expect(
          result.entries.find((entry) => entry.id === "amp-acp")?.binaryDistribution?.cmd,
        ).toBe("amp-acp.exe");
      }
      const recovered = yield* runCatalog(asFetch(async () => new Response('{"agents":[]}')));
      expect(recovered).toEqual({
        entries: withManualAcpCatalog([], "win32", "x64"),
        error: null,
        source: "registry",
      });
      expect(recovered.entries.some((entry) => entry.id === "cline")).toBe(false);
    }),
  );

  it("离线数据保留去重 ID、固定版本与平台限制，连同公开环境参数生成命令", () => {
    const entries = parseAcpRegistryCatalog(bundledRegistry, "win32", "x64");
    expect(entries).toHaveLength(41);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.find((entry) => entry.id === "factory-droid")?.supportsMcpServers).toBe(false);
    expect(entries.find((entry) => entry.id === "cline")?.supportsMcpServers).toBeUndefined();
    expect(entries.find((entry) => entry.id === "cline")).toMatchObject({
      version: "3.0.65",
      availability: "installable",
      iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/cline.svg",
    });
    expect(entries.every((entry) => typeof entry.iconUrl === "string")).toBe(true);
    expect(entries.find((entry) => entry.id === "auggie")).toMatchObject({
      command: "cmd.exe /d /s /c npx -y @augmentcode/auggie@0.36.0 --acp",
      environment: [{ name: "AUGMENT_DISABLE_AUTO_UPDATE", value: "1", sensitive: false }],
    });
    expect(entries.find((entry) => entry.id === "amp-acp")).toMatchObject({
      command: null,
      availability: "manual",
      binaryDistribution: {
        platform: "windows-x86_64",
        archiveUrl:
          "https://github.com/tao12345666333/amp-acp/releases/download/v0.9.0/amp-acp-windows-x86_64.zip",
        sha256: "3b2c3d14d703fcf9572da9733e4941703a7744bd37ec4aaa75421d6002c0157b",
        cmd: "amp-acp.exe",
        args: [],
      },
    });
    for (const id of [
      "antigravity-acp",
      "cortex-code",
      "corust-agent",
      "devin",
      "junie",
      "stakpak",
      "vtcode",
    ] as const) {
      const entry = entries.find((item) => item.id === id);
      expect(entry?.binaryDistribution?.platform).toBe("windows-x86_64");
      expect(entry?.binaryDistribution?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(entry?.binaryDistribution?.archiveUrl?.startsWith("https://")).toBe(true);
    }
    expect(entries.find((entry) => entry.id === "junie")?.version).toBe("3419.22.0");
    expect(entries.find((entry) => entry.id === "cline")?.binaryDistribution).toBeUndefined();
    const ampArm = parseAcpRegistryCatalog(bundledRegistry, "win32", "arm64").find(
      (entry) => entry.id === "amp-acp",
    );
    expect(ampArm?.availability).toBe("unsupported-platform");
    expect(ampArm?.binaryDistribution).toBeUndefined();
  });

  it("五个手工入口有官方来源和平台限制，现有同 ID 优先且不复制专用驱动", () => {
    const manual = withManualAcpCatalog([], "win32", "x64");
    expect(manual.map((entry) => [entry.id, entry.command])).toEqual([
      ["codewhale", "codewhale serve --acp"],
      ["gjc", "gjc acp"],
      ["hermes", "hermes acp"],
      ["kiro", "kiro-cli acp"],
      ["traecli", "traecli acp serve"],
    ]);
    for (const entry of manual) {
      expect(entry.availability).toBe("manual");
      expect(entry.version).toBeNull();
      expect(entry.setup?.installationUrl).toMatch(/^https:\/\//);
      expect(entry.setup?.documentationUrl).toMatch(/^https:\/\//);
      expect(entry.setup?.verifiedAt).toBe("2026-09-30");
    }
    expect(manual.find((entry) => entry.id === "gjc")?.environment).toEqual([
      { name: "GJC_ACP_PERMISSION_MODE", value: "prompt", sensitive: false },
    ]);
    expect(manual.find((entry) => entry.id === "hermes")?.authMethodId).toBe("");
    expect(manual.find((entry) => entry.id === "gjc")?.authMethodId).toBe("agent");
    const current = { ...manual[0]!, command: "npx -y codewhale@1.0.0", version: "1.0.0" };
    const merged = withManualAcpCatalog([current], "win32", "x64");
    expect(merged).toHaveLength(5);
    expect(merged.find((entry) => entry.id === "codewhale")).toBe(current);
    expect(
      withManualAcpCatalog([], "win32", "arm64").find((entry) => entry.id === "gjc"),
    ).toMatchObject({ command: null, availability: "unsupported-platform" });
    expect(
      withManualAcpCatalog([], "win32", "arm64").find((entry) => entry.id === "kiro"),
    ).toMatchObject({ command: null, availability: "unsupported-platform" });
    expect(
      withManualAcpCatalog([], "linux", "arm64").every((entry) => entry.command !== null),
    ).toBe(true);
    expect(withManualAcpCatalog([], "aix", "ppc64").every((entry) => entry.command === null)).toBe(
      true,
    );
    const full = withManualAcpCatalog(
      parseAcpRegistryCatalog(bundledRegistry, "win32", "x64"),
      "win32",
      "x64",
    );
    expect(full).toHaveLength(46);
    expect(new Set(full.map((entry) => entry.id)).size).toBe(46);
    expect(full.filter((entry) => entry.id === "cursor")).toHaveLength(1);
    expect(full.filter((entry) => entry.id === "kimi")).toHaveLength(1);
    expect(full.some((entry) => entry.id === "grok")).toBe(false);
  });

  it("uvx 的两种固定版本语法均转为 --from，保留参数与公开环境", () => {
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const entries = parseAcpRegistryCatalog(bundledRegistry, platform, "x64");
      expect(entries.find((entry) => entry.id === "fast-agent")).toMatchObject({
        command: "uvx --from fast-agent-acp==0.10.1 fast-agent-acp -x",
        environment: [{ name: "FAST_AGENT_MODEL", value: "codexplan", sensitive: false }],
      });
      expect(entries.find((entry) => entry.id === "minion-code")).toMatchObject({
        command: "uvx --from minion-code==0.1.44 minion-code acp",
      });
    }
  });

  it("拒绝未知环境、畸形环境、命令注入和不固定的 uvx 包，不把参数拼进 shell", () => {
    for (const distribution of [
      { npx: { package: "agent@1.0.0", env: { NODE_OPTIONS: "--require bad" } } },
      { npx: { package: "agent@1.0.0", env: { TOKEN: "secret" } } },
      { npx: { package: "agent@1.0.0", env: { AUGMENT_DISABLE_AUTO_UPDATE: "$(bad)" } } },
      { npx: { package: "agent@1.0.0", env: [] } },
      { uvx: { package: "agent@latest" } },
      { uvx: { package: "agent==0.9.0" } },
      { uvx: { package: "agent==1.0.0;bad" } },
      { uvx: { package: "agent==1.0.0", args: ["&bad"] } },
      { uvx: { package: "--help==1.0.0" } },
    ]) {
      const [entry] = parseAcpRegistryCatalog(
        {
          agents: [
            {
              id: "unsafe",
              name: "Unsafe",
              version: "1.0.0",
              distribution,
            },
          ],
        },
        "win32",
        "x64",
      );
      expect(entry).toMatchObject({ command: null, availability: "manual" });
      expect(entry?.environment).toBeUndefined();
    }
  });

  it("同命令缺少或覆盖了必要环境参数时不显示已配置，额外凭据不影响匹配", () => {
    const entry = parseAcpRegistryCatalog(bundledRegistry, "linux", "x64").find(
      (entry) => entry.id === "auggie",
    )!;
    const instance = { driver: "acpAgent", config: { command: entry.command } };
    const provider = {
      instanceId: ProviderInstanceId.make("auggie"),
      enabled: true,
      installed: true,
      status: "ready" as const,
      availability: "available" as const,
    };
    expect(
      withAcpRegistryDiagnostics([entry], { auggie: instance }, [provider])[0]?.configuredStatus,
    ).toBe("not-configured");
    expect(
      withAcpRegistryDiagnostics(
        [entry],
        {
          auggie: {
            ...instance,
            environment: [
              ...entry.environment!,
              { name: "API_KEY", value: "", sensitive: true, valueRedacted: true },
            ],
          },
        },
        [provider],
      )[0]?.configuredStatus,
    ).toBe("ready");
    expect(
      withAcpRegistryDiagnostics(
        [entry],
        {
          auggie: {
            ...instance,
            environment: [
              ...entry.environment!,
              { name: "AUGMENT_DISABLE_AUTO_UPDATE", value: "0", sensitive: false },
            ],
          },
        },
        [provider],
      )[0]?.configuredStatus,
    ).toBe("not-configured");
  });

  it("精确归档哈希补充缺省字段，官方非法值和未知归档仍拒绝", () => {
    const archives: Readonly<Record<string, string>> = sha256Overlay.byArchiveUrl;
    for (const [archive, sha256] of Object.entries(archives)) {
      const parse = (target: Record<string, unknown>, platform: NodeJS.Platform = "win32") =>
        parseAcpRegistryCatalog(
          {
            agents: [
              {
                id: "fixture",
                name: "Fixture",
                distribution: { binary: { "windows-x86_64": target } },
              },
            ],
          },
          platform,
          "x64",
        )[0];
      const target = { archive, cmd: "agent.exe", args: ["--acp"] };
      expect(parse(target)?.binaryDistribution).toMatchObject({ archiveUrl: archive, sha256 });
      expect(parse({ ...target, sha256: "A".repeat(64) })?.binaryDistribution?.sha256).toBe(
        "a".repeat(64),
      );
      for (const invalid of [null, 42, {}, "", "invalid", "b".repeat(63)]) {
        expect(parse({ ...target, sha256: invalid })?.binaryDistribution).toBeUndefined();
      }
      for (const changed of [
        archive + "?version=next",
        archive.replace("https:", "http:"),
        "https://example.com/agent.zip",
      ]) {
        expect(parse({ ...target, archive: changed })?.binaryDistribution).toBeUndefined();
      }
      expect(parse({ ...target, cmd: "../agent.exe" })?.binaryDistribution).toBeUndefined();
      expect(parse({ ...target, args: ["$(bad)"] })?.binaryDistribution).toBeUndefined();
      expect(parse(target, "linux")?.binaryDistribution).toBeUndefined();
    }
  });

  it.effect("在线目录在缺少官方哈希时仍交付可校验分发并保留在线来源", () =>
    Effect.gen(function* () {
      const archive =
        "https://github.com/Corust-ai/corust-agent-release/releases/download/v0.6.0/agent-windows-x64.zip";
      const result = yield* runCatalog(
        asFetch(
          async () =>
            new Response(
              JSON.stringify({
                agents: [
                  {
                    id: "corust-agent",
                    name: "Corust Agent",
                    version: "0.6.0",
                    distribution: {
                      binary: { "windows-x86_64": { archive, cmd: "agent.exe", args: ["--acp"] } },
                    },
                  },
                ],
              }),
            ),
        ),
      );
      expect(result.source).toBe("registry");
      expect(result.error).toBeNull();
      expect(result.snapshotDate).toBeUndefined();
      expect(
        result.entries.find((entry) => entry.id === "corust-agent")?.binaryDistribution,
      ).toMatchObject({
        archiveUrl: archive,
        sha256: "79d28ce683cb5c7d436a1c9abb759425314a57ec6aa4d02b5fcfb0c84ca124a2",
      });
    }),
  );
});
