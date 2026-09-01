import { useNavigation } from "@react-navigation/native";
import type { CompositionSupplierRegistryResult } from "@codework/contracts";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { t } from "../../i18n";
import {
  formatOrphanProfilesWarning,
  formatSupplierProfileSummary,
  supplierDisplayName,
  supplierEnabledLabelKey,
} from "./SettingsSupplierRegistryRouteScreen.logic";

/** Supplier/Profile/Account 只读投影，移动端对应 Web 设置"集成"页的 Supplier 注册表区块。 */
export function SettingsSupplierRegistryRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const environmentId = environments[0]?.environmentId ?? null;
  const registryQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.supplierRegistry({ environmentId, input: {} }),
  );

  const registry: CompositionSupplierRegistryResult | null = registryQuery.data;
  const orphanWarning =
    registry === null
      ? null
      : formatOrphanProfilesWarning(
          t("supplierRegistry.orphanProfiles"),
          registry.orphanProfileAgentIds,
        );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={t("supplierRegistry.title")}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={registryQuery.isPending && registry !== null}
            onRefresh={registryQuery.refresh}
          />
        }
      >
        {environmentId === null ? (
          <StatusMessage text={t("supplierRegistry.noEnvironment")} />
        ) : registry === null && registryQuery.isPending ? (
          <StatusMessage text={t("supplierRegistry.pending")} />
        ) : registry === null && registryQuery.error !== null ? (
          <StatusMessage text={t("supplierRegistry.error")} tone="danger" />
        ) : registry === null || registry.suppliers.length === 0 ? (
          <StatusMessage text={t("supplierRegistry.noData")} />
        ) : (
          <View className="gap-3">
            {registry.suppliers.map((supplier) => (
              <View
                key={supplier.instanceId}
                className="gap-2 rounded-[24px] border-continuous bg-card p-4"
              >
                <View className="flex-row flex-wrap items-center gap-2">
                  <Text
                    className="text-base font-codework-medium text-foreground"
                    numberOfLines={1}
                  >
                    {supplierDisplayName(supplier)}
                  </Text>
                  <BadgePill label={supplier.driverKind} />
                  <BadgePill label={t(supplierEnabledLabelKey(supplier.enabled))} emphasized />
                </View>
                <Text className="font-mono text-xs text-foreground-muted" numberOfLines={1}>
                  {supplier.continuationKey}
                </Text>
                {supplier.defaultModelId === undefined ? null : (
                  <Text className="text-sm text-foreground-muted">
                    {`${t("supplierRegistry.defaultModel")}: ${supplier.defaultModelId}`}
                  </Text>
                )}
                {supplier.profile === undefined ? null : (
                  <Text className="text-sm text-foreground-muted">
                    {`${t("supplierRegistry.profile")}: ${formatSupplierProfileSummary(supplier.profile)}`}
                  </Text>
                )}
              </View>
            ))}
          </View>
        )}
        {orphanWarning === null ? null : (
          // 孤儿档案是多账号回滚关注对象；移动端主题没有 warning 色，用 danger 色示警。
          <View className="rounded-[16px] border-continuous bg-card px-4 py-3">
            <Text className="text-sm text-danger-foreground">{orphanWarning}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function StatusMessage(props: { readonly text: string; readonly tone?: "danger" }) {
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
    </View>
  );
}

function BadgePill(props: { readonly label: string; readonly emphasized?: boolean }) {
  return (
    <View
      className={
        props.emphasized
          ? "rounded-full bg-subtle-strong px-2.5 py-0.5"
          : "rounded-full bg-subtle px-2.5 py-0.5"
      }
    >
      <Text className="text-xs text-foreground">{props.label}</Text>
    </View>
  );
}
