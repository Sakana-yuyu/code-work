import { createFileRoute } from "@tanstack/react-router";

import { CompositionSquadPanel } from "../components/settings/CompositionSquadPanel";
import { CompositionSquadRunPanel } from "../components/settings/CompositionSquadRunPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsSquadsRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <CompositionSquadPanel />
      <CompositionSquadRunPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/squads")({
  component: SettingsSquadsRoute,
});
