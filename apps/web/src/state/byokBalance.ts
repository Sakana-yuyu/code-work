/**
 * Multi-environment BYOK balance state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the results into one plan view. Balance credentials never leave the server
 * that holds them.
 *
 * @module state/byokBalance
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  ByokBalanceDashboardResult,
  ByokBalanceResult,
  EnvironmentId,
} from "@codework/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { mergeByokDashboards, type MergedByokPlans } from "@codework/shared/byokBalanceMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { byokEnvironment, serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface EnvironmentByokBalanceStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly dashboard: ByokBalanceDashboardResult | null;
}

const dashboardsAtom = Atom.make((get): readonly EnvironmentByokBalanceStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentByokBalanceStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.byokBalanceDashboard({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report balances." : null,
      dashboard: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-byok-balance:dashboards"));

export interface ByokBalanceQueryTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly adapterId: string;
}

export interface ByokBalanceView {
  readonly environments: readonly EnvironmentByokBalanceStatus[];
  readonly merged: MergedByokPlans;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly refresh: () => void;
  /** One user-initiated balance query; refreshes the environment dashboard after. */
  readonly queryBalance: (target: ByokBalanceQueryTarget) => Promise<ByokBalanceResult | null>;
}

export function useByokBalanceDashboards(): ByokBalanceView {
  const environments = useAtomValue(dashboardsAtom);
  const balanceCommand = useAtomCommand(byokEnvironment.balance, { reportFailure: false });

  const queryBalance = useCallback(
    async (target: ByokBalanceQueryTarget): Promise<ByokBalanceResult | null> => {
      const result = await balanceCommand({
        environmentId: target.environmentId,
        input: {
          instanceId: target.instanceId,
          adapterId: target.adapterId,
          forceRefresh: true,
        },
      });
      appAtomRegistry.refresh(
        serverEnvironment.byokBalanceDashboard({ environmentId: target.environmentId, input: {} }),
      );
      return AsyncResult.isSuccess(result) ? (result.value ?? null) : null;
    },
    [balanceCommand],
  );

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.byokBalanceDashboard({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
    }
  }, [environments]);

  const merged = useMemo(
    () =>
      mergeByokDashboards(
        environments.flatMap((environment) =>
          environment.dashboard === null
            ? []
            : [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  dashboard: environment.dashboard,
                },
              ],
        ),
      ),
    [environments],
  );

  const answeredCount = environments.filter((environment) => environment.dashboard !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.dashboard === null && environment.error === null,
  ).length;

  return {
    environments,
    merged,
    isPending: answeredCount === 0 && stillReporting > 0,
    refresh,
    queryBalance,
  };
}
