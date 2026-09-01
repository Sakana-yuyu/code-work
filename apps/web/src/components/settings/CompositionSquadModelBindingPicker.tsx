"use client";

import type {
  CompositionSquadMemberModelBinding,
  CompositionSquadModelBinding,
  ProviderInstanceConfig,
  ProviderInstanceId,
} from "@codework/contracts";
import {
  buildCompositionSquadByokProviderOptions,
  compositionSquadModelBindingMode,
  firstSelectableCompositionSquadByokBinding,
  type CompositionSquadModelBindingMode,
  type CompositionSquadModelBindingValue,
} from "@codework/client-runtime/composition/squad-model-bindings";
import { useMemo, type ReactNode } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";

import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CompositionSquadByokBindingFields } from "./CompositionSquadByokBindingFields";

interface SharedProps {
  readonly idPrefix: string;
  readonly providerInstances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>;
  readonly disabled: boolean;
  readonly className?: string;
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

type CompositionSquadModelBindingPickerProps = TeamProps | MemberProps;

function BindingField({
  label,
  description,
  className,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-xs font-medium", className)}>
      <span>{label}</span>
      {children}
      {description ? (
        <span className="font-normal leading-snug text-muted-foreground">{description}</span>
      ) : null}
    </label>
  );
}

const bindingModeLabel = (mode: CompositionSquadModelBindingMode): string =>
  t(`squadBuilder.modelBinding.mode.${mode}`);

export function CompositionSquadModelBindingPicker(props: CompositionSquadModelBindingPickerProps) {
  const providers = useMemo(
    () => buildCompositionSquadByokProviderOptions(props.providerInstances),
    [props.providerInstances],
  );
  const binding: CompositionSquadModelBindingValue = props.value;
  const mode = compositionSquadModelBindingMode(binding);
  const hasSelectableByok = providers.some(
    (provider) => provider.enabled && provider.adapters.length > 0,
  );

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

  const modeOptions: ReadonlyArray<CompositionSquadModelBindingMode> = [
    ...(mode === "legacy" ? (["legacy"] as const) : []),
    ...(props.scope === "member" ? (["team_default"] as const) : []),
    "runtime_native",
    "byok",
  ];

  return (
    <div className={cn("grid min-w-0 gap-3 sm:grid-cols-2", props.className)}>
      <BindingField label={t("squadBuilder.modelBinding.source")}>
        <Select
          value={mode}
          disabled={props.disabled}
          onValueChange={(next) => next && changeMode(next as CompositionSquadModelBindingMode)}
        >
          <SelectTrigger
            id={`${props.idPrefix}-source`}
            size="compact"
            aria-label={t("squadBuilder.modelBinding.source")}
          >
            <SelectValue>{bindingModeLabel(mode)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {modeOptions.map((option) => (
              <SelectItem
                key={option}
                value={option}
                disabled={option === "byok" && !hasSelectableByok && mode !== "byok"}
              >
                {bindingModeLabel(option)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </BindingField>

      {mode === "legacy" ? (
        props.scope === "member" ? (
          <BindingField
            label={t("squadBuilder.modelBinding.legacyModel")}
            description={t("squadBuilder.modelBinding.legacyDescription")}
          >
            <Input
              id={`${props.idPrefix}-legacy-model`}
              size="compact"
              value={props.legacyModel}
              disabled={props.disabled}
              placeholder={t("squadBuilder.optional")}
              onChange={(event) => props.onLegacyModelChange(event.currentTarget.value)}
            />
          </BindingField>
        ) : (
          <p className="self-end text-xs leading-snug text-muted-foreground sm:pb-1">
            {t("squadBuilder.modelBinding.legacyTeamDescription")}
          </p>
        )
      ) : null}

      {mode === "team_default" ? (
        <p className="self-end text-xs leading-snug text-muted-foreground sm:pb-1">
          {t("squadBuilder.modelBinding.teamDefaultDescription")}
        </p>
      ) : null}

      {binding?.kind === "runtime_native" ? (
        <BindingField
          label={t("squadBuilder.modelBinding.runtimeModel")}
          description={t("squadBuilder.modelBinding.runtimeDescription")}
        >
          <Input
            id={`${props.idPrefix}-runtime-model`}
            size="compact"
            value={binding.modelId ?? ""}
            disabled={props.disabled}
            placeholder={t("squadBuilder.optional")}
            onChange={(event) => {
              const modelId = event.currentTarget.value.trim();
              setBinding({
                kind: "runtime_native",
                ...(modelId.length > 0 ? { modelId } : {}),
              });
            }}
          />
        </BindingField>
      ) : null}

      {binding?.kind === "byok" ? (
        <CompositionSquadByokBindingFields
          idPrefix={props.idPrefix}
          providers={providers}
          binding={binding}
          disabled={props.disabled}
          onChange={setBinding}
        />
      ) : null}
    </div>
  );
}
