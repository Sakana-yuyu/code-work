import { createFileRoute } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";

import { CompositionControlCenterPanel } from "../components/settings/CompositionControlCenterPanel";
import { CompositionSquadPanel } from "../components/settings/CompositionSquadPanel";
import { CompositionSquadRunPanel } from "../components/settings/CompositionSquadRunPanel";
import { TeamRuntimeSettingsPanel } from "../components/settings/TeamRuntimeSettingsPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { t } from "~/i18n";

export function SettingsSquadsPage() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<UsersIcon className="size-4" />}
        title={t("settings.squads")}
        description={t("teamRuntime.description")}
      >
        <FacilitiesQuickGuide guideId="team" />
      </FacilitiesPageHeader>
      <div data-facilities-guide-target="team-runtime">
        <TeamRuntimeSettingsPanel />
      </div>
      <div data-facilities-guide-target="team-builder">
        <CompositionSquadPanel />
      </div>
      <div data-facilities-guide-target="team-run">
        <CompositionSquadRunPanel />
      </div>
      <div data-facilities-guide-target="team-control">
        <CompositionControlCenterPanel />
      </div>
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/squads")({
  component: SettingsSquadsPage,
});
