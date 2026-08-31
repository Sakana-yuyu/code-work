"use client";

import type {
  ByokDelegationConfig,
  ByokModelAdapter,
  ByokPromptTemplateConfig,
  ProviderInstanceConfig,
  ServerSettings,
} from "@codework/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ListTodoIcon,
  NetworkIcon,
  ServerCogIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";
import { usePrimaryEnvironment } from "~/state/environments";

import { AgentDriversSettings } from "./AgentDriversSettings";
import { ByokBalanceDashboardPanel } from "./ByokBalanceDashboardPanel";
import { ByokDelegationWorkspacePanel } from "./ByokDelegationWorkspacePanel";
import { ByokFeaturesSection } from "./ByokFeaturesSection";
import { ByokModelAdaptersSection, readByokModelAdapters } from "./ByokModelAdaptersSection";
import { CompositionControlCenterPanel } from "./CompositionControlCenterPanel";
import { FacilitiesPageHeader } from "./FacilitiesPageHeader";
import { IdeSessionsSettings } from "./IdeSessionsSettings";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SupplierRegistryPanel } from "./SupplierRegistryPanel";
import { TaskGraphPanel } from "./TaskGraphPanel";

type ByokFeatureConfigKey = "promptTemplate" | "delegation";

const readByokFeatureConfig = (
  config: unknown,
  key: ByokFeatureConfigKey,
): ByokPromptTemplateConfig | ByokDelegationConfig => {
  if (config === null || typeof config !== "object") return {} as ByokPromptTemplateConfig;
  const value = (config as Record<string, unknown>)[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {} as ByokPromptTemplateConfig;
  }
  return value as ByokPromptTemplateConfig;
};

const nextByokConfig = (config: unknown, key: string, value: unknown): Record<string, unknown> => ({
  ...(config !== null && typeof config === "object" ? (config as Record<string, unknown>) : {}),
  [key]: value,
});

function ByokConfigurationWorkspace() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const instances = (settings.providerInstances ?? {}) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const byokInstances = useMemo(
    () => Object.entries(instances).filter(([, instance]) => String(instance.driver) === "byok"),
    [instances],
  );

  const updateInstanceConfig = (instanceId: string, key: string, value: unknown) => {
    const instance = instances[instanceId];
    if (instance === undefined) return;
    const { config: _ignoredConfig, ...rest } = instance;
    updateSettings({
      providerInstances: {
        ...instances,
        [instanceId]: {
          ...rest,
          config: nextByokConfig(instance.config, key, value),
        } as ProviderInstanceConfig,
      } as ServerSettings["providerInstances"],
    });
  };

  return (
    <SettingsSection
      id="byok-configuration"
      title={t("byokAdapters.title")}
      icon={<BotIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow title={t("settings.byok")} description={t("byokAdapters.description")} />
      {environmentId === null ? (
        <SettingsRow title={t("supplierRegistry.noEnvironment")} />
      ) : byokInstances.length === 0 ? (
        <SettingsRow title={t("byokAdapters.empty")} />
      ) : (
        byokInstances.map(([instanceId, instance]) => {
          const adapters = readByokModelAdapters(instance.config);
          return (
            <section
              key={instanceId}
              className="border-t border-border/60 px-3 py-5 first:border-t-0 sm:px-4"
              data-byok-instance-id={instanceId}
            >
              <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-medium text-foreground">
                  {instance.displayName ?? instanceId}
                </h3>
                <code className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  {instanceId}
                </code>
              </div>
              <div className="space-y-7">
                <ByokModelAdaptersSection
                  environmentId={String(environmentId)}
                  instanceId={instanceId}
                  adapters={adapters}
                  onChange={(next: ReadonlyArray<ByokModelAdapter>) =>
                    updateInstanceConfig(instanceId, "adapters", [...next])
                  }
                />
                <ByokFeaturesSection
                  environmentId={String(environmentId)}
                  instanceId={instanceId}
                  adapters={adapters}
                  promptTemplate={
                    readByokFeatureConfig(
                      instance.config,
                      "promptTemplate",
                    ) as ByokPromptTemplateConfig
                  }
                  delegation={
                    readByokFeatureConfig(instance.config, "delegation") as ByokDelegationConfig
                  }
                  onPromptTemplateChange={(next) =>
                    updateInstanceConfig(instanceId, "promptTemplate", next)
                  }
                  onDelegationChange={(next) =>
                    updateInstanceConfig(instanceId, "delegation", next)
                  }
                />
              </div>
            </section>
          );
        })
      )}
    </SettingsSection>
  );
}

export function RuntimeFacilitiesSettingsPanel() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<ServerCogIcon className="size-4" />}
        title={t("settings.runtime")}
        description={t("runtimeGuide.pageDescription")}
      />
      <AgentDriversSettings />
      <IdeSessionsSettings />
    </SettingsPageContainer>
  );
}

function FacilitiesCollapsibleSection({
  title,
  description,
  icon,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="space-y-3">
        <div className="flex items-start gap-2 px-3 sm:px-4">
          <span className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/25 text-muted-foreground">
            {icon}
          </span>
          <CollapsibleTrigger className="min-w-0 flex-1 text-left">
            <span className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
              {title}
              {open ? (
                <ChevronUpIcon className="size-4 text-muted-foreground" />
              ) : (
                <ChevronDownIcon className="size-4 text-muted-foreground" />
              )}
            </span>
            <span className="mt-1 block max-w-2xl text-[13px] leading-[1.45] text-muted-foreground/80">
              {description}
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div className="space-y-4">{children}</div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

export function DelegationFacilitiesSettingsPanel() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<NetworkIcon className="size-4" />}
        title={t("settings.delegation")}
        description={t("delegationSettings.pageDescription")}
      />
      <ByokDelegationWorkspacePanel />
      <FacilitiesCollapsibleSection
        title={t("delegationSettings.taskGraphTitle")}
        description={t("delegationSettings.taskGraphDescription")}
        icon={<NetworkIcon className="size-3.5" />}
      >
        <TaskGraphPanel />
      </FacilitiesCollapsibleSection>
      <FacilitiesCollapsibleSection
        title={t("delegationSettings.runtimeTitle")}
        description={t("delegationSettings.runtimeDescription")}
        icon={<ListTodoIcon className="size-3.5" />}
      >
        <CompositionControlCenterPanel scope="byok-delegation" />
      </FacilitiesCollapsibleSection>
    </SettingsPageContainer>
  );
}

export function ByokFacilitiesSettingsPanel() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<BotIcon className="size-4" />}
        title={t("settings.byok")}
        description={t("byokAdapters.description")}
      />
      <ByokConfigurationWorkspace />
      <ByokBalanceDashboardPanel />
      <SupplierRegistryPanel />
    </SettingsPageContainer>
  );
}
