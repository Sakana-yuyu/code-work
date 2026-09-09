// 第一方桥接扩展只读取当前编辑器选择；草稿仍由父应用管理和手动发送。
export const CODEOSS_CHAT_MANIFEST = {
  name: "codework-chat-bridge",
  publisher: "codework",
  version: "0.0.1",
  displayName: "Code Work 对话",
  description: "将选中代码加入当前 Code Work 对话草稿。",
  engines: { vscode: "^1.121.0" },
  extensionKind: ["workspace"],
  main: "./extension.cjs",
  activationEvents: ["onCommand:codework.readSelection"],
};

export const CODEOSS_CHAT_EXTENSION = `const vscode = require("vscode");
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand("codework.readSelection", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return null;
    const text = editor.document.getText(editor.selection);
    if (text.length > 200000) { vscode.window.showWarningMessage("所选代码过长，请缩小选择范围。"); return null; }
    return { filePath: editor.document.uri.fsPath, text, language: editor.document.languageId,
      startLine: editor.selection.start.line + 1, endLine: editor.selection.end.line + 1 };
  }));
};
`;
