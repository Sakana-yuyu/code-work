// @effect-diagnostics nodeBuiltinImport:off - 临时目录与路径拼接用 node 原生模块更直接。
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, describe, expect } from "vite-plus/test";

import { HostProcessPlatform } from "@codework/shared/hostProcess";

import { makeCodeIndexRoot } from "./CodeIndexService.ts";
import { readActiveCodeIndexProgress } from "./codeIndexProgress.ts";
import { layerCodeIndexStoreFor } from "./CodeIndexStore.ts";

// makeCodeIndexRoot 需要 effect FileSystem（stat/read）；store 用 :memory:。
const depsLayer = Layer.merge(layerCodeIndexStoreFor(":memory:"), NodeServices.layer);

let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "codework-code-index-"));
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "goal.ts"),
    [
      "export interface ThreadGoal {",
      "  readonly id: string;",
      "}",
      "",
      "export function flushGoal(goal: ThreadGoal) {",
      "  return goal;",
      "}",
    ].join("\n"),
  );
  await NodeFSP.writeFile(NodePath.join(workspaceRoot, "notes.md"), "# not code");
  await NodeFSP.mkdir(NodePath.join(workspaceRoot, "node_modules"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(workspaceRoot, "node_modules", "vendor.ts"),
    "export function squatted() {}",
  );
});

afterEach(async () => {
  await NodeFSP.rm(workspaceRoot, { recursive: true, force: true });
});

describe("CodeIndexRoot", () => {
  it.effect("首扫建立索引并跳过非代码与 node_modules", () =>
    Effect.gen(function* () {
      const root = yield* makeCodeIndexRoot(workspaceRoot);
      const status = yield* root.status();
      expect(status.state).toBe("idle");
      // 只有 goal.ts 入库：notes.md 非代码，node_modules 被排除。
      expect(status.fileCount).toBe(1);

      const matches = yield* root.search({ query: "goal", limit: 10 });
      expect(matches.map((match) => match.name).toSorted()).toEqual(["ThreadGoal", "flushGoal"]);
      expect(matches[0]?.path).toBe("goal.ts");
    }).pipe(Effect.provide(depsLayer), Effect.scoped),
  );

  it.effect("watcher 事件让新文件被索引", () =>
    Effect.gen(function* () {
      const root = yield* makeCodeIndexRoot(workspaceRoot);
      expect((yield* root.status()).fileCount).toBe(1);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(workspaceRoot, "created.ts"), "export class FreshStore {}"),
      );
      // 生产上由 fs.watch 流 tap 进来；测试直接驱动同一处理器，确定性等待。
      yield* root.handleWatchEvent({ filename: "created.ts" });
      yield* root.flushPending();

      const matches = yield* root.search({ query: "freshstore", limit: 10 });
      expect(matches).toEqual([{ path: "created.ts", name: "FreshStore", kind: "class", line: 1 }]);
    }).pipe(Effect.provide(depsLayer), Effect.scoped),
  );

  it.effect("对账补扫发现 watcher 漏掉的新文件并剪除已删除文件", () =>
    Effect.gen(function* () {
      const root = yield* makeCodeIndexRoot(workspaceRoot);

      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(workspaceRoot, "missed.ts"),
          "export enum MissedKind { A }",
        ),
      );
      yield* Effect.promise(() => NodeFSP.rm(NodePath.join(workspaceRoot, "goal.ts")));
      // watcher 漏事件的对账兜底：mtime 对账后新文件入库、旧文件剪除。
      yield* root.reconcile();

      const status = yield* root.status();
      expect(status.fileCount).toBe(1);
      expect(yield* root.search({ query: "goal", limit: 10 })).toEqual([]);
      expect(yield* root.search({ query: "missedkind", limit: 10 })).toEqual([
        { path: "missed.ts", name: "MissedKind", kind: "enum", line: 1 },
      ]);
    }).pipe(Effect.provide(depsLayer), Effect.scoped),
  );

  it.effect("fileSymbols 返回按行排序的声明并拒绝非代码扩展名", () =>
    Effect.gen(function* () {
      const root = yield* makeCodeIndexRoot(workspaceRoot);
      const symbols = yield* root.fileSymbols("goal.ts");
      expect(symbols.map((symbol) => symbol.name)).toEqual(["ThreadGoal", "flushGoal"]);
      expect(yield* root.fileSymbols("notes.md")).toEqual([]);
    }).pipe(Effect.provide(depsLayer), Effect.scoped),
  );

  // 真实时间：中途回读进度依赖 fs 往返的自然耗时，TestClock 会让 sleep 永停。
  it.live("首扫完成不留残余进度；flush 进行中进度可见且按根目录隔离", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const root = yield* makeCodeIndexRoot(workspaceRoot);
      // 首扫的 scanning/extracting 条目必须已被清除，状态行回落到常规统计。
      expect(readActiveCodeIndexProgress(workspaceRoot, platform)).toBeNull();

      // 批量排队后 fork flush：条目在出队瞬间同步落表，200 个文件的真实
      // fs 往返不可能在首个轮询窗口内跑完，这里的中途回读是确定性的。
      for (let index = 0; index < 200; index += 1) {
        yield* root.handleWatchEvent({ filename: `bulk/File${index}.ts` });
      }
      expect(readActiveCodeIndexProgress(workspaceRoot, platform)).toBeNull();

      const flushFiber = yield* Effect.forkChild(root.flushPending());
      yield* Effect.sleep("5 millis");
      const midFlight = readActiveCodeIndexProgress(workspaceRoot, platform);
      expect(midFlight?.phase).toBe("extracting");
      expect(midFlight?.totalFiles).toBe(200);
      expect(midFlight?.processedFiles).toBeLessThan(200);
      // 其他根目录读不到本根的进度。
      expect(
        readActiveCodeIndexProgress(
          NodePath.join(NodeOS.tmpdir(), "codework-other-root"),
          platform,
        ),
      ).toBeNull();

      yield* Fiber.join(flushFiber);
      expect(readActiveCodeIndexProgress(workspaceRoot, platform)).toBeNull();
    }).pipe(Effect.provide(depsLayer), Effect.scoped),
  );
});
