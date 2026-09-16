import { PencilIcon, PlusIcon, ServerIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  EnvironmentId,
  SshServerConfig,
  SshServerId,
  SshServerStatus,
  ServerSettings,
} from "@codework/contracts";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { usePrimaryEnvironment } from "~/state/environments";
import { sshServerEnvironment } from "~/state/ssh";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface SshFormState {
  readonly label: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
}

const EMPTY_FORM: SshFormState = {
  label: "",
  hostname: "",
  port: "22",
  username: "root",
  password: "",
};

const slugify = (label: string): string => {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return slug.length > 0 ? slug : "server";
};

function nextServerId(label: string, existing: ReadonlySet<string>): SshServerId {
  const base = slugify(label);
  if (!existing.has(base)) return base as SshServerId;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}` as SshServerId;
}

function validPort(value: string): value is string {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function SshServerEditor(props: {
  readonly environmentId: EnvironmentId | null;
  readonly initial: SshFormState;
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onSave: (form: SshFormState) => void;
}) {
  const [form, setForm] = useState(props.initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const testConnection = useAtomCommand(sshServerEnvironment.testConnection, {
    reportFailure: false,
  });
  const update = (key: keyof SshFormState, value: string) =>
    setForm((current) => ({ ...current, [key]: value }));

  const valid =
    form.label.trim().length > 0 &&
    form.hostname.trim().length > 0 &&
    form.username.trim().length > 0 &&
    validPort(form.port) &&
    // 编辑时留空 = 保留已存密码；新建必须有密码。
    (props.editing || form.password.length > 0);

  const runTest = async () => {
    if (props.environmentId === null) return;
    setTesting(true);
    setTestResult(null);
    const result = await testConnection({
      environmentId: props.environmentId,
      input: {
        hostname: form.hostname.trim(),
        port: Number.parseInt(form.port, 10),
        username: form.username.trim(),
        password: form.password,
      },
    });
    setTesting(false);
    if (result._tag === "Success") {
      setTestResult(
        result.value.ok
          ? t("sshServers.testOk", { os: result.value.os ? ` (${result.value.os})` : "" })
          : (result.value.error ?? t("sshServers.testFailed")),
      );
    } else {
      setTestResult(t("sshServers.testFailed"));
    }
  };

  return (
    <div className="grid gap-3 rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("sshServers.label")}
          <Input
            value={form.label}
            onChange={(event) => update("label", event.target.value)}
            placeholder={t("sshServers.labelPlaceholder")}
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("sshServers.host")}
          <Input
            value={form.hostname}
            onChange={(event) => update("hostname", event.target.value)}
            placeholder="203.0.113.10"
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("sshServers.port")}
          <Input
            value={form.port}
            onChange={(event) => update("port", event.target.value)}
            inputMode="numeric"
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("sshServers.username")}
          <Input
            value={form.username}
            onChange={(event) => update("username", event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
          {t("sshServers.password")}
          <Input
            type="password"
            value={form.password}
            onChange={(event) => update("password", event.target.value)}
            placeholder={
              props.editing ? t("sshServers.passwordKeep") : t("sshServers.passwordPlaceholder")
            }
            autoComplete="new-password"
          />
        </label>
      </div>
      {testResult !== null ? <p className="text-xs text-muted-foreground">{testResult}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          type="button"
          disabled={!valid || testing || props.environmentId === null}
          onClick={() => void runTest()}
        >
          {testing ? t("sshServers.testing") : t("sshServers.test")}
        </Button>
        <Button variant="outline" onClick={props.onCancel} type="button">
          {t("cancel")}
        </Button>
        <Button onClick={() => props.onSave(form)} disabled={!valid} type="button">
          {t("save")}
        </Button>
      </div>
    </div>
  );
}

function SshServerCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly serverId: string;
  readonly config: SshServerConfig;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onResetFingerprint: () => void;
}) {
  const statusQuery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sshServerEnvironment.status({
          environmentId: props.environmentId,
          input: { serverId: props.serverId as SshServerId },
        }),
  );
  const status: SshServerStatus | null = statusQuery.data ?? null;
  const online = status?.online === true;
  return (
    <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-zinc-400"}`}
            />
            <span className="truncate text-sm font-medium">{props.config.label}</span>
            <span className="truncate text-muted-foreground text-xs">
              {props.config.username}@{props.config.hostname}
              {props.config.port !== 22 ? `:${props.config.port}` : ""}
            </span>
          </div>
          <div className="mt-1 text-muted-foreground text-xs">
            {status === null
              ? statusQuery.isPending
                ? t("loading")
                : null
              : online
                ? [
                    status.os,
                    status.uptimeSeconds !== undefined
                      ? t("sshServers.uptime", { value: formatUptime(status.uptimeSeconds) })
                      : null,
                    status.cpuPercent !== undefined ? `CPU ${status.cpuPercent.toFixed(0)}%` : null,
                    status.memoryUsedMb !== undefined && status.memoryTotalMb !== undefined
                      ? t("sshServers.memory", {
                          used: status.memoryUsedMb,
                          total: status.memoryTotalMb,
                        })
                      : null,
                    status.diskUsedGb !== undefined && status.diskTotalGb !== undefined
                      ? t("sshServers.disk", {
                          used: status.diskUsedGb.toFixed(0),
                          total: status.diskTotalGb.toFixed(0),
                        })
                      : null,
                  ]
                    .filter((part) => part !== null && part !== undefined && part.length > 0)
                    .join(" · ")
                : (status.error ?? t("sshServers.offline"))}
          </div>
          {props.config.knownHostFingerprint !== undefined ? (
            <div className="mt-1 flex items-center gap-1 text-muted-foreground text-[10px]">
              <ShieldCheckIcon className="size-3 shrink-0" />
              <span className="truncate">{props.config.knownHostFingerprint.slice(0, 24)}…</span>
              <button
                type="button"
                className="shrink-0 cursor-pointer underline hover:text-foreground"
                onClick={props.onResetFingerprint}
              >
                {t("sshServers.resetFingerprint")}
              </button>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="outline" onClick={props.onEdit} type="button">
            <PencilIcon />
            {t("edit")}
          </Button>
          <Button size="sm" variant="outline" onClick={props.onDelete} type="button">
            <Trash2Icon />
            {t("delete")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SshServersSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const configuredServers = usePrimarySettings((settings) => settings.sshServers);
  const updateSettings = useUpdatePrimarySettings();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // 设置原子的键带 SshServerId 品牌，表单/patch 侧用普通 string 记录操作。
  const configuredServerMap = configuredServers as unknown as Record<string, SshServerConfig>;
  const serverEntries = useMemo(() => Object.entries(configuredServerMap), [configuredServerMap]);
  const existingIds = useMemo(
    () => new Set(serverEntries.map(([serverId]) => serverId)),
    [serverEntries],
  );

  const persist = (next: Record<string, SshServerConfig>) => {
    updateSettings({ sshServers: next as unknown as ServerSettings["sshServers"] });
  };

  const saveForm = (form: SshFormState) => {
    const isNew = editingId === "__new__";
    const serverId = isNew ? nextServerId(form.label, existingIds) : (editingId as SshServerId);
    const previous = isNew ? undefined : configuredServerMap[serverId];
    const config: SshServerConfig = {
      schemaVersion: 1,
      label: form.label.trim(),
      hostname: form.hostname.trim(),
      port: Number.parseInt(form.port, 10),
      username: form.username.trim(),
      // 编辑留空 = 保留已存密码（passwordRedacted 标记语义）。
      ...(form.password.length > 0
        ? { password: form.password }
        : {
            password: "",
            ...(previous?.passwordRedacted === true ? { passwordRedacted: true } : {}),
          }),
      ...(previous?.knownHostFingerprint !== undefined
        ? { knownHostFingerprint: previous.knownHostFingerprint }
        : {}),
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
    persist({ ...configuredServerMap, [serverId]: config });
    setEditingId(null);
  };

  const deleteServer = () => {
    if (pendingDelete === null) return;
    const next = { ...configuredServerMap };
    delete next[pendingDelete];
    persist(next);
    setPendingDelete(null);
    if (editingId === pendingDelete) setEditingId(null);
  };

  const resetFingerprint = (serverId: string) => {
    const config = configuredServerMap[serverId];
    if (config === undefined) return;
    const { knownHostFingerprint: _dropped, ...rest } = config;
    persist({ ...configuredServerMap, [serverId]: { ...rest } });
  };

  return (
    <>
      <SettingsSection
        id="ssh-servers"
        title={t("sshServers.title")}
        icon={<ServerIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            size="sm"
            onClick={() => setEditingId("__new__")}
            disabled={editingId !== null}
            type="button"
          >
            <PlusIcon />
            {t("sshServers.add")}
          </Button>
        }
      >
        <SettingsRow
          title={t("sshServers.sectionTitle")}
          description={t("sshServers.sectionDescription")}
        />

        {editingId === "__new__" ? (
          <SshServerEditor
            key="new-ssh-server"
            environmentId={environmentId}
            initial={EMPTY_FORM}
            editing={false}
            onCancel={() => setEditingId(null)}
            onSave={saveForm}
          />
        ) : null}

        {serverEntries.length === 0 && editingId !== "__new__" ? (
          <SettingsRow
            title={t("sshServers.empty")}
            description={t("sshServers.emptyDescription")}
          />
        ) : null}

        {serverEntries.map(([serverId, config]) =>
          editingId === serverId ? (
            <SshServerEditor
              key={serverId}
              environmentId={environmentId}
              initial={{
                label: config.label,
                hostname: config.hostname,
                port: String(config.port),
                username: config.username,
                password: "",
              }}
              editing
              onCancel={() => setEditingId(null)}
              onSave={saveForm}
            />
          ) : (
            <SshServerCard
              key={serverId}
              environmentId={environmentId}
              serverId={serverId}
              config={config}
              onEdit={() => setEditingId(serverId)}
              onDelete={() => setPendingDelete(serverId)}
              onResetFingerprint={() => resetFingerprint(serverId)}
            />
          ),
        )}
      </SettingsSection>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sshServers.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("sshServers.deleteConfirm", {
                label:
                  pendingDelete !== null ? (configuredServerMap[pendingDelete]?.label ?? "") : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("cancel")}</AlertDialogClose>
            <Button variant="destructive" onClick={deleteServer}>
              {t("delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
