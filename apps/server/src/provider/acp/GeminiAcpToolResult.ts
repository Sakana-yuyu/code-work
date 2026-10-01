import type * as AcpSchema from "effect-acp/schema";

/** Gemini 的空输出命令失败只有文本标记；保留原帧，仅归一化明确的非零结束码。 */
export function normalizeGeminiToolResult(
  notification: AcpSchema.SessionNotification,
  agentName: string | undefined,
): AcpSchema.SessionNotification {
  const update = notification.update;
  if (
    agentName !== "gemini-cli" ||
    update.sessionUpdate !== "tool_call_update" ||
    update.kind !== "execute" ||
    update.status !== "completed" ||
    !update.toolCallId.startsWith("run_shell_command__") ||
    update.rawOutput != null ||
    update.content?.length !== 1
  )
    return notification;
  const block = update.content[0];
  if (block?.type !== "content" || block.content.type !== "text") return notification;
  // ponytail: 上游未传结构化退出码，纯 stdout 同文仍有歧义；有原生退出字段后删除文本识别。
  const match = /^Command exited with code: ([1-9]\d*)$/.exec(block.content.text);
  if (!match) return notification;
  const exitCode = Number(match[1]);
  if (!Number.isSafeInteger(exitCode) || exitCode > 4294967295) return notification;
  return {
    ...notification,
    update: { ...update, status: "failed", rawOutput: { exitCode } },
  };
}
