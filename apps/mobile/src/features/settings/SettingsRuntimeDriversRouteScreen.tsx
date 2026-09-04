import type { CompositionAgentDriverProfile, EnvironmentId } from "@codework/contracts";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useMemo, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { t } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsEnvironmentPicker } from "./components/SettingsEnvironmentPicker";
import { SettingsSection } from "./components/SettingsSection";

const SURFACES: ReadonlyArray<readonly [keyof CompositionAgentDriverProfile, string]> = [
  ["supportsWorkspace", "workspace"],
  ["supportsTerminal", "terminal"],
  ["supportsGit", "git"],
  ["supportsMcp", "mcp"],
  ["supportsBrowser", "browser"],
  ["supportsIde", "ide"],
  ["supportsProviderApi", "providerApi"],
  ["supportsResume", "resume"],
  ["supportsSquad", "squad"],
  ["supportsLeader", "leader"],
  ["supportsTaskGraph", "taskGraph"],
];

export function SettingsRuntimeDriversRouteScreen() {
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
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  useEffect(() => {
    if (
      selectedEnvironmentId !== null &&
      environments.some((item) => item.environmentId === selectedEnvironmentId)
    ) {
      return;
    }
    setSelectedEnvironmentId(environments[0]?.environmentId ?? null);
  }, [environments, selectedEnvironmentId]);

  const visibleProfiles = useMemo(() => query.data ?? [], [query.data]);

  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("runtimeDriversMobile.title")}
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
          {t("runtimeDriversMobile.description")}
        </Text>
        <SettingsEnvironmentPicker
          environments={environments}
          selectedEnvironmentId={environmentId}
          disabled={query.isPending}
          onSelect={(next) => setSelectedEnvironmentId(next)}
        />
        {environmentId === null ? (
          <StatusMessage text={t("runtimeDriversMobile.noEnvironment")} />
        ) : null}
        {environmentId !== null && query.data === null && query.isPending ? (
          <StatusMessage text={t("runtimeDriversMobile.loading")} />
        ) : null}
        {query.error ? <StatusMessage text={query.error} tone="danger" /> : null}
        <SettingsSection title={t("runtimeDriversMobile.title")} card>
          {visibleProfiles.length === 0 && !query.isPending ? (
            <StatusMessage
              text={t("runtimeDriversMobile.empty")}
              detail={t("runtimeDriversMobile.emptyDescription")}
            />
          ) : null}
          {visibleProfiles.map((profile) => (
            <DriverCard key={profile.agentId} profile={profile} />
          ))}
          <View className="border-t border-border-subtle p-4">
            <Text className="text-xs leading-5 text-foreground-muted">
              {t("runtimeDriversMobile.authorizationDescription")}
            </Text>
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}

function DriverCard(props: { readonly profile: CompositionAgentDriverProfile }) {
  const activeSurfaces = SURFACES.filter(([key]) => props.profile[key] === true);
  const statusLabel =
    props.profile.status === "available"
      ? t("runtimeDriversMobile.available")
      : props.profile.status === "degraded"
        ? t("runtimeDriversMobile.degraded")
        : t("runtimeDriversMobile.unavailable");
  const statusClassName =
    props.profile.status === "available"
      ? "text-xs text-success-foreground"
      : props.profile.status === "degraded"
        ? "text-xs text-warning-foreground"
        : "text-xs text-danger-foreground";
  return (
    <View className="gap-3 border-b border-border-subtle p-4 last:border-b-0">
      <View className="gap-1">
        <Text className="text-base font-codework-medium text-foreground">
          {props.profile.displayName ?? props.profile.agentId}
        </Text>
        <Text className={statusClassName}>{statusLabel}</Text>
        <Text className="font-mono text-xs leading-5 text-foreground-muted" numberOfLines={2}>
          {`${props.profile.agentId} · ${props.profile.runtimeId} · ${props.profile.driverKind}`}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-1.5">
        {activeSurfaces.length === 0 ? (
          <Text className="text-xs text-foreground-muted">
            {t("runtimeDriversMobile.noVerifiedSurfaces")}
          </Text>
        ) : (
          activeSurfaces.map(([, surface]) => (
            <View key={surface} className="rounded-full bg-input px-2.5 py-1.5">
              <Text className="text-xs text-foreground-muted">
                {t(`runtimeDriversMobile.surface.${surface}`)}
              </Text>
            </View>
          ))
        )}
      </View>
      {props.profile.capabilities.length > 0 ? (
        <Text className="font-mono text-xs leading-5 text-foreground-muted" numberOfLines={5}>
          {props.profile.capabilities.join(", ")}
        </Text>
      ) : null}
      {props.profile.reasonCode ? (
        <Text className="text-xs text-danger-foreground">
          {`${t("runtimeDriversMobile.reason")}: ${props.profile.reasonCode}`}
        </Text>
      ) : null}
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
