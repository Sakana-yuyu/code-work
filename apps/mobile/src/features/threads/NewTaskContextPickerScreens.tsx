import type { VcsRef } from "@codework/client-runtime/state/vcs";
import type { GitResolvedPullRequest } from "@codework/contracts";
import { parsePullRequestReference } from "@codework/shared/pullRequestReference";
import { LegendList } from "@legendapp/list/react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useFontFamily } from "../../lib/useFontFamily";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useAtomCommand } from "../../state/use-atom-command";
import { gitEnvironment } from "../../state/git";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { shouldCheckoutNewTaskBranch } from "./new-task-context-presentation";
import { t } from "../../i18n";

function SelectionRow(props: {
  readonly icon?: "arrow.triangle.branch" | "desktopcomputer";
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const checkmarkColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={17} tintColor={iconColor} type="monochrome" />
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-codework-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColor={checkmarkColor}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function ToggleRow(props: {
  readonly title: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 bg-card px-4 py-3">
      <Text
        className="min-w-0 flex-1 text-base font-codework-medium text-foreground"
        numberOfLines={1}
      >
        {props.title}
      </Text>
      <ThemedSwitch
        accessibilityLabel={props.title}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

function BranchSelectionRow(props: {
  readonly badge: string | null;
  readonly branch: VcsRef;
  readonly disabled: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onSelect: (branch: VcsRef) => void;
  readonly selected: boolean;
}) {
  const onPress = useCallback(() => props.onSelect(props.branch), [props.branch, props.onSelect]);

  return (
    <View
      className={cn(
        props.isFirst && "overflow-hidden rounded-t-2xl",
        props.isLast && "overflow-hidden rounded-b-2xl",
      )}
    >
      <SelectionRow
        icon="arrow.triangle.branch"
        disabled={props.disabled}
        isLast={props.isLast}
        onPress={onPress}
        selected={props.selected}
        subtitle={props.badge ? props.badge.toUpperCase() : undefined}
        title={props.branch.name}
      />
    </View>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>;
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: t("environment"),
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={t("environment")} onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <PickerSurface>
          {flow.environments.map((environment, index) => (
            <SelectionRow
              key={String(environment.environmentId)}
              icon="desktopcomputer"
              isLast={index === flow.environments.length - 1}
              onPress={() => {
                void Haptics.selectionAsync();
                flow.selectEnvironment(environment.environmentId);
                navigation.goBack();
              }}
              selected={flow.selectedEnvironmentId === environment.environmentId}
              title={environment.environmentLabel}
            />
          ))}
        </PickerSurface>
      </ScrollView>
    </View>
  );
}

export function NewTaskBranchPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const placeholderColor = useThemeColor("--color-placeholder");
  const foregroundColor = useThemeColor("--color-foreground");
  const fontFamily = useFontFamily("regular");
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(null);
  const [preparingPullRequestMode, setPreparingPullRequestMode] = useState<
    "local" | "worktree" | null
  >(null);
  const [pullRequestInput, setPullRequestInput] = useState("");
  const selectingBranchNameRef = useRef<string | null>(null);
  const preparingPullRequestModeRef = useRef<"local" | "worktree" | null>(null);
  const allowSelectionNavigationRef = useRef(false);
  const mountedRef = useRef(true);
  const screenTitle =
    flow.workspaceMode === "worktree" ? t("interface.base-branch") : t("gitCommit.branch");
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const selectedBranchName =
    flow.selectedBranchName ??
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const branchListContentStyle = useMemo(
    () => ({
      paddingBottom: usesNativeMailSearchToolbar
        ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
        : Platform.OS === "ios"
          ? 16
          : Math.max(insets.bottom, 16) + 16,
      paddingHorizontal: 16,
      paddingTop: 12,
    }),
    [insets.bottom, usesNativeMailSearchToolbar],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flow.setBranchQuery("");
    };
  }, [flow.setBranchQuery]);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (
          (selectingBranchNameRef.current !== null ||
            preparingPullRequestModeRef.current !== null) &&
          !allowSelectionNavigationRef.current
        ) {
          event.preventDefault();
        }
      }),
    [navigation],
  );

  const pullRequestReference = useMemo(
    () => parsePullRequestReference(pullRequestInput),
    [pullRequestInput],
  );
  const pullRequestResolution = useEnvironmentQuery(
    flow.selectedProject !== null &&
      flow.selectedProject.workspaceRoot.length > 0 &&
      pullRequestReference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: flow.selectedProject.environmentId,
          input: {
            cwd: flow.selectedProject.workspaceRoot,
            reference: pullRequestReference,
          },
        })
      : null,
  );
  const resolvedPullRequest: GitResolvedPullRequest | null =
    pullRequestResolution.data?.pullRequest ?? null;
  const pullRequestInputInvalid =
    pullRequestInput.trim().length > 0 && pullRequestReference === null;
  const preparePullRequest = useCallback(
    async (mode: "local" | "worktree") => {
      if (
        pullRequestReference === null ||
        resolvedPullRequest === null ||
        flow.selectedProject === null ||
        preparingPullRequestModeRef.current !== null
      ) {
        return;
      }
      preparingPullRequestModeRef.current = mode;
      setPreparingPullRequestMode(mode);
      const result = await preparePullRequestThread({
        environmentId: flow.selectedProject.environmentId,
        input: {
          cwd: flow.selectedProject.workspaceRoot,
          reference: pullRequestReference,
          mode,
        },
      });
      preparingPullRequestModeRef.current = null;
      setPreparingPullRequestMode(null);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result) && mountedRef.current && navigation.isFocused()) {
          const error = squashAtomCommandFailure(result);
          Alert.alert(
            t("couldNotCheckoutPullRequest"),
            error instanceof Error ? error.message : t("thePullRequestCouldNotBeCheckedOut"),
          );
        }
        return;
      }

      // 服务端负责 checkout/worktree；保存其确切结果，让新线程复用用户刚看到的远程工作区。
      flow.setPreparedWorkspace({
        mode,
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
      setPullRequestInput("");
      flow.setBranchQuery("");
      if (mountedRef.current && navigation.isFocused()) {
        allowSelectionNavigationRef.current = true;
        navigation.goBack();
      }
      allowSelectionNavigationRef.current = false;
    },
    [flow, navigation, preparePullRequestThread, pullRequestReference, resolvedPullRequest],
  );

  const selectBranch = useCallback(
    async (branch: VcsRef) => {
      if (selectingBranchNameRef.current !== null) {
        return;
      }
      selectingBranchNameRef.current = branch.name;
      void Haptics.selectionAsync();

      try {
        let selectedBranch = branch;
        const needsCheckout = shouldCheckoutNewTaskBranch({
          branchIsCurrent: branch.current,
          branchWorktreePath: branch.worktreePath,
          workspaceMode: flow.workspaceMode,
        });
        if (needsCheckout && flow.selectedProject) {
          setSwitchingBranchName(branch.name);
          const result = await switchRef({
            environmentId: flow.selectedProject.environmentId,
            input: {
              cwd: flow.selectedProject.workspaceRoot,
              refName: branch.name,
            },
          });
          if (result._tag === "Failure") {
            if (mountedRef.current && navigation.isFocused() && !isAtomCommandInterrupted(result)) {
              const error = squashAtomCommandFailure(result);
              Alert.alert(
                t("couldNotSwitchBranch"),
                error instanceof Error ? error.message : t("theBranchCouldNotBeCheckedOut"),
              );
            }
            return;
          }
          selectedBranch = {
            ...branch,
            current: true,
            isRemote: false,
            name: result.value.refName ?? branch.name,
          };
        }

        // The checkout has already changed the repository. Persist the matching
        // draft selection even if the native sheet was dismissed while the
        // command was in flight; only visible-screen work is focus-gated below.
        flow.selectBranch(selectedBranch);
        if (!mountedRef.current || !navigation.isFocused()) {
          return;
        }
        flow.setBranchQuery("");
        allowSelectionNavigationRef.current = true;
        navigation.goBack();
      } finally {
        selectingBranchNameRef.current = null;
        allowSelectionNavigationRef.current = false;
        if (mountedRef.current) {
          setSwitchingBranchName(null);
        }
      }
    },
    [
      flow.selectBranch,
      flow.selectedProject,
      flow.setBranchQuery,
      flow.workspaceMode,
      navigation,
      switchRef,
    ],
  );

  const renderBranch = useCallback(
    ({ item, index }: { readonly item: VcsRef; readonly index: number }) => (
      <BranchSelectionRow
        badge={branchBadgeLabel({ branch: item, project: flow.selectedProject })}
        branch={item}
        disabled={switchingBranchName !== null}
        isFirst={index === 0}
        isLast={index === flow.filteredBranches.length - 1}
        onSelect={selectBranch}
        selected={selectedBranchName === item.name}
      />
    ),
    [
      flow.filteredBranches.length,
      flow.selectedProject,
      selectBranch,
      selectedBranchName,
      switchingBranchName,
    ],
  );

  const branchListHeader = (
    <View className="gap-3">
      <View className="overflow-hidden rounded-2xl bg-card">
        <View className="gap-2 px-4 py-4">
          <Text className="text-foreground-secondary text-2xs font-codework-bold tracking-[1px] uppercase">
            {t("git.checkoutPullRequest")}
          </Text>
          <Text className="text-xs leading-snug text-foreground-muted">
            {t("git.checkoutPullRequestDescription")}
          </Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-xl bg-subtle px-4 text-base text-foreground"
            onChangeText={setPullRequestInput}
            placeholder={t("git.pullRequestReferencePlaceholder")}
            placeholderTextColor={placeholderColor}
            style={{ color: foregroundColor, fontFamily }}
            value={pullRequestInput}
          />
          {pullRequestInputInvalid ? (
            <Text className="text-xs text-danger-foreground">
              {t("git.pullRequestReferenceInvalid")}
            </Text>
          ) : null}
          {pullRequestResolution.isPending && pullRequestReference !== null ? (
            <Text className="text-xs text-foreground-muted">
              {t("git.preparingPullRequestThread")}
            </Text>
          ) : null}
          {resolvedPullRequest ? (
            <View className="gap-0.5 rounded-xl border border-border-subtle bg-subtle px-3 py-2">
              <Text className="text-sm font-codework-bold text-foreground" numberOfLines={1}>
                {resolvedPullRequest.title}
              </Text>
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} →{" "}
                {resolvedPullRequest.baseBranch}
              </Text>
            </View>
          ) : null}
          {pullRequestResolution.error ? (
            <Text className="text-xs text-danger-foreground">{pullRequestResolution.error}</Text>
          ) : null}
          <View className="flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              className="flex-1 rounded-full bg-subtle px-3 py-2 active:opacity-70"
              disabled={
                preparingPullRequestMode !== null ||
                resolvedPullRequest === null ||
                pullRequestResolution.isPending
              }
              onPress={() => void preparePullRequest("local")}
            >
              <Text className="text-center text-sm font-codework-medium text-foreground">
                {preparingPullRequestMode === "local"
                  ? t("git.preparingPullRequestThread")
                  : t("git.pullRequestCheckoutLocal")}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              className="flex-1 rounded-full bg-accent px-3 py-2 active:opacity-70"
              disabled={
                preparingPullRequestMode !== null ||
                resolvedPullRequest === null ||
                pullRequestResolution.isPending
              }
              onPress={() => void preparePullRequest("worktree")}
            >
              <Text className="text-center text-sm font-codework-medium text-white">
                {preparingPullRequestMode === "worktree"
                  ? t("git.preparingPullRequestThread")
                  : t("git.pullRequestCheckoutWorktree")}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
      {flow.workspaceMode === "worktree" ? (
        <View className="overflow-hidden rounded-2xl">
          <ToggleRow
            onValueChange={flow.setStartFromOrigin}
            title={t("settings.startFromOrigin")}
            value={flow.startFromOrigin}
          />
        </View>
      ) : null}
    </View>
  );

  const branchContent =
    flow.filteredBranches.length === 0 ? (
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 12 }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        {branchListHeader}
        <View
          className="flex-1 items-center justify-center gap-3 px-4"
          style={{
            marginBottom: usesNativeMailSearchToolbar
              ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
              : 0,
          }}
        >
          {flow.branchesLoading ? <ActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">
            {flow.branchesLoading
              ? t("loadingBranches2")
              : flow.branchesError
                ? flow.branchesError
                : flow.branchQuery
                  ? t("noMatchingBranches")
                  : t("noBranchesAvailable")}
          </Text>
          {!flow.branchesLoading && flow.branchesError ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-card px-4 py-2 active:opacity-70"
              onPress={flow.loadBranches}
            >
              <Text className="text-sm font-codework-medium text-foreground">{t("tryAgain2")}</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    ) : (
      <LegendList
        alwaysBounceVertical={false}
        automaticallyAdjustsScrollIndicatorInsets
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={branchListContentStyle}
        data={flow.filteredBranches}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(branch) =>
          `${branch.remoteName ?? "local"}:${branch.name}:${branch.worktreePath ?? ""}`
        }
        ListHeaderComponent={branchListHeader}
        ListFooterComponent={
          flow.branchesFetchingNextPage ? (
            <View className="items-center py-4">
              <ActivityIndicator />
            </View>
          ) : null
        }
        onEndReached={flow.hasMoreBranches ? flow.loadMoreBranches : undefined}
        onEndReachedThreshold={0.35}
        renderItem={renderBranch}
        showsVerticalScrollIndicator={false}
      />
    );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title={screenTitle} onBack={() => navigation.goBack()} />
        <View className="px-4 pb-2 pt-3">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-xl bg-card px-4 text-base text-foreground"
            onChangeText={flow.setBranchQuery}
            placeholder={t("findABranch")}
            placeholderTextColor={placeholderColor}
            style={{ color: foregroundColor, fontFamily }}
            value={flow.branchQuery}
          />
        </View>
        {branchContent}
      </View>
    );
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: true,
          title: screenTitle,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: flow.setBranchQuery,
                  placeholder: t("findABranch"),
                  searchTextChangeId: "new-task-branch-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailSearchToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: t("findABranch"),
                onChangeText: (event) => {
                  flow.setBranchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  flow.setBranchQuery("");
                },
              },
        }}
      />
      {usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.SearchBarSlot />
        </NativeHeaderToolbar>
      )}
      {branchContent}
    </>
  );
}
