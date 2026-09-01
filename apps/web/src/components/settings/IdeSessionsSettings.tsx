import type {
  CompositionIdeResolveResult,
  CompositionIdeRuntimeProfile,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
  ServerSettings,
} from "@codework/contracts";
import { ProviderDriverKind } from "@codework/contracts";
import {
  CheckCircle2Icon,
  CircleOffIcon,
  LaptopIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  configFromIdeSessionDraft,
  emptyIdeSessionDraft,
  formFromIdeInstance,
  IDE_SESSION_PROFILES,
  type IdeSessionDraft,
} from "./IdeSessionsSettings.logic";

const EMPTY_INSTANCES: Readonly<Record<string, ProviderInstanceConfig>> = {};

const statusLabel = (status: CompositionIdeResolveResult["status"] | undefined): string => {
  switch (status) {
    case "ready":
      return t("ideSessions.ready");
    case "incomplete":
      return t("ideSessions.registeredIncomplete");
    case "unavailable":
      return t("pullRequests.unavailable");
    default:
      return t("ideSessions.notRegistered");
  }
};

const statusClassName = (status: CompositionIdeResolveResult["status"] | undefined): string => {
  switch (status) {
    case "ready":
      return "text-success";
    case "incomplete":
      return "text-warning";
    case "unavailable":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
};

function HeaderEditor({
  values,
  onChange,
}: {
  readonly values: IdeSessionDraft["headers"];
  readonly onChange: (values: IdeSessionDraft["headers"]) => void;
}) {
  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">
          {t("ideSessions.requestHeaders")}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...values, { headerName: "", environmentVariable: "" }])}
        >
          <PlusIcon />
          {t("commandPalette.add")}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("ideSessions.noHeaders")}</p>
      ) : (
        values.map((value, index) => (
          <div
            key={`${value.headerName}-${index}`}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Input
              value={value.headerName}
              placeholder={t("ideSessions.headerName")}
              aria-label={`${t("ideSessions.headerName")} ${index + 1}`}
              onChange={(event) =>
                onChange(
                  values.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, headerName: event.target.value } : entry,
                  ),
                )
              }
              spellCheck={false}
            />
            <Input
              value={value.environmentVariable}
              placeholder={t("ideSessions.environmentVariableName")}
              aria-label={`${t("ideSessions.environmentVariableName")} ${index + 1}`}
              onChange={(event) =>
                onChange(
                  values.map((entry, entryIndex) =>
                    entryIndex === index
                      ? { ...entry, environmentVariable: event.target.value }
                      : entry,
                  ),
                )
              }
              spellCheck={false}
            />
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t("ideSessions.deleteHeader")}
              onClick={() => onChange(values.filter((_, entryIndex) => entryIndex !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">{t("ideSessions.headerFromEnvironment")}</p>
    </div>
  );
}

function EnvironmentEditor({
  values,
  onChange,
}: {
  readonly values: IdeSessionDraft["environment"];
  readonly onChange: (values: IdeSessionDraft["environment"]) => void;
}) {
  const update = (index: number, patch: Partial<ProviderInstanceEnvironmentVariable>) => {
    onChange(
      values.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              ...patch,
              ...(patch.value === undefined ? {} : { valueRedacted: false }),
            }
          : entry,
      ),
    );
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{t("environmentVariables")}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...values, { name: "", value: "", sensitive: true }])}
        >
          <PlusIcon />
          {t("commandPalette.add")}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("ideSessions.noEnvironmentVariables")}</p>
      ) : (
        values.map((value, index) => (
          <div
            key={`${value.name}-${index}`}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
          >
            <Input
              value={value.name}
              placeholder={t("ideSessions.variableName")}
              aria-label={`${t("ideSessions.variableName")} ${index + 1}`}
              onChange={(event) => update(index, { name: event.target.value })}
              spellCheck={false}
            />
            <Input
              value={value.valueRedacted ? "" : value.value}
              type={value.sensitive ? "password" : "text"}
              placeholder={
                value.valueRedacted ? t("ideSessions.savedSecretPlaceholder") : t("value")
              }
              aria-label={`${t("ideSessions.variableValue")} ${index + 1}`}
              onChange={(event) => update(index, { value: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                checked={value.sensitive}
                onCheckedChange={(checked) => update(index, { sensitive: Boolean(checked) })}
                aria-label={`${t("ideSessions.sensitiveValue")} ${index + 1}`}
              />
              {t("ideSessions.sensitiveValue")}
            </label>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t("ideSessions.deleteEnvironmentVariable")}
              onClick={() => onChange(values.filter((_, entryIndex) => entryIndex !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">
        {t("ideSessions.sensitiveValueDescription")}
      </p>
    </div>
  );
}

function IdeSessionEditor({
  initial,
  editing,
  onCancel,
  onSave,
}: {
  readonly initial: IdeSessionDraft;
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onSave: (draft: IdeSessionDraft) => string | null;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof IdeSessionDraft>(key: K, value: IdeSessionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = () => {
    const nextError = onSave(draft);
    setError(nextError);
  };

  return (
    <div className="grid gap-4 rounded-xl border border-border/60 bg-card px-3 py-3 sm:px-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("ideSessions.sessionId")}
          <Input
            value={draft.sessionId}
            onChange={(event) => update("sessionId", event.target.value)}
            placeholder={"vscode-session-1"}
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("ideSessions.profile")}
          <Select
            value={draft.profile}
            onValueChange={(value) => update("profile", value as CompositionIdeRuntimeProfile)}
          >
            <SelectTrigger>
              <SelectValue>
                {IDE_SESSION_PROFILES.find((profile) => profile.value === draft.profile)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {IDE_SESSION_PROFILES.map((profile) => (
                <SelectItem key={profile.value} value={profile.value}>
                  {profile.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      </div>

      {!editing ? (
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("instanceId")}
          <Input
            value={draft.instanceId}
            onChange={(event) => update("instanceId", event.target.value)}
            placeholder={t("ideLocal")}
            spellCheck={false}
          />
        </label>
      ) : (
        <div className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("instanceId")}
          <code className="rounded-md border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {draft.instanceId}
          </code>
        </div>
      )}

      <label className="grid gap-1.5 text-xs font-medium text-foreground">
        {t("ideSessions.websocketUrl")}
        <Input
          value={draft.url}
          onChange={(event) => update("url", event.target.value)}
          placeholder={t("ws1270014111T3Ide")}
          spellCheck={false}
        />
      </label>

      <HeaderEditor values={draft.headers} onChange={(headers) => update("headers", headers)} />
      <EnvironmentEditor
        values={draft.environment}
        onChange={(environment) => update("environment", environment)}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("ideSessions.openTimeout")}
          <Input
            value={draft.openTimeoutMs}
            onChange={(event) => update("openTimeoutMs", event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("ideSessions.requestTimeout")}
          <Input
            value={draft.requestTimeoutMs}
            onChange={(event) => update("requestTimeoutMs", event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("ideSessions.reconnectDelays")}
          <Input
            value={draft.reconnectDelaysMs}
            onChange={(event) => update("reconnectDelaysMs", event.target.value)}
            placeholder="250, 1000, 3000"
            inputMode="numeric"
          />
        </label>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground">
        {t("enable")}
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => update("enabled", Boolean(checked))}
        />
      </label>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="button" size="sm" onClick={save}>
          {t("save")}
        </Button>
      </div>
    </div>
  );
}

function SessionStatus({ status }: { readonly status: CompositionIdeResolveResult | undefined }) {
  return (
    <p className={`flex items-center gap-1.5 text-xs ${statusClassName(status?.status)}`}>
      {status?.status === "ready" ? <CheckCircle2Icon className="size-3.5" /> : null}
      {status?.status === undefined ? <CircleOffIcon className="size-3.5" /> : null}
      {statusLabel(status?.status)}
      {status?.reasonCode ? ` · ${status.reasonCode}` : ""}
    </p>
  );
}

export function IdeSessionsSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const statusQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionIdeSessions({ environmentId, input: {} }),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const instances = (settings.providerInstances ?? EMPTY_INSTANCES) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const ideEntries = useMemo(
    () => Object.entries(instances).filter(([, instance]) => instance.driver === "ide"),
    [instances],
  );
  const statuses = useMemo(
    () => new Map((statusQuery.data ?? []).map((status) => [status.sessionId, status] as const)),
    [statusQuery.data],
  );

  const nextInstanceId = () => {
    let index = 1;
    let candidate = "ide_local";
    while (instances[candidate] !== undefined) {
      index += 1;
      candidate = `ide_local_${index}`;
    }
    return candidate;
  };

  const saveSession = (originalId: string | null, draft: IdeSessionDraft): string | null => {
    const saved = configFromIdeSessionDraft(draft);
    if (saved === null) {
      return t("ideSessions.invalidForm");
    }
    const nextInstances = { ...instances };
    if (originalId !== null && originalId !== saved.instanceId) delete nextInstances[originalId];
    nextInstances[saved.instanceId] = {
      driver: ProviderDriverKind.make("ide"),
      enabled: saved.config.enabled,
      environment: saved.environment,
      config: saved.config,
    };
    updateSettings({
      providerInstances: nextInstances as ServerSettings["providerInstances"],
    });
    setEditingId(null);
    statusQuery.refresh();
    return null;
  };

  const deleteSession = () => {
    if (pendingDelete === null) return;
    const nextInstances = { ...instances };
    delete nextInstances[pendingDelete];
    updateSettings({
      providerInstances: nextInstances as ServerSettings["providerInstances"],
    });
    if (editingId === pendingDelete) setEditingId(null);
    setPendingDelete(null);
    statusQuery.refresh();
  };

  return (
    <>
      <SettingsSection
        id="ide-sessions"
        title={t("ideSessions.title")}
        icon={<LaptopIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            type="button"
            size="sm"
            onClick={() => setEditingId("__new__")}
            disabled={editingId !== null}
          >
            <PlusIcon />
            {t("ideSessions.add")}
          </Button>
        }
      >
        <SettingsRow
          title={t("ideSessions.runtimeTitle")}
          description={t("ideSessions.runtimeDescription")}
          status={statusQuery.error ?? (statusQuery.isPending ? t("loading") : undefined)}
        />

        {editingId === "__new__" ? (
          <IdeSessionEditor
            key="new-ide-session"
            initial={emptyIdeSessionDraft(nextInstanceId())}
            editing={false}
            onCancel={() => setEditingId(null)}
            onSave={(draft) => saveSession(null, draft)}
          />
        ) : null}

        {ideEntries.length === 0 && editingId !== "__new__" ? (
          <SettingsRow
            title={t("ideSessions.empty")}
            description={t("ideSessions.emptyDescription")}
          />
        ) : null}

        {ideEntries.map(([instanceId, instance]) => {
          const draft =
            formFromIdeInstance(instanceId, instance) ?? emptyIdeSessionDraft(instanceId);
          const status = statuses.get(draft.sessionId);
          const isEditing = editingId === instanceId;
          return (
            <div key={instanceId} className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
              {isEditing ? (
                <IdeSessionEditor
                  key={instanceId}
                  initial={draft}
                  editing
                  onCancel={() => setEditingId(null)}
                  onSave={(next) => saveSession(instanceId, next)}
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-foreground">{draft.sessionId}</h3>
                        <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {instanceId}
                        </code>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {draft.profile}
                        </span>
                      </div>
                      <SessionStatus status={status} />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("ideSessions.edit")}
                        onClick={() => setEditingId(instanceId)}
                        disabled={editingId !== null}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("ideSessions.delete")}
                        onClick={() => setPendingDelete(instanceId)}
                        disabled={editingId !== null}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{draft.enabled ? t("diagnostics.enabled") : t("disabledStatus")}</span>
                    {draft.environment.some((entry) => entry.valueRedacted === true) ? (
                      <span className="text-warning">{t("ideSessions.sensitiveConfigured")}</span>
                    ) : null}
                    <span className="break-all font-mono">{draft.url}</span>
                    {status?.verifiedOperations.length ? (
                      <span>
                        {t("ideSessions.verifiedOperations")}: {status.verifiedOperations.length}
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <SettingsRow
          title={t("authorizationBoundary")}
          description={t("ideSessions.authorizationDescription")}
          status={<ShieldCheckIcon className="inline size-3.5 align-[-2px]" />}
        />
      </SettingsSection>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("ideSessions.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ideSessions.deleteConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </AlertDialogClose>
            <Button type="button" variant="destructive" onClick={deleteSession}>
              <Trash2Icon />
              {t("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
