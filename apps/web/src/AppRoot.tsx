import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import type { DesktopTrayRecentItem } from "@codework/contracts";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { PreviewAutomationHosts } from "./components/preview/PreviewAutomationHosts";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { isElectron } from "./env";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { useProjects, useThreadShells } from "./state/entities";
import type { AppRouter } from "./router";

/**
 * Owns renderer-wide providers. The Electron browser host intentionally sits
 * outside the router so its webviews survive route transitions, but it must
 * share the same atom registry as routed UI.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
      <DesktopTrayRecentsSync />
      <PreviewAutomationHosts />
      <ElectronBrowserHost />
      <QuitHoldOverlay />
    </AppAtomRegistryProvider>
  );
}

function DesktopTrayRecentsSync() {
  const projects = useProjects();
  const threads = useThreadShells();
  const recentItems = useMemo<ReadonlyArray<DesktopTrayRecentItem>>(() => {
    const projectsByKey = new Map(
      projects.map((project) => [`${project.environmentId}\u0000${project.id}`, project] as const),
    );
    return threads
      .filter((thread) => thread.archivedAt === null)
      .flatMap((thread) => {
        const project = projectsByKey.get(`${thread.environmentId}\u0000${thread.projectId}`);
        return project === undefined
          ? []
          : [
              {
                environmentId: thread.environmentId,
                projectId: project.id,
                threadId: thread.id,
                projectTitle: project.title,
                threadTitle: thread.title,
                updatedAt: thread.latestUserMessageAt ?? thread.updatedAt,
                isRunning:
                  (thread.session?.status === "running" && thread.session.activeTurnId != null) ||
                  thread.backgroundLiveness === "working",
                isPinned: thread.pinnedAt != null,
              } satisfies DesktopTrayRecentItem,
            ];
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 24);
  }, [projects, threads]);

  useEffect(() => {
    if (!isElectron) return;
    const updateTrayRecents = window.desktopBridge?.updateTrayRecents;
    if (typeof updateTrayRecents !== "function") return;
    void updateTrayRecents(recentItems).catch(() => undefined);
  }, [recentItems]);

  return null;
}
