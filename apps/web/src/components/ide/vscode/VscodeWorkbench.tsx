import { useCallback, useEffect, useRef, useState } from "react";
import {
  WS_METHODS,
  IdeCodeSelection,
  type EnvironmentId,
  type IdeConnectionInfo,
  type IdeOpenResult,
} from "@codework/contracts";
import { createEnvironmentRpcCommand } from "@codework/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { useAtomCommand } from "../../../state/use-atom-command";
import { usePreparedConnection } from "../../../state/session";
import { Button } from "../../ui/button";
import { t, useResolvedLanguage } from "../../../i18n";
import { getNLSLanguage } from "@codingame/monaco-vscode-api/vscode/vs/nls";
import { useTheme } from "../../../hooks/useTheme";
import {
  getCustomThemes,
  installCustomTheme,
  updateCustomTheme,
  type ThemeDefinition,
} from "../../../themePalette";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ThemeBackdrop, ThemeVideoControls } from "../../settings/ThemeBackground";
import "./workbenchBackground.css";

import {
  attachPart,
  isPartVisibile,
  onPartVisibilityChange,
  Parts,
} from "@codingame/monaco-vscode-views-service-override";
import {
  bootstrapVscodeIde,
  executeWorkbenchCommand,
  onIdeSocketClose,
  relayoutWorkbenchPart,
  revealRemoteFile,
  showWorkbenchTerminal,
  setRemoteWorkspaceFolder,
  trackActiveEditorSelection,
  type VscodeIdeRuntime,
} from "./bootstrap";
import { capabilityChanged, planSessionReload, proxyOriginFromBaseUrl } from "./sessionWatchdog";
import {
  CODEWORK_IDE_COMMAND_EVENT,
  codeossWorkbenchCommands,
  type CodeossCommand,
} from "../codeossCommands";
import { revealTerminalPanel } from "./panelVisibility";

const openIde = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ide.open",
  tag: WS_METHODS.ideOpen,
});

// Watchdog cadence: slow sweep while healthy, fast while the server is
// rebuilding the session, throttled immediate probe on abnormal socket closes.
const IDE_HEALTH_PROBE_MS = 30_000;
const IDE_RECOVERY_PROBE_MS = 3_000;
const IDE_SOCKET_PROBE_THROTTLE_MS = 5_000;

function reportThemeSyncError(error: unknown) {
  console.error("[codework-ide] theme sync failed", error);
  toastManager.add(stackedThreadToast({ type: "error", title: t("ide.themeSyncFailed") }));
}

/**
 * The IDE workbench rendered inside the Code Work document: VS Code parts are
 * attached into these DOM nodes directly — no iframe, no nested page. The
 * conversation column stays a Code Work-owned sibling in the layout grid.
 */
export default function VscodeWorkbench(props: {
  environmentId: EnvironmentId;
  cwd: string;
  enabled: boolean;
  relativePath?: string | null;
  line?: number | null;
  revealRequestId?: number;
  onSelection: (selection: IdeCodeSelection) => void;
}) {
  const language = useResolvedLanguage();
  const languageChanged = language.toLowerCase() !== (getNLSLanguage() ?? "en");
  const { setTheme, setAppearanceMode, refreshTheme } = useTheme();
  const onThemeSelected = useCallback(
    (theme: ThemeDefinition) => {
      if (getCustomThemes().some((existing) => existing.id === theme.id)) updateCustomTheme(theme);
      else installCustomTheme(theme);
      if (!setTheme(theme.id) || !setAppearanceMode(theme.appearance)) {
        throw new Error(t("couldNotSaveYourTheme"));
      }
      refreshTheme();
    },
    [setTheme, setAppearanceMode, refreshTheme],
  );
  const open = useAtomCommand(openIde, { reportFailure: false });
  const connection = usePreparedConnection(props.environmentId);
  const baseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const [status, setStatus] = useState<IdeOpenResult>({ phase: "starting", message: "" });
  const [ideConnection, setIdeConnection] = useState<IdeConnectionInfo | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [panelVisible, setPanelVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const runtimeRef = useRef<VscodeIdeRuntime | null>(null);
  const onSelectionRef = useRef(props.onSelection);
  onSelectionRef.current = props.onSelection;
  const activityBarRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const editorsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const statusBarRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Resolve the authorized proxy prefix for this environment's REH session.
  useEffect(() => {
    if (!props.enabled || !baseUrl) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function connect(retry: boolean) {
      const result = await open({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, retry },
      });
      if (cancelled) return;
      if (result._tag !== "Success") {
        setStatus({ phase: "error", message: t("ide.connectionFailed") });
        return;
      }
      setStatus(result.value);
      if (result.value.phase === "ready" && result.value.connection) {
        setIdeConnection(result.value.connection);
      } else if (result.value.phase !== "error") {
        timer = setTimeout(() => void connect(false), 1500);
      }
    }
    void connect(attempt > 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, props.environmentId, props.cwd, props.enabled, baseUrl, attempt]);

  // Initialize the shared in-document VS Code runtime exactly once; later
  // mounts (mode switches, HMR) reuse the live instance.
  useEffect(() => {
    if (!props.enabled || ideConnection === null) return;
    let cancelled = false;
    void bootstrapVscodeIde({
      capabilityBase: ideConnection.webSocketPath.replace(/\/$/, ""),
      product: ideConnection,
      folderPath: ideConnection.folderPath,
      // A non-primary environment serves its own /api/ide proxy; the page
      // origin would route B-environment capabilities to the wrong backend.
      proxyOrigin: proxyOriginFromBaseUrl(baseUrl),
      onThemeSelected,
      onThemeSyncError: reportThemeSyncError,
    })
      .then((runtime) => {
        if (!cancelled) {
          runtimeRef.current = runtime;
          setBootstrapped(true);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("[codework-ide] workbench bootstrap failed", error);
        setStatus({ phase: "error", message: t("ide.connectionFailed") });
      });
    return () => {
      cancelled = true;
    };
  }, [props.enabled, ideConnection, onThemeSelected, baseUrl]);

  // The runtime binds one capability per page lifetime, so a server answer
  // pointing at a different one (rebuilt session, switched environment) can
  // only be followed with a controlled reload that rebinds the WebSocket
  // factory, resource proxy and workspace. sessionWatchdog bounds the reload
  // count so a flapping server cannot loop the tab; dirty editors survive the
  // reload via hot exit and chat drafts persist in localStorage.
  useEffect(() => {
    if (!bootstrapped || !ideConnection) return;
    if (!capabilityChanged(runtimeRef.current?.capabilityBase, ideConnection.webSocketPath)) {
      return;
    }
    if (planSessionReload(window.sessionStorage)) {
      window.location.reload();
    } else {
      setStatus({ phase: "error", message: t("ide.sessionRebuildPaused") });
    }
  }, [bootstrapped, ideConnection]);

  // Session watchdog: nothing upstream notices a dead REH after ready, so
  // probe the server on a slow cadence and immediately (throttled) when an
  // IDE socket closes abnormally. `retry: true` is a no-op on a healthy
  // session and rebuilds an errored one; a rebuilt capability flows into the
  // rebind effect above.
  useEffect(() => {
    if (!bootstrapped || !props.enabled || ideConnection === null) return;
    let cancelled = false;
    let probing = false;
    let lastSocketProbe = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void probe(), delay);
    };
    const probe = async () => {
      if (probing || cancelled) return;
      probing = true;
      try {
        const result = await open({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, retry: true },
        });
        if (cancelled) return;
        const value = result._tag === "Success" ? result.value : null;
        const connection = value?.phase === "ready" && value.connection ? value.connection : null;
        if (
          connection &&
          capabilityChanged(runtimeRef.current?.capabilityBase, connection.webSocketPath)
        ) {
          setIdeConnection(connection);
          return; // the page is about to reload; stop scheduling
        }
        // A non-ready, non-error phase means the server is rebuilding the
        // session right now — poll fast until it lands.
        schedule(
          value !== null && value.phase !== "ready" && value.phase !== "error"
            ? IDE_RECOVERY_PROBE_MS
            : IDE_HEALTH_PROBE_MS,
        );
      } catch {
        // A failed probe must not kill the watchdog: reschedule and record.
        schedule(IDE_HEALTH_PROBE_MS);
      } finally {
        probing = false;
      }
    };
    const disposeSocketWatch = onIdeSocketClose((code) => {
      if (code === 1000 || code === 1001) return;
      const now = Date.now();
      if (now - lastSocketProbe < IDE_SOCKET_PROBE_THROTTLE_MS) return;
      lastSocketProbe = now;
      void probe();
    });
    schedule(IDE_HEALTH_PROBE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      disposeSocketWatch.dispose();
    };
  }, [bootstrapped, props.enabled, ideConnection, props.environmentId, props.cwd, open]);

  // Attach each workbench part into our grid nodes. attachPart returns a
  // disposable so StrictMode double-mounts stay balanced.
  useEffect(() => {
    if (!bootstrapped) return;
    const parts: Array<[Parts, React.RefObject<HTMLDivElement | null>]> = [
      [Parts.ACTIVITYBAR_PART, activityBarRef],
      [Parts.SIDEBAR_PART, sidebarRef],
      [Parts.EDITOR_PART, editorsRef],
      [Parts.PANEL_PART, panelRef],
      [Parts.STATUSBAR_PART, statusBarRef],
    ];
    const disposables = parts
      .filter(([, ref]) => ref.current !== null)
      .flatMap(([part, ref]) => [
        attachPart(part, ref.current!),
        onPartVisibilityChange(part, (visible) => {
          if (ref.current) ref.current.style.display = visible ? "" : "none";
          if (part === Parts.PANEL_PART) setPanelVisible(visible);
        }),
      ]);
    // The terminal toggle command updates the workbench layout service before
    // the attached part emits its visibility event. Read the authoritative
    // service state once after attaching so a hidden panel does not leave the
    // host grid at 0px after the first command.
    setPanelVisible(isPartVisibile(Parts.PANEL_PART));
    // Parts are laid out at a 9999px placeholder before they land in this
    // grid, so drive their layout from the host container sizes ourselves.
    const relayoutAll = () => {
      for (const [part, ref] of parts) {
        const el = ref.current;
        if (el && el.style.display !== "none") {
          void relayoutWorkbenchPart(part, el.offsetWidth, el.offsetHeight);
        }
      }
    };
    relayoutAll();
    const rootEl = rootRef.current;
    const observer =
      typeof ResizeObserver !== "undefined" && rootEl ? new ResizeObserver(relayoutAll) : null;
    if (observer && rootEl) observer.observe(rootEl);
    window.addEventListener("resize", relayoutAll);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", relayoutAll);
      for (const disposable of disposables) disposable.dispose();
    };
  }, [bootstrapped]);

  // IDE 模式默认展示底部终端，保持 VS Code 工作区的主编辑区、文件树和
  // 终端三块结构；对话模式不会挂载这个组件，因此不会改变对话布局。
  useEffect(() => {
    if (!bootstrapped || isPartVisibile(Parts.PANEL_PART)) return;
    void revealTerminalPanel(false, showWorkbenchTerminal)
      .then((revealed) => {
        if (revealed) setPanelVisible(true);
      })
      .catch((error: unknown) => {
        console.error("[codework-ide] terminal panel reveal failed", error);
      });
  }, [bootstrapped]);

  // Workspace intents (header buttons, sidebar toggle) arrive as window
  // events; execute them in the live workbench command service.
  useEffect(() => {
    if (!bootstrapped) return;
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<CodeossCommand>).detail;
      const commandId = codeossWorkbenchCommands[command];
      if (commandId) {
        void executeWorkbenchCommand(commandId)
          .then(() => setPanelVisible(isPartVisibile(Parts.PANEL_PART)))
          .catch(() => {});
      }
    };
    window.addEventListener(CODEWORK_IDE_COMMAND_EVENT, onCommand);
    return () => window.removeEventListener(CODEWORK_IDE_COMMAND_EVENT, onCommand);
  }, [bootstrapped]);

  // Follow the active chat project: point the remote workspace at the
  // project's directory whenever the surrounding thread switches.
  useEffect(() => {
    if (!bootstrapped || !props.enabled || ideConnection === null) return;
    void setRemoteWorkspaceFolder(ideConnection.folderPath).catch((error: unknown) => {
      // Retried on the next cwd/reveal change; log so a persistent switch
      // failure is diagnosable instead of silently blanking the Explorer.
      console.error("[codework-ide] workspace switch failed", error);
    });
  }, [bootstrapped, props.enabled, ideConnection]);

  // Reveal a file (from a file mention or an AI message link) in the editor.
  useEffect(() => {
    if (!bootstrapped || !props.enabled || !props.relativePath) return;
    void revealRemoteFile(props.cwd, props.relativePath, props.line ?? null).catch(() => {});
  }, [
    bootstrapped,
    props.enabled,
    props.cwd,
    props.relativePath,
    props.line,
    props.revealRequestId,
  ]);

  // Forward the active editor selection into the Code Work composer. This
  // listens on the document's code editor service directly, so it works
  // whether or not the web worker extension host is up.
  useEffect(() => {
    if (!bootstrapped || !props.enabled) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void trackActiveEditorSelection(props.cwd, (selection) => {
      if (!disposed) onSelectionRef.current(selection);
    }).then((dispose) => {
      if (disposed) dispose();
      else stop = dispose;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [bootstrapped, props.enabled, props.cwd]);

  const ready = bootstrapped;

  return (
    <div
      ref={rootRef}
      className="codework-vscode-workbench relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-vscode-workbench
    >
      {languageChanged ? (
        <div
          className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2 text-xs"
          role="status"
        >
          <span>{t("ide.languageReloadRequired")}</span>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {t("reload")}
          </Button>
        </div>
      ) : null}
      <div className="max-w-full shrink-0 self-end">
        <ThemeVideoControls />
      </div>
      <div
        className="grid min-h-0 min-w-0 flex-1"
        style={{
          gridTemplateColumns: "auto auto minmax(0, 1fr)",
          // Statusbar and panel rows are height-capped: parts laid out before
          // their containers attach report placeholder sizes (9999px), and
          // unconstrained auto rows would let that collapse the 1fr rows.
          gridTemplateRows: `minmax(0, 1fr) ${panelVisible ? "minmax(0, 40%)" : "0px"} 22px`,
          gridTemplateAreas: `
            "activitybar sidebar editors"
            "activitybar sidebar panel"
            "statusbar statusbar statusbar"
          `,
        }}
      >
        <div
          ref={activityBarRef}
          data-vscode-part="activitybar"
          className="min-h-0 overflow-hidden"
          style={{ gridArea: "activitybar" }}
        />
        <div
          ref={sidebarRef}
          data-vscode-part="sidebar"
          className="theme-ide-sidebar relative isolate min-h-0 min-w-0 overflow-hidden border-r border-border"
          style={{ gridArea: "sidebar", width: 260 }}
        >
          <ThemeBackdrop region="sidebar" />
        </div>
        <div
          ref={editorsRef}
          data-vscode-part="editors"
          className="min-h-0 min-w-0 overflow-hidden"
          style={{ gridArea: "editors" }}
        />
        <div
          ref={panelRef}
          data-vscode-part="panel"
          className="min-h-0 min-w-0 overflow-hidden"
          style={{ gridArea: "panel" }}
        />
        <div
          ref={statusBarRef}
          data-vscode-part="statusbar"
          className="min-h-0 overflow-hidden"
          style={{ gridArea: "statusbar", height: 22 }}
        />
      </div>
      {!ready || status.phase === "error" ? (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center text-sm"
          role="status"
        >
          <img src="/apple-touch-icon.png" alt="" className="size-12" />
          <span className="font-medium">{t("ide.workbenchTitle")}</span>
          <span className="max-w-md text-muted-foreground">
            {ready
              ? t("ide.loadingWorkbench")
              : status.phase === "starting" || status.phase === "installing"
                ? status.message || t("ide.preparing")
                : status.phase === "error"
                  ? status.message || t("ide.connectionFailed")
                  : t("ide.loadingWorkbench")}
          </span>
          {status.phase === "error" ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {t("ide.retry")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
