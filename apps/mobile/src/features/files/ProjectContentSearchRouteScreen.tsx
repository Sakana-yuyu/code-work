import type { ProjectContentMatch, ProjectSearchContentsResult } from "@codework/contracts";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, FlatList, Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useEnvironmentQuery } from "../../state/query";
import { projectEnvironment } from "../../state/projects";
import { SettingsSection } from "../settings/components/SettingsSection";
import { t } from "../../i18n";

type ProjectContentSearchRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function SearchOption(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      className={cn(
        "rounded-full border border-border px-3 py-2 active:opacity-70",
        props.active && "border-primary bg-primary/10",
      )}
      onPress={props.onPress}
    >
      <Text className="text-xs font-codework-medium text-foreground">{props.label}</Text>
    </Pressable>
  );
}

function SearchResultRow(props: {
  readonly match: ProjectContentMatch;
  readonly onPress: (match: ProjectContentMatch) => void;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.match.path}:${props.match.lineNumber}`}
      accessibilityRole="button"
      className="gap-1 border-b border-border-subtle px-4 py-3 active:bg-subtle"
      onPress={() => props.onPress(props.match)}
    >
      <Text className="text-sm font-codework-medium text-info-foreground" numberOfLines={1}>
        {props.match.path}
      </Text>
      <Text className="font-mono text-xs text-foreground-muted" numberOfLines={2}>
        {`${props.match.lineNumber}: ${props.match.lineContent}`}
      </Text>
    </Pressable>
  );
}

export function ProjectContentSearchRouteScreen(_props: ProjectContentSearchRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const environmentId = selectedThread?.environmentId ?? null;
  const cwd = selectedThreadCwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const searchQuery = useEnvironmentQuery(
    environmentId !== null && cwd !== null && submittedQuery !== null
      ? projectEnvironment.searchContents({
          environmentId,
          input: {
            cwd,
            query: submittedQuery,
            limit: 200,
            caseSensitive,
            wholeWord,
            useRegex,
          },
        })
      : null,
  );
  const result = searchQuery.data as ProjectSearchContentsResult | null;
  const matches = result?.matches ?? [];
  const submitSearch = () => {
    setSubmittedQuery(query.trim().length === 0 ? null : query);
  };
  const openMatch = (match: ProjectContentMatch) => {
    if (environmentId === null || selectedThread === null) return;
    navigation.dispatch(
      StackActions.replace("ThreadFile", {
        environmentId: String(environmentId),
        threadId: String(selectedThread.id),
        path: match.path.split("/").filter(Boolean),
        line: String(match.lineNumber),
      }),
    );
  };

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions
        options={{ title: t("searchProjectContents"), headerShown: Platform.OS !== "android" }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={t("searchProjectContents")}
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <View className="flex-1 px-5 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 18) }}>
        <SettingsSection title={t("searchProjectContents")} card>
          <View className="gap-3 p-4">
            <Text className="text-sm leading-5 text-foreground-muted">
              {t("searchProjectContentsDescription")}
            </Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setQuery}
              onSubmitEditing={submitSearch}
              placeholder={t("searchProjectContentsPlaceholder")}
              returnKeyType="search"
              value={query}
            />
            <View className="flex-row flex-wrap gap-2">
              <SearchOption
                active={caseSensitive}
                label={t("matchCase")}
                onPress={() => setCaseSensitive((current) => !current)}
              />
              <SearchOption
                active={wholeWord}
                label={t("matchWholeWord")}
                onPress={() => setWholeWord((current) => !current)}
              />
              <SearchOption
                active={useRegex}
                label={t("useRegularExpression")}
                onPress={() => setUseRegex((current) => !current)}
              />
            </View>
            <Pressable
              accessibilityRole="button"
              className="items-center rounded-xl bg-primary px-4 py-3 active:opacity-70"
              onPress={submitSearch}
            >
              <Text className="text-sm font-codework-bold text-primary-foreground">
                {t("search")}
              </Text>
            </Pressable>
          </View>
        </SettingsSection>

        <View className="min-h-0 flex-1 pt-4">
          {searchQuery.isPending ? (
            <View className="items-center gap-2 py-8">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">{t("searching")}</Text>
            </View>
          ) : searchQuery.error ? (
            <Text className="px-2 py-4 text-sm text-danger-foreground">{searchQuery.error}</Text>
          ) : result?.regexFallbackError ? (
            <Text className="px-2 py-4 text-sm text-danger-foreground">
              {result.regexFallbackError}
            </Text>
          ) : submittedQuery === null ? (
            <Text className="px-2 py-8 text-center text-sm text-foreground-muted">
              {t("typeToSearchAcrossYourProject")}
            </Text>
          ) : matches.length === 0 ? (
            <Text className="px-2 py-8 text-center text-sm text-foreground-muted">
              {t("noResultsFound")}
            </Text>
          ) : (
            <FlatList
              contentContainerStyle={{ paddingBottom: 24 }}
              data={matches}
              keyExtractor={(match) =>
                `${match.path}:${match.lineNumber}:${match.matchRanges[0]?.start ?? 0}`
              }
              ListHeaderComponent={
                <Text className="px-2 pb-2 text-xs text-foreground-muted">
                  {t("resultsInFiles", {
                    value1: matches.length.toLocaleString(),
                    value2: result?.truncated ? "+" : "",
                    value3: new Set(matches.map((match) => match.path)).size.toLocaleString(),
                  })}
                </Text>
              }
              renderItem={({ item }) => <SearchResultRow match={item} onPress={openMatch} />}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      </View>
    </View>
  );
}
