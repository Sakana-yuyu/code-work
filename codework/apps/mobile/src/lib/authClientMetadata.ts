import type { AuthClientPresentationMetadata } from "@codework/contracts";
import { Platform } from "react-native";
import { t } from "../i18n/runtime";

export function authClientMetadata(appVersion?: string): AuthClientPresentationMetadata {
  return {
    label: t("codeWorkMobile"),
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
    surface: "mobile",
    ...(appVersion ? { appVersion } : {}),
  };
}
