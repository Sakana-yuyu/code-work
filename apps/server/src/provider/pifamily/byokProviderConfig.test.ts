// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - 纯路径断言 + 直接校验生成的 JSON 配置文件。
/**
 * pi-family 受管 BYOK 配置单元测试。
 *
 * 这些纯函数是凭据隔离的根基：agent 目录形状、环境清洗键表、models.json
 * 的 provider 拆分。任何一条松动都意味着 CLI 能绕过网关接触真实供应商
 * 凭据，所以全部钉死。
 *
 * @module provider/pifamily/byokProviderConfig.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ServerSettings } from "@codework/contracts";

import {
  PI_FAMILY_BYOK_PROVIDER_ANTHROPIC,
  PI_FAMILY_BYOK_PROVIDER_OPENAI,
  buildPifamilyModelsJson,
  pifamilyModelRoutes,
  pifamilyProviderNameForProtocol,
  resolvePifamilyAgentDir,
  scrubPifamilyEnvironment,
  writePifamilyByokConfig,
} from "./byokProviderConfig.ts";

const settingsWithInstances = (
  instances: Record<string, { driver: string; enabled: boolean; config: unknown }>,
): ServerSettings =>
  ({
    providerInstances: instances,
  }) as unknown as ServerSettings;

describe("resolvePifamilyAgentDir", () => {
  it("lays out the managed agent dir per driver kind and instance", () => {
    expect(
      resolvePifamilyAgentDir({
        stateDir: "/srv/state",
        driverKind: "piAgent",
        instanceId: "pi-1",
      }),
    ).toBe(
      NodePath.join(
        "/srv/state",
        "provider-homes",
        "pi-family",
        "piAgent",
        "instance-pi-1",
        "agent",
      ),
    );
    expect(
      resolvePifamilyAgentDir({
        stateDir: "/srv/state",
        driverKind: "ompAgent",
        instanceId: "omp-a",
      }),
    ).toBe(
      NodePath.join(
        "/srv/state",
        "provider-homes",
        "pi-family",
        "ompAgent",
        "instance-omp-a",
        "agent",
      ),
    );
  });

  it("escapes instance ids so they cannot escape the managed root", () => {
    // 点号编码成 %2E，路径分隔符经 encodeURIComponent 变成 %2F%5C。
    expect(
      resolvePifamilyAgentDir({
        stateDir: "/srv/state",
        driverKind: "piAgent",
        instanceId: "a.b/c",
      }),
    ).toBe(
      NodePath.join(
        "/srv/state",
        "provider-homes",
        "pi-family",
        "piAgent",
        "instance-a%2Eb%2Fc",
        "agent",
      ),
    );
  });
});

describe("scrubPifamilyEnvironment", () => {
  it("removes documented provider keys and pi-family pointers, keeps the rest", () => {
    expect(
      scrubPifamilyEnvironment({
        PATH: "/usr/bin",
        OPENAI_API_KEY: "sk-openai",
        ANTHROPIC_API_KEY: "sk-anthropic",
        OPENROUTER_API_KEY: "sk-or",
        GEMINI_API_KEY: "gem",
        GROQ_API_KEY: "groq",
        XAI_API_KEY: "xai",
        DEEPSEEK_API_KEY: "ds",
        PI_CONFIG_DIR: "/home/user/.pi",
        OMP_PROFILE: "work",
        PI_PROFILE: "work",
        PI_SMOL_MODEL: "m",
        PI_SLOW_MODEL: "m",
        PI_PLAN_MODEL: "m",
        PI_CODING_AGENT_DIR: "/managed/agent",
        MOCK_RESPONSE_TEXT: "keep me",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      PI_CODING_AGENT_DIR: "/managed/agent",
      MOCK_RESPONSE_TEXT: "keep me",
    });
  });

  it("drops undefined values", () => {
    expect(
      scrubPifamilyEnvironment({
        DEFINITELY_UNSET: undefined,
        PRESENT: "yes",
        OPENAI_API_KEY: undefined,
      }),
    ).toEqual({ PRESENT: "yes" });
  });
});

describe("pifamilyModelRoutes", () => {
  const gatewayRoutes = [
    {
      id: "openai-adapter",
      protocol: "openai" as const,
      displayName: "Mock OpenAI",
      modelId: "gpt-mock",
    },
    {
      id: "anthropic-adapter",
      protocol: "anthropic" as const,
      displayName: "  ",
      modelId: "claude-mock",
    },
    {
      id: "gemini-adapter",
      protocol: "gemini" as const,
      displayName: "Gemini",
      modelId: "gem-mock",
    },
  ];

  it("excludes gemini routes and mirrors the rest as gateway routes", () => {
    const routes = pifamilyModelRoutes(
      gatewayRoutes,
      settingsWithInstances({
        byok: {
          driver: "byok",
          enabled: true,
          config: {
            enabled: true,
            adapters: [
              {
                id: "openai-adapter",
                displayName: "Mock OpenAI",
                groupName: "",
                protocol: "openai",
                baseURL: "https://upstream.example/v1",
                apiKey: "sk-upstream",
                apiKeyRedacted: false,
                modelId: "gpt-mock",
                contextWindowTokens: 200_000,
                supplierID: "custom",
              },
            ],
          },
        },
      }),
    );
    expect(routes).toEqual([
      {
        adapterId: "openai-adapter",
        protocol: "openai",
        displayName: "Mock OpenAI",
        modelId: "gpt-mock",
        contextWindowTokens: 200_000,
      },
      {
        adapterId: "anthropic-adapter",
        protocol: "anthropic",
        // displayName 空白时回退到上游模型名。
        displayName: "claude-mock",
        modelId: "claude-mock",
        contextWindowTokens: 128_000,
      },
    ]);
  });
});

describe("pifamilyProviderNameForProtocol", () => {
  it("maps protocols onto the two gateway provider names", () => {
    expect(pifamilyProviderNameForProtocol("openai")).toBe(PI_FAMILY_BYOK_PROVIDER_OPENAI);
    expect(pifamilyProviderNameForProtocol("anthropic")).toBe(PI_FAMILY_BYOK_PROVIDER_ANTHROPIC);
    expect(PI_FAMILY_BYOK_PROVIDER_OPENAI).toBe("codework-openai");
    expect(PI_FAMILY_BYOK_PROVIDER_ANTHROPIC).toBe("codework-anthropic");
  });
});

describe("buildPifamilyModelsJson", () => {
  it("splits routes by protocol, keys models by adapter id, embeds the gateway token", () => {
    const modelsJson = buildPifamilyModelsJson({
      routes: [
        {
          adapterId: "mock-byok-adapter",
          protocol: "openai",
          displayName: "Mock",
          modelId: "gpt-mock-upstream",
          contextWindowTokens: 128_000,
        },
        {
          adapterId: "mock-anthropic-adapter",
          protocol: "anthropic",
          displayName: "Mock Claude",
          modelId: "claude-mock-upstream",
          contextWindowTokens: 200_000,
        },
      ],
      openaiBaseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
      anthropicBaseUrl: "http://127.0.0.1:3773/byok-gw/anthropic",
      gatewayToken: "gateway-secret-token",
    });

    expect(Object.keys(modelsJson.providers)).toEqual([
      PI_FAMILY_BYOK_PROVIDER_OPENAI,
      PI_FAMILY_BYOK_PROVIDER_ANTHROPIC,
    ]);
    expect(modelsJson.providers[PI_FAMILY_BYOK_PROVIDER_OPENAI]).toEqual({
      name: "Code Work BYOK Gateway (OpenAI)",
      baseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
      api: "openai-completions",
      apiKey: "gateway-secret-token",
      models: [
        {
          id: "mock-byok-adapter",
          name: "Mock",
          input: ["text"],
          contextWindow: 128_000,
          reasoning: false,
        },
      ],
    });
    expect(modelsJson.providers[PI_FAMILY_BYOK_PROVIDER_ANTHROPIC]?.models[0]).toEqual({
      id: "mock-anthropic-adapter",
      name: "Mock Claude",
      input: ["text"],
      contextWindow: 200_000,
      reasoning: false,
    });
    // models.json 是 CLI 配置：JSON 可序列化且可原样往返。
    expect(JSON.parse(JSON.stringify(modelsJson))).toEqual(modelsJson);
  });

  it("omits providers without any routes", () => {
    const modelsJson = buildPifamilyModelsJson({
      routes: [
        {
          adapterId: "mock-byok-adapter",
          protocol: "openai",
          displayName: "Mock",
          modelId: "gpt-mock-upstream",
          contextWindowTokens: 128_000,
        },
      ],
      openaiBaseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
      anthropicBaseUrl: "http://127.0.0.1:3773/byok-gw/anthropic",
      gatewayToken: "tok",
    });
    expect(Object.keys(modelsJson.providers)).toEqual([PI_FAMILY_BYOK_PROVIDER_OPENAI]);
  });
});

describe("writePifamilyByokConfig", () => {
  it.effect("writes models.json atomically, creating parent directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-pifamily-config-test-",
      });
      const agentDir = path.join(
        baseDir,
        "provider-homes",
        "pi-family",
        "piAgent",
        "instance-x",
        "agent",
      );
      const modelsJson = buildPifamilyModelsJson({
        routes: [
          {
            adapterId: "mock-byok-adapter",
            protocol: "openai",
            displayName: "Mock",
            modelId: "gpt-mock-upstream",
            contextWindowTokens: 128_000,
          },
        ],
        openaiBaseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
        anthropicBaseUrl: "http://127.0.0.1:3773/byok-gw/anthropic",
        gatewayToken: "gateway-secret-token",
      });

      yield* writePifamilyByokConfig({ agentDir, modelsJson });

      const contents = yield* fileSystem.readFileString(path.join(agentDir, "models.json"));
      expect(JSON.parse(contents)).toEqual(modelsJson);
      // 原子写入以换行收尾，与手工文件一致。
      expect(contents.endsWith("\n")).toBe(true);
      // 覆盖写：第二次写入替换旧 token。
      yield* writePifamilyByokConfig({
        agentDir,
        modelsJson: buildPifamilyModelsJson({
          routes: [],
          openaiBaseUrl: "http://127.0.0.1:3773/byok-gw/openai/v1",
          anthropicBaseUrl: "http://127.0.0.1:3773/byok-gw/anthropic",
          gatewayToken: "rotated",
        }),
      });
      const rotated = JSON.parse(
        yield* fileSystem.readFileString(path.join(agentDir, "models.json")),
      ) as { readonly providers: Record<string, unknown> };
      expect(rotated.providers).toEqual({});
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
