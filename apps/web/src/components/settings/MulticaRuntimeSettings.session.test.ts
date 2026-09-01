import {
  multicaProviderInstanceRevision,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emptyMulticaRuntimeDraft,
  formFromMulticaRuntimeInstance,
  multicaRuntimeDraftFingerprint,
} from "./MulticaRuntimeSettings.logic";
import {
  reconcileMulticaRuntimeEditorSession,
  type MulticaRuntimeEditorSession,
} from "./MulticaRuntimeSettings.session";

const editorSession = (mode: "create" | "edit" = "edit"): MulticaRuntimeEditorSession => {
  const draft = {
    ...emptyMulticaRuntimeDraft("multica_local"),
    runtimeId: "multica:daemon:runtime",
    daemonId: "daemon",
    daemonRuntimeId: "runtime",
    environment: [
      {
        name: "MULTICA_TOKEN",
        originalName: "MULTICA_TOKEN",
        value: "",
        sensitive: true,
        valueRedacted: true,
      },
    ],
  };
  return {
    sessionId: 1,
    scopeKey: "environment-a",
    mode,
    originalInstanceId: mode === "edit" ? "multica_local" : null,
    initialDraft: draft,
    draft,
    initialFingerprint: multicaRuntimeDraftFingerprint(draft),
    conflict: false,
    saveState: "idle",
    expectedRevision: "revision-v1",
  };
};

const multicaInstance = {
  driver: ProviderDriverKind.make("multica"),
  settingsRevision: "revision-v1",
  config: {
    runtimeId: "multica:daemon:runtime",
    daemonId: "daemon",
    daemonRuntimeId: "runtime",
    baseUrl: "http://127.0.0.1:9000",
    headers: [{ headerName: "Authorization", environmentVariable: "MULTICA_TOKEN" }],
    assigneeRoutes: [],
  },
  environment: [{ name: "MULTICA_TOKEN", value: "", sensitive: true, valueRedacted: true }],
};

const editorSessionFor = (instance: ProviderInstanceConfig): MulticaRuntimeEditorSession => {
  const draft = formFromMulticaRuntimeInstance("multica_local", instance);
  if (draft === null) throw new Error("missing Multica draft");
  return {
    ...editorSession(),
    initialDraft: draft,
    draft,
    initialFingerprint: multicaRuntimeDraftFingerprint(draft),
    expectedRevision: multicaProviderInstanceRevision("multica_local", instance),
  };
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

  it("ready 快照删除或替换正在编辑的 Multica 实例时标记冲突而不继续覆盖", () => {
    const editor = editorSession();
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: {},
      }),
    ).toMatchObject({ conflict: true, saveState: "conflict" });
    expect(
      reconcileMulticaRuntimeEditorSession(editor, {
        scopeKey: "environment-a",
        readyInstances: {
          multica_local: { driver: ProviderDriverKind.make("ide") },
        },
      }),
    ).toMatchObject({ conflict: true, saveState: "conflict" });
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
    ).toMatchObject({ conflict: false, saveState: "idle" });
  });

  it("服务端 revision 变化时，即使敏感环境变量脱敏后草稿指纹不变也标记冲突", () => {
    const secretEditor = editorSessionFor(multicaInstance);
    expect(
      reconcileMulticaRuntimeEditorSession(secretEditor, {
        scopeKey: "environment-a",
        readyInstances: { multica_local: { ...multicaInstance, settingsRevision: "revision-v2" } },
      }),
    ).toMatchObject({ conflict: true, saveState: "conflict" });
  });

  it("服务端 revision 变化时，即使普通环境变量不影响草稿指纹也标记冲突", () => {
    const publicValueOne = {
      ...multicaInstance,
      environment: [
        ...multicaInstance.environment,
        { name: "PUBLIC_LABEL", value: "v1", sensitive: false },
      ],
    };
    const publicEditor = editorSessionFor(publicValueOne);
    expect(
      reconcileMulticaRuntimeEditorSession(publicEditor, {
        scopeKey: "environment-a",
        readyInstances: {
          multica_local: {
            ...publicValueOne,
            settingsRevision: "revision-v2",
            environment: [
              ...multicaInstance.environment,
              { name: "PUBLIC_LABEL", value: "v2", sensitive: false },
            ],
          },
        },
      }),
    ).toMatchObject({ conflict: true, saveState: "conflict" });
  });
});
