/**
 * 移动端跨环境第一方订阅额度状态。
 *
 * 与 web 的 state/accountQuota 同构：每个已连接环境回答同一查询，
 * 客户端合并成一份 provider 列表。数据是 CLI 自己推送的限额事件。
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
import { appAtomRegistry } from "./atom-registry";
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
}).pipe(Atom.withLabel("mobile-account-quota:providers"));

export interface AccountQuotaView {
  readonly providers: readonly MergedAccountQuotaProvider[];
  readonly hasData: boolean;
  readonly isPending: boolean;
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
    refresh,
  };
}
