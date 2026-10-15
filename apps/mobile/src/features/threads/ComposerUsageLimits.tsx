/**
 * The `/usage-limits` result, docked above the composer. It is the
 * Usage → subscription quota card one size down, so the two read as the same
 * thing. Code Work answers the command locally — the agent never sees it.
 *
 * @module threads/ComposerUsageLimits
 */
import type { AccountQuotaWindow, EnvironmentId } from "@codework/contracts";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";

import {
  externalUsageLinkForProvider,
  quotaWindowRemainingPercent,
  type MergedAccountQuotaProvider,
} from "@codework/shared/accountQuotaMerge";
import { formatPercent } from "@codework/shared/usageFormat";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { relativeTimeUntil } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";

function windowLabel(window: AccountQuotaWindow): string {
  switch (window.id) {
    case "primary":
    case "five_hour":
      return t("usageAccountQuotaMobile.window.fiveHours");
    case "secondary":
    case "seven_day":
      return t("usageAccountQuotaMobile.window.sevenDays");
    default:
      return window.label;
  }
}

const WINDOW_BAR_CLASS: Readonly<Record<AccountQuotaWindow["status"], string>> = {
  ok: "bg-emerald-500",
  warning: "bg-amber-500",
  exhausted: "bg-red-500",
  unknown: "bg-muted-foreground/50",
};

export function ComposerUsageLimits({
  providers,
  environmentsCount,
  instanceLabel,
  onClose,
}: {
  readonly providers: readonly MergedAccountQuotaProvider[];
  readonly environmentsCount: number;
  readonly instanceLabel: (
    environmentId: EnvironmentId,
    instanceId: string | undefined,
  ) => string | undefined;
  readonly onClose: () => void;
}) {
  const { height } = useWindowDimensions();
  const iconMutedColor = useThemeColor("--color-icon-muted");
  const accountCounts = new Map<string, number>();
  for (const provider of providers) {
    accountCounts.set(provider.provider, (accountCounts.get(provider.provider) ?? 0) + 1);
  }
  return (
    <View className="overflow-hidden rounded-[20px] border border-border bg-card">
      <View className="flex-row items-center justify-between px-4 pt-3">
        <Text className="text-[13px] font-medium text-foreground">
          {t("usageLimits.commandTitle")}
        </Text>
        <Pressable
          accessibilityLabel={t("usageLimits.dismiss")}
          accessibilityRole="button"
          hitSlop={12}
          onPress={onClose}
          className="-me-1 p-1 active:opacity-60"
        >
          <SymbolView name="xmark" size={14} tintColor={iconMutedColor} type="monochrome" />
        </Pressable>
      </View>
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
        contentContainerClassName="px-4 pb-3 pt-1.5 gap-3"
      >
        {providers.map((provider) => {
          const instance = instanceLabel(provider.environmentId, provider.providerInstanceId);
          const externalUsage = externalUsageLinkForProvider(provider.provider);
          const showInstance =
            instance !== undefined && (accountCounts.get(provider.provider) ?? 0) > 1;
          return (
            <View
              key={`${provider.provider}:${provider.providerInstanceId ?? ""}`}
              className="gap-1.5"
            >
              {providers.length > 1 ? (
                <Text className="text-xs font-medium text-muted-foreground" numberOfLines={1}>
                  {provider.provider}
                  {showInstance ? ` · ${instance}` : ""}
                  {provider.planName !== undefined ? ` · ${provider.planName}` : ""}
                  {environmentsCount > 1 ? ` · ${provider.environmentLabel}` : ""}
                </Text>
              ) : null}
              {provider.windows.map((window) => {
                const remaining = quotaWindowRemainingPercent(window);
                const resetsInFuture =
                  window.resetsAt !== undefined && Date.parse(window.resetsAt) > Date.now();
                return (
                  <View key={window.id} className="gap-1">
                    <View className="flex-row items-baseline justify-between gap-3">
                      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                        {windowLabel(window)}
                      </Text>
                      <Text className="text-xs tabular-nums text-foreground">
                        {remaining === null
                          ? t("usageAccountQuotaMobile.unknown")
                          : `${formatPercent(remaining / 100, 0)} ${t("usageAccountQuotaMobile.leftSuffix")}`}
                        {window.resetsAt !== undefined && resetsInFuture
                          ? ` · ${relativeTimeUntil(window.resetsAt)}`
                          : ""}
                      </Text>
                    </View>
                    {remaining === null ? null : (
                      <View className="h-1 overflow-hidden rounded-full bg-muted">
                        <View
                          className={`h-full rounded-full ${WINDOW_BAR_CLASS[window.status]}`}
                          style={{ width: `${remaining}%` }}
                        />
                      </View>
                    )}
                  </View>
                );
              })}
              {externalUsage === null ? null : (
                <Pressable
                  accessibilityRole="link"
                  className="self-start active:opacity-60"
                  hitSlop={8}
                  onPress={() => void tryOpenExternalUrl(externalUsage.url, "usage-dashboard")}
                >
                  <Text className="text-[10px] text-foreground-tertiary underline">
                    {externalUsage.label} ↗
                  </Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}
