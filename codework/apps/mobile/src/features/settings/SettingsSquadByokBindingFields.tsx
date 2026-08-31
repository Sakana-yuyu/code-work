import {
  compositionSquadByokBindingAvailability,
  compositionSquadByokBindingForAdapter,
  compositionSquadByokBindingForProvider,
  type CompositionSquadByokProviderOption,
} from "@codework/client-runtime/composition/squad-model-bindings";
import type { CompositionSquadModelBinding } from "@codework/contracts";
import { View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { t } from "../../i18n";
import {
  SquadModelActionButton,
  SquadModelField,
  SquadModelOptionGroup,
  type SquadModelOption,
} from "./SettingsSquadModelBindingControls";

type CompositionSquadByokBinding = Extract<CompositionSquadModelBinding, { kind: "byok" }>;

export function SettingsSquadByokBindingFields(props: {
  readonly providers: ReadonlyArray<CompositionSquadByokProviderOption>;
  readonly binding: CompositionSquadByokBinding;
  readonly disabled: boolean;
  readonly onChange: (binding: CompositionSquadModelBinding) => void;
}) {
  const selectedProvider =
    props.providers.find(
      (provider) => provider.providerInstanceId === props.binding.providerInstanceId,
    ) ?? null;
  const selectedAdapter =
    selectedProvider?.adapters.find((adapter) => adapter.adapterId === props.binding.adapterId) ??
    null;
  const availability = compositionSquadByokBindingAvailability(props.binding, props.providers);
  const providerOptions: SquadModelOption<string>[] = props.providers.map((provider) => ({
    value: provider.providerInstanceId,
    label: provider.displayName,
    disabled: !provider.enabled,
  }));
  if (selectedProvider === null) {
    providerOptions.unshift({
      value: props.binding.providerInstanceId,
      label: props.binding.providerInstanceId,
      disabled: true,
    });
  }
  const adapterOptions: SquadModelOption<string>[] =
    selectedProvider?.adapters.map((adapter) => ({
      value: adapter.adapterId,
      label: adapter.displayName,
    })) ?? [];
  if (selectedAdapter === null) {
    adapterOptions.unshift({
      value: props.binding.adapterId,
      label: props.binding.adapterId,
      disabled: true,
    });
  }

  return (
    <View className="gap-3">
      <SquadModelOptionGroup
        label={t("squadBuilder.modelBinding.provider")}
        options={providerOptions}
        selected={props.binding.providerInstanceId}
        disabled={props.disabled}
        onSelect={(providerInstanceId) => {
          const nextBinding = compositionSquadByokBindingForProvider(
            props.providers,
            providerInstanceId,
          );
          if (nextBinding !== null) props.onChange(nextBinding);
        }}
      />
      <SquadModelOptionGroup
        label={t("squadBuilder.modelBinding.adapter")}
        options={adapterOptions}
        selected={props.binding.adapterId}
        disabled={props.disabled || selectedProvider === null || !selectedProvider.enabled}
        onSelect={(adapterId) => {
          const nextBinding = compositionSquadByokBindingForAdapter(
            props.providers,
            props.binding.providerInstanceId,
            adapterId,
          );
          if (nextBinding !== null) props.onChange(nextBinding);
        }}
      />
      <SquadModelField
        label={t("squadBuilder.modelBinding.model")}
        description={t("squadBuilder.modelBinding.modelDescription")}
      >
        <TextInput value={props.binding.modelId} editable={false} autoCapitalize="none" />
      </SquadModelField>
      {availability === "available" ? null : (
        <View className="gap-2">
          <Text className="text-sm leading-5 text-warning-foreground">
            {t(`squadBuilder.modelBinding.availability.${availability}`)}
          </Text>
          {availability === "model_changed" && selectedAdapter !== null ? (
            <SquadModelActionButton
              label={t("squadBuilder.modelBinding.acceptCurrentModel")}
              disabled={props.disabled}
              onPress={() => {
                const nextBinding = compositionSquadByokBindingForAdapter(
                  props.providers,
                  props.binding.providerInstanceId,
                  props.binding.adapterId,
                );
                if (nextBinding !== null) props.onChange(nextBinding);
              }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}
