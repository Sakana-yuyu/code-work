import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";

import { WorkspaceScriptsPanel } from "../components/settings/WorkspaceScriptsPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { t } from "~/i18n";
import { useProjects } from "~/state/entities";

function SettingsWorkspaceScriptsRoute() {
  // Scripts run inside projects, so a projectless environment is the page's
  // empty state. useProjects reads the local entity cache — no extra request
  // (the panel's runs query is parameter-selective and cannot be reused here).
  const projects = useProjects();
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<TerminalIcon className="size-4" />}
        title={t("settings.workspaceScripts")}
        description={t("workspaceScripts.description")}
      >
        <FacilitiesQuickGuide guideId="workspace-scripts" empty={projects.length === 0} />
      </FacilitiesPageHeader>
      <WorkspaceScriptsPanel />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/workspace-scripts")({
  component: SettingsWorkspaceScriptsRoute,
});
