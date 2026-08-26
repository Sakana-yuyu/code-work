import type { CompositionAgentDriverProfile } from "@codework/contracts";
import { BotIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { t } from "~/i18n";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_PROFILES: ReadonlyArray<CompositionAgentDriverProfile> = [];

const statusLabel = (status: CompositionAgentDriverProfile["status"]): string => {
  switch (status) {
    case "available":
      return t("Available");
    case "degraded":
      return t("Degraded");
    case "unavailable":
      return t("Unavailable");
  }
};

const statusClassName = (status: CompositionAgentDriverProfile["status"]): string => {
  switch (status) {
    case "available":
      return "text-success";
    case "degraded":
      return "text-warning";
    case "unavailable":
      return "text-destructive";
  }
};

const surfaceLabels: ReadonlyArray<readonly [keyof CompositionAgentDriverProfile, string]> = [
  ["supportsToolBroker", "ToolBroker"],
  ["supportsWorkspace", "Workspace"],
  ["supportsTerminal", "Terminal"],
  ["supportsGit", "Git"],
  ["supportsMcp", "MCP"],
  ["supportsBrowser", "Browser"],
  ["supportsIde", "IDE API"],
  ["supportsProviderApi", "Provider API"],
  ["supportsCapabilityHandshake", "Capability handshake"],
  ["supportsResume", "Resume"],
  ["supportsSquad", "Squad"],
  ["supportsLeader", "Leader"],
  ["supportsTaskGraph", "Task Graph"],
];

function DriverProfileRow({ profile }: { readonly profile: CompositionAgentDriverProfile }) {
  const activeSurfaces = surfaceLabels.filter(([key]) => profile[key] === true);

  return (
    <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {profile.displayName ?? profile.agentId}
          </h3>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {profile.driverKind}
            {profile.providerKind === undefined ? "" : `:${profile.providerKind}`}
          </span>
          <span className={`text-xs ${statusClassName(profile.status)}`}>
            {statusLabel(profile.status)}
          </span>
        </div>
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          {profile.agentId} · {profile.runtimeId}
        </p>
        <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          {activeSurfaces.length === 0 ? (
            <span>{t("No verified shared surfaces")}</span>
          ) : (
            activeSurfaces.map(([key, label]) => (
              <span key={String(key)} className="rounded bg-muted px-1.5 py-0.5">
                {label}
              </span>
            ))
          )}
        </div>
        {profile.capabilities.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {profile.capabilities.map((capability) => (
              <code
                key={capability}
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {capability}
              </code>
            ))}
          </div>
        ) : null}
        {profile.reasonCode ? (
          <p className="text-xs text-muted-foreground">
            {t("Reason")}: <code>{profile.reasonCode}</code>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AgentDriversSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  const profiles = query.data ?? EMPTY_PROFILES;

  return (
    <SettingsSection
      id="agent-drivers"
      title={t("Agent Drivers")}
      icon={<BotIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t("Refresh Agent Drivers")}
          onClick={() => query.refresh()}
          disabled={query.isPending}
          type="button"
        >
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
        </Button>
      }
    >
      <SettingsRow
        title={t("Unified Driver capability projection")}
        description={t(
          "This read-only view reports verified runtime and API surfaces. Task grants and ToolBroker approval still apply to every execution.",
        )}
        status={query.error ?? (query.isPending ? t("Loading...") : undefined)}
      />
      {profiles.length === 0 ? (
        <SettingsRow
          title={t("No Agent Drivers available")}
          description={t(
            "Provider and external runtime drivers appear here after their environment is connected.",
          )}
        />
      ) : (
        profiles.map((profile) => <DriverProfileRow key={profile.agentId} profile={profile} />)
      )}
      <SettingsRow
        title={t("Authorization boundary")}
        description={t(
          "A visible capability does not grant access by itself; the task-scoped grant, approval, audit, and cancellation path remains authoritative.",
        )}
        status={<ShieldCheckIcon className="inline size-3.5 align-[-2px]" />}
      />
    </SettingsSection>
  );
}
