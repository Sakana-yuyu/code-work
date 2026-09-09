import { EnvironmentId, ProjectId } from "@codework/contracts";
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { t } from "../../i18n";
import { IdeProjectStart } from "./IdeProjectStart";

const actions = vi.hoisted(() => [] as Array<() => void>);
vi.mock("../ui/button", () => ({
  Button: (props: { children: ReactNode; onClick: () => void }) => {
    actions.push(props.onClick);
    return <button>{props.children}</button>;
  },
}));

const environmentId = EnvironmentId.make("remote-environment");
const projectId = ProjectId.make("project-id");
const project = {
  environmentId,
  id: projectId,
  title: "workspace",
  workspaceRoot: "/srv/workspace",
};

function render(overrides: Partial<ComponentProps<typeof IdeProjectStart>> = {}) {
  return renderToStaticMarkup(
    <IdeProjectStart
      projects={[project]}
      environmentLabels={new Map([[environmentId, "Remote"]])}
      loading={false}
      unavailable={false}
      onSelectProject={vi.fn()}
      onAddProject={vi.fn()}
      onOpenConnections={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => actions.splice(0));

describe("IDE 未解析项目时的恢复入口", () => {
  it("直接列出真实项目和所属环境，点击携带正确的环境与项目引用", () => {
    const onSelectProject = vi.fn();
    const markup = render({ onSelectProject });
    expect(markup).toContain("workspace");
    expect(markup).toContain("/srv/workspace");
    expect(markup).toContain("Remote");
    expect(markup).not.toContain(t("ide.projectsAndChats"));
    actions[0]!();
    expect(onSelectProject).toHaveBeenCalledWith({ environmentId, projectId });
  });

  it("加载期间不误报没有项目，加载完成后可显示列表", () => {
    const loading = render({ projects: [], loading: true });
    expect(loading).toContain(t("ide.loadingProject"));
    expect(loading).not.toContain(t("addAProjectToStart"));
    expect(render()).toContain("/srv/workspace");
  });

  it("无项目时同时提供添加项目和连接设置的可操作入口", () => {
    const onAddProject = vi.fn();
    const onOpenConnections = vi.fn();
    const markup = render({ projects: [], onAddProject, onOpenConnections });
    expect(markup).toContain(t("addAProjectToStart"));
    expect(markup).not.toContain("<ul");
    actions[0]!();
    actions[1]!();
    expect(onAddProject).toHaveBeenCalledOnce();
    expect(onOpenConnections).toHaveBeenCalledOnce();
  });

  it("环境断开时说明恢复方式，并保留其他项目入口", () => {
    const markup = render({ unavailable: true });
    expect(markup).toContain(t("ide.projectEnvironmentUnavailable"));
    expect(markup).toContain("/srv/workspace");
  });
});
