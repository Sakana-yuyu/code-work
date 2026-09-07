// @effect-diagnostics nodeBuiltinImport:off - 临时目录与路径拼接用 node 原生模块更直接。
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { makeCodeIndexStore } from "./CodeIndexStore.ts";
import type { ExtractedSymbol } from "./SymbolExtractor.ts";

const symbolsFor = (...symbols: ExtractedSymbol[]) => symbols;

describe("CodeIndexStore", () => {
  it.effect("按项目隔离统计与符号查询", () =>
    Effect.gen(function* () {
      const store = yield* makeCodeIndexStore(":memory:");

      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "src/goal.ts", mtimeMs: 100, size: 10 },
        symbols: [
          { name: "GoalStore", kind: "class", line: 1 },
          { name: "setStatus", kind: "method", line: 2, parent: "GoalStore" },
        ],
        indexedAtUnixMs: 1000,
      });
      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "src/state.ts", mtimeMs: 200, size: 20 },
        symbols: symbolsFor({ name: "GoalState", kind: "type", line: 5 }),
        indexedAtUnixMs: 1000,
      });
      yield* store.replaceFile({
        rootKey: "p2",
        file: { path: "other.py", mtimeMs: 300, size: 30 },
        symbols: symbolsFor({ name: "GoalStore", kind: "class", line: 1 }),
        indexedAtUnixMs: 2000,
      });

      expect(yield* store.stats("p1")).toEqual({
        fileCount: 2,
        symbolCount: 3,
        lastIndexedAtUnixMs: 1000,
      });
      expect(yield* store.stats("missing")).toEqual({
        fileCount: 0,
        symbolCount: 0,
        lastIndexedAtUnixMs: null,
      });

      // p2 里同名 GoalStore 不得泄漏进 p1 的查询结果。
      const matches = yield* store.searchSymbols({
        rootKey: "p1",
        query: "goalstore",
        limit: 10,
      });
      expect(matches).toEqual([{ path: "src/goal.ts", name: "GoalStore", kind: "class", line: 1 }]);
    }).pipe(Effect.scoped),
  );

  it.effect("replaceFile 幂等覆盖旧符号，removeFile 清干净", () =>
    Effect.gen(function* () {
      const store = yield* makeCodeIndexStore(":memory:");
      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "a.ts", mtimeMs: 1, size: 1 },
        symbols: symbolsFor({ name: "old", kind: "function", line: 1 }),
        indexedAtUnixMs: 10,
      });
      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "a.ts", mtimeMs: 2, size: 2 },
        symbols: symbolsFor({ name: "new", kind: "function", line: 3 }),
        indexedAtUnixMs: 20,
      });

      const remaining = yield* store.searchSymbols({ rootKey: "p1", query: "", limit: 100 });
      expect(remaining.map((symbol) => symbol.name)).toEqual(["new"]);
      expect((yield* store.stats("p1")).lastIndexedAtUnixMs).toBe(20);

      yield* store.removeFile("p1", "a.ts");
      expect((yield* store.stats("p1")).fileCount).toBe(0);
      expect(yield* store.fileSymbols("p1", "a.ts")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("searchSymbols 支持 kind 过滤与 LIKE 通配符字面量", () =>
    Effect.gen(function* () {
      const store = yield* makeCodeIndexStore(":memory:");
      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "a.ts", mtimeMs: 1, size: 1 },
        symbols: symbolsFor(
          { name: "fetch_data", kind: "function", line: 1 },
          { name: "FetchClient", kind: "class", line: 2 },
          { name: "parse", kind: "method", line: 3, parent: "FetchClient" },
        ),
        indexedAtUnixMs: 10,
      });

      const methodsOnly = yield* store.searchSymbols({
        rootKey: "p1",
        query: "",
        kind: "method",
        limit: 10,
      });
      expect(methodsOnly.map((symbol) => symbol.name)).toEqual(["parse"]);

      // LIKE 里的 _ 是字面量而非任意字符：f_ 不得借通配符命中 fetch_data 的 fe。
      const literal = yield* store.searchSymbols({ rootKey: "p1", query: "f_", limit: 10 });
      expect(literal).toEqual([]);
      const literalUnderscore = yield* store.searchSymbols({
        rootKey: "p1",
        query: "h_da",
        limit: 10,
      });
      expect(literalUnderscore).toEqual([
        { path: "a.ts", name: "fetch_data", kind: "function", line: 1 },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("removeRoot 清空该项目全部痕迹", () =>
    Effect.gen(function* () {
      const store = yield* makeCodeIndexStore(":memory:");
      yield* store.replaceFile({
        rootKey: "p1",
        file: { path: "a.ts", mtimeMs: 1, size: 1 },
        symbols: symbolsFor({ name: "alpha", kind: "function", line: 1 }),
        indexedAtUnixMs: 10,
      });
      yield* store.removeRoot("p1");
      expect(yield* store.stats("p1")).toEqual({
        fileCount: 0,
        symbolCount: 0,
        lastIndexedAtUnixMs: null,
      });
      // files() 是对账输入：removeRoot 后为空。
      expect(yield* store.files("p1")).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
