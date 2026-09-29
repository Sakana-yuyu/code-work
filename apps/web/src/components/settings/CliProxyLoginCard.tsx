import { useCallback, useEffect, useRef, useState } from "react";
import { Cause } from "effect";
import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type CliProxyNativeLogin,
  type LocalAccountProvider,
  type TerminalSessionSnapshot,
} from "@codework/contracts";
import { scopeThreadRef } from "@codework/client-runtime/environment";
import { KeyRoundIcon, LogInIcon, UploadIcon } from "lucide-react";
import { serverEnvironment, primaryServerKeybindingsAtom } from "../../state/server";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { TerminalViewport } from "../ThreadTerminalDrawer";
import { t } from "~/i18n";
import { randomUUID } from "../../lib/utils";

export type PoolLoginProvider = Extract<LocalAccountProvider, "codex" | "claude" | "xai" | "zcode">;

const POOL_LOGIN_PLATFORMS: ReadonlyArray<{
  /** 平台选择器内的唯一键；同一 provider 可有多个登录域入口。 */
  readonly id: string;
  readonly provider: PoolLoginProvider;
  readonly label: string;
  readonly instanceId: ProviderInstanceId;
  readonly deviceCode: boolean;
  /** 厂商自己的登录域（zcode 的 zai/bigmodel）；存在时走服务端原生 OAuth 登录。 */
  readonly loginProvider?: "zai" | "bigmodel";
}> = [
  {
    id: "codex",
    provider: "codex",
    label: "Codex",
    instanceId: ProviderInstanceId.make("codex"),
    deviceCode: true,
  },
  {
    id: "claude",
    provider: "claude",
    label: "Claude",
    instanceId: ProviderInstanceId.make("claudeAgent"),
    deviceCode: false,
  },
  {
    id: "xai",
    provider: "xai",
    label: "Grok / xAI",
    instanceId: ProviderInstanceId.make("grok"),
    deviceCode: true,
  },
  {
    id: "zcode-intl",
    provider: "zcode",
    label: "ZCode 国际版 (Z.AI)",
    instanceId: ProviderInstanceId.make("zcodeAgent"),
    deviceCode: false,
    loginProvider: "zai",
  },
  {
    id: "zcode-domestic",
    provider: "zcode",
    label: "ZCode 国内版 (BigModel)",
    instanceId: ProviderInstanceId.make("zcodeAgent"),
    deviceCode: false,
    loginProvider: "bigmodel",
  },
];

/**
 * 号池「添加账号」卡片：和供应商的原生登录同一套交互——选平台、点登录、
 * 在弹出的终端里完成官方 CLI 授权，关闭/结束后自动把凭据导入号池。
 */
export function CliProxyLoginCard({
  environmentId: rawEnvironmentId,
  disabled,
  importOpen,
  onToggleImport,
  onLoginFinished,
}: {
  environmentId: string;
  disabled: boolean;
  importOpen: boolean;
  onToggleImport: () => void;
  onLoginFinished: (
    input:
      | { provider: PoolLoginProvider; terminalId: string; models: string[] }
      | { provider: PoolLoginProvider; nativePath: string; models: string[] },
  ) => void | Promise<void>;
}) {
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const [platformId, setPlatformId] = useState("codex");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [session, setSession] = useState<TerminalSessionSnapshot | null>(null);
  const [zcodeAuth, setZcodeAuth] = useState<{
    sessionId: string;
    authorizeUrl: string;
  } | null>(null);
  const active = useRef<{ terminalId: string; provider: PoolLoginProvider } | null>(null);
  const [nativeLogins, setNativeLogins] = useState<ReadonlyArray<CliProxyNativeLogin>>([]);
  const [importedPaths, setImportedPaths] = useState<ReadonlySet<string>>(new Set());
  const startLogin = useAtomCommand(serverEnvironment.startProviderLogin, { reportFailure: false });
  const cliProxyCommand = useAtomCommand(serverEnvironment.cliProxy, { reportFailure: false });
  const zcodeLoginCommand = useAtomCommand(serverEnvironment.zcodeLogin, {
    reportFailure: false,
  });
  const closeTerminal = useAtomCommand(terminalEnvironment.close);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const current = POOL_LOGIN_PLATFORMS.find((entry) => entry.id === platformId)!;
  const platform = current.provider;
  const threadId = ThreadId.make(`provider-login:${current.instanceId}`);

  useEffect(
    () => () => {
      const login = active.current;
      active.current = null;
      if (!login) return;
      // zcode 会话不是终端：按会话取消，不做终端关闭。
      if (login.provider === "zcode") {
        void zcodeLoginCommand({
          environmentId,
          input: { action: "cancel", sessionId: login.terminalId },
        });
        return;
      }
      void closeTerminal({
        environmentId,
        input: { threadId, terminalId: login.terminalId, deleteHistory: true },
      });
    },
    [closeTerminal, environmentId, threadId, zcodeLoginCommand],
  );

  /** 失败的统一文案：预检/服务端错误把内层可读原因带上来。 */
  const failureFeedback = (cause: Cause.Cause<unknown>, fallback: string): string => {
    const squashed = Cause.squash(cause);
    const detail =
      squashed instanceof Error && squashed.cause instanceof Error
        ? squashed.cause.message
        : squashed instanceof Error
          ? squashed.message
          : null;
    return detail !== null && detail !== "" ? `${current.label}：${detail}` : fallback;
  };

  const login = async (deviceCode: boolean) => {
    if (active.current) return;
    // ZCode 登录是服务端原生 OAuth（无 CLI）：拿授权链接给用户，后台轮询完成。
    if (current.loginProvider !== undefined) {
      setBusy(true);
      setFeedback(null);
      const result = await zcodeLoginCommand({
        environmentId,
        input: {
          action: "start",
          family: current.loginProvider as "zai" | "bigmodel",
          poolLogin: true,
        },
      });
      setBusy(false);
      if (result._tag === "Success" && result.value.action === "start") {
        active.current = { terminalId: result.value.sessionId, provider: platform };
        setZcodeAuth({
          sessionId: result.value.sessionId,
          authorizeUrl: result.value.authorizeUrl,
        });
      } else {
        setFeedback(
          result._tag === "Failure"
            ? failureFeedback(
                result.cause,
                `${current.label}：${t("providerConnection.loginFailed")}`,
              )
            : `${current.label}：${t("providerConnection.loginFailed")}`,
        );
      }
      return;
    }
    const terminalId = randomUUID();
    active.current = { terminalId, provider: platform };
    setBusy(true);
    setFeedback(null);
    const result = await startLogin({
      environmentId,
      input: {
        instanceId: current.instanceId,
        terminalId,
        deviceCode,
        poolLogin: true,
        loginProvider: current.loginProvider,
      },
    });
    setBusy(false);
    if (result._tag === "Success") setSession(result.value);
    else {
      active.current = null;
      setFeedback(
        failureFeedback(result.cause, `${current.label}：${t("providerConnection.loginFailed")}`),
      );
    }
  };

  /** ZCode 授权完成/失败/取消后结算对话框状态。 */
  const settleZcodeAuth = (nextFeedback: string | null) => {
    setZcodeAuth(null);
    active.current = null;
    setFeedback(nextFeedback);
  };

  // ZCode 会话状态轮询：ready → 结算导入；failed/expired/cancelled → 展示原因。
  useEffect(() => {
    if (zcodeAuth === null) return;
    const sessionId = zcodeAuth.sessionId;
    let disposed = false;
    const timer = window.setInterval(() => {
      void (async () => {
        const result = await zcodeLoginCommand({
          environmentId,
          input: { action: "status", sessionId },
        });
        if (disposed || result._tag !== "Success" || result.value.action !== "status") return;
        const status = result.value;
        if (status.status === "ready") {
          setZcodeAuth(null);
          finish();
        } else if (status.status !== "waiting") {
          settleZcodeAuth(
            status.message !== undefined && status.message !== ""
              ? `${current.label}：${status.message}`
              : `${current.label}：${t("providerConnection.loginFailed")}`,
          );
        }
      })();
    }, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zcodeAuth, zcodeLoginCommand, environmentId]);

  /** 「本机已登录」扫描：默认账号目录 + 各实例受管 home 里的凭据文件。 */
  const scanNativeLogins = useCallback(async () => {
    const result = await cliProxyCommand({
      environmentId,
      input: { action: "scanNativeAccounts" },
    });
    if (result._tag === "Success") {
      setNativeLogins(result.value.nativeLogins ?? []);
    }
  }, [cliProxyCommand, environmentId]);

  useEffect(() => {
    void scanNativeLogins();
  }, [scanNativeLogins]);

  /** 终端结束或对话框关闭：只结算一次，交给号池导入凭据。 */
  const finish = () => {
    const login = active.current;
    active.current = null;
    if (!login) return;
    void scanNativeLogins();
    onLoginFinished({
      provider: login.provider,
      terminalId: login.terminalId,
      models: models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    });
  };

  /** 一键导入扫描到的原生登录态；导入完成后同一路径再点是覆盖式更新。 */
  const importNative = (login: CliProxyNativeLogin) => {
    const provider = login.provider;
    if (provider !== "codex" && provider !== "claude" && provider !== "xai" && provider !== "zcode")
      return;
    setImportedPaths((paths) => new Set(paths).add(login.path));
    const done = onLoginFinished({
      provider,
      nativePath: login.path,
      models: models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
    });
    // 导入完成后重扫——服务端会标记 imported，该行随之隐藏。
    void Promise.resolve(done).then(() => scanNativeLogins());
  };

  return (
    <section
      className="@container/connection space-y-4 rounded-xl border border-border/70 bg-muted/20 p-4"
      aria-label={t("cliProxy.addAccountTitle")}
    >
      <div className="flex items-start gap-2.5">
        <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{t("cliProxy.addAccountTitle")}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("cliProxy.addAccountDescription")}
          </p>
        </div>
      </div>
      <div
        className="grid gap-1 rounded-lg bg-muted/60 p-1 @sm/connection:grid-cols-2"
        role="group"
        aria-label={t("providerConnection.method")}
      >
        <Button
          size="sm"
          variant={importOpen ? "ghost" : "outline"}
          aria-pressed={!importOpen}
          disabled={busy || session !== null || zcodeAuth !== null}
          onClick={() => importOpen && onToggleImport()}
        >
          <LogInIcon />
          {t("cliProxy.modeLogin")}
        </Button>
        <Button
          size="sm"
          variant={importOpen ? "outline" : "ghost"}
          aria-pressed={importOpen}
          disabled={busy || session !== null || zcodeAuth !== null}
          onClick={() => !importOpen && onToggleImport()}
        >
          <UploadIcon />
          {t("cliProxy.modeImport")}
        </Button>
      </div>
      {!importOpen && (
        <div className="space-y-3 animate-in fade-in-50 duration-150 motion-reduce:animate-none">
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label={t("localAccountPool.provider")}
          >
            {POOL_LOGIN_PLATFORMS.map((entry) => (
              <Button
                key={entry.id}
                size="sm"
                variant={platformId === entry.id ? "outline" : "ghost"}
                aria-pressed={platformId === entry.id}
                disabled={busy || session !== null || zcodeAuth !== null}
                onClick={() => setPlatformId(entry.id)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <label className="block space-y-1.5 text-xs font-medium">
            <span>{t("localAccountPool.models")}</span>
            <Input
              autoComplete="off"
              value={models}
              disabled={busy || session !== null || zcodeAuth !== null}
              onChange={(event) => setModels(event.target.value)}
              placeholder={t("cliProxy.loginModelsPlaceholder")}
            />
          </label>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("cliProxy.loginModelsHint")}
          </p>
          {nativeLogins.filter((login) => !login.imported && !importedPaths.has(login.path))
            .length > 0 ? (
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium">{t("cliProxy.nativeLoginsTitle")}</span>
                <Button
                  size="micro"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void scanNativeLogins()}
                >
                  {t("cliProxy.refreshAccounts")}
                </Button>
              </div>
              {nativeLogins
                .filter((login) => !login.imported && !importedPaths.has(login.path))
                .map((login) => (
                  <div
                    key={`${login.provider}:${login.path}`}
                    className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5"
                  >
                    <span className="shrink-0 text-xs font-medium">
                      {POOL_LOGIN_PLATFORMS.find((entry) => entry.provider === login.provider)
                        ?.label ?? login.provider}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {login.label ?? login.path.split(/[\\/]/u).pop() ?? login.path}
                    </span>
                    <Button
                      size="micro"
                      disabled={disabled || busy}
                      onClick={() => importNative(login)}
                    >
                      {importedPaths.has(login.path)
                        ? t("cliProxy.nativeImported")
                        : t("cliProxy.nativeImport")}
                    </Button>
                  </div>
                ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={disabled || busy || session !== null || zcodeAuth !== null}
              onClick={() => void login(false)}
            >
              <LogInIcon />
              {t("providerConnection.login")}
            </Button>
            {current.deviceCode && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || busy || session !== null || zcodeAuth !== null}
                onClick={() => void login(true)}
              >
                {t("providerConnection.deviceLogin")}
              </Button>
            )}
          </div>
        </div>
      )}
      {feedback && (
        <p role="status" className="text-xs leading-relaxed text-destructive">
          {feedback}
        </p>
      )}
      <Dialog
        open={session !== null || zcodeAuth !== null}
        onOpenChange={(open) => {
          if (open) return;
          if (zcodeAuth !== null) {
            const sessionId = zcodeAuth.sessionId;
            settleZcodeAuth(null);
            void zcodeLoginCommand({
              environmentId,
              input: { action: "cancel", sessionId },
            });
            return;
          }
          if (!session) return;
          const terminalId = session.terminalId;
          setSession(null);
          finish();
          void closeTerminal({
            environmentId,
            input: { threadId, terminalId, deleteHistory: true },
          });
        }}
      >
        <DialogPopup className="w-full max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("providerConnection.login")}</DialogTitle>
            <DialogDescription>
              {zcodeAuth !== null ? t("cliProxy.zcodeLoginHint") : t("cliProxy.poolLoginHint")}
            </DialogDescription>
          </DialogHeader>
          {zcodeAuth !== null && (
            <div className="space-y-4 px-1 pb-1">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("cliProxy.zcodeLoginUrlHint")}
              </p>
              <div className="rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
                <code className="block break-all text-xs text-foreground">
                  {zcodeAuth.authorizeUrl}
                </code>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    window.open(zcodeAuth.authorizeUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  {t("cliProxy.zcodeOpenLink")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(zcodeAuth.authorizeUrl)
                      .catch(() => undefined);
                  }}
                >
                  {t("cliProxy.zcodeCopyLink")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const sessionId = zcodeAuth.sessionId;
                    settleZcodeAuth(null);
                    void zcodeLoginCommand({
                      environmentId,
                      input: { action: "cancel", sessionId },
                    });
                  }}
                >
                  {t("cliProxy.zcodeCancel")}
                </Button>
              </div>
              <p role="status" className="text-xs text-muted-foreground">
                {t("cliProxy.zcodeWaiting")}
              </p>
            </div>
          )}
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
                onSessionExited={finish}
              />
            </div>
          )}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
