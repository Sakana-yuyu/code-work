import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceScriptsPanel } from "../components/settings/WorkspaceScriptsPanel";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsWorkspaceScriptsRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <WorkspaceScriptsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/workspace-scripts")({
  component: SettingsWorkspaceScriptsRoute,
});
