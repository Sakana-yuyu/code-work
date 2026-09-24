"use client";

import type { EnvironmentId } from "@codework/contracts";
import type { AcpRegistryCatalogEntry } from "@codework/contracts";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";

import { byokEnvironment } from "../../state/server";
import { t } from "~/i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface AcpRegistryCatalogPickerProps {
  readonly environmentId: EnvironmentId;
  readonly selectedCommand: string;
  readonly onSelect: (command: string) => void;
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
  onSelect,
}: AcpRegistryCatalogPickerProps) {
  const [query, setQuery] = useState("");
  const result = useAtomValue(byokEnvironment.acpRegistryCatalog({ environmentId, input: {} }));
  const catalog = AsyncResult.isSuccess(result) ? result.value : null;
  const entries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter(
      (entry) =>
        needle.length === 0 ||
        `${entry.name} ${entry.description} ${entry.id}`.toLowerCase().includes(needle),
    );
  }, [catalog, query]);

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
      ) : catalog === null ? (
        <p className="text-xs text-muted-foreground">{t("acpRegistryLoading")}</p>
      ) : catalog.error !== null ? (
        <p className="text-xs text-destructive">{t("acpRegistryUnavailable")}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("acpRegistryEmpty")}</p>
      ) : (
        <div className="max-h-44 divide-y divide-border/60 overflow-y-auto rounded-md border border-border/60">
          {entries.map((entry) => {
            const command = entry.command;
            return (
              <div className="flex items-start gap-2 p-2" key={entry.id}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{entry.name}</div>
                  {entry.configuredStatus && entry.configuredStatus !== "not-configured" ? (
                    <div className="text-[11px] text-muted-foreground">
                      {t(CONFIGURED_STATUS_KEYS[entry.configuredStatus])}
                    </div>
                  ) : null}
                  <div className="line-clamp-2 text-[11px] text-muted-foreground">
                    {entry.description}
                  </div>
                </div>
                {command === null ? (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t(
                      entry.availability === "unsupported-platform"
                        ? "acpRegistryUnsupported"
                        : "acpRegistryManual",
                    )}
                  </span>
                ) : (
                  <Button
                    aria-label={t("acpRegistryUseAgent", { name: entry.name })}
                    className="shrink-0"
                    onClick={() => onSelect(command)}
                    size="sm"
                    type="button"
                    variant={selectedCommand === command ? "secondary" : "outline"}
                  >
                    {selectedCommand === command ? t("acpRegistrySelected") : t("acpRegistryUse")}
                  </Button>
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
