import type { ProviderInstanceId } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { emptyMulticaRuntimeDraft } from "./MulticaRuntimeSettings.logic";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import { validateMulticaRuntimeDraft } from "./MulticaRuntimeSettings.validation";

const validDraft = (): MulticaRuntimeDraft => ({
  ...emptyMulticaRuntimeDraft("multica_local"),
  originalInstanceId: "multica_local",
  runtimeId: " multica:daemon-1:runtime-1 ",
  daemonId: " daemon-1 ",
  daemonRuntimeId: " runtime-1 ",
  baseUrl: " https://multica.test/ ",
  headers: [{ headerName: " Authorization ", environmentVariable: " MULTICA_TOKEN " }],
  environment: [
    {
      name: " MULTICA_TOKEN ",
      originalName: "MULTICA_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
    },
    {
      name: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
      originalName: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
    },
  ],
  assigneeRoutes: [
    {
      codeworkAgentId: " agent-1 ",
      codeworkSquadId: "",
      workspaceId: " workspace-1 ",
      multicaAgentId: " remote-agent-1 ",
      multicaSquadId: "",
      codeworkMcpCredentialEnvironmentVariable: " MULTICA_AGENT_1_CODEWORK_MCP_TOKEN ",
    },
  ],
  version: " 1.2.3 ",
  capabilities: [" rpc-v1 ", "squad", "rpc-v1"],
  supportsResume: true,
  supportsMcp: true,
  taskExecutionExtension: {
    command: " node ",
    args: ["extension.mjs", "--mode", "worker"],
    cwd: " C:/multica-extension ",
    timeoutMs: "5000",
  },
  supportsSquad: true,
  supportsLeader: true,
  supportsTaskGraph: true,
});

const expectProviderInstanceId = (_value: ProviderInstanceId): void => undefined;

const publicEnvironment = (name = "VISIBLE_VALUE") => ({
  name,
  value: "visible",
  sensitive: false,
});

describe("MulticaRuntimeSettings validation", () => {
  it("规范化可保存配置、保留 Secret 占位并返回 branded instanceId", () => {
    const result = validateMulticaRuntimeDraft(validDraft());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expectProviderInstanceId(result.value.instanceId);
    expect(result.value).toEqual({
      instanceId: "multica_local",
      environment: [
        {
          name: "MULTICA_TOKEN",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
        {
          name: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
          value: "",
          sensitive: true,
          valueRedacted: true,
        },
      ],
      config: {
        schemaVersion: 1,
        enabled: true,
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "https://multica.test/",
        headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [
          {
            codeworkAgentId: "agent-1",
            workspaceId: "workspace-1",
            multicaAgentId: "remote-agent-1",
            codeworkMcpCredentialEnvironmentVariable: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
          },
        ],
        version: "1.2.3",
        capabilities: ["rpc-v1", "squad"],
        supportsResume: true,
        supportsMcp: true,
        taskExecutionExtension: {
          command: "node",
          args: ["extension.mjs", "--mode", "worker"],
          cwd: "C:/multica-extension",
          timeoutMs: 5000,
        },
        supportsSquad: true,
        supportsLeader: true,
        supportsTaskGraph: true,
      },
    });
  });

  it("显式输入新 Secret 时清除 valueRedacted 并执行轮换", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      environment: draft.environment.map((entry, index) =>
        index === 0 ? { ...entry, value: "rotated-secret", valueRedacted: true } : entry,
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.environment[0]).toEqual({
      name: "MULTICA_TOKEN",
      value: "rotated-secret",
      sensitive: true,
    });
  });

  it.each([
    {
      name: "实例 ID 改名",
      patch: (draft: MulticaRuntimeDraft): MulticaRuntimeDraft => ({
        ...draft,
        instanceId: "multica_renamed",
      }),
    },
    {
      name: "Secret 环境变量改名",
      patch: (draft: MulticaRuntimeDraft): MulticaRuntimeDraft => ({
        ...draft,
        headers: [{ headerName: "Authorization", environmentVariable: "RENAMED_TOKEN" }],
        environment: draft.environment.map((entry, index) =>
          index === 0 ? { ...entry, name: "RENAMED_TOKEN" } : entry,
        ),
      }),
    },
    {
      name: "缺少原环境变量身份",
      patch: (draft: MulticaRuntimeDraft): MulticaRuntimeDraft => ({
        ...draft,
        environment: draft.environment.map((entry, index) => {
          if (index !== 0) return entry;
          const { originalName: _omit, ...withoutOriginalName } = entry;
          return withoutOriginalName;
        }),
      }),
    },
    {
      name: "关闭 sensitive",
      patch: (draft: MulticaRuntimeDraft): MulticaRuntimeDraft => ({
        ...draft,
        environment: draft.environment.map((entry, index) =>
          index === 0 ? { ...entry, sensitive: false } : entry,
        ),
      }),
    },
    {
      name: "丢失 valueRedacted 标记",
      patch: (draft: MulticaRuntimeDraft): MulticaRuntimeDraft => ({
        ...draft,
        environment: draft.environment.map((entry, index) => {
          if (index !== 0) return entry;
          const { valueRedacted: _omit, ...withoutRedactedFlag } = entry;
          return withoutRedactedFlag;
        }),
      }),
    },
  ])("拒绝用脱敏空值保存$name", ({ patch }) => {
    expect(validateMulticaRuntimeDraft(patch(validDraft()))).toEqual({
      ok: false,
      issue: { code: "invalid_environment_secret", path: "environment.0.value" },
    });
  });

  it.each([
    ["Accept", "aCcEpT"],
    ["Content-Type", "CONTENT-TYPE"],
    ["X-Workspace-ID", "x-workspace-id"],
    ["X-Idempotency-Key", "X-IDEMPOTENCY-KEY"],
  ])("拒绝协议保留 Header %s 的大小写变体", (_name, headerName) => {
    const draft = validDraft();
    expect(
      validateMulticaRuntimeDraft({
        ...draft,
        headers: [{ headerName, environmentVariable: "VISIBLE_VALUE" }],
        environment: [...draft.environment, publicEnvironment()],
      }),
    ).toEqual({
      ok: false,
      issue: { code: "invalid_header_binding", path: "headers.0.headerName" },
    });
  });

  it.each([
    "Authorization",
    "Proxy-Authorization",
    "api_key",
    "X-API-Key",
    "token",
    "X-Auth-Token",
    "X-Tenant-Key",
    "Private-Token",
    "Client-Secret",
    "X-Client-Secret",
    "Ocp-Apim-Subscription-Key",
  ])("要求凭据 Header %s 绑定 sensitive 环境变量", (headerName) => {
    const draft = validDraft();
    expect(
      validateMulticaRuntimeDraft({
        ...draft,
        headers: [{ headerName, environmentVariable: "PUBLIC_TOKEN" }],
        environment: [...draft.environment, publicEnvironment("PUBLIC_TOKEN")],
      }),
    ).toEqual({
      ok: false,
      issue: { code: "invalid_header_binding", path: "headers.0.environmentVariable" },
    });
  });

  it("允许非凭据自定义 Header 绑定普通环境变量", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      headers: [{ headerName: "X-Trace-Label", environmentVariable: "VISIBLE_VALUE" }],
      environment: [...draft.environment, publicEnvironment()],
    });

    expect(result.ok).toBe(true);
  });

  it("拒绝 Header 绑定没有显式值或已保存 Secret 的环境变量", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      environment: draft.environment.map((entry, index) =>
        index === 0 ? { name: entry.name, value: "", sensitive: true } : entry,
      ),
    });

    expect(result).toEqual({
      ok: false,
      issue: { code: "invalid_header_binding", path: "headers.0.environmentVariable" },
    });
  });

  it("要求静态 MCP credential 环境变量存在且 sensitive", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      environment: draft.environment.map((entry) => {
        if (entry.name !== "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN") return entry;
        return {
          name: entry.name,
          value: "plaintext-token",
          sensitive: false,
        };
      }),
    });

    expect(result).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.0.codeworkMcpCredentialEnvironmentVariable",
      },
    });
  });

  it("拒绝静态 MCP credential 引用空敏感变量", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      environment: draft.environment.map((entry) =>
        entry.name === "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN"
          ? { name: entry.name, value: "", sensitive: true }
          : entry,
      ),
    });

    expect(result).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.0.codeworkMcpCredentialEnvironmentVariable",
      },
    });
  });

  it("拒绝不同 Agent 共用同一个静态 MCP credential 环境变量", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      assigneeRoutes: [
        draft.assigneeRoutes[0]!,
        {
          codeworkAgentId: "agent-2",
          codeworkSquadId: "",
          workspaceId: "workspace-1",
          multicaAgentId: "remote-agent-2",
          multicaSquadId: "",
          codeworkMcpCredentialEnvironmentVariable: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.1.codeworkMcpCredentialEnvironmentVariable",
      },
    });
  });

  it("拒绝同一 Agent 的多条路由引用不同静态 MCP credential", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      environment: [
        ...draft.environment,
        {
          name: "MULTICA_AGENT_1_SECOND_TOKEN",
          value: "second-token",
          sensitive: true,
        },
      ],
      assigneeRoutes: [
        {
          codeworkAgentId: "agent-1",
          codeworkSquadId: "squad-1",
          workspaceId: "workspace-1",
          multicaAgentId: "",
          multicaSquadId: "remote-squad-1",
          codeworkMcpCredentialEnvironmentVariable: "MULTICA_AGENT_1_CODEWORK_MCP_TOKEN",
        },
        {
          codeworkAgentId: "agent-1",
          codeworkSquadId: "squad-2",
          workspaceId: "workspace-1",
          multicaAgentId: "",
          multicaSquadId: "remote-squad-2",
          codeworkMcpCredentialEnvironmentVariable: "MULTICA_AGENT_1_SECOND_TOKEN",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.1.codeworkMcpCredentialEnvironmentVariable",
      },
    });
  });

  it("拒绝 supportsMcp=false 时保存静态 credential 或 taskMcpEndpoint", () => {
    const staticDraft = validDraft();
    expect(validateMulticaRuntimeDraft({ ...staticDraft, supportsMcp: false })).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.0.codeworkMcpCredentialEnvironmentVariable",
      },
    });

    expect(
      validateMulticaRuntimeDraft({
        ...staticDraft,
        supportsMcp: false,
        taskMcpEndpoint: "http://127.0.0.1:4317/mcp",
        assigneeRoutes: staticDraft.assigneeRoutes.map((route) => ({
          ...route,
          codeworkMcpCredentialEnvironmentVariable: "",
        })),
      }),
    ).toEqual({
      ok: false,
      issue: { code: "invalid_task_mcp_endpoint", path: "taskMcpEndpoint" },
    });
  });

  it("拒绝 taskMcpEndpoint 与会被 Server 忽略的静态 credential 同时存在", () => {
    const draft = validDraft();
    expect(
      validateMulticaRuntimeDraft({
        ...draft,
        taskMcpEndpoint: "http://127.0.0.1:4317/mcp/composition-runtime",
      }),
    ).toEqual({
      ok: false,
      issue: {
        code: "invalid_assignee_route",
        path: "assigneeRoutes.0.codeworkMcpCredentialEnvironmentVariable",
      },
    });
  });

  it("允许 supportsMcp=true 的每 Run endpoint 模式且不保存静态 credential", () => {
    const draft = validDraft();
    const result = validateMulticaRuntimeDraft({
      ...draft,
      taskMcpEndpoint: " http://127.0.0.1:4317/mcp/composition-runtime ",
      assigneeRoutes: draft.assigneeRoutes.map((route) => ({
        ...route,
        codeworkMcpCredentialEnvironmentVariable: "",
      })),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config.taskMcpEndpoint).toBe(
      "http://127.0.0.1:4317/mcp/composition-runtime",
    );
    expect(result.value.config.assigneeRoutes[0]?.codeworkMcpCredentialEnvironmentVariable).toBe(
      undefined,
    );
  });

  it.each([
    {
      name: "非法实例 ID",
      patch: { instanceId: "9-invalid" },
      code: "invalid_instance_id",
      path: "instanceId",
    },
    {
      name: "非 HTTP baseUrl",
      patch: { baseUrl: "ws://127.0.0.1:9000" },
      code: "invalid_base_url",
      path: "baseUrl",
    },
    {
      name: "内嵌凭据的 baseUrl",
      patch: { baseUrl: "https://operator:secret@multica.test/api" },
      code: "invalid_base_url",
      path: "baseUrl",
    },
    {
      name: "携带查询参数的 baseUrl",
      patch: { baseUrl: "https://multica.test/api?token=secret" },
      code: "invalid_base_url",
      path: "baseUrl",
    },
    {
      name: "Header 引用缺失环境变量",
      patch: {
        headers: [{ headerName: "Authorization", environmentVariable: "MISSING_TOKEN" }],
      },
      code: "invalid_header_binding",
      path: "headers.0.environmentVariable",
    },
    {
      name: "同一路由同时绑定远端 Agent 和 Squad",
      patch: {
        assigneeRoutes: [
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "",
            workspaceId: "workspace-1",
            multicaAgentId: "remote-agent-1",
            multicaSquadId: "remote-squad-1",
            codeworkMcpCredentialEnvironmentVariable: "",
          },
        ],
      },
      code: "invalid_assignee_route",
      path: "assigneeRoutes.0",
    },
    {
      name: "Agent 路由重复",
      patch: {
        assigneeRoutes: [
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "",
            workspaceId: "workspace-1",
            multicaAgentId: "remote-agent-1",
            multicaSquadId: "",
            codeworkMcpCredentialEnvironmentVariable: "",
          },
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "",
            workspaceId: "workspace-2",
            multicaAgentId: "remote-agent-2",
            multicaSquadId: "",
            codeworkMcpCredentialEnvironmentVariable: "",
          },
        ],
      },
      code: "invalid_assignee_route",
      path: "assigneeRoutes.1.codeworkAgentId",
    },
    {
      name: "非法 task MCP endpoint",
      patch: { taskMcpEndpoint: "file:///tmp/mcp" },
      code: "invalid_task_mcp_endpoint",
      path: "taskMcpEndpoint",
    },
    {
      name: "内嵌凭据的 task MCP endpoint",
      patch: { taskMcpEndpoint: "https://operator:secret@codework.test/mcp" },
      code: "invalid_task_mcp_endpoint",
      path: "taskMcpEndpoint",
    },
    {
      name: "携带凭据查询的 task MCP endpoint",
      patch: { taskMcpEndpoint: "https://codework.test/mcp?access_token=secret" },
      code: "invalid_task_mcp_endpoint",
      path: "taskMcpEndpoint",
    },
    {
      name: "非法执行扩展超时",
      patch: {
        taskExecutionExtension: {
          command: "node",
          args: [],
          cwd: "",
          timeoutMs: "0",
        },
      },
      code: "invalid_task_execution_extension",
      path: "taskExecutionExtension.timeoutMs",
    },
  ])("拒绝$name", ({ patch, code, path }) => {
    expect(validateMulticaRuntimeDraft({ ...validDraft(), ...patch })).toEqual({
      ok: false,
      issue: { code, path },
    });
  });
});
