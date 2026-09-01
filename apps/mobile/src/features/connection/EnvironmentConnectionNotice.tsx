import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@codework/client-runtime/connection";
import { SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useThemeColor } from "../../lib/useThemeColor";
import { t } from "../../i18n";

function noticeTitle(phase: EnvironmentConnectionPhase, environmentLabel: string): string {
  switch (phase) {
    case "offline":
      return t("youAreOffline");
    case "connecting":
      return t("connection.connectingTo", { environmentLabel });
    case "reconnecting":
      return t("connection.reconnectingTo", { environmentLabel });
    case "error":
      return t("connection.environmentUnavailable", { environmentLabel });
    case "available":
      return t("connection.environmentDisconnected", { environmentLabel });
    case "connected":
      return "";
  }
}

function noticeDetail(
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
): string {
  if (error) {
    return t("connection.retryingAutomatically", { error });
  }

  switch (phase) {
    case "offline":
      return t("connection.offlineCachedDetail", { resourceName });
    case "connecting":
    case "reconnecting":
      return t("connection.loadingWhenReadyDetail", { resourceName });
    case "available":
    case "error":
      return t("connection.reconnectToLoadDetail", { resourceName });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: string;
  readonly onRetry: () => void;
}) {
  const iconColor = String(useThemeColor("--color-icon-muted"));
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <ActivityIndicator size="small" color={iconColor} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColor={iconColor}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-codework-bold text-foreground">
          {noticeTitle(props.connection.phase, props.environmentLabel)}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(props.connection.phase, props.resourceName, props.connection.error)}
          {props.connection.traceId ? (
            <>
              {t("traceId")}
              <Text
                accessibilityHint={t("copiesTheTraceId")}
                accessibilityRole="button"
                className="underline decoration-dotted"
                onPress={() =>
                  copyTextWithHaptic(props.connection.traceId!, {
                    target: "connection-trace-id",
                  })
                }
              >
                {props.connection.traceId}
              </Text>
            </>
          ) : null}
        </Text>

        {props.connection.phase !== "offline" ? (
          <Pressable
            accessibilityRole="button"
            className="mt-1 rounded-full bg-subtle px-4 py-2.5 active:opacity-70"
            onPress={props.onRetry}
          >
            <Text className="text-sm font-codework-bold text-foreground">{t("retryNow")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
