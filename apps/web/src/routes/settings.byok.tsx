import { createFileRoute } from "@tanstack/react-router";

import { ByokFacilitiesSettingsPanel } from "../components/settings/FacilitiesSettingsPanels";

export const Route = createFileRoute("/settings/byok")({
  component: ByokFacilitiesSettingsPanel,
});
