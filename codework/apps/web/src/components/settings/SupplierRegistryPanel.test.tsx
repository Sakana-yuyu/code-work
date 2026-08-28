import type { CompositionSupplierRegistryResult } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  registryAtom: Symbol("registry"),
  setEnabledCommand: Symbol("set-enabled-command"),
  updateCredentialCommand: Symbol("update-credential-command"),
  setEnabled: vi.fn(),
  updateCredential: vi.fn(),
  registryQuery: {
    data: null as CompositionSupplierRegistryResult | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => mocks.environment,
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === mocks.registryAtom) return mocks.registryQuery;
    return {
      data: null,
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    supplierRegistry: () => mocks.registryAtom,
    supplierSetInstanceEnabled: mocks.setEnabledCommand,
    supplierUpdateCredential: mocks.updateCredentialCommand,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === mocks.setEnabledCommand) return mocks.setEnabled;
    if (command === mocks.updateCredentialCommand) return mocks.updateCredential;
    return vi.fn();
  },
}));

import { SupplierRegistryPanel, buildSupplierCredentialInput } from "./SupplierRegistryPanel";

const registry = (): CompositionSupplierRegistryResult => ({
  generatedAtUnixMs: 1_000,
  suppliers: [
    {
      instanceId: "instance-byok-1",
      driverKind: "byok",
      displayName: "BYOK OpenRouter",
      enabled: true,
      continuationKey: "byok:instance:instance-byok-1",
      defaultModelId: "openrouter/auto",
      profile: {
        agentId: "provider:instance-byok-1",
        runtimeId: "byok:instance-byok-1",
        status: "available",
        supportsResume: true,
      },
    },
    {
      instanceId: "instance-provider-1",
      driverKind: "provider",
      enabled: false,
      continuationKey: "provider:instance:instance-provider-1",
    },
  ],
  orphanProfileAgentIds: ["provider:instance-removed"],
});

describe("SupplierRegistryPanel", () => {
  beforeEach(() => {
    mocks.environment = { environmentId: "env-1" };
    mocks.registryQuery.data = null;
    mocks.registryQuery.error = null;
    mocks.registryQuery.isPending = false;
    mocks.registryQuery.refresh = vi.fn();
    mocks.setEnabled = vi.fn();
    mocks.updateCredential = vi.fn();
  });

  it("渲染 Supplier 条目：名称/驱动类型/启用态/账号锚点/默认模型/档案摘要", () => {
    mocks.registryQuery.data = registry();
    const html = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(html).toContain('data-supplier-id="instance-byok-1"');
    expect(html).toContain('data-supplier-id="instance-provider-1"');
    expect(html).toContain("BYOK OpenRouter");
    expect(html).toContain("byok:instance:instance-byok-1");
    expect(html).toContain("openrouter/auto");
    expect(html).toContain("provider:instance-byok-1");
    const plainRow = html.split('data-supplier-id="instance-provider-1"')[1] ?? "";
    expect(plainRow).toContain("provider:instance:instance-provider-1");
    expect(plainRow).not.toContain("openrouter");
  });

  it("渲染孤儿档案提示", () => {
    mocks.registryQuery.data = registry();
    const html = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(html).toContain('data-testid="supplier-registry-orphans"');
    expect(html).toContain("provider:instance-removed");
  });

  it("无孤儿时不渲染提示行", () => {
    mocks.registryQuery.data = {
      generatedAtUnixMs: 1_000,
      suppliers: registry().suppliers.slice(0, 1),
      orphanProfileAgentIds: [],
    };
    const html = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(html).not.toContain("supplier-registry-orphans");
  });

  it("每个 Supplier 行渲染启用/禁用切换与凭据更新入口，表单默认不展开", () => {
    mocks.registryQuery.data = registry();
    const html = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(html).toContain('data-testid="supplier-toggle-instance-byok-1"');
    expect(html).toContain('data-testid="supplier-toggle-instance-provider-1"');
    expect(html).toContain('data-testid="supplier-credential-toggle-instance-byok-1"');
    expect(html).toContain('data-testid="supplier-credential-toggle-instance-provider-1"');
    // 表单懒展开：未点击前不渲染任何凭据输入。
    expect(html).not.toContain("supplier-credential-form-");
    expect(html).not.toContain("supplier-credential-submit-");
  });

  it("buildSupplierCredentialInput：byok 走适配器 apiKey，其余驱动走环境变量，目标去除空白", () => {
    expect(
      buildSupplierCredentialInput({
        driverKind: "byok",
        target: " adapter-1 ",
        secret: "sk-new",
      }),
    ).toEqual({ kind: "byok_adapter", adapterId: "adapter-1", apiKey: "sk-new" });
    expect(
      buildSupplierCredentialInput({
        driverKind: "codex",
        target: "CODEX_API_KEY",
        secret: "env-secret",
      }),
    ).toEqual({ kind: "environment_variable", name: "CODEX_API_KEY", value: "env-secret" });
  });

  it("无环境/加载中/错误/空数据四种状态均正常渲染且不输出 undefined", () => {
    mocks.environment = null;
    const noEnv = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(noEnv).not.toContain("data-supplier-id");
    expect(noEnv).not.toContain("undefined");

    mocks.environment = { environmentId: "env-1" };
    mocks.registryQuery.isPending = true;
    const pending = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(pending).not.toContain("data-supplier-id");
    expect(pending).not.toContain("undefined");

    mocks.registryQuery.isPending = false;
    mocks.registryQuery.error = "boom";
    const errored = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(errored).not.toContain("data-supplier-id");
    expect(errored).not.toContain("undefined");

    mocks.registryQuery.error = null;
    mocks.registryQuery.data = {
      generatedAtUnixMs: 1_000,
      suppliers: [],
      orphanProfileAgentIds: [],
    };
    const empty = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(empty).not.toContain("data-supplier-id");
    expect(empty).not.toContain("undefined");
  });

  it("投影为 null 且非 pending 时按空数据处理", () => {
    mocks.registryQuery.data = null;
    const html = renderToStaticMarkup(<SupplierRegistryPanel />);
    expect(html).not.toContain("data-supplier-id");
    expect(html).not.toContain("undefined");
  });
});
