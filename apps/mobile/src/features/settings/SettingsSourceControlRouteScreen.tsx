import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentId,
  SourceControlDiscoveryResult,
  SourceControlProviderDiscoveryItem,
  VcsDiscoveryItem,
} from "@codework/contracts";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";

const EMPTY_DISCOVERY_RESULT: SourceControlDiscoveryResult = {
  versionControlSystems: [],
  sourceControlProviders: [],
};

export function SettingsSourceControlRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    () => environments[0]?.environmentId ?? null,
  );
  const environmentId = selectedEnvironmentId;
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const result = query.data ?? EMPTY_DISCOVERY_RESULT;

  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("sourceControlMobile.title")}
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
            refreshing={query.isPending && query.data !== null}
            onRefresh={query.refresh}
          />
        }
      >
        <Text className="px-2 text-sm leading-5 text-foreground-muted">
          {t("sourceControlMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={query.isPending}
          onSelect={(next) => setSelectedEnvironmentId(next)}
        />
        {environmentId === null ? (
          <StatusMessage text={t("sourceControlMobile.noEnvironment")} />
        ) : null}
        {query.error ? <StatusMessage text={query.error} tone="danger" /> : null}
        {environmentId !== null && query.data === null && query.isPending ? (
          <StatusMessage text={t("sourceControlMobile.loading")} />
        ) : null}
        {result.versionControlSystems.length > 0 ? (
          <SettingsSection title={t("sourceControlMobile.versionControl")} card>
            {result.versionControlSystems.map((item) => (
              <DiscoveryCard key={`vcs:${item.kind}`} item={item} />
            ))}
          </SettingsSection>
        ) : null}
        {result.sourceControlProviders.length > 0 ? (
          <SettingsSection title={t("sourceControlMobile.providers")} card>
            {result.sourceControlProviders.map((item) => (
              <DiscoveryCard key={`provider:${item.kind}`} item={item} />
            ))}
          </SettingsSection>
        ) : null}
        {query.data !== null &&
        result.versionControlSystems.length === 0 &&
        result.sourceControlProviders.length === 0 ? (
          <StatusMessage
            text={t("sourceControlMobile.empty")}
            detail={t("sourceControlMobile.emptyDescription")}
          />
        ) : null}
        <Text className="px-2 text-xs leading-5 text-foreground-muted">
          {t("sourceControlMobile.serverOnly")}
        </Text>
      </ScrollView>
    </View>
  );
}

function DiscoveryCard(props: {
  readonly item: VcsDiscoveryItem | SourceControlProviderDiscoveryItem;
}) {
  const item = props.item;
  const provider = "auth" in item ? item : null;
  const status =
    item.status === "available"
      ? t("sourceControlMobile.available")
      : t("sourceControlMobile.missing");
  const auth = provider === null ? null : provider.auth.status;
  return (
    <View className="gap-2 border-b border-border-subtle p-4 last:border-b-0">
      <View className="flex-row items-start justify-between gap-3">
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-base font-codework-medium text-foreground">{item.label}</Text>
          <Text className="font-mono text-xs text-foreground-muted">
            {`${item.kind} · ${status}`}
          </Text>
        </View>
        {"implemented" in item && !item.implemented ? (
          <Text className="text-xs text-warning-foreground">
            {t("sourceControlMobile.comingSoon")}
          </Text>
        ) : null}
      </View>
      <View className="gap-1">
        {Option.getOrNull(item.version) ? (
          <Text className="text-xs text-foreground-muted">
            {`${t("sourceControlMobile.version")}: ${Option.getOrNull(item.version)}`}
          </Text>
        ) : null}
        {provider ? (
          <Text className="text-xs text-foreground-muted">
            {`${t("sourceControlMobile.authentication")}: ${auth === "authenticated" ? t("sourceControlMobile.authenticated") : auth === "unauthenticated" ? t("sourceControlMobile.unauthenticated") : t("sourceControlMobile.unknown")}`}
          </Text>
        ) : null}
        {Option.getOrNull(item.detail) ? (
          <Text className="text-xs leading-5 text-foreground-muted">
            {Option.getOrNull(item.detail)}
          </Text>
        ) : null}
        {item.status === "missing" ? (
          <Text className="text-xs leading-5 text-warning-foreground">{item.installHint}</Text>
        ) : null}
      </View>
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
