"use client";

import type { EnvironmentId } from "@codework/contracts";
import type { AcpRegistryCatalogEntry } from "@codework/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { byokEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { t } from "~/i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { acpAgentIconSrc } from "./acpAgentIcons";

interface AcpRegistryCatalogPickerProps {
  readonly environmentId: EnvironmentId;
  readonly selectedCommand: string;
  readonly selectedEntryId?: string | undefined;
  readonly initialQuery?: string;
  readonly onSelect: (entry: AcpRegistryCatalogEntry) => void;
}

const CONFIGURED_STATUS_KEYS: Readonly<
  Record<NonNullable<AcpRegistryCatalogEntry["configuredStatus"]>, string>
> = {
  "not-configured": "acpRegistryNotConfigured",
  checking: "acpRegistryChecking",
  ready: "acpRegistryReady",
  missing: "acpRegistryMissing",
  error: "acpRegistryFailed",
  disabled: "acpRegistryDisabled",
};

/** 目录来自所选环境的服务端；手工命令始终可用。 */
export function AcpRegistryCatalogPicker({
  environmentId,
  selectedCommand,
  selectedEntryId,
  initialQuery = "",
  onSelect,
}: AcpRegistryCatalogPickerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const activeInstall = useRef<symbol | null>(null);
  const selection = useRef<symbol | null>(null);
  useEffect(() => {
    selection.current = Symbol();
    setInstallError(null);
    return () => {
      selection.current = null;
    };
  }, [environmentId, selectedCommand, selectedEntryId]);
  const result = useAtomValue(byokEnvironment.acpRegistryCatalog({ environmentId, input: {} }));
  const installBinary = useAtomCommand(byokEnvironment.installAcpRegistryBinary, {
    reportFailure: false,
  });
  const catalog = AsyncResult.isSuccess(result) ? result.value : null;
  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter(
      (entry) =>
        needle.length === 0 ||
        `${entry.name} ${entry.description} ${entry.id}`.toLowerCase().includes(needle),
    );
  }, [catalog, query]);

  const downloadEntry = async (entry: AcpRegistryCatalogEntry) => {
    if (!entry.binaryDistribution || activeInstall.current !== null) return;
    const request = Symbol();
    const selectedAtStart = selection.current;
    activeInstall.current = request;
    setInstallingId(entry.id);
    setInstallError(null);
    try {
      const outcome = await installBinary({ environmentId, input: { entryId: entry.id } });
      if (selection.current !== selectedAtStart || isAtomCommandInterrupted(outcome)) return;
      if (outcome._tag !== "Success") {
        const failure = squashAtomCommandFailure(outcome);
        setInstallError(
          failure instanceof Error
            ? failure.message
            : typeof failure === "object" &&
                failure !== null &&
                "detail" in failure &&
                typeof failure.detail === "string"
              ? failure.detail
              : String(failure),
        );
        return;
      }
      onSelect({
        ...entry,
        command: outcome.value.command,
        availability: "installable",
      });
    } catch (error) {
      if (selection.current === selectedAtStart)
        setInstallError(error instanceof Error ? error.message : String(error));
    } finally {
      if (activeInstall.current === request) {
        activeInstall.current = null;
        if (selection.current !== null) setInstallingId(null);
      }
    }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border/70 p-3">
      <div className="text-sm font-medium">{t("acpRegistry")}</div>
      <p className="text-xs text-muted-foreground">{t("acpRegistryDescription")}</p>
      <Input
        aria-label={t("acpRegistrySearch")}
        placeholder={t("acpRegistrySearch")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {AsyncResult.isFailure(result) ? (
        <p className="text-xs text-destructive">{t("acpRegistryUnavailable")}</p>
      ) : catalog?.source === "bundled" ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("acpRegistryOfflineSnapshot", { date: catalog.snapshotDate ?? "" })}
        </p>
      ) : catalog?.error ? (
        <p className="text-xs text-destructive">{t("acpRegistryUnavailable")}</p>
      ) : null}
      {installError ? (
        <p role="alert" className="text-xs text-destructive">
          {t("acpRegistryDownloadFailed", { detail: installError })}
        </p>
      ) : null}
      {catalog === null && !AsyncResult.isFailure(result) ? (
        <p className="text-xs text-muted-foreground">{t("acpRegistryLoading")}</p>
      ) : entries.length === 0 ? (
        catalog && (!catalog.error || catalog.entries.length > 0) ? (
          <p className="text-xs text-muted-foreground">{t("acpRegistryEmpty")}</p>
        ) : null
      ) : (
        <div className="max-h-72 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
          {entries.map((entry) => {
            // 下载安装后命令只存在于表单/选中态，目录查询仍可能是 null。
            const installedForSelection =
              selectedEntryId === entry.id &&
              selectedCommand.length > 0 &&
              entry.command === null &&
              entry.binaryDistribution !== undefined;
            const command = installedForSelection ? selectedCommand : entry.command;
            const selected =
              selectedEntryId === entry.id && command !== null && selectedCommand === command;
            const iconSrc = acpAgentIconSrc(entry);
            const downloading = installingId === entry.id;
            const selectableEntry =
              command === null
                ? entry
                : { ...entry, command, availability: "installable" as const };
            return (
              <div className="flex flex-wrap items-start gap-2 p-2" key={entry.id}>
                <AcpAgentIcon src={iconSrc} name={entry.name} />
                <div className="min-w-0 flex-1 basis-48">
                  <div className="truncate text-xs font-medium">
                    {entry.name} {entry.version}
                  </div>
                  {entry.configuredStatus && entry.configuredStatus !== "not-configured" ? (
                    <div className="text-[11px] text-muted-foreground">
                      {t(CONFIGURED_STATUS_KEYS[entry.configuredStatus])}
                    </div>
                  ) : null}
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {entry.description}
                  </div>
                  {entry.binaryDistribution ? (
                    <div className="mt-1 grid gap-1 text-[11px] text-muted-foreground">
                      <span>
                        {t("acpRegistryDownloadDetail", {
                          hash: entry.binaryDistribution.sha256.slice(0, 12),
                        })}
                      </span>
                      <a
                        className="w-fit underline underline-offset-2 hover:text-foreground"
                        href={entry.binaryDistribution.archiveUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("acpRegistryArchive")}
                      </a>
                    </div>
                  ) : null}
                  {entry.setup ? (
                    <div className="mt-1 grid gap-1 text-[11px] text-muted-foreground">
                      <span>{t("acpRegistryManualPreset", { date: entry.setup.verifiedAt })}</span>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href={entry.setup.installationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("acpRegistryInstallation")}
                        </a>
                        <a
                          className="underline underline-offset-2 hover:text-foreground"
                          href={entry.setup.documentationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t("acpRegistryDocumentation")}
                        </a>
                      </div>
                    </div>
                  ) : null}
                </div>
                {command !== null ? (
                  <Button
                    aria-label={t("acpRegistryUseAgent", { name: entry.name })}
                    className="shrink-0"
                    onClick={() => onSelect(selectableEntry)}
                    size="sm"
                    type="button"
                    variant={selected ? "secondary" : "outline"}
                  >
                    {selected ? t("acpRegistrySelected") : t("acpRegistryUse")}
                  </Button>
                ) : entry.binaryDistribution ? (
                  <Button
                    aria-label={t("acpRegistryDownloadInstallAgent", { name: entry.name })}
                    className="shrink-0"
                    disabled={installingId !== null}
                    onClick={() => void downloadEntry(entry)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {downloading ? t("acpRegistryDownloading") : t("acpRegistryDownloadInstall")}
                  </Button>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t(
                      entry.availability === "unsupported-platform"
                        ? "acpRegistryUnsupported"
                        : "acpRegistryManual",
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{t("acpRegistryInstallHint")}</p>
    </div>
  );
}

function AcpAgentIcon(props: { readonly src: string | null; readonly name: string }) {
  const [failed, setFailed] = useState(false);
  if (!props.src || failed) {
    return (
      <span
        aria-hidden
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted text-[10px] font-medium text-muted-foreground"
      >
        {props.name.trim().charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/70 bg-background">
      <img
        alt=""
        className="size-5 object-contain"
        loading="lazy"
        src={props.src}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
