import { describe, expect, it } from "vite-plus/test";

import { codeIndexLanguageOf, extractSymbols } from "./SymbolExtractor.ts";

describe("SymbolExtractor", () => {
  it("提取 TypeScript 顶层声明与一级方法", () => {
    const source = [
      'import { Effect } from "effect";',
      "",
      "export interface ThreadGoal {",
      "  readonly status: string;",
      "}",
      "",
      "export type GoalState = { status: string } | null;",
      "",
      "const helper = (value: number) => value + 1;",
      "",
      "export class GoalStore {",
      "  setStatus(value: string): void {",
      "    return;",
      "  }",
      "",
      "  private async flush() {",
      "    return;",
      "  }",
      "}",
      "",
      "export async function* streamGoals() {",
      "  yield 1;",
      "}",
      "",
      'export enum GoalKind { A = "a" }',
      "",
      "const NOT_A_SYMBOL = 42;",
    ].join("\n");

    const symbols = extractSymbols("src/goal/store.ts", source);
    expect(symbols).toEqual([
      { name: "ThreadGoal", kind: "interface", line: 3 },
      { name: "GoalState", kind: "type", line: 7 },
      { name: "helper", kind: "function", line: 9 },
      { name: "GoalStore", kind: "class", line: 11 },
      { name: "setStatus", kind: "method", line: 12, parent: "GoalStore" },
      { name: "flush", kind: "method", line: 16, parent: "GoalStore" },
      { name: "streamGoals", kind: "function", line: 21 },
      { name: "GoalKind", kind: "enum", line: 25 },
    ]);
  });

  it("提取 Python 声明并带所属类", () => {
    const source = [
      "class GoalStore:",
      "    def __init__(self):",
      "        self.value = 1",
      "",
      "    async def flush(self):",
      "        return None",
      "",
      "",
      "def top_level():",
      "    return 1",
    ].join("\n");

    const symbols = extractSymbols("goal_store.py", source);
    expect(symbols).toEqual([
      { name: "GoalStore", kind: "class", line: 1 },
      { name: "__init__", kind: "function", line: 2, parent: "GoalStore" },
      { name: "flush", kind: "function", line: 5, parent: "GoalStore" },
      { name: "top_level", kind: "function", line: 9 },
    ]);
  });

  it("提取 Go 与 Rust 声明", () => {
    const goSource = [
      "package pool",
      "",
      "type Account struct {",
      "\tID string",
      "}",
      "",
      "func (account *Account) Touch() error {",
      "\treturn nil",
      "}",
      "",
      "func PickAccount() *Account {",
      "\treturn nil",
      "}",
    ].join("\n");
    expect(extractSymbols("pool/account.go", goSource)).toEqual([
      { name: "Account", kind: "struct", line: 3 },
      { name: "Touch", kind: "function", line: 7 },
      { name: "PickAccount", kind: "function", line: 11 },
    ]);

    const rustSource = [
      "pub struct GoalStore;",
      "",
      "impl GoalStore {",
      "    pub fn touch(&self) {}",
      "}",
      "",
      "pub trait Runnable {",
      "    fn run(&self);",
      "}",
      "",
      "pub async fn run_all() {}",
    ].join("\n");
    expect(extractSymbols("src/store.rs", rustSource)).toEqual([
      { name: "GoalStore", kind: "struct", line: 1 },
      { name: "touch", kind: "method", line: 4, parent: "GoalStore" },
      { name: "Runnable", kind: "trait", line: 7 },
      // trait 体内的方法也被提取；parent 归属最近的类形声明是 v1 的近似取舍。
      { name: "run", kind: "method", line: 8, parent: "GoalStore" },
      { name: "run_all", kind: "function", line: 11 },
    ]);
  });

  it("提取 Ruby 类/模块与方法", () => {
    const source = [
      "module Work;",
      "  class Store",
      "    def touch?",
      "      true",
      "    end",
      "",
      "    def self.build",
      "      new",
      "    end",
      "  end",
      "end",
    ].join("\n");
    expect(extractSymbols("store.rb", source)).toEqual([
      { name: "Work", kind: "module", line: 1 },
      { name: "Store", kind: "class", line: 2 },
      { name: "touch?", kind: "function", line: 3 },
      { name: "build", kind: "function", line: 7 },
    ]);
  });

  it("忽略非代码扩展名与无扩展名文件", () => {
    expect(extractSymbols("README.md", "# class NotCode {}")).toEqual([]);
    expect(extractSymbols("Dockerfile", "class NotCode {}")).toEqual([]);
    expect(codeIndexLanguageOf("a/b/c.PY")).toBe("py");
  });
});
