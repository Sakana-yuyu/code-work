import type { ClientSettings, ProviderOptionDescriptor, RuntimeMode } from "@codework/contracts";
import { getProviderOptionCurrentValue } from "@codework/shared/model";
import { t } from "../../i18n/runtime";

/**
 * Desktop-oriented effort keywords that don't belong in the phone picker.
 * Prompt-injected values (ultrathink and friends) are filtered from the
 * descriptor metadata; ultracode is a real option but a workflow trigger, not
 * a reasoning level. A value set elsewhere still displays, it just isn't
 * offered.
 */
const HIDDEN_EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["ultracode"]);

const EFFORT_LABELS_ZH: Readonly<Record<string, string>> = {
  none: "关闭",
  minimal: "最低",
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

/** 只改变强度选项的显示文字；传给电脑端的选项 ID 保持原值。 */
export function providerOptionDisplayLabel(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  language: ClientSettings["effortLabelLanguage"] = "en",
  value = getProviderOptionCurrentValue(descriptor),
) {
  const label = descriptor.options.find((option) => option.id === value)?.label;
  return language === "zh-CN" &&
    (descriptor.id === "reasoningEffort" || descriptor.id === "effort") &&
    typeof value === "string"
    ? (EFFORT_LABELS_ZH[value] ?? label)
    : label;
}

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
