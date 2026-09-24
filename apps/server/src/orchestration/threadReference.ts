import type { OrchestrationMessage } from "@codework/contracts";

const MAX_REFERENCE_CHARS = 6_000;
const MAX_MESSAGES = 6;

/** 仅保留最近的已完成对话文字，严格限制引用的上下文大小。 */
export function buildThreadReference(thread: {
  readonly messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text" | "streaming">>;
}) {
  const messages = thread.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.streaming &&
        message.text.trim().length > 0,
    )
    .slice(-MAX_MESSAGES);
  let remaining = MAX_REFERENCE_CHARS;
  let truncated = thread.messages.length > messages.length;
  const lines: string[] = [];
  for (const message of messages) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const role = message.role === "user" ? "用户" : "Agent";
    const body = message.text.trim().slice(0, Math.max(0, remaining - role.length - 3));
    if (body.length < message.text.trim().length) truncated = true;
    const line = `${role}：${body}`;
    lines.push(line);
    remaining -= line.length + 1;
  }
  return { excerpt: lines.join("\n"), truncated };
}
