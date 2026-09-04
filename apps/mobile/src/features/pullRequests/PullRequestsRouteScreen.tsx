import type {
  PullRequestAction,
  PullRequestDetail,
  PullRequestDiffFileContentsResult,
  PullRequestDiffResult,
  PullRequestInvolvement,
  PullRequestListEntry,
  PullRequestListCursors,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestComment,
  PullRequestCommit,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestRef,
  PullRequestReviewCommentDraft,
  PullRequestReviewThread,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidate,
  PullRequestThreadComment,
  PullRequestUpdateMethod,
} from "@codework/contracts";
import { EnvironmentId, ProjectId } from "@codework/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@codework/client-runtime/state/runtime";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsEnvironmentPicker } from "../settings/components/SettingsEnvironmentPicker";
import { SettingsSection } from "../settings/components/SettingsSection";
import { parseUnifiedDiff, type ParsedDiffFile, type ParsedDiffLine } from "../review/diffParser";
import { changeTone, renderVisibleWhitespace } from "../review/reviewDiffRendering";
import {
  mergePullRequestEntries,
  mergePullRequestThreadComments,
  pullRequestDiffFileChangeType,
  pullRequestDiffFilePaths,
  pullRequestReviewPositionForLine,
  pullRequestReviewPositionLine,
} from "./pullRequests.logic";

const LIST_STATES: ReadonlyArray<PullRequestListState> = ["open", "closed", "merged", "all"];
const INVOLVEMENTS: ReadonlyArray<PullRequestInvolvement> = ["all", "reviewing", "authored"];
const DRAFT_FILTERS: ReadonlyArray<NonNullable<PullRequestListFilters["draft"]> | null> = [
  null,
  "only",
  "hide",
];
const REVIEW_FILTERS: ReadonlyArray<NonNullable<PullRequestListFilters["review"]> | null> = [
  null,
  "approved",
  "changes-requested",
  "review-required",
  "none",
];
const CHECK_FILTERS: ReadonlyArray<NonNullable<PullRequestListFilters["checks"]> | null> = [
  null,
  "passing",
  "failing",
];

export function PullRequestsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const [state, setState] = useState<PullRequestListState>("open");
  const [involvement, setInvolvement] = useState<PullRequestInvolvement>("all");
  const [draftFilter, setDraftFilter] = useState<NonNullable<
    PullRequestListFilters["draft"]
  > | null>(null);
  const [reviewFilter, setReviewFilter] = useState<NonNullable<
    PullRequestListFilters["review"]
  > | null>(null);
  const [checksFilter, setChecksFilter] = useState<NonNullable<
    PullRequestListFilters["checks"]
  > | null>(null);
  const [authorFilter, setAuthorFilter] = useState("");
  const [labelFilter, setLabelFilter] = useState("");
  const [excludedLabelFilter, setExcludedLabelFilter] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<PullRequestListCursors | undefined>(undefined);
  const [loadedEntries, setLoadedEntries] = useState<ReadonlyArray<PullRequestListEntry>>([]);
  const environmentId = selectedEnvironmentId;
  const filterKey = `${state}:${involvement}:${draftFilter ?? "all"}:${reviewFilter ?? "all"}:${checksFilter ?? "all"}:${authorFilter.trim()}:${labelFilter.trim()}:${excludedLabelFilter.trim()}:${search.trim()}`;
  const labelGroups = useMemo(
    () =>
      [
        labelFilter
          .split(",")
          .map((value) => value.trim().slice(0, 200))
          .filter((value) => value.length > 0)
          .slice(0, 10),
      ].filter((group) => group.length > 0),
    [labelFilter],
  );
  const excludedLabels = useMemo(
    () =>
      excludedLabelFilter
        .split(",")
        .map((value) => value.trim().slice(0, 200))
        .filter((value) => value.length > 0)
        .slice(0, 10),
    [excludedLabelFilter],
  );
  const filters = useMemo<PullRequestListFilters>(
    () => ({
      ...(draftFilter === null ? {} : { draft: draftFilter }),
      ...(reviewFilter === null ? {} : { review: reviewFilter }),
      ...(checksFilter === null ? {} : { checks: checksFilter }),
      ...(authorFilter.trim().length === 0 ? {} : { author: authorFilter.trim().slice(0, 200) }),
      ...(labelGroups.length === 0 ? {} : { labels: labelGroups }),
      ...(excludedLabels.length === 0 ? {} : { excludedLabels }),
    }),
    [authorFilter, checksFilter, draftFilter, excludedLabels, labelGroups, reviewFilter],
  );
  const input = useMemo(
    () => ({
      state,
      involvement,
      limit: 100,
      ...(Object.keys(filters).length === 0 ? {} : { filters }),
      ...(cursors ? { cursors } : {}),
      ...(search.trim().length > 0 ? { query: search.trim() } : {}),
    }),
    [cursors, filters, involvement, search, state],
  );
  const listQuery = useEnvironmentQuery(
    environmentId === null ? null : pullRequestEnvironment.list({ environmentId, input }),
  );
  const result = listQuery.data;
  const visibleEntries = useMemo(
    () =>
      cursors
        ? mergePullRequestEntries(loadedEntries, result?.entries ?? [])
        : (result?.entries ?? []),
    [cursors, loadedEntries, result?.entries],
  );
  const statsInput = useMemo(
    () =>
      result === null
        ? null
        : {
            refs: visibleEntries.map(({ projectId, repository, number }) => ({
              projectId,
              repository,
              number,
            })),
          },
    [visibleEntries],
  );
  const statsQuery = useEnvironmentQuery(
    environmentId === null || statsInput === null
      ? null
      : pullRequestEnvironment.listStats({ environmentId, input: statsInput }),
  );
  const refresh = useCallback(() => {
    listQuery.refresh();
    statsQuery.refresh();
  }, [listQuery.refresh, statsQuery.refresh]);

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  useEffect(() => {
    setCursors(undefined);
    setLoadedEntries([]);
  }, [filterKey]);

  const changeFilter = useCallback(<T,>(setValue: (value: T) => void, value: T) => {
    setCursors(undefined);
    setLoadedEntries([]);
    setValue(value);
  }, []);

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: t("pullRequestsMobile.title"),
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={t("pullRequestsMobile.title")}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl refreshing={listQuery.isPending && result !== null} onRefresh={refresh} />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("pullRequestsMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={listQuery.isPending}
          onSelect={(next) => {
            setCursors(undefined);
            setLoadedEntries([]);
            setSelectedEnvironmentId(next);
          }}
        />
        <View className="gap-2">
          <SegmentRow
            accessibilityLabel={t("pullRequestsMobile.state")}
            labels={LIST_STATES.map((item) => t(`pullRequestsMobile.state.${item}`))}
            selectedIndex={LIST_STATES.indexOf(state)}
            onSelect={(index) => changeFilter(setState, LIST_STATES[index] ?? "open")}
          />
          <SegmentRow
            accessibilityLabel={t("pullRequestsMobile.involvement")}
            labels={INVOLVEMENTS.map((item) => t(`pullRequestsMobile.involvement.${item}`))}
            selectedIndex={INVOLVEMENTS.indexOf(involvement)}
            onSelect={(index) => changeFilter(setInvolvement, INVOLVEMENTS[index] ?? "all")}
          />
          <SegmentRow
            accessibilityLabel={t("pullRequestsMobile.draftFilter")}
            labels={DRAFT_FILTERS.map((value) =>
              value === null
                ? t("pullRequestsMobile.filter.all")
                : t(`pullRequestsMobile.draftFilter.${value}`),
            )}
            selectedIndex={DRAFT_FILTERS.indexOf(draftFilter)}
            onSelect={(index) => changeFilter(setDraftFilter, DRAFT_FILTERS[index] ?? null)}
          />
          <SegmentRow
            accessibilityLabel={t("pullRequestsMobile.reviewFilter")}
            labels={REVIEW_FILTERS.map((value) =>
              value === null
                ? t("pullRequestsMobile.filter.all")
                : t(`pullRequestsMobile.reviewFilter.${value}`),
            )}
            selectedIndex={REVIEW_FILTERS.indexOf(reviewFilter)}
            onSelect={(index) => changeFilter(setReviewFilter, REVIEW_FILTERS[index] ?? null)}
          />
          <SegmentRow
            accessibilityLabel={t("pullRequestsMobile.checkFilter")}
            labels={CHECK_FILTERS.map((value) =>
              value === null
                ? t("pullRequestsMobile.filter.all")
                : t(`pullRequestsMobile.checkFilter.${value}`),
            )}
            selectedIndex={CHECK_FILTERS.indexOf(checksFilter)}
            onSelect={(index) => changeFilter(setChecksFilter, CHECK_FILTERS[index] ?? null)}
          />
        </View>
        <TextInput
          accessibilityLabel={t("pullRequestsMobile.search")}
          autoCapitalize="none"
          onChangeText={(value) => changeFilter(setSearch, value)}
          placeholder={t("pullRequestsMobile.search")}
          returnKeyType="search"
          value={search}
        />
        <TextInput
          accessibilityLabel={t("pullRequestsMobile.authorFilter")}
          autoCapitalize="none"
          onChangeText={(value) => changeFilter(setAuthorFilter, value)}
          placeholder={t("pullRequestsMobile.authorFilter")}
          value={authorFilter}
        />
        <TextInput
          accessibilityLabel={t("pullRequestsMobile.labelFilter")}
          autoCapitalize="none"
          onChangeText={(value) => changeFilter(setLabelFilter, value)}
          placeholder={t("pullRequestsMobile.labelFilter")}
          value={labelFilter}
        />
        <TextInput
          accessibilityLabel={t("pullRequestsMobile.excludedLabelFilter")}
          autoCapitalize="none"
          onChangeText={(value) => changeFilter(setExcludedLabelFilter, value)}
          placeholder={t("pullRequestsMobile.excludedLabelFilter")}
          value={excludedLabelFilter}
        />
        {environmentId === null ? (
          <StatusMessage text={t("pullRequestsMobile.noEnvironment")} />
        ) : null}
        {listQuery.error ? <StatusMessage text={listQuery.error} tone="danger" /> : null}
        {environmentId !== null && result === null && listQuery.isPending ? (
          <LoadingMessage />
        ) : null}
        {result?.errors.map((error) => (
          <StatusMessage
            key={String(error.projectId)}
            text={`${error.projectTitle}: ${error.message}`}
            tone="danger"
          />
        ))}
        {result !== null && visibleEntries.length === 0 ? (
          <StatusMessage
            text={t("pullRequestsMobile.empty")}
            detail={t("pullRequestsMobile.emptyDescription")}
          />
        ) : null}
        {visibleEntries.map((entry) => (
          <PullRequestListCard
            key={`${entry.projectId}:${entry.repository}:${entry.number}`}
            entry={entry}
            stats={
              statsQuery.data?.stats.find(
                (stat) =>
                  stat.projectId === entry.projectId &&
                  stat.repository === entry.repository &&
                  stat.number === entry.number,
              ) ?? null
            }
            onOpen={() =>
              navigation.navigate("PullRequestDetail", {
                environmentId: String(environmentId),
                projectId: String(entry.projectId),
                repository: entry.repository,
                number: entry.number,
              })
            }
          />
        ))}
        {result?.truncated && Object.keys(result.nextCursors).length > 0 ? (
          <ActionButton
            disabled={listQuery.isPending}
            label={t("pullRequestsMobile.loadMore")}
            onPress={() => {
              setLoadedEntries(visibleEntries);
              setCursors(result.nextCursors);
            }}
          />
        ) : result?.truncated ? (
          <Text className="px-2 text-xs leading-5 text-foreground-muted">
            {t("pullRequestsMobile.truncated")}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

type PullRequestDetailRouteParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
};

export function PullRequestDetailRouteScreen({
  route,
}: StaticScreenProps<PullRequestDetailRouteParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const reference: PullRequestRef = {
    projectId: ProjectId.make(route.params.projectId),
    repository: route.params.repository,
    number: route.params.number,
  };
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const postComment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });
  const updatePullRequest = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const updateComment = useAtomCommand(pullRequestEnvironment.updateComment, {
    reportFailure: false,
  });
  const getDiffFileContents = useAtomCommand(pullRequestEnvironment.diffFileContents, {
    reportFailure: false,
  });
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const setReaction = useAtomCommand(pullRequestEnvironment.setReaction, { reportFailure: false });
  const replyToThread = useAtomCommand(pullRequestEnvironment.replyToThread, {
    reportFailure: false,
  });
  const setThreadResolution = useAtomCommand(pullRequestEnvironment.setThreadResolution, {
    reportFailure: false,
  });
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });
  const loadThreadComments = useAtomCommand(pullRequestEnvironment.threadComments, {
    reportFailure: false,
  });
  const [comment, setComment] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [commentEditDraft, setCommentEditDraft] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [bodyDraft, setBodyDraft] = useState("");
  const [reviewBody, setReviewBody] = useState("");
  const [reviewVerdict, setReviewVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [mergeMethodOverride, setMergeMethodOverride] = useState<PullRequestMergeMethod | null>(
    null,
  );
  const [updateMethodOverride, setUpdateMethodOverride] = useState<PullRequestUpdateMethod | null>(
    null,
  );
  const [inlineReviewComments, setInlineReviewComments] = useState<
    ReadonlyArray<{ readonly lineId: string; readonly draft: PullRequestReviewCommentDraft }>
  >([]);
  const [selectedInlineLine, setSelectedInlineLine] = useState<{
    readonly filePath: string;
    readonly oldPath: string | null;
    readonly line: ParsedDiffLine;
  } | null>(null);
  const [inlineCommentBody, setInlineCommentBody] = useState("");
  const [threadReplyDrafts, setThreadReplyDrafts] = useState<Record<string, string>>({});
  const [threadCommentPages, setThreadCommentPages] = useState<
    Record<string, ReadonlyArray<PullRequestThreadComment>>
  >({});
  const [threadCommentCursors, setThreadCommentCursors] = useState<Record<string, string | null>>(
    {},
  );
  const [loadingThreadComments, setLoadingThreadComments] = useState<string | null>(null);
  const [diffCursor, setDiffCursor] = useState<string | null>(null);
  const [selectedCommitOid, setSelectedCommitOid] = useState<string | null>(null);
  const [diffPages, setDiffPages] = useState<
    ReadonlyArray<{ readonly cursor: string | null; readonly result: PullRequestDiffResult }>
  >([]);
  const [expandedDiffFileIds, setExpandedDiffFileIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [diffFileContents, setDiffFileContents] = useState<
    Readonly<Record<string, PullRequestDiffFileContentsResult>>
  >({});
  const [loadingDiffFileId, setLoadingDiffFileId] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "code">("summary");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = detailQuery.data;
  const activity = activityQuery.data;
  const reviewerCandidatesQuery = useEnvironmentQuery(
    detail?.capabilities.reviewers.listCandidates
      ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference })
      : null,
  );
  const diffQuery = useEnvironmentQuery(
    detail === null
      ? null
      : pullRequestEnvironment.diff({
          environmentId,
          input: {
            ...reference,
            ...(diffCursor === null ? {} : { cursor: diffCursor }),
            ...(selectedCommitOid === null ? {} : { commit: selectedCommitOid }),
          },
        }),
  );
  const diffData = useMemo<PullRequestDiffResult | null>(() => {
    if (diffPages.length === 0) return diffQuery.data;
    const omittedFileStats = new Map<
      string,
      NonNullable<PullRequestDiffResult["omittedFileStats"]>[number]
    >();
    for (const page of diffPages) {
      for (const file of page.result.omittedFileStats ?? []) omittedFileStats.set(file.path, file);
    }
    return {
      patch: diffPages
        .map((page) => page.result.patch)
        .filter((patch) => patch.length > 0)
        .join("\n"),
      truncated: diffPages.some((page) => page.result.truncated),
      nextCursor: diffPages.at(-1)?.result.nextCursor ?? null,
      omittedFileStats: [...omittedFileStats.values()],
    };
  }, [diffPages, diffQuery.data]);
  const refresh = useCallback(() => {
    detailQuery.refresh();
    activityQuery.refresh();
  }, [activityQuery.refresh, detailQuery.refresh]);
  const refreshFromServer = useCallback(async () => {
    await invalidate({ environmentId, input: { reference } });
    setThreadCommentPages({});
    setThreadCommentCursors({});
    setDiffCursor(null);
    setDiffPages([]);
    setExpandedDiffFileIds(new Set());
    setDiffFileContents({});
    setLoadingDiffFileId(null);
    refresh();
  }, [environmentId, invalidate, refresh, reference]);

  useEffect(() => {
    setError(null);
    setDiffCursor(null);
    setDiffPages([]);
    setSelectedCommitOid(null);
    setExpandedDiffFileIds(new Set());
    setDiffFileContents({});
    setLoadingDiffFileId(null);
  }, [
    route.params.environmentId,
    route.params.number,
    route.params.projectId,
    route.params.repository,
  ]);

  useEffect(() => {
    const result = diffQuery.data;
    if (result === null || diffQuery.isPending) return;
    setDiffPages((pages) => {
      const page = { cursor: diffCursor, result };
      const existingIndex = pages.findIndex((entry) => entry.cursor === diffCursor);
      if (existingIndex >= 0) {
        return pages.map((entry, index) => (index === existingIndex ? page : entry));
      }
      return [...pages, page];
    });
  }, [diffCursor, diffQuery.data, diffQuery.isPending]);

  useEffect(() => {
    setDiffCursor(null);
    setDiffPages([]);
    setExpandedDiffFileIds(new Set());
    setDiffFileContents({});
    setLoadingDiffFileId(null);
    setSelectedInlineLine(null);
    setInlineCommentBody("");
    setInlineReviewComments([]);
  }, [selectedCommitOid]);

  useEffect(() => {
    if (
      selectedCommitOid !== null &&
      activity !== null &&
      !activity.commits.some((commit) => commit.oid === selectedCommitOid)
    ) {
      setSelectedCommitOid(null);
    }
  }, [activity, selectedCommitOid]);

  useEffect(() => {
    setTitleDraft(detail?.title ?? "");
    setBodyDraft(detail?.body ?? "");
  }, [detail?.body, detail?.number, detail?.repository, detail?.title]);

  const toggleFullDiffFile = useCallback(
    async (file: ParsedDiffFile) => {
      if (expandedDiffFileIds.has(file.id)) {
        setExpandedDiffFileIds((ids) => {
          const next = new Set(ids);
          next.delete(file.id);
          return next;
        });
        return;
      }
      const cached = diffFileContents[file.id];
      if (cached) {
        setExpandedDiffFileIds((ids) => new Set(ids).add(file.id));
        return;
      }
      const paths = pullRequestDiffFilePaths(file);
      if (paths === null || loadingDiffFileId !== null) return;
      setLoadingDiffFileId(file.id);
      setError(null);
      const result = await getDiffFileContents({
        environmentId,
        input: {
          ...reference,
          ...(selectedCommitOid === null ? {} : { commit: selectedCommitOid }),
          changeType: pullRequestDiffFileChangeType(file),
          ...paths,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        setDiffFileContents((contents) => ({ ...contents, [file.id]: result.value }));
        setExpandedDiffFileIds((ids) => new Set(ids).add(file.id));
      }
      setLoadingDiffFileId(null);
    },
    [
      diffFileContents,
      environmentId,
      expandedDiffFileIds,
      getDiffFileContents,
      loadingDiffFileId,
      reference,
      selectedCommitOid,
    ],
  );

  const submitAction = useCallback(
    async (
      action: PullRequestAction,
      options: {
        readonly mergeMethod?: PullRequestMergeMethod;
        readonly updateMethod?: PullRequestUpdateMethod;
      } = {},
    ) => {
      if (working) return;
      setWorking(true);
      setError(null);
      const result = await runAction({
        environmentId,
        input: { ...reference, action, ...options },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        await refreshFromServer();
      }
      setWorking(false);
    },
    [environmentId, reference, refreshFromServer, runAction, working],
  );

  const confirmAction = useCallback(
    (
      action: PullRequestAction,
      options?: {
        readonly mergeMethod?: PullRequestMergeMethod;
        readonly updateMethod?: PullRequestUpdateMethod;
      },
    ) => {
      const label = actionLabel(action);
      Alert.alert(label, t("pullRequestsMobile.confirmAction", { action: label }), [
        { text: t("cancel"), style: "cancel" },
        {
          text: label,
          style: action === "merge" ? "destructive" : "default",
          onPress: () => void submitAction(action, options),
        },
      ]);
    },
    [submitAction],
  );

  const submitComment = useCallback(async () => {
    const body = comment.trim();
    if (working || body.length === 0) return;
    setWorking(true);
    setError(null);
    const result = await postComment({ environmentId, input: { ...reference, body } });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(commandError(result));
    } else {
      setComment("");
      await refreshFromServer();
    }
    setWorking(false);
  }, [comment, environmentId, postComment, reference, refreshFromServer, working]);

  const saveCommentEdit = useCallback(
    async (item: PullRequestComment) => {
      const body = commentEditDraft.trim();
      if (working || body.length === 0 || item.kind === "review" || !canEditComment(detail, item))
        return;
      setWorking(true);
      setError(null);
      const result = await updateComment({
        environmentId,
        input: { ...reference, commentId: item.id, kind: item.kind, body },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        setEditingCommentId(null);
        await refreshFromServer();
      }
      setWorking(false);
    },
    [commentEditDraft, detail, environmentId, reference, refreshFromServer, updateComment, working],
  );

  const saveDetails = useCallback(async () => {
    if (working || detail === null) return;
    const title = titleDraft.trim();
    if (title.length === 0) {
      setError(t("pullRequestsMobile.titleRequired"));
      return;
    }
    if (title === detail.title && bodyDraft === detail.body) return;
    setWorking(true);
    setError(null);
    const result = await updatePullRequest({
      environmentId,
      input: { ...reference, title, body: bodyDraft },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(commandError(result));
    } else {
      await refreshFromServer();
    }
    setWorking(false);
  }, [
    bodyDraft,
    detail,
    environmentId,
    reference,
    refreshFromServer,
    titleDraft,
    updatePullRequest,
    working,
  ]);

  const submitReviewDraft = useCallback(async () => {
    if (working || detail === null) return;
    const verdict = reviewVerdicts(detail).includes(reviewVerdict)
      ? reviewVerdict
      : (reviewVerdicts(detail)[0] ?? "comment");
    if (
      verdict !== "approve" &&
      reviewBody.trim().length === 0 &&
      inlineReviewComments.length === 0
    ) {
      setError(t("pullRequestsMobile.reviewBodyRequired"));
      return;
    }
    setWorking(true);
    setError(null);
    const result = await submitReview({
      environmentId,
      input: {
        ...reference,
        verdict,
        body: reviewBody,
        comments: inlineReviewComments.map((entry) => entry.draft),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setError(commandError(result));
    } else {
      setReviewBody("");
      setInlineReviewComments([]);
      setSelectedInlineLine(null);
      setInlineCommentBody("");
      await refreshFromServer();
    }
    setWorking(false);
  }, [
    detail,
    environmentId,
    reference,
    refreshFromServer,
    reviewBody,
    reviewVerdict,
    inlineReviewComments,
    submitReview,
    working,
  ]);

  const toggleReaction = useCallback(
    async (
      subjectId: string | undefined,
      content: PullRequestReactionContent,
      reacted: boolean,
    ) => {
      if (working) return;
      setWorking(true);
      setError(null);
      const result = await setReaction({
        environmentId,
        input: { ...reference, ...(subjectId ? { subjectId } : {}), content, reacted },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        await refreshFromServer();
      }
      setWorking(false);
    },
    [environmentId, reference, refreshFromServer, setReaction, working],
  );

  const submitThreadReply = useCallback(
    async (threadId: string) => {
      const body = (threadReplyDrafts[threadId] ?? "").trim();
      if (working || body.length === 0) return;
      setWorking(true);
      setError(null);
      const result = await replyToThread({
        environmentId,
        input: { ...reference, threadId, body },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        setThreadReplyDrafts((drafts) => ({ ...drafts, [threadId]: "" }));
        await refreshFromServer();
      }
      setWorking(false);
    },
    [environmentId, reference, refreshFromServer, replyToThread, threadReplyDrafts, working],
  );

  const toggleThreadResolution = useCallback(
    async (threadId: string, resolved: boolean) => {
      if (working) return;
      setWorking(true);
      setError(null);
      const result = await setThreadResolution({
        environmentId,
        input: { ...reference, threadId, resolved },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        await refreshFromServer();
      }
      setWorking(false);
    },
    [environmentId, reference, refreshFromServer, setThreadResolution, working],
  );

  const toggleReviewer = useCallback(
    async (candidate: PullRequestReviewerCandidate) => {
      if (working) return;
      setWorking(true);
      setError(null);
      const result = await requestReviewers({
        environmentId,
        input: {
          ...reference,
          reviewers: [{ id: candidate.id, kind: candidate.kind }],
          requested: !candidate.isRequested,
        },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        await refreshFromServer();
        reviewerCandidatesQuery.refresh();
      }
      setWorking(false);
    },
    [
      environmentId,
      reference,
      refreshFromServer,
      requestReviewers,
      reviewerCandidatesQuery.refresh,
      working,
    ],
  );

  const loadMoreThreadComments = useCallback(
    async (thread: PullRequestReviewThread) => {
      if (loadingThreadComments !== null) return;
      const cursor =
        thread.id in threadCommentCursors
          ? threadCommentCursors[thread.id]
          : (thread.nextCommentsCursor ?? null);
      if (cursor === null) return;
      setLoadingThreadComments(thread.id);
      setError(null);
      const result = await loadThreadComments({
        environmentId,
        input: { ...reference, threadId: thread.id, cursor },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError(commandError(result));
      } else {
        setThreadCommentPages((pages) => ({
          ...pages,
          [thread.id]: mergePullRequestThreadComments(
            pages[thread.id] ?? [],
            result.value.comments,
          ),
        }));
        setThreadCommentCursors((cursors) => ({
          ...cursors,
          [thread.id]: result.value.nextCursor,
        }));
      }
      setLoadingThreadComments(null);
    },
    [environmentId, loadThreadComments, loadingThreadComments, reference, threadCommentCursors],
  );

  const mergeMethods =
    detail?.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method]) ?? [];
  const mergeMethod =
    mergeMethodOverride !== null && mergeMethods.includes(mergeMethodOverride)
      ? mergeMethodOverride
      : (mergeMethods[0] ?? null);
  const updateMethods =
    detail?.viewerPermissions.updateMethods ?? detail?.capabilities.updateMethods ?? [];
  const updateMethod =
    updateMethodOverride !== null && updateMethods.includes(updateMethodOverride)
      ? updateMethodOverride
      : (updateMethods[0] ?? null);
  const offeredReviewVerdicts = detail === null ? [] : reviewVerdicts(detail);
  const selectedReviewVerdict = offeredReviewVerdicts.includes(reviewVerdict)
    ? reviewVerdict
    : (offeredReviewVerdicts[0] ?? "comment");

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: detail?.title ?? t("pullRequestsMobile.detail"),
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={detail?.title ?? t("pullRequestsMobile.detail")}
          subtitle={detail ? `#${detail.number} · ${detail.repository}` : null}
          onBack={() => navigation.goBack()}
          actions={[
            {
              accessibilityLabel: t("pullRequestsMobile.openExternal"),
              icon: "safari",
              onPress: () => detail && void tryOpenExternalUrl(detail.url, "pull-request"),
            },
          ]}
        />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={detailQuery.isPending && detail !== null}
            onRefresh={refreshFromServer}
          />
        }
      >
        {detail === null && detailQuery.isPending ? <LoadingMessage /> : null}
        {detailQuery.error ? <StatusMessage text={detailQuery.error} tone="danger" /> : null}
        {error ? <StatusMessage text={error} tone="danger" /> : null}
        {detail ? (
          <>
            <SegmentRow
              accessibilityLabel={t("pullRequestsMobile.view")}
              labels={[t("pullRequestsMobile.summary"), t("pullRequestsMobile.code")]}
              selectedIndex={tab === "summary" ? 0 : 1}
              onSelect={(index) => setTab(index === 1 ? "code" : "summary")}
            />
            {tab === "code" ? (
              <SettingsSection title={t("pullRequestsMobile.code")} card>
                <View className="p-3">
                  {activity?.commits.length ? (
                    <CommitScopePicker
                      commits={activity.commits}
                      selectedCommitOid={selectedCommitOid}
                      onSelect={setSelectedCommitOid}
                    />
                  ) : null}
                  {diffQuery.isPending && diffData === null ? <LoadingMessage /> : null}
                  {diffQuery.error ? <StatusMessage text={diffQuery.error} tone="danger" /> : null}
                  {diffData ? (
                    <>
                      <PullRequestDiffView
                        canComment={
                          detail.capabilities.review.inlineComment &&
                          detail.viewerPermissions.comment &&
                          selectedCommitOid === null
                        }
                        onSelectLine={(file, line) => {
                          const filePath = file.newPath ?? file.oldPath;
                          if (filePath === null) return;
                          setSelectedInlineLine({
                            filePath,
                            oldPath:
                              file.oldPath !== null && file.oldPath !== filePath
                                ? file.oldPath
                                : null,
                            line,
                          });
                          setInlineCommentBody("");
                        }}
                        patch={diffData.patch}
                        expandedFileIds={expandedDiffFileIds}
                        fileContents={diffFileContents}
                        loadingFileId={loadingDiffFileId}
                        onToggleFullFile={(file) => void toggleFullDiffFile(file)}
                        selectedLineId={
                          selectedInlineLine
                            ? `${selectedInlineLine.filePath}:${selectedInlineLine.line.id}`
                            : null
                        }
                      />
                      {selectedInlineLine ? (
                        <View className="mt-3 gap-2">
                          <Text className="text-xs text-foreground-muted">
                            {t("pullRequestsMobile.inlineCommentOn", {
                              path: selectedInlineLine.filePath,
                              line:
                                selectedInlineLine.line.newLine ??
                                selectedInlineLine.line.oldLine ??
                                0,
                            })}
                          </Text>
                          <TextInput
                            accessibilityLabel={t("pullRequestsMobile.inlineComment")}
                            editable={!working}
                            multiline
                            onChangeText={setInlineCommentBody}
                            placeholder={t("pullRequestsMobile.inlineCommentPlaceholder")}
                            textAlignVertical="top"
                            value={inlineCommentBody}
                          />
                          <View className="flex-row flex-wrap gap-2">
                            <ActionButton
                              disabled={working || inlineCommentBody.trim().length === 0}
                              emphasized
                              label={t("pullRequestsMobile.addLineComment")}
                              onPress={() => {
                                const body = inlineCommentBody.trim();
                                const position = pullRequestReviewPositionForLine(
                                  selectedInlineLine.line,
                                );
                                if (body.length === 0 || position === null) return;
                                const lineId = `${selectedInlineLine.filePath}:${selectedInlineLine.line.id}`;
                                const draft: PullRequestReviewCommentDraft = {
                                  path: selectedInlineLine.filePath,
                                  ...(selectedInlineLine.oldPath === null
                                    ? {}
                                    : { oldPath: selectedInlineLine.oldPath }),
                                  position,
                                  body,
                                };
                                setInlineReviewComments((comments) => {
                                  const index = comments.findIndex(
                                    (entry) => entry.lineId === lineId,
                                  );
                                  if (index < 0) return [...comments, { lineId, draft }];
                                  return comments.map((entry, entryIndex) =>
                                    entryIndex === index ? { lineId, draft } : entry,
                                  );
                                });
                                setSelectedInlineLine(null);
                                setInlineCommentBody("");
                              }}
                            />
                            <ActionButton
                              disabled={working}
                              label={t("cancel")}
                              onPress={() => {
                                setSelectedInlineLine(null);
                                setInlineCommentBody("");
                              }}
                            />
                          </View>
                        </View>
                      ) : null}
                      {diffData.nextCursor !== null ? (
                        <ActionButton
                          disabled={diffQuery.isPending}
                          label={
                            diffQuery.error ? t("retry") : t("pullRequestsMobile.loadMoreDiff")
                          }
                          onPress={() =>
                            diffQuery.error
                              ? diffQuery.refresh()
                              : setDiffCursor(diffData.nextCursor)
                          }
                        />
                      ) : null}
                      {diffData.truncated ? (
                        <StatusMessage text={t("pullRequestsMobile.diffTruncated")} />
                      ) : null}
                      {diffData.omittedFileStats?.length ? (
                        <Text className="mt-2 text-xs leading-5 text-foreground-muted">
                          {t("pullRequestsMobile.omittedFiles", {
                            count: diffData.omittedFileStats.length,
                          })}
                        </Text>
                      ) : null}
                    </>
                  ) : null}
                </View>
              </SettingsSection>
            ) : (
              <>
                <SettingsSection title={t("pullRequestsMobile.summary")} card>
                  <View className="gap-3 p-4">
                    {canEditChangeRequest(detail) ? (
                      <>
                        <TextInput
                          accessibilityLabel={t("pullRequestsMobile.titleField")}
                          editable={!working}
                          onChangeText={setTitleDraft}
                          value={titleDraft}
                        />
                        <TextInput
                          accessibilityLabel={t("pullRequestsMobile.descriptionField")}
                          editable={!working}
                          multiline
                          onChangeText={setBodyDraft}
                          placeholder={t("pullRequestsMobile.descriptionField")}
                          textAlignVertical="top"
                          value={bodyDraft}
                        />
                        <ActionButton
                          disabled={working || titleDraft.trim().length === 0}
                          emphasized
                          label={t("pullRequestsMobile.saveDetails")}
                          onPress={() => void saveDetails()}
                        />
                      </>
                    ) : (
                      <>
                        <Text className="text-lg font-codework-medium text-foreground">
                          {detail.title}
                        </Text>
                        {detail.body ? (
                          <Text className="text-sm leading-5 text-foreground">{detail.body}</Text>
                        ) : null}
                      </>
                    )}
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {`${detail.repository} · #${detail.number}`}
                    </Text>
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {`${detail.headBranch} → ${detail.baseBranch}`}
                    </Text>
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {`${t("pullRequestsMobile.status")}: ${detail.state}${detail.isDraft ? ` · ${t("pullRequestsMobile.draft")}` : ""}`}
                    </Text>
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {t("pullRequestsMobile.stats", {
                        additions: detail.additions,
                        deletions: detail.deletions,
                        files: detail.changedFiles,
                      })}
                    </Text>
                    <Text className="text-sm leading-5 text-foreground-muted">
                      {`${t("pullRequestsMobile.mergeability")}: ${detail.mergeability}`}
                    </Text>
                    {detail.baseComparison === "behind" && detail.behindBy !== undefined ? (
                      <Text className="text-sm leading-5 text-foreground-muted">
                        {t("pullRequestsMobile.behindBy", { count: detail.behindBy })}
                      </Text>
                    ) : null}
                    {detail.autoMergeEnabled !== undefined ? (
                      <Text className="text-sm leading-5 text-foreground-muted">
                        {`${t("pullRequestsMobile.autoMerge")}: ${detail.autoMergeEnabled ? t("pullRequestsMobile.enabled") : t("pullRequestsMobile.disabled")}`}
                      </Text>
                    ) : null}
                    <ReactionRow
                      canReact={detail.capabilities.reactions === true}
                      reactions={activity?.reactions ?? []}
                      onToggle={(content, reacted) =>
                        void toggleReaction(undefined, content, reacted)
                      }
                    />
                    <View className="flex-row flex-wrap gap-2">
                      {detail.viewerPermissions.actions.includes("merge") &&
                      mergeMethods.length > 1 ? (
                        <View className="w-full gap-2">
                          <Text className="text-xs text-foreground-muted">
                            {t("pullRequestsMobile.mergeMethod")}
                          </Text>
                          <SegmentRow
                            accessibilityLabel={t("pullRequestsMobile.mergeMethod")}
                            labels={mergeMethods.map((method) =>
                              t(`pullRequestsMobile.mergeMethod.${method}`),
                            )}
                            selectedIndex={mergeMethods.indexOf(mergeMethod ?? mergeMethods[0]!)}
                            onSelect={(index) =>
                              setMergeMethodOverride(mergeMethods[index] ?? mergeMethods[0] ?? null)
                            }
                          />
                        </View>
                      ) : null}
                      {detail.viewerPermissions.actions.includes("update-branch") &&
                      updateMethods.length > 1 ? (
                        <View className="w-full gap-2">
                          <Text className="text-xs text-foreground-muted">
                            {t("pullRequestsMobile.updateMethod")}
                          </Text>
                          <SegmentRow
                            accessibilityLabel={t("pullRequestsMobile.updateMethod")}
                            labels={updateMethods.map((method) =>
                              t(`pullRequestsMobile.updateMethod.${method}`),
                            )}
                            selectedIndex={updateMethods.indexOf(updateMethod ?? updateMethods[0]!)}
                            onSelect={(index) =>
                              setUpdateMethodOverride(
                                updateMethods[index] ?? updateMethods[0] ?? null,
                              )
                            }
                          />
                        </View>
                      ) : null}
                      <ActionButton
                        label={t("pullRequestsMobile.openExternal")}
                        onPress={() => void tryOpenExternalUrl(detail.url, "pull-request")}
                      />
                      {detail.viewerPermissions.actions.includes("merge") && mergeMethod ? (
                        <ActionButton
                          emphasized
                          disabled={working}
                          label={actionLabel("merge")}
                          onPress={() => confirmAction("merge", { mergeMethod })}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("close") ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("close")}
                          onPress={() => confirmAction("close")}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("reopen") ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("reopen")}
                          onPress={() => void submitAction("reopen")}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("ready") && detail.isDraft ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("ready")}
                          onPress={() => void submitAction("ready")}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("draft") && !detail.isDraft ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("draft")}
                          onPress={() => void submitAction("draft")}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("update-branch") &&
                      updateMethod ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("update-branch")}
                          onPress={() => void submitAction("update-branch", { updateMethod })}
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("enable-auto-merge") ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("enable-auto-merge")}
                          onPress={() =>
                            void submitAction(
                              "enable-auto-merge",
                              mergeMethod ? { mergeMethod } : {},
                            )
                          }
                        />
                      ) : null}
                      {detail.viewerPermissions.actions.includes("disable-auto-merge") ? (
                        <ActionButton
                          disabled={working}
                          label={actionLabel("disable-auto-merge")}
                          onPress={() => void submitAction("disable-auto-merge")}
                        />
                      ) : null}
                    </View>
                  </View>
                </SettingsSection>
                {detail.labels.length > 0 ? (
                  <SettingsSection title={t("pullRequestsMobile.labels")} card>
                    <View className="flex-row flex-wrap gap-2 p-4">
                      {detail.labels.map((label) => (
                        <View key={label.name} className="rounded-full bg-subtle px-3 py-1">
                          <Text className="text-xs text-foreground">{label.name}</Text>
                        </View>
                      ))}
                    </View>
                  </SettingsSection>
                ) : null}
                <SettingsSection title={t("pullRequestsMobile.checks")} card>
                  <View className="gap-2 p-4">
                    {detail.checks.length === 0 ? (
                      <Text className="text-sm text-foreground-muted">
                        {t("pullRequestsMobile.noChecks")}
                      </Text>
                    ) : null}
                    {detail.checks.map((check) => (
                      <Pressable
                        key={check.name}
                        accessibilityLabel={check.url ? check.name : undefined}
                        accessibilityRole={check.url ? "link" : undefined}
                        disabled={check.url === null}
                        onPress={() => {
                          if (check.url) void tryOpenExternalUrl(check.url, "pull-request");
                        }}
                        className="flex-row items-center justify-between gap-3"
                      >
                        <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
                          {check.name}
                        </Text>
                        <Text className="text-xs text-foreground-muted">{check.status}</Text>
                        {check.description ? (
                          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                            {check.description}
                          </Text>
                        ) : null}
                      </Pressable>
                    ))}
                  </View>
                </SettingsSection>
                {activity?.commits.length ? (
                  <SettingsSection title={t("pullRequestsMobile.commits")} card>
                    <View className="gap-3 p-4">
                      {activity.commits.map((commit) => (
                        <View key={commit.oid} className="gap-1 border-b border-border-subtle pb-3">
                          <Text className="text-sm text-foreground" numberOfLines={2}>
                            {commit.messageHeadline || t("pullRequestsMobile.untitledCommit")}
                          </Text>
                          <Text className="font-mono text-xs text-foreground-muted">
                            {commit.oid.slice(0, 7)}
                          </Text>
                          <Text className="text-xs text-foreground-muted">
                            {new Date(commit.committedDate).toLocaleString()}
                            {commit.authors?.length
                              ? ` · ${commit.authors.map((author) => author.login).join(", ")}`
                              : ""}
                          </Text>
                          {commit.additions !== undefined && commit.deletions !== undefined ? (
                            <Text className="text-xs text-foreground-muted">
                              {t("pullRequestsMobile.lineStats", {
                                additions: commit.additions,
                                deletions: commit.deletions,
                              })}
                            </Text>
                          ) : null}
                        </View>
                      ))}
                    </View>
                  </SettingsSection>
                ) : null}
                {detail.reviewers.length > 0 || detail.capabilities.reviewers.request ? (
                  <SettingsSection title={t("pullRequestsMobile.reviewers")} card>
                    <View className="gap-2 p-4">
                      {detail.reviewers.length === 0 ? (
                        <Text className="text-sm text-foreground-muted">
                          {t("pullRequestsMobile.noReviewers")}
                        </Text>
                      ) : (
                        detail.reviewers.map((reviewer) => (
                          <Text key={reviewer.login} className="text-sm text-foreground">
                            {reviewer.login}
                          </Text>
                        ))
                      )}
                      {detail.capabilities.reviewers.request &&
                      detail.viewerPermissions.requestReviewers ? (
                        detail.capabilities.reviewers.listCandidates ? (
                          <>
                            {reviewerCandidatesQuery.isPending ? <LoadingMessage /> : null}
                            {reviewerCandidatesQuery.error ? (
                              <Text className="text-sm text-danger-foreground">
                                {reviewerCandidatesQuery.error}
                              </Text>
                            ) : null}
                            {reviewerCandidatesQuery.data?.candidates.map((candidate) => (
                              <ActionButton
                                key={candidate.id}
                                disabled={working}
                                label={
                                  candidate.isRequested
                                    ? t("pullRequestsMobile.removeReviewer", {
                                        login: candidate.login,
                                      })
                                    : t("pullRequestsMobile.requestReviewer", {
                                        login: candidate.login,
                                      })
                                }
                                onPress={() => void toggleReviewer(candidate)}
                              />
                            ))}
                          </>
                        ) : (
                          <Text className="text-sm text-foreground-muted">
                            {t("pullRequestsMobile.reviewerListUnavailable")}
                          </Text>
                        )
                      ) : null}
                    </View>
                  </SettingsSection>
                ) : null}
                <SettingsSection title={t("pullRequestsMobile.activity")} card>
                  <View className="gap-3 p-4">
                    {activityQuery.error ? (
                      <Text className="text-sm text-danger-foreground">{activityQuery.error}</Text>
                    ) : null}
                    {activity?.commentsTruncated ? (
                      <Text className="text-sm text-foreground-muted">
                        {t("pullRequestsMobile.commentsTruncated")}
                      </Text>
                    ) : null}
                    {activity?.comments.length === 0 ? (
                      <Text className="text-sm text-foreground-muted">
                        {t("pullRequestsMobile.noComments")}
                      </Text>
                    ) : null}
                    {activity?.comments.map((item) => (
                      <View
                        key={item.id}
                        className="gap-1 border-b border-border-subtle pb-3 last:border-b-0"
                      >
                        <Text className="text-xs text-foreground-muted">
                          {item.author?.login ?? t("pullRequestsMobile.unknownAuthor")}
                        </Text>
                        {item.path ? (
                          <Text className="text-xs text-foreground-muted">{item.path}</Text>
                        ) : null}
                        {editingCommentId === item.id ? (
                          <>
                            <TextInput
                              accessibilityLabel={t("pullRequestsMobile.editComment")}
                              editable={!working}
                              multiline
                              onChangeText={setCommentEditDraft}
                              textAlignVertical="top"
                              value={commentEditDraft}
                            />
                            <View className="flex-row flex-wrap gap-2">
                              <ActionButton
                                disabled={working || commentEditDraft.trim().length === 0}
                                emphasized
                                label={t("pullRequestsMobile.saveComment")}
                                onPress={() => void saveCommentEdit(item)}
                              />
                              <ActionButton
                                disabled={working}
                                label={t("cancel")}
                                onPress={() => setEditingCommentId(null)}
                              />
                            </View>
                          </>
                        ) : (
                          <Text className="text-sm leading-5 text-foreground">{item.body}</Text>
                        )}
                        {item.reviewState ? (
                          <Text className="text-xs text-foreground-muted">{item.reviewState}</Text>
                        ) : null}
                        {item.url ? (
                          <ActionButton
                            disabled={working}
                            label={t("pullRequestsMobile.openExternal")}
                            onPress={() => void tryOpenExternalUrl(item.url!, "pull-request")}
                          />
                        ) : null}
                        {canEditComment(detail, item) && editingCommentId !== item.id ? (
                          <ActionButton
                            disabled={working}
                            label={t("pullRequestsMobile.editComment")}
                            onPress={() => {
                              setEditingCommentId(item.id);
                              setCommentEditDraft(item.body);
                            }}
                          />
                        ) : null}
                        <ReactionRow
                          canReact={detail.capabilities.reactions === true}
                          reactions={item.reactions ?? []}
                          onToggle={(content, reacted) =>
                            void toggleReaction(item.id, content, reacted)
                          }
                        />
                      </View>
                    ))}
                    {activity?.reviewThreads.map((thread) => (
                      <ReviewThreadCard
                        key={thread.id}
                        canReact={detail.capabilities.reactions === true}
                        canReply={
                          detail.capabilities.review.reply && detail.viewerPermissions.comment
                        }
                        canResolve={
                          detail.capabilities.review.resolve && detail.viewerPermissions.resolve
                        }
                        draft={threadReplyDrafts[thread.id] ?? ""}
                        comments={mergePullRequestThreadComments(
                          thread.comments,
                          threadCommentPages[thread.id] ?? [],
                        )}
                        loadingComments={loadingThreadComments === thread.id}
                        nextCommentsCursor={
                          thread.id in threadCommentCursors
                            ? threadCommentCursors[thread.id]
                            : (thread.nextCommentsCursor ?? null)
                        }
                        onChangeDraft={(draft) =>
                          setThreadReplyDrafts((drafts) => ({ ...drafts, [thread.id]: draft }))
                        }
                        onReact={(subjectId, content, reacted) =>
                          void toggleReaction(subjectId, content, reacted)
                        }
                        onReply={() => void submitThreadReply(thread.id)}
                        onLoadMore={() => void loadMoreThreadComments(thread)}
                        onOpenUrl={(url) => void tryOpenExternalUrl(url, "pull-request")}
                        onResolve={(resolved) => void toggleThreadResolution(thread.id, resolved)}
                        thread={thread}
                        working={working}
                      />
                    ))}
                    {detail.capabilities.comment && detail.viewerPermissions.comment ? (
                      <View className="gap-2">
                        <TextInput
                          accessibilityLabel={t("pullRequestsMobile.comment")}
                          multiline
                          onChangeText={setComment}
                          placeholder={t("pullRequestsMobile.commentPlaceholder")}
                          textAlignVertical="top"
                          value={comment}
                        />
                        <ActionButton
                          emphasized
                          disabled={working || comment.trim().length === 0}
                          label={t("pullRequestsMobile.postComment")}
                          onPress={() => void submitComment()}
                        />
                      </View>
                    ) : null}
                  </View>
                </SettingsSection>
                {offeredReviewVerdicts.length > 0 ? (
                  <SettingsSection title={t("pullRequestsMobile.review")} card>
                    <View className="gap-3 p-4">
                      <SegmentRow
                        accessibilityLabel={t("pullRequestsMobile.reviewVerdict")}
                        labels={offeredReviewVerdicts.map((verdict) =>
                          t(`pullRequestsMobile.verdict.${verdict}`),
                        )}
                        selectedIndex={offeredReviewVerdicts.indexOf(selectedReviewVerdict)}
                        onSelect={(index) =>
                          setReviewVerdict(offeredReviewVerdicts[index] ?? "comment")
                        }
                      />
                      <TextInput
                        accessibilityLabel={t("pullRequestsMobile.reviewSummary")}
                        editable={!working}
                        multiline
                        onChangeText={setReviewBody}
                        placeholder={t("pullRequestsMobile.reviewSummary")}
                        textAlignVertical="top"
                        value={reviewBody}
                      />
                      {inlineReviewComments.length > 0 ? (
                        <View className="gap-2">
                          <Text className="text-xs text-foreground-muted">
                            {t("pullRequestsMobile.pendingLineComments", {
                              count: inlineReviewComments.length,
                            })}
                          </Text>
                          {inlineReviewComments.map(({ lineId, draft }) => (
                            <View
                              key={lineId}
                              className="flex-row items-center gap-2 rounded-xl bg-subtle px-3 py-2"
                            >
                              <Text
                                className="min-w-0 flex-1 text-xs text-foreground"
                                numberOfLines={2}
                              >
                                {`${draft.path}:${pullRequestReviewPositionLine(draft.position)} · ${draft.body}`}
                              </Text>
                              <ActionButton
                                disabled={working}
                                label={t("pullRequestsMobile.removeLineComment")}
                                onPress={() =>
                                  setInlineReviewComments((comments) =>
                                    comments.filter((entry) => entry.lineId !== lineId),
                                  )
                                }
                              />
                            </View>
                          ))}
                        </View>
                      ) : null}
                      <ActionButton
                        disabled={
                          working ||
                          (selectedReviewVerdict !== "approve" &&
                            reviewBody.trim().length === 0 &&
                            inlineReviewComments.length === 0)
                        }
                        emphasized
                        label={t("pullRequestsMobile.submitReview")}
                        onPress={() => void submitReviewDraft()}
                      />
                    </View>
                  </SettingsSection>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function PullRequestListCard(props: {
  readonly entry: PullRequestListEntry;
  readonly stats: {
    readonly additions: number;
    readonly deletions: number;
  } | null;
  readonly onOpen: () => void;
}) {
  const { entry } = props;
  const additions = props.stats?.additions ?? entry.additions;
  const deletions = props.stats?.deletions ?? entry.deletions;
  return (
    <Pressable
      accessibilityLabel={`${entry.title} #${entry.number}`}
      accessibilityRole="button"
      onPress={props.onOpen}
      className="gap-2 rounded-[24px] border-continuous bg-card px-4 py-4 active:bg-subtle"
    >
      <View className="flex-row items-start gap-3">
        <SymbolView name="arrow.triangle.pull" size={18} tintColor="#8b5cf6" type="monochrome" />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground">{entry.title}</Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {`${entry.repository} · #${entry.number} · ${entry.state}${entry.isDraft ? ` · ${t("pullRequestsMobile.draft")}` : ""}`}
          </Text>
        </View>
      </View>
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {`${entry.headBranch} → ${entry.baseBranch}${entry.author ? ` · ${entry.author.login}` : ""}`}
      </Text>
      <Text className="text-xs text-foreground-muted">
        {t("pullRequestsMobile.lineStats", {
          additions,
          deletions,
        })}
      </Text>
    </Pressable>
  );
}

function CommitScopePicker(props: {
  readonly commits: ReadonlyArray<PullRequestCommit>;
  readonly selectedCommitOid: string | null;
  readonly onSelect: (oid: string | null) => void;
}) {
  const commits = useMemo(
    () =>
      // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023 method.
      [...props.commits].sort(
        (left, right) => Date.parse(right.committedDate) - Date.parse(left.committedDate),
      ),
    [props.commits],
  );
  return (
    <View className="mb-3 gap-2">
      <Text className="text-xs font-codework-medium text-foreground-muted">
        {t("pullRequestsMobile.commitScope")}
      </Text>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <View className="flex-row gap-2">
          <ActionButton
            emphasized={props.selectedCommitOid === null}
            label={t("pullRequestsMobile.allCommits")}
            onPress={() => props.onSelect(null)}
          />
          {commits.map((commit) => (
            <ActionButton
              key={commit.oid}
              emphasized={props.selectedCommitOid === commit.oid}
              label={`${commit.messageHeadline || t("pullRequestsMobile.untitledCommit")} · ${commit.oid.slice(0, 7)}`}
              onPress={() => props.onSelect(commit.oid)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function PullRequestDiffView(props: {
  readonly canComment: boolean;
  readonly expandedFileIds: ReadonlySet<string>;
  readonly fileContents: Readonly<Record<string, PullRequestDiffFileContentsResult>>;
  readonly loadingFileId: string | null;
  readonly onSelectLine: (file: ParsedDiffFile, line: ParsedDiffLine) => void;
  readonly onToggleFullFile: (file: ParsedDiffFile) => void;
  readonly patch: string;
  readonly selectedLineId: string | null;
}) {
  const files = useMemo(() => parseUnifiedDiff(props.patch), [props.patch]);
  if (files.length === 0) {
    return (
      <Text selectable className="font-mono text-xs leading-5 text-foreground">
        {props.patch || t("pullRequestsMobile.noDiff")}
      </Text>
    );
  }

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="min-w-full gap-3"
    >
      <View className="min-w-full gap-3">
        {files.map((file) => {
          const filePath = file.newPath ?? file.oldPath;
          return (
            <View key={file.id} className="overflow-hidden rounded-xl bg-subtle">
              <Text className="border-b border-border-subtle px-3 py-2 text-xs font-codework-medium text-foreground">
                {file.newPath !== null && file.oldPath !== null && file.oldPath !== file.newPath
                  ? `${file.oldPath} → ${file.newPath}`
                  : (filePath ?? "—")}
              </Text>
              {filePath !== null ? (
                <View className="gap-2 px-3 py-2">
                  <ActionButton
                    disabled={props.loadingFileId !== null && props.loadingFileId !== file.id}
                    label={
                      props.loadingFileId === file.id
                        ? t("pullRequestsMobile.loadingFile")
                        : props.expandedFileIds.has(file.id)
                          ? t("pullRequestsMobile.hideFullFile")
                          : t("pullRequestsMobile.readFullFile")
                    }
                    onPress={() => props.onToggleFullFile(file)}
                  />
                  {props.expandedFileIds.has(file.id) && props.fileContents[file.id] ? (
                    <FullFileContentsView file={file} contents={props.fileContents[file.id]} />
                  ) : null}
                </View>
              ) : null}
              <View className="py-1">
                {file.lines.map((line) => {
                  const position = pullRequestReviewPositionForLine(line);
                  const selectable = props.canComment && filePath !== null && position !== null;
                  const lineId = filePath === null ? line.id : `${filePath}:${line.id}`;
                  const change = diffLineChange(line);
                  if (line.type === "hunk" || line.type === "meta") {
                    return (
                      <Text
                        key={line.id}
                        className="bg-accent/10 px-3 py-1 font-mono text-xs leading-5 text-foreground-muted"
                      >
                        {renderVisibleWhitespace(line.content)}
                      </Text>
                    );
                  }
                  return (
                    <Pressable
                      key={line.id}
                      accessibilityLabel={
                        selectable
                          ? t("pullRequestsMobile.selectLine", {
                              line: line.newLine ?? line.oldLine ?? 0,
                            })
                          : undefined
                      }
                      accessibilityRole={selectable ? "button" : undefined}
                      accessibilityState={{ selected: props.selectedLineId === lineId }}
                      disabled={!selectable}
                      onPress={() => {
                        if (selectable) props.onSelectLine(file, line);
                      }}
                      className={`${changeTone(change)} flex-row items-start ${props.selectedLineId === lineId ? "border border-accent" : ""}`}
                    >
                      <Text className="w-12 px-2 text-right font-mono text-[10px] leading-5 text-foreground-muted">
                        {line.oldLine ?? ""}
                      </Text>
                      <Text className="w-12 px-2 text-right font-mono text-[10px] leading-5 text-foreground-muted">
                        {line.newLine ?? ""}
                      </Text>
                      <Text className="px-2 font-mono text-xs leading-5 text-foreground">
                        {`${lineMarker(line)}${renderVisibleWhitespace(line.content) || " "}`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

function FullFileContentsView(props: {
  readonly file: ParsedDiffFile;
  readonly contents: PullRequestDiffFileContentsResult;
}) {
  const contents =
    props.file.newPath === null ? props.contents.oldContents : props.contents.newContents;
  return (
    <View className="rounded-lg bg-card px-2 py-2">
      <Text selectable className="font-mono text-xs leading-5 text-foreground">
        {contents || t("pullRequestsMobile.emptyFile")}
      </Text>
    </View>
  );
}

function diffLineChange(line: ParsedDiffLine): "context" | "add" | "delete" {
  return line.type === "add" || line.type === "delete" ? line.type : "context";
}

function lineMarker(line: ParsedDiffLine): string {
  if (line.type === "add") return "+";
  if (line.type === "delete") return "-";
  return " ";
}

const REACTION_ORDER: ReadonlyArray<PullRequestReactionContent> = [
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
];

const REACTION_EMOJI: Readonly<Record<PullRequestReactionContent, string>> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

function ReactionRow(props: {
  readonly canReact: boolean;
  readonly reactions: ReadonlyArray<PullRequestReaction>;
  readonly onToggle: (content: PullRequestReactionContent, reacted: boolean) => void;
}) {
  const contents = props.canReact
    ? REACTION_ORDER
    : props.reactions.map((reaction) => reaction.content);
  if (contents.length === 0) return null;
  return (
    <View className="flex-row flex-wrap gap-1">
      {contents.map((content) => {
        const reaction = props.reactions.find((item) => item.content === content);
        const reacted = reaction?.viewerHasReacted ?? false;
        return (
          <Pressable
            key={content}
            accessibilityLabel={`${REACTION_EMOJI[content]} ${reaction?.count ?? 0}`}
            accessibilityRole="button"
            accessibilityState={{ selected: reacted, disabled: !props.canReact }}
            disabled={!props.canReact}
            onPress={() => props.onToggle(content, !reacted)}
            className={
              reacted ? "rounded-full bg-accent px-2 py-1" : "rounded-full bg-subtle px-2 py-1"
            }
          >
            <Text className="text-xs text-foreground">
              {`${REACTION_EMOJI[content]}${reaction ? ` ${reaction.count}` : ""}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function ReviewThreadCard(props: {
  readonly canReact: boolean;
  readonly canReply: boolean;
  readonly canResolve: boolean;
  readonly comments: ReadonlyArray<PullRequestThreadComment>;
  readonly draft: string;
  readonly loadingComments: boolean;
  readonly onChangeDraft: (draft: string) => void;
  readonly onLoadMore: () => void;
  readonly onOpenUrl: (url: string) => void;
  readonly onReact: (
    subjectId: string,
    content: PullRequestReactionContent,
    reacted: boolean,
  ) => void;
  readonly onReply: () => void;
  readonly onResolve: (resolved: boolean) => void;
  readonly nextCommentsCursor: string | null;
  readonly thread: PullRequestReviewThread;
  readonly working: boolean;
}) {
  return (
    <View className="gap-2 rounded-2xl bg-subtle px-3 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 flex-1 text-xs font-codework-medium text-foreground">
          {`${props.thread.path}${props.thread.line === null ? "" : `:${props.thread.line}`}`}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {props.thread.isResolved
            ? t("pullRequestsMobile.resolved")
            : t("pullRequestsMobile.unresolved")}
        </Text>
      </View>
      {props.comments.map((comment) => (
        <View key={comment.id} className="gap-1 border-b border-border-subtle pb-2 last:border-b-0">
          <Text className="text-xs text-foreground-muted">
            {comment.author?.login ?? t("pullRequestsMobile.unknownAuthor")}
          </Text>
          <Text className="text-sm leading-5 text-foreground">{comment.body}</Text>
          {comment.url ? (
            <ActionButton
              label={t("pullRequestsMobile.openExternal")}
              onPress={() => props.onOpenUrl(comment.url!)}
            />
          ) : null}
          <ReactionRow
            canReact={props.canReact}
            reactions={comment.reactions ?? []}
            onToggle={(content, reacted) => props.onReact(comment.id, content, reacted)}
          />
        </View>
      ))}
      {props.nextCommentsCursor !== null ? (
        <ActionButton
          disabled={props.loadingComments || props.working}
          label={
            props.loadingComments
              ? t("pullRequestsMobile.loadingComments")
              : t("pullRequestsMobile.loadMoreComments")
          }
          onPress={props.onLoadMore}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {props.canResolve ? (
          <ActionButton
            disabled={props.working}
            label={
              props.thread.isResolved
                ? t("pullRequestsMobile.unresolve")
                : t("pullRequestsMobile.resolve")
            }
            onPress={() => props.onResolve(!props.thread.isResolved)}
          />
        ) : null}
      </View>
      {props.canReply ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel={t("pullRequestsMobile.reply")}
            editable={!props.working}
            multiline
            onChangeText={props.onChangeDraft}
            placeholder={t("pullRequestsMobile.replyPlaceholder")}
            textAlignVertical="top"
            value={props.draft}
          />
          <ActionButton
            disabled={props.working || props.draft.trim().length === 0}
            emphasized
            label={t("pullRequestsMobile.reply")}
            onPress={props.onReply}
          />
        </View>
      ) : null}
    </View>
  );
}

function SegmentRow(props: {
  readonly accessibilityLabel: string;
  readonly labels: ReadonlyArray<string>;
  readonly selectedIndex: number;
  readonly onSelect: (index: number) => void;
}) {
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      className="flex-row gap-1 rounded-2xl bg-subtle p-1"
    >
      {props.labels.map((label, index) => (
        <Pressable
          key={label}
          accessibilityRole="tab"
          accessibilityState={{ selected: props.selectedIndex === index }}
          onPress={() => props.onSelect(index)}
          className={
            props.selectedIndex === index
              ? "flex-1 rounded-xl bg-card px-2 py-2"
              : "flex-1 rounded-xl px-2 py-2"
          }
        >
          <Text className="text-center text-xs text-foreground" numberOfLines={1}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function LoadingMessage() {
  return (
    <View className="items-center gap-3 rounded-[24px] border-continuous bg-card px-6 py-8">
      <ActivityIndicator />
      <Text className="text-sm text-foreground-muted">{t("pullRequestsMobile.loading")}</Text>
    </View>
  );
}

function StatusMessage(props: {
  readonly text: string;
  readonly detail?: string;
  readonly tone?: "danger";
}) {
  return (
    <View className="rounded-[24px] border-continuous bg-card px-4 py-6">
      <Text
        className={
          props.tone === "danger"
            ? "text-center text-sm text-danger-foreground"
            : "text-center text-sm text-foreground-muted"
        }
      >
        {props.text}
      </Text>
      {props.detail ? (
        <Text className="mt-1 text-center text-xs leading-5 text-foreground-muted">
          {props.detail}
        </Text>
      ) : null}
    </View>
  );
}

function ActionButton(props: {
  readonly disabled?: boolean;
  readonly emphasized?: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={
        props.emphasized
          ? "rounded-full bg-accent px-3.5 py-2 opacity-100 disabled:opacity-40"
          : "rounded-full bg-subtle-strong px-3.5 py-2 opacity-100 disabled:opacity-40"
      }
    >
      <Text
        className={
          props.emphasized
            ? "text-sm font-codework-medium text-accent-foreground"
            : "text-sm text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function reviewVerdicts(detail: PullRequestDetail): ReadonlyArray<PullRequestReviewVerdict> {
  return (["comment", "approve", "request-changes"] as const).filter(
    (verdict) =>
      detail.capabilities.review.verdicts.includes(verdict) &&
      detail.viewerPermissions.verdicts.includes(verdict),
  );
}

function sameLogin(one: string | null | undefined, other: string | null | undefined): boolean {
  return one != null && other != null && one.trim().toLowerCase() === other.trim().toLowerCase();
}

function canEditChangeRequest(detail: PullRequestDetail): boolean {
  if (detail.capabilities.edit?.changeRequest !== true) return false;
  return (
    sameLogin(detail.viewer, detail.author?.login) ||
    detail.viewerPermissions.actions.includes("merge")
  );
}

function canEditComment(
  detail: PullRequestDetail | null,
  comment: Pick<PullRequestComment, "author" | "kind">,
): boolean {
  if (detail === null || detail.capabilities.edit?.comment !== true) return false;
  if (comment.kind !== "issue-comment" && comment.kind !== "review-comment") return false;
  return sameLogin(detail.viewer, comment.author?.login);
}

function actionLabel(action: PullRequestAction): string {
  return t(`pullRequestsMobile.action.${action}`);
}

function commandError(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : t("pullRequestsMobile.actionFailed");
}
