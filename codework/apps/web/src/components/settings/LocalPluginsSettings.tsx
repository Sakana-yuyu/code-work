import { FileUpIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";

import { t } from "~/i18n";
import type {
  LocalPluginLifecycleErrorCode,
  LocalPluginLifecycleResult,
} from "~/localPlugins/localPluginLifecycle";
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
type LocalPluginImportErrorCode = LocalPluginLifecycleErrorCode | "invalid-json";

export function installLocalPluginJson(
  runtime: LocalPluginRuntime,
  contents: string,
): LocalPluginImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const failure = runtime.failures.record({
      pluginId: "unknown-plugin",
      phase: "install",
      error,
    });
    return { ok: false, error: { code: "invalid-json", message: failure.message } };
  }
  return runtime.lifecycle.install(parsed);
}

function importErrorLabel(code: LocalPluginImportErrorCode) {
  switch (code) {
    case "invalid-json":
      return t("localPlugins.error.invalidJson");
    case "schema-invalid":
      return t("localPlugins.error.schemaInvalid");
    case "api-incompatible":
      return t("localPlugins.error.apiIncompatible");
    case "manifest-invalid":
      return t("localPlugins.error.manifestInvalid");
    case "storage-write-failed":
      return t("localPlugins.error.storageWriteFailed");
    case "storage-duplicate-id":
      return t("localPlugins.error.storageDuplicateId");
    case "plugin-not-found":
      return t("localPlugins.error.notFound");
    case "storage-invalid":
      return t("localPlugins.error.storageInvalid");
    default:
      return t("localPlugins.error.unknown");
  }
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
  const restoreFailure = failures.findLast(
    (failure) => failure.pluginId === "unknown-plugin" && failure.phase === "restore",
  );
  const restoreErrorLabel = runtime.restoreResult.ok
    ? null
    : importErrorLabel(runtime.restoreResult.error.code);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const result = installLocalPluginJson(runtime, await file.text());
      setImportStatus(result.ok ? t("localPlugins.imported") : importErrorLabel(result.error.code));
    } catch (error) {
      runtime.failures.record({ pluginId: "unknown-plugin", phase: "install", error });
      setImportStatus(t("localPlugins.error.readFailed"));
    }
  };

  return (
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
      {restoreFailure && restoreErrorLabel ? (
        <SettingsRow
          data-local-plugin-restore-failure={restoreFailure.id}
          title={<span className="text-destructive">{restoreErrorLabel}</span>}
          description={restoreFailure.message}
          control={
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("localPlugins.clearRestoreFailure")}
                    onClick={() => runtime.failures.clear("unknown-plugin")}
                  >
                    <XIcon />
                  </Button>
                }
              />
              <TooltipPopup>{t("localPlugins.clearRestoreFailure")}</TooltipPopup>
            </Tooltip>
          }
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
              className="rounded-xl border border-border/60 px-3 py-3 sm:px-4"
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
                      if (!result.ok) setImportStatus(importErrorLabel(result.error.code));
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
                            const result = runtime.lifecycle.uninstall(manifest.id);
                            if (!result.ok) setImportStatus(importErrorLabel(result.error.code));
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
                    {latestFailure.phase}: {latestFailure.message}
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
  );
}
