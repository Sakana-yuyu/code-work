import type { Icon } from "../Icons";
import { AcpAgentIcon, Gemini, GithubCopilotIcon } from "../Icons";
import { t } from "~/i18n/runtime";

/**
 * First-class add-provider shortcuts that still save as `acpAgent` instances.
 * Keep ids aligned with registry catalog entry ids so search/prefill works.
 */
export type AcpCuratedShortcut = {
  readonly id: string;
  readonly label: () => string;
  readonly icon: Icon;
  readonly auth: string;
  readonly catalogQuery: string;
};

export const ACP_CURATED_SHORTCUTS: readonly AcpCuratedShortcut[] = [
  {
    id: "github-copilot-cli",
    label: () => t("githubCopilot"),
    icon: GithubCopilotIcon,
    auth: "copilot-login",
    catalogQuery: "github-copilot-cli",
  },
  {
    id: "gemini",
    label: () => t("gemini"),
    icon: Gemini,
    auth: "oauth-personal",
    catalogQuery: "gemini",
  },
  {
    id: "cline",
    label: () => t("acpShortcut.cline"),
    icon: AcpAgentIcon,
    auth: "",
    catalogQuery: "cline",
  },
  {
    id: "qwen",
    label: () => t("acpShortcut.qwen"),
    icon: AcpAgentIcon,
    auth: "openai",
    catalogQuery: "qwen",
  },
];
