import type { AcpRegistryCatalogEntry } from "@codework/contracts";

/** `public/acp-agent-icons/` 内随 Web 打包的官方目录图标（2026-09-30 自 ACP Registry CDN 获取）。 */
const BUNDLED_ACP_AGENT_ICON_IDS: ReadonlySet<string> = new Set([
  "agoragentic-acp",
  "amp-acp",
  "antigravity-acp",
  "auggie",
  "autohand",
  "claude-acp",
  "cline",
  "codebuddy-code",
  "codex-acp",
  "cortex-code",
  "corust-agent",
  "crow-cli",
  "cursor",
  "deepagents",
  "devin",
  "dimcode",
  "dirac",
  "factory-droid",
  "fast-agent",
  "gemini",
  "github-copilot-cli",
  "glm-acp-agent",
  "goose",
  "grok-build",
  "harn",
  "junie",
  "kilo",
  "kimchi",
  "kimi",
  "minimax-code",
  "minion-code",
  "mistral-vibe",
  "nova",
  "opencode",
  "pi-acp",
  "poolside",
  "qoder",
  "qwen-code",
  "sigit",
  "stakpak",
  "vtcode",
]);

/** 内置副本优先，离线和桌面端无需访问 CDN；未内置时使用目录给出的 HTTPS 图标。 */
export function acpAgentIconSrc(
  entry: Pick<AcpRegistryCatalogEntry, "id" | "iconUrl">,
): string | null {
  if (BUNDLED_ACP_AGENT_ICON_IDS.has(entry.id)) return `/acp-agent-icons/${entry.id}.svg`;
  return entry.iconUrl ?? null;
}
