"use client";

import type { CompositionSquadModelBinding } from "@codework/contracts";
import {
  compositionSquadByokBindingAvailability,
  compositionSquadByokBindingForAdapter,
  compositionSquadByokBindingForProvider,
  type CompositionSquadByokProviderOption,
} from "@codework/client-runtime/composition/squad-model-bindings";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { t } from "~/i18n";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
type CompositionSquadByokBinding = Extract<CompositionSquadModelBinding, { kind: "byok" }>;

function ByokBindingField({
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

export function CompositionSquadByokBindingFields({
  idPrefix,
  providers,
  binding,
  disabled,
  onChange,
}: {
  readonly idPrefix: string;
  readonly providers: ReadonlyArray<CompositionSquadByokProviderOption>;
  readonly binding: CompositionSquadByokBinding;
  readonly disabled: boolean;
  readonly onChange: (binding: CompositionSquadModelBinding) => void;
}) {
  const selectedProvider =
    providers.find((provider) => provider.providerInstanceId === binding.providerInstanceId) ??
    null;
  const selectedAdapter =
    selectedProvider?.adapters.find((adapter) => adapter.adapterId === binding.adapterId) ?? null;
  const availability = compositionSquadByokBindingAvailability(binding, providers);

  return (
    <>
      <ByokBindingField label={t("squadBuilder.modelBinding.provider")}>
        <Select
          value={binding.providerInstanceId}
          disabled={disabled}
          onValueChange={(next) => {
            if (!next) return;
            const nextBinding = compositionSquadByokBindingForProvider(providers, next);
            if (nextBinding !== null) onChange(nextBinding);
          }}
        >
          <SelectTrigger
            id={`${idPrefix}-provider`}
            size="compact"
            aria-label={t("squadBuilder.modelBinding.provider")}
          >
            <SelectValue>{selectedProvider?.displayName ?? binding.providerInstanceId}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {selectedProvider === null ? (
              <SelectItem value={binding.providerInstanceId} disabled>
                {binding.providerInstanceId}
              </SelectItem>
            ) : null}
            {providers.map((provider) => (
              <SelectItem
                key={provider.providerInstanceId}
                value={provider.providerInstanceId}
                disabled={!provider.enabled}
              >
                {provider.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </ByokBindingField>

      <ByokBindingField label={t("squadBuilder.modelBinding.adapter")}>
        <Select
          value={binding.adapterId}
          disabled={disabled || selectedProvider === null || !selectedProvider.enabled}
          onValueChange={(next) => {
            if (!next) return;
            const nextBinding = compositionSquadByokBindingForAdapter(
              providers,
              binding.providerInstanceId,
              next,
            );
            if (nextBinding !== null) onChange(nextBinding);
          }}
        >
          <SelectTrigger
            id={`${idPrefix}-adapter`}
            size="compact"
            aria-label={t("squadBuilder.modelBinding.adapter")}
          >
            <SelectValue>{selectedAdapter?.displayName ?? binding.adapterId}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {selectedAdapter === null ? (
              <SelectItem value={binding.adapterId} disabled>
                {binding.adapterId}
              </SelectItem>
            ) : null}
            {selectedProvider?.adapters.map((adapter) => (
              <SelectItem key={adapter.adapterId} value={adapter.adapterId}>
                {adapter.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </ByokBindingField>

      <ByokBindingField
        className="sm:col-span-2"
        label={t("squadBuilder.modelBinding.model")}
        description={t("squadBuilder.modelBinding.modelDescription")}
      >
        <Input
          id={`${idPrefix}-model`}
          size="compact"
          value={binding.modelId}
          readOnly
          disabled={disabled}
        />
      </ByokBindingField>

      {availability !== "available" ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 sm:col-span-2">
          <p role="status" className="min-w-0 flex-1 text-xs leading-snug text-warning-foreground">
            {t(`squadBuilder.modelBinding.availability.${availability}`)}
          </p>
          {availability === "model_changed" && selectedAdapter !== null ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                const nextBinding = compositionSquadByokBindingForAdapter(
                  providers,
                  binding.providerInstanceId,
                  binding.adapterId,
                );
                if (nextBinding !== null) onChange(nextBinding);
              }}
            >
              <RefreshCwIcon />
              {t("squadBuilder.modelBinding.acceptCurrentModel")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
