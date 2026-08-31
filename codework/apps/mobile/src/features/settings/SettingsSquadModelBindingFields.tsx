import {
  buildCompositionSquadByokProviderOptions,
  compositionSquadModelBindingMode,
  firstSelectableCompositionSquadByokBinding,
  type CompositionSquadModelBindingMode,
  type CompositionSquadModelBindingValue,
} from "@codework/client-runtime/composition/squad-model-bindings";
import type {
  CompositionSquadMemberModelBinding,
  CompositionSquadModelBinding,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@codework/contracts";
import { useMemo } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import { SettingsSquadByokBindingFields } from "./SettingsSquadByokBindingFields";
import {
  SquadModelField,
  SquadModelOptionGroup,
  type SquadModelOption,
} from "./SettingsSquadModelBindingControls";

interface SharedProps {
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly disabled: boolean;
}

interface TeamProps extends SharedProps {
  readonly scope: "team";
  readonly value: CompositionSquadModelBinding | null;
  readonly onChange: (value: CompositionSquadModelBinding | null) => void;
}

interface MemberProps extends SharedProps {
  readonly scope: "member";
  readonly value: CompositionSquadMemberModelBinding | null;
  readonly legacyModel: string;
  readonly onChange: (value: CompositionSquadMemberModelBinding | null) => void;
  readonly onLegacyModelChange: (value: string) => void;
}

type SettingsSquadModelBindingFieldsProps = TeamProps | MemberProps;

const bindingModeLabel = (mode: CompositionSquadModelBindingMode): string =>
  t(`squadBuilder.modelBinding.mode.${mode}`);

export function SettingsSquadModelBindingFields(props: SettingsSquadModelBindingFieldsProps) {
  const providers = useMemo(
    () => buildCompositionSquadByokProviderOptions(props.providerInstances),
    [props.providerInstances],
  );
  const binding: CompositionSquadModelBindingValue = props.value;
  const mode = compositionSquadModelBindingMode(binding);
  const hasSelectableByok = providers.some(
    (provider) => provider.enabled && provider.adapters.length > 0,
  );
  const modeOptions: SquadModelOption<CompositionSquadModelBindingMode>[] = [
    ...(mode === "legacy"
      ? [{ value: "legacy" as const, label: bindingModeLabel("legacy"), disabled: true }]
      : []),
    ...(props.scope === "member"
      ? [{ value: "team_default" as const, label: bindingModeLabel("team_default") }]
      : []),
    { value: "runtime_native", label: bindingModeLabel("runtime_native") },
    {
      value: "byok",
      label: bindingModeLabel("byok"),
      disabled: !hasSelectableByok && mode !== "byok",
    },
  ];

  const setBinding = (next: CompositionSquadModelBindingValue): void => {
    if (props.scope === "member") {
      props.onChange(next);
      return;
    }
    if (next === null || next.kind !== "team_default") props.onChange(next);
  };

  const changeMode = (next: CompositionSquadModelBindingMode): void => {
    if (next === "legacy") return;
    if (next === "team_default") {
      if (props.scope === "member") {
        props.onLegacyModelChange("");
        props.onChange({ kind: "team_default" });
      }
      return;
    }
    if (next === "runtime_native") {
      if (props.scope === "member") props.onLegacyModelChange("");
      setBinding({ kind: "runtime_native" });
      return;
    }
    const nextBinding = firstSelectableCompositionSquadByokBinding(providers);
    if (nextBinding !== null) {
      if (props.scope === "member") props.onLegacyModelChange("");
      setBinding(nextBinding);
    }
  };

  return (
    <View className="gap-3">
      <SquadModelOptionGroup
        label={t("squadBuilder.modelBinding.source")}
        options={modeOptions}
        selected={mode}
        disabled={props.disabled}
        onSelect={changeMode}
      />
      {mode === "legacy" ? (
        props.scope === "member" ? (
          <SquadModelField
            label={t("squadBuilder.modelBinding.legacyModel")}
            description={t("squadBuilder.modelBinding.legacyDescription")}
          >
            <TextInput
              value={props.legacyModel}
              onChangeText={props.onLegacyModelChange}
              editable={!props.disabled}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </SquadModelField>
        ) : (
          <Text className="text-sm leading-5 text-foreground-muted">
            {t("squadBuilder.modelBinding.legacyTeamDescription")}
          </Text>
        )
      ) : null}
      {mode === "team_default" ? (
        <Text className="text-sm leading-5 text-foreground-muted">
          {t("squadBuilder.modelBinding.teamDefaultDescription")}
        </Text>
      ) : null}
      {binding?.kind === "runtime_native" ? (
        <SquadModelField
          label={t("squadBuilder.modelBinding.runtimeModel")}
          description={t("squadBuilder.modelBinding.runtimeDescription")}
        >
          <TextInput
            value={binding.modelId ?? ""}
            onChangeText={(value) => {
              const modelId = value.trim();
              setBinding({
                kind: "runtime_native",
                ...(modelId.length > 0 ? { modelId } : {}),
              });
            }}
            editable={!props.disabled}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </SquadModelField>
      ) : null}
      {binding?.kind === "byok" ? (
        <SettingsSquadByokBindingFields
          providers={providers}
          binding={binding}
          disabled={props.disabled}
          onChange={setBinding}
        />
      ) : null}
    </View>
  );
}
