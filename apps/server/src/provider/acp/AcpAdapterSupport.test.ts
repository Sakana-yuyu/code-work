import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@codework/contracts";

import { selectAcpPermissionOptionId, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("进程退出、输入结束和传输失败均表示连接关闭，保留原始原因", () => {
    for (const cause of [
      new EffectAcpErrors.AcpProcessExitedError({ code: 7 }),
      new EffectAcpErrors.AcpInputStreamEndedError({}),
      new EffectAcpErrors.AcpTransportError({ operation: "read-input-stream", cause: "closed" }),
    ]) {
      const error = mapAcpToAdapterError(
        ProviderDriverKind.make("cursor"),
        "thread-1" as never,
        "session/prompt",
        cause,
      );
      expect(error._tag).toBe("ProviderAdapterSessionClosedError");
      expect(error.cause).toBe(cause);
    }
  });
  it("按广告类型选择原生 ID，不假设连字符或下划线", () => {
    const request = {
      sessionId: "s",
      toolCall: { toolCallId: "t" },
      options: [
        { optionId: "allow_once", name: "一次", kind: "allow_once" },
        { optionId: "original-session-id", name: "会话", kind: "allow_always" },
        { optionId: "original-reject-id", name: "拒绝", kind: "reject_once" },
      ],
    } as const;
    expect(selectAcpPermissionOptionId(request, "accept")).toBe("allow_once");
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("original-session-id");
    expect(selectAcpPermissionOptionId(request, "decline")).toBe("original-reject-id");
    expect(
      selectAcpPermissionOptionId(
        { ...request, options: [request.options[0]] },
        "acceptForSession",
      ),
    ).toBe("allow_once");
    expect(
      selectAcpPermissionOptionId({ ...request, options: [request.options[1]] }, "accept"),
    ).toBeUndefined();
    expect(selectAcpPermissionOptionId({ ...request, options: [] }, "decline")).toBeUndefined();
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
