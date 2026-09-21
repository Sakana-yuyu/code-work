import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverByokSkills, loadSkillByName } from "./skillDiscovery.ts";

const writeSkill = Effect.fn("writeSkill")(function* (root: string, dir: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillDir = path.join(root, dir);
  yield* fileSystem.makeDirectory(skillDir, { recursive: true });
  yield* fileSystem.writeFileString(path.join(skillDir, "SKILL.md"), contents);
});

describe("skillDiscovery", () => {
  it.effect("扫描用户级与项目级技能目录，同名项目级覆盖用户级", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-skills-home-",
      });
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-skills-cwd-",
      });

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills"),
        "user-only",
        "---\nname: user-only\ndescription: 用户级技能\n---\nuser body\n",
      );
      yield* writeSkill(
        path.join(homeDir, ".claude", "skills"),
        "shared",
        "---\nname: shared\ndescription: 用户级版本\n---\nuser shared\n",
      );
      yield* writeSkill(
        path.join(cwd, ".agents", "skills"),
        "shared",
        "---\nname: shared\ndescription: 项目级版本\n---\nproject shared\n",
      );
      yield* writeSkill(path.join(cwd, ".codex", "skills"), "proj", "no frontmatter body\n");
      // 坏 frontmatter 的技能跳过而不是以目录名兜底。
      yield* writeSkill(
        path.join(cwd, ".agents", "skills"),
        "broken",
        "---\nname: [unclosed\n---\nbody\n",
      );

      const skills = yield* discoverByokSkills(cwd, homeDir);
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      expect(byName.has("user-only")).toBe(true);
      expect(byName.get("user-only")?.scope).toBe("user");
      expect(byName.get("shared")?.scope).toBe("project");
      expect(byName.get("shared")?.path).toContain(path.join(cwd, ".agents"));
      expect(byName.get("proj")?.name).toBe("proj");
      expect(byName.has("broken")).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loadSkillByName 返回技能全文与目录，未命中返回 undefined", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-skills-home-",
      });
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "codework-skills-cwd-",
      });
      yield* writeSkill(
        path.join(cwd, ".agents", "skills"),
        "review",
        "---\nname: review\n---\n逐项评审。\n",
      );

      const loaded = yield* loadSkillByName("review", cwd, homeDir);
      expect(loaded?.name).toBe("review");
      expect(loaded?.contents).toContain("逐项评审");
      expect(loaded?.directory).toBe(path.join(cwd, ".agents", "skills", "review"));

      expect(yield* loadSkillByName("missing", cwd, homeDir)).toBeUndefined();
      expect(yield* loadSkillByName("review", cwd, homeDir)).toBeDefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("homeDir 缺省时使用真实用户目录，未知工作区也能返回用户级技能", () =>
    Effect.gen(function* () {
      const cwd = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "codework-skills-empty-" })),
      );
      // 不断言具体技能名：真实 HOME 下可能什么都没有，只验证不抛错。
      const skills = yield* discoverByokSkills(cwd);
      expect(Array.isArray(skills)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
