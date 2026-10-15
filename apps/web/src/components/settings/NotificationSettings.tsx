import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  NOTIFICATION_MODES,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { t } from "../../i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function NotificationSettings() {
  const mode = usePrimarySettings((settings) => settings.notificationMode);
  const updateSettings = useUpdatePrimarySettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...searchableSetting("thread-notifications")}
      description={permissionMessage ?? t("settings.threadNotificationsDescription")}
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (!NOTIFICATION_MODES.includes(value as (typeof NOTIFICATION_MODES)[number])) return;
            const nextMode = value as (typeof NOTIFICATION_MODES)[number];
            setPermissionMessage(null);
            if (hasNotificationSound(nextMode)) unlockNotificationAudio();
            if (hasDesktopNotifications(nextMode)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(t("settings.threadNotificationsUnsupported"));
                return;
              }
              setRequesting(true);
              try {
                const permission = await Notification.requestPermission();
                if (permission !== "granted") {
                  setPermissionMessage(t("settings.threadNotificationsDenied"));
                  return;
                }
              } catch {
                setPermissionMessage(t("settings.threadNotificationsUnsupported"));
                return;
              } finally {
                setRequesting(false);
              }
            }
            void updateSettings({ notificationMode: nextMode });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("settings.threadNotifications")}
          >
            <SelectValue>{t(`settings.notificationMode.${mode}`)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {NOTIFICATION_MODES.map((value) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(`settings.notificationMode.${value}`)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
