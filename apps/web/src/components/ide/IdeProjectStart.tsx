import type { ScopedProjectRef } from "@codework/contracts";
import { scopeProjectRef } from "@codework/client-runtime/environment";
import { ChevronRightIcon, FolderIcon, FolderPlusIcon } from "lucide-react";

import type { Project } from "../../types";
import { t } from "../../i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// 项目尚未解析时提供真实项目入口，不把空工作台伪装成已加载的编辑器。
export function IdeProjectStart(props: {
  projects: ReadonlyArray<Pick<Project, "id" | "environmentId" | "title" | "workspaceRoot">>;
  environmentLabels: ReadonlyMap<Project["environmentId"], string>;
  loading: boolean;
  unavailable: boolean;
  onSelectProject: (project: ScopedProjectRef) => void;
  onAddProject: () => void;
  onOpenConnections: () => void;
}) {
  return (
    <section
      className="flex size-full min-h-0 flex-col overflow-auto px-6 py-10 sm:px-10"
      aria-label={t("ide.chooseProject")}
      data-ide-project-start
    >
      <div className="my-auto w-full max-w-lg self-center space-y-6">
        <div className="space-y-2">
          <h1 className="text-xl font-medium tracking-tight">{t("ide.chooseProject")}</h1>
          <p className="text-sm leading-6 text-muted-foreground" role="status">
            {props.loading
              ? t("ide.loadingProject")
              : props.unavailable
                ? t("ide.projectEnvironmentUnavailable")
                : props.projects.length === 0
                  ? t("addAProjectToStart")
                  : t("ide.chooseProjectDescription")}
          </p>
        </div>
        {props.projects.length > 0 ? (
          <ul className="space-y-1" aria-label={t("allProjects")}>
            {props.projects.map((project) => (
              <li key={`${project.environmentId}:${project.id}`}>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start gap-3 px-3 py-3 text-left"
                  onClick={() =>
                    props.onSelectProject(scopeProjectRef(project.environmentId, project.id))
                  }
                >
                  <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate">{project.title}</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="truncate text-xs font-normal text-muted-foreground" />
                        }
                      >
                        {props.environmentLabels.get(project.environmentId)}
                        {props.environmentLabels.has(project.environmentId) ? " · " : ""}
                        {project.workspaceRoot}
                      </TooltipTrigger>
                      <TooltipPopup>{project.workspaceRoot}</TooltipPopup>
                    </Tooltip>
                  </span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button variant="outline" onClick={props.onAddProject}>
            <FolderPlusIcon />
            {t("newProject")}
          </Button>
          <Button variant="ghost" onClick={props.onOpenConnections}>
            {t("connection.connections")}
          </Button>
        </div>
      </div>
    </section>
  );
}
