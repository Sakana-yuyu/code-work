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
