import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ByokModelAdapter } from "@codework/contracts";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { t } from "~/i18n";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, ...reactHookHarness };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    _tag: "Success",
    value: [
      {
        id: "openrouter",
        label: "OpenRouter",
        protocol: "openai",
        defaultBaseURL: "https://openrouter.ai/api/v1",
        iconLight: false,
        modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
        modelCatalogStatus: "openai_models",
        appendGeneratedCandidates: true,
      },
    ],
  }),
}));
vi.mock("../../state/server", async (original) => ({
  ...(await original<typeof import("../../state/server")>()),
  byokEnvironment: {
    supplierCatalog: () => null,
    discoverModels: Symbol("discoverModels"),
    benchmarkModel: Symbol("benchmarkModel"),
    matchContextWindows: Symbol("matchContextWindows"),
    discoverDraftModels: Symbol("discoverDraftModels"),
    catalogModelLookup: Symbol("catalogModelLookup"),
  },
}));
vi.mock("../../state/byokBalance", () => ({
  useByokBalanceDashboards: () => ({ merged: { adapters: [] } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { ByokModelAdaptersSection } from "./ByokModelAdaptersSection";

beforeEach(() => hooks.reset());

describe("适配器保存目录配置", () => {
  for (const scenario of ["保留自定义目录", "保留空目录", "目标变更", "使用模板默认值"] as const) {
    it(scenario, async () => {
      const hasSavedCatalog = scenario !== "使用模板默认值";
      const adapter: ByokModelAdapter = {
        id: "model-1",
        displayName: "Model",
        supplierID: "openrouter",
        protocol: "openai",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: "sk-test",
        balanceAccessToken: "",
        customHeaders: "",
        modelId: "openai/test-model",
        contextWindowTokens: 128_000,
        ...(hasSavedCatalog
          ? {
              modelCatalogURL: "https://openrouter.ai/api/v1/private-models",
              modelCatalogURLs:
                scenario === "保留空目录" ? [] : ["https://openrouter.ai/api/v1/private-models"],
              modelCatalogStatus: "manual_only" as const,
              appendModelCatalogCandidates: false,
            }
          : {}),
      };
      const onChange = vi.fn((_next: ReadonlyArray<ByokModelAdapter>) => true);
      const render = () => {
        hooks.beginRender();
        return ByokModelAdaptersSection({
          environmentId: "remote-test",
          instanceId: "byok",
          adapters: [adapter],
          onChange,
        });
      };
      const element = (predicate: Parameters<typeof visitElements>[1]) => {
        const found = visitElements(render(), predicate);
        expect(found).not.toBeNull();
        return found!;
      };
      const relay = element(
        (entry) => entry.type === "button" && String(entry.props.className).includes("group/relay"),
      );
      (relay.props.onClick as () => void)();
      const edit = element(
        (entry) => entry.props["aria-label"] === `${t("byokAdapters.editAdapter")}: Model`,
      );
      (edit.props.onClick as () => void)();
      const groupName = element(
        (entry) => entry.props.id === "byok-adapter-byok-model-1-group-name",
      );
      (groupName.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "新分组名称" },
      });
      if (scenario === "目标变更") {
        const baseURL = element(
          (entry) => entry.props["data-facilities-guide-target"] === "providers-base-url",
        );
        (baseURL.props.onChange as (event: { target: { value: string } }) => void)({
          target: { value: "https://relay.example/v1" },
        });
      }
      const save = element(
        (entry) => entry.props["data-facilities-guide-target"] === "providers-save-channel",
      );
      await (save.props.onClick as () => Promise<void>)();
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0]![0];
      expect(next[0]?.groupName).toBe("新分组名称");
      if (hasSavedCatalog && scenario !== "目标变更") {
        expect(next[0]).toMatchObject({
          modelCatalogURL: adapter.modelCatalogURL,
          modelCatalogURLs: adapter.modelCatalogURLs,
          modelCatalogStatus: "manual_only",
          appendModelCatalogCandidates: false,
        });
      } else {
        expect(next[0]).toMatchObject({
          modelCatalogURLs: ["https://openrouter.ai/api/v1/models"],
          modelCatalogStatus: "openai_models",
          appendModelCatalogCandidates: true,
        });
        expect(next[0]?.modelCatalogURL).toBeUndefined();
      }
    });
  }
});
