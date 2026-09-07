/**
 * Multi-environment first-party account quota state.
 *
 * Every connected environment answers the same typed query; the client merges
 * the reports into one provider list. The data is exactly what the provider
 * CLIs pushed while threads ran — no credentials involved.
 *
 * @module state/accountQuota
 */
import { useAtomValue } from "@effect/atom-react";
import type { AccountQuotaResult, EnvironmentId } from "@codework/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import {
  mergeAccountQuota,
  type MergedAccountQuotaProvider,
} from "@codework/shared/accountQuotaMerge";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentAccountQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly result: AccountQuotaResult | null;
}

const quotaAtom = Atom.make((get): readonly EnvironmentAccountQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentAccountQuotaStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.accountQuota({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report quota." : null,
      result: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-account-quota:providers"));

export interface AccountQuotaView {
  readonly providers: readonly MergedAccountQuotaProvider[];
  /** True once at least one provider reported any window. */
  readonly hasData: boolean;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly environmentsCount: number;
  readonly refresh: () => void;
}

export function useAccountQuota(): AccountQuotaView {
  const environments = useAtomValue(quotaAtom);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.accountQuota({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const providers = useMemo(
    () =>
      mergeAccountQuota(
        environments.flatMap((environment) =>
          environment.result === null
            ? []
            : [
                {
                  environmentId: environment.environmentId,
                  label: environment.label,
                  result: environment.result,
                },
              ],
        ),
      ),
    [environments],
  );

  const answeredCount = environments.filter((environment) => environment.result !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.result === null && environment.error === null,
  ).length;

  return {
    providers,
    hasData: providers.length > 0,
    isPending: answeredCount === 0 && stillReporting > 0,
    environmentsCount: environments.length,
    refresh,
  };
}
