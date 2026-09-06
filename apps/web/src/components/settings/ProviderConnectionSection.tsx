import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type TerminalSessionSnapshot,
} from "@codework/contracts";
import { scopeThreadRef } from "@codework/client-runtime/environment";
import type { AtomCommandResult } from "@codework/client-runtime/state/runtime";
import { KeyRoundIcon, LinkIcon, LogInIcon } from "lucide-react";
import { serverEnvironment, primaryServerKeybindingsAtom } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { AnimatedHeight } from "../AnimatedHeight";
import { t } from "~/i18n";
import { randomUUID } from "../../lib/utils";

const EMPTY_SHARED_INSTANCES: ReadonlyArray<{ instanceId: ProviderInstanceId; label: string }> = [];

type ConnectionMode = "native" | "api" | "gateway";
const supportsApiConnection = (driver: string): boolean =>
  driver === "codex" || driver === "claudeAgent" || driver === "kimi";
const supportsGatewayConnection = (driver: string): boolean =>
  driver === "codex" || driver === "claudeAgent" || driver === "grok" || driver === "opencode";
const apiNames = (driver: string, bearer = false) =>
  driver === "codex"
    ? { url: "CODEWORK_CODEX_BASE_URL", key: "CODEWORK_CODEX_API_KEY" }
    : driver === "kimi"
      ? { url: "KIMI_BASE_URL", key: "KIMI_API_KEY" }
      : driver === "antigravity"
        ? { url: "AGY_BASE_URL", key: "AGY_API_KEY" }
        : {
            url: "ANTHROPIC_BASE_URL",
            key: bearer ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY",
          };

export function providerConnectionMode(instance: ProviderInstanceConfig): ConnectionMode {
  const config = instance.config as Record<string, unknown> | null;
  if (supportsGatewayConnection(instance.driver) && config?.routeThroughByok === true)
    return "gateway";
  const key = apiNames(instance.driver).key;
  if (
    supportsApiConnection(instance.driver) &&
    instance.environment?.some(
      (entry) =>
        (entry.name === key ||
          (instance.driver === "claudeAgent" && entry.name === "ANTHROPIC_AUTH_TOKEN")) &&
        (entry.value || entry.valueRedacted),
    )
  )
    return "api";
  return "native";
}

export function withProviderConnection(
  instance: ProviderInstanceConfig,
  mode: ConnectionMode,
  url: string,
  key: string,
  bearer = false,
  sourceInstanceId?: ProviderInstanceId,
): ProviderInstanceConfig {
  const names = apiNames(instance.driver, bearer);
  const current = instance.environment ?? [];
  const existingKey = current.find((entry) => entry.name === names.key);
  if (mode === "api") {
    const parsed = new URL(url.trim());
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(t("providerConnection.invalidUrl"));
    }
    if (!key.trim() && !existingKey?.value && !existingKey?.valueRedacted)
      throw new Error(t("providerConnection.keyRequired"));
  }
  const managed =
    instance.driver === "codex"
      ? [names.url, names.key, "OPENAI_API_KEY", "OPENAI_BASE_URL"]
      : instance.driver === "claudeAgent"
        ? [names.url, "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]
        : instance.driver === "kimi"
          ? [names.url, names.key]
          : [];
  const environment = current.filter((entry) => !managed.includes(entry.name));
  if (mode === "api") {
    environment.push({ name: names.url, value: url.trim().replace(/\/+$/, ""), sensitive: false });
    environment.push(
      key.trim()
        ? { name: names.key, value: key.trim(), sensitive: true }
        : { ...existingKey!, sensitive: true },
    );
    if (instance.driver === "claudeAgent") {
      // 显式屏蔽服务器继承的另一种鉴权，避免将两套凭据发到同一地址。
      environment.push({
        name: bearer ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN",
        value: "",
        sensitive: true,
      });
      environment.push({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "", sensitive: true });
    }
  }
  const config: Record<string, unknown> = {
    ...(instance.config as Record<string, unknown>),
    routeThroughByok: mode === "gateway" && supportsGatewayConnection(instance.driver),
  };
  if (sourceInstanceId) config.byokSourceInstanceId = sourceInstanceId;
  else delete config.byokSourceInstanceId;
  return {
    ...instance,
    config,
    environment,
  };
}

export function ProviderConnectionSection({
  environmentId: rawEnvironmentId,
  instanceId,
  instance,
  onUpdate,
  onManageChannels,
  renderSharedChannels,
  sharedInstances = EMPTY_SHARED_INSTANCES,
}: {
  environmentId: string;
  instanceId: ProviderInstanceId;
  instance: ProviderInstanceConfig;
  onUpdate: (
    next: ProviderInstanceConfig,
  ) =>
    | AtomCommandResult<unknown, unknown>
    | null
    | PromiseLike<AtomCommandResult<unknown, unknown> | null>;
  onManageChannels?: ((instanceId?: ProviderInstanceId) => void) | undefined;
  renderSharedChannels?: ((instanceId: string) => ReactNode) | undefined;
  sharedInstances?: ReadonlyArray<{ instanceId: ProviderInstanceId; label: string }> | undefined;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const [bearer, setBearer] = useState(
    () =>
      instance.environment?.some(
        (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN" && (entry.value || entry.valueRedacted),
      ) ?? false,
  );
  const names = apiNames(instance.driver, bearer);
  const [mode, setMode] = useState(() => providerConnectionMode(instance));
  const savedSource = (instance.config as { byokSourceInstanceId?: ProviderInstanceId } | undefined)
    ?.byokSourceInstanceId;
  const [sourceInstanceId, setSourceInstanceId] = useState(savedSource);
  useEffect(() => setSourceInstanceId(savedSource), [savedSource]);
  const [url, setUrl] = useState(
    () =>
      instance.environment?.find((entry) => entry.name === names.url)?.value ||
      (instance.driver === "codex"
        ? "https://api.openai.com/v1"
        : instance.driver === "kimi"
          ? "https://api.kimi.com/coding"
          : "https://api.anthropic.com"),
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const sessionId = useRef<string | null>(null);
  const startLogin = useAtomCommand(serverEnvironment.startProviderLogin, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const threadId = ThreadId.make(`provider-login:${instanceId}`);
  const canDirect = supportsApiConnection(instance.driver);
  const canGateway = supportsGatewayConnection(instance.driver);
  const canLogin =
    canDirect ||
    instance.driver === "grok" ||
    instance.driver === "kimi" ||
    instance.driver === "antigravity";
  const storedKey = instance.environment?.some(
    (entry) => entry.name === names.key && (entry.value || entry.valueRedacted),
  );
  const savedMode = providerConnectionMode(instance);
  const savedUrl = instance.environment?.find((entry) => entry.name === names.url)?.value;
  useEffect(() => {
    setMode(savedMode);
  }, [savedMode]);
  useEffect(() => {
    if (savedUrl) setUrl(savedUrl);
  }, [savedUrl]);

  useEffect(
    () => () => {
      const terminalId = sessionId.current;
      sessionId.current = null;
      if (terminalId)
        void closeTerminal({ environmentId, input: { threadId, terminalId, deleteHistory: true } });
    },
    [closeTerminal, environmentId, threadId],
  );

  const save = async () => {
    setBusy(true);
    setFeedback(null);
    try {
      const next = withProviderConnection(instance, mode, url, key, bearer, sourceInstanceId);
      const result = await onUpdate(next);
      if (result !== null && result._tag !== "Success") throw new Error(t("settingsSaveTryAgain"));
      setKey("");
      setFeedback({ error: false, text: t("providerConnection.saved") });
      return true;
    } catch (error) {
      setFeedback({
        error: true,
        text:
          error instanceof TypeError
            ? t("providerConnection.invalidUrl")
            : error instanceof Error
              ? error.message
              : t("settingsSaveTryAgain"),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const login = async (deviceCode: boolean) => {
    if (sessionId.current) return;
    const terminalId = randomUUID();
    sessionId.current = terminalId;
    if (!(await save())) {
      sessionId.current = null;
      return;
    }
    if (sessionId.current !== terminalId) return;
    setBusy(true);
    const result = await startLogin({
      environmentId,
      input: { instanceId, terminalId, deviceCode },
    });
    setBusy(false);
    if (sessionId.current !== terminalId) {
      if (result._tag === "Success")
        void closeTerminal({ environmentId, input: { threadId, terminalId, deleteHistory: true } });
      return;
    }
    if (result._tag === "Success") setSession(result.value);
    else {
      sessionId.current = null;
      setFeedback({ error: true, text: t("providerConnection.loginFailed") });
    }
  };

  return (
    <section
      className="@container/connection space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4"
      aria-label={t("providerConnection.title")}
    >
      <div className="flex items-start gap-2.5">
        <LinkIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{t("providerConnection.title")}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("providerConnection.description")}
          </p>
        </div>
      </div>
      <div
        className="grid gap-1 rounded-lg bg-muted/60 p-1 @sm/connection:grid-cols-3"
        role="group"
        aria-label={t("providerConnection.method")}
      >
        {(
          [
            "native",
            ...(canDirect ? ["api"] : []),
            ...(canGateway ? ["gateway"] : []),
          ] as ConnectionMode[]
        ).map((value) => (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? "outline" : "ghost"}
            aria-pressed={mode === value}
            disabled={busy || session !== null}
            onClick={() => {
              setMode(value);
              setFeedback(null);
            }}
          >
            {value === "native" ? <LogInIcon /> : value === "api" ? <KeyRoundIcon /> : <LinkIcon />}
            {t(`providerConnection.${value}`)}
          </Button>
        ))}
      </div>
      <AnimatedHeight>
        <div className="space-y-3">
          {mode === "api" ? (
            <div className="grid min-w-0 gap-3 animate-in fade-in-50 duration-150 motion-reduce:animate-none">
              {instance.driver === "claudeAgent" && (
                <label className="space-y-1.5 text-xs font-medium">
                  <span>{t("providerConnection.authHeader")}</span>
                  <select
                    value={bearer ? "bearer" : "key"}
                    disabled={busy}
                    onChange={(event) => {
                      setBearer(event.target.value === "bearer");
                      setKey("");
                      setFeedback(null);
                    }}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="key">{t("providerConnection.apiKeyOption")}</option>
                    <option value="bearer">{t("providerConnection.bearerOption")}</option>
                  </select>
                </label>
              )}
              <label className="space-y-1.5 text-xs font-medium">
                <span>{t("providerConnection.url")}</span>
                <Input
                  type="url"
                  autoComplete="off"
                  value={url}
                  disabled={busy}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setFeedback(null);
                  }}
                  placeholder="https://api.example.com/v1"
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                <span>{t("providerConnection.apiKeyHeader")}</span>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={key}
                  disabled={busy}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setFeedback(null);
                  }}
                  placeholder={t(
                    storedKey ? "providerConnection.keySaved" : "providerConnection.keyPlaceholder",
                  )}
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  instance.driver === "codex"
                    ? "providerConnection.responsesHint"
                    : instance.driver === "kimi"
                      ? "providerConnection.kimiHint"
                      : "providerConnection.anthropicHint",
                )}
              </p>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground animate-in fade-in-50 duration-150 motion-reduce:animate-none">
              {t(
                mode === "native"
                  ? "providerConnection.nativeHint"
                  : "providerConnection.gatewayHint",
              )}
            </p>
          )}
          {instance.driver === "opencode" &&
          (instance.config as { serverUrl?: string } | undefined)?.serverUrl ? (
            <p className="text-xs text-muted-foreground">{t("cliProxy.openCodeHint")}</p>
          ) : null}
          {mode === "gateway" && (
            <label className="block space-y-1.5 text-xs font-medium animate-in fade-in-50 duration-150 motion-reduce:animate-none">
              <span>{t("cliProxy.sharedRoute")}</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={sourceInstanceId ?? ""}
                disabled={busy}
                onChange={(event) => {
                  setSourceInstanceId(
                    sharedInstances.find((item) => item.instanceId === event.target.value)
                      ?.instanceId,
                  );
                  setFeedback(null);
                }}
              >
                <option value="">{t("cliProxy.allRoutes")}</option>
                {sourceInstanceId &&
                  !sharedInstances.some((item) => item.instanceId === sourceInstanceId) && (
                    <option value={sourceInstanceId}>
                      {t("cliProxy.missingRoute", { id: sourceInstanceId })}
                    </option>
                  )}
                {sharedInstances.map((item) => (
                  <option key={item.instanceId} value={item.instanceId}>
                    {item.label}
                  </option>
                ))}
              </select>
              <p className="font-normal text-muted-foreground">{t("cliProxy.sharedHint")}</p>
            </label>
          )}
          {mode === "gateway" && renderSharedChannels?.(sourceInstanceId ?? "")}
        </div>
      </AnimatedHeight>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || session !== null} onClick={() => void save()}>
          {t(busy ? "saving" : "save")}
        </Button>
        {mode === "native" && canLogin && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session !== null}
            onClick={() => void login(false)}
          >
            <LogInIcon />
            {t("providerConnection.login")}
          </Button>
        )}
        {mode === "native" && (instance.driver === "codex" || instance.driver === "grok") && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || session !== null}
            onClick={() => void login(true)}
          >
            {t("providerConnection.deviceLogin")}
          </Button>
        )}
        {mode === "gateway" && onManageChannels && (
          <Button size="sm" variant="outline" onClick={() => onManageChannels(sourceInstanceId)}>
            {t("providerConnection.manageChannels")}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void refresh({ environmentId, input: {} })}
        >
          {t("refreshProviderStatus")}
        </Button>
      </div>
      {feedback && (
        <p
          role="status"
          className={`text-xs leading-relaxed transition-opacity duration-150 animate-in fade-in-50 motion-reduce:animate-none ${feedback.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {feedback.text}
        </p>
      )}
      <Dialog
        open={session !== null}
        onOpenChange={(open) => {
          if (open || !session) return;
          sessionId.current = null;
          void closeTerminal({
            environmentId,
            input: { threadId, terminalId: session.terminalId, deleteHistory: true },
          });
          setSession(null);
          void refresh({ environmentId, input: {} });
        }}
      >
        <DialogPopup className="w-full max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("providerConnection.login")}</DialogTitle>
            <DialogDescription>{t("providerConnection.loginHint")}</DialogDescription>
          </DialogHeader>
          {session && (
            <div className="h-80 min-w-0 overflow-hidden px-3 pb-3">
              <TerminalViewport
                advancedTypography={false}
                threadRef={scopeThreadRef(environmentId, threadId)}
                threadId={threadId}
                terminalId={session.terminalId}
                terminalLabel={t("providerConnection.login")}
                cwd={session.cwd}
                keybindings={keybindings}
                autoFocus
                focusRequestId={1}
                resizeEpoch={0}
                drawerHeight={320}
                onAddTerminalContext={() => {}}
                onSessionExited={() => {
                  void refresh({ environmentId, input: {} });
                }}
              />
            </div>
          )}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
