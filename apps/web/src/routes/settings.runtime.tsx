import { createFileRoute } from "@tanstack/react-router";

import { RuntimeFacilitiesSettingsPanel } from "../components/settings/FacilitiesSettingsPanels";

export const Route = createFileRoute("/settings/runtime")({
  component: RuntimeFacilitiesSettingsPanel,
});
