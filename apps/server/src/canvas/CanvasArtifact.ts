// @effect-diagnostics nodeBuiltinImport:off
import {
  CanvasCreateInput,
  CanvasDocument,
  CanvasReference,
  ProjectCanvasSummary,
} from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";

import {
  CODEWORK_CANVAS_ARTIFACT_DIRECTORY,
  CODEWORK_CANVAS_ARTIFACT_PREFIX,
  isCodeworkCanvasArtifactPath,
} from "@codework/shared/path";
import type * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import type * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

type CanvasWriter = Pick<WorkspaceFileSystem.WorkspaceFileSystem["Service"], "writeFile">;
type WorkspaceRootNormalizer = Pick<
  WorkspacePaths.WorkspacePaths["Service"],
  "normalizeWorkspaceRoot"
>;

/**
 * Bounds for the project-wide artifact scan: the canvases directory only ever
 * holds agent-written JSON documents, so a shallow walk with generous caps is
 * enough to keep listing cheap even on long-lived workspaces.
 */
const CANVAS_SCAN_MAX_FILES = 500;
const CANVAS_SCAN_MAX_DEPTH = 3;
const CANVAS_LIST_MAX_RESULTS = 200;

const safeSegment = (value: string, fallback: string): string => {
  const normalized = value
    .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized.length > 0 ? normalized : fallback;
};

export const writeCanvasArtifact = (input: {
  readonly fileSystem: CanvasWriter;
  readonly request: CanvasCreateInput;
  readonly threadId: string;
  readonly fallbackCanvasId: string;
  readonly now?: number;
}) => {
  const prepare = (now: number) => {
    const canvasId = safeSegment(input.request.canvasId ?? input.fallbackCanvasId, "code-analysis");
    const fileName = safeSegment(input.request.title, canvasId);
    const threadSegment = safeSegment(input.threadId, "thread");
    const relativePath = `${CODEWORK_CANVAS_ARTIFACT_PREFIX}${threadSegment}/${fileName}.canvas.json`;
    const reference = Schema.decodeUnknownSync(CanvasReference)({
      canvasId,
      title: input.request.title,
      ...(input.request.summary === undefined ? {} : { summary: input.request.summary }),
      relativePath,
    });
    const document = Schema.decodeUnknownSync(CanvasDocument)({
      schemaVersion: 1,
      ...reference,
      blocks: input.request.blocks,
      createdAt: now,
      updatedAt: now,
    });
    return {
      reference,
      relativePath,
      contents: Schema.encodeSync(Schema.fromJsonString(CanvasDocument))(document),
    };
  };

  return Effect.gen(function* () {
    const now = input.now ?? (yield* Clock.currentTimeMillis);
    const artifact = prepare(now);
    yield* input.fileSystem.writeFile({
      cwd: input.request.cwd,
      relativePath: artifact.relativePath,
      contents: artifact.contents,
    });
    return artifact.reference;
  });
};

const readDirents = async (dir: string) => {
  try {
    return await NodeFSP.readdir(dir, { withFileTypes: true });
  } catch {
    // No canvases directory (or unreadable) simply means no canvases yet.
    return null;
  }
};

const readCanvasSummary = async (absolutePath: string): Promise<ProjectCanvasSummary | null> => {
  try {
    const contents = await NodeFSP.readFile(absolutePath, "utf8");
    const document = Schema.decodeUnknownSync(Schema.fromJsonString(CanvasDocument))(contents);
    return {
      canvasId: document.canvasId,
      title: document.title,
      relativePath: document.relativePath,
      updatedAt: document.updatedAt,
    };
  } catch {
    // A single unreadable or invalid artifact must not hide the others.
    return null;
  }
};

/**
 * Project-wide recent-canvas listing: walks the managed canvases directory
 * (newest first). Entries are sourced from the artifacts themselves rather
 * than workspace path listings, which deliberately exclude `.codework/`.
 * An unresolvable workspace degrades to an empty listing: the sidebar treats
 * "no canvases" and "no workspace" the same way.
 */
export const listCanvasArtifacts = (input: {
  readonly workspacePaths: WorkspaceRootNormalizer;
  readonly cwd: string;
}): Effect.Effect<ReadonlyArray<ProjectCanvasSummary>> =>
  Effect.gen(function* () {
    const workspaceRoot = yield* input.workspacePaths
      .normalizeWorkspaceRoot(input.cwd)
      .pipe(Effect.orElseSucceed(() => null));
    if (workspaceRoot === null) return [];
    const canvasesRoot = `${workspaceRoot}/${CODEWORK_CANVAS_ARTIFACT_DIRECTORY}`;

    const summaries: ProjectCanvasSummary[] = [];
    let filesSeen = 0;
    const relativePathOf = (absolutePath: string) =>
      absolutePath.slice(workspaceRoot.length + 1).replaceAll("\\", "/");
    const collect = async (dir: string, depth: number): Promise<void> => {
      const dirents = await readDirents(dir);
      if (dirents === null) return;
      for (const dirent of dirents) {
        if (filesSeen >= CANVAS_SCAN_MAX_FILES) return;
        const entryPath = `${dir}/${dirent.name}`;
        if (dirent.isDirectory()) {
          if (depth >= CANVAS_SCAN_MAX_DEPTH) continue;
          await collect(entryPath, depth + 1);
          continue;
        }
        if (
          !dirent.isFile() ||
          !isCodeworkCanvasArtifactPath(relativePathOf(entryPath)) ||
          !dirent.name.endsWith(".json")
        ) {
          continue;
        }
        filesSeen += 1;
        const summary = await readCanvasSummary(entryPath);
        if (summary) summaries.push(summary);
      }
    };

    yield* Effect.promise(() => collect(canvasesRoot, 0));

    return summaries
      .toSorted((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, CANVAS_LIST_MAX_RESULTS);
  });
