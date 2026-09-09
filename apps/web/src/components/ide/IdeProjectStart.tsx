import type { ScopedProjectRef } from "@codework/contracts";
import { scopeProjectRef } from "@codework/client-runtime/environment";
import { ChevronRightIcon, FolderIcon, FolderPlusIcon, MonitorIcon } from "lucide-react";

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
      className="@container flex size-full min-h-0 flex-col overflow-auto px-6 py-10 sm:px-10"
      aria-label={t("ide.chooseProject")}
      data-ide-project-start
    >
      <div className="my-auto w-full max-w-2xl self-center space-y-5">
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
          <ul className="grid grid-cols-1 gap-3 @[36rem]:grid-cols-2" aria-label={t("allProjects")}>
            {props.projects.map((project) => (
              <li className="min-w-0" key={`${project.environmentId}:${project.id}`}>
                <Button
                  variant="outline"
                  className="group h-full min-h-28 w-full min-w-0 flex-col items-stretch justify-start gap-3 whitespace-normal rounded-xl border-border/80 bg-card/85 p-4 text-left shadow-none backdrop-blur-md hover:border-primary/40 hover:bg-card/95 sm:h-full sm:p-4"
                  onClick={() =>
                    props.onSelectProject(scopeProjectRef(project.environmentId, project.id))
                  }
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <FolderIcon className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="line-clamp-2 break-words text-sm font-medium leading-5">
                        {project.title}
                      </span>
                      {props.environmentLabels.has(project.environmentId) ? (
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
                          <MonitorIcon className="size-3.5" />
                          <span className="truncate">
                            {props.environmentLabels.get(project.environmentId)}
                          </span>
                        </span>
                      ) : null}
                    </span>
                    <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="mt-auto block w-full min-w-0 text-xs font-normal leading-5 text-muted-foreground" />
                      }
                    >
                      <span className="block truncate font-mono">{project.workspaceRoot}</span>
                    </TooltipTrigger>
                    <TooltipPopup className="max-w-sm break-all">
                      {project.workspaceRoot}
                    </TooltipPopup>
                  </Tooltip>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
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
