/**
 * Preview - Schemas for the in-app browser preview surface.
 *
 * The preview is desktop-only (Chromium <webview>); the server tracks per-thread
 * tab metadata so it survives client reconnects and multi-window. The desktop
 * renderer mediates: it owns the actual <webview> and reports navigation back to
 * the server via these RPCs, the server fans events to all subscribers.
 *
 * @module Preview
 */
import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PREVIEW_URL_MAX_LENGTH = 2_048;
export const PREVIEW_SCREENSHOT_DATA_URL_MAX_LENGTH = 16 * 1024 * 1024;
export const CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS = 32;

const Url = TrimmedNonEmptyString.check(Schema.isMaxLength(PREVIEW_URL_MAX_LENGTH));
const ScreenshotDataUrl = Schema.String.check(
  Schema.isMaxLength(PREVIEW_SCREENSHOT_DATA_URL_MAX_LENGTH),
  Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
);

export const ConfiguredLocalServerUrls = Schema.Array(Url).check(
  Schema.isMaxLength(CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS),
);
const Title = Schema.String.check(Schema.isMaxLength(512));

export const PreviewTabId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewTabId = typeof PreviewTabId.Type;

export const PREVIEW_VIEWPORT_MIN_DIMENSION = 240;
export const PREVIEW_VIEWPORT_MAX_DIMENSION = 3840;
export const PREVIEW_VIEWPORT_MAX_AREA = 3840 * 2160;

const PreviewViewportDimension = Schema.Int.check(
  Schema.isBetween({
    minimum: PREVIEW_VIEWPORT_MIN_DIMENSION,
    maximum: PREVIEW_VIEWPORT_MAX_DIMENSION,
  }),
);

const viewportAreaFilter = Schema.makeFilter(
  ({ width, height }: { readonly width: number; readonly height: number }) =>
    width * height <= PREVIEW_VIEWPORT_MAX_AREA ||
    `Viewport area must not exceed ${PREVIEW_VIEWPORT_MAX_AREA} pixels.`,
);

export const PreviewViewportSize = Schema.Struct({
  width: PreviewViewportDimension,
  height: PreviewViewportDimension,
}).check(viewportAreaFilter);
export type PreviewViewportSize = typeof PreviewViewportSize.Type;

/**
 * The page's measured viewport can be smaller than the minimum selectable
 * fixed size while fill mode follows a narrow panel. Keep measurement
 * validation separate from the stricter user-selectable size constraints.
 */
export const PreviewRenderedViewportSize = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PreviewRenderedViewportSize = typeof PreviewRenderedViewportSize.Type;

export const PREVIEW_VIEWPORT_PRESET_IDS = [
  "iphone-se",
  "iphone-xr",
  "iphone-12-pro",
  "iphone-14-pro-max",
  "pixel-7",
  "samsung-galaxy-s8-plus",
  "samsung-galaxy-s20-ultra",
  "ipad-mini",
  "ipad-air",
  "ipad-pro",
  "surface-pro-7",
  "surface-duo",
  "galaxy-z-fold-5",
  "asus-zenbook-fold",
  "samsung-galaxy-a51-71",
  "nest-hub",
  "nest-hub-max",
] as const;

export const PreviewViewportPresetId = Schema.Literals(PREVIEW_VIEWPORT_PRESET_IDS);
export type PreviewViewportPresetId = typeof PreviewViewportPresetId.Type;

/**
 * Preset IDs shipped before the Chrome-compatible catalog. Existing sessions
 * can still reconnect with these values, but new resize requests only expose
 * PREVIEW_VIEWPORT_PRESET_IDS.
 */
const LEGACY_PREVIEW_VIEWPORT_PRESET_IDS = [
  "desktop-1920x1080",
  "desktop-1440x900",
  "laptop-1366x768",
  "laptop-1280x800",
  "ipad-pro-11",
  "iphone-15-pro",
  "pixel-8",
  "galaxy-s24",
] as const;

const StoredPreviewViewportPresetId = Schema.Literals([
  ...PREVIEW_VIEWPORT_PRESET_IDS,
  ...LEGACY_PREVIEW_VIEWPORT_PRESET_IDS,
]);

export const PreviewViewportSetting = Schema.Union([
  Schema.TaggedStruct("fill", {}),
  Schema.TaggedStruct("freeform", {
    ...PreviewViewportSize.fields,
  }).check(viewportAreaFilter),
  Schema.TaggedStruct("preset", {
    ...PreviewViewportSize.fields,
    presetId: StoredPreviewViewportPresetId,
  }).check(viewportAreaFilter),
]);
export type PreviewViewportSetting = typeof PreviewViewportSetting.Type;

export const FILL_PREVIEW_VIEWPORT = {
  _tag: "fill",
} as const satisfies PreviewViewportSetting;

/**
 * Discrete zoom levels mirroring Chrome's preset ladder. Zoom is applied by the
 * desktop main process to the Chromium guest, but the ladder lives here so the
 * settings UI can offer exactly the steps the zoom controls step through.
 */
export const PREVIEW_ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
] as const;

export const PreviewZoomFactor = Schema.Literals(PREVIEW_ZOOM_LEVELS);
export type PreviewZoomFactor = typeof PreviewZoomFactor.Type;

export const DEFAULT_PREVIEW_ZOOM_FACTOR: PreviewZoomFactor = 1.0;

/**
 * Preferred `prefers-color-scheme` for preview guests. `system` clears the
 * emulation override so the guest follows the OS. Structurally identical to
 * `DesktopPreviewColorScheme`, which is the IPC-layer spelling of the same set.
 */
export const PreviewAppearancePreference = Schema.Literals(["system", "light", "dark"]);
export type PreviewAppearancePreference = typeof PreviewAppearancePreference.Type;

export const DEFAULT_PREVIEW_APPEARANCE: PreviewAppearancePreference = "system";

export const PreviewNavStatus = Schema.Union([
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Loading", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("Success", {
    url: Url,
    title: Title,
  }),
  Schema.TaggedStruct("LoadFailed", {
    url: Url,
    title: Title,
    code: Schema.Int,
    description: Schema.String,
  }),
]);
export type PreviewNavStatus = typeof PreviewNavStatus.Type;

export const PreviewSessionSnapshot = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  /** Missing snapshots from older servers are treated as fill-panel mode. */
  viewport: Schema.optional(PreviewViewportSetting),
  /** Desktop-only browser state mirrored for remote mobile control surfaces. */
  zoomFactor: Schema.optional(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThan(0)),
  ),
  pictureInPicture: Schema.optional(Schema.Boolean),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  audioMuted: Schema.optional(Schema.Boolean),
  audible: Schema.optional(Schema.Boolean),
  /** Desktop recording state mirrored for remote mobile controls. */
  recording: Schema.optional(Schema.Boolean),
  recordingStartedAt: Schema.optional(Schema.String),
  updatedAt: Schema.String,
});
export type PreviewSessionSnapshot = typeof PreviewSessionSnapshot.Type;

export const PreviewOpenInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to create an empty (Idle) tab the user can type into. */
  url: Schema.optional(Url),
  /**
   * Initial viewport for the new tab. Omitting it keeps the historical
   * fill-panel behaviour; clients that have a configured default send it here
   * so the session is born at the right size instead of being resized a frame
   * later (which the user would see as a visible reflow).
   */
  viewport: Schema.optional(PreviewViewportSetting),
});
export type PreviewOpenInput = typeof PreviewOpenInput.Type;

export const PreviewNavigateInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  url: Url,
  resolvedTitle: Schema.optional(Title),
});
export type PreviewNavigateInput = typeof PreviewNavigateInput.Type;

export const PreviewReportStatusInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  navStatus: PreviewNavStatus,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  zoomFactor: Schema.optional(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThan(0)),
  ),
  pictureInPicture: Schema.optional(Schema.Boolean),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  audioMuted: Schema.optional(Schema.Boolean),
  audible: Schema.optional(Schema.Boolean),
  recording: Schema.optional(Schema.Boolean),
  recordingStartedAt: Schema.optional(Schema.String),
});
export type PreviewReportStatusInput = typeof PreviewReportStatusInput.Type;

export const PreviewReportRecordingInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  recording: Schema.Boolean,
  recordingStartedAt: Schema.optional(Schema.String),
});
export type PreviewReportRecordingInput = typeof PreviewReportRecordingInput.Type;

const PreviewAnnotationText = Schema.String.check(Schema.isMaxLength(4_096));
const PreviewAnnotationElementSummary = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  tagName: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  selector: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  componentName: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  htmlPreview: Schema.String.check(Schema.isMaxLength(4_096)),
});
const PreviewAnnotationScreenshotPreview = Schema.Struct({
  dataUrl: ScreenshotDataUrl,
  width: Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThan(0)),
});

/** 字段受限的远程拾取结果，避免把桌面端本地文件路径或任意 DOM 数据带上 wire。 */
export const PreviewAnnotationRemoteResult = Schema.Struct({
  annotationId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  pageUrl: Url,
  pageTitle: Schema.NullOr(Title),
  comment: PreviewAnnotationText,
  elements: Schema.Array(PreviewAnnotationElementSummary).check(Schema.isMaxLength(20)),
  regionCount: NonNegativeInt,
  strokeCount: NonNegativeInt,
  screenshot: Schema.NullOr(PreviewAnnotationScreenshotPreview),
  submission: Schema.Literals(["attach", "send"]),
});
export type PreviewAnnotationRemoteResult = typeof PreviewAnnotationRemoteResult.Type;

export const PreviewReportAnnotationInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  annotation: PreviewAnnotationRemoteResult,
});
export type PreviewReportAnnotationInput = typeof PreviewReportAnnotationInput.Type;

export const PreviewReportScreenshotInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  artifactId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  dataUrl: ScreenshotDataUrl,
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});
export type PreviewReportScreenshotInput = typeof PreviewReportScreenshotInput.Type;

export const PreviewRefreshInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type PreviewRefreshInput = typeof PreviewRefreshInput.Type;

export const PreviewControl = Schema.Literals([
  "back",
  "forward",
  "hardReload",
  "openDevTools",
  "zoomIn",
  "zoomOut",
  "resetZoom",
  "captureScreenshot",
  "setColorScheme",
  "setAudioMuted",
  "openPictureInPicture",
  "closePictureInPicture",
  "clearCookies",
  "clearCache",
  "startRecording",
  "stopRecording",
  "pickElement",
  "cancelPickElement",
  "openInSystemBrowser",
  "click",
  "type",
  "press",
  "scroll",
]);
export type PreviewControl = typeof PreviewControl.Type;

const PreviewControlText = Schema.String.check(Schema.isMaxLength(8_192));
const PreviewControlKey = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const PreviewControlCoordinate = Schema.Number.check(Schema.isFinite());
const PreviewControlDelta = Schema.Number.check(Schema.isFinite());

export const PreviewControlInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  control: PreviewControl,
  url: Schema.optional(Url),
  x: Schema.optional(PreviewControlCoordinate),
  y: Schema.optional(PreviewControlCoordinate),
  text: Schema.optional(PreviewControlText),
  key: Schema.optional(PreviewControlKey),
  deltaX: Schema.optional(PreviewControlDelta),
  deltaY: Schema.optional(PreviewControlDelta),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  audioMuted: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter((input) => {
    switch (input.control) {
      case "openInSystemBrowser":
        return input.url !== undefined || "A URL is required to open the system browser.";
      case "click":
        return (
          (input.x !== undefined && input.y !== undefined) ||
          "Click control requires both x and y coordinates."
        );
      case "type":
        return input.text !== undefined || "Type control requires text.";
      case "press":
        return input.key !== undefined || "Press control requires a key.";
      case "scroll":
        return (
          input.deltaX !== undefined ||
          input.deltaY !== undefined ||
          "Scroll control requires deltaX or deltaY."
        );
      default:
        return true;
    }
  }),
);
export type PreviewControlInput = typeof PreviewControlInput.Type;

export const PreviewResizeInput = Schema.Struct({
  threadId: ThreadId,
  tabId: PreviewTabId,
  viewport: PreviewViewportSetting,
});
export type PreviewResizeInput = typeof PreviewResizeInput.Type;

export const PreviewCloseInput = Schema.Struct({
  threadId: ThreadId,
  tabId: Schema.optional(PreviewTabId),
});
export type PreviewCloseInput = typeof PreviewCloseInput.Type;

export const PreviewListInput = Schema.Struct({
  threadId: ThreadId,
});
export type PreviewListInput = typeof PreviewListInput.Type;

export const PreviewListResult = Schema.Struct({
  sessions: Schema.Array(PreviewSessionSnapshot),
  /** Identifies the current server process so revision resets are safe. */
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision used to reject stale list responses. */
  revision: NonNegativeInt,
});
export type PreviewListResult = typeof PreviewListResult.Type;

const PreviewEventBaseSchema = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  tabId: PreviewTabId,
  createdAt: Schema.String,
  /** Identifies the server process that emitted this event. */
  serverEpoch: TrimmedNonEmptyString,
  /** Monotonic server state revision shared with PreviewListResult. */
  revision: PositiveInt,
});

const PreviewOpenedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("opened"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewNavigatedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("navigated"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewResizedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("resized"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewRecordingEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("recording"),
  snapshot: PreviewSessionSnapshot,
});

const PreviewAnnotationEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("annotation"),
  annotation: PreviewAnnotationRemoteResult,
});

const PreviewFailedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("failed"),
  url: Url,
  title: Title,
  code: Schema.Int,
  description: Schema.String,
});

const PreviewClosedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("closed"),
});

const PreviewRefreshedEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("refreshed"),
});

const PreviewControlledEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("controlled"),
  control: PreviewControl,
  url: Schema.optional(Url),
  x: Schema.optional(PreviewControlCoordinate),
  y: Schema.optional(PreviewControlCoordinate),
  text: Schema.optional(PreviewControlText),
  key: Schema.optional(PreviewControlKey),
  deltaX: Schema.optional(PreviewControlDelta),
  deltaY: Schema.optional(PreviewControlDelta),
  colorScheme: Schema.optional(PreviewAppearancePreference),
  audioMuted: Schema.optional(Schema.Boolean),
});

const PreviewScreenshotEvent = Schema.Struct({
  ...PreviewEventBaseSchema.fields,
  type: Schema.Literal("screenshot"),
  artifactId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  dataUrl: ScreenshotDataUrl,
  width: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  height: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
});

export const PreviewEvent = Schema.Union([
  PreviewOpenedEvent,
  PreviewNavigatedEvent,
  PreviewResizedEvent,
  PreviewRecordingEvent,
  PreviewFailedEvent,
  PreviewClosedEvent,
  PreviewRefreshedEvent,
  PreviewControlledEvent,
  PreviewScreenshotEvent,
  PreviewAnnotationEvent,
]);
export type PreviewEvent = typeof PreviewEvent.Type;

/**
 * A localhost server detected by the port scanner. Used to populate the
 * "Local" recommendations in the empty-state of the preview panel.
 */
export const DiscoveredLocalServer = Schema.Struct({
  host: TrimmedNonEmptyString,
  port: Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThan(65536)),
  url: Url,
  processName: Schema.NullOr(TrimmedNonEmptyString),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  terminal: Schema.NullOr(
    Schema.Struct({
      threadId: ThreadId,
      terminalId: TrimmedNonEmptyString,
    }),
  ),
});
export type DiscoveredLocalServer = typeof DiscoveredLocalServer.Type;

export const DiscoveredLocalServerList = Schema.Struct({
  servers: Schema.Array(DiscoveredLocalServer),
  scannedAt: Schema.String,
  configuredUrlProbing: Schema.optional(Schema.Literal(true)),
});
export type DiscoveredLocalServerList = typeof DiscoveredLocalServerList.Type;

export class PreviewSessionLookupError extends Schema.TaggedErrorClass<PreviewSessionLookupError>()(
  "PreviewSessionLookupError",
  {
    threadId: Schema.String,
    tabId: Schema.String,
  },
) {
  override get message() {
    return `Unknown preview session: thread=${this.threadId}, tab=${this.tabId}`;
  }
}

export class PreviewInvalidUrlError extends Schema.TaggedErrorClass<PreviewInvalidUrlError>()(
  "PreviewInvalidUrlError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol", "unexpected"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const PreviewError = Schema.Union([PreviewSessionLookupError, PreviewInvalidUrlError]);
export type PreviewError = typeof PreviewError.Type;
