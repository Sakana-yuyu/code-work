"use client";

import { PlusIcon, SaveIcon, ServerCogIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "@tanstack/react-router";
import { multicaProviderInstanceRevision } from "@codework/contracts";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import {
  buildTeamRuntimeSavePatch,
  nextMulticaRuntimeInstanceId,
} from "@codework/shared/multicaRuntimeSettings";
import { ensureLocalApi } from "~/localApi";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { teamRuntimeInstancesFromSettings } from "./TeamRuntimeSettingsPanel.logic";
import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  multicaRuntimeDraftEquals,
  type MulticaRuntimeDraft,
} from "./MulticaRuntimeSettings.logic";
import { validateMulticaRuntimeDraft } from "./MulticaRuntimeSettings.validation";
import { SettingsSection } from "./settingsLayout";
import { t } from "~/i18n";

function Field({
  label,
  children,
  description,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly description?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-xs font-medium text-foreground">
      <span>{label}</span>
      {children}
      {description ? (
        <span className="font-normal text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

function safeTeamLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : fallback).replace(
    /multica/giu,
    t("teamRuntime.multicaAlias"),
  );
}

function patchEnvironmentValue(
  draft: MulticaRuntimeDraft,
  index: number,
  value: string,
): MulticaRuntimeDraft {
  return {
    ...draft,
    environment: draft.environment.map((entry, entryIndex) => {
      if (entryIndex !== index) return entry;
      const next = { ...entry, value };
      if (value.length > 0) {
        delete next.valueRedacted;
        delete next.originalName;
      }
      return next;
    }),
  };
}

export function TeamRuntimeSettingsPanel() {
  const environment = usePrimaryEnvironment();
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const instances = useMemo(() => teamRuntimeInstancesFromSettings(settings), [settings]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MulticaRuntimeDraft | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<MulticaRuntimeDraft | null>(null);
  const [expectedRevision, setExpectedRevision] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const dirty =
    isCreating ||
    (draft === null || baseline === null
      ? draft !== baseline
      : !multicaRuntimeDraftEquals(draft, baseline));
  const confirmDiscard = async () =>
    !savingRef.current &&
    (!dirty || (await ensureLocalApi().dialogs.confirm(t("teamRuntime.discardChanges"))));
  useBlocker({
    shouldBlockFn: async () => !(await confirmDiscard()),
    enableBeforeUnload: dirty || pending,
    disabled: !dirty && !pending,
  });

  useEffect(() => {
    // 外部配置刷新不能覆盖编辑内容；保存时由服务端检查打开编辑器时的版本。
    if (isCreating || dirty || pending) return;
    const selected =
      selectedId === null
        ? instances[0]
        : instances.find((entry) => String(entry.instanceId) === selectedId);
    if (!selected) return;
    const nextId = selected ? String(selected.instanceId) : null;
    setSelectedId(nextId);
    setEditingId(nextId);
    const nextDraft = formFromMulticaRuntimeInstance(
      String(selected.instanceId),
      selected.instance,
    );
    setDraft(nextDraft);
    setBaseline(nextDraft);
    setExpectedRevision(
      multicaProviderInstanceRevision(String(selected.instanceId), selected.instance),
    );
  }, [instances, isCreating, selectedId, dirty, pending]);

  const validation = draft ? validateMulticaRuntimeDraft(draft) : null;
  const selectedInstance = instances.find((entry) => String(entry.instanceId) === selectedId);

  const startCreate = async () => {
    if (!(await confirmDiscard())) return;
    const instanceId = nextMulticaRuntimeInstanceId(settings.providerInstances);
    setIsCreating(true);
    setSelectedId(null);
    setEditingId(null);
    setDraft(emptyMulticaRuntimeDraft(instanceId));
    setBaseline(null);
    setExpectedRevision(null);
    setSaved(false);
    setActionError(null);
  };

  const selectInstance = async (instanceId: string) => {
    if (!(await confirmDiscard())) return;
    const selected = instances.find((entry) => String(entry.instanceId) === instanceId);
    if (!selected) return;
    const nextDraft = formFromMulticaRuntimeInstance(instanceId, selected.instance);
    setIsCreating(false);
    setSelectedId(instanceId);
    setEditingId(instanceId);
    setDraft(nextDraft);
    setBaseline(nextDraft);
    setExpectedRevision(multicaProviderInstanceRevision(instanceId, selected.instance));
    setSaved(false);
    setActionError(null);
  };

  const save = async () => {
    if (savingRef.current || environment === null) return;
    if (draft === null || validation === null || !validation.ok) {
      setActionError(t("teamRuntime.invalidConfiguration"));
      return;
    }
    const originalInstanceId = isCreating ? null : editingId;
    savingRef.current = true;
    setPending(true);
    setSaved(false);
    setActionError(null);
    try {
      const result = await updateSettings(
        buildTeamRuntimeSavePatch(settings, originalInstanceId, expectedRevision, validation.value),
      );
      if (result === null) throw new Error(t("settingsSaveTryAgain"));
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setIsCreating(false);
      setSelectedId(String(validation.value.instanceId));
      setEditingId(String(validation.value.instanceId));
      setDraft(null);
      setBaseline(null);
      setSaved(true);
    } catch (error) {
      setActionError(
        typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "ServerSettingsConflictError"
          ? t("teamRuntime.conflict")
          : t("settingsSaveTryAgain"),
      );
    } finally {
      savingRef.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsSection
      id="team-runtime"
      title={t("teamRuntime.title")}
      icon={<UsersIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="sm"
          variant="outline"
          disabled={pending || environment === null}
          onClick={startCreate}
        >
          <PlusIcon />
          {t("teamRuntime.new")}
        </Button>
      }
    >
      <p className="px-3 text-sm text-muted-foreground sm:px-4">{t("teamRuntime.description")}</p>
      {saved && !dirty ? (
        <p role="status" className="px-3 text-sm sm:px-4">
          {t("saved", { label: t("teamRuntime.title") })}
        </p>
      ) : null}
      {environment === null ? (
        <p className="px-3 py-6 text-sm text-muted-foreground sm:px-4">
          {t("teamRuntime.noEnvironment")}
        </p>
      ) : (
        <div className="grid border-y border-border/60 xl:grid-cols-[minmax(13rem,0.32fr)_minmax(0,1fr)]">
          <aside className="border-b border-border/60 xl:border-r xl:border-b-0">
            <div className="flex min-h-9 items-center justify-between border-b border-border/60 px-3 text-[11px] font-medium text-muted-foreground">
              <span>{t("teamRuntime.instances")}</span>
              <ServerCogIcon className="size-3.5" />
            </div>
            <div className="p-2">
              {instances.length === 0 && !isCreating ? (
                <p className="px-2 py-5 text-xs text-muted-foreground">{t("teamRuntime.empty")}</p>
              ) : null}
              {instances.map((entry, index) => {
                const instanceId = String(entry.instanceId);
                return (
                  <button
                    key={instanceId}
                    type="button"
                    data-team-runtime-id={instanceId}
                    aria-pressed={selectedId === instanceId}
                    disabled={pending}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:bg-muted/50"
                    onClick={() => selectInstance(instanceId)}
                  >
                    <span className="min-w-0 truncate">
                      {safeTeamLabel(
                        entry.instance.displayName,
                        t("teamRuntime.instance", { index: index + 1 }),
                      )}
                    </span>
                    <Badge
                      variant={entry.instance.enabled === false ? "outline" : "success"}
                      size="sm"
                    >
                      {entry.instance.enabled === false ? t("disabled") : t("enabledColumn")}
                    </Badge>
                  </button>
                );
              })}
              {isCreating ? (
                <div className="rounded-md bg-muted/50 px-2.5 py-2 text-xs font-medium text-foreground">
                  {t("teamRuntime.newDraft")}
                </div>
              ) : null}
            </div>
          </aside>

          <div className="min-w-0 p-3 sm:p-4">
            {draft === null ? (
              <div className="space-y-2 py-8 text-center text-sm text-muted-foreground">
                <ServerCogIcon className="mx-auto size-5" />
                <p>
                  {selectedInstance
                    ? t("teamRuntime.invalidStoredConfiguration")
                    : t("teamRuntime.selectOrCreate")}
                </p>
              </div>
            ) : (
              <fieldset disabled={pending} className="min-w-0 space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {t("teamRuntime.editorTitle")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t("teamRuntime.editorDescription")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !dirty || validation?.ok !== true}
                    onClick={save}
                  >
                    <SaveIcon />
                    {t(pending ? "saving" : "teamRuntime.save")}
                  </Button>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("teamRuntime.runtimeId")}>
                    <Input
                      size="compact"
                      value={draft.runtimeId}
                      onChange={(event) =>
                        setDraft({ ...draft, runtimeId: event.currentTarget.value })
                      }
                    />
                  </Field>
                  <Field label={t("teamRuntime.daemonId")}>
                    <Input
                      size="compact"
                      value={draft.daemonId}
                      onChange={(event) =>
                        setDraft({ ...draft, daemonId: event.currentTarget.value })
                      }
                    />
                  </Field>
                  <Field label={t("teamRuntime.daemonRuntimeId")}>
                    <Input
                      size="compact"
                      value={draft.daemonRuntimeId}
                      onChange={(event) =>
                        setDraft({ ...draft, daemonRuntimeId: event.currentTarget.value })
                      }
                    />
                  </Field>
                  <Field label={t("teamRuntime.baseUrl")}>
                    <Input
                      size="compact"
                      value={draft.baseUrl}
                      onChange={(event) =>
                        setDraft({ ...draft, baseUrl: event.currentTarget.value })
                      }
                    />
                  </Field>
                  <Field label={t("teamRuntime.version")}>
                    <Input
                      size="compact"
                      value={draft.version}
                      placeholder={t("teamRuntime.optional")}
                      onChange={(event) =>
                        setDraft({ ...draft, version: event.currentTarget.value })
                      }
                    />
                  </Field>
                  <Field
                    label={t("teamRuntime.capabilities")}
                    description={t("teamRuntime.capabilitiesDescription")}
                  >
                    <Textarea
                      rows={2}
                      value={draft.capabilities.join(", ")}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          capabilities: event.currentTarget.value.split(","),
                        })
                      }
                    />
                  </Field>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["enabled", "teamRuntime.enabled"],
                      ["supportsResume", "teamRuntime.supportsResume"],
                      ["supportsMcp", "teamRuntime.supportsMcp"],
                      ["supportsSquad", "teamRuntime.supportsSquad"],
                      ["supportsLeader", "teamRuntime.supportsLeader"],
                      ["supportsTaskGraph", "teamRuntime.supportsTaskGraph"],
                    ] as const
                  ).map(([field, labelKey]) => (
                    <label
                      key={field}
                      className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-xs text-muted-foreground"
                    >
                      <Checkbox
                        checked={draft[field]}
                        onCheckedChange={(checked) =>
                          setDraft({ ...draft, [field]: checked === true })
                        }
                      />
                      {t(labelKey)}
                    </label>
                  ))}
                </div>

                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">
                    {t("teamRuntime.environment")}
                  </h4>
                  {draft.environment.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("teamRuntime.noEnvironmentVariables")}
                    </p>
                  ) : (
                    draft.environment.map((entry, index) => (
                      <div
                        key={`${entry.name}-${index}`}
                        className="grid gap-2 sm:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)]"
                      >
                        <code className="flex min-h-8 items-center rounded-md bg-muted/40 px-2 text-[11px] text-muted-foreground">
                          {entry.name}
                        </code>
                        <Input
                          size="compact"
                          type={entry.sensitive ? "password" : "text"}
                          value={entry.value}
                          placeholder={
                            entry.valueRedacted === true ? t("teamRuntime.savedSecret") : undefined
                          }
                          onChange={(event) =>
                            setDraft(patchEnvironmentValue(draft, index, event.currentTarget.value))
                          }
                        />
                      </div>
                    ))
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-foreground">
                      {t("teamRuntime.headers")}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      {draft.headers.length > 0
                        ? draft.headers
                            .map((header) => `${header.headerName} ← ${header.environmentVariable}`)
                            .join(" · ")
                        : t("teamRuntime.none")}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-foreground">
                      {t("teamRuntime.routes")}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      {draft.assigneeRoutes.length > 0
                        ? t("teamRuntime.routeCount", { count: draft.assigneeRoutes.length })
                        : t("teamRuntime.none")}
                    </p>
                  </div>
                </div>

                {validation && !validation.ok ? (
                  <p role="alert" className="text-xs text-warning-foreground">
                    {t("teamRuntime.validationFailed", { path: validation.issue.path })}
                  </p>
                ) : null}
                {actionError ? (
                  <div className="space-y-2">
                    <p role="alert" className="text-xs text-destructive-foreground">
                      {actionError}
                    </p>
                    {editingId !== null ? (
                      <Button size="sm" variant="outline" onClick={() => selectInstance(editingId)}>
                        {t("teamRuntime.reload")}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </fieldset>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
