import type { CompositionAgentDriverProfile } from "@codework/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

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
      return t("available");
    case "degraded":
      return t("diagnostics.sourceStatus.degraded");
    case "unavailable":
      return t("pullRequests.unavailable");
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
  ["supportsWorkspace", "runtimeGuide.surfaceWorkspace"],
  ["supportsTerminal", "runtimeGuide.surfaceTerminal"],
  ["supportsGit", "runtimeGuide.surfaceGit"],
  ["supportsMcp", "runtimeGuide.surfaceMcp"],
  ["supportsBrowser", "runtimeGuide.surfaceBrowser"],
  ["supportsIde", "runtimeGuide.surfaceIde"],
  ["supportsProviderApi", "runtimeGuide.surfaceProviderApi"],
  ["supportsResume", "runtimeGuide.surfaceResume"],
  ["supportsSquad", "runtimeGuide.surfaceSquad"],
  ["supportsLeader", "runtimeGuide.surfaceLeader"],
  ["supportsTaskGraph", "runtimeGuide.surfaceTaskGraph"],
];

const statusDescription = (status: CompositionAgentDriverProfile["status"]): string => {
  switch (status) {
    case "available":
      return t("runtimeGuide.statusAvailableDescription");
    case "degraded":
      return t("runtimeGuide.statusDegradedDescription");
    case "unavailable":
      return t("runtimeGuide.statusUnavailableDescription");
  }
};

const statusIcon = (status: CompositionAgentDriverProfile["status"]) => {
  switch (status) {
    case "available":
      return <CircleCheckIcon className="size-3.5" />;
    case "degraded":
      return <CircleAlertIcon className="size-3.5" />;
    case "unavailable":
      return <CircleXIcon className="size-3.5" />;
  }
};

export function displayDriverName(profile: CompositionAgentDriverProfile): string {
  const generatedName = `${profile.driverKind}${
    profile.providerKind === undefined ? "" : `:${profile.providerKind}`
  }`;
  const customName = profile.displayName?.trim();
  if (customName && customName !== profile.agentId && customName !== generatedName) {
    return customName;
  }

  switch (profile.providerKind) {
    case "byok":
      return t("runtimeGuide.driverByok");
    case "codex":
      return t("runtimeGuide.driverCodex");
    case "claudeAgent":
      return t("runtimeGuide.driverClaude");
    case "cursor":
      return t("runtimeGuide.driverCursor");
    case "grok":
      return t("runtimeGuide.driverGrok");
    case "opencode":
      return t("runtimeGuide.driverOpenCode");
    default:
      return customName ?? profile.agentId;
  }
}

function RuntimeStartGuide({
  profiles,
}: {
  readonly profiles: ReadonlyArray<CompositionAgentDriverProfile>;
}) {
  const availableProfiles = profiles.filter((profile) => profile.status === "available");
  const hasAvailableByok = availableProfiles.some((profile) => profile.providerKind === "byok");
  const title =
    profiles.length === 0
      ? t("runtimeGuide.emptyTitle")
      : hasAvailableByok
        ? t("runtimeGuide.byokReadyTitle")
        : availableProfiles.length > 0
          ? t("runtimeGuide.readyTitle", { count: availableProfiles.length })
          : t("runtimeGuide.setupTitle");
  const description =
    profiles.length === 0
      ? t("runtimeGuide.emptyDescription")
      : hasAvailableByok
        ? t("runtimeGuide.byokReadyDescription")
        : availableProfiles.length > 0
          ? t("runtimeGuide.readyDescription")
          : t("runtimeGuide.setupDescription");

  return (
    <SettingsRow
      data-runtime-guide
      title={title}
      description={description}
      control={
        <div className="flex flex-wrap gap-2">
          {availableProfiles.length > 0 ? (
            <Button
              data-facilities-guide-target="runtime-delegation"
              render={<Link to="/settings/delegation" />}
              size="xs"
            >
              {t("runtimeGuide.openDelegation")}
              <ArrowRightIcon />
            </Button>
          ) : null}
          <Button
            render={<Link to={hasAvailableByok ? "/settings/byok" : "/settings/providers"} />}
            size="xs"
            variant={availableProfiles.length > 0 ? "outline" : "default"}
          >
            {hasAvailableByok ? t("runtimeGuide.openByok") : t("runtimeGuide.openProviders")}
          </Button>
        </div>
      }
    />
  );
}

function DriverProfileRow({ profile }: { readonly profile: CompositionAgentDriverProfile }) {
  const activeSurfaces = surfaceLabels.filter(([key]) => profile[key] === true);
  const isByok = profile.providerKind === "byok";

  return (
    <article
      className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3 sm:px-4"
      data-facilities-guide-target="runtime-capabilities"
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{displayDriverName(profile)}</h3>
          <span
            className={`inline-flex items-center gap-1 text-xs ${statusClassName(profile.status)}`}
          >
            {statusIcon(profile.status)}
            {statusLabel(profile.status)}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{statusDescription(profile.status)}</p>
        <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
          {activeSurfaces.length === 0 ? (
            <span>{t("agentDrivers.noVerifiedSharedSurfaces")}</span>
          ) : (
            activeSurfaces.map(([key, labelKey]) => (
              <span key={String(key)} className="rounded bg-muted px-1.5 py-0.5">
                {t(labelKey)}
              </span>
            ))
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 pt-2">
          <details className="min-w-0 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none text-foreground hover:text-muted-foreground">
              {t("runtimeGuide.technicalDetails")}
            </summary>
            <div className="mt-2 grid gap-2 border-l border-border/70 pl-3">
              <p>{t("runtimeGuide.technicalDetailsDescription")}</p>
              <p className="break-all font-mono text-[11px]">
                {profile.agentId} · {profile.runtimeId}
              </p>
              {profile.capabilities.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {profile.capabilities.map((capability) => (
                    <code key={capability} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                      {capability}
                    </code>
                  ))}
                </div>
              ) : null}
              {profile.reasonCode ? (
                <p>
                  {t("agentDrivers.reason")}: <code>{profile.reasonCode}</code>
                </p>
              ) : null}
            </div>
          </details>
          {isByok ? (
            <Button render={<Link to="/settings/byok" />} size="xs" variant="outline">
              {t("runtimeGuide.openByok")}
            </Button>
          ) : profile.status !== "available" ? (
            <Button render={<Link to="/settings/providers" />} size="xs" variant="outline">
              {t("runtimeGuide.manageProvider")}
            </Button>
          ) : null}
        </div>
      </div>
    </article>
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
      data-facilities-guide-target="runtime-drivers"
      title={t("agentDrivers.title")}
      icon={<BotIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label={t("agentDrivers.refresh")}
          onClick={() => query.refresh()}
          disabled={query.isPending}
          type="button"
        >
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
        </Button>
      }
    >
      <RuntimeStartGuide profiles={profiles} />
      <SettingsRow
        title={t("runtimeGuide.driverStatusTitle")}
        description={t("runtimeGuide.driverStatusDescription")}
        status={query.error ?? (query.isPending ? t("loading") : undefined)}
      />
      {profiles.length === 0 ? (
        <SettingsRow
          title={t("agentDrivers.empty")}
          description={t("agentDrivers.emptyDescription")}
        />
      ) : (
        profiles.map((profile) => <DriverProfileRow key={profile.agentId} profile={profile} />)
      )}
      <SettingsRow
        title={t("authorizationBoundary")}
        description={t("agentDrivers.authorizationDescription")}
        status={<ShieldCheckIcon className="inline size-3.5 align-[-2px]" />}
      />
    </SettingsSection>
  );
}
