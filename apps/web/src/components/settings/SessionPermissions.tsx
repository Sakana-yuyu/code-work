import { type EnvironmentId, sessionGrantsScope } from "@codework/contracts";
import { AUTH_SCOPE_OPTIONS } from "@codework/shared/authScopeOptions";
import { t } from "~/i18n";
import { useEnvironmentSessionState } from "../../state/session";

export function SessionPermissions({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const session = useEnvironmentSessionState(environmentId);
  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      <p className="text-muted-foreground">
        {t("thesePermissionsApplyToThisClientsCurrentConnection")}
      </p>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
          <li key={scope} className="flex items-start justify-between gap-3">
            <span>{t(title)}</span>
            <span className="shrink-0 text-muted-foreground">
              {sessionGrantsScope(session.data!, scope) ? t("allowed") : t("notGranted")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      {t("permissionsNotCheckedConnectToThisEnvironment")}
    </p>
  );
}
