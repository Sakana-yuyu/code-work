import type { ProviderOptionDescriptor, RuntimeMode } from "@codework/contracts";
import { t } from "../../i18n/runtime";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

export function runtimeModeChoices(): ReadonlyArray<{
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly description: string;
}> {
  return [
    {
      mode: "approval-required",
      label: t("chat.supervised"),
      description: t("chat.supervisedDescription"),
    },
    {
      mode: "auto-accept-edits",
      label: t("chat.autoAcceptEdits"),
      description: t("chat.autoAcceptEditsDescription"),
    },
    {
      mode: "auto",
      label: t("chat.auto"),
      description: t("chat.autoDescription"),
    },
    {
      mode: "full-access",
      label: t("chat.fullAccess"),
      description: t("chat.fullAccessDescription"),
    },
  ];
}

export function selectableChoices(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
) {
  const injected = new Set(descriptor.promptInjectedValues ?? []);
  return descriptor.options.filter(
    (option) => !injected.has(option.id) && !HIDDEN_EFFORT_OPTION_IDS.has(option.id),
  );
}
