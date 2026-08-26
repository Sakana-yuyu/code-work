import {
  CheckCircle2Icon,
  LinkIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UnplugIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  CompositionMcpRuntimeServerConfig,
  CompositionMcpRuntimeServerState,
  CompositionMcpSecretValue,
  CompositionMcpServerId,
  CompositionMcpTransport,
  ServerSettings,
} from "@codework/contracts";
import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { cn } from "../../lib/utils";
import { t } from "~/i18n";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
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

type SecretDraft = CompositionMcpSecretValue;

interface McpFormState {
  readonly serverId: string;
  readonly name: string;
  readonly transport: CompositionMcpTransport;
  readonly command: string;
  readonly args: string;
  readonly cwd: string;
  readonly url: string;
  readonly headers: ReadonlyArray<SecretDraft>;
  readonly environment: ReadonlyArray<SecretDraft>;
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly trustFingerprint: string;
}

const EMPTY_MCP_SERVERS: Readonly<Record<string, CompositionMcpRuntimeServerConfig>> = {};

const MCP_TRANSPORTS: ReadonlyArray<CompositionMcpTransport> = ["stdio", "http", "sse"];
const MCP_SERVER_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function emptySecret(): SecretDraft {
  return { name: "", value: "", sensitive: true };
}

function emptyForm(): McpFormState {
  return {
    serverId: "",
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    cwd: "",
    url: "",
    headers: [],
    environment: [],
    enabled: true,
    trusted: false,
    trustFingerprint: "",
  };
}

function formFromConfig(serverId: string, config: CompositionMcpRuntimeServerConfig): McpFormState {
  return {
    serverId,
    name: config.name,
    transport: config.transport,
    command: config.command ?? "",
    args: config.args.join("\n"),
    cwd: config.cwd ?? "",
    url: config.url ?? "",
    headers: config.headers,
    environment: config.environment,
    enabled: config.enabled,
    trusted: config.trusted,
    trustFingerprint: config.trustFingerprint ?? "",
  };
}

function validServerId(value: string): value is CompositionMcpServerId {
  return MCP_SERVER_ID_PATTERN.test(value);
}

function configFromForm(form: McpFormState): CompositionMcpRuntimeServerConfig | null {
  const name = form.name.trim();
  if (!name || !validServerId(form.serverId.trim())) return null;

  const command = form.command.trim();
  const url = form.url.trim();
  if (form.transport === "stdio" && !command) return null;
  if (form.transport !== "stdio" && !url) return null;

  const args = form.args
    .split(/\r?\n/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);

  return {
    schemaVersion: 1,
    name,
    transport: form.transport,
    args,
    ...(form.transport === "stdio"
      ? {
          command,
          ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
        }
      : { url }),
    headers: form.headers.filter((entry) => entry.name.trim().length > 0),
    environment: form.environment.filter((entry) => entry.name.trim().length > 0),
    enabled: form.enabled,
    trusted: form.trusted,
    ...(form.trustFingerprint.trim() ? { trustFingerprint: form.trustFingerprint.trim() } : {}),
  };
}

function statusLabel(
  state: CompositionMcpRuntimeServerState | undefined,
  enabled: boolean,
): string {
  if (!enabled) return t("Disabled");
  switch (state?.status) {
    case "connected":
      return t("Connected");
    case "connecting":
      return t("Connecting");
    case "error":
      return t("Error");
    default:
      return t("Registered");
  }
}

function statusClassName(state: CompositionMcpRuntimeServerState | undefined, enabled: boolean) {
  if (!enabled) return "text-muted-foreground";
  switch (state?.status) {
    case "connected":
      return "text-success";
    case "error":
      return "text-destructive";
    case "connecting":
      return "text-warning";
    default:
      return "text-muted-foreground";
  }
}

function SecretList({
  label,
  values,
  onChange,
}: {
  readonly label: string;
  readonly values: ReadonlyArray<SecretDraft>;
  readonly onChange: (values: ReadonlyArray<SecretDraft>) => void;
}) {
  const update = (index: number, patch: Partial<SecretDraft>) => {
    onChange(
      values.map((value, valueIndex) => (valueIndex === index ? { ...value, ...patch } : value)),
    );
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange([...values, emptySecret()])}
          type="button"
        >
          <PlusIcon />
          {t("Add")}
        </Button>
      </div>
      {values.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("No entries")}</p>
      ) : (
        values.map((value, index) => (
          <div
            key={`${value.name}-${index}`}
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Input
              value={value.name}
              placeholder={t("Name")}
              aria-label={`${label} ${t("Name")}`}
              onChange={(event) => update(index, { name: event.target.value })}
              spellCheck={false}
            />
            <Input
              value={value.value}
              type={value.sensitive ? "password" : "text"}
              placeholder={
                value.valueRedacted ? t("Saved secret; leave blank to keep it") : t("Value")
              }
              aria-label={`${label} ${t("Value")}`}
              onChange={(event) =>
                update(index, {
                  value: event.target.value,
                  ...(event.target.value.length > 0 ? { valueRedacted: false } : {}),
                })
              }
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex items-center justify-end gap-1">
              <Switch
                checked={value.sensitive}
                aria-label={t("Sensitive value")}
                onCheckedChange={(checked) => update(index, { sensitive: Boolean(checked) })}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={t("Remove")}
                onClick={() => onChange(values.filter((_, valueIndex) => valueIndex !== index))}
                type="button"
              >
                <Trash2Icon />
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function McpServerEditor({
  initial,
  editing,
  onCancel,
  onSave,
}: {
  readonly initial: McpFormState;
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onSave: (form: McpFormState) => void;
}) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const update = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const save = () => {
    const config = configFromForm(form);
    if (!config) {
      setError(t("Enter a valid server ID, name, and transport endpoint."));
      return;
    }
    setError(null);
    onSave(form);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/70 bg-muted/10 p-3 sm:p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Server ID")}
          <Input
            value={form.serverId}
            disabled={editing}
            placeholder="local-tools"
            onChange={(event) => update("serverId", event.target.value)}
            spellCheck={false}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Display name")}
          <Input
            value={form.name}
            placeholder={t("Local tools")}
            onChange={(event) => update("name", event.target.value)}
            spellCheck={false}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Transport")}
          <Select
            value={form.transport}
            onValueChange={(value) => {
              if (MCP_TRANSPORTS.includes(value as CompositionMcpTransport)) {
                update("transport", value as CompositionMcpTransport);
              }
            }}
          >
            <SelectTrigger>
              <SelectValue>{form.transport}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {MCP_TRANSPORTS.map((transport) => (
                <SelectItem key={transport} value={transport}>
                  {transport}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        {form.transport === "stdio" ? (
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            {t("Command")}
            <Input
              value={form.command}
              placeholder="node"
              onChange={(event) => update("command", event.target.value)}
              spellCheck={false}
            />
          </label>
        ) : (
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            {t("URL")}
            <Input
              value={form.url}
              placeholder="https://mcp.example.test"
              onChange={(event) => update("url", event.target.value)}
              spellCheck={false}
            />
          </label>
        )}
      </div>

      {form.transport === "stdio" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            {t("Arguments")}
            <textarea
              className="min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={form.args}
              placeholder={t("One argument per line")}
              onChange={(event) => update("args", event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-medium text-foreground">
            {t("Working directory")}
            <Input
              value={form.cwd}
              placeholder="C:\\workspace"
              onChange={(event) => update("cwd", event.target.value)}
              spellCheck={false}
            />
          </label>
        </div>
      ) : null}

      <SecretList
        label={t("Headers")}
        values={form.headers}
        onChange={(values) => update("headers", values)}
      />
      <SecretList
        label={t("Environment variables")}
        values={form.environment}
        onChange={(values) => update("environment", values)}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground">
          {t("Enabled")}
          <Switch
            checked={form.enabled}
            onCheckedChange={(checked) => update("enabled", Boolean(checked))}
          />
        </label>
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-xs font-medium text-foreground">
          {t("Trusted")}
          <Switch
            checked={form.trusted}
            onCheckedChange={(checked) => update("trusted", Boolean(checked))}
          />
        </label>
      </div>

      {form.trusted ? (
        <label className="grid gap-1.5 text-xs font-medium text-foreground">
          {t("Trust fingerprint")}
          <Input
            value={form.trustFingerprint}
            placeholder={t("Optional trust fingerprint")}
            onChange={(event) => update("trustFingerprint", event.target.value)}
            spellCheck={false}
          />
        </label>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onCancel} type="button">
          {t("Cancel")}
        </Button>
        <Button onClick={save} type="button">
          {t("Save")}
        </Button>
      </div>
    </div>
  );
}

export function McpServersSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const configuredServers = usePrimarySettings((settings) => settings.mcpServers);
  const updateSettings = useUpdatePrimarySettings();
  const runtimeQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.mcpServers({ environmentId, input: {} }),
  );
  const connect = useAtomCommand(serverEnvironment.connectMcpServer, { reportFailure: false });
  const disconnect = useAtomCommand(serverEnvironment.disconnectMcpServer, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshMcpServer, { reportFailure: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingControl, setPendingControl] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const configuredServerMap = configuredServers as unknown as Readonly<
    Record<string, CompositionMcpRuntimeServerConfig>
  >;

  const serverEntries = useMemo(
    () => Object.entries(configuredServerMap ?? EMPTY_MCP_SERVERS),
    [configuredServerMap],
  );
  const runtimeById = useMemo(
    () => new Map((runtimeQuery.data ?? []).map((state) => [state.serverId, state] as const)),
    [runtimeQuery.data],
  );

  const persist = (next: Record<string, CompositionMcpRuntimeServerConfig>) => {
    updateSettings({ mcpServers: next as ServerSettings["mcpServers"] });
  };

  const saveForm = (form: McpFormState) => {
    const config = configFromForm(form);
    if (!config) return;
    persist({ ...configuredServerMap, [form.serverId.trim()]: config });
    setEditingId(null);
    runtimeQuery.refresh();
  };

  const deleteServer = () => {
    if (pendingDelete === null) return;
    const next = { ...configuredServerMap };
    delete next[pendingDelete];
    persist(next);
    setPendingDelete(null);
    if (editingId === pendingDelete) setEditingId(null);
    runtimeQuery.refresh();
  };

  const runControl = async (
    serverId: CompositionMcpServerId,
    operation: "connect" | "disconnect" | "refresh",
  ) => {
    if (environmentId === null) return;
    setActionError(null);
    setPendingControl(`${operation}:${serverId}`);
    const result =
      operation === "connect"
        ? await connect({ environmentId, input: { serverId } })
        : operation === "disconnect"
          ? await disconnect({ environmentId, input: { serverId } })
          : await refresh({ environmentId, input: { serverId } });
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      setActionError(error instanceof Error ? error.message : t("MCP operation failed"));
    }
    setPendingControl(null);
    runtimeQuery.refresh();
  };

  return (
    <>
      <SettingsSection
        id="mcp-servers"
        title={t("MCP servers")}
        icon={<LinkIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <Button
            size="sm"
            onClick={() => setEditingId("__new__")}
            disabled={editingId !== null}
            type="button"
          >
            <PlusIcon />
            {t("Add server")}
          </Button>
        }
      >
        <SettingsRow
          title={t("MCP runtime")}
          description={t(
            "Trusted MCP servers can expose their discovered tools to Code Work Agent Drivers through ToolBroker.",
          )}
          status={runtimeQuery.error ?? (runtimeQuery.isPending ? t("Loading...") : undefined)}
        />

        {editingId === "__new__" ? (
          <McpServerEditor
            key="new-mcp-server"
            initial={emptyForm()}
            editing={false}
            onCancel={() => setEditingId(null)}
            onSave={saveForm}
          />
        ) : null}

        {serverEntries.length === 0 && editingId !== "__new__" ? (
          <SettingsRow
            title={t("No MCP servers configured")}
            description={t(
              "Add a stdio, Streamable HTTP, or SSE server to make its tools available to Code Work.",
            )}
          />
        ) : null}

        {serverEntries.map(([serverId, config]) => {
          const state = runtimeById.get(serverId as CompositionMcpServerId);
          const isEditing = editingId === serverId;
          const connected = state?.status === "connected";
          return (
            <div key={serverId} className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
              {isEditing ? (
                <McpServerEditor
                  key={serverId}
                  initial={formFromConfig(serverId, config)}
                  editing
                  onCancel={() => setEditingId(null)}
                  onSave={saveForm}
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-medium text-foreground">{config.name}</h3>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                          {serverId}
                        </span>
                      </div>
                      <p
                        className={cn(
                          "mt-1 flex items-center gap-1.5 text-xs",
                          statusClassName(state, config.enabled),
                        )}
                      >
                        {state?.status === "connected" ? (
                          <CheckCircle2Icon className="size-3.5" />
                        ) : null}
                        {statusLabel(state, config.enabled)} · {config.transport}
                        {state?.errorCode ? ` · ${state.errorCode}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void runControl(
                            serverId as CompositionMcpServerId,
                            connected ? "disconnect" : "connect",
                          )
                        }
                        disabled={pendingControl !== null || !config.enabled || !config.trusted}
                        type="button"
                      >
                        {connected ? <UnplugIcon /> : <PlugZapIcon />}
                        {connected ? t("Disconnect") : t("Connect")}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("Refresh")}
                        onClick={() =>
                          void runControl(serverId as CompositionMcpServerId, "refresh")
                        }
                        disabled={pendingControl !== null}
                        type="button"
                      >
                        <RefreshCwIcon
                          className={
                            pendingControl === `refresh:${serverId}` ? "animate-spin" : undefined
                          }
                        />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("Edit")}
                        onClick={() => setEditingId(serverId)}
                        disabled={editingId !== null || pendingControl !== null}
                        type="button"
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost-muted"
                        aria-label={t("Delete")}
                        onClick={() => setPendingDelete(serverId)}
                        disabled={pendingControl !== null}
                        type="button"
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span>{config.enabled ? t("Enabled") : t("Disabled")}</span>
                    <span>{config.trusted ? t("Trusted") : t("Untrusted")}</span>
                    <span>
                      {t("Tools")}: {state?.toolNames.length ?? 0}
                    </span>
                  </div>
                  {state?.toolNames.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {state.toolNames.map((toolName) => (
                        <code
                          key={toolName}
                          className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {toolName}
                        </code>
                      ))}
                    </div>
                  ) : null}
                  {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
                </div>
              )}
            </div>
          );
        })}
      </SettingsSection>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Delete MCP server?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("This removes the server configuration and its saved secrets.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button variant="destructive" onClick={deleteServer} type="button">
              <Trash2Icon />
              {t("Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
