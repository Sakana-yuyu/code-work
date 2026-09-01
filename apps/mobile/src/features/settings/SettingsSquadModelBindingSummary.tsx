import {
  buildCompositionSquadByokProviderOptions,
  compositionSquadByokBindingAvailability,
} from "@codework/client-runtime/composition/squad-model-bindings";
import type {
  CompositionSquadMemberModelBinding,
  CompositionSquadModelBinding,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@codework/contracts";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";

type SquadModelBinding = CompositionSquadModelBinding | CompositionSquadMemberModelBinding | null;

export function SettingsSquadModelBindingSummary(props: {
  readonly scope: "team" | "member";
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly binding: SquadModelBinding;
  readonly legacyModel?: string;
}) {
  const providers = useMemo(
    () => buildCompositionSquadByokProviderOptions(props.providerInstances),
    [props.providerInstances],
  );
  const label = t(
    props.scope === "team"
      ? "squadBuilder.modelBinding.summary.teamLabel"
      : "squadBuilder.modelBinding.summary.memberLabel",
  );

  if (props.binding === null) {
    const legacyModel = props.legacyModel?.trim() ?? "";
    return (
      <SummaryFrame label={label}>
        {t(
          legacyModel.length > 0
            ? "squadBuilder.modelBinding.summary.legacy"
            : props.scope === "team"
              ? "squadBuilder.modelBinding.summary.teamUnset"
              : "squadBuilder.modelBinding.summary.legacyUnset",
          legacyModel.length > 0 ? { model: legacyModel } : undefined,
        )}
      </SummaryFrame>
    );
  }

  if (props.binding.kind === "team_default") {
    return (
      <SummaryFrame label={label}>
        {t("squadBuilder.modelBinding.summary.team_default")}
      </SummaryFrame>
    );
  }

  if (props.binding.kind === "runtime_native") {
    return (
      <SummaryFrame label={label}>
        {props.binding.modelId === undefined
          ? t("squadBuilder.modelBinding.summary.runtimeDefault")
          : t("squadBuilder.modelBinding.summary.runtimeModel", {
              model: props.binding.modelId,
            })}
      </SummaryFrame>
    );
  }

  const binding = props.binding;
  const provider = providers.find(
    (candidate) => candidate.providerInstanceId === binding.providerInstanceId,
  );
  const adapter = provider?.adapters.find((candidate) => candidate.adapterId === binding.adapterId);
  const availability = compositionSquadByokBindingAvailability(binding, providers);

  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">{label}</Text>
      <Text className="text-xs text-foreground">
        {t("squadBuilder.modelBinding.summary.byok", {
          provider: provider?.displayName ?? binding.providerInstanceId,
          adapter: adapter?.displayName ?? binding.adapterId,
          model: binding.modelId,
        })}
      </Text>
      {availability === "available" ? null : (
        <Text className="text-xs leading-5 text-warning-foreground">
          {t(`squadBuilder.modelBinding.availability.${availability}`)}
        </Text>
      )}
    </View>
  );
}

function SummaryFrame(props: { readonly label: string; readonly children: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      <Text className="text-xs text-foreground">{props.children}</Text>
    </View>
  );
}
