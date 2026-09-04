import { createFileRoute } from "@tanstack/react-router";
import { AlarmClockIcon } from "lucide-react";

import { CompositionAutomationPanel } from "../components/settings/CompositionAutomationPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { t } from "~/i18n";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

function SettingsAutomationsRoute() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  // Same atom family and input as CompositionAutomationPanel below — shared cache.
  const automationsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAutomations({ environmentId, input: {} }),
  );
  const automationsEmpty =
    !automationsQuery.isPending &&
    automationsQuery.error === null &&
    (automationsQuery.data?.automations ?? []).length === 0;
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<AlarmClockIcon className="size-4" />}
        title={t("settings.automations")}
        description={t("automationCenter.description")}
      >
        <FacilitiesQuickGuide guideId="automations" empty={automationsEmpty} />
      </FacilitiesPageHeader>
      <CompositionAutomationPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/automations")({
  component: SettingsAutomationsRoute,
});
