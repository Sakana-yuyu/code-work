// @effect-diagnostics nodeBuiltinImport:off - 执行实际扩展，验证只读选择的命令协议。
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import { CODEOSS_CHAT_EXTENSION, CODEOSS_CHAT_MANIFEST } from "./codeossChatExtension.ts";

describe("Code Work 原生扩展桥", () => {
  it("读取当前选择及行号，空选择和过大选择不返回上下文", () => {
    let handler: (() => unknown) | undefined;
    let contents = "const value = 1;";
    const selection = { isEmpty: false, start: { line: 3 }, end: { line: 5 } };
    const extension: { activate?: (context: { subscriptions: unknown[] }) => void } = {};
    const api = {
      commands: {
        registerCommand: (_id: string, callback: () => unknown) => {
          handler = callback;
          return { dispose() {} };
        },
      },
      window: {
        activeTextEditor: {
          selection,
          document: {
            uri: { fsPath: "/workspace/app.js" },
            languageId: "javascript",
            getText: () => contents,
          },
        },
        showWarningMessage: () => {},
      },
    };
    NodeVM.runInNewContext(CODEOSS_CHAT_EXTENSION, { exports: extension, require: () => api });
    extension.activate?.({ subscriptions: [] });
    // 自动选区芯片已由客户端维护，桥接扩展不得再贡献无人处理的发送菜单。
    expect(CODEOSS_CHAT_MANIFEST).not.toHaveProperty("contributes");
    expect(handler?.()).toEqual({
      filePath: "/workspace/app.js",
      text: contents,
      language: "javascript",
      startLine: 4,
      endLine: 6,
    });
    selection.isEmpty = true;
    expect(handler?.()).toBeNull();
    selection.isEmpty = false;
    contents = "x".repeat(200001);
    expect(handler?.()).toBeNull();
    expect(CODEOSS_CHAT_MANIFEST.extensionKind).toEqual(["workspace"]);
  });
});
