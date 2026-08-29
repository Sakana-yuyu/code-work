import { createFileRoute } from "@tanstack/react-router";

import { CompositionAutomationPanel } from "../components/settings/CompositionAutomationPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsAutomationsRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <CompositionAutomationPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/automations")({
  component: SettingsAutomationsRoute,
});
