import { describe, expect, it } from "vite-plus/test";

import { providerUpdateMessageTranslation } from "./providerUpdateMessages.ts";

// Exact sentences emitted by apps/server/src/provider/providerMaintenanceRunner.ts
// and providerMaintenance.ts. If the server wording changes, these fail and the
// mapping plus catalogs must be updated together.
describe("providerUpdateMessageTranslation", () => {
  it("maps known server sentences to stable keys", () => {
    expect(providerUpdateMessageTranslation("Updating provider.")).toEqual({
      key: "providerMaintenance.updating",
    });
    expect(
      providerUpdateMessageTranslation(
        "Install command completed, but Code Work still cannot find the provider CLI on PATH.",
      ),
    ).toEqual({ key: "providerMaintenance.installStillMissing" });
    expect(
      providerUpdateMessageTranslation("Install the update now or review provider settings."),
    ).toEqual({ key: "installTheUpdateNowOrReviewProviderSettings" });
  });

  it("extracts params from templated sentences", () => {
    expect(providerUpdateMessageTranslation("Update command exited with code 17.")).toEqual({
      key: "providerMaintenance.updateExitCode",
      params: { exitCode: "17" },
    });
    expect(providerUpdateMessageTranslation("Installing claude-code@latest.")).toEqual({
      key: "providerMaintenance.installingPackage",
      params: { packageName: "claude-code" },
    });
    expect(
      providerUpdateMessageTranslation(
        "Failed to run update command npm install -g @x/y: EBUSY: resource busy",
      ),
    ).toEqual({
      key: "providerMaintenance.runFailed",
      params: { command: "npm install -g @x/y", detail: "EBUSY: resource busy" },
    });
  });

  it("returns null for unknown text so callers pass it through", () => {
    expect(providerUpdateMessageTranslation("WebSocket closed")).toBeNull();
    expect(providerUpdateMessageTranslation("")).toBeNull();
  });
});
