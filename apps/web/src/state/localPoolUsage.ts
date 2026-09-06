/**
 * 本地账号池调用统计的多环境只读状态。
 *
 * 每个已连接环境回答同一个 `server.cliProxy status` 查询；统计是环境本地
 * 的，不需要也不应该跨环境合并——每个服务器只统计自己的账号池。用量页
 * 只展示有活动的环境，未绑定账号池的环境不会出现空卡片。
 *
 * @module state/localPoolUsage
 */
import { useAtomValue } from "@effect/atom-react";
import type { CliProxyAccountUsage, EnvironmentId } from "@codework/contracts";
import { useCallback, useEffect, useState } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface EnvironmentPoolUsageStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly usage: readonly CliProxyAccountUsage[];
}

export interface LocalPoolUsageView {
  readonly environments: readonly EnvironmentPoolUsageStatus[];
  readonly refresh: () => void;
}

export function useLocalPoolUsage(): LocalPoolUsageView {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const command = useAtomCommand(serverEnvironment.cliProxy, { reportFailure: false });
  const [statuses, setStatuses] = useState<readonly EnvironmentPoolUsageStatus[]>([]);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: EnvironmentPoolUsageStatus[] = [];
      for (const [environmentId, presentation] of presentations) {
        const result = await command({ environmentId, input: { action: "status" } });
        if (cancelled) return;
        next.push({
          environmentId,
          label: presentation.entry.target.label,
          isPending: false,
          error: result._tag !== "Success" ? "This environment could not report pool usage." : null,
          usage: result._tag === "Success" ? (result.value?.accountUsage ?? []) : [],
        });
      }
      if (!cancelled) setStatuses(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [command, presentations, attempt]);

  const refresh = useCallback(() => setAttempt((current) => current + 1), []);
  return { environments: statuses, refresh };
}
