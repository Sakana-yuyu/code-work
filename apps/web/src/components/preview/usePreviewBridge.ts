"use client";

import type {
  DesktopPreviewTabState,
  PreviewAnnotationRemoteResult,
  PreviewAnnotationSubmissionResult,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@codework/contracts";
import { PREVIEW_SCREENSHOT_DATA_URL_MAX_LENGTH } from "@codework/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@codework/client-runtime/environment";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useMemo, useRef } from "react";

import {
  flushPendingFaviconsForThread,
  recordFaviconForThread,
  useFaviconProjectRefForThread,
} from "~/browserFaviconStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import {
  applyPreviewDesktopState,
  type DesktopPreviewOverlay,
  useThreadPreviewState,
} from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { readLocalApi } from "~/localApi";

import { previewBridge } from "./previewBridge";

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Mirrors low-latency desktop state into the store and reflects navigation
 * events back to the server. Webview lifetime is owned by ElectronBrowserHost.
 */
export function usePreviewBridge(input: {
  threadRef: ScopedThreadRef;
  tabId: string;
  runtimeTabId: string;
}): void {
  const { threadRef, tabId, runtimeTabId } = input;
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear);
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const reportRecording = useAtomCommand(
    previewEnvironment.reportRecording,
    "preview recording report",
  );
  const reportAnnotation = useAtomCommand(
    previewEnvironment.reportAnnotation,
    "preview annotation report",
  );
  const reportScreenshot = useAtomCommand(
    previewEnvironment.reportScreenshot,
    "preview screenshot report",
  );
  const bridge = previewBridge;
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const recording = activeRecordingTabIds.has(runtimeTabId);
  const previewState = useThreadPreviewState(threadRef);
  const serverSnapshot = previewState.sessions[tabId] ?? null;
  const serverNavigationUrl =
    serverSnapshot?.navStatus._tag === "Idle" ? null : (serverSnapshot?.navStatus.url ?? null);
  const serverRefreshRevision = previewState.refreshRevisionByTabId[tabId] ?? 0;
  const serverControl = previewState.controlByTabId[tabId] ?? null;
  const threadKey = scopedThreadKey(threadRef);
  const stableThreadRef = useMemo(() => {
    const parsed = parseScopedThreadKey(threadKey);
    if (!parsed) throw new Error(`Invalid scoped thread key: ${threadKey}`);
    return parsed;
  }, [threadKey]);
  const projectRef = useFaviconProjectRefForThread(stableThreadRef);
  const preparedConnection = usePreparedConnection(stableThreadRef.environmentId);
  const environmentHostname = Option.isSome(preparedConnection)
    ? new URL(preparedConnection.value.httpBaseUrl).hostname
    : undefined;

  // One bridge subscription does both jobs (mirror state + forward to
  // server) so the desktop bridge keeps a single listener entry per tab.
  const lastReportedUrl = useRef<string | null>(null);
  const lastReportedKind = useRef<DesktopPreviewTabState["navStatus"]["kind"] | null>(null);
  const lastReportedPresentation = useRef<string | null>(null);
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState["navStatus"] | null>(null);
  const lastNativeUrl = useRef<string | null>(null);
  const lastAppliedServerUrl = useRef<string | null | undefined>(undefined);
  const lastAppliedRefreshRevision = useRef(0);
  const lastAppliedRefreshTabId = useRef<string | null>(null);
  const lastAppliedControlRevision = useRef(0);
  const lastAppliedControlTabId = useRef<string | null>(null);
  const lastReportedRecording = useRef<boolean | null>(null);
  const handleStateChange = useEffectEvent(
    (changedTabId: string, state: DesktopPreviewTabState): void => {
      if (changedTabId !== runtimeTabId) return;
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus)) {
        clearBrowserPointer(runtimeTabId);
      }
      lastDesktopNavStatus.current = state.navStatus;
      lastNativeUrl.current = state.navStatus.kind === "Idle" ? null : state.navStatus.url;
      applyPreviewDesktopState(stableThreadRef, tabId, projectDesktopState(state));
      if (state.favicon) {
        recordFaviconForThread(stableThreadRef, state.favicon, projectRef, environmentHostname);
      }
      const reported = buildReportInput({
        threadId: stableThreadRef.threadId,
        tabId,
        state,
        lastReportedUrl: lastReportedUrl.current,
        lastReportedKind: lastReportedKind.current,
        lastReportedPresentation: lastReportedPresentation.current,
      });
      if (!reported) return;
      lastReportedUrl.current = reported.lastReportedUrl;
      lastReportedKind.current = reported.lastReportedKind;
      lastReportedPresentation.current = reported.lastReportedPresentation;
      void reportStatus({
        environmentId: stableThreadRef.environmentId,
        input: reported.input,
      });
    },
  );
  useEffect(() => {
    if (!bridge || typeof window === "undefined") return;
    lastReportedUrl.current = null;
    lastReportedKind.current = null;
    lastReportedPresentation.current = null;
    lastDesktopNavStatus.current = null;
    lastReportedRecording.current = null;
    return bridge.onStateChange(handleStateChange);
  }, [bridge, runtimeTabId, stableThreadRef, tabId]);
  useEffect(() => {
    if (!bridge) {
      lastReportedRecording.current = null;
      return;
    }
    if (lastReportedRecording.current === recording) return;
    lastReportedRecording.current = recording;
    void reportRecording({
      environmentId: stableThreadRef.environmentId,
      input: {
        threadId: stableThreadRef.threadId,
        tabId,
        recording,
      },
    });
  }, [bridge, recording, reportRecording, stableThreadRef, tabId]);
  useEffect(() => {
    if (!bridge) return;
    if (lastAppliedServerUrl.current === undefined) {
      lastAppliedServerUrl.current = serverNavigationUrl;
      return;
    }
    if (lastAppliedServerUrl.current === serverNavigationUrl) return;
    lastAppliedServerUrl.current = serverNavigationUrl;
    if (serverNavigationUrl === null || lastNativeUrl.current === serverNavigationUrl) return;
    void bridge.navigate(runtimeTabId, serverNavigationUrl).catch(() => undefined);
  }, [bridge, runtimeTabId, serverNavigationUrl]);
  useEffect(() => {
    if (!bridge) return;
    if (lastAppliedRefreshTabId.current !== runtimeTabId) {
      lastAppliedRefreshTabId.current = runtimeTabId;
      lastAppliedRefreshRevision.current = serverRefreshRevision;
      return;
    }
    if (serverRefreshRevision <= lastAppliedRefreshRevision.current) return;
    lastAppliedRefreshRevision.current = serverRefreshRevision;
    void bridge.refresh(runtimeTabId).catch(() => undefined);
  }, [bridge, runtimeTabId, serverRefreshRevision]);
  useEffect(() => {
    if (!bridge) return;
    if (lastAppliedControlTabId.current !== runtimeTabId) {
      lastAppliedControlTabId.current = runtimeTabId;
      lastAppliedControlRevision.current = serverControl?.revision ?? 0;
      return;
    }
    if (serverControl === null || serverControl.revision <= lastAppliedControlRevision.current) {
      return;
    }
    lastAppliedControlRevision.current = serverControl.revision;
    const operation = (() => {
      switch (serverControl.control) {
        case "back":
          return bridge.goBack(runtimeTabId);
        case "forward":
          return bridge.goForward(runtimeTabId);
        case "hardReload":
          return bridge.hardReload(runtimeTabId);
        case "openDevTools":
          return bridge.openDevTools(runtimeTabId);
        case "zoomIn":
          return bridge.zoomIn(runtimeTabId);
        case "zoomOut":
          return bridge.zoomOut(runtimeTabId);
        case "resetZoom":
          return bridge.resetZoom(runtimeTabId);
        case "startRecording":
          return startBrowserRecording(runtimeTabId, stableThreadRef, tabId);
        case "stopRecording":
          return stopBrowserRecording(runtimeTabId);
        case "pickElement":
          return bridge.pickElement(runtimeTabId).then((result) => {
            if (result === null) return;
            return reportAnnotation({
              environmentId: stableThreadRef.environmentId,
              input: {
                threadId: stableThreadRef.threadId,
                tabId,
                annotation: toRemoteAnnotation(result),
              },
            });
          });
        case "cancelPickElement":
          return bridge.cancelPickElement(runtimeTabId);
        case "openInSystemBrowser":
          return serverControl.url === undefined
            ? Promise.resolve()
            : (readLocalApi()?.shell.openExternal(serverControl.url) ?? Promise.resolve());
        case "click":
          return serverControl.x === undefined || serverControl.y === undefined
            ? Promise.resolve()
            : bridge.automation.click(runtimeTabId, {
                x: serverControl.x,
                y: serverControl.y,
              });
        case "type":
          return serverControl.text === undefined
            ? Promise.resolve()
            : bridge.automation.type(runtimeTabId, { text: serverControl.text });
        case "press":
          return serverControl.key === undefined
            ? Promise.resolve()
            : bridge.automation.press(runtimeTabId, { key: serverControl.key });
        case "scroll":
          return serverControl.deltaX === undefined && serverControl.deltaY === undefined
            ? Promise.resolve()
            : bridge.automation.scroll(runtimeTabId, {
                ...(serverControl.deltaX === undefined ? {} : { deltaX: serverControl.deltaX }),
                ...(serverControl.deltaY === undefined ? {} : { deltaY: serverControl.deltaY }),
              });
        case "captureScreenshot":
          return bridge.captureScreenshot(runtimeTabId).then((artifact) => {
            if (artifact.dataUrl === undefined) return;
            return reportScreenshot({
              environmentId: stableThreadRef.environmentId,
              input: {
                threadId: stableThreadRef.threadId,
                tabId,
                artifactId: artifact.id,
                dataUrl: artifact.dataUrl,
                ...(artifact.width === undefined ? {} : { width: artifact.width }),
                ...(artifact.height === undefined ? {} : { height: artifact.height }),
              },
            });
          });
        case "setColorScheme":
          return serverControl.colorScheme === undefined
            ? Promise.resolve()
            : bridge.setColorScheme(runtimeTabId, serverControl.colorScheme);
        case "setAudioMuted":
          return serverControl.audioMuted === undefined
            ? Promise.resolve()
            : bridge.setAudioMuted(runtimeTabId, serverControl.audioMuted);
        case "openPictureInPicture":
          return bridge.pictureInPicture.open(runtimeTabId);
        case "closePictureInPicture":
          return bridge.pictureInPicture.close(runtimeTabId);
        case "clearCookies":
          return bridge.clearCookies();
        case "clearCache":
          return bridge.clearCache();
      }
    })();
    void operation.catch(() => undefined);
  }, [
    bridge,
    reportAnnotation,
    reportScreenshot,
    runtimeTabId,
    serverControl,
    stableThreadRef,
    tabId,
  ]);
  useEffect(() => {
    if (!projectRef) return;
    flushPendingFaviconsForThread(stableThreadRef, projectRef, environmentHostname);
  }, [environmentHostname, projectRef, stableThreadRef]);
}

function shouldClearBrowserPointer(
  previous: DesktopPreviewTabState["navStatus"] | null,
  current: DesktopPreviewTabState["navStatus"],
): boolean {
  if (!previous) return false;
  if (current.kind === "Loading" && previous.kind !== "Loading") return true;
  if (current.kind === "Idle" || previous.kind === "Idle") return false;
  return current.url !== previous.url;
}

export function toRemoteAnnotation(
  result: PreviewAnnotationSubmissionResult,
): PreviewAnnotationRemoteResult {
  const { annotation, submission } = result;
  const screenshot =
    annotation.screenshot &&
    annotation.screenshot.dataUrl.length <= PREVIEW_SCREENSHOT_DATA_URL_MAX_LENGTH
      ? {
          dataUrl: annotation.screenshot.dataUrl,
          width: annotation.screenshot.width,
          height: annotation.screenshot.height,
        }
      : null;
  return {
    annotationId: annotation.id.slice(0, 256),
    pageUrl: annotation.pageUrl.slice(0, 2_048),
    pageTitle: annotation.pageTitle?.slice(0, 512) ?? null,
    comment: annotation.comment.slice(0, 4_096),
    elements: annotation.elements.slice(0, 20).map(({ id, element }) => ({
      id: id.slice(0, 128),
      tagName: element.tagName.trim().slice(0, 64) || "element",
      selector: element.selector?.slice(0, 2_048) ?? null,
      componentName: element.componentName?.slice(0, 256) ?? null,
      htmlPreview: element.htmlPreview.slice(0, 4_096),
    })),
    regionCount: annotation.regions.length,
    strokeCount: annotation.strokes.length,
    screenshot,
    submission,
  };
}

export function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  const navOrigin = state.navStatus.kind === "Idle" ? null : originOf(state.navStatus.url);
  return {
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
    controller: state.controller,
    favicon: state.favicon && originOf(state.favicon.pageUrl) === navOrigin ? state.favicon : null,
  };
}

/**
 * Decide whether a state change warrants an RPC to the server, and shape
 * the report payload.
 *
 * - Idle never reports — the tab is post-close or pre-load and the server
 *   already knows the canonical state from `open` / `closed`.
 * - We dedupe on (kind, url): consecutive Loading→Loading→Loading for the
 *   same URL collapses to a single RPC, ditto Success.
 * - LoadFailed always reports (the server uses it to emit `failed`).
 */
function buildReportInput(args: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
  readonly lastReportedUrl: string | null;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"] | null;
  readonly lastReportedPresentation: string | null;
}): {
  readonly input: PreviewReportStatusInput;
  readonly lastReportedUrl: string;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"];
  readonly lastReportedPresentation: string;
} | null {
  const { threadId, tabId, state, lastReportedUrl, lastReportedKind, lastReportedPresentation } =
    args;
  const status = state.navStatus;
  if (status.kind === "Idle") return null;

  const presentation = JSON.stringify([
    state.canGoBack,
    state.canGoForward,
    state.zoomFactor,
    state.pictureInPicture,
    state.colorScheme,
    state.audioMuted,
    state.audible,
  ]);
  // Skip if we've already reported the same navigation and desktop chrome.
  // LoadFailed always reports (rapid duplicate failures are unusual and worth
  // surfacing).
  const sameAsLast =
    status.kind !== "LoadFailed" &&
    status.kind === lastReportedKind &&
    status.url === lastReportedUrl &&
    presentation === lastReportedPresentation;
  if (sameAsLast) return null;

  const base = {
    threadId,
    tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    audioMuted: state.audioMuted,
    audible: state.audible,
  };
  if (status.kind === "LoadFailed") {
    return {
      input: {
        ...base,
        navStatus: {
          _tag: "LoadFailed",
          url: status.url,
          title: status.title,
          code: status.code,
          description: status.description,
        },
      },
      lastReportedUrl: status.url,
      lastReportedKind: "LoadFailed",
      lastReportedPresentation: presentation,
    };
  }
  return {
    input: {
      ...base,
      navStatus: { _tag: status.kind, url: status.url, title: status.title },
    },
    lastReportedUrl: status.url,
    lastReportedKind: status.kind,
    lastReportedPresentation: presentation,
  };
}
