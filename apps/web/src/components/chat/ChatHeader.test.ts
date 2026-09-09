import { EnvironmentId, ThreadId } from "@codework/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ChatHeader, resolveRenameCommit, shouldShowOpenInPicker } from "./ChatHeader";
import { t } from "../../i18n";

vi.mock("../../workspaceLayout", () => ({ useIdeViewportAvailable: () => true }));
vi.mock("../../hooks/useCodeworkProjectFileScripts", () => ({
  useCodeworkProjectFileScripts: () => [],
}));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn(), closeMenu: vi.fn() }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../remoteOpen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../remoteOpen")>()),
  useRemoteOpenState: () => ({ mode: "local-exec" }),
}));

it("项目尚未解析到时，对话和 IDE 的往返切换仍可点击", () => {
  const action = vi.fn();
  for (const workspaceLayout of ["chat", "ide"] as const) {
    const markup = renderToStaticMarkup(
      createElement(ChatHeader, {
        activeThreadEnvironmentId: EnvironmentId.make("local"),
        activeThreadId: ThreadId.make("draft-thread"),
        activeThreadTitle: "新建线程",
        isServerThread: false,
        changeRequest: null,
        activeProjectName: undefined,
        activeProjectCwd: null,
        activeProjectFaviconPath: null,
        openInCwd: null,
        activeProjectScripts: undefined,
        preferredScriptId: null,
        keybindings: [],
        availableEditors: [],
        rightPanelOpen: false,
        workspaceLayout,
        onWorkspaceLayoutChange: action,
        gitCwd: null,
        onNewThreadInProject: action,
        onRunProjectScript: action,
        onAddProjectScript: action,
        onUpdateProjectScript: action,
        onDeleteProjectScript: action,
      }),
    );
    expect(markup.match(/aria-pressed="(?:true|false)"/g)).toHaveLength(2);
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain(
      `aria-label="${t("workspace.layout")}: ${t(workspaceLayout === "ide" ? "workspace.ideMode" : "workspace.chatMode")}"`,
    );
  }
});

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(true);
  });

  it("shows the picker for remote environments in deep-link mode", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(true);
  });

  it("shows the picker's unavailable state for remote environments without an SSH route", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        remoteOpenMode: "remote-unavailable",
      }),
    ).toBe(true);
  });

  it("hides the picker for non-primary local backends", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        remoteOpenMode: "local-exec",
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        remoteOpenMode: "remote-links",
      }),
    ).toBe(false);
  });
});

describe("resolveRenameCommit", () => {
  it("commits a trimmed changed title", () => {
    expect(resolveRenameCommit({ title: "  New title ", originalTitle: "Old" })).toEqual({
      action: "commit",
      title: "New title",
    });
  });

  it("rejects empty and whitespace-only titles", () => {
    expect(resolveRenameCommit({ title: "   ", originalTitle: "Old" })).toEqual({
      action: "reject-empty",
    });
  });

  it("no-ops when the trimmed title is unchanged", () => {
    expect(resolveRenameCommit({ title: " Old ", originalTitle: "Old" })).toEqual({
      action: "noop",
    });
  });
});
