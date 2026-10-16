/**
 * Native counterpart of the web permission-update toast. Sessions minted before
 * granular permissions still carry only the broad scopes, so new granular
 * denials would land mid-session. Alert once per environment per launch, with a
 * per-environment "don't show again" persisted in SecureStore.
 */

import { sessionHasLegacyPermissions, type EnvironmentId } from "@codework/contracts";
import { useAtomValue } from "@effect/atom-react";
import { createNavigationContainerRef, type ParamListBase } from "@react-navigation/native";
import * as SecureStore from "expo-secure-store";
import { memo, useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import { t } from "../i18n";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";

const PERMISSION_UPDATE_DISMISS_KEY = "codework.permission-update-notice.dismissed";

// Untyped param list: the notice lives outside the navigator tree and only
// needs to reach the Connections screen, which is loosely typed everywhere.
export const navigationRef = createNavigationContainerRef<ParamListBase>();

const shownThisLaunch = new Set<EnvironmentId>();

export const PermissionUpdateNotice = memo(function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  const [dismissed, setDismissed] = useState<ReadonlySet<string> | null>(null);
  const [showing, setShowing] = useState<EnvironmentId | null>(null);

  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(PERMISSION_UPDATE_DISMISS_KEY)
      .then((raw) => {
        const value: unknown = raw === null ? [] : JSON.parse(raw);
        if (cancelled) return;
        setDismissed(
          new Set(
            Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [],
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setDismissed(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback((environmentId: EnvironmentId) => {
    setDismissed((current) => {
      const next = new Set([...(current ?? []), environmentId]);
      void SecureStore.setItemAsync(PERMISSION_UPDATE_DISMISS_KEY, JSON.stringify([...next])).catch(
        () => {
          // Remember for this launch even if persistent storage is unavailable.
        },
      );
      return next;
    });
    setShowing(null);
  }, []);

  const openConnections = useCallback(
    (environmentId: EnvironmentId) => {
      if (navigationRef.isReady()) {
        navigationRef.navigate("Connections" as never);
      }
      dismiss(environmentId);
    },
    [dismiss],
  );

  if (dismissed === null) return null;
  return (
    <>
      {environments.map((env) => (
        <EnvironmentPermissionNotice
          key={env.environmentId}
          environmentId={env.environmentId}
          label={env.label}
          suppressed={
            dismissed.has(env.environmentId) ||
            shownThisLaunch.has(env.environmentId) ||
            showing !== null
          }
          onLegacyDetected={() => setShowing(env.environmentId)}
          onDismiss={() => dismiss(env.environmentId)}
          onOpenConnections={() => openConnections(env.environmentId)}
        />
      ))}
    </>
  );
});

const EnvironmentPermissionNotice = memo(function EnvironmentPermissionNotice({
  environmentId,
  label,
  suppressed,
  onLegacyDetected,
  onDismiss,
  onOpenConnections,
}: {
  environmentId: EnvironmentId;
  label: string;
  suppressed: boolean;
  onLegacyDetected: () => void;
  onDismiss: () => void;
  onOpenConnections: () => void;
}) {
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));

  useEffect(() => {
    if (suppressed) return;
    if (session === null || !sessionHasLegacyPermissions(session)) return;
    shownThisLaunch.add(environmentId);
    onLegacyDetected();
    Alert.alert(
      t("permissionsChangedForLabel", { label }),
      t("connectionStillUsesOldPermissionsPairAgainUsingANewLink"),
      [
        { text: t("dismiss"), style: "cancel", onPress: onDismiss },
        { text: t("commandPalette.environments"), onPress: onOpenConnections },
      ],
    );
  }, [session, suppressed, environmentId, label, onLegacyDetected, onDismiss, onOpenConnections]);

  return null;
});
