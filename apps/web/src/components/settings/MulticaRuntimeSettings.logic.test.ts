import { ProviderDriverKind } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  nextMulticaRuntimeInstanceId,
} from "./MulticaRuntimeSettings.logic";

describe("MulticaRuntimeSettings logic", () => {
  it("从 Multica provider instance 读取完整草稿并记录 Secret 原始身份", () => {
    const draft = formFromMulticaRuntimeInstance("multica_local", {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      environment: [
        { name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true },
        { name: "VISIBLE_VALUE", value: "visible", sensitive: false },
      ],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [
          {
            codeworkAgentId: "agent-1",
            codeworkSquadId: "squad-1",
            workspaceId: "workspace-1",
            multicaSquadId: "remote-squad-1",
          },
        ],
        taskExecutionExtension: {
          command: "node",
          args: ["extension.mjs"],
          timeoutMs: 4000,
        },
      },
    });

    expect(draft).toMatchObject({
      instanceId: "multica_local",
      originalInstanceId: "multica_local",
      runtimeId: "multica:daemon-1:runtime-1",
      daemonId: "daemon-1",
      daemonRuntimeId: "runtime-1",
      baseUrl: "http://127.0.0.1:9000",
      enabled: true,
      environment: [
        {
          name: "MULTICA_TOKEN",
          originalName: "MULTICA_TOKEN",
          value: "",
          valueRedacted: true,
        },
        { name: "VISIBLE_VALUE", value: "visible" },
      ],
      assigneeRoutes: [
        {
          codeworkAgentId: "agent-1",
          codeworkSquadId: "squad-1",
          workspaceId: "workspace-1",
          multicaAgentId: "",
          multicaSquadId: "remote-squad-1",
        },
      ],
      taskExecutionExtension: {
        command: "node",
        args: ["extension.mjs"],
        cwd: "",
        timeoutMs: "4000",
      },
    });
  });

  it("已保存敏感值即使快照意外含明文也只生成脱敏占位", () => {
    const draft = formFromMulticaRuntimeInstance("multica_local", {
      driver: ProviderDriverKind.make("multica"),
      enabled: true,
      environment: [{ name: "MULTICA_TOKEN", value: "fixture-secret", sensitive: true }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    });

    expect(draft?.environment[0]).toEqual({
      name: "MULTICA_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
      originalName: "MULTICA_TOKEN",
    });
    expect(JSON.stringify(draft)).not.toContain("fixture-secret");
  });

  it("历史误标为非敏感的 Private-Token 也不会进入草稿", () => {
    const draft = formFromMulticaRuntimeInstance("multica_local", {
      driver: ProviderDriverKind.make("multica"),
      environment: [{ name: "MULTICA_TOKEN", value: "legacy-fixture-secret", sensitive: false }],
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "http://127.0.0.1:9000",
        headers: [{ headerName: "Private-Token", environmentVariable: "MULTICA_TOKEN" }],
        assigneeRoutes: [],
      },
    });

    expect(draft?.environment[0]).toEqual({
      name: "MULTICA_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
      originalName: "MULTICA_TOKEN",
    });
    expect(JSON.stringify(draft)).not.toContain("legacy-fixture-secret");
  });

  it("拒绝非 Multica 或无法解码的 provider instance", () => {
    expect(
      formFromMulticaRuntimeInstance("codex_local", {
        driver: ProviderDriverKind.make("codex"),
      }),
    ).toBeNull();
    expect(
      formFromMulticaRuntimeInstance("multica_local", {
        driver: ProviderDriverKind.make("multica"),
        config: { runtimeId: "" },
      }),
    ).toBeNull();
  });

  it("拒绝会把 URL 凭据带入设置界面的已保存 Runtime", () => {
    const base = {
      driver: ProviderDriverKind.make("multica"),
      config: {
        runtimeId: "multica:daemon-1:runtime-1",
        daemonId: "daemon-1",
        daemonRuntimeId: "runtime-1",
        baseUrl: "https://multica.test/api",
        headers: [],
        assigneeRoutes: [],
      },
    };

    expect(
      formFromMulticaRuntimeInstance("multica_local", {
        ...base,
        config: {
          ...base.config,
          baseUrl: "https://operator:secret@multica.test/api",
        },
      }),
    ).toBeNull();
    expect(
      formFromMulticaRuntimeInstance("multica_local", {
        ...base,
        config: {
          ...base.config,
          taskMcpEndpoint: "https://codework.test/mcp?access_token=secret",
        },
      }),
    ).toBeNull();
  });

  it("为新实例创建不冒充既有 Secret 身份的默认草稿", () => {
    expect(emptyMulticaRuntimeDraft()).toMatchObject({
      instanceId: "multica_local",
      originalInstanceId: null,
      baseUrl: "http://127.0.0.1:9000",
      environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true }],
    });
  });

  it("为新增 Runtime 生成不覆盖现有实例的稳定 ID", () => {
    expect(nextMulticaRuntimeInstanceId({})).toBe("multica_local");
    expect(
      nextMulticaRuntimeInstanceId({
        multica_local: { driver: ProviderDriverKind.make("multica") },
        multica_local_2: { driver: ProviderDriverKind.make("multica") },
      }),
    ).toBe("multica_local_3");
  });
});
