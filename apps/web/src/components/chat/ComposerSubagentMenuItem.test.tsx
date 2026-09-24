import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { setCurrentLanguage, t } from "~/i18n/runtime";
import {
  ComposerAddMenuBody,
  ComposerSubagentModePill,
  type ComposerSpecWorkflowControl,
  type ComposerSubagentModeControl,
} from "./ComposerAddMenu";

const specWorkflow: ComposerSpecWorkflowControl = {
  available: true,
  enabled: true,
  selectedIntent: "workflow",
  flags: [],
  isPending: false,
  hasError: false,
  workflowState: null,
  workflowStateIsPending: false,
  workflowStateHasError: false,
  onToggle: async () => true,
  onSelectIntent: async () => true,
  onToggleFlag: async () => true,
  onApproveProposal: async () => true,
  onRejectProposal: async () => true,
  onCompleteAcceptance: async () => true,
  onPause: async () => true,
  onResume: async () => true,
};

const subagentMode: ComposerSubagentModeControl = {
  available: true,
  kind: "delegation",
  enabled: false,
  isPending: false,
  onToggle: async () => true,
};

const renderMenuBody = (
  overrides: {
    readonly subagentMode?: Partial<ComposerSubagentModeControl>;
  } = {},
) =>
  renderToStaticMarkup(
    <ComposerAddMenuBody
      disabled={false}
      interactionMode="default"
      planModeEnabled={true}
      canEditGoal={false}
      goal={null}
      goalIsPending={false}
      goalErrorMessage={null}
      pluginItems={[]}
      onAddFileReference={() => true}
      onAddSkillReference={() => true}
      onAddThreadReference={() => {}}
      onTogglePlanMode={() => {}}
      onSelectGoal={() => {}}
      onSetGoal={async () => true}
      onPauseGoal={async () => true}
      onResumeGoal={async () => true}
      onClearGoal={async () => true}
      specWorkflow={specWorkflow}
      subagentMode={{ ...subagentMode, ...overrides.subagentMode }}
      onDismiss={() => {}}
      showWorkflowNodes={false}
      onToggleWorkflowNodes={() => {}}
    />,
  );

describe("加号菜单子代理模式项", () => {
  it("关闭态展示开启引导，开启态展示已启用说明", () => {
    setCurrentLanguage("zh-CN");
    const off = renderMenuBody();
    expect(off).toContain(t("composer.subagentMode"));
    expect(off).toContain(t("composer.subagentModeDisabledDescription"));
    expect(off).not.toContain(t("composer.subagentModeEnabledDescription"));
    expect(off).not.toContain(t("composer.subagentModeRequiresByok"));

    const on = renderMenuBody({ subagentMode: { enabled: true } });
    expect(on).toContain(t("composer.subagentModeEnabledDescription"));
    expect(on).not.toContain(t("composer.subagentModeDisabledDescription"));
  });

  it("非 BYOK 实例时整项置灰并提示需要自定义模型服务", () => {
    setCurrentLanguage("zh-CN");
    // canEditGoal=false 时目标项恒为禁用，构成基线；子代理项不可用时额外多一个禁用按钮。
    const available = renderMenuBody();
    expect(available.match(/disabled=""/g)).toHaveLength(1);
    const unavailable = renderMenuBody({ subagentMode: { available: false } });
    expect(unavailable).toContain(t("composer.subagentModeRequiresByok"));
    expect(unavailable.match(/disabled=""/g)).toHaveLength(2);
  });

  it("codex/claude 原生子代理:开与关分别显示原生说明", () => {
    setCurrentLanguage("zh-CN");
    const nativeOff = renderMenuBody({ subagentMode: { kind: "native" } });
    expect(nativeOff).toContain(t("composer.subagentModeNativeDisabledDescription"));
    expect(nativeOff).not.toContain(t("composer.subagentModeDisabledDescription"));
    const nativeOn = renderMenuBody({ subagentMode: { kind: "native", enabled: true } });
    expect(nativeOn).toContain(t("composer.subagentModeNativeEnabledDescription"));
  });

  it("保存中说明切换为进行时文案", () => {
    setCurrentLanguage("zh-CN");
    expect(renderMenuBody({ subagentMode: { isPending: true } })).toContain(
      t("composer.subagentModeSaving"),
    );
  });

  it("三种语言的标题与全部说明均有翻译", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      for (const key of [
        "composer.subagentMode",
        "composer.subagentModeDisabledDescription",
        "composer.subagentModeEnabledDescription",
        "composer.subagentModeRequiresByok",
        "composer.subagentModeSaving",
      ] as const) {
        expect(t(key)).not.toBe(key);
      }
    }
    setCurrentLanguage("zh-CN");
  });
});

describe("子代理模式胶囊", () => {
  it("关闭时不渲染，开启后显示名称与可访问的关闭入口", () => {
    setCurrentLanguage("zh-CN");
    expect(renderToStaticMarkup(<ComposerSubagentModePill control={subagentMode} />)).toBe("");
    const markup = renderToStaticMarkup(
      <ComposerSubagentModePill control={{ ...subagentMode, enabled: true }} />,
    );
    expect(markup).toContain('data-subagent-mode-pill="true"');
    expect(markup).toContain(t("composer.subagentMode"));
    expect(markup).toContain(`aria-label="${t("composer.subagentModeDisable")}"`);
  });

  it("保存中时关闭入口置灰", () => {
    setCurrentLanguage("zh-CN");
    const markup = renderToStaticMarkup(
      <ComposerSubagentModePill control={{ ...subagentMode, enabled: true, isPending: true }} />,
    );
    expect(markup).toContain(`aria-label="${t("composer.subagentModeDisable")}"`);
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });

  it("关闭入口与保存失败提示均有三语翻译", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      expect(t("composer.subagentModeDisable")).not.toBe("composer.subagentModeDisable");
      expect(t("composer.subagentModeSaveFailed")).not.toBe("composer.subagentModeSaveFailed");
    }
    setCurrentLanguage("zh-CN");
  });
});
