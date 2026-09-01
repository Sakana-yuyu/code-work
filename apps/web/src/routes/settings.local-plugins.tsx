import { createFileRoute } from "@tanstack/react-router";

import { LocalPluginsSettings } from "../components/settings/LocalPluginsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

export function SettingsLocalPluginsPage() {
  return (
    <SettingsPageContainer>
      <LocalPluginsSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/local-plugins")({
  component: SettingsLocalPluginsPage,
});
