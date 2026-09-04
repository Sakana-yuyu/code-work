import { describe, expect, it } from "vite-plus/test";

import {
  defaultKeybindingForRow,
  keybindingInputFromDraft,
  keybindingRows,
  keybindingRemoveTarget,
} from "./SettingsKeybindingsRouteScreen.logic";

describe("移动端快捷键逻辑", () => {
  const row = keybindingRows(
    [
      {
        command: "terminal.toggle",
        shortcut: {
          key: "j",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: { type: "identifier", name: "terminalOpen" },
      },
    ],
    "terminal",
  )[0];

  it("读取并筛选服务端快捷键", () => {
    expect(row).toMatchObject({ command: "terminal.toggle", key: "mod+j", when: "terminalOpen" });
  });

  it("保存前校验命令、按键和 when 表达式", () => {
    expect(
      keybindingInputFromDraft({ command: "terminal.toggle", key: "mod+j", when: "!terminalOpen" }),
    ).toEqual({
      command: "terminal.toggle",
      key: "mod+j",
      when: "!terminalOpen",
    });
    expect(keybindingInputFromDraft({ command: "nope", key: "mod+j", when: "" })).toBeNull();
    expect(
      keybindingInputFromDraft({ command: "terminal.toggle", key: "mod+j+k", when: "" }),
    ).toBeNull();
    expect(
      keybindingInputFromDraft({ command: "terminal.toggle", key: "mod+j", when: "!" }),
    ).toBeNull();
  });

  it("删除和恢复都针对当前解析规则", () => {
    if (!row) throw new Error("测试快捷键未生成");
    expect(keybindingRemoveTarget(row)).toEqual({
      command: "terminal.toggle",
      key: "mod+j",
      when: "terminalOpen",
    });
    expect(defaultKeybindingForRow(row)).toMatchObject({
      command: "terminal.toggle",
      key: "mod+j",
    });
  });
});
