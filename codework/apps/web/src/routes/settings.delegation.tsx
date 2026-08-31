import { createFileRoute } from "@tanstack/react-router";

import { DelegationFacilitiesSettingsPanel } from "../components/settings/FacilitiesSettingsPanels";

export const Route = createFileRoute("/settings/delegation")({
  component: DelegationFacilitiesSettingsPanel,
});
