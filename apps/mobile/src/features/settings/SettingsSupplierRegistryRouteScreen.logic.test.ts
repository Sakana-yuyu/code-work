import { describe, expect, it } from "vite-plus/test";

import {
  formatOrphanProfilesWarning,
  formatSupplierProfileSummary,
  supplierDisplayName,
  supplierEnabledLabelKey,
} from "./SettingsSupplierRegistryRouteScreen.logic";

describe("supplierDisplayName", () => {
  it("prefers the display name when present", () => {
    expect(supplierDisplayName({ instanceId: "inst-1", displayName: "My OpenAI" })).toBe(
      "My OpenAI",
    );
  });

  it("falls back to the instance id when the display name is missing", () => {
    expect(supplierDisplayName({ instanceId: "inst-1" })).toBe("inst-1");
  });
});

describe("supplierEnabledLabelKey", () => {
  it("maps the enabled flag to the matching i18n key", () => {
    expect(supplierEnabledLabelKey(true)).toBe("supplierRegistry.enabled");
    expect(supplierEnabledLabelKey(false)).toBe("supplierRegistry.disabled");
  });
});

describe("formatSupplierProfileSummary", () => {
  it("joins the agent id and status", () => {
    expect(formatSupplierProfileSummary({ agentId: "provider:inst-1", status: "available" })).toBe(
      "provider:inst-1 · available",
    );
  });
});

describe("formatOrphanProfilesWarning", () => {
  it("returns null when there are no orphaned profiles", () => {
    expect(formatOrphanProfilesWarning("Orphaned agent profiles", [])).toBeNull();
  });

  it("lists orphaned profile agent ids after the label", () => {
    expect(
      formatOrphanProfilesWarning("Orphaned agent profiles", ["provider:gone-1", "provider:gone-2"]),
    ).toBe("Orphaned agent profiles: provider:gone-1, provider:gone-2");
  });
});
