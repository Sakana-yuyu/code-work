import { Link } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { t } from "~/i18n";

import { openCommandPalette } from "../commandPaletteBus";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";

function GettingStartedStep({
  index,
  description,
  children,
}: {
  readonly index: number;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {index}
      </span>
      <span className="min-w-0 flex-1 text-start text-sm leading-snug text-foreground">
        {description}
      </span>
      {children}
    </li>
  );
}

/**
 * First screen for a brand-new workspace (no projects yet): tells the beginner
 * what step 1 is and wires a direct shortcut to each entry point.
 */
export function GettingStartedState() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const driversQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.compositionAgentDrivers({ environmentId, input: {} }),
  );
  const hasAvailableDriver = (driversQuery.data ?? []).some(
    (profile) => profile.status === "available",
  );

  return (
    <Empty className="flex-1">
      <div className="w-full max-w-lg px-8 py-12">
        <EmptyHeader className="max-w-none">
          <EmptyTitle className="text-foreground text-xl">{t("gettingStarted.title")}</EmptyTitle>
          <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
            {t("gettingStarted.subtitle")}
          </EmptyDescription>
        </EmptyHeader>
        <ol className="mt-6 list-none space-y-3">
          <GettingStartedStep index={1} description={t("gettingStarted.stepProviders")}>
            {hasAvailableDriver ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                <CheckIcon className="size-3.5" aria-hidden />
                {t("gettingStarted.providerReady")}
              </span>
            ) : (
              <Button size="xs" render={<Link to="/settings/providers" />} className="shrink-0">
                {t("gettingStarted.addProvider")}
              </Button>
            )}
          </GettingStartedStep>
          <GettingStartedStep index={2} description={t("gettingStarted.stepProject")}>
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              {t("addProject")}
            </Button>
          </GettingStartedStep>
          <GettingStartedStep index={3} description={t("gettingStarted.stepThread")} />
        </ol>
      </div>
    </Empty>
  );
}
