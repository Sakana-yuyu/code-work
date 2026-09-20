import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  SpecWorkflowArtifactStore,
  SpecWorkflowArtifactStoreLive,
} from "./SpecWorkflowArtifactStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const testLayer = Layer.mergeAll(
  SpecWorkflowArtifactStoreLive.pipe(
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

it.effect("创建、更新、读取和恢复 spec change 产物，并拒绝越界 changeName", () =>
  Effect.gen(function* () {
    const store = yield* SpecWorkflowArtifactStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-spec-artifacts-",
    });

    const created = yield* store.write({
      workspaceRoot,
      changeName: "native-spec-workflow",
      artifact: "research.md",
      contents: "# Research\n\n事实\n",
    });
    const restored = yield* store.read({
      workspaceRoot,
      changeName: "native-spec-workflow",
      artifact: "research.md",
    });
    const listed = yield* store.list({
      workspaceRoot,
      changeName: "native-spec-workflow",
    });
    const updated = yield* store.write({
      workspaceRoot,
      changeName: "native-spec-workflow",
      artifact: "research.md",
      contents: "# Research\n\n更新后的事实\n",
    });
    const escaped = yield* store
      .write({
        workspaceRoot,
        changeName: "../outside",
        artifact: "research.md",
        contents: "不应写出项目根目录",
      })
      .pipe(Effect.flip);

    expect(created).toEqual(restored);
    expect(listed).toEqual(["research.md"]);
    expect(updated.contents).toContain("更新后的事实");
    expect(escaped.code).toBe("invalid-change-name");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("knowledge.md 存放在工作区级 spec/knowledge.md，不受 changeName 约束", () =>
  Effect.gen(function* () {
    const store = yield* SpecWorkflowArtifactStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-spec-knowledge-",
    });

    yield* store.write({
      workspaceRoot,
      changeName: "not-a-valid-name!",
      artifact: "knowledge.md",
      contents: "- [domain] auth.md — 登录令牌刷新规则\n",
    });
    const restored = yield* store.read({
      workspaceRoot,
      changeName: "whatever",
      artifact: "knowledge.md",
    });
    expect(restored.contents).toContain("auth.md");

    const listed = yield* store
      .list({ workspaceRoot, changeName: "not-a-valid-name!" })
      .pipe(Effect.flip);
    expect(listed.code).toBe("invalid-change-name");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("archive 把 change 目录移入 spec/archive/<日期-name>，同名碰撞加序号", () =>
  Effect.gen(function* () {
    const store = yield* SpecWorkflowArtifactStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "codework-spec-archive-",
    });
    const archivedAtUnixMs = Date.UTC(2026, 8, 20, 12, 0, 0);

    // 没有产物时归档是空操作。
    const missing = yield* store.archive({
      workspaceRoot,
      changeName: "native-spec",
      archivedAtUnixMs,
    });
    expect(missing.archivedTo).toBeNull();

    yield* store.write({
      workspaceRoot,
      changeName: "native-spec",
      artifact: "research.md",
      contents: "# Research\n",
    });
    const first = yield* store.archive({
      workspaceRoot,
      changeName: "native-spec",
      archivedAtUnixMs,
    });
    expect(first.archivedTo?.replace(/\\/gu, "/")).toContain("spec/archive/2026-09-20-native-spec");
    const movedAway = yield* store
      .read({ workspaceRoot, changeName: "native-spec", artifact: "research.md" })
      .pipe(Effect.flip);
    expect(movedAway.code).toBe("artifact-not-found");

    // 同日同名再归档：加序号，不覆盖。
    yield* store.write({
      workspaceRoot,
      changeName: "native-spec",
      artifact: "research.md",
      contents: "# Research v2\n",
    });
    const second = yield* store.archive({
      workspaceRoot,
      changeName: "native-spec",
      archivedAtUnixMs,
    });
    expect(second.archivedTo?.replace(/\\/gu, "/")).toContain(
      "spec/archive/2026-09-20-native-spec-2",
    );
  }).pipe(Effect.provide(testLayer)),
);
