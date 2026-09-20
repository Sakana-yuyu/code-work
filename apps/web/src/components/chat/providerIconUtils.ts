import { ProviderDriverKind } from "@codework/contracts";
import {
  AcpAgentIcon,
  AntigravityIcon,
  ClaudeAI,
  CursorIcon,
  GrokIcon,
  Icon,
  OmpAgentIcon,
  OpenAI,
  OpenCodeIcon,
  PiAgentIcon,
} from "../Icons";
import { PROVIDER_OPTIONS } from "../../session-logic";

export const PROVIDER_ICON_BY_PROVIDER: Partial<Record<ProviderDriverKind, Icon>> = {
  [ProviderDriverKind.make("codex")]: OpenAI,
  [ProviderDriverKind.make("claudeAgent")]: ClaudeAI,
  [ProviderDriverKind.make("opencode")]: OpenCodeIcon,
  [ProviderDriverKind.make("cursor")]: CursorIcon,
  [ProviderDriverKind.make("grok")]: GrokIcon,
  [ProviderDriverKind.make("kimi")]: OpenCodeIcon,
  [ProviderDriverKind.make("antigravity")]: AntigravityIcon,
  [ProviderDriverKind.make("piAgent")]: PiAgentIcon,
  [ProviderDriverKind.make("ompAgent")]: OmpAgentIcon,
  [ProviderDriverKind.make("acpAgent")]: AcpAgentIcon,
  [ProviderDriverKind.make("byok")]: CursorIcon,
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderDriverKind;
  label: string;
  available: true;
  pickerSidebarBadge?: "new" | "soon";
} {
  return option.available;
}

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);

export type ModelEsque = {
  slug: string;
  name: string;
  shortName?: string | undefined;
  subProvider?: string | undefined;
  isLegacy?: boolean | undefined;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 剥掉展示名开头与 `subProvider`（供应商/分组标签）重复的冗余前缀。
 *
 * 只把明确的标签分隔符（":"、"·"、"/"、"|"）当作前缀边界，用于中转把模型
 * 命名成 "GitHub Copilot: GPT-4o" 而分组就是 "GitHub Copilot" 这类冗余场景；
 * 重复的分组标签本就由次行「实例 · 分组」展示，这里只是去重。
 *
 * 不能把 "-"、"_"、"." 或空格当作边界：模型 ID 本身经常以厂商名开头再用这些
 * 字符连接（"glm-5.3"、"grok-4.5"、"kimi_k2"、"GLM 5.3"）。BYOK 分组名恰好是
 * 模型 ID 前缀时（分组 "GLM" + 模型 "glm-5.3"、分组 "Grok" + 模型 "grok-4.5"），
 * 旧的宽松匹配会把模型名截成 "5.3"/"4.5"——「模型名以分组名开头」是完全合法
 * 的形态，必须原样完整展示。
 */
function stripLeadingQualifier(value: string, qualifier: string | null | undefined): string {
  const trimmedQualifier = qualifier?.trim();
  if (!trimmedQualifier) {
    return value;
  }

  const pattern = new RegExp(`^${escapeRegExp(trimmedQualifier)}\\s*[\\u00B7:/|]\\s*`, "iu");
  return value.replace(pattern, "").trim() || value;
}

export function getDisplayModelName(
  model: ModelEsque,
  options?: { preferShortName?: boolean },
): string {
  const name = options?.preferShortName && model.shortName ? model.shortName : model.name;
  return stripLeadingQualifier(name, model.subProvider);
}

export function getTriggerDisplayModelName(model: ModelEsque): string {
  return getDisplayModelName(model, { preferShortName: true });
}

export function getTriggerDisplayModelLabel(model: ModelEsque): string {
  return getTriggerDisplayModelName(model);
}
