import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SpecWorkflowIntentName } from "@codework/contracts";
import { setCurrentLanguage, t } from "~/i18n/runtime";
import {
  ComposerSpecWorkflowPill,
  SpecWorkflowNodePicker,
  type ComposerSpecWorkflowControl,
} from "./ComposerAddMenu";

const control: ComposerSpecWorkflowControl = {
  available: true,
  enabled: true,
  selectedIntent: "design",
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

describe("工作流节点胶囊", () => {
  it("关闭时无胶囊，启用后显示所选节点和可访问的移除入口", () => {
    setCurrentLanguage("zh-CN");
    expect(
      renderToStaticMarkup(<ComposerSpecWorkflowPill control={{ ...control, enabled: false }} />),
    ).toBe("");
    const markup = renderToStaticMarkup(<ComposerSpecWorkflowPill control={control} />);
    expect(markup).toContain("技术设计");
    expect(markup).toContain('data-spec-workflow-pill="true"');
    expect(markup).toContain(`aria-label="${t("specWorkflow.remove")}"`);
    expect(markup).toContain("bg-transparent px-3 py-1.5 text-xs");
    expect(markup).toContain("min-w-0 flex-1");
    expect(markup).not.toContain("bg-primary/10");
    expect(markup).not.toContain("rounded-full");
  });

  it("所有节点独立可选，只有当前节点被选中；三种语言均有名称与说明", () => {
    for (const language of ["zh-CN", "en", "ja"] as const) {
      setCurrentLanguage(language);
      const markup = renderToStaticMarkup(
        <SpecWorkflowNodePicker control={control} onSelected={() => {}} />,
      );
      expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1);
      for (const intent of SpecWorkflowIntentName.literals) {
        expect(markup).toContain(t(`specWorkflow.node.${intent}`).replace(/&/g, "&amp;"));
        expect(t(`specWorkflow.description.${intent}`)).not.toBe(
          `specWorkflow.description.${intent}`,
        );
      }
      expect(markup).toContain(t("specWorkflow.flags.title"));
      for (const flag of ["design", "strict"] as const) {
        expect(markup).toContain(t(`specWorkflow.flag.${flag}`));
        expect(t(`specWorkflow.flag.${flag}Description`)).not.toBe(
          `specWorkflow.flag.${flag}Description`,
        );
      }
    }
    setCurrentLanguage("zh-CN");
  });

  it("已启用的执行取向开关带选中态；未选中时无额外 aria-pressed", () => {
    setCurrentLanguage("zh-CN");
    const active = renderToStaticMarkup(
      <SpecWorkflowNodePicker control={{ ...control, flags: ["strict"] }} onSelected={() => {}} />,
    );
    expect(active.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(active).toContain(t("specWorkflow.flag.strict"));
    setCurrentLanguage("zh-CN");
  });
});
