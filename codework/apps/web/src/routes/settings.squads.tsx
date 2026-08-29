import { createFileRoute } from "@tanstack/react-router";

import { CompositionControlCenterPanel } from "../components/settings/CompositionControlCenterPanel";
import { CompositionSquadPanel } from "../components/settings/CompositionSquadPanel";
import { CompositionSquadRunPanel } from "../components/settings/CompositionSquadRunPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

export function SettingsSquadsPage() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <CompositionSquadPanel />
      <CompositionSquadRunPanel />
      <CompositionControlCenterPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/squads")({
  component: SettingsSquadsPage,
});
