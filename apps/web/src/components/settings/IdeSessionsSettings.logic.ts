import type { CompositionIdeRuntimeProfile } from "@codework/contracts";
import { t } from "~/i18n/runtime";

export type {
  IdeSessionDraft,
  IdeSessionHeaderDraft,
  IdeSessionSave,
} from "@codework/shared/ideSessionSettings";
export {
  configFromIdeSessionDraft,
  emptyIdeSessionDraft,
  formFromIdeInstance,
} from "@codework/shared/ideSessionSettings";

export const IDE_SESSION_PROFILES: ReadonlyArray<{
  readonly value: CompositionIdeRuntimeProfile;
  readonly label: string;
}> = [
  {
    value: "cursor_ide",
    get label() {
      return t("cursorIde");
    },
  },
  {
    value: "vscode_ide",
    get label() {
      return t("vsCode");
    },
  },
  {
    value: "browser_mcp",
    get label() {
      return t("browserMcp");
    },
  },
];
