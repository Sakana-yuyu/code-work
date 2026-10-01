import type * as AcpSchema from "effect-acp/schema";

/** Copilot 将 shell_exit 放在 contents 中；归一化退出码，保留原始结果和正文。 */
export function normalizeCopilotToolResult(
  notification: AcpSchema.SessionNotification,
  agentName: string | undefined,
): AcpSchema.SessionNotification {
  const update = notification.update;
  if (
    agentName !== "Copilot" ||
    update.sessionUpdate !== "tool_call_update" ||
    update.status !== "completed" ||
    (update.kind !== undefined && update.kind !== "execute")
  )
    return notification;
  const output = update.rawOutput;
  if (!output || typeof output !== "object" || Array.isArray(output) || "exitCode" in output)
    return notification;
  if (!("contents" in output) || !Array.isArray(output.contents)) return notification;
  const exits = output.contents.filter(
    (entry: unknown) =>
      entry !== null && typeof entry === "object" && "type" in entry && entry.type === "shell_exit",
  );
  // ponytail: 多个 shell 退出结果没有唯一结束码，暂不合并；出现真实批次时按上游语义扩展。
  if (exits.length !== 1) return notification;
  const exit = exits[0];
  if (!exit || typeof exit !== "object" || !("exitCode" in exit)) return notification;
  const exitCode = exit.exitCode;
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
    },
  };
}
