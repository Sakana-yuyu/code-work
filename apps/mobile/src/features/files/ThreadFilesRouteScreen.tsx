import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import {
  EnvironmentId,
  type ProjectListEntriesResult,
  type ProjectReadFileResult,
  ThreadId,
} from "@codework/contracts";
import { isCodeworkCanvasArtifactPath, parseCanvasDocument } from "@codework/shared/canvas";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { resolveFileSelectionNavigationAction } from "../../lib/adaptive-navigation";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { ReviewHighlighterProvider } from "../review/ReviewHighlighterProvider";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { ThreadRouteScreen } from "../threads/ThreadRouteScreen";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { FileTreeBrowser } from "./FileTreeBrowser";
import { preloadWorkspaceFileContents } from "./preload-workspace-file";
import { SourceFileSurface } from "./SourceFileSurface";
import { ThreadFileNavigatorPane } from "./thread-file-navigator-pane";
import { WorkspaceFileImagePreview } from "./WorkspaceFileImagePreview";
import { WorkspaceFileWebPreview } from "./WorkspaceFileWebPreview";
import { canEditWorkspaceFile, type FileViewMode } from "./fileEditing";
import {
  basename,
  isBrowserPreviewFile,
  isImagePreviewFile,
  isMarkdownPreviewFile,
  isSvgImagePreviewFile,
} from "./filePath";
import { useWorkspaceFileAssetUrl } from "./workspaceFileAssetUrl";
import { t } from "../../i18n";

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function normalizeRoutePath(value: string | string[] | undefined): string | null {
  const path = Array.isArray(value) ? value.join("/") : value;
  if (path === undefined || path.trim().length === 0) {
    return null;
  }
  return path;
}

function normalizeRouteLine(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function defaultViewMode(path: string | null): FileViewMode {
  return path !== null && (isBrowserPreviewFile(path) || isImagePreviewFile(path))
    ? "preview"
    : "source";
}

function FileContent(props: {
  readonly activeMode: FileViewMode;
  readonly previewUri: string | null;
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly initialLine: number | null;
  readonly truncated: boolean;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const isMarkdown = isMarkdownPreviewFile(props.relativePath);
  const isBrowserFile = isBrowserPreviewFile(props.relativePath);
  const isImageFile = isImagePreviewFile(props.relativePath);

  if (props.activeMode === "preview" && isImageFile) {
    if (isSvgImagePreviewFile(props.relativePath)) {
      return <WorkspaceFileWebPreview uri={props.previewUri} />;
    }
    return (
      <WorkspaceFileImagePreview
        accessibilityLabel={basename(props.relativePath)}
        uri={props.previewUri}
      />
    );
  }

  if (props.activeMode === "preview" && isBrowserFile) {
    return <WorkspaceFileWebPreview uri={props.previewUri} />;
  }

  if (props.fileError && props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState title={t("fileUnavailable")} detail={props.fileError} />
      </View>
    );
  }

  if (props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">{t("loadingFile")}</Text>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      {props.truncated ? (
        <View className="border-b border-amber-200 bg-amber-50 px-4 py-2 dark:border-amber-900/60 dark:bg-amber-950/40">
          <Text className="text-2xs font-codework-bold uppercase text-amber-700 dark:text-amber-300">
            {t("partialFile")}
          </Text>
          <Text className="text-xs leading-snug text-amber-800 dark:text-amber-200">
            {t("previewLimitedToTheFirst1MbOfATruncatedFile")}
          </Text>
        </View>
      ) : null}
      {props.activeMode === "preview" && isMarkdown ? (
        <FileMarkdownPreview markdown={props.fileContents} onRefresh={props.onRefresh} />
      ) : (
        <SourceFileSurface
          contents={props.fileContents}
          path={props.relativePath}
          initialLine={props.initialLine}
          onRefresh={props.onRefresh}
        />
      )}
    </View>
  );
}

function CanvasFileContent(props: {
  readonly fileContents: string | null;
  readonly fileError: string | null;
  readonly relativePath: string;
  readonly truncated: boolean;
  readonly onRefresh: () => Promise<void> | void;
  readonly onOpenFile: (path: string, line?: number) => void;
}) {
  const document = props.fileContents ? parseCanvasDocument(props.fileContents) : null;

  if (props.fileError && props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState title={t("fileUnavailable")} detail={props.fileError} />
      </View>
    );
  }

  if (props.fileContents === null) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-sheet px-6">
        <ActivityIndicator />
        <Text className="text-center text-sm text-foreground-muted">{t("loadingFile")}</Text>
      </View>
    );
  }

  if (document === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <EmptyState title={t("canvas.invalid")} detail={props.relativePath} />
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-sheet" contentContainerClassName="gap-3 px-4 pb-8 pt-4">
      {props.truncated ? (
        <View className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900/60 dark:bg-amber-950/40">
          <Text className="text-xs font-codework-bold text-amber-700 dark:text-amber-300">
            {t("partialFile")}
          </Text>
        </View>
      ) : null}
      <View className="gap-2 border-b border-border pb-4">
        <Text className="text-2xs font-codework-bold uppercase text-foreground-muted">
          {t("canvas.agentGenerated")}
        </Text>
        <Text className="text-2xl font-codework-bold text-foreground">{document.title}</Text>
        {document.summary ? (
          <Text selectable className="text-sm leading-relaxed text-foreground-secondary">
            {document.summary}
          </Text>
        ) : null}
      </View>

      {document.blocks.length === 0 ? (
        <Text className="text-sm text-foreground-muted">{t("canvas.noContent")}</Text>
      ) : (
        document.blocks.map((block) => {
          switch (block.type) {
            case "stat":
              return (
                <View
                  key={JSON.stringify(block)}
                  className="gap-1 rounded-2xl border border-border bg-card px-4 py-3"
                >
                  <Text className="text-xs text-foreground-muted">{block.label}</Text>
                  <Text
                    selectable
                    className="text-2xl font-codework-bold tabular-nums text-foreground"
                  >
                    {block.value}
                  </Text>
                </View>
              );
            case "section":
              return (
                <View
                  key={JSON.stringify(block)}
                  className="gap-1.5 rounded-2xl border border-border bg-card/60 p-4"
                >
                  <Text className="text-sm font-codework-bold text-foreground">
                    {block.heading}
                  </Text>
                  <Text selectable className="text-sm leading-relaxed text-foreground-secondary">
                    {block.body}
                  </Text>
                </View>
              );
            case "file":
              return (
                <View
                  key={JSON.stringify(block)}
                  className="gap-1 rounded-2xl border border-border bg-card/60 p-4"
                >
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`${block.path}${block.line ? `:${block.line}` : ""}`}
                    onPress={() => props.onOpenFile(block.path, block.line)}
                  >
                    <Text className="text-sm font-codework-medium text-info-foreground underline">
                      {block.path}
                      {block.line ? `:${block.line}` : ""}
                    </Text>
                  </Pressable>
                  {block.note ? (
                    <Text selectable className="text-xs leading-relaxed text-foreground-muted">
                      {block.note}
                    </Text>
                  ) : null}
                </View>
              );
            case "table":
              return (
                <ScrollView
                  key={JSON.stringify(block)}
                  horizontal
                  nestedScrollEnabled
                  className="rounded-2xl border border-border bg-card/60"
                >
                  <View>
                    <View className="flex-row border-b border-border">
                      {block.columns.map((column) => (
                        <Text
                          key={column}
                          className="w-36 px-3 py-2 text-xs font-codework-bold text-foreground-muted"
                        >
                          {column}
                        </Text>
                      ))}
                    </View>
                    {block.rows.map((row) => (
                      <View
                        key={JSON.stringify(row)}
                        className="flex-row border-b border-border last:border-b-0"
                      >
                        {block.columns.map((column, columnIndex) => (
                          <Text
                            key={column}
                            selectable
                            className="w-36 px-3 py-2 text-xs text-foreground-secondary"
                          >
                            {row[columnIndex] ?? ""}
                          </Text>
                        ))}
                      </View>
                    ))}
                  </View>
                </ScrollView>
              );
          }
        })
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("refresh")}
        className="self-start rounded-xl border border-border px-3 py-2 active:bg-subtle"
        onPress={() => void props.onRefresh()}
      >
        <Text className="text-xs font-codework-medium text-foreground-secondary">
          {t("refresh")}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

type ThreadFilesRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

type ThreadFileRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly path: string[];
  readonly line?: string;
}>;

function useThreadFilesWorkspace(params: {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
}) {
  const routeEnvironmentId = firstRouteParam(params.environmentId);
  const routeThreadId = firstRouteParam(params.threadId);
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const environmentId =
    routeEnvironmentId !== null
      ? EnvironmentId.make(routeEnvironmentId)
      : (selectedThread?.environmentId ?? null);
  const threadId = routeThreadId !== null ? ThreadId.make(routeThreadId) : null;
  const project = selectedThreadProject as {
    readonly title?: string;
    readonly workspaceRoot?: string;
  } | null;

  return {
    cwd: selectedThreadCwd ?? project?.workspaceRoot ?? null,
    environmentId,
    projectName: project?.title ?? "Files",
    selectedThread,
    threadId,
  };
}

function FilesUnavailable() {
  return (
    <View className="flex-1 items-center justify-center bg-sheet px-6">
      <NativeStackScreenOptions options={{ title: t("surface.files") }} />
      <EmptyState
        title={t("filesUnavailable")}
        detail={t("thisThreadDoesNotHaveAnActiveWorkspacePath")}
      />
    </View>
  );
}

function FilesToolbarBottomFade() {
  const sheetColor = String(useThemeColor("--color-sheet"));

  if (process.env.EXPO_OS !== "ios") {
    return null;
  }

  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="absolute inset-x-0 bottom-0 z-[1] h-28"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id="files-toolbar-bottom-fade" x1="0%" x2="0%" y1="0%" y2="100%">
            <Stop offset="0%" stopColor={sheetColor} stopOpacity={0} />
            <Stop offset="58%" stopColor={sheetColor} stopOpacity={0.72} />
            <Stop offset="100%" stopColor={sheetColor} stopOpacity={0.96} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#files-toolbar-bottom-fade)" />
      </Svg>
    </View>
  );
}

export function ThreadFilesTreeScreen(props: ThreadFilesRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, layout, panes, showAuxiliaryPane, togglePrimarySidebar } =
    useAdaptiveWorkspaceLayout();
  const [searchQuery, setSearchQuery] = useState("");
  const isAndroid = Platform.OS === "android";
  const { themeAppearance: highlightTheme } = useAppearancePreferences();
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const sheetSurfaceColor = String(useThemeColor("--color-sheet-solid"));
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
  const revealedInspectorRef = useRef(false);
  const entriesQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && !fileInspector.supported
      ? projectEnvironment.listEntries({
          environmentId,
          input: { cwd },
        })
      : null,
  );
  const entriesData = entriesQuery.data as ProjectListEntriesResult | null;
  const handleReturnToThread = useCallback(() => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentId !== null && threadId !== null) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(environmentId),
          threadId: String(threadId),
        }),
      );
    }
  }, [environmentId, navigation, threadId]);

  const handleSelectFile = useCallback(
    (path: string) => {
      if (environmentId === null || threadId === null) {
        return;
      }
      const params = {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      const navigationAction = resolveFileSelectionNavigationAction({
        hasPersistentFileInspector: fileInspector.supported,
      });
      if (navigationAction === "replace") {
        navigation.dispatch(StackActions.replace("ThreadFile", params));
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [environmentId, fileInspector.supported, navigation, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={projectName}
          selectedPath={null}
          onSelectFile={handleSelectFile}
        />
      ) : null,
    [cwd, environmentId, handleSelectFile, projectName],
  );
  const handlePreviewFile = useCallback(
    (relativePath: string) => {
      if (environmentId === null || cwd === null) {
        return;
      }
      preloadWorkspaceFileContents({
        cwd,
        environmentId,
        relativePath,
        theme: highlightTheme,
      });
    },
    [cwd, environmentId, highlightTheme],
  );
  useEffect(() => {
    if (fileInspector.supported && cwd !== null && !revealedInspectorRef.current) {
      revealedInspectorRef.current = true;
      showAuxiliaryPane("inspector");
    }
  }, [cwd, fileInspector.supported, showAuxiliaryPane]);

  if (selectedThread === null || environmentId === null || threadId === null) {
    if (fileInspector.supported) {
      return (
        <ThreadRouteScreen
          onReturnToThread={handleReturnToThread}
          renderInspector={renderInspector}
          route={props.route}
        />
      );
    }
    return <LoadingScreen message="Opening files..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (fileInspector.supported) {
    return (
      <ThreadRouteScreen
        onReturnToThread={handleReturnToThread}
        renderInspector={renderInspector}
        route={props.route}
      />
    );
  }

  const usesCompactMailToolbar =
    Platform.OS === "ios" && !layout.usesSplitView && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;

  return (
    <>
      {/* Static header config (glass preset and title) lives in Stack.tsx. The
          live sheet color stays dynamic here so the FlatList can remain the
          direct scene child for native scroll-edge sampling. */}
      <NativeStackScreenOptions
        options={{
          contentStyle: { backgroundColor: sheetSurfaceColor },
          headerShown: !isAndroid,
          unstable_headerSubtitle:
            Platform.OS === "ios" && projectName.length > 0 ? projectName : undefined,
          // No refresh button: the list already supports pull-to-refresh.
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: setSearchQuery,
                  placeholder: t("searchFiles"),
                  searchTextChangeId: "files-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                placeholder: t("searchFiles"),
                onChangeText: (event) => {
                  setSearchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  setSearchQuery("");
                },
              },
        }}
      />
      {isAndroid ? (
        <>
          <AndroidScreenHeader
            title={t("surface.files")}
            subtitle={projectName}
            onBack={handleReturnToThread}
            actions={[
              {
                accessibilityLabel: t("searchProjectContents"),
                icon: "magnifyingglass",
                onPress: () => {
                  if (environmentId === null || threadId === null) return;
                  navigation.navigate("ThreadFileSearch", {
                    environmentId: String(environmentId),
                    threadId: String(threadId),
                  });
                },
              },
              {
                accessibilityLabel: t("refreshFiles"),
                icon: "arrow.clockwise",
                onPress: entriesQuery.refresh,
              },
            ]}
          />
          <View className="flex-row items-center gap-2 border-b border-border px-3 py-2">
            <SymbolView name="magnifyingglass" size={17} tintColor={iconColor} type="monochrome" />
            <TextInput
              accessibilityLabel={t("searchFiles")}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 flex-1 rounded-xl py-2 text-sm"
              placeholder={t("searchFiles")}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
          </View>
        </>
      ) : (
        <>
          {layout.usesSplitView ? (
            <NativeHeaderToolbar placement="left">
              <NativeHeaderToolbar.Button
                accessibilityLabel={
                  panes.primarySidebarVisible ? t("maximizeFiles") : t("showThreads")
                }
                icon={
                  panes.primarySidebarVisible
                    ? "arrow.up.left.and.arrow.down.right"
                    : "sidebar.left"
                }
                onPress={togglePrimarySidebar}
                separateBackground
              />
            </NativeHeaderToolbar>
          ) : null}
          <NativeHeaderToolbar placement="right">
            <NativeHeaderToolbar.Button
              accessibilityLabel={t("searchProjectContents")}
              icon="magnifyingglass"
              onPress={() => {
                if (environmentId === null || threadId === null) return;
                navigation.navigate("ThreadFileSearch", {
                  environmentId: String(environmentId),
                  threadId: String(threadId),
                });
              }}
            />
          </NativeHeaderToolbar>
          {usesCompactMailToolbar ? null : (
            <NativeHeaderToolbar placement="bottom">
              <NativeHeaderToolbar.SearchBarSlot />
            </NativeHeaderToolbar>
          )}
        </>
      )}
      <FileTreeBrowser
        entries={entriesData?.entries ?? []}
        error={entriesQuery.error}
        isPending={entriesQuery.isPending}
        searchQuery={searchQuery}
        selectedPath={null}
        onPreviewFile={handlePreviewFile}
        onRefresh={entriesQuery.refresh}
        onSelectFile={handleSelectFile}
      />
      <FilesToolbarBottomFade />
    </>
  );
}

export function ThreadFileScreen(props: ThreadFileRouteScreenProps) {
  useAdaptiveWorkspacePaneRole("inspector");
  const navigation = useNavigation();
  const { fileInspector, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const iconColor = useThemeColor("--color-icon");
  const params = props.route.params;
  const relativePath = normalizeRoutePath(params.path);
  const targetLine = normalizeRouteLine(firstRouteParam(params.line));
  const { cwd, environmentId, projectName, selectedThread, threadId } = useThreadFilesWorkspace(
    props.route.params,
  );
  const [modeOverride, setModeOverride] = useState<{
    readonly path: string;
    readonly mode: FileViewMode;
  } | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const isBrowserFile = relativePath !== null && isBrowserPreviewFile(relativePath);
  const isImageFile = relativePath !== null && isImagePreviewFile(relativePath);
  const canPreview =
    relativePath !== null && (isMarkdownPreviewFile(relativePath) || isBrowserFile || isImageFile);
  const activeMode =
    relativePath !== null && modeOverride?.path === relativePath
      ? modeOverride.mode
      : defaultViewMode(relativePath);
  const resolvedActiveMode = canPreview ? activeMode : "source";
  const assetPreviewPath = isBrowserFile || isImageFile ? relativePath : null;
  const assetPreviewUri = useWorkspaceFileAssetUrl({
    cwd,
    environmentId,
    relativePath: assetPreviewPath,
    threadId,
  });
  const previewUri =
    assetPreviewUri === null || previewRevision === 0
      ? assetPreviewUri
      : `${assetPreviewUri}${assetPreviewUri.includes("?") ? "&" : "?"}revision=${previewRevision}`;
  const needsFileContents =
    relativePath !== null &&
    (resolvedActiveMode === "source" || isMarkdownPreviewFile(relativePath));
  const fileQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && relativePath !== null && needsFileContents
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd, relativePath },
        })
      : null,
  );
  const fileData = fileQuery.data as ProjectReadFileResult | null;
  const isCanvasFile = relativePath !== null && isCodeworkCanvasArtifactPath(relativePath);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const [isEditing, setIsEditing] = useState(false);
  const [editContents, setEditContents] = useState("");
  const [isSavingFile, setIsSavingFile] = useState(false);
  const [fileEditError, setFileEditError] = useState<string | null>(null);
  const canEditFile = canEditWorkspaceFile({
    relativePath,
    fileLoaded: fileData !== null,
    truncated: fileData?.truncated ?? false,
    isCanvas: isCanvasFile,
    viewMode: resolvedActiveMode,
  });
  const hasUnsavedFileChanges =
    isEditing && fileData !== null && editContents !== fileData.contents;

  useEffect(() => {
    if (!isEditing && fileData !== null) {
      setEditContents(fileData.contents);
    }
  }, [fileData, isEditing]);

  usePreventRemove(hasUnsavedFileChanges, ({ data }) => {
    Alert.alert(t("fileUnsavedChanges"), t("fileUnsavedChangesDescription"), [
      { text: t("keepEditing"), style: "cancel" },
      {
        text: t("discardChanges"),
        style: "destructive",
        onPress: () => {
          setIsEditing(false);
          navigation.dispatch(data.action);
        },
      },
    ]);
  });

  const startEditing = useCallback(() => {
    if (!canEditFile || fileData === null) return;
    setFileEditError(null);
    setEditContents(fileData.contents);
    setIsEditing(true);
  }, [canEditFile, fileData]);

  const cancelEditing = useCallback(() => {
    if (!hasUnsavedFileChanges) {
      setIsEditing(false);
      return;
    }
    Alert.alert(t("fileUnsavedChanges"), t("fileUnsavedChangesDescription"), [
      { text: t("keepEditing"), style: "cancel" },
      {
        text: t("discardChanges"),
        style: "destructive",
        onPress: () => {
          setIsEditing(false);
          setFileEditError(null);
        },
      },
    ]);
  }, [hasUnsavedFileChanges]);

  const saveFile = useCallback(async () => {
    if (
      !hasUnsavedFileChanges ||
      environmentId === null ||
      cwd === null ||
      relativePath === null ||
      isSavingFile
    ) {
      return;
    }
    setIsSavingFile(true);
    setFileEditError(null);
    const result = await writeFile({
      environmentId,
      input: { cwd, relativePath, contents: editContents },
    });
    setIsSavingFile(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setFileEditError(failure instanceof Error ? failure.message : t("fileSaveFailed"));
      }
      return;
    }
    setIsEditing(false);
    fileQuery.refresh();
  }, [
    cwd,
    editContents,
    environmentId,
    fileQuery,
    hasUnsavedFileChanges,
    isSavingFile,
    relativePath,
    writeFile,
  ]);

  const handleSelectFile = useCallback(
    (path: string, line?: number) => {
      navigation.navigate("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        path: path.split("/").filter(Boolean),
        ...(line === undefined ? {} : { line: String(line) }),
      });
    },
    [environmentId, navigation, threadId],
  );
  const renderInspector = useCallback(
    (headerInset: number) =>
      fileInspector.supported && environmentId !== null && cwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={cwd}
          environmentId={environmentId}
          headerInset={headerInset}
          projectName={projectName}
          selectedPath={relativePath}
          onSelectFile={handleSelectFile}
        />
      ) : undefined,
    [cwd, environmentId, fileInspector.supported, handleSelectFile, projectName, relativePath],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // pane brings its own nested native header; elsewhere it pads itself below
  // the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  // Hand the file navigator to the workspace so it renders beside the
  // navigator, outside this screen's native header.
  const renderWorkspaceInspector = useCallback(
    () => renderInspector(inspectorHeaderInset),
    [inspectorHeaderInset, renderInspector],
  );
  useRegisterWorkspaceInspector(fileInspector.supported ? renderWorkspaceInspector : undefined);

  if (selectedThread === null || environmentId === null || threadId === null) {
    return <LoadingScreen message="Opening file..." messagePlacement="above-spinner" />;
  }

  if (cwd === null) {
    return <FilesUnavailable />;
  }

  if (relativePath === null) {
    return (
      <View className="flex-1 items-center justify-center bg-sheet px-6">
        <NativeStackScreenOptions options={{ title: t("surface.files") }} />
        <EmptyState title={t("fileUnavailable")} detail={t("thisFilePathIsInvalid")} />
      </View>
    );
  }

  const parentDir = relativePath.split("/").slice(0, -1).join("/");
  const headerSubtitle = [projectName, parentDir].filter(Boolean).join(" · ");

  return (
    <ReviewHighlighterProvider>
      <View className="flex-1 bg-sheet">
        <NativeStackScreenOptions
          options={{
            // Static header config lives in Stack.tsx (SOLID_HEADER_OPTIONS: solid
            // sheet-colored header — this route's content scrolls internally, so
            // there is nothing for glass to sample). Only dynamic values here.
            headerTintColor: iconColor,
            headerTitle: basename(relativePath),
            title: basename(relativePath),
            unstable_headerSubtitle:
              Platform.OS === "ios" && headerSubtitle.length > 0 ? headerSubtitle : undefined,
          }}
        />
        <WorkspaceSidebarToolbar>
          {fileInspector.supported ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={t("returnToChat")}
              icon="chevron.left"
              onPress={() => {
                navigation.dispatch(
                  StackActions.replace("Thread", {
                    environmentId: String(environmentId),
                    threadId: String(threadId),
                  }),
                );
              }}
            />
          ) : null}
        </WorkspaceSidebarToolbar>
        <NativeHeaderToolbar placement="right">
          {fileInspector.supported ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={
                panes.auxiliaryPaneVisible ? t("hideFileNavigator") : t("showFileNavigator")
              }
              icon="sidebar.right"
              onPress={toggleAuxiliaryPane}
              separateBackground
            />
          ) : null}
          <NativeHeaderToolbar.Menu accessibilityLabel={t("fileActions")} icon="ellipsis">
            {isEditing ? (
              <>
                <NativeHeaderToolbar.MenuAction
                  disabled={isSavingFile || !hasUnsavedFileChanges}
                  icon="checkmark"
                  onPress={() => void saveFile()}
                >
                  {isSavingFile ? t("fileSaving") : t("save")}
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  destructive
                  disabled={isSavingFile}
                  icon="xmark"
                  onPress={cancelEditing}
                >
                  {t("cancel")}
                </NativeHeaderToolbar.MenuAction>
              </>
            ) : canEditFile ? (
              <NativeHeaderToolbar.MenuAction icon="pencil" onPress={startEditing}>
                {t("edit")}
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {canPreview && !isImageFile ? (
              <NativeHeaderToolbar.Menu inline>
                <NativeHeaderToolbar.MenuAction
                  icon="eye"
                  isOn={resolvedActiveMode === "preview"}
                  onPress={() => setModeOverride({ path: relativePath, mode: "preview" })}
                >
                  {t("preview")}
                </NativeHeaderToolbar.MenuAction>
                <NativeHeaderToolbar.MenuAction
                  icon="doc.text"
                  isOn={resolvedActiveMode === "source"}
                  onPress={() => setModeOverride({ path: relativePath, mode: "source" })}
                >
                  {t("source")}
                </NativeHeaderToolbar.MenuAction>
              </NativeHeaderToolbar.Menu>
            ) : null}
            <NativeHeaderToolbar.MenuAction
              icon="doc.on.doc"
              onPress={() => copyTextWithHaptic(relativePath)}
            >
              {t("copyPath")}
            </NativeHeaderToolbar.MenuAction>
            {isBrowserFile && typeof assetPreviewUri === "string" ? (
              <NativeHeaderToolbar.MenuAction
                icon="safari"
                onPress={() => {
                  void tryOpenExternalUrl(assetPreviewUri, "file-preview");
                }}
              >
                {t("openInSafari")}
              </NativeHeaderToolbar.MenuAction>
            ) : null}
            {resolvedActiveMode === "preview" && (isBrowserFile || isImageFile) ? (
              <NativeHeaderToolbar.MenuAction
                icon="arrow.clockwise"
                onPress={() => {
                  setPreviewRevision((current) => current + 1);
                }}
              >
                {t("refresh")}
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
        {isEditing ? (
          <View className="flex-1 bg-sheet">
            {fileEditError ? (
              <Text className="border-b border-danger-border bg-danger-surface px-4 py-2 text-xs text-danger-foreground">
                {fileEditError}
              </Text>
            ) : null}
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isSavingFile}
              multiline
              onChangeText={setEditContents}
              scrollEnabled
              style={{ textAlignVertical: "top" }}
              value={editContents}
              className="flex-1 rounded-none border-0 bg-transparent px-4 py-3 font-mono text-sm leading-5"
            />
          </View>
        ) : isCanvasFile ? (
          <CanvasFileContent
            fileContents={fileData?.contents ?? null}
            fileError={fileQuery.error}
            relativePath={relativePath}
            truncated={fileData?.truncated ?? false}
            onOpenFile={handleSelectFile}
            onRefresh={() => fileQuery.refresh()}
          />
        ) : (
          <FileContent
            activeMode={resolvedActiveMode}
            previewUri={previewUri}
            fileContents={fileData?.contents ?? null}
            fileError={fileQuery.error}
            initialLine={targetLine}
            relativePath={relativePath}
            truncated={fileData?.truncated ?? false}
            onRefresh={() => fileQuery.refresh()}
          />
        )}
      </View>
    </ReviewHighlighterProvider>
  );
}
