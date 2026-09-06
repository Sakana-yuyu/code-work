import { createFileRoute, useLocation } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { EnvironmentId, ProviderInstanceId } from "@codework/contracts";

function SettingsProvidersRoute() {
  const location = useLocation();
  const rawEnvironmentId =
    typeof location.search === "object" && location.search !== null
      ? (location.search as { readonly environmentId?: unknown }).environmentId
      : undefined;
  const environmentId = typeof rawEnvironmentId === "string" ? rawEnvironmentId : undefined;
  const rawProviderInstanceId =
    typeof location.search === "object" && location.search !== null
      ? (location.search as { readonly providerInstanceId?: unknown }).providerInstanceId
      : undefined;
  const providerInstanceId =
    typeof rawProviderInstanceId === "string"
      ? ProviderInstanceId.make(rawProviderInstanceId)
      : undefined;
  return (
    <ProviderSettingsPanel
      {...(environmentId === undefined
        ? {}
        : { initialEnvironmentId: EnvironmentId.make(environmentId) })}
      {...(providerInstanceId === undefined ? {} : { initialInstanceId: providerInstanceId })}
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRoute,
});
