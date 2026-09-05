import { describe, expect, it } from "vite-plus/test";

import { serverSessionErrorTranslation } from "./serverSessionMessages.ts";

describe("serverSessionErrorTranslation", () => {
  it("把已知的服务端 lastError 原句映射为稳定 i18n key", () => {
    expect(
      serverSessionErrorTranslation(
        "Claude reached the maximum agent turns. Send another message to continue, or adjust the limit in provider settings.",
      ),
    ).toEqual({ key: "session.claudeMaxTurnsReached", params: {} });
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

  it("过期 pending 请求模板解析出 requestKind 与 requestId", () => {
    expect(
      serverSessionErrorTranslation(
        "Stale pending approval request: req-123. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
      ),
    ).toEqual({
      key: "session.stalePendingRequest",
      params: { requestKind: "approval", requestId: "req-123" },
    });
    expect(
      serverSessionErrorTranslation(
        "Stale pending user-input request: req_9. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.",
      ),
    ).toEqual({
      key: "session.stalePendingRequest",
      params: { requestKind: "user-input", requestId: "req_9" },
    });
  });

  it("检查点失败详情原句映射为稳定 i18n key", () => {
    expect(serverSessionErrorTranslation("Thread was not found in read model.")).toEqual({
      key: "checkpoint.threadNotFound",
      params: {},
    });
    expect(
      serverSessionErrorTranslation(
        "No active provider session with workspace cwd is bound to this thread.",
      ),
    ).toEqual({
      key: "checkpoint.noSessionWithCwd",
      params: {},
    });
    expect(
      serverSessionErrorTranslation(
        "Checkpoints are unavailable because this project is not a git repository.",
      ),
    ).toEqual({
      key: "checkpoint.notGitRepo",
      params: {},
    });
    expect(
      serverSessionErrorTranslation("Checkpoint turn count 5 exceeds current turn count 3."),
    ).toEqual({
      key: "checkpoint.turnCountExceeds",
      params: { count: "5", current: "3" },
    });
    expect(
      serverSessionErrorTranslation("Checkpoint ref for turn 4 is unavailable in read model."),
    ).toEqual({
      key: "checkpoint.refUnavailable",
      params: { count: "4" },
    });
    expect(
      serverSessionErrorTranslation("Filesystem checkpoint is unavailable for turn 2."),
    ).toEqual({
      key: "checkpoint.filesystemUnavailable",
      params: { count: "2" },
    });
    expect(
      serverSessionErrorTranslation(
        "Checkpoint captured, but turn diff summary is unavailable: git diff timed out",
      ),
    ).toEqual({
      key: "checkpoint.diffSummaryUnavailable",
      params: { message: "git diff timed out" },
    });
    expect(
      serverSessionErrorTranslation("Project was not found for setup script execution."),
    ).toEqual({
      key: "setupScript.projectNotFound",
      params: {},
    });
  });

  it("未知文案返回 null，由调用方原样透传", () => {
    expect(serverSessionErrorTranslation("Some future server error.")).toBeNull();
    expect(serverSessionErrorTranslation("")).toBeNull();
    expect(serverSessionErrorTranslation("Provider session error!")).toBeNull();
  });
});
