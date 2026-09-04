import type {
  PullRequestDiffFileContentsInput,
  PullRequestListEntry,
  PullRequestReviewPosition,
  PullRequestThreadComment,
} from "@codework/contracts";

import type { ParsedDiffFile, ParsedDiffLine } from "../review/diffParser";

export function pullRequestDiffFilePaths(
  file: Pick<ParsedDiffFile, "oldPath" | "newPath">,
): { readonly oldPath: string; readonly newPath: string } | null {
  const oldPath = file.oldPath ?? file.newPath;
  const newPath = file.newPath ?? file.oldPath;
  return oldPath === null || newPath === null ? null : { oldPath, newPath };
}

export function pullRequestDiffFileChangeType(
  file: ParsedDiffFile,
): PullRequestDiffFileContentsInput["changeType"] {
  if (file.oldPath === null) return "new";
  if (file.newPath === null) return "deleted";
  if (file.oldPath === file.newPath) return "change";
  return file.lines.some((line) => line.type === "add" || line.type === "delete")
    ? "rename-changed"
    : "rename-pure";
}

export function pullRequestEntryKey(
  entry: Pick<PullRequestListEntry, "projectId" | "repository" | "number">,
): string {
  return `${entry.projectId}:${entry.repository}:${entry.number}`;
}

export function mergePullRequestEntries(
  existing: ReadonlyArray<PullRequestListEntry>,
  next: ReadonlyArray<PullRequestListEntry>,
): ReadonlyArray<PullRequestListEntry> {
  const seen = new Set(existing.map(pullRequestEntryKey));
  return [...existing, ...next.filter((entry) => !seen.has(pullRequestEntryKey(entry)))];
}

export function mergePullRequestThreadComments(
  existing: ReadonlyArray<PullRequestThreadComment>,
  next: ReadonlyArray<PullRequestThreadComment>,
): ReadonlyArray<PullRequestThreadComment> {
  const seen = new Set(existing.map((comment) => comment.id));
  return [...existing, ...next.filter((comment) => !seen.has(comment.id))];
}

export function pullRequestReviewPositionForLine(
  line: ParsedDiffLine,
): PullRequestReviewPosition | null {
  if (line.type === "add" && line.newLine !== null && line.newLine > 0) {
    return { kind: "added", newLine: line.newLine };
  }
  if (line.type === "delete" && line.oldLine !== null && line.oldLine > 0) {
    return { kind: "deleted", oldLine: line.oldLine };
  }
  if (
    line.type === "context" &&
    line.oldLine !== null &&
    line.oldLine > 0 &&
    line.newLine !== null &&
    line.newLine > 0
  ) {
    return { kind: "context", oldLine: line.oldLine, newLine: line.newLine, side: "right" };
  }
  return null;
}

export function pullRequestReviewPositionLine(position: PullRequestReviewPosition): number {
  return position.kind === "added" || position.kind === "context"
    ? position.newLine
    : position.oldLine;
}
