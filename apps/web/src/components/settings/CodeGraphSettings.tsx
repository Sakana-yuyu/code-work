/**
 * CodeGraph settings - the server-wide switch for the CodeGraph code
 * knowledge-graph integration (upstream `@colbymchenry/codegraph` CLI),
 * plus a CLI install row and per-project index health cards. The index
 * belongs to each project's `.codegraph/` directory; this panel only
 * installs the CLI, reports indexing stats and background phases (no fake
 * percentages - the upstream CLI only announces phase lines), and triggers
 * sync/rebuild.
 *
 * @module CodeGraphSettings
 */
import type {
  CodeGraphIndexPhase,
  CodeGraphProjectIndexStatus,
  CodeGraphStatusResult,
} from "@codework/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codework/contracts";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";

/** init/reindex 正在推进的阶段；设置页轮询只在有活跃阶段或安装中时开启。 */
const ACTIVE_PHASES: ReadonlySet<CodeGraphIndexPhase> = new Set([
  "queued",
  "scanning",
  "parsing",
  "resolving",
  "linking",
]);

const PHASE_LABELS: Readonly<Record<CodeGraphIndexPhase, string>> = {
  queued: "codeGraph.phase.queued",
  scanning: "codeGraph.phase.scanning",
  parsing: "codeGraph.phase.parsing",
  resolving: "codeGraph.phase.resolving",
  linking: "codeGraph.phase.linking",
  complete: "codeGraph.phase.complete",
  failed: "codeGraph.phase.failed",
};

/** 活跃阶段读作进行中（sky），完成读作成功（green），失败读作错误。 */
const PHASE_BADGE_CLASS: Readonly<Record<CodeGraphIndexPhase, string>> = {
  queued: "text-muted-foreground",
  scanning: "text-sky-600 dark:text-sky-400",
  parsing: "text-sky-600 dark:text-sky-400",
  resolving: "text-sky-600 dark:text-sky-400",
  linking: "text-sky-600 dark:text-sky-400",
  complete: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
};

const formatCount = (value: number | null): string =>
  value === null ? "—" : value.toLocaleString();

const formatDbSize = (bytes: number | null): string | null => {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const baseName = (root: string): string => {
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || root;
};

function CodeGraphToggleSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      title={t("codeGraph.toggle")}
      description={t("codeGraph.toggleDescription")}
      status={settings.codeGraphEnabled ? t("codeGraph.enabledStatus") : undefined}
      resetAction={
        settings.codeGraphEnabled !== DEFAULT_UNIFIED_SETTINGS.codeGraphEnabled ? (
          <SettingResetButton
            label={t("codeGraph.toggle")}
            onClick={() =>
              updateSettings({ codeGraphEnabled: DEFAULT_UNIFIED_SETTINGS.codeGraphEnabled })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.codeGraphEnabled}
          onCheckedChange={(checked) => updateSettings({ codeGraphEnabled: Boolean(checked) })}
          aria-label={t("codeGraph.toggle")}
        />
      }
    />
  );
}

/** 安装行：CLI 缺失时给一键安装，安装中（queued/running）禁用并按状态呈现。 */
function CliInstallRow({
  status,
  cliInstalled,
  cliVersion,
  installing,
  onInstall,
}: {
  readonly status: CodeGraphStatusResult["install"];
  readonly cliInstalled: boolean;
  readonly cliVersion: string | null;
  readonly installing: boolean;
  readonly onInstall: () => void;
}) {
  const stateText =
    status.status === "failed"
      ? (status.message ?? t("codeGraph.installFailed"))
      : cliInstalled
        ? t("codeGraph.cliInstalled")
        : t("codeGraph.cliMissing");
  return (
    <SettingsRow
      title={t("codeGraph.cliTitle")}
      description={
        cliInstalled ? t("codeGraph.cliInstalledDescription") : t("codeGraph.cliMissing")
      }
      status={stateText}
      control={
        cliInstalled ? (
          <span className="text-xs text-muted-foreground">
            {t("codeGraph.cliVersion", { version: cliVersion ?? "?" })}
          </span>
        ) : (
          <Button size="sm" variant="outline" disabled={installing} onClick={onInstall}>
            {installing ? t("codeGraph.installing") : t("codeGraph.install")}
          </Button>
        )
      }
    />
  );
}

/** 项目健康卡：阶段徽标（后台 init/重建推进时）+ 统计行 + 同步/重建。 */
export function ProjectStatusRow({
  project,
  busy,
  onSync,
  onReindex,
}: {
  readonly project: CodeGraphProjectIndexStatus;
  readonly busy: boolean;
  readonly onSync: () => void;
  readonly onReindex: () => void;
}) {
  const progress = project.progress;
  const activePhase = progress !== undefined && ACTIVE_PHASES.has(progress.phase);
  const phaseBadge =
    progress === undefined
      ? null
      : activePhase || progress.phase === "failed" || progress.phase === "complete"
        ? {
            text:
              progress.phase === "failed" && progress.detail !== null
                ? `${t(PHASE_LABELS[progress.phase])} · ${progress.detail}`
                : t(PHASE_LABELS[progress.phase]),
            className: PHASE_BADGE_CLASS[progress.phase],
          }
        : null;
  const dbSize = formatDbSize(project.dbSizeBytes);
  const pending = project.pendingChanges;
  const pendingTotal = pending === null ? 0 : pending.added + pending.modified + pending.removed;
  const actionsEnabled = project.cliInstalled && !busy;
  const syncEnabled = project.initialized && actionsEnabled;
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/60 px-3 py-2">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {baseName(project.workspaceRoot)}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {project.workspaceRoot}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {phaseBadge !== null ? (
            <span className={`font-medium ${phaseBadge.className}`}>{phaseBadge.text}</span>
          ) : project.reindexRecommended ? (
            <span className="font-medium text-amber-600 dark:text-amber-400">
              {t("codeGraph.state.reindexRecommended")}
            </span>
          ) : project.initialized ? (
            <span className="font-medium text-emerald-600 dark:text-emerald-400">
              {t("codeGraph.state.ready")}
            </span>
          ) : (
            <span className="font-medium text-muted-foreground">
              {t("codeGraph.state.uninitialized")}
            </span>
          )}
          {pendingTotal > 0 ? (
            <span>{t("codeGraph.pendingChanges", { count: pendingTotal.toLocaleString() })}</span>
          ) : null}
        </div>
      </div>
      {project.initialized ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("codeGraph.projectStats", {
              files: formatCount(project.fileCount),
              nodes: formatCount(project.nodeCount),
              edges: formatCount(project.edgeCount),
            })}
          </span>
          {project.languages.length > 0 ? <span>{project.languages.join(", ")}</span> : null}
          {dbSize !== null ? <span>{dbSize}</span> : null}
          <span>
            {project.lastIndexed === null
              ? t("codeGraph.neverIndexed")
              : t("codeGraph.lastIndexed", {
                  time: new Date(project.lastIndexed).toLocaleString(),
                })}
          </span>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!syncEnabled}
          onClick={onSync}
          aria-label={t("codeGraph.sync")}
        >
          {busy ? t("codeGraph.working") : t("codeGraph.sync")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!actionsEnabled}
          onClick={onReindex}
          aria-label={project.initialized ? t("codeGraph.reindex") : t("codeGraph.buildIndex")}
        >
          {busy
            ? t("codeGraph.working")
            : project.initialized
              ? t("codeGraph.reindex")
              : t("codeGraph.buildIndex")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The section owns the one status query; install and per-project actions
 * share it and refresh it. Polling only runs while an install or a visible
 * background phase is actually in flight.
 */
export function CodeGraphSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.codeGraphStatus({ environmentId, input: {} }),
  );
  const refreshRef = useRef(query.refresh);
  refreshRef.current = query.refresh;

  const installCommand = useAtomCommand(serverEnvironment.codeGraphInstall, {
    reportFailure: false,
  });
  const syncCommand = useAtomCommand(serverEnvironment.codeGraphSync, { reportFailure: false });
  const reindexCommand = useAtomCommand(serverEnvironment.codeGraphReindex, {
    reportFailure: false,
  });
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [busyProjects, setBusyProjects] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<{ projectId: string; text: string } | null>(null);

  const data = query.data;
  const installInFlight = data?.install.status === "queued" || data?.install.status === "running";
  const hasActivePhase =
    data?.projects.some(
      (project) => project.progress !== undefined && ACTIVE_PHASES.has(project.progress.phase),
    ) ?? false;
  const poll = installInFlight || hasActivePhase;

  useEffect(() => {
    if (!poll) return;
    const id = window.setInterval(() => refreshRef.current(), 3_000);
    return () => window.clearInterval(id);
  }, [poll]);

  const runInstall = async (): Promise<void> => {
    if (environmentId === null || installing || installInFlight) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const result = await installCommand({ environmentId, input: {} });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setInstallError(failure instanceof Error ? failure.message : t("codeGraph.installFailed"));
      }
    } finally {
      setInstalling(false);
      refreshRef.current();
    }
  };

  const runProjectAction = async (
    projectId: CodeGraphProjectIndexStatus["projectId"],
    action: "sync" | "reindex",
  ): Promise<void> => {
    if (environmentId === null) return;
    setBusyProjects((current) => ({ ...current, [projectId]: true }));
    setActionError(null);
    try {
      const command = action === "sync" ? syncCommand : reindexCommand;
      const result = await command({ environmentId, input: { projectId } });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        setActionError({
          projectId,
          text: failure instanceof Error ? failure.message : t("codeGraph.actionFailed"),
        });
      } else if (!result.value.succeeded) {
        setActionError({ projectId, text: result.value.message ?? t("codeGraph.actionFailed") });
      }
    } finally {
      setBusyProjects((current) => {
        const next = { ...current };
        delete next[projectId];
        return next;
      });
      refreshRef.current();
    }
  };

  return (
    <SettingsSection
      id="code-graph"
      title={t("codeGraph.title")}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          disabled={environmentId === null}
          aria-label={t("codeGraph.refresh")}
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">{t("codeGraph.explanation")}</p>
      <CodeGraphToggleSetting />
      {query.error !== null ? (
        <p className="text-xs text-destructive">{query.error}</p>
      ) : data !== null ? (
        <>
          <CliInstallRow
            status={data.install}
            cliInstalled={data.cliInstalled}
            cliVersion={data.cliVersion}
            installing={installing || installInFlight}
            onInstall={() => void runInstall()}
          />
          {installError !== null ? (
            <p className="text-xs text-destructive">{installError}</p>
          ) : null}
          {data.enabled ? (
            data.projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("codeGraph.noProjects")}</p>
            ) : (
              <div className="space-y-2">
                {data.projects.map((project) => (
                  <div key={project.projectId} className="space-y-1">
                    <ProjectStatusRow
                      project={project}
                      busy={busyProjects[project.projectId] === true}
                      onSync={() => void runProjectAction(project.projectId, "sync")}
                      onReindex={() => void runProjectAction(project.projectId, "reindex")}
                    />
                    {actionError !== null && actionError.projectId === project.projectId ? (
                      <p className="text-xs text-destructive">{actionError.text}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : (
            <p className="text-xs text-muted-foreground">{t("codeGraph.state.off")}</p>
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}
