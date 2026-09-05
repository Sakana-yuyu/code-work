import type { RelayClientDeviceRecord } from "@codework/contracts/relay";

import { t } from "~/i18n";

const mobileClientUpdatedAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const NOTIFICATION_PREFERENCES = [
  ["notifyOnApproval", "clerk.notificationApprovals"],
  ["notifyOnInput", "clerk.notificationInputRequests"],
  ["notifyOnCompletion", "clerk.notificationCompletions"],
  ["notifyOnFailure", "clerk.notificationFailures"],
] as const satisfies ReadonlyArray<
  readonly [keyof RelayClientDeviceRecord["notifications"], string]
>;

export function mobileClientPlatformLabel(device: RelayClientDeviceRecord): string {
  return `iOS ${device.iosMajorVersion}${device.appVersion ? ` · Code Work ${device.appVersion}` : ""}`;
}

export function mobileClientNotificationDetail(device: RelayClientDeviceRecord): string {
  if (!device.notifications.enabled) {
    return t("clerk.pushDisabledDevice");
  }

  const enabledPreferences = NOTIFICATION_PREFERENCES.flatMap(([preference, label]) =>
    device.notifications[preference] ? [t(label)] : [],
  );
  return enabledPreferences.length > 0
    ? t("clerk.alertsEnabledFor", { alerts: enabledPreferences.join(", ") })
    : t("clerk.pushEnabledNoAlerts");
}

export function mobileClientUpdatedAtLabel(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime())
    ? t("clerk.updateTimeUnavailable")
    : t("clerk.updatedAtLabel", { datetime: mobileClientUpdatedAtFormatter.format(date) });
}
