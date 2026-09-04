/**
 * 移动端跨环境 BYOK 余额状态。
 *
 * 余额凭据始终由持有它的服务端查询，手机只接收脱敏后的结果。
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
import { appAtomRegistry } from "./atom-registry";
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
}).pipe(Atom.withLabel("mobile-byok-balance:dashboards"));

export interface ByokBalanceQueryTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string;
  readonly adapterId: string;
}

export interface ByokBalanceView {
  readonly environments: readonly EnvironmentByokBalanceStatus[];
  readonly merged: MergedByokPlans;
  readonly isPending: boolean;
  readonly refresh: () => void;
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
