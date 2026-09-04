import { scopeThreadRef } from "@codework/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@codework/contracts";
import type { EnvironmentThread } from "@codework/client-runtime/state/models";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadDetails } from "../../state/threads";

/** 等待服务端回退事件进入移动端线程投影，避免在工作区尚未恢复时发送新消息。 */
export async function waitForThreadRewound(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly targetTurnCount: number;
  readonly startedAt: string;
  readonly timeoutMs?: number;
}): Promise<"rewound" | "failed" | "timeout"> {
  const threadAtom = environmentThreadDetails.detailAtom(
    scopeThreadRef(input.environmentId, input.threadId),
  );
  const hasRewound = (thread: EnvironmentThread | null) =>
    (thread?.checkpoints ?? []).reduce(
      (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
      0,
    ) <= input.targetTurnCount;
  const hasFailure = (thread: EnvironmentThread | null) =>
    (thread?.activities ?? []).some(
      (activity) =>
        activity.kind === "checkpoint.revert.failed" && activity.createdAt >= input.startedAt,
    );

  return await new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;
    const finish = (result: "rewound" | "failed" | "timeout") => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe?.();
      resolve(result);
    };
    const inspect = (thread: EnvironmentThread | null) => {
      if (hasFailure(thread)) {
        finish("failed");
      } else if (hasRewound(thread)) {
        finish("rewound");
      }
    };

    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    inspect(appAtomRegistry.get(threadAtom));
    if (!settled) {
      timeoutId = globalThis.setTimeout(() => finish("timeout"), input.timeoutMs ?? 30_000);
    }
  });
}
