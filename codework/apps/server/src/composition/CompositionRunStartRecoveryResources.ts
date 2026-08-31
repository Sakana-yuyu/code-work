import type { CompositionTask, CompositionTaskRun } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import {
  claimCompositionRuntimeLease,
  recoverCompositionRuntimeLease,
} from "./CompositionRuntimeLeaseLifecycle.ts";

export type CompositionRunStartRuntimeLeaseRecovery =
  | { readonly _tag: "Ready"; readonly run: CompositionTaskRun }
  | {
      readonly _tag: "Deferred";
      readonly code: "run_start_runtime_lease_unavailable";
      readonly detail: string;
    };

export const recoverCompositionRunStartRuntimeLease = Effect.fn(
  "recoverCompositionRunStartRuntimeLease",
)(function* (
  store: CompositionTaskStoreShape,
  input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly workspaceRootDigest?: string;
  },
): Effect.fn.Return<CompositionRunStartRuntimeLeaseRecovery, CompositionTaskStoreError> {
  const workspaceRootDigest = input.workspaceRootDigest;
  if (workspaceRootDigest === undefined) return { _tag: "Ready", run: input.run };

  if (input.run.leaseId !== undefined) {
    const existing = yield* store.getLease(input.run.leaseId);
    if (
      Option.isNone(existing) ||
      existing.value.runtimeId !== input.run.runtimeId ||
      existing.value.taskId !== input.task.taskId ||
      existing.value.workspaceRootDigest !== workspaceRootDigest
    ) {
      return {
        _tag: "Deferred",
        code: "run_start_runtime_lease_unavailable",
        detail: "Run 持久化的 workspace lease 身份与本次恢复输入不一致，已阻止自动启动。",
      };
    }
  }

  const nowUnixMs = yield* Clock.currentTimeMillis;
  const recovered =
    input.run.leaseId === undefined
      ? yield* claimCompositionRuntimeLease(store, {
          task: input.task,
          run: input.run,
          workspaceRootDigest,
          nowUnixMs,
        })
      : yield* recoverCompositionRuntimeLease(store, {
          task: input.task,
          run: input.run,
          nowUnixMs,
        });
  if (Option.isNone(recovered)) {
    return {
      _tag: "Deferred",
      code: "run_start_runtime_lease_unavailable",
      detail: "工作区已有其他有效 Runtime lease，Run Start 恢复已延后。",
    };
  }
  return { _tag: "Ready", run: recovered.value };
});
