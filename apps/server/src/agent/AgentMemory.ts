import type { AgentMemorySettings } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

export const PROJECT_MEMORY_RELATIVE_PATH = ".codework/memory.md";
export const MAX_MEMORY_CHARS = 32_000;

export type MemoryScope = "user" | "project";
export type MemoryWriteMode = "append" | "replace";

export function clampMemoryText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_MEMORY_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_MEMORY_CHARS)}\n…`;
}

export function appendMemoryNote(
  current: string,
  note: string,
  mode: MemoryWriteMode = "append",
): string {
  const next = note.trim();
  if (next.length === 0) return clampMemoryText(current);
  if (mode === "replace" || current.trim().length === 0) return clampMemoryText(next);
  return clampMemoryText(`${current.trimEnd()}\n\n${next}`);
}

export function recallMemory(haystack: string, query: string): string {
  const text = haystack.trim();
  if (text.length === 0) return "";
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return text;
  const matched = text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.toLowerCase().includes(needle));
  return matched.length === 0 ? text : matched.join("\n\n");
}

export function formatMemoryGuidance(input: {
  readonly userNotes: string;
  readonly projectNotes: string;
}): string {
  const user = input.userNotes.trim();
  const project = input.projectNotes.trim();
  if (user.length === 0 && project.length === 0) {
    return [
      "当前没有已保存的 agent 记忆。需要跨回合记住的事实请用 memory.save 写入（scope=user 为服务器级用户笔记，scope=project 为当前项目 .codework/memory.md）。查找已有笔记用 memory.recall。",
    ].join("\n");
  }
  const parts = [
    "以下是 Code Work 为当前环境保存的 agent 记忆。需要更新时调用 memory.save；查找时调用 memory.recall。不要把记忆里没有的内容当成已知事实。",
  ];
  if (user.length > 0) {
    parts.push(`<agent-memory scope="user">\n${user}\n</agent-memory>`);
  }
  if (project.length > 0) {
    parts.push(`<agent-memory scope="project">\n${project}\n</agent-memory>`);
  }
  return parts.join("\n\n");
}

export function formatMemoryListing(input: {
  readonly enabled: boolean;
  readonly userNotes: string;
  readonly projectNotes: string;
}): string {
  if (!input.enabled) {
    return "Agent memory is turned off. Enable it in Settings → Integrations → Agent memory.";
  }
  const user = input.userNotes.trim();
  const project = input.projectNotes.trim();
  const lines = [
    "Agent memory (Settings → Integrations → Agent memory):",
    "",
    "User notes:",
    user.length === 0 ? "(empty)" : user,
    "",
    "Project notes (.codework/memory.md):",
    project.length === 0 ? "(empty)" : project,
    "",
    "In chat: /memory lists notes. /memory <text> appends to user notes. Agents can also call memory.save and memory.recall.",
  ];
  return lines.join("\n");
}

export const projectMemoryFilePath = (path: Path.Path, workspaceRoot: string): string =>
  path.join(workspaceRoot, ".codework", "memory.md");

// 读失败要冒泡而不是当空文件：调用方据此区分“没有笔记”和“读不出来”，
// 避免 memory.save 的 append 把读失败的现有笔记当成空再覆盖写。
export const readProjectMemory = (
  workspaceRoot: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = projectMemoryFilePath(path, workspaceRoot);
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "";
    return yield* fileSystem.readFileString(filePath);
  });

export const writeProjectMemory = (
  workspaceRoot: string,
  contents: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = projectMemoryFilePath(path, workspaceRoot);
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    const next = clampMemoryText(contents);
    yield* fileSystem.writeFileString(filePath, next.length === 0 ? "" : `${next}\n`);
    return next;
  });

export const loadMemoryForPrompt = (
  settings: AgentMemorySettings,
  workspaceRoot: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (!settings.enabled) return "";
    const projectNotes = yield* readProjectMemory(workspaceRoot);
    return formatMemoryGuidance({
      userNotes: settings.userNotes,
      projectNotes,
    });
  });
