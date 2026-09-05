/**
 * Provider maintenance progress and failure sentences arrive from the server in
 * `provider.updateState.message` (see apps/server/src/provider/providerMaintenanceRunner.ts).
 * The server cannot know the UI language, so known sentences map to stable i18n keys
 * here and the client translates before rendering; unknown text returns null and the
 * caller shows it verbatim (same policy as serverSessionErrorTranslation). When the
 * server adds a sentence, register it here and in the catalogs.
 */

export interface ProviderUpdateMessageTranslation {
  readonly key: string;
  readonly params?: Record<string, string>;
}

const EXACT_MESSAGES: Readonly<Record<string, string>> = {
  "Updating provider.": "providerMaintenance.updating",
  "Waiting for another provider update to finish.": "providerMaintenance.waitingForOtherUpdate",
  "Waiting for another provider update or install to finish.":
    "providerMaintenance.waitingForOtherUpdateOrInstall",
  "Running the provider CLI installer.": "providerMaintenance.runningInstaller",
  "Provider updated.": "providerMaintenance.updated",
  "Update command completed, but Code Work could not verify the provider version.":
    "providerMaintenance.updateUnverified",
  "Update command completed, but Code Work still detects an outdated provider version.":
    "providerMaintenance.updateStillOutdated",
  "Provider CLI installed.": "providerMaintenance.cliInstalled",
  "Install command completed, but Code Work could not verify the provider installation.":
    "providerMaintenance.installUnverified",
  "Install command completed, but Code Work still cannot find the provider CLI on PATH.":
    "providerMaintenance.installStillMissing",
  "Update timed out.": "providerMaintenance.updateTimedOut",
  "Update command failed.": "providerMaintenance.updateFailed",
  "Install timed out.": "providerMaintenance.installTimedOut",
  "The package manager could not be started; install Node.js (npm) first, then retry.":
    "providerMaintenance.packageManagerMissing",
  "Install command failed.": "providerMaintenance.installFailed",
  "Update command failed to run.": "providerMaintenance.runFailedGeneric",
  "Install the update now or review provider settings.":
    "installTheUpdateNowOrReviewProviderSettings",
};

export function providerUpdateMessageTranslation(
  message: string,
): ProviderUpdateMessageTranslation | null {
  const exact = EXACT_MESSAGES[message];
  if (exact !== undefined) return { key: exact };

  let match = /^Update command exited with code (\d+)\.$/.exec(message);
  if (match) {
    return { key: "providerMaintenance.updateExitCode", params: { exitCode: match[1]! } };
  }
  match = /^Install command exited with code (\d+)\.$/.exec(message);
  if (match) {
    return { key: "providerMaintenance.installExitCode", params: { exitCode: match[1]! } };
  }
  match = /^Installing (\S+)@latest\.$/.exec(message);
  if (match) {
    return { key: "providerMaintenance.installingPackage", params: { packageName: match[1]! } };
  }
  match = /^Failed to run update command (.+?): ([\s\S]*)$/.exec(message);
  if (match) {
    return {
      key: "providerMaintenance.runFailed",
      params: { command: match[1]!, detail: match[2]! },
    };
  }
  return null;
}
