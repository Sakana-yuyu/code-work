/**
 * VS Code workbench services mounted directly into the Code Work document.
 *
 * The upstream `monaco-vscode-api` runtime must be initialized exactly once
 * per page load; every React mount afterwards only attaches parts into its
 * own DOM nodes (see `VscodeWorkbench.tsx`). The remote extension host runs
 * as the REH process started by the Code Work server and is reached through
 * the same authorized `/api/ide/{capability}` proxy the previous embedded
 * page used — but now as a plain same-document WebSocket, not an iframe.
 */
import { initialize, getService, LogLevel } from "@codingame/monaco-vscode-api";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { IWorkspaceContextService } from "@codingame/monaco-vscode-api/vscode/vs/platform/workspace/common/workspace.service";
import { ICommandService } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands.service";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { ICodeEditorService } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/services/codeEditorService.service";
import { IWorkbenchLayoutService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/layout/browser/layoutService.service";
import { IWorkbenchThemeService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/workbenchThemeService.service";
import { Parts } from "@codingame/monaco-vscode-views-service-override";
import type { IdeConnectionInfo } from "@codework/contracts";
import { workbenchResourceUri } from "./resourceUri";
import { registerExtension, ExtensionHostKind } from "@codingame/monaco-vscode-api/extensions";
import { ColorThemeData } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/themes/common/colorThemeData";
import { IConfigurationService } from "@codingame/monaco-vscode-api/vscode/vs/platform/configuration/common/configuration.service";
import { ITerminalService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/terminal/browser/terminal.service";
import { IExtensionService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service";
import { IExtensionResourceLoaderService } from "@codingame/monaco-vscode-api/vscode/vs/platform/extensionResourceLoader/common/extensionResourceLoader.service";
import { IWorkingCopyBackupService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyBackup.service";
import { IWorkingCopyService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/workingCopy/common/workingCopyService.service";
import { createIndexedDbBackupStore, HotExitBackupService } from "./hotExitBackup";
import type { ThemeDefinition } from "../../../themePalette";
import { APP_WORKBENCH_THEMES, startWorkbenchThemeSync } from "./themeSync";
import { workbenchThemeDataUrl } from "./themeColors";

import getBaseServiceOverride from "@codingame/monaco-vscode-base-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExtensionsServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride from "@codingame/monaco-vscode-files-service-override";
import { IFileService } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files.service";
import getHostServiceOverride from "@codingame/monaco-vscode-host-service-override";
import getLayoutServiceOverride from "@codingame/monaco-vscode-layout-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getRemoteAgentServiceOverride from "@codingame/monaco-vscode-remote-agent-service-override";
import getViewsServiceOverride, {
  isEditorPartVisible,
} from "@codingame/monaco-vscode-views-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override";
import getTerminalServiceOverride from "@codingame/monaco-vscode-terminal-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getDebugServiceOverride from "@codingame/monaco-vscode-debug-service-override";
import getTaskServiceOverride from "@codingame/monaco-vscode-task-service-override";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getTimelineServiceOverride from "@codingame/monaco-vscode-timeline-service-override";
import getSnippetsServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getCommentsServiceOverride from "@codingame/monaco-vscode-comments-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getWorkspaceTrustServiceOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getMultiDiffEditorServiceOverride from "@codingame/monaco-vscode-multi-diff-editor-service-override";
import getAccessibilityServiceOverride from "@codingame/monaco-vscode-accessibility-service-override";
import getViewStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getViewTitleBarServiceOverride from "@codingame/monaco-vscode-view-title-bar-service-override";
import getAuthenticationServiceOverride from "@codingame/monaco-vscode-authentication-service-override";
import getSecretStorageServiceOverride from "@codingame/monaco-vscode-secret-storage-service-override";
import getUserDataProfileServiceOverride from "@codingame/monaco-vscode-user-data-profile-service-override";

// Default themes, grammars and language basics. Without the theme defaults
// the workbench renders unstyled, and without grammars the tokenization
// stays plain text.
import "@codingame/monaco-vscode-theme-defaults-default-extension";
import "@codingame/monaco-vscode-json-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-css-default-extension";
import "@codingame/monaco-vscode-html-default-extension";
import "@codingame/monaco-vscode-markdown-basics-default-extension";
import "@codingame/monaco-vscode-python-default-extension";
import "@codingame/monaco-vscode-json-language-features-default-extension";
import "@codingame/monaco-vscode-typescript-language-features-default-extension";
import "@codingame/monaco-vscode-css-language-features-default-extension";
import "@codingame/monaco-vscode-html-language-features-default-extension";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import textmateWorker from "@codingame/monaco-vscode-textmate-service-override/worker?worker";
import outputLinkWorker from "@codingame/monaco-vscode-output-service-override/worker?worker";
import extensionHostWorker from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker";
import localFileSearchWorker from "@codingame/monaco-vscode-search-service-override/worker?worker";
import extensionHostWorkerUrl from "./extensionHostWorker.ts?worker&url";

// VS Code's remote connection targets the bootstrapping environment's proxy
// origin (the page origin for the primary environment): the Code Work server
// proxies `/api/ide/{capability}/*` to the per-session REH process and injects
// the auth token server-side, so the browser never sees a credential.
//
// The authority also names the remote in every `vscode-remote://` URI, and
// workspace storage/backup keys derive from those URIs — two environments
// exposing the same directory must therefore not share one authority. The
// module value is only the pre-bootstrap default; doBootstrap re-derives it
// from the environment being mounted.
let remoteAuthority = window.location.host;

/**
 * `BrowserSocketFactory` builds `ws(s)://{host}:{port}/ws?...` for the
 * management channel. We redirect the `/ws` path into the capability-scoped
 * proxy prefix while keeping the exact byte framing the remote protocol
 * expects (binary frames, no subprotocol).
 */
class ProxyWebSocket {
  private readonly socket: WebSocket;
  private readonly dataEmitter = createSimpleEmitter<unknown>();
  private readonly openEmitter = createSimpleEmitter<unknown>();
  private readonly closeEmitter = createSimpleEmitter<unknown>();
  private readonly errorEmitter = createSimpleEmitter<unknown>();

  constructor(url: string, capabilityBase: string, proxyOrigin: string) {
    const parsed = new URL(url);
    // For a non-primary environment the capability lives on the remote
    // server's own proxy, not under the page's origin.
    const base = new URL(proxyOrigin);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    parsed.pathname = `${capabilityBase}${parsed.pathname}`;
    this.socket = new WebSocket(parsed.toString());
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", (e) => this.openEmitter.fire(e));
    this.socket.addEventListener("close", (e) => {
      ideSocketCloseEmitter.fire(e.code);
      this.closeEmitter.fire(e);
    });
    this.socket.addEventListener("error", (e) => this.errorEmitter.fire(e));
    this.socket.addEventListener("message", (e) => {
      this.dataEmitter.fire(e.data);
    });
  }

  send(data: ArrayBuffer | ArrayBufferView) {
    this.socket.send(data as ArrayBuffer);
  }

  close() {
    this.socket.close();
  }

  dispose() {
    this.socket.close();
  }

  onData = (listener: (data: unknown) => void) => this.dataEmitter.event(listener);
  onOpen = (listener: (e: unknown) => void) => this.openEmitter.event(listener);
  onClose = (listener: (e: unknown) => void) => this.closeEmitter.event(listener);
  onError = (listener: (e: unknown) => void) => this.errorEmitter.event(listener);
}

interface SimpleEmitter<T> {
  fire(data: T): void;
  event(listener: (data: T) => void): { dispose(): void };
}

function createSimpleEmitter<T>(): SimpleEmitter<T> {
  const listeners = new Set<(data: T) => void>();
  return {
    fire(data) {
      for (const listener of [...listeners]) listener(data);
    },
    event(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };
}

// Abnormal closes on any IDE-channel socket are the earliest signal that the
// session behind the capability died; the session watchdog probes server
// state on them instead of waiting for its periodic sweep.
const ideSocketCloseEmitter = createSimpleEmitter<number>();

export function onIdeSocketClose(listener: (code: number) => void): { dispose(): void } {
  return ideSocketCloseEmitter.event(listener);
}

// The monaco-vscode service container lives for the whole page, so the
// bootstrap promise must outlive HMR module reloads too — a second
// `initialize()` on the same page throws "Services are already initialized".
const bootstrapKey = "__codeworkIdeBootstrap";
const globals = globalThis as Record<string, unknown>;

let bootstrapPromise: Promise<VscodeIdeRuntime> | null =
  (globals[bootstrapKey] as Promise<VscodeIdeRuntime> | undefined) ?? null;

export interface VscodeIdeRuntime {
  remoteAuthority: string;
  /** The capability prefix this page's sockets and proxies are bound to. */
  capabilityBase: string;
}

export interface VscodeIdeBootstrapOptions {
  /** Proxy prefix for this IDE session, e.g. `/api/ide/{capability}`. */
  capabilityBase: string;
  /** Host product identity — must match the REH server for the handshake. */
  product: Pick<IdeConnectionInfo, "commit" | "version" | "quality">;
  /** Server-canonical remote path of the project folder, e.g. `/C:/repo`. */
  folderPath: string;
  /**
   * Origin whose `/api/ide` proxy serves this session. Equals the page origin
   * for the primary environment; a non-primary environment's proxy lives on
   * the remote server itself.
   */
  proxyOrigin: string;
  onThemeSelected: (theme: ThemeDefinition) => void;
  onThemeSyncError: (error: unknown) => void;
}

export async function bootstrapVscodeIde(
  options: VscodeIdeBootstrapOptions,
): Promise<VscodeIdeRuntime> {
  bootstrapPromise ??= doBootstrap(options);
  globals[bootstrapKey] = bootstrapPromise;
  return bootstrapPromise;
}

async function doBootstrap(options: VscodeIdeBootstrapOptions): Promise<VscodeIdeRuntime> {
  window.MonacoEnvironment = {
    getWorker(_moduleId, label) {
      switch (label) {
        case "editorWorkerService":
          return new editorWorker();
        case "TextMateWorker":
          return new textmateWorker();
        case "OutputLinkDetectionWorker":
          return new outputLinkWorker();
        case "extensionHostWorkerMain":
          return new extensionHostWorker();
        case "LocalFileSearchWorker":
          return new localFileSearchWorker();
        default:
          throw new Error(`Unknown VS Code worker: ${label}`);
      }
    },
    // The web worker extension host spawns its worker inside a same-origin
    // iframe and can only accept a URL there (never a Worker instance), so
    // the in-page `vscode` API needs this bundled entry URL plus module
    // worker options.
    getWorkerUrl(_moduleId: string, label: string) {
      if (label === "extensionHostWorkerMain") return extensionHostWorkerUrl;
      return undefined;
    },
    getWorkerOptions(_moduleId: string, label: string) {
      if (label === "extensionHostWorkerMain") return { type: "module" as const };
      return undefined;
    },
  };

  // The REH validates the first protocol message against its
  // --connection-token-file, whose content is this session's capability.
  // monaco-vscode-api falls back to a zero-filled token when this is unset,
  // and the REH then refuses every connection with "auth mismatch".
  const connectionToken = /^\/api\/ide\/([a-f0-9]{64})/.exec(options.capabilityBase)?.[1];

  // Workspace identity follows the environment's own origin, not the page's:
  // a reload re-runs this with the next environment before any URI escapes.
  remoteAuthority = new URL(options.proxyOrigin).host;

  const folderUri = URI.from({
    scheme: "vscode-remote",
    authority: remoteAuthority,
    path: options.folderPath,
  });
  // 嵌入里上游 hot exit 的备份服务是 no-op、调度 tracker 缺失（见 hotExitBackup.ts）。
  // 数据面先于 initialize 注册进服务集合，按工作区身份分键。
  const hotExit = new HotExitBackupService(createIndexedDbBackupStore(), folderUri.toString());

  await initialize(
    {
      ...getBaseServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getFilesServiceOverride(),
      ...getHostServiceOverride(),
      ...getLayoutServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getLogServiceOverride(),
      ...getStorageServiceOverride(),
      ...getSecretStorageServiceOverride(),
      ...getUserDataProfileServiceOverride(),
      ...getAuthenticationServiceOverride(),
      ...getAccessibilityServiceOverride(),

      ...getConfigurationServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getThemeServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getModelServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getSnippetsServiceOverride(),

      ...getExtensionsServiceOverride({ enableWorkerExtensionHost: true }),
      ...getExtensionGalleryServiceOverride({ webOnly: false }),
      ...getRemoteAgentServiceOverride({ scanRemoteExtensions: true }),

      ...getViewsServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: isEditorPartVisible,
        shouldUseGlobalPicker: (_editor, isStandalone) => !isStandalone && isEditorPartVisible(),
      }),
      ...getNotificationsServiceOverride(),
      ...getDialogsServiceOverride(),

      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getScmServiceOverride(),
      ...getTerminalServiceOverride(),
      ...getOutputServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getDebugServiceOverride(),
      ...getTaskServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getOutlineServiceOverride(),
      ...getTimelineServiceOverride(),
      ...getCommentsServiceOverride(),
      ...getMultiDiffEditorServiceOverride(),
      ...getWorkspaceTrustServiceOverride(),
      ...getViewStatusBarServiceOverride(),
      ...getViewTitleBarServiceOverride(),

      // 覆盖 missing-services 注册的 no-op 备份单例（hot exit 数据面）。
      [IWorkingCopyBackupService.toString()]: hotExit,
    },
    document.body,
    {
      remoteAuthority,
      ...(connectionToken === undefined ? {} : { connectionToken }),
      enableWorkspaceTrust: false,
      // The connection token is injected by the server-side proxy; the
      // browser only ever knows the opaque capability path prefix.
      webSocketFactory: {
        create(url: string, _debugLabel?: string) {
          return new ProxyWebSocket(url, options.capabilityBase, options.proxyOrigin);
        },
      } as never,
      productConfiguration: {
        nameShort: "Code Work",
        nameLong: "Code Work",
        version: options.product.version,
        commit: options.product.commit,
        quality: options.product.quality,
        extensionsGallery: {
          serviceUrl: "https://open-vsx.org/vscode/gallery",
          resourceUrlTemplate:
            "https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/README.md",
          extensionUrlTemplate:
            "https://open-vsx.org/vscode/extension/{publisher}/{name}/{version}/file/{fileName}",
          controlUrl: "",
          nlsBaseUrl: "",
        },
        embedderIdentifier: "codework",
        // Workbench 按此表决定扩展跑本地 worker 宿主还是远程 Node 宿主。TS
        // 扩展在浏览器装配里没有 tsserver 库，强制走远程宿主——REH 安装层
        // 在 `extensions/node_modules/typescript` 供库（codeossInstall.ts）。
        extensionKind: {
          "vscode.typescript-language-features": ["workspace"],
        },
      },
      configurationDefaults: {
        // The workbench follows the Code Work app appearance; this only picks
        // the theme it boots with before the first sync. Values are theme
        // *settings ids* ("Dark Modern"), not display labels.
        "workbench.colorTheme": document.documentElement.classList.contains("dark")
          ? "Dark Modern"
          : "Light Modern",
        "workbench.startupEditor": "none",
        "update.mode": "none",
        "extensions.autoCheckUpdates": false,
        "extensions.autoUpdate": false,
        "telemetry.telemetryLevel": "off",
      },
      developmentOptions: { logLevel: LogLevel.Warning },
      // 主题配置、图标字体与图片统一走当前 IDE 会话的授权资源代理。
      resourceUriProvider: (uri: URI) =>
        workbenchResourceUri(uri, options.capabilityBase, options.proxyOrigin),
      workspaceProvider: {
        trusted: true,
        // The initial workspace decides what the Explorer, search and language
        // services resolve against. `IWorkspaceEditingService.updateFolders`
        // is a missing-service stub in monaco-vscode-api, so the folder can
        // only be set here, once per page load.
        workspace: {
          folderUri,
        },
        async open(workspace: { folderUri?: URI; workspaceUri?: URI } | undefined) {
          // VS Code routes "Open Folder" and workspace edits through the
          // provider. Upstream's browser flow would navigate the page; we
          // re-enter the workspace service in document instead so chat and
          // IDE keep sharing one live page.
          if (workspace?.folderUri) await switchRemoteWorkspace(workspace.folderUri);
          return true;
        },
      },
    },
  );

  // 与工作台单例同寿命：切回对话或进入设置页后，主题同步仍然有效。
  await initializeThemeSync(options).catch(options.onThemeSyncError);

  // hot exit 调度面：接上工作副本服务的脏状态事件；卸载前补写一次在途脏内容。
  hotExit.attach(await getService(IWorkingCopyService));
  window.addEventListener("pagehide", () => void hotExit.flushDirty());
  return { remoteAuthority, capabilityBase: options.capabilityBase };
}

/** `C:\repo\sub` → `/C:/repo/sub`, the path form the REH server expects. */
function remoteFolderPath(cwd: string): string {
  return URI.file(cwd).path;
}

function decodeRemotePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Project paths are recorded case-insensitively on Windows, so the folder URI
 * the workbench resolves (`/c%3A/users/…`) can differ in case and encoding
 * from the cwd-derived root (`/C:/Users/…`). Compare decoded and
 * case-insensitively; the returned relative path keeps its real casing.
 */
function relativeToRemoteRoot(path: string, root: string): string | null {
  const decoded = decodeRemotePath(path);
  const normalizedRoot = decodeRemotePath(root).replace(/\/$/, "");
  if (!decoded.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)) return null;
  return decoded.slice(normalizedRoot.length + 1);
}

/**
 * Point the (single-folder) remote workspace at a project directory without
 * reloading the document. This is what keeps chat and IDE mode — and IDE
 * project switches — sharing one live workbench instance. `folderPath` is
 * the server-canonical remote path (e.g. `/C:/repo`).
 *
 * Upstream's `IWorkspaceEditingService` enters a new workspace by creating an
 * untitled workspace file and letting the provider navigate; with no page
 * navigation available, the supported re-entry point is the workspace
 * service's own `initialize`, which rebuilds the workspace in place and
 * fires the workbench-state / folder-change events the Explorer, search and
 * SCM views listen to.
 */
export async function setRemoteWorkspaceFolder(folderPath: string): Promise<void> {
  await switchRemoteWorkspace(
    URI.from({
      scheme: "vscode-remote",
      authority: remoteAuthority,
      path: folderPath,
    }),
  );
}

interface WorkspaceServiceShape {
  getWorkspace(): { folders: Array<{ uri: URI }> };
  initialize(arg: { id: string; uri: URI }): Promise<void>;
}

async function switchRemoteWorkspace(folderUri: URI): Promise<void> {
  const contextService = (await getService(
    IWorkspaceContextService,
  )) as never as WorkspaceServiceShape;
  const folders = contextService.getWorkspace().folders;
  if (folders.length === 1 && folders[0]?.uri.toString() === folderUri.toString()) return;
  await contextService.initialize({ id: singleFolderWorkspaceId(folderUri), uri: folderUri });
}

/** Stable per-folder workspace id; VS Code only needs it to be repeatable. */
function singleFolderWorkspaceId(uri: URI): string {
  const key = uri.toString();
  let hash = 5381;
  for (let index = 0; index < key.length; index++)
    hash = ((hash << 5) + hash + key.charCodeAt(index)) >>> 0;
  return `codework-${hash.toString(16)}`;
}

// Devtools handle for diagnosing the embedded workbench (read-only except the
// explicit folder switch); costs nothing at runtime.
declare global {
  interface Window {
    __codeworkIde?: {
      state(): Promise<{ workbenchState: number; folders: string[] }>;
      openFolder(path: string): Promise<void>;
      readRemoteFile(
        path: string,
      ): Promise<{ byteLength: number; headHex: string; headText: string }>;
    };
  }
}

Object.assign(window, {
  __codeworkIde: {
    async readRemoteFile(path: string) {
      const files = await getService(IFileService);
      const content = await files.readFile(
        URI.from({ scheme: "vscode-remote", authority: remoteAuthority, path }),
      );
      // VSBuffer.buffer is the Uint8Array view itself; copy it as-is.
      const bytes = new Uint8Array(content.value.buffer);
      const head = bytes.subarray(0, 64);
      return {
        byteLength: bytes.byteLength,
        headHex: [...head].map((b) => b.toString(16).padStart(2, "0")).join(" "),
        headText: new TextDecoder().decode(head),
      };
    },
    async state() {
      const contextService = (await getService(
        IWorkspaceContextService,
      )) as never as WorkspaceServiceShape & {
        getWorkbenchState(): number;
      };
      return {
        workbenchState: contextService.getWorkbenchState(),
        folders: contextService.getWorkspace().folders.map((folder) => folder.uri.toString()),
      };
    },
    openFolder: (path: string) => setRemoteWorkspaceFolder(path),
    async themes() {
      const themes = await getService(IWorkbenchThemeService);
      return { current: themes.getColorTheme().settingsId };
    },
  },
});

/**
 * Subscribe to selection changes of every in-document code editor. This goes
 * through the document's own `ICodeEditorService` rather than the `vscode`
 * API proxy, which only comes up once the web worker extension host is fully
 * started; selections must work even when that host is unavailable.
 * `cwd` filters events to the active project; returns an unsubscriber.
 */
export async function trackActiveEditorSelection(
  cwd: string,
  onSelection: (selection: IdeCodeSelectionShape) => void,
): Promise<() => void> {
  const root = remoteFolderPath(cwd).replace(/\/$/, "");
  const service = (await getService(ICodeEditorService)) as never as CodeEditorServiceShape;
  const disposables: Array<{ dispose(): void }> = [];
  const tracked = new Set<TrackedCodeEditor>();
  const attach = (editor: TrackedCodeEditor | null | undefined) => {
    if (!editor || tracked.has(editor)) return;
    tracked.add(editor);
    disposables.push(
      editor.onDidChangeCursorSelection(() => {
        const selection = selectionFromEditor(root, editor);
        if (selection) onSelection(selection);
      }),
    );
  };
  for (const editor of service.listCodeEditors()) attach(editor);
  disposables.push(service.onCodeEditorAdd((editor) => attach(editor)));
  return () => {
    for (const disposable of disposables) disposable.dispose();
    disposables.length = 0;
    tracked.clear();
  };
}

interface SelectionShape {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface TrackedCodeEditor {
  onDidChangeCursorSelection(listener: () => void): { dispose(): void };
  getSelection(): SelectionShape | null;
  getModel(): {
    uri: URI;
    getLanguageId(): string;
    getValueInRange(range: SelectionShape): string;
  } | null;
}

interface CodeEditorServiceShape {
  listCodeEditors(): TrackedCodeEditor[];
  onCodeEditorAdd(listener: (editor: TrackedCodeEditor) => void): { dispose(): void };
}

function selectionFromEditor(
  root: string,
  editor: TrackedCodeEditor,
): IdeCodeSelectionShape | null {
  const selection = editor.getSelection();
  const model = editor.getModel();
  // `Selection` inherits `isEmpty()` as a method from `Range`; treat it as a
  // property and every selection looks empty.
  const collapsed =
    selection == null ||
    (selection.startLineNumber === selection.endLineNumber &&
      selection.startColumn === selection.endColumn);
  if (collapsed || !model) return null;
  const relativePath = relativeToRemoteRoot(model.uri.path, root);
  if (!relativePath) return null;
  const text = model.getValueInRange(selection);
  if (!text || text.length > 200_000) return null;
  return {
    filePath: relativePath,
    text,
    language: model.getLanguageId(),
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
  };
}

interface IdeCodeSelectionShape {
  filePath: string;
  text: string;
  language: string;
  startLine: number;
  endLine: number;
}

/**
 * The folder URI files should be opened against. Prefers the live workspace
 * folder (the exact identity the Explorer and language services use, which
 * may differ from the cwd in case or encoding) when it points at the project;
 * falls back to deriving from `cwd` before the runtime is up.
 */
async function remoteRootUri(cwd: string): Promise<URI> {
  try {
    const contextService = (await getService(
      IWorkspaceContextService,
    )) as never as WorkspaceServiceShape;
    const folder = contextService.getWorkspace().folders[0]?.uri;
    const root = remoteFolderPath(cwd);
    if (
      folder &&
      folder.scheme === "vscode-remote" &&
      decodeRemotePath(folder.path).replace(/\/$/, "").toLowerCase() === root.toLowerCase()
    ) {
      return folder;
    }
  } catch {
    // Workspace runtime not up yet; the derived URI is the best guess.
  }
  return URI.from({
    scheme: "vscode-remote",
    authority: remoteAuthority,
    path: remoteFolderPath(cwd),
  });
}

/**
 * Reveal a project file (optionally at a line) in the workbench editor area.
 * Used by file mentions and AI-message jump links.
 */
export async function revealRemoteFile(
  cwd: string,
  relativePath: string,
  line?: number | null,
): Promise<void> {
  const base = await remoteRootUri(cwd);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\//, "");
  const uri = base.with({ path: `${base.path.replace(/\/$/, "")}/${normalized}` });
  // The workbench-side "vscode.open" registration forwards only the URI and
  // drops trailing options (extension hosts repack them onto _workbench.open),
  // so open through the editor service to keep the line selection.
  const editorService = await getService(IEditorService);
  await editorService.openEditor(
    line != null && line > 0
      ? {
          resource: uri,
          options: {
            selection: {
              startLineNumber: line,
              startColumn: 1,
              endLineNumber: line,
              endColumn: 1,
            },
          },
        }
      : { resource: uri },
  );
}

/** Run a workbench command id (e.g. `workbench.view.scm`) if the runtime is up. */
export async function executeWorkbenchCommand(commandId: string): Promise<void> {
  const commands = await getService(ICommandService);
  await commands.executeCommand(commandId);
}

async function initializeThemeSync(options: VscodeIdeBootstrapOptions): Promise<void> {
  // 默认主题由扩展贡献；冷启动先等注册完成，避免空清单让整条主题同步失效。
  await (await getService(IExtensionService)).whenInstalledExtensionsRegistered();
  const themes = await getService(IWorkbenchThemeService);
  const configuration = await getService(IConfigurationService);
  const loader = await getService(IExtensionResourceLoaderService);
  const available = await themes.getColorThemes();
  const definitions = await Promise.all(
    (["light", "dark"] as const).map(async (appearance) => {
      const seed = available.find(
        (theme) => theme.settingsId === (appearance === "dark" ? "Dark Modern" : "Light Modern"),
      );
      if (!(seed instanceof ColorThemeData)) throw new Error("IDE 默认主题不可用");
      await seed.ensureLoaded(loader);
      return { appearance, tokens: seed.tokenColors };
    }),
  );
  // 专用主题承载应用配色，不改写用户安装的主题；沿用上游默认代码高亮规则。
  const extension = registerExtension(
    {
      name: "app-color-themes",
      publisher: "codework",
      version: "1.0.0",
      engines: { vscode: "*" },
      contributes: {
        themes: definitions.map(({ appearance }) => ({
          id: APP_WORKBENCH_THEMES[appearance],
          label: APP_WORKBENCH_THEMES[appearance],
          uiTheme: appearance === "dark" ? "vs-dark" : "vs",
          path: `themes/${appearance}.json`,
        })),
      },
    },
    ExtensionHostKind.LocalProcess,
    { system: true },
  );
  for (const { appearance, tokens } of definitions) {
    extension.registerFileUrl(`themes/${appearance}.json`, workbenchThemeDataUrl(tokens));
  }
  await extension.whenReady();
  await startWorkbenchThemeSync(
    themes,
    configuration,
    options.onThemeSelected,
    options.onThemeSyncError,
    await getService(ITerminalService),
  );
}

/**
 * Force a workbench part to a concrete pixel size. Upstream sizes parts once
 * (at a 9999px placeholder) inside a hidden container and relies on its own
 * resize observers afterwards, which can miss the move into the host grid
 * and leave a part stuck at the placeholder size.
 */
export async function relayoutWorkbenchPart(
  part: Parts,
  width: number,
  height: number,
): Promise<void> {
  if (width <= 0 || height <= 0) return;
  const layoutService = (await getService(IWorkbenchLayoutService)) as never as {
    getPart(part: Parts): { layout(width: number, height: number): void } | null;
  };
  layoutService.getPart(part)?.layout(width, height);
}
