import { createFileRoute } from "@tanstack/react-router";
import { AlarmClockIcon } from "lucide-react";

import { CompositionAutomationPanel } from "../components/settings/CompositionAutomationPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { t } from "~/i18n";

function SettingsAutomationsRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<AlarmClockIcon className="size-4" />}
        title={t("settings.automations")}
        description={t("automationCenter.description")}
      >
        <FacilitiesQuickGuide guideId="automations" />
      </FacilitiesPageHeader>
      <CompositionAutomationPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/automations")({
  component: SettingsAutomationsRoute,
});
