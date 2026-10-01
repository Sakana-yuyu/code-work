import type * as AcpSchema from "effect-acp/schema";
import { isCodebuddyCancelledToolNotification } from "effect-acp/protocol";

/** 厂商取消进入既有失败终态；调用方仍保留原始通知，恢复重放沿用共同门禁。 */
export function normalizeCodebuddyCancelledToolNotification(
  payload: unknown,
): AcpSchema.SessionNotification | undefined {
  if (!isCodebuddyCancelledToolNotification(payload)) return undefined;
  return {
    ...payload,
    update: {
      ...payload.update,
      status: "failed",
      content: payload.update.content ?? [
        {
          type: "content",
          content: {
            type: "text",
            text:
              payload.update._meta["codebuddy.ai/toolCancelReason"] === "permission_denied"
                ? "用户已拒绝工具执行。"
                : "会话已取消，工具未完成。",
          },
        },
      ],
    },
  };
}

/** CodeBuddy 不广告 agentInfo，命令退出码来自专有工具元数据，原输出和元数据保留。 */
export function normalizeCodebuddyToolResult(
  notification: AcpSchema.SessionNotification,
): AcpSchema.SessionNotification {
  const update = notification.update;
  if (
    update.sessionUpdate !== "tool_call_update" ||
    update.status !== "completed" ||
    (update.kind != null && update.kind !== "execute")
  )
    return notification;
  const toolName = update._meta?.["codebuddy.ai/toolName"];
  if (toolName !== "Bash" && toolName !== "PowerShell") return notification;
  const response = update._meta?.["codebuddy.ai/rawResponse"];
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    !("exitCode" in response)
  )
    return notification;
  const exitCode = response.exitCode;
  if (
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 4294967295
  )
    return notification;
  const output = update.rawOutput;
  if (!output || typeof output !== "object" || Array.isArray(output) || "exitCode" in output)
    return notification;
  return {
    ...notification,
    update: {
      ...update,
      status: exitCode === 0 ? "completed" : "failed",
      rawOutput: { ...output, exitCode },
    },
  };
}
