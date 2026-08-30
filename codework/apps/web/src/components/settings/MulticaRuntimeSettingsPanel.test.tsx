import { ProviderDriverKind, type ProviderInstanceConfig } from "@codework/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  type MulticaRuntimeDraft,
} from "./MulticaRuntimeSettings.logic";
import { MulticaRuntimeSettingsEditor } from "./MulticaRuntimeSettingsEditor";
import {
  MulticaRuntimeSettingsPanel,
  persistMulticaRuntimeDraft,
  type MulticaRuntimeSettingsText,
} from "./MulticaRuntimeSettingsPanel";
import { MulticaRuntimeInstanceRow } from "./MulticaRuntimeInstanceRow";

const text: MulticaRuntimeSettingsText = (key) => `文案:${key}`;
const noop = () => undefined;

const validDraft = (): MulticaRuntimeDraft => ({
  ...emptyMulticaRuntimeDraft(),
  runtimeId: "multica:daemon-1:runtime-1",
  daemonId: "daemon-1",
  daemonRuntimeId: "runtime-1",
  environment: [{ name: "MULTICA_TOKEN", value: "new-secret", sensitive: true }],
});

const savedInstance = (secretValue: string): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make("multica"),
  enabled: true,
  environment: [{ name: "MULTICA_TOKEN", value: secretValue, sensitive: true }],
  config: {
    runtimeId: "multica:daemon-1:runtime-1",
    daemonId: "daemon-1",
    daemonRuntimeId: "runtime-1",
    baseUrl: "http://127.0.0.1:9000",
    headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
    assigneeRoutes: [],
  },
});

const renderEditor = (
  initialDraft: MulticaRuntimeDraft,
  draft: MulticaRuntimeDraft,
  saveState: "idle" | "saving" | "error" | "conflict" = "idle",
): string =>
  renderToStaticMarkup(
    <MulticaRuntimeSettingsEditor
      text={text}
      mode="edit"
      initialDraft={initialDraft}
      draft={draft}
      saveState={saveState}
      onDraftChange={noop}
      onCancel={noop}
      onSave={noop}
    />,
  );

const saveButtonMarkup = (html: string): string => {
  const markup = html.match(/<button[^>]*data-testid="multica-runtime-save"[^>]*>/u)?.[0];
  expect(markup).toBeDefined();
  return markup ?? "";
};

const isButtonDisabled = (markup: string): boolean => /\sdisabled(?:=""|(?=[ >]))/u.test(markup);

describe("MulticaRuntimeSettingsPanel", () => {
  it("明确展示加载中和加载失败重试状态", () => {
    const loadingHtml = renderToStaticMarkup(
      <MulticaRuntimeSettingsPanel
        scopeKey="environment-1"
        text={text}
        state={{ status: "loading" }}
        onRetryLoad={noop}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const failedHtml = renderToStaticMarkup(
      <MulticaRuntimeSettingsPanel
        scopeKey="environment-1"
        text={text}
        state={{ status: "error" }}
        onRetryLoad={noop}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(loadingHtml).toContain("文案:loadingTitle");
    expect(loadingHtml).toContain("文案:loadingDescription");
    expect(failedHtml).toContain("文案:loadFailedTitle");
    expect(failedHtml).toContain("文案:loadFailedDescription");
    expect(failedHtml).toContain('data-testid="multica-runtime-retry-load"');
  });

  it("编辑已保存 Runtime 时不回显敏感 Authorization 值", () => {
    const draft = formFromMulticaRuntimeInstance("multica_local", savedInstance("fixture-secret"));
    expect(draft).not.toBeNull();

    const html = renderEditor(draft ?? validDraft(), draft ?? validDraft());

    expect(html).not.toContain("fixture-secret");
    expect(html).toContain('type="password"');
    expect(html).toContain('placeholder="文案:savedSecretPlaceholder"');
  });

  it("损坏的已保存配置只显示不可编辑告警而不回退假数据", () => {
    const html = renderToStaticMarkup(
      <MulticaRuntimeSettingsPanel
        scopeKey="environment-1"
        text={text}
        state={{
          status: "ready",
          instances: {
            multica_broken: {
              driver: ProviderDriverKind.make("multica"),
              config: { runtimeId: "" },
            },
          },
        }}
        onRetryLoad={noop}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain("文案:invalidSavedTitle");
    expect(html).toContain("文案:invalidSavedDescription");
    expect(html).not.toContain("http://127.0.0.1:9000");
    expect(html).toMatch(/aria-label="文案:edit multica_broken"[^>]*disabled/u);
  });

  it("使用已解码配置的 enabled 值展示旧 Runtime 的真实禁用状态", () => {
    const instance = savedInstance("fixture-secret");
    const { enabled: _ignoredEnabled, ...instanceWithoutEnvelopeEnabled } = instance;
    const html = renderToStaticMarkup(
      <MulticaRuntimeSettingsPanel
        scopeKey="environment-1"
        text={text}
        state={{
          status: "ready",
          instances: {
            multica_disabled: {
              ...instanceWithoutEnvelopeEnabled,
              config: { ...(instance.config as object), enabled: false },
            },
          },
        }}
        onRetryLoad={noop}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain("文案:disabled");
  });

  it("已有 Runtime 的 URL 嵌入凭据时不在列表输出明文", () => {
    const instance = savedInstance("fixture-secret");
    const html = renderToStaticMarkup(
      <MulticaRuntimeSettingsPanel
        scopeKey="environment-1"
        text={text}
        state={{
          status: "ready",
          instances: {
            multica_unsafe: {
              ...instance,
              config: {
                ...(instance.config as object),
                baseUrl: "https://operator:embedded-secret@multica.test/api?token=query-secret",
              },
            },
          },
        }}
        onRetryLoad={noop}
        onSave={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(html).toContain("文案:invalidSavedTitle");
    expect(html).not.toContain("embedded-secret");
    expect(html).not.toContain("query-secret");
  });

  it("pristine 草稿禁用保存，发生有效修改后标记脏状态并允许保存", () => {
    const initial = validDraft();
    const pristineHtml = renderEditor(initial, initial);
    const dirtyHtml = renderEditor(initial, {
      ...initial,
      baseUrl: "http://127.0.0.1:9100",
    });

    expect(isButtonDisabled(saveButtonMarkup(pristineHtml))).toBe(true);
    expect(pristineHtml).not.toContain("文案:unsavedChanges");
    expect(isButtonDisabled(saveButtonMarkup(dirtyHtml))).toBe(false);
    expect(dirtyHtml).toContain("文案:unsavedChanges");
  });

  it("无效配置禁用保存并显示类型化校验文案", () => {
    const initial = validDraft();
    const html = renderEditor(initial, { ...initial, baseUrl: "not-a-url" });

    expect(isButtonDisabled(saveButtonMarkup(html))).toBe(true);
    expect(html).toContain("文案:issue.invalid_base_url");
  });

  it("保存失败保留脏草稿并显示稳定失败文案", () => {
    const initial = validDraft();
    const draft = { ...initial, baseUrl: "http://127.0.0.1:9200" };
    const html = renderEditor(initial, draft, "error");

    expect(html).toContain("http://127.0.0.1:9200");
    expect(html).toContain("文案:unsavedChanges");
    expect(html).toContain("文案:saveFailed");
    expect(isButtonDisabled(saveButtonMarkup(html))).toBe(false);
  });

  it("保存冲突锁定草稿并显示稳定冲突文案", () => {
    const initial = validDraft();
    const draft = { ...initial, baseUrl: "http://127.0.0.1:9200" };
    const html = renderEditor(initial, draft, "conflict");

    expect(html).toContain("文案:saveConflict");
    expect(html).not.toContain("raw persistence failure");
    expect(isButtonDisabled(saveButtonMarkup(html))).toBe(true);
  });

  it("删除冲突显示稳定文案而不回显服务端错误", () => {
    const html = renderToStaticMarkup(
      <MulticaRuntimeInstanceRow
        text={text}
        instanceId="multica_local"
        enabled
        draft={validDraft()}
        disabled={false}
        deleting={false}
        deleteFailure="conflict"
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(html).toContain("文案:deleteConflict");
    expect(html).not.toContain("raw persistence failure");
  });

  it("保存回调拒绝时返回稳定 error 结果", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("raw persistence failure"));

    await expect(persistMulticaRuntimeDraft(validDraft(), null, onSave)).resolves.toBe("error");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      originalInstanceId: null,
      instanceId: "multica_local",
      config: { runtimeId: "multica:daemon-1:runtime-1" },
    });
  });

  it("仅将 RPC 稳定 _tag 或 code 映射为保存冲突", async () => {
    await expect(
      persistMulticaRuntimeDraft(
        validDraft(),
        null,
        vi.fn().mockRejectedValue({
          _tag: "ServerSettingsConflictError",
          message: "不应显示",
        }),
      ),
    ).resolves.toBe("conflict");
    await expect(
      persistMulticaRuntimeDraft(
        validDraft(),
        null,
        vi.fn().mockRejectedValue({
          code: "ServerSettingsConflictError",
          message: "不应显示",
        }),
      ),
    ).resolves.toBe("conflict");
    await expect(
      persistMulticaRuntimeDraft(
        validDraft(),
        null,
        vi.fn().mockRejectedValue(new Error("ServerSettingsConflictError")),
      ),
    ).resolves.toBe("error");
  });
});
