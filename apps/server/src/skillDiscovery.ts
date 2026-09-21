/**
 * SkillDiscovery — shared SKILL.md scanning and loading.
 *
 * Skills are directories containing a `SKILL.md` with YAML frontmatter
 * (`name`/`description`). Provider drivers resolve their own root set (Claude
 * mirrors its CLI's config-dir precedence; BYOK scans the generic
 * `.agents`/`.claude`/`.codex` conventions) and delegate the filesystem walk
 * here. Later roots win on name collisions, so callers order roots from
 * weakest to strongest scope.
 *
 * @module skillDiscovery
 */
import * as NodeOS from "node:os";

import type { ServerProviderSkill } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export type SkillScope = "user" | "project";

export interface SkillRoot {
  readonly directory: string;
  readonly scope: SkillScope;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | { readonly kind: "parsed"; readonly name?: string; readonly description?: string };

export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
  };
}

/**
 * Enumerate skills under the given roots in order; later roots win on name
 * collisions. Unreadable roots and entries without a readable `SKILL.md` are
 * skipped — a broken skill must never degrade the provider snapshot.
 */
export const scanSkillRoots = Effect.fn("scanSkillRoots")(function* (
  roots: ReadonlyArray<SkillRoot>,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    const entries = yield* fileSystem
      .readDirectory(root.directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

    for (const entry of [...entries].sort()) {
      const skillPath = path.join(root.directory, entry, "SKILL.md");
      const contents = yield* fileSystem
        .readFileString(skillPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (contents === undefined) {
        continue;
      }

      const frontmatter = parseSkillFrontmatter(contents);
      // Malformed frontmatter means the skill won't load in the provider
      // CLI either — skip it rather than surfacing a broken entry under its
      // directory name.
      if (frontmatter.kind === "malformed") {
        continue;
      }

      const name = (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.trim();
      if (!name) {
        continue;
      }

      skillsByName.set(name, {
        name,
        path: skillPath,
        enabled: true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description
          ? { description: frontmatter.description }
          : {}),
      });
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/** 目录约定集合：用户级 ~/.{agents,claude,codex}/skills，项目级 cwd 下同名目录。 */
const SKILL_DIR_NAMES = [".agents", ".claude", ".codex"] as const;

/**
 * BYOK 通道的技能根目录：用户级目录在前、项目级在后，同名时项目覆盖用户。
 * BYOK 没有宿主 CLI 的配置目录概念，统一扫描三种通用约定以覆盖用户自建
 * 与从 Claude/Codex 复用的技能。
 */
export const byokSkillRoots = (
  path: Path.Path,
  cwd?: string,
  homeDir: string = NodeOS.homedir(),
): ReadonlyArray<SkillRoot> => [
  ...SKILL_DIR_NAMES.map(
    (dir): SkillRoot => ({ directory: path.join(homeDir, dir, "skills"), scope: "user" }),
  ),
  ...(cwd === undefined
    ? []
    : SKILL_DIR_NAMES.map(
        (dir): SkillRoot => ({ directory: path.join(cwd, dir, "skills"), scope: "project" }),
      )),
];

/**
 * 发现 BYOK 模式下可用的技能（用户级 + 项目级）。工作区根目录不同时项目
 * 级技能不同，因此会话回合应传入线程的 cwd 而不是服务器 cwd。
 */
export const discoverByokSkills = Effect.fn("discoverByokSkills")(function* (
  cwd?: string,
  homeDir?: string,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  return yield* scanSkillRoots(byokSkillRoots(path, cwd, homeDir));
});

export type LoadedSkill = {
  readonly name: string;
  readonly path: string;
  readonly directory: string;
  readonly contents: string;
};

/**
 * 按名称解析并读取一个技能的 SKILL.md。只接受发现集合内的名称，不接受
 * 任意路径，模型无法借它读取技能目录之外的文件。
 */
export const loadSkillByName = Effect.fn("loadSkillByName")(function* (
  name: string,
  cwd?: string,
  homeDir?: string,
): Effect.fn.Return<LoadedSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const normalized = name.trim();
  if (normalized.length === 0) return undefined;
  const skills = yield* discoverByokSkills(cwd, homeDir);
  const skill = skills.find((candidate) => candidate.name === normalized);
  if (skill === undefined) return undefined;
  const contents = yield* fileSystem
    .readFileString(skill.path)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return undefined;
  return {
    name: skill.name,
    path: skill.path,
    directory: path.dirname(skill.path),
    contents,
  };
});
