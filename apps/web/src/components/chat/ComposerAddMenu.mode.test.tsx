import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { setCurrentLanguage, t } from "~/i18n/runtime";
import { ComposerAddMenuBody, type ComposerAddMenuBodyProps } from "./ComposerAddMenu";

const succeed = async () => true;
const props: ComposerAddMenuBodyProps = {
  disabled: false,
  interactionMode: "plan",
  planModeEnabled: false,
  planModeAvailable: false,
  subagentMode: {
    available: false,
    kind: "native",
    enabled: false,
    isPending: false,
    onToggle: succeed,
  },
  canEditGoal: true,
  goal: null,
  goalIsPending: false,
  goalErrorMessage: null,
  pluginItems: [],
  onAddFileReference: () => true,
  onAddSkillReference: () => true,
  onAddThreadReference: () => {},
  onTogglePlanMode: () => {},
  onSelectGoal: () => {},
  onSetGoal: succeed,
  onPauseGoal: succeed,
  onResumeGoal: succeed,
  onClearGoal: succeed,
  onDismiss: () => {},
  showWorkflowNodes: false,
  onToggleWorkflowNodes: () => {},
  specWorkflow: {
    available: false,
    enabled: false,
    selectedIntent: "design",
    flags: [],
    isPending: false,
    hasError: false,
    workflowState: null,
    workflowStateIsPending: false,
    workflowStateHasError: false,
    onToggle: succeed,
    onSelectIntent: succeed,
    onToggleFlag: succeed,
    onApproveProposal: succeed,
    onRejectProposal: succeed,
    onCompleteAcceptance: succeed,
    onPause: succeed,
    onResume: succeed,
  },
};

describe("添加菜单的实例模式边界", () => {
  for (const language of ["zh-CN", "en", "ja"] as const) {
    it(`${language} 未声明两态时撤回模式入口，文件、技能和目标继续可用`, () => {
      setCurrentLanguage(language);
      const markup = renderToStaticMarkup(<ComposerAddMenuBody {...props} />);
      expect(markup).not.toContain(t("composer.planMode"));
      expect(markup).not.toContain(t("composer.planModeDisabledDescription"));
      expect(markup).toContain(t("composer.addFilesAndFolders"));
      expect(markup).toContain(t("composer.addSkill"));
      expect(markup).toContain(t("composer.addGoal"));
    });
  }
  it("能力恢复后显示模式且旧调用者保留禁用提示的兼容行为", () => {
    setCurrentLanguage("zh-CN");
    const enabled = renderToStaticMarkup(
      <ComposerAddMenuBody {...props} planModeAvailable planModeEnabled />,
    );
    expect(enabled).toContain(t("composer.planMode"));
    expect(enabled).toContain(t("switchThisThreadBackToNormalBuildMode"));
    const { planModeAvailable: _available, ...legacy } = props;
    expect(renderToStaticMarkup(<ComposerAddMenuBody {...legacy} />)).toContain(
      t("composer.planModeDisabledDescription"),
    );
  });
});
