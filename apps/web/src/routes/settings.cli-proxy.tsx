import { createFileRoute } from "@tanstack/react-router";
import { useNavigate } from "@tanstack/react-router";

import { EnvironmentId } from "@codework/contracts";
import { useEnvironment, usePrimaryEnvironment } from "../state/environments";
import { CliProxySettingsSection } from "../components/settings/CliProxySettingsSection";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsCliProxyRoute() {
  const primaryEnvironment = usePrimaryEnvironment();
  const search = Route.useSearch();
  const requestedEnvironment = useEnvironment(
    search.environmentId === undefined ? null : EnvironmentId.make(search.environmentId),
  );
  const environment = requestedEnvironment ?? primaryEnvironment;
  const navigate = useNavigate();
  return (
    <SettingsPageContainer width="expanded" className="gap-4">
      {environment ? (
        <CliProxySettingsSection
          environmentId={environment.environmentId}
          readOnly={false}
          onConnected={(instanceId) =>
            void navigate({
              to: "/settings/providers",
              search: {
                environmentId: String(environment.environmentId),
                providerInstanceId: String(instanceId),
              },
            })
          }
        />
      ) : null}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/cli-proxy")({
  validateSearch: (raw: Record<string, unknown>) => ({
    environmentId: typeof raw.environmentId === "string" ? raw.environmentId : undefined,
    providerInstanceId:
      typeof raw.providerInstanceId === "string" ? raw.providerInstanceId : undefined,
  }),
  component: SettingsCliProxyRoute,
});
