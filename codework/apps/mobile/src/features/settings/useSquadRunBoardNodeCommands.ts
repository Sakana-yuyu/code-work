import {
  buildCompositionSquadRetryRequest,
  buildCompositionSquadReviewRequest,
  executeCompositionSquadNodeCommandWithRefresh,
  type CompositionSquadReviewAction,
  type CompositionSquadRunBoardNode,
  type CompositionSquadRunBoardRefreshers,
} from "@codework/client-runtime/composition/squad-run-board";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@codework/client-runtime/state/runtime";
import type { EnvironmentId } from "@codework/contracts";
import { useRef, useState } from "react";

import { t } from "../../i18n";
import { uuidv4 } from "../../lib/uuid";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export interface SquadRunBoardNodeCommandError {
  readonly taskId: string;
  readonly message: string;
}

export interface SquadRunBoardNodeCommands {
  readonly pendingTaskId: string | null;
  readonly error: SquadRunBoardNodeCommandError | null;
  readonly retryNode: (
    node: CompositionSquadRunBoardNode,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ) => Promise<void>;
  readonly reviewNode: (
    node: CompositionSquadRunBoardNode,
    decision: CompositionSquadReviewAction,
  ) => Promise<void>;
}

/** 管理 Run Board 节点命令的单飞、错误归属和成功刷新，不承担展示职责。 */
export function useSquadRunBoardNodeCommands(input: {
  readonly environmentId: EnvironmentId | null;
  readonly refreshers: CompositionSquadRunBoardRefreshers;
}): SquadRunBoardNodeCommands {
  const retryCompositionTask = useAtomCommand(serverEnvironment.retryCompositionTask, {
    reportFailure: false,
  });
  const reviewCompositionTask = useAtomCommand(serverEnvironment.reviewCompositionTask, {
    reportFailure: false,
  });
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const pendingTaskIdRef = useRef<string | null>(null);
  const [error, setError] = useState<SquadRunBoardNodeCommandError | null>(null);

  const executeNodeCommand = async (
    taskId: string,
    fallbackErrorKey: string,
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
  ): Promise<void> => {
    if (input.environmentId === null || pendingTaskIdRef.current !== null) return;
    pendingTaskIdRef.current = taskId;
    setPendingTaskId(taskId);
    setError(null);
    try {
      const result = await executeCompositionSquadNodeCommandWithRefresh(execute, input.refreshers);
      if (result._tag === "Success") return;
      const failure = squashAtomCommandFailure(result);
      setError({
        taskId,
        message: failure instanceof Error ? failure.message : t(fallbackErrorKey),
      });
    } catch (failure) {
      setError({
        taskId,
        message: failure instanceof Error ? failure.message : t(fallbackErrorKey),
      });
    } finally {
      pendingTaskIdRef.current = null;
      setPendingTaskId(null);
    }
  };

  const retryNode = async (
    node: CompositionSquadRunBoardNode,
    capabilityIds: ReadonlyArray<string>,
    reassignAgentId?: string,
  ): Promise<void> => {
    const reassigning = reassignAgentId !== undefined;
    const request = buildCompositionSquadRetryRequest({
      node,
      capabilityIds,
      nextRunId: `mobile-squad-${reassigning ? "reassign" : "retry"}-${uuidv4()}`,
      reason: t(
        reassigning
          ? "squadExecutionHistory.reassignReasonDefault"
          : "squadExecutionHistory.retryReasonDefault",
      ),
      ...(reassignAgentId === undefined ? {} : { reassignAgentId }),
    });
    if (request === null || input.environmentId === null) return;
    await executeNodeCommand(node.taskId, "squadExecutionHistory.retryFailed", () =>
      retryCompositionTask({ environmentId: input.environmentId!, input: request }),
    );
  };

  const reviewNode = async (
    node: CompositionSquadRunBoardNode,
    decision: CompositionSquadReviewAction,
  ): Promise<void> => {
    const request = buildCompositionSquadReviewRequest({
      node,
      decision,
      reason: t(
        decision === "approve"
          ? "squadExecutionHistory.approveReasonDefault"
          : "squadExecutionHistory.rejectReasonDefault",
      ),
    });
    if (request === null || input.environmentId === null) return;
    await executeNodeCommand(node.taskId, "squadExecutionHistory.reviewFailed", () =>
      reviewCompositionTask({ environmentId: input.environmentId!, input: request }),
    );
  };

  return { pendingTaskId, error, retryNode, reviewNode };
}
