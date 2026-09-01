import { describe, expect, it } from "vite-plus/test";

import { t } from "~/i18n/runtime";
import { editorLabelForPlatform, openInEditorMenuLabel } from "./editorLabels";

describe("editorLabelForPlatform", () => {
  it("uses the editor name from the shared editor definitions", () => {
    expect(editorLabelForPlatform("cursor", "MacIntel")).toBe("Cursor");
    expect(editorLabelForPlatform("vscode-insiders", "Win32")).toBe("VS Code Insiders");
  });

  it.each([
    ["MacIntel", t("finder")],
    ["Win32", t("explorer")],
    ["Linux x86_64", t("surface.files")],
  ])("uses the platform file-manager name on %s", (platform, label) => {
    expect(editorLabelForPlatform("file-manager", platform)).toBe(label);
  });
});

describe("openInEditorMenuLabel", () => {
  it("names the preferred editor", () => {
    expect(openInEditorMenuLabel("zed")).toBe(t("commandPalette.openInManager", { manager: "Zed" }));
  });

  it("keeps the generic label for the default file handler and missing preferences", () => {
    expect(openInEditorMenuLabel("file-manager")).toBe(t("openInEditor"));
    expect(openInEditorMenuLabel(null)).toBe(t("openInEditor"));
  });
});
