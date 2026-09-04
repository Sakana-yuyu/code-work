"use client";

import type {
  ByokDelegationConfig,
  ByokPromptTemplateConfig,
  ProviderInstanceConfig,
  ServerSettings,
} from "@codework/contracts";
import { Link } from "@tanstack/react-router";
import { BotIcon, NetworkIcon, ServerCogIcon } from "lucide-react";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { AgentDriversSettings } from "./AgentDriversSettings";
import {
  delegationInstancesFrom,
  ByokDelegationWorkspacePanel,
} from "./ByokDelegationWorkspacePanel";
import { ByokFeaturesSection } from "./ByokFeaturesSection";
import { FacilitiesPageHeader } from "./FacilitiesPageHeader";
import {
  FacilitiesQuickGuide,
  type FacilitiesGuideConcept,
  type FacilitiesGuideStep,
} from "./FacilitiesQuickGuide";
import { IdeSessionsSettings } from "./IdeSessionsSettings";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";

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

const BYOK_GUIDE_STEPS: ReadonlyArray<FacilitiesGuideStep> = [
  {
    titleKey: "facilitiesGuide.byok.step1Title",
    descriptionKey: "facilitiesGuide.byok.step1Description",
    linkTo: "/settings/providers",
    linkLabelKey: "facilitiesGuide.byok.step1Link",
  },
  {
    titleKey: "facilitiesGuide.byok.step2Title",
    descriptionKey: "facilitiesGuide.byok.step2Description",
  },
  {
    titleKey: "facilitiesGuide.byok.step3Title",
    descriptionKey: "facilitiesGuide.byok.step3Description",
  },
  {
    titleKey: "facilitiesGuide.byok.step4Title",
    descriptionKey: "facilitiesGuide.byok.step4Description",
  },
  {
    titleKey: "facilitiesGuide.byok.step5Title",
    descriptionKey: "facilitiesGuide.byok.step5Description",
  },
  {
    titleKey: "facilitiesGuide.byok.step6Title",
    descriptionKey: "facilitiesGuide.byok.step6Description",
  },
];

const BYOK_GUIDE_CONCEPTS: ReadonlyArray<FacilitiesGuideConcept> = [
  {
    termKey: "facilitiesGuide.byok.termChannel",
    descriptionKey: "facilitiesGuide.byok.termChannelDescription",
  },
  {
    termKey: "facilitiesGuide.byok.termSecrets",
    descriptionKey: "facilitiesGuide.byok.termSecretsDescription",
  },
  {
    termKey: "facilitiesGuide.byok.termContext",
    descriptionKey: "facilitiesGuide.byok.termContextDescription",
  },
  {
    termKey: "facilitiesGuide.byok.termBalance",
    descriptionKey: "facilitiesGuide.byok.termBalanceDescription",
  },
];

const DELEGATION_GUIDE_STEPS: ReadonlyArray<FacilitiesGuideStep> = [
  {
    titleKey: "facilitiesGuide.delegation.step1Title",
    descriptionKey: "facilitiesGuide.delegation.step1Description",
    targetSelector: '[data-facilities-guide-target="delegation-workspace"]',
    targetActionKey: "facilitiesGuide.delegation.step1Action",
  },
  {
    titleKey: "facilitiesGuide.delegation.step2Title",
    descriptionKey: "facilitiesGuide.delegation.step2Description",
    targetSelector: '[data-facilities-guide-target="delegation-config"]',
    targetActionKey: "facilitiesGuide.delegation.step2Action",
  },
  {
    titleKey: "facilitiesGuide.delegation.step4Title",
    descriptionKey: "facilitiesGuide.delegation.step4Description",
    targetSelector: '[data-facilities-guide-target="delegation-advanced"]',
    targetActionKey: "facilitiesGuide.delegation.step4Action",
  },
];

const DELEGATION_GUIDE_CONCEPTS: ReadonlyArray<FacilitiesGuideConcept> = [
  {
    termKey: "facilitiesGuide.delegation.termSupervision",
    descriptionKey: "facilitiesGuide.delegation.termSupervisionDescription",
  },
  {
    termKey: "facilitiesGuide.delegation.termExecutionMode",
    descriptionKey: "facilitiesGuide.delegation.termExecutionModeDescription",
  },
];

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
      title={t("byokFeatures.title")}
      icon={<BotIcon className="size-4 text-muted-foreground" />}
    >
      <SettingsRow title={t("settings.byok")} description={t("byokFeatures.facilitiesHint")} />
      {environmentId === null ? (
        <SettingsRow title={t("delegationWorkspace.noEnvironment")} />
      ) : byokInstances.length === 0 ? (
        <SettingsRow
          title={t("byokFeatures.noInstance")}
          control={
            <Button size="sm" variant="outline" render={<Link to="/settings/providers" />}>
              {t("gettingStarted.addProvider")}
            </Button>
          }
        />
      ) : (
        byokInstances.map(([instanceId, instance]) => {
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
                <ByokFeaturesSection
                  environmentId={String(environmentId)}
                  instanceId={instanceId}
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
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  // Shares the agent-drivers atom family with AgentDriversSettings below, so
  // this adds no extra request.
  const driversQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  const runtimeEmpty =
    !driversQuery.isPending &&
    driversQuery.error === null &&
    (driversQuery.data ?? []).length === 0;
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<ServerCogIcon className="size-4" />}
        title={t("settings.runtime")}
        description={t("runtimeGuide.pageDescription")}
      >
        <FacilitiesQuickGuide guideId="runtime" empty={runtimeEmpty} />
      </FacilitiesPageHeader>
      <AgentDriversSettings />
      <IdeSessionsSettings />
    </SettingsPageContainer>
  );
}

export function DelegationFacilitiesSettingsPanel() {
  const settings = usePrimarySettings();
  const delegationEmpty =
    delegationInstancesFrom(
      (settings.providerInstances ?? {}) as Readonly<Record<string, ProviderInstanceConfig>>,
    ).length === 0;
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<NetworkIcon className="size-4" />}
        title={t("settings.delegation")}
        description={t("delegationSettings.pageDescription")}
      >
        <FacilitiesQuickGuide
          guideId="delegation"
          steps={DELEGATION_GUIDE_STEPS}
          concepts={DELEGATION_GUIDE_CONCEPTS}
          empty={delegationEmpty}
        />
      </FacilitiesPageHeader>
      <div data-facilities-guide-target="delegation-workspace">
        <ByokDelegationWorkspacePanel />
      </div>
    </SettingsPageContainer>
  );
}

export function ByokFacilitiesSettingsPanel() {
  const settings = usePrimarySettings();
  const instances = (settings.providerInstances ?? {}) as Readonly<
    Record<string, ProviderInstanceConfig>
  >;
  const byokEmpty = !Object.entries(instances).some(
    ([, instance]) => String(instance.driver) === "byok",
  );
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<BotIcon className="size-4" />}
        title={t("settings.byok")}
        description={t("byokAdapters.description")}
      >
        <FacilitiesQuickGuide
          guideId="byok"
          steps={BYOK_GUIDE_STEPS}
          concepts={BYOK_GUIDE_CONCEPTS}
          empty={byokEmpty}
        />
      </FacilitiesPageHeader>
      <ByokConfigurationWorkspace />
    </SettingsPageContainer>
  );
}
