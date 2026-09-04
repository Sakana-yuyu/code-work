import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type PreviewAppearancePreference,
  type PreviewAnnotationRemoteResult,
  type PreviewControl,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
} from "@codework/contracts";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Option from "effect/Option";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { normalizePreviewUrl } from "@codework/shared/preview";
import { PREVIEW_VIEWPORT_PRESETS } from "@codework/shared/previewViewport";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { t } from "../../i18n";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { previewEnvironment } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { controlInvalidatesScreenshot } from "./ThreadPreviewRouteScreen.logic";

type ThreadPreviewRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function firstRouteParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function previewUrl(snapshot: PreviewSessionSnapshot): string {
  return snapshot.navStatus._tag === "Idle" ? "" : snapshot.navStatus.url;
}

function previewStatus(snapshot: PreviewSessionSnapshot): string {
  switch (snapshot.navStatus._tag) {
    case "Idle":
      return t("threadPreviewMobile.status.idle");
    case "Loading":
      return t("threadPreviewMobile.status.loading");
    case "Success":
      return t("threadPreviewMobile.status.ready");
    case "LoadFailed":
      return t("threadPreviewMobile.status.failed");
  }
}

function previewViewportMatches(
  current: PreviewViewportSetting,
  candidate: PreviewViewportSetting,
): boolean {
  if (current._tag !== candidate._tag) return false;
  if (current._tag === "fill" || candidate._tag === "fill") return true;
  return (
    current.width === candidate.width &&
    current.height === candidate.height &&
    (current._tag !== "preset" ||
      candidate._tag !== "preset" ||
      current.presetId === candidate.presetId)
  );
}

function previewViewportLabel(setting: PreviewViewportSetting): string {
  if (setting._tag === "fill") return t("threadPreviewMobile.viewportFill");
  if (setting._tag === "preset") {
    return (
      PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === setting.presetId)?.label ??
      `${setting.width} × ${setting.height}`
    );
  }
  return `${setting.width} × ${setting.height}`;
}

function commandError(result: unknown): string {
  const failure = squashAtomCommandFailure(result as never);
  return failure instanceof Error ? failure.message : t("threadPreviewMobile.operationFailed");
}

type PreviewControlOptions = {
  readonly url?: string;
  readonly x?: number;
  readonly y?: number;
  readonly text?: string;
  readonly key?: string;
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly colorScheme?: PreviewAppearancePreference;
  readonly audioMuted?: boolean;
};

export function ThreadPreviewRouteScreen(props: ThreadPreviewRouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const routeEnvironmentId = firstRouteParam(props.route.params.environmentId);
  const routeThreadId = firstRouteParam(props.route.params.threadId);
  const environmentId = routeEnvironmentId ? EnvironmentId.make(routeEnvironmentId) : null;
  const threadId = routeThreadId ? ThreadId.make(routeThreadId) : null;
  const listQuery = useEnvironmentQuery(
    environmentId !== null && threadId !== null
      ? previewEnvironment.list({ environmentId, input: { threadId } })
      : null,
  );
  const eventResult = useAtomValue(
    environmentId !== null
      ? previewEnvironment.events({ environmentId, input: {} })
      : previewEnvironment.events({ environmentId: "" as EnvironmentId, input: {} }),
  );
  const open = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const navigate = useAtomCommand(previewEnvironment.navigate, { reportFailure: false });
  const refresh = useAtomCommand(previewEnvironment.refresh, { reportFailure: false });
  const control = useAtomCommand(previewEnvironment.control, { reportFailure: false });
  const resize = useAtomCommand(previewEnvironment.resize, { reportFailure: false });
  const close = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<{
    readonly tabId: string;
    readonly artifactId: string;
    readonly dataUrl: string;
    readonly width?: number;
    readonly height?: number;
  } | null>(null);
  const [annotation, setAnnotation] = useState<{
    readonly tabId: string;
    readonly result: PreviewAnnotationRemoteResult;
  } | null>(null);
  const [pickActive, setPickActive] = useState(false);
  const [staleScreenshotTabId, setStaleScreenshotTabId] = useState<string | null>(null);
  const [screenshotLayout, setScreenshotLayout] = useState({ width: 0, height: 0 });
  const [typeText, setTypeText] = useState("");
  const [keyText, setKeyText] = useState("");
  const event = Option.getOrNull(AsyncResult.value(eventResult)) ?? null;
  const sessions = listQuery.data?.sessions ?? [];
  const selectedSnapshot = useMemo(
    () => sessions.find((session) => session.tabId === selectedTabId) ?? sessions[0] ?? null,
    [selectedTabId, sessions],
  );

  useEffect(() => {
    if (event === null || threadId === null || event.threadId !== threadId) return;
    if (event.type === "screenshot") {
      setScreenshot({
        tabId: event.tabId,
        artifactId: event.artifactId,
        dataUrl: event.dataUrl,
        ...(event.width === undefined ? {} : { width: event.width }),
        ...(event.height === undefined ? {} : { height: event.height }),
      });
      setStaleScreenshotTabId((current) => (current === event.tabId ? null : current));
    } else if (event.type === "annotation") {
      setAnnotation({ tabId: event.tabId, result: event.annotation });
      setPickActive(false);
    } else if (event.type === "controlled") {
      if (event.control === "pickElement") setPickActive(true);
      if (event.control === "cancelPickElement") setPickActive(false);
    } else if (event.type === "closed") {
      setScreenshot((current) => (current?.tabId === event.tabId ? null : current));
      setAnnotation((current) => (current?.tabId === event.tabId ? null : current));
      setPickActive(false);
      setStaleScreenshotTabId((current) => (current === event.tabId ? null : current));
    }
    listQuery.refresh();
  }, [event, listQuery.refresh, threadId]);

  useEffect(() => {
    if (selectedSnapshot === null) {
      setSelectedTabId(null);
      setUrlDraft("");
      return;
    }
    const selectedStillExists =
      selectedTabId !== null && sessions.some((session) => session.tabId === selectedTabId);
    setSelectedTabId((current) => (selectedStillExists ? current : selectedSnapshot.tabId));
    setUrlDraft((current) =>
      selectedStillExists && current.length > 0 ? current : previewUrl(selectedSnapshot),
    );
  }, [selectedSnapshot, selectedTabId, sessions]);

  const fail = useCallback((result: unknown): void => {
    if (!isAtomCommandInterrupted(result as never)) setError(commandError(result));
  }, []);

  const normalizedDraft = useCallback((): string | null => {
    try {
      return normalizePreviewUrl(urlDraft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("threadPreviewMobile.invalidUrl"));
      return null;
    }
  }, [urlDraft]);

  const openTab = useCallback(async () => {
    if (environmentId === null || threadId === null || pendingAction !== null) return;
    setPendingAction("open");
    setError(null);
    const normalized = urlDraft.trim().length > 0 ? normalizedDraft() : null;
    if (urlDraft.trim().length > 0 && normalized === null) {
      setPendingAction(null);
      return;
    }
    const result = await open({
      environmentId,
      input: normalized === null ? { threadId } : { threadId, url: normalized },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      fail(result);
      return;
    }
    setSelectedTabId(result.value.tabId);
    setUrlDraft(previewUrl(result.value));
    listQuery.refresh();
  }, [environmentId, fail, listQuery, normalizedDraft, open, pendingAction, threadId, urlDraft]);

  const navigateTab = useCallback(async () => {
    if (
      environmentId === null ||
      threadId === null ||
      selectedSnapshot === null ||
      pendingAction !== null
    ) {
      return;
    }
    const normalized = normalizedDraft();
    if (normalized === null) return;
    setPendingAction("navigate");
    setError(null);
    const result = await navigate({
      environmentId,
      input: { threadId, tabId: selectedSnapshot.tabId, url: normalized },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      fail(result);
      return;
    }
    setUrlDraft(previewUrl(result.value));
    setStaleScreenshotTabId(result.value.tabId);
    listQuery.refresh();
  }, [
    environmentId,
    fail,
    listQuery,
    navigate,
    normalizedDraft,
    pendingAction,
    selectedSnapshot,
    threadId,
  ]);

  const refreshTab = useCallback(
    async (targetTabId?: string) => {
      const targetSnapshot =
        sessions.find((session) => session.tabId === targetTabId) ?? selectedSnapshot;
      if (
        environmentId === null ||
        threadId === null ||
        targetSnapshot === null ||
        pendingAction !== null
      ) {
        return;
      }
      setPendingAction("refresh");
      setError(null);
      const result = await refresh({
        environmentId,
        input: { threadId, tabId: targetSnapshot.tabId },
      });
      setPendingAction(null);
      if (result._tag === "Failure") fail(result);
      else setStaleScreenshotTabId(targetSnapshot.tabId);
    },
    [environmentId, fail, pendingAction, refresh, selectedSnapshot, sessions, threadId],
  );

  const controlTab = useCallback(
    async (direction: PreviewControl, options: PreviewControlOptions = {}) => {
      if (
        environmentId === null ||
        threadId === null ||
        selectedSnapshot === null ||
        pendingAction !== null ||
        (direction === "back" && !selectedSnapshot.canGoBack) ||
        (direction === "forward" && !selectedSnapshot.canGoForward)
      ) {
        return false;
      }
      setPendingAction(direction);
      setError(null);
      const result = await control({
        environmentId,
        input: { threadId, tabId: selectedSnapshot.tabId, control: direction, ...options },
      });
      setPendingAction(null);
      if (result._tag === "Failure") {
        fail(result);
        return false;
      }
      if (controlInvalidatesScreenshot(direction)) setStaleScreenshotTabId(selectedSnapshot.tabId);
      listQuery.refresh();
      return true;
    },
    [control, environmentId, fail, listQuery, pendingAction, selectedSnapshot, threadId],
  );

  const resizeTab = useCallback(
    async (viewport: PreviewViewportSetting) => {
      if (
        environmentId === null ||
        threadId === null ||
        selectedSnapshot === null ||
        pendingAction !== null
      ) {
        return;
      }
      setPendingAction("resize");
      setError(null);
      const result = await resize({
        environmentId,
        input: { threadId, tabId: selectedSnapshot.tabId, viewport },
      });
      setPendingAction(null);
      if (result._tag === "Failure") {
        fail(result);
        return;
      }
      setStaleScreenshotTabId(selectedSnapshot.tabId);
      listQuery.refresh();
    },
    [environmentId, fail, listQuery, pendingAction, resize, selectedSnapshot, threadId],
  );

  const closeTab = useCallback(
    async (targetTabId?: string) => {
      const targetSnapshot =
        sessions.find((session) => session.tabId === targetTabId) ?? selectedSnapshot;
      if (
        environmentId === null ||
        threadId === null ||
        targetSnapshot === null ||
        pendingAction !== null
      ) {
        return;
      }
      setPendingAction("close");
      setError(null);
      const result = await close({
        environmentId,
        input: { threadId, tabId: targetSnapshot.tabId },
      });
      setPendingAction(null);
      if (result._tag === "Failure") {
        fail(result);
        return;
      }
      setSelectedTabId(null);
      listQuery.refresh();
    },
    [close, environmentId, fail, listQuery, pendingAction, selectedSnapshot, sessions, threadId],
  );

  const busy = pendingAction !== null;
  const actionButtonClass =
    "min-h-11 flex-1 items-center justify-center rounded-full bg-primary px-4";

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("threadPreviewMobile.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={listQuery.isPending && listQuery.data !== null}
            onRefresh={listQuery.refresh}
          />
        }
      >
        <View className="gap-2 px-2">
          <Text className="text-base font-codework-bold text-foreground">
            {t("threadPreviewMobile.computerPreview")}
          </Text>
          <Text className="text-sm leading-5 text-foreground-muted">
            {t("threadPreviewMobile.description")}
          </Text>
        </View>

        <View className="gap-3 rounded-[24px] bg-card p-4">
          <TextInput
            value={urlDraft}
            onChangeText={setUrlDraft}
            placeholder={t("threadPreviewMobile.urlPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!busy}
            onSubmitEditing={() => void navigateTab()}
          />
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              disabled={busy || selectedSnapshot === null}
              onPress={() => void navigateTab()}
              className={actionButtonClass + " disabled:opacity-40"}
            >
              <Text className="font-codework-bold text-primary-foreground">
                {t("threadPreviewMobile.navigate")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void openTab()}
              className="min-h-11 items-center justify-center rounded-full border border-border px-4 disabled:opacity-40"
            >
              <Text className="font-codework-bold text-foreground">
                {t("threadPreviewMobile.open")}
              </Text>
            </Pressable>
          </View>
          <View className="flex-row gap-2">
            <Pressable
              accessibilityLabel={t("threadPreviewMobile.back")}
              accessibilityRole="button"
              disabled={busy || selectedSnapshot === null || !selectedSnapshot.canGoBack}
              onPress={() => void controlTab("back")}
              className="min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full border border-border px-4 disabled:opacity-40"
            >
              <SymbolView name="chevron.left" size={17} tintColor="#8b8b93" type="monochrome" />
              <Text className="font-codework-bold text-foreground">
                {t("threadPreviewMobile.back")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t("threadPreviewMobile.forward")}
              accessibilityRole="button"
              disabled={busy || selectedSnapshot === null || !selectedSnapshot.canGoForward}
              onPress={() => void controlTab("forward")}
              className="min-h-11 flex-1 flex-row items-center justify-center gap-2 rounded-full border border-border px-4 disabled:opacity-40"
            >
              <Text className="font-codework-bold text-foreground">
                {t("threadPreviewMobile.forward")}
              </Text>
              <SymbolView name="chevron.right" size={17} tintColor="#8b8b93" type="monochrome" />
            </Pressable>
          </View>
          {selectedSnapshot ? (
            <View className="gap-2">
              <Text className="text-sm font-codework-bold text-foreground">
                {t("threadPreviewMobile.viewport")}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2"
              >
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void resizeTab(FILL_PREVIEW_VIEWPORT)}
                  className={
                    "min-h-10 rounded-full border px-4 py-2 disabled:opacity-40 " +
                    (previewViewportMatches(
                      selectedSnapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
                      FILL_PREVIEW_VIEWPORT,
                    )
                      ? "border-primary bg-primary/10"
                      : "border-border")
                  }
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.viewportFill")}
                  </Text>
                </Pressable>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => {
                  const setting: PreviewViewportSetting = {
                    _tag: "preset",
                    presetId: preset.id,
                    width: preset.width,
                    height: preset.height,
                  };
                  const selected = previewViewportMatches(
                    selectedSnapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
                    setting,
                  );
                  return (
                    <Pressable
                      key={preset.id}
                      accessibilityRole="button"
                      disabled={busy}
                      onPress={() => void resizeTab(setting)}
                      className={
                        "min-h-10 rounded-full border px-4 py-2 disabled:opacity-40 " +
                        (selected ? "border-primary bg-primary/10" : "border-border")
                      }
                    >
                      <Text className="text-sm font-codework-bold text-foreground">
                        {preset.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Text className="text-xs text-foreground-muted">
                {t("threadPreviewMobile.viewportCurrent", {
                  value: previewViewportLabel(selectedSnapshot.viewport ?? FILL_PREVIEW_VIEWPORT),
                })}
              </Text>
              <Text className="text-sm font-codework-bold text-foreground">
                {t("threadPreviewMobile.desktopControls")}
              </Text>
              <View className="flex-row items-center gap-2">
                {selectedSnapshot.navStatus._tag !== "Idle" ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() =>
                      void controlTab("openInSystemBrowser", {
                        url: previewUrl(selectedSnapshot),
                      })
                    }
                    className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                  >
                    <Text className="text-sm font-codework-bold text-foreground">
                      {t("threadPreviewMobile.openInSystemBrowser")}
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("zoomOut")}
                  className="size-11 items-center justify-center rounded-full border border-border disabled:opacity-40"
                >
                  <SymbolView name="minus" size={18} tintColor="#8b8b93" type="monochrome" />
                </Pressable>
                <View className="min-h-11 min-w-16 items-center justify-center rounded-full bg-background px-3">
                  <Text className="text-sm font-codework-bold text-foreground">
                    {Math.round((selectedSnapshot.zoomFactor ?? 1) * 100)}%
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("zoomIn")}
                  className="size-11 items-center justify-center rounded-full border border-border disabled:opacity-40"
                >
                  <SymbolView name="plus" size={18} tintColor="#8b8b93" type="monochrome" />
                </Pressable>
                <Pressable
                  accessibilityLabel={t("threadPreviewMobile.resetZoom")}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("resetZoom")}
                  className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.resetZoom")}
                  </Text>
                </Pressable>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2"
              >
                {(["system", "light", "dark"] as const).map((colorScheme) => (
                  <Pressable
                    key={colorScheme}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => void controlTab("setColorScheme", { colorScheme })}
                    className={
                      "min-h-10 rounded-full border px-4 py-2 disabled:opacity-40 " +
                      ((selectedSnapshot.colorScheme ?? "system") === colorScheme
                        ? "border-primary bg-primary/10"
                        : "border-border")
                    }
                  >
                    <Text className="text-sm font-codework-bold text-foreground">
                      {t(`threadPreviewMobile.appearance.${colorScheme}`)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <View className="flex-row gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("hardReload")}
                  className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.hardReload")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("captureScreenshot")}
                  className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.captureScreenshot")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void controlTab("setAudioMuted", { audioMuted: !selectedSnapshot.audioMuted })
                  }
                  className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {selectedSnapshot.audioMuted
                      ? t("threadPreviewMobile.unmute")
                      : t("threadPreviewMobile.mute")}
                  </Text>
                </Pressable>
              </View>
              <View className="flex-row items-center gap-2">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void controlTab(selectedSnapshot.recording ? "stopRecording" : "startRecording")
                  }
                  className="min-h-11 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {selectedSnapshot.recording
                      ? t("threadPreviewMobile.stopRecording")
                      : t("threadPreviewMobile.startRecording")}
                  </Text>
                </Pressable>
                {selectedSnapshot.recording ? (
                  <Text className="flex-1 text-xs text-foreground-muted">
                    {t("threadPreviewMobile.recording")}
                  </Text>
                ) : null}
              </View>
              <View className="gap-1">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => {
                    void controlTab(pickActive ? "cancelPickElement" : "pickElement");
                  }}
                  className="min-h-11 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {pickActive
                      ? t("threadPreviewMobile.cancelPickElement")
                      : t("threadPreviewMobile.pickElement")}
                  </Text>
                </Pressable>
                <Text className="text-xs text-foreground-muted">
                  {t("threadPreviewMobile.pickElementHint")}
                </Text>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="gap-2"
              >
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("openDevTools")}
                  className="min-h-10 rounded-full border border-border px-4 py-2 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.devTools")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void controlTab(
                      selectedSnapshot.pictureInPicture
                        ? "closePictureInPicture"
                        : "openPictureInPicture",
                    )
                  }
                  className="min-h-10 rounded-full border border-border px-4 py-2 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {selectedSnapshot.pictureInPicture
                      ? t("threadPreviewMobile.closePictureInPicture")
                      : t("threadPreviewMobile.openPictureInPicture")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("clearCache")}
                  className="min-h-10 rounded-full border border-border px-4 py-2 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.clearCache")}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void controlTab("clearCookies")}
                  className="min-h-10 rounded-full border border-border px-4 py-2 disabled:opacity-40"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.clearCookies")}
                  </Text>
                </Pressable>
              </ScrollView>
              {screenshot?.tabId === selectedSnapshot.tabId ? (
                <View className="gap-2 rounded-2xl bg-background p-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("threadPreviewMobile.tapScreenshotHint")}
                    disabled={
                      screenshot.width === undefined ||
                      screenshot.height === undefined ||
                      staleScreenshotTabId === selectedSnapshot.tabId ||
                      screenshotLayout.width <= 0
                    }
                    onLayout={({ nativeEvent }) => setScreenshotLayout(nativeEvent.layout)}
                    onPress={({ nativeEvent }) => {
                      if (
                        screenshot.width === undefined ||
                        screenshot.height === undefined ||
                        screenshotLayout.width <= 0 ||
                        screenshotLayout.height <= 0
                      ) {
                        return;
                      }
                      void controlTab("click", {
                        x: (nativeEvent.locationX / screenshotLayout.width) * screenshot.width,
                        y: (nativeEvent.locationY / screenshotLayout.height) * screenshot.height,
                      });
                    }}
                    className="w-full overflow-hidden rounded-xl disabled:opacity-80"
                    style={
                      screenshot.width !== undefined && screenshot.height !== undefined
                        ? { aspectRatio: screenshot.width / screenshot.height }
                        : undefined
                    }
                  >
                    <Image
                      accessibilityLabel={t("threadPreviewMobile.screenshotReady")}
                      source={{ uri: screenshot.dataUrl }}
                      resizeMode="contain"
                      className="h-full w-full"
                    />
                  </Pressable>
                  <Text className="text-xs text-foreground-muted">
                    {staleScreenshotTabId === selectedSnapshot.tabId
                      ? t("threadPreviewMobile.screenshotStale")
                      : t("threadPreviewMobile.screenshotReady")}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {staleScreenshotTabId === selectedSnapshot.tabId
                      ? t("threadPreviewMobile.captureScreenshotToUpdate")
                      : t("threadPreviewMobile.tapScreenshotHint")}
                  </Text>
                  <View className="gap-2">
                    <TextInput
                      value={typeText}
                      onChangeText={setTypeText}
                      placeholder={t("threadPreviewMobile.typeOnComputerPlaceholder")}
                      editable={!busy}
                      className="rounded-xl border border-input-border bg-input px-3 py-2 text-sm text-foreground"
                    />
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy || typeText.length === 0}
                      onPress={() => {
                        void controlTab("type", { text: typeText }).then((succeeded) => {
                          if (succeeded) setTypeText("");
                        });
                      }}
                      className="min-h-10 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                    >
                      <Text className="text-sm font-codework-bold text-foreground">
                        {t("threadPreviewMobile.typeOnComputer")}
                      </Text>
                    </Pressable>
                    <View className="flex-row items-center gap-2">
                      <TextInput
                        value={keyText}
                        onChangeText={setKeyText}
                        placeholder={t("threadPreviewMobile.pressKeyPlaceholder")}
                        autoCapitalize="none"
                        editable={!busy}
                        className="flex-1 rounded-xl border border-input-border bg-input px-3 py-2 text-sm text-foreground"
                      />
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy || keyText.trim().length === 0}
                        onPress={() => {
                          void controlTab("press", { key: keyText.trim() }).then((succeeded) => {
                            if (succeeded) setKeyText("");
                          });
                        }}
                        className="min-h-10 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                      >
                        <Text className="text-sm font-codework-bold text-foreground">
                          {t("threadPreviewMobile.pressKey")}
                        </Text>
                      </Pressable>
                    </View>
                    <View className="flex-row items-center gap-2">
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => void controlTab("scroll", { deltaY: -640 })}
                        className="min-h-10 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                      >
                        <Text className="text-sm font-codework-bold text-foreground">
                          {t("threadPreviewMobile.scrollUp")}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        disabled={busy}
                        onPress={() => void controlTab("scroll", { deltaY: 640 })}
                        className="min-h-10 flex-1 items-center justify-center rounded-full border border-border px-3 disabled:opacity-40"
                      >
                        <Text className="text-sm font-codework-bold text-foreground">
                          {t("threadPreviewMobile.scrollDown")}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ) : null}
              {annotation?.tabId === selectedSnapshot.tabId ? (
                <View className="gap-2 rounded-2xl bg-background p-3">
                  <Text className="text-sm font-codework-bold text-foreground">
                    {t("threadPreviewMobile.annotationReady")}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {annotation.result.pageTitle || annotation.result.pageUrl}
                  </Text>
                  {annotation.result.elements.map((element) => (
                    <View key={element.id} className="gap-1 rounded-xl bg-card p-2">
                      <Text className="text-xs font-codework-bold text-foreground">
                        {element.componentName || element.tagName}
                      </Text>
                      {element.selector ? (
                        <Text className="text-xs text-foreground-muted">{element.selector}</Text>
                      ) : null}
                      <Text numberOfLines={3} className="text-xs text-foreground-muted">
                        {element.htmlPreview}
                      </Text>
                    </View>
                  ))}
                  {annotation.result.screenshot ? (
                    <Image
                      accessibilityLabel={t("threadPreviewMobile.annotationReady")}
                      source={{ uri: annotation.result.screenshot.dataUrl }}
                      resizeMode="contain"
                      className="aspect-video w-full rounded-xl"
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : null}
          {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        </View>

        <View className="gap-3">
          <Text className="px-2 text-sm font-codework-bold uppercase text-foreground-muted">
            {t("threadPreviewMobile.tabs", { count: sessions.length })}
          </Text>
          {listQuery.data === null && listQuery.isPending ? (
            <View className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">
                {t("threadPreviewMobile.loading")}
              </Text>
            </View>
          ) : sessions.length === 0 ? (
            <View className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
              <SymbolView name="safari" size={28} tintColor="#8b8b93" type="monochrome" />
              <Text className="text-center text-sm leading-5 text-foreground-muted">
                {t("threadPreviewMobile.noTabs")}
              </Text>
            </View>
          ) : (
            sessions.map((session) => (
              <PreviewTabRow
                key={session.tabId}
                snapshot={session}
                selected={selectedSnapshot?.tabId === session.tabId}
                busy={busy}
                onSelect={() => {
                  setSelectedTabId(session.tabId);
                  setUrlDraft(previewUrl(session));
                }}
                onRefresh={() => {
                  void refreshTab(session.tabId);
                }}
                onClose={() => {
                  void closeTab(session.tabId);
                }}
              />
            ))
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function PreviewTabRow(props: {
  readonly snapshot: PreviewSessionSnapshot;
  readonly selected: boolean;
  readonly busy: boolean;
  readonly onSelect: () => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}) {
  const iconColor = props.selected ? "#ffffff" : "#8b8b93";
  const url = previewUrl(props.snapshot);
  const title = props.snapshot.navStatus._tag === "Success" ? props.snapshot.navStatus.title : url;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      onPress={props.onSelect}
      className={
        props.selected ? "gap-3 rounded-[24px] bg-primary p-4" : "gap-3 rounded-[24px] bg-card p-4"
      }
    >
      <View className="flex-row items-center gap-3">
        <SymbolView name="safari" size={22} tintColor={iconColor} type="monochrome" />
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className={
              props.selected
                ? "font-codework-bold text-primary-foreground"
                : "font-codework-bold text-foreground"
            }
          >
            {title || t("threadPreviewMobile.newTab")}
          </Text>
          <Text
            numberOfLines={1}
            className={
              props.selected
                ? "text-xs text-primary-foreground/75"
                : "text-xs text-foreground-muted"
            }
          >
            {previewStatus(props.snapshot)}
          </Text>
        </View>
        <Pressable
          accessibilityLabel={t("threadPreviewMobile.refresh")}
          accessibilityRole="button"
          disabled={props.busy}
          onPress={props.onRefresh}
          className="size-10 items-center justify-center rounded-full bg-black/10 disabled:opacity-40 dark:bg-white/10"
        >
          <SymbolView name="arrow.clockwise" size={18} tintColor={iconColor} type="monochrome" />
        </Pressable>
        <Pressable
          accessibilityLabel={t("threadPreviewMobile.close")}
          accessibilityRole="button"
          disabled={props.busy}
          onPress={props.onClose}
          className="size-10 items-center justify-center rounded-full bg-black/10 disabled:opacity-40 dark:bg-white/10"
        >
          <SymbolView name="xmark" size={18} tintColor={iconColor} type="monochrome" />
        </Pressable>
      </View>
      {url ? (
        <Text
          numberOfLines={2}
          className={
            props.selected
              ? "text-xs leading-4 text-primary-foreground/80"
              : "text-xs leading-4 text-foreground-muted"
          }
        >
          {url}
        </Text>
      ) : null}
    </Pressable>
  );
}
