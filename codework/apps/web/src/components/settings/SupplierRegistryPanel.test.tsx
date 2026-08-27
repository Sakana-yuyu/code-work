import type { CompositionSupplierRegistryResult } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  environment: null as { readonly environmentId: string } | null,
  registryAtom: Symbol("registry"),
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
  },
}));

import { SupplierRegistryPanel } from "./SupplierRegistryPanel";

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
