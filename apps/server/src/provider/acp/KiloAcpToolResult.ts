import type * as AcpSchema from "effect-acp/schema";

/** Kilo 的命令协议完成不等于退出成功；保留 metadata，并显式展示结构化退出码。 */
export function normalizeKiloToolResult(
  notification: AcpSchema.SessionNotification,
  agentName: string | undefined,
): AcpSchema.SessionNotification {
  const update = notification.update;
  if (
    agentName !== "Kilo" ||
    update.sessionUpdate !== "tool_call_update" ||
    update.status !== "completed" ||
    (update.kind !== undefined && update.kind !== "execute")
  )
    return notification;
  const output = update.rawOutput;
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    "exitCode" in output ||
    !("metadata" in output)
  )
    return notification;
  const metadata = output.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("exit" in metadata))
    return notification;
  const exitCode = metadata.exit;
  if (
    typeof exitCode !== "number" ||
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 4294967295
  )
    return notification;
  return {
    ...notification,
    update: {
      ...update,
      status: exitCode === 0 ? "completed" : "failed",
      rawOutput: { ...output, exitCode },
      content: [
        ...(update.content ?? []),
        { type: "content", content: { type: "text", text: `Exit code: ${exitCode}` } },
      ],
    },
  };
}
