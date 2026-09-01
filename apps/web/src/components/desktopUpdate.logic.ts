import { t } from "~/i18n/runtime";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@codework/contracts";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_TAG_URL = "https://github.com/Sakana-yuyu/code-work/releases/tag";

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowDesktopUpdateButton(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) {
    return false;
  }
  if (state.status === "downloading") {
    return true;
  }
  return resolveDesktopUpdateButtonAction(state) !== "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return t("thisInstallIsUsingTheCorrectArchitecture");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return t("thisMacHasAppleSiliconButCodeworkIsStillRunningTheIntelBuildUn");
  }
  if (action === "install") {
    return t("thisMacHasAppleSiliconButCodeworkIsStillRunningTheIntelBuildUn2");
  }
  return t("thisMacHasAppleSiliconButCodeworkIsStillRunningTheIntelBuildUn23");
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return state.availableVersion
      ? t("desktopUpdate.readyToDownload", { version: state.availableVersion })
      : t("desktopUpdate.readyToDownloadNoVersion");
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? t("desktopUpdate.downloadingWithProgress", { percent: Math.floor(state.downloadPercent) })
      : t("desktopUpdate.downloading");
  }
  if (state.status === "downloaded") {
    return t("desktopUpdate.downloadedRestart", {
      version: state.downloadedVersion ?? state.availableVersion ?? t("desktopUpdate.versionReady"),
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return t("desktopUpdate.downloadFailed", { version: state.availableVersion });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return t("desktopUpdate.installFailed", { version: state.downloadedVersion });
    }
    if (state.downloadedVersion) {
      return t("desktopUpdate.downloadedRestart", { version: state.downloadedVersion });
    }
    return state.message ?? t("updateFailed");
  }
  return t("upToDate");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return `Install update${version ? ` ${version}` : ""} and restart Code Work?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.`;
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function shouldHighlightDesktopUpdateError(state: DesktopUpdateState | null): boolean {
  if (!state || state.status !== "error") return false;
  return state.errorContext === "download" || state.errorContext === "install";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
