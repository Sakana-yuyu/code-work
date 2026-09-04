import { CanvasDocument, CanvasReference } from "@codework/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isCodeworkCanvasArtifactPath } from "./path.ts";

const decodeReference = Schema.decodeUnknownOption(CanvasReference);
const decodeDocument = Schema.decodeUnknownOption(CanvasDocument);

export { isCodeworkCanvasArtifactPath };

function normalizeCanvasPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** 从 Canvas 管理目录中的文件名恢复引用，兼容旧的 .json 产物。 */
export function canvasReferenceFromArtifactPath(path: string): CanvasReference | null {
  const normalizedPath = normalizeCanvasPath(path);
  if (!isCodeworkCanvasArtifactPath(normalizedPath) || !normalizedPath.endsWith(".json")) {
    return null;
  }
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const canvasId = fileName.replace(/\.canvas\.json$|\.json$/u, "");
  if (!canvasId || canvasId.includes("/")) return null;
  return {
    canvasId,
    title: canvasId.replaceAll("-", " "),
    relativePath: normalizedPath,
  };
}

export function resolveCanvasReferenceForFiles(
  files: ReadonlyArray<{ readonly path: string }>,
  references: ReadonlyArray<CanvasReference>,
): CanvasReference | null {
  for (const file of files) {
    const normalizedPath = normalizeCanvasPath(file.path);
    const reference = references.find(
      (candidate) => normalizeCanvasPath(candidate.relativePath) === normalizedPath,
    );
    if (reference) return reference;
    const inferred = canvasReferenceFromArtifactPath(normalizedPath);
    if (inferred) return inferred;
  }
  return null;
}

export function parseCanvasReference(value: unknown, depth = 0): CanvasReference | null {
  if (depth > 4) return null;
  const direct = Option.getOrNull(decodeReference(value));
  if (direct) return direct;
  if (typeof value === "string") {
    try {
      return parseCanvasReference(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = parseCanvasReference(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["canvas", "result", "structuredContent", "content", "data", "item"]) {
    const found = parseCanvasReference(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function parseCanvasDocument(contents: string): CanvasDocument | null {
  try {
    return Option.getOrNull(decodeDocument(JSON.parse(contents)));
  } catch {
    return null;
  }
}
