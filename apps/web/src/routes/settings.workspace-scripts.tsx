import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";

import { WorkspaceScriptsPanel } from "../components/settings/WorkspaceScriptsPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { t } from "~/i18n";

function SettingsWorkspaceScriptsRoute() {
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<TerminalIcon className="size-4" />}
        title={t("settings.workspaceScripts")}
        description={t("workspaceScripts.description")}
      >
        <FacilitiesQuickGuide guideId="workspace-scripts" />
      </FacilitiesPageHeader>
      <WorkspaceScriptsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/workspace-scripts")({
  component: SettingsWorkspaceScriptsRoute,
});
