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
import { t } from "~/i18n";
import { randomUUID } from "../../lib/utils";

type ConnectionMode = "native" | "api" | "gateway";
const apiNames = (driver: string, bearer = false) =>
  driver === "codex"
    ? { url: "CODEWORK_CODEX_BASE_URL", key: "CODEWORK_CODEX_API_KEY" }
    : { url: "ANTHROPIC_BASE_URL", key: bearer ? "ANTHROPIC_AUTH_TOKEN" : "ANTHROPIC_API_KEY" };

export function providerConnectionMode(instance: ProviderInstanceConfig): ConnectionMode {
  const config = instance.config as Record<string, unknown> | null;
  if (config?.routeThroughByok === true) return "gateway";
  const key = apiNames(instance.driver).key;
  return instance.environment?.some(
    (entry) =>
      (entry.name === key ||
        (instance.driver === "claudeAgent" && entry.name === "ANTHROPIC_AUTH_TOKEN")) &&
      (entry.value || entry.valueRedacted),
  )
    ? "api"
    : "native";
}

export function withProviderConnection(
  instance: ProviderInstanceConfig,
  mode: ConnectionMode,
  url: string,
  key: string,
  bearer = false,
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
  return {
    ...instance,
    config: { ...(instance.config as object), routeThroughByok: mode === "gateway" },
    environment,
  };
}

export function ProviderConnectionSection({
  environmentId: rawEnvironmentId,
  instanceId,
  instance,
  onUpdate,
  onManageChannels,
  sharedChannels,
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
  onManageChannels?: (() => void) | undefined;
  sharedChannels?: ReactNode;
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
  const [url, setUrl] = useState(
    () =>
      instance.environment?.find((entry) => entry.name === names.url)?.value ||
      (instance.driver === "codex" ? "https://api.openai.com/v1" : "https://api.anthropic.com"),
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
  const canDirect = instance.driver === "codex" || instance.driver === "claudeAgent";
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
      const next = withProviderConnection(instance, mode, url, key, bearer);
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
        {(["native", ...(canDirect ? ["api"] : []), "gateway"] as ConnectionMode[]).map((value) => (
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
      {mode === "api" ? (
        <div className="grid min-w-0 gap-3">
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
                <option value="key">API Key (x-api-key)</option>
                <option value="bearer">Bearer Token (Authorization)</option>
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
            <span>API Key</span>
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
                : "providerConnection.anthropicHint",
            )}
          </p>
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            mode === "native" ? "providerConnection.nativeHint" : "providerConnection.gatewayHint",
          )}
        </p>
      )}
      {mode === "gateway" && sharedChannels}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || session !== null} onClick={() => void save()}>
          {t(busy ? "saving" : "save")}
        </Button>
        {mode === "native" && canDirect && (
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
        {mode === "native" && instance.driver === "codex" && (
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
          <Button size="sm" variant="outline" onClick={onManageChannels}>
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
          className={`text-xs leading-relaxed ${feedback.error ? "text-destructive" : "text-muted-foreground"}`}
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
