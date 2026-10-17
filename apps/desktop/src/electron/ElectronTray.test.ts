import { describe, expect, it } from "vite-plus/test";

import { normalizeTrayRecentItems, shouldCloseToTray, trayThreadAction } from "./ElectronTray.ts";

describe("ElectronTray", () => {
  it("hides to the tray only while the tray exists and no quit is in flight", () => {
    expect(shouldCloseToTray({ trayReady: true, quitting: false })).toBe(true);
    // Without a tray icon the app could never be brought back: close for real.
    expect(shouldCloseToTray({ trayReady: false, quitting: false })).toBe(false);
    // Tray Quit and Cmd+Q drive before-quit; swallowing that close would hang.
    expect(shouldCloseToTray({ trayReady: true, quitting: true })).toBe(false);
    expect(shouldCloseToTray({ trayReady: false, quitting: true })).toBe(false);
  });

  it("keeps the latest bounded set of valid conversations without duplicates", () => {
    expect(
      normalizeTrayRecentItems([
        {
          environmentId: " env-1 ",
          projectId: "project-1",
          threadId: "thread-1",
          projectTitle: " Project ",
          threadTitle: " Conversation ",
          updatedAt: "2026-09-04T00:00:00.000Z",
          isRunning: false,
          isPinned: false,
        },
        {
          environmentId: "env-1",
          projectId: "project-1",
          threadId: "thread-1",
          projectTitle: "Duplicate",
          threadTitle: "Duplicate",
          updatedAt: "2026-09-04T00:01:00.000Z",
          isRunning: false,
          isPinned: false,
        },
        {
          environmentId: " ",
          projectId: "project-2",
          threadId: "thread-2",
          projectTitle: "Ignored",
          threadTitle: "Ignored",
          updatedAt: "2026-09-04T00:00:00.000Z",
          isRunning: false,
          isPinned: false,
        },
      ]),
    ).toEqual([
      {
        environmentId: "env-1",
        projectId: "project-1",
        threadId: "thread-1",
        projectTitle: "Project",
        threadTitle: "Conversation",
        updatedAt: "2026-09-04T00:00:00.000Z",
        isRunning: false,
        isPinned: false,
      },
    ]);
  });

  it("encodes environment and thread identifiers for the renderer action", () => {
    expect(trayThreadAction({ environmentId: "env:one", threadId: "thread/two" })).toBe(
      "open-thread:env%3Aone:thread%2Ftwo",
    );
  });
});
