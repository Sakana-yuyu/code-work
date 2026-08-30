import { t } from "~/i18n";

import type { LocalPluginFailureCode } from "./localPluginFailureJournal";

export function localPluginFailureLabel(code: LocalPluginFailureCode): string {
  switch (code) {
    case "invalid-json":
      return t("localPlugins.error.invalidJson");
    case "manifest-read-failed":
      return t("localPlugins.error.readFailed");
    case "schema-invalid":
      return t("localPlugins.error.schemaInvalid");
    case "api-incompatible":
      return t("localPlugins.error.apiIncompatible");
    case "manifest-invalid":
      return t("localPlugins.error.manifestInvalid");
    case "plugin-not-found":
      return t("localPlugins.error.notFound");
    case "storage-invalid":
      return t("localPlugins.error.storageInvalid");
    case "storage-duplicate-id":
      return t("localPlugins.error.storageDuplicateId");
    case "storage-lock-unavailable":
      return t("localPlugins.error.storageLockUnavailable");
    case "storage-conflict":
      return t("localPlugins.error.storageConflict");
    case "storage-write-failed":
      return t("localPlugins.error.storageWriteFailed");
    case "contribution-invoke-failed":
      return t("localPlugins.error.contributionInvokeFailed");
    case "contribution-render-failed":
      return t("localPlugins.error.contributionRenderFailed");
    case "timeline-storage-restore-failed":
      return t("localPlugins.error.timelineStorageRestoreFailed");
  }
}
