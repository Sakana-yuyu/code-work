import type { ProjectCanvasSummary } from "@codework/contracts";

import type { RightPanelSurface } from "~/rightPanelStore";

export {
  canvasReferenceFromArtifactPath,
  isCodeworkCanvasArtifactPath,
  parseCanvasDocument,
  parseCanvasReference,
  resolveCanvasReferenceForFiles,
} from "@codework/shared/canvas";

export type CanvasSurface = Extract<RightPanelSurface, { kind: "canvas" }>;

/**
 * Combine this thread's live canvas surfaces with the project-wide on-disk
 * artifacts for the recent sidebar. Live entries win so a thread's surfaces
 * keep their state; disk entries fill in canvases generated in other threads
 * or before this page load. Deduped by canvasId, which is also the surface-id
 * namespace (`canvas:<id>`) used for activation, so the list stays unique.
 */
export function mergeRecentCanvasSurfaces(
  live: ReadonlyArray<CanvasSurface>,
  disk: ReadonlyArray<ProjectCanvasSummary>,
): CanvasSurface[] {
  const seenCanvasIds = new Set<string>();
  const merged: CanvasSurface[] = [];
  for (const surface of live) {
    if (seenCanvasIds.has(surface.canvasId)) continue;
    seenCanvasIds.add(surface.canvasId);
    merged.push(surface);
  }
  for (const summary of disk) {
    if (seenCanvasIds.has(summary.canvasId)) continue;
    seenCanvasIds.add(summary.canvasId);
    merged.push({
      id: `canvas:${summary.canvasId}`,
      kind: "canvas",
      canvasId: summary.canvasId,
      title: summary.title,
      relativePath: summary.relativePath,
    });
  }
  return merged;
}
