/**
 * Auth upgrades reworded session permissions without re-pairing every existing
 * client. Sessions minted before granular permissions still carry only the broad
 * scopes, so new granular denials would land mid-session after refresh.
 *
 * When a session reports the old permission vocabulary, surface one persistent
 * toast per environment (snoozable via localStorage) that points the user at the
 * pairing flow to mint a fresh credential.
 */

import { sessionHasLegacyPermissions, type EnvironmentId } from "@codework/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Schema } from "effect";
import { memo, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { t } from "~/i18n";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";
import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { toastManager } from "./ui/toast";

// Keep an active toast across remounts, including Strict Mode effect replay.
const shown = new Set<EnvironmentId>();

const storageKey = (environmentId: EnvironmentId) =>
  `code-work:permission-update:v1:${environmentId}`;

const EnvironmentPermissionNotice = memo(function EnvironmentPermissionNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const navigate = useNavigate();

  useEffect(() => {
    if (
      session._tag !== "Success" ||
      session.waiting ||
      !sessionHasLegacyPermissions(session.value)
    )
      return;
    if (shown.has(environmentId)) return;
    try {
      if (getLocalStorageItem(storageKey(environmentId), Schema.Boolean)) return;
    } catch {
      // An unavailable store must not prevent the notice.
    }
    shown.add(environmentId);
    const persistDismissal = () => {
      try {
        setLocalStorageItem(storageKey(environmentId), true, Schema.Boolean);
      } catch {
        // The in-memory marker still prevents repeats during this launch.
      }
    };
    let toastId: ReturnType<typeof toastManager.add> | undefined;
    const dismiss = () => {
      persistDismissal();
      if (toastId !== undefined) toastManager.close(toastId);
    };
    toastId = toastManager.add({
      type: "warning",
      title: t("permissionsChangedForLabel", { label }),
      description: t("connectionStillUsesOldPermissionsPairAgainUsingANewLink"),
      timeout: 0,
      actionProps: {
        children: t("openConnections"),
        onClick: () => {
          dismiss();
          void navigate({ to: "/settings/connections" });
        },
      },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: { children: t("dismiss"), onClick: dismiss },
        secondaryActionVariant: "ghost",
        onClose: persistDismissal,
      },
    });
  }, [environmentId, label, navigate, session]);

  return null;
});

const PermissionUpdateNotice = memo(function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map(({ environmentId, label }) => (
        <EnvironmentPermissionNotice
          key={environmentId}
          environmentId={environmentId}
          label={label}
        />
      ))}
    </>
  );
});

export default PermissionUpdateNotice;
