import { ProviderDriverKind } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import { emptyMulticaRuntimeDraft } from "./MulticaRuntimeSettings.logic";
import {
  reconcileMulticaRuntimeEditorSession,
  type MulticaRuntimeEditorSession,
} from "./MulticaRuntimeSettings.session";

const editorSession = (mode: "create" | "edit" = "edit"): MulticaRuntimeEditorSession => {
  const draft = emptyMulticaRuntimeDraft("multica_local");
  return {
    sessionId: 1,
    scopeKey: "environment-a",
    mode,
    originalInstanceId: mode === "edit" ? "multica_local" : null,
    initialDraft: draft,
    draft,
    saveState: "idle",
  };
};

const multicaInstance = {
  driver: ProviderDriverKind.make("multica"),
};

describe("MulticaRuntimeSettings session", () => {
  it("环境切换时立即丢弃旧环境编辑会话，即使实例 ID 相同", () => {
    expect(
      reconcileMulticaRuntimeEditorSession(editorSession(), {
        scopeKey: "environment-b",
        readyInstances: { multica_local: multicaInstance },
      }),
    ).toBeNull();
  });

  it("ready 快照删除或替换正在编辑的 Multica 实例时释放会话", () => {
    const editor = editorSession();
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: {},
      }),
    ).toBeNull();
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: {
          multica_local: { driver: ProviderDriverKind.make("ide") },
        },
      }),
    ).toBeNull();
  });

  it("同环境的暂时加载态与仍存在实例不会抢走用户草稿", () => {
    const editor = editorSession();
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: undefined,
      }),
    ).toBe(editor);
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: { multica_local: multicaInstance },
      }),
    ).toBe(editor);
    expect(
      reconcileMulticaRuntimeEditorSession(editorSession("create"), {
        scopeKey: "environment-a",
        readyInstances: {},
      }),
    ).not.toBeNull();
  });
});
