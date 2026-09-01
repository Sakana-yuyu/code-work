import { describe, expect, it } from "vite-plus/test";

import { renderLocalPluginTemplate } from "./localPluginTemplate";

const workspace = {
  name: "Code Work",
  root: "C:\\workspace\\code-work",
};

describe("renderLocalPluginTemplate", () => {
  it("只替换调用方明确授权的工作区字段", () => {
    expect(
      renderLocalPluginTemplate({
        template: "{{workspace.name}}: {{workspace.root}}",
        allowedFields: ["workspace.name", "workspace.root"],
        workspace,
      }),
    ).toBe("Code Work: C:\\workspace\\code-work");
  });

  it("拒绝未声明字段、未知字段和缺失的工作区上下文", () => {
    expect(() =>
      renderLocalPluginTemplate({
        template: "{{workspace.root}}",
        allowedFields: ["workspace.name"],
        workspace,
      }),
    ).toThrow("未授权工作区模板字段 workspace.root");

    expect(() =>
      renderLocalPluginTemplate({
        template: "{{workspace.secret}}",
        allowedFields: ["workspace.name", "workspace.root"],
        workspace,
      }),
    ).toThrow("不支持的工作区模板标记 {{workspace.secret}}");

    expect(() =>
      renderLocalPluginTemplate({
        template: "{{workspace.name}}",
        allowedFields: ["workspace.name"],
        workspace: null,
      }),
    ).toThrow("当前没有可用的工作区上下文");
  });
});
