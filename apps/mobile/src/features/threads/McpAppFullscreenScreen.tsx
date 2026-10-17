import { EnvironmentId, ThreadId } from "@codework/contracts";
import { scopeThreadRef } from "@codework/client-runtime/environment";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@codework/shared/mcpApp";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Predicate from "effect/Predicate";
import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { t } from "../../i18n";
import { mcpAppEnvironment } from "../../state/mcpApps";
import { useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadMcpApp } from "./McpAppWebView";

type McpAppFullscreenScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly itemId: string;
}>;

/**
 * An MCP App full screen (`ui/request-display-mode`), in a modal over the
 * thread. It is its own view of the app; closing it returns to the row. The
 * app is read from its stored tool call, never from the route, so a link can
 * only open an app that call really produced.
 */
export function McpAppFullscreenScreen({ route }: McpAppFullscreenScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  // A plain goBack pops whatever is on top, so it only runs while this modal
  // is: an exit that lands while another screen covers it (after a teardown
  // wait) waits for the modal to be on top again, rather than popping that
  // screen or being lost.
  const focused = useIsFocused();
  const [exitRequested, setExitRequested] = useState(false);
  const onClose = useCallback(() => {
    if (navigation.isFocused()) navigation.goBack();
    else setExitRequested(true);
  }, [navigation]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = route.params;
  const environmentId = EnvironmentId.make(params.environmentId);
  const threadId = ThreadId.make(params.threadId);
  const itemId = params.itemId;

  const itemDetail = useAtomCommand(mcpAppEnvironment.itemDetail, { reportFailure: false });
  const [storedItem, setStoredItem] = useState<unknown>(undefined);
  const [detailSettled, setDetailSettled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void itemDetail({ environmentId, input: { threadId, itemId } }).then((detail) => {
      if (cancelled) return;
      setDetailSettled(true);
      if (detail._tag === "Success") setStoredItem(detail.value.item);
    });
    return () => {
      cancelled = true;
    };
  }, [itemDetail, environmentId, threadId, itemId]);
  const item = Predicate.isObject(storedItem) ? storedItem : undefined;
  // One reference per app: the item is a new object on every refetch (a
  // reconnect, for one), and a new reference would rebuild the app's host.
  const derived = readMcpAppReference(item?.[MCP_APP_OUTPUT_KEY]);
  const [app, setApp] = useState(derived);
  if (derived?.attachmentId !== app?.attachmentId) setApp(derived);
  // The approval or question the agent waits on renders on the thread this
  // modal covers, so the app steps aside for it.
  const conversation = useThreadShell(scopeThreadRef(environmentId, threadId));
  const awaitingUser =
    conversation?.hasPendingApprovals === true || conversation?.hasPendingUserInput === true;
  useEffect(() => {
    if ((awaitingUser || exitRequested) && focused) navigation.goBack();
  }, [awaitingUser, exitRequested, focused, navigation]);

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      <View className="h-11 flex-row items-center justify-between px-3">
        <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
          {app?.server ?? "App"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mcpApp.exitFullscreen")}
          hitSlop={8}
          onPress={onClose}
        >
          <SymbolView name="xmark" size={18} tintColor="gray" />
        </Pressable>
      </View>
      <View
        className="flex-1"
        style={{ paddingBottom: insets.bottom }}
        onLayout={(event) =>
          setSize({
            width: Math.round(event.nativeEvent.layout.width),
            height: Math.round(event.nativeEvent.layout.height - insets.bottom),
          })
        }
      >
        {app === undefined ? (
          detailSettled ? (
            <Text className="m-6 text-sm text-foreground-muted">{t("mcpApp.cannotBeShown")}</Text>
          ) : null
        ) : size.width > 0 ? (
          <ThreadMcpApp
            environmentId={environmentId}
            threadId={threadId}
            conversationThreadId={threadId}
            itemId={itemId}
            app={app}
            width={size.width}
            height={size.height}
            displayMode="fullscreen"
            onExitFullscreen={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}
