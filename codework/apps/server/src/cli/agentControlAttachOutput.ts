import { sanitizeAgentOutputText } from "./agentControlOutput.ts";
import type { AgentAttachFrame } from "./agentControlAttachState.ts";

export function formatAgentAttachFrame(frame: AgentAttachFrame, json: boolean): string {
  if (json) return JSON.stringify(frame);

  switch (frame.kind) {
    case "message-removed":
      return `[message removed] ${frame.messageId}`;
    case "status":
      return `[status] ${frame.status}`;
    case "message": {
      const text = sanitizeAgentOutputText(frame.text);
      if (frame.change === "append" && text.length > 0) return text;
      const streaming = frame.streaming ? " (streaming)" : "";
      const change = frame.change === "replace" ? " (replaced)" : "";
      const header = `[${frame.updatedAt}] ${frame.role}${streaming}${change}`;
      return text.length > 0 ? `${header}\n${text}` : header;
    }
  }
}
