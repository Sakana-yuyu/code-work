import { describe, expect, it } from "vite-plus/test";

import { serverSessionErrorTranslation } from "./serverSessionMessages.ts";

describe("serverSessionErrorTranslation", () => {
  it("把已知的服务端 lastError 原句映射为稳定 i18n key", () => {
    expect(
      serverSessionErrorTranslation(
        "Provider session did not survive a server restart. Send a new message to continue.",
      ),
    ).toEqual({
      key: "session.providerSessionLostAfterRestart",
      params: {},
    });
    expect(serverSessionErrorTranslation("Turn failed")).toEqual({
      key: "session.turnFailed",
      params: {},
    });
    expect(
      serverSessionErrorTranslation("No active provider session is bound to this thread."),
    ).toEqual({
      key: "session.noActiveProviderSession",
      params: {},
    });
  });

  it("模板句解析出插值参数", () => {
    expect(
      serverSessionErrorTranslation(
        "Thread 'thread-1' cannot switch models after the conversation has started. Start a new thread to use 'gpt-5-codex'.",
      ),
    ).toEqual({
      key: "session.cannotSwitchModelsAfterStart",
      params: { threadId: "thread-1", model: "gpt-5-codex" },
    });
    expect(
      serverSessionErrorTranslation(
        "Requested provider instance 'inst-9' uses unknown provider driver 'cursor'. The driver is not installed in this build.",
      ),
    ).toEqual({
      key: "session.unknownProviderDriver",
      params: { instanceId: "inst-9", driverKind: "cursor" },
    });
    expect(
      serverSessionErrorTranslation(
        "Thread 't1' is bound to driver 'codex' and cannot switch to 'claude'.",
      ),
    ).toEqual({
      key: "session.driverSwitchUnsupported",
      params: { threadId: "t1", currentDriverKind: "codex", desiredDriverKind: "claude" },
    });
  });

  it("未知文案返回 null，由调用方原样透传", () => {
    expect(serverSessionErrorTranslation("Some future server error.")).toBeNull();
    expect(serverSessionErrorTranslation("")).toBeNull();
    expect(serverSessionErrorTranslation("Provider session error!")).toBeNull();
  });
});
