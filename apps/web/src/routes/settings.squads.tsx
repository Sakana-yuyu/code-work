import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon, UsersIcon } from "lucide-react";

import { CompositionControlCenterPanel } from "../components/settings/CompositionControlCenterPanel";
import { CompositionSquadPanel } from "../components/settings/CompositionSquadPanel";
import { CompositionSquadRunPanel } from "../components/settings/CompositionSquadRunPanel";
import { TeamRuntimeSettingsPanel } from "../components/settings/TeamRuntimeSettingsPanel";
import { FacilitiesPageHeader } from "../components/settings/FacilitiesPageHeader";
import { FacilitiesQuickGuide } from "../components/settings/FacilitiesQuickGuide";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { t } from "~/i18n";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

function TeamRuntimeAdvancedSection() {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4 px-3 sm:px-4">
          <CollapsibleTrigger className="group min-w-0 flex-1 items-start gap-2 text-left">
            <span className="flex items-center gap-1.5 text-lg font-semibold text-foreground">
              {open ? (
                <ChevronUpIcon className="size-4 text-muted-foreground" />
              ) : (
                <ChevronDownIcon className="size-4 text-muted-foreground" />
              )}
              {t("settings.squadsRuntimeTitle")}
            </span>
            <span className="mt-1 block max-w-2xl text-[13px] leading-[1.45] text-muted-foreground/80">
              {t("settings.squadsRuntimeHint")}
            </span>
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel>
          <div data-facilities-guide-target="team-runtime">
            <TeamRuntimeSettingsPanel />
          </div>
        </CollapsiblePanel>
      </section>
    </Collapsible>
  );
}

export function SettingsSquadsPage() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  // Same atom family and input as CompositionSquadPanel below — shared cache.
  const squadsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionSquads({ environmentId, input: { includeArchived: true } }),
  );
  const squadsEmpty =
    !squadsQuery.isPending &&
    squadsQuery.error === null &&
    (squadsQuery.data?.squads ?? []).length === 0;
  return (
    <SettingsPageContainer width="wide" className="gap-9">
      <FacilitiesPageHeader
        icon={<UsersIcon className="size-4" />}
        title={t("settings.squads")}
        description={t("settings.squadsDescription")}
      >
        <FacilitiesQuickGuide guideId="team" empty={squadsEmpty} />
      </FacilitiesPageHeader>
      <div data-facilities-guide-target="team-builder">
        <CompositionSquadPanel />
      </div>
      <div data-facilities-guide-target="team-run">
        <CompositionSquadRunPanel />
      </div>
      <div data-facilities-guide-target="team-control">
        <CompositionControlCenterPanel />
      </div>
      <TeamRuntimeAdvancedSection />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/squads")({
  component: SettingsSquadsPage,
});
