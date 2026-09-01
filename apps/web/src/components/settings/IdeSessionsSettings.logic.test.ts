import { ProviderDriverKind } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  configFromIdeSessionDraft,
  formFromIdeInstance,
  type IdeSessionDraft,
} from "./IdeSessionsSettings.logic";

const baseDraft = (): IdeSessionDraft => ({
  instanceId: "ide_local",
  sessionId: "vscode-session-1",
  profile: "vscode_ide",
  url: "wss://127.0.0.1:4111/t3/ide",
  headers: [{ headerName: "Authorization", environmentVariable: "IDE_TOKEN" }],
  environment: [
    {
      name: "IDE_TOKEN",
      value: "",
      sensitive: true,
      valueRedacted: true,
    },
  ],
  enabled: true,
  openTimeoutMs: "15000",
  requestTimeoutMs: "10000",
  reconnectDelaysMs: "250, 1000, 3000",
});

describe("IdeSessionsSettings logic", () => {
  it("保留未重新输入的已保存敏感值标记", () => {
    const draft = baseDraft();
    const saved = configFromIdeSessionDraft(draft);

    expect(saved?.config).toMatchObject({
      sessionId: "vscode-session-1",
      headers: [{ headerName: "Authorization", environmentVariable: "IDE_TOKEN" }],
    });
    expect(saved?.environment).toEqual(draft.environment);
    expect(draft.environment[0]).toMatchObject({ value: "", valueRedacted: true });
  });

  it("拒绝非 WebSocket URL、重复 Header 和非法环境变量名", () => {
    expect(configFromIdeSessionDraft({ ...baseDraft(), url: "https://127.0.0.1:4111" })).toBeNull();
    expect(
      configFromIdeSessionDraft({
        ...baseDraft(),
        headers: [
          { headerName: "Authorization", environmentVariable: "IDE_TOKEN" },
          { headerName: "authorization", environmentVariable: "IDE_TOKEN_2" },
        ],
      }),
    ).toBeNull();
    expect(
      configFromIdeSessionDraft({
        ...baseDraft(),
        environment: [{ name: "IDE-TOKEN", value: "", sensitive: true }],
      }),
    ).toBeNull();
  });

  it("从 IDE provider instance 读取配置和环境变量草稿", () => {
    const draft = formFromIdeInstance("ide_local", {
      driver: ProviderDriverKind.make("ide"),
      enabled: true,
      environment: [{ name: "IDE_TOKEN", value: "", sensitive: true, valueRedacted: true }],
      config: {
        schemaVersion: 1,
        enabled: true,
        sessionId: "cursor-session-1",
        profile: "cursor_ide",
        url: "ws://127.0.0.1:4111/t3/ide",
        headers: [{ headerName: "Authorization", environmentVariable: "IDE_TOKEN" }],
      },
    });

    expect(draft).toMatchObject({
      instanceId: "ide_local",
      sessionId: "cursor-session-1",
      profile: "cursor_ide",
      url: "ws://127.0.0.1:4111/t3/ide",
      environment: [{ name: "IDE_TOKEN", valueRedacted: true }],
    });
  });
});
