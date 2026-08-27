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
      return t("已就绪");
    case "incomplete":
      return t("已注册但未完成");
    case "unavailable":
      return t("不可用");
    default:
      return t("未注册");
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
        <span className="text-xs font-medium text-foreground">{t("请求 Header")}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...values, { headerName: "", environmentVariable: "" }])}
        >
          <PlusIcon />
          {t("添加")}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("尚未配置 Header")}</p>
      ) : (
        values.map((value, index) => (
          <div
            key={`${value.headerName}-${index}`}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Input
              value={value.headerName}
              placeholder={t("Header 名称")}
              aria-label={`${t("Header 名称")} ${index + 1}`}
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
              placeholder={t("环境变量名称")}
              aria-label={`${t("环境变量名称")} ${index + 1}`}
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
              aria-label={t("删除 Header")}
              onClick={() => onChange(values.filter((_, entryIndex) => entryIndex !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">{t("Header 值从对应的环境变量读取。")}</p>
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
        <span className="text-xs font-medium text-foreground">{t("环境变量")}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => onChange([...values, { name: "", value: "", sensitive: true }])}
        >
          <PlusIcon />
          {t("添加")}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("尚未配置环境变量")}</p>
      ) : (
        values.map((value, index) => (
          <div
            key={`${value.name}-${index}`}
            className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto]"
          >
            <Input
              value={value.name}
              placeholder={t("变量名称")}
              aria-label={`${t("变量名称")} ${index + 1}`}
              onChange={(event) => update(index, { name: event.target.value })}
              spellCheck={false}
            />
            <Input
              value={value.valueRedacted ? "" : value.value}
              type={value.sensitive ? "password" : "text"}
              placeholder={value.valueRedacted ? t("已保存密钥，输入新值即可替换") : t("值")}
              aria-label={`${t("变量值")} ${index + 1}`}
              onChange={(event) => update(index, { value: event.target.value })}
              autoComplete="off"
              spellCheck={false}
            />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Switch
                checked={value.sensitive}
                onCheckedChange={(checked) => update(index, { sensitive: Boolean(checked) })}
                aria-label={`${t("敏感值")} ${index + 1}`}
              />
              {t("敏感值")}
            </label>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost-muted"
              aria-label={t("删除环境变量")}
              onClick={() => onChange(values.filter((_, entryIndex) => entryIndex !== index))}
            >
              <XIcon />
            </Button>
          </div>
        ))
      )}
      <p className="text-[11px] text-muted-foreground">
        {t("敏感值会单独保存，保存后不会完整显示。")}
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
          {t("Session ID")}
          <Input
            value={draft.sessionId}
            onChange={(event) => update("sessionId", event.target.value)}
            placeholder={t("vscode-session-1")}
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("IDE Profile")}
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
          {t("实例 ID")}
          <Input
            value={draft.instanceId}
            onChange={(event) => update("instanceId", event.target.value)}
            placeholder="ide_local"
            spellCheck={false}
          />
        </label>
      ) : (
        <div className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("实例 ID")}
          <code className="rounded-md border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {draft.instanceId}
          </code>
        </div>
      )}

      <label className="grid gap-1.5 text-xs font-medium text-foreground">
        {t("WebSocket URL")}
        <Input
          value={draft.url}
          onChange={(event) => update("url", event.target.value)}
          placeholder="ws://127.0.0.1:4111/t3/ide"
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
          {t("Open timeout (ms)")}
          <Input
            value={draft.openTimeoutMs}
            onChange={(event) => update("openTimeoutMs", event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Request timeout (ms)")}
          <Input
            value={draft.requestTimeoutMs}
            onChange={(event) => update("requestTimeoutMs", event.target.value)}
            inputMode="numeric"
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Reconnect delays (ms)")}
          <Input
            value={draft.reconnectDelaysMs}
            onChange={(event) => update("reconnectDelaysMs", event.target.value)}
            placeholder="250, 1000, 3000"
            inputMode="numeric"
          />
        </label>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground">
        {t("启用")}
        <Switch
          checked={draft.enabled}
          onCheckedChange={(checked) => update("enabled", Boolean(checked))}
        />
      </label>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("取消")}
        </Button>
        <Button type="button" size="sm" onClick={save}>
          {t("保存")}
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
      return t("请输入有效的实例 ID、Session ID、WebSocket URL、环境变量绑定和超时值。");
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
        title={t("IDE 会话")}
        icon={<LaptopIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            type="button"
            size="sm"
            onClick={() => setEditingId("__new__")}
            disabled={editingId !== null}
          >
            <PlusIcon />
            {t("添加 IDE 会话")}
          </Button>
        }
      >
        <SettingsRow
          title={t("IDE Runtime 连接")}
          description={t(
            "配置 Cursor、VS Code 或 Browser MCP 会话。服务端会探测每个已注册会话；IDE 操作仍需要任务级 Grant 和审批。",
          )}
          status={statusQuery.error ?? (statusQuery.isPending ? t("Loading...") : undefined)}
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
            title={t("尚未配置 IDE 会话")}
            description={t("添加 WebSocket 会话后，Composition Runtime 才能使用受支持的 IDE API。")}
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
                        aria-label={t("Edit IDE session")}
                        onClick={() => setEditingId(instanceId)}
                        disabled={editingId !== null}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("Delete IDE session")}
                        onClick={() => setPendingDelete(instanceId)}
                        disabled={editingId !== null}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{draft.enabled ? t("已启用") : t("已停用")}</span>
                    {draft.environment.some((entry) => entry.valueRedacted === true) ? (
                      <span className="text-warning">{t("已配置敏感值")}</span>
                    ) : null}
                    <span className="break-all font-mono">{draft.url}</span>
                    {status?.verifiedOperations.length ? (
                      <span>
                        {t("已验证操作")}: {status.verifiedOperations.length}
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <SettingsRow
          title={t("授权边界")}
          description={t(
            "已注册会话不是不受限制的 Agent。每次 IDE 调用仍受已验证 operation allowlist、任务 Grant、审批、审计和取消链路约束。",
          )}
          status={<ShieldCheckIcon className="inline size-3.5 align-[-2px]" />}
        />
      </SettingsSection>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("删除 IDE 会话？")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("这会删除会话配置并注销对应的 transport。")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>
              {t("取消")}
            </AlertDialogClose>
            <Button type="button" variant="destructive" onClick={deleteSession}>
              <Trash2Icon />
              {t("删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
