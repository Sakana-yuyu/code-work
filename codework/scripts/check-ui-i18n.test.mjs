import * as NodeModule from "node:module";

import { describe, expect, it } from "vite-plus/test";

import { expressionStrings } from "./check-ui-i18n.mjs";

const requireFromMobile = NodeModule.createRequire(
  new URL("../apps/mobile/package.json", import.meta.url),
);
const ts = requireFromMobile("typescript");

const initializerStrings = (sourceText) => {
  const source = ts.createSourceFile(
    "fixture.tsx",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const statement = source.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("测试源码缺少变量声明");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer) throw new Error("测试源码缺少变量初始值");

  const strings = [];
  expressionStrings(ts, initializer, strings);
  return strings.map((item) => item.text);
};

describe("UI i18n AST 可见文案提取", () => {
  it("提取对象映射中的可见字符串", () => {
    expect(
      initializerStrings(
        'const actionLabel: Record<string, string> = { download: "Download", install: "Install" };',
      ),
    ).toEqual(["Download", "Install"]);
  });

  it("提取空值回退中的可见字符串", () => {
    expect(
      initializerStrings('const buttonLabel: string = labels[action] ?? "Check for Updates";'),
    ).toEqual(["Check for Updates"]);
    expect(
      initializerStrings('const buttonLabel: string = (labels[action] ?? "Check for Updates");'),
    ).toEqual(["Check for Updates"]);
    expect(
      initializerStrings('const buttonLabel = (labels[action] ?? "Check for Updates") as string;'),
    ).toEqual(["Check for Updates"]);
  });

  it("忽略未显式声明为可见字符串的内部结构", () => {
    expect(initializerStrings('const protocolState = { message: "user" };')).toEqual([]);
    expect(initializerStrings('const internalLabel = labels[action] ?? "user";')).toEqual([]);
  });
});
