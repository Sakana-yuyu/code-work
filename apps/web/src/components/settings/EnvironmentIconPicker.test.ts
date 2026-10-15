import type { ServerConfig } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { t } from "~/i18n/runtime";
import { resolveEnvironmentIconPickerLock } from "./EnvironmentIconPicker";

const config = (environmentIcon: boolean | undefined) =>
  ({
    environment: { capabilities: environmentIcon === undefined ? {} : { environmentIcon } },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentIconPickerLock", () => {
  it("locks until the environment is connected", () => {
    expect(resolveEnvironmentIconPickerLock({ serverConfig: null, operateAccess: "granted" })).toBe(
      t("environmentIconPicker.connectToChange"),
    );
  });

  it("locks on servers that predate the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentIconPickerLock({
        serverConfig: config(undefined),
        operateAccess: "denied",
      }),
    ).toBe(t("environmentIconPicker.serverTooOld"));
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toBe(t("environmentIconPicker.cannotChangeSettings"));
  });

  it("waits for a settings grant before allowing changes", () => {
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "pending" }),
    ).toBe(t("environmentIconPicker.cannotChangeSettings"));
    expect(
      resolveEnvironmentIconPickerLock({ serverConfig: config(true), operateAccess: "granted" }),
    ).toBeNull();
  });
});
