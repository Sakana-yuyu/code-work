import { DownloadIcon, FileUpIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";

import { compareSemverVersions } from "@codework/shared/semver";

import { t } from "~/i18n";
import { LOCAL_PLUGIN_CATALOG } from "~/localPlugins/localPluginCatalog";
import { localPluginFailureLabel } from "~/localPlugins/localPluginFailurePresentation";
import type { LocalPluginLifecycleResult } from "~/localPlugins/localPluginLifecycle";
import { localPluginRuntime, type LocalPluginRuntime } from "~/localPlugins/localPluginRuntime";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export type LocalPluginImportResult =
  | LocalPluginLifecycleResult
  | {
      readonly ok: false;
      readonly error: { readonly code: "invalid-json"; readonly message: string };
    };

export function installLocalPluginJson(
  runtime: LocalPluginRuntime,
  contents: string,
): Promise<LocalPluginImportResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const failure = runtime.failures.record({
      pluginId: "unknown-plugin",
      phase: "install",
      code: "invalid-json",
      error,
    });
    return Promise.resolve({
      ok: false,
      error: { code: "invalid-json", message: failure.message },
    });
  }
  return runtime.lifecycle.install(parsed);
}

function contributionCountLabel(input: {
  readonly commands: number;
  readonly panels: number;
  readonly timeline: number;
  readonly attachments: number;
}): string {
  return [
    input.commands > 0 ? t("localPlugins.commandCount", { count: input.commands }) : null,
    input.panels > 0 ? t("localPlugins.panelCount", { count: input.panels }) : null,
    input.timeline > 0 ? t("localPlugins.timelineCount", { count: input.timeline }) : null,
    input.attachments > 0 ? t("localPlugins.attachmentCount", { count: input.attachments }) : null,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
}

export type LocalPluginStoreButtonState = "install" | "update" | "installed";

/** 三态按钮：未装→安装；本地版本低于目录→更新；同版本或本地更新→已安装。 */
export function resolveLocalPluginStoreButtonState(
  installedVersion: string | undefined,
  catalogVersion: string,
): LocalPluginStoreButtonState {
  if (installedVersion === undefined) return "install";
  return compareSemverVersions(catalogVersion, installedVersion) > 0 ? "update" : "installed";
}

export function LocalPluginsSettings({
  runtime = localPluginRuntime,
}: {
  readonly runtime?: LocalPluginRuntime;
}) {
  const registry = useSyncExternalStore(
    runtime.registry.subscribe,
    runtime.registry.getSnapshot,
    runtime.registry.getSnapshot,
  );
  const failures = useSyncExternalStore(
    runtime.failures.subscribe,
    runtime.failures.getSnapshot,
    runtime.failures.getSnapshot,
  );
  const storageStatus = useSyncExternalStore(
    runtime.storageStatus.subscribe,
    runtime.storageStatus.getSnapshot,
    runtime.storageStatus.getSnapshot,
  );
  const storageErrorLabel = storageStatus.result.ok
    ? null
    : localPluginFailureLabel(storageStatus.result.error.code);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const catalogIds = new Set(LOCAL_PLUGIN_CATALOG.map((item) => item.entry.id));
  // 商店失败行只展示「装了一半没装上」的目录插件（未在已装列表里的），
  // 已装插件的失败由下方已安装区块的逐插件失败行负责。
  const latestStoreFailure = failures.findLast(
    (failure) =>
      catalogIds.has(failure.pluginId) &&
      !registry.plugins.some((plugin) => plugin.manifest.id === failure.pluginId),
  );

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const result = await installLocalPluginJson(runtime, await file.text());
      setImportStatus(
        result.ok ? t("localPlugins.imported") : localPluginFailureLabel(result.error.code),
      );
    } catch (error) {
      runtime.failures.record({
        pluginId: "unknown-plugin",
        phase: "install",
        code: "manifest-read-failed",
        error,
      });
      setImportStatus(t("localPlugins.error.readFailed"));
    }
  };

  return (
    <>
      <SettingsSection id="local-plugin-store" title={t("localPlugins.store.title")}>
        {latestStoreFailure ? (
          <SettingsRow
            data-local-plugin-store-failure={latestStoreFailure.id}
            title={
              <span className="text-destructive">
                {localPluginFailureLabel(latestStoreFailure.code)}
              </span>
            }
            resetAction={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t("localPlugins.clearFailures")}
                onClick={() => runtime.failures.clear(latestStoreFailure.pluginId)}
              >
                <XIcon />
              </Button>
            }
          />
        ) : null}
        {LOCAL_PLUGIN_CATALOG.map((item) => {
          const manifest = item.entry;
          const installed = registry.plugins.find((plugin) => plugin.manifest.id === manifest.id);
          const buttonState = resolveLocalPluginStoreButtonState(
            installed?.manifest.version,
            manifest.version,
          );
          const countLabel = contributionCountLabel({
            commands: manifest.contributions.commands?.length ?? 0,
            panels: manifest.contributions.workspacePanels?.length ?? 0,
            timeline: manifest.contributions.timeline?.length ?? 0,
            attachments: manifest.contributions.attachments?.length ?? 0,
          });
          return (
            <div
              key={manifest.id}
              className="rounded-md border border-border/60 px-3 py-3 sm:px-4"
              data-local-plugin-store-card={manifest.id}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{manifest.name}</h3>
                    <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {manifest.id}
                    </code>
                    <span className="text-xs text-muted-foreground">v{manifest.version}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{t(item.summaryKey)}</p>
                  {countLabel ? (
                    <p className="text-xs text-muted-foreground">{countLabel}</p>
                  ) : null}
                  {manifest.permissions.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {manifest.permissions.map((permission) => (
                        <code
                          key={permission}
                          className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {permission}
                        </code>
                      ))}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant={buttonState === "install" ? "default" : "outline"}
                  disabled={buttonState === "installed" || installingId === manifest.id}
                  data-local-plugin-store-action={manifest.id}
                  data-local-plugin-store-state={buttonState}
                  onClick={() => {
                    setInstallingId(manifest.id);
                    // 失败已由 lifecycle 记入 journal，商店失败行会自动出现。
                    void runtime.lifecycle.install(manifest).then(() => {
                      setInstallingId(null);
                    });
                  }}
                >
                  {buttonState === "install" ? <DownloadIcon /> : null}
                  {buttonState === "update" ? <RefreshCwIcon /> : null}
                  {t(`localPlugins.store.${buttonState}`)}
                </Button>
              </div>
            </div>
          );
        })}
      </SettingsSection>
      <SettingsSection
        id="local-plugins"
        title={t("localPlugins.title")}
        headerAction={
          <>
            <input
              ref={fileInputRef}
              accept=".json,application/json"
              className="sr-only"
              onChange={(event) => void handleFileChange(event)}
              type="file"
            />
            <Button type="button" size="sm" onClick={() => fileInputRef.current?.click()}>
              <FileUpIcon />
              {t("localPlugins.import")}
            </Button>
          </>
        }
      >
        {importStatus ? <SettingsRow title={importStatus} /> : null}
        {!storageStatus.result.ok && storageErrorLabel ? (
          <SettingsRow
            data-local-plugin-storage-phase={storageStatus.phase}
            data-local-plugin-storage-failure={storageStatus.result.error.code}
            title={<span className="text-destructive">{storageErrorLabel}</span>}
          />
        ) : null}
        {registry.plugins.length === 0 ? (
          <SettingsRow title={t("localPlugins.empty")} />
        ) : (
          registry.plugins.map((plugin) => {
            const manifest = plugin.manifest;
            const pluginFailures = failures.filter((failure) => failure.pluginId === manifest.id);
            const latestFailure = pluginFailures.at(-1);
            const countLabel = contributionCountLabel({
              commands: manifest.contributions.commands?.length ?? 0,
              panels: manifest.contributions.workspacePanels?.length ?? 0,
              timeline: manifest.contributions.timeline?.length ?? 0,
              attachments: manifest.contributions.attachments?.length ?? 0,
            });
            return (
              <div
                key={manifest.id}
                className="rounded-md border border-border/60 px-3 py-3 sm:px-4"
                data-local-plugin-id={manifest.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{manifest.name}</h3>
                      <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {manifest.id}
                      </code>
                      <span className="text-xs text-muted-foreground">v{manifest.version}</span>
                    </div>
                    {countLabel ? (
                      <p className="text-xs text-muted-foreground">{countLabel}</p>
                    ) : null}
                    {manifest.permissions.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {manifest.permissions.map((permission) => (
                          <code
                            key={permission}
                            className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {permission}
                          </code>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Switch
                      checked={plugin.enabled}
                      data-local-plugin-toggle={manifest.id}
                      aria-label={t("localPlugins.toggle", { name: manifest.name })}
                      onCheckedChange={(enabled) => {
                        const result = enabled
                          ? runtime.lifecycle.enable(manifest.id)
                          : runtime.lifecycle.disable(manifest.id);
                        void result.then((completed) => {
                          if (!completed.ok) {
                            setImportStatus(localPluginFailureLabel(completed.error.code));
                          }
                        });
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost-muted"
                            data-local-plugin-remove={manifest.id}
                            aria-label={t("localPlugins.remove", { name: manifest.name })}
                            onClick={() => {
                              void runtime.lifecycle.uninstall(manifest.id).then((result) => {
                                if (!result.ok) {
                                  setImportStatus(localPluginFailureLabel(result.error.code));
                                }
                              });
                            }}
                          >
                            <Trash2Icon />
                          </Button>
                        }
                      />
                      <TooltipPopup>{t("localPlugins.removeLabel")}</TooltipPopup>
                    </Tooltip>
                  </div>
                </div>
                {latestFailure ? (
                  <div
                    className="mt-3 flex items-start justify-between gap-3 border-t border-border/50 pt-3 text-xs text-destructive"
                    data-local-plugin-failure={latestFailure.id}
                  >
                    <p className="min-w-0 break-words">
                      {localPluginFailureLabel(latestFailure.code)}
                    </p>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label={t("localPlugins.clearFailuresFor", { name: manifest.name })}
                            onClick={() => runtime.failures.clear(manifest.id)}
                          >
                            <XIcon />
                          </Button>
                        }
                      />
                      <TooltipPopup>{t("localPlugins.clearFailures")}</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </SettingsSection>
    </>
  );
}
