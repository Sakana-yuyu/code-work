/**
 * Code index settings - the server-wide switch plus a live per-project status
 * summary. The index is a disposable declaration cache the server owns; this
 * panel only toggles it and reports what has been indexed so far.
 *
 * @module CodeIndexSettings
 */
import type { CodeIndexProjectStatus, CodeIndexStatusResult } from "@codework/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@codework/contracts";
import { RefreshCwIcon } from "lucide-react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";

const STATE_LABELS: Readonly<Record<CodeIndexProjectStatus["state"], string>> = {
  idle: "codeIndex.state.idle",
  indexing: "codeIndex.state.indexing",
  off: "codeIndex.state.off",
};

/** Indexing states read as status colors; "off" shares the muted treatment. */
const STATE_BADGE_CLASS: Readonly<Record<CodeIndexProjectStatus["state"], string>> = {
  idle: "text-muted-foreground",
  indexing: "text-sky-600 dark:text-sky-400",
  off: "text-muted-foreground",
};

const formatIndexedAt = (project: CodeIndexProjectStatus): string =>
  project.lastIndexedAt === null
    ? t("codeIndex.neverIndexed")
    : t("codeIndex.lastIndexed", { time: new Date(project.lastIndexedAt).toLocaleString() });

const baseName = (root: string): string => {
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || root;
};

function CodeIndexToggleSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      title={t("codeIndex.toggle")}
      description={t("codeIndex.toggleDescription")}
      status={settings.codeIndexEnabled ? t("codeIndex.appliesToNewSessions") : undefined}
      resetAction={
        settings.codeIndexEnabled !== DEFAULT_UNIFIED_SETTINGS.codeIndexEnabled ? (
          <SettingResetButton
            label={t("codeIndex.toggle")}
            onClick={() =>
              updateSettings({ codeIndexEnabled: DEFAULT_UNIFIED_SETTINGS.codeIndexEnabled })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.codeIndexEnabled}
          onCheckedChange={(checked) => updateSettings({ codeIndexEnabled: Boolean(checked) })}
          aria-label={t("codeIndex.toggle")}
        />
      }
    />
  );
}

function ProjectStatusRow({ project }: { readonly project: CodeIndexProjectStatus }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border/60 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {baseName(project.workspaceRoot)}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {project.workspaceRoot}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className={`font-medium ${STATE_BADGE_CLASS[project.state]}`}>
          {t(STATE_LABELS[project.state])}
        </span>
        <span>
          {t("codeIndex.projectStats", {
            files: project.fileCount.toLocaleString(),
            symbols: project.symbolCount.toLocaleString(),
          })}
        </span>
        <span>{formatIndexedAt(project)}</span>
      </div>
    </div>
  );
}

function CodeIndexStatusView({
  query,
}: {
  readonly query: EnvironmentQueryView<CodeIndexStatusResult>;
}) {
  if (query.error !== null) {
    return <p className="text-xs text-destructive">{query.error}</p>;
  }
  if (!query.data?.enabled) {
    return <p className="text-xs text-muted-foreground">{t("codeIndex.state.off")}</p>;
  }
  if (query.data.projects.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("codeIndex.noProjects")}</p>;
  }
  return (
    <div className="space-y-2">
      {query.data.projects.map((project) => (
        <ProjectStatusRow key={project.projectId} project={project} />
      ))}
    </div>
  );
}

/**
 * The section owns the one status query, so the header refresh button and the
 * rows share a single atom; the toggle itself is independent settings state.
 */
export function CodeIndexSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.codeIndexStatus({ environmentId, input: {} }),
  );

  return (
    <SettingsSection
      id="code-index"
      title={t("codeIndex.title")}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          disabled={environmentId === null}
          aria-label={t("codeIndex.refresh")}
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
      }
    >
      <p className="text-xs text-muted-foreground">{t("codeIndex.explanation")}</p>
      <CodeIndexToggleSetting />
      <CodeIndexStatusView query={query} />
    </SettingsSection>
  );
}
