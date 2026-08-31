import type {
  CompositionCapabilityGrant,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionTaskStoreShape } from "../persistence/Services/CompositionTaskStore.ts";
import * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import * as CapabilityRegistry from "./CapabilityRegistry.ts";
import { COMPOSITION_RUN_START_OWNER_LEASE_MS } from "./CompositionRunStartOwnerLease.ts";

export const COMPOSITION_RUN_START_RECOVERY_GRANT_MINIMUM_REMAINING_MS =
  COMPOSITION_RUN_START_OWNER_LEASE_MS * 2;

export type CompositionRunStartCapabilityRecoveryPurpose = "start" | "replay" | "accepted";

export type CompositionRunStartCapabilityRecoveryResult =
  | {
      readonly _tag: "Ready";
      readonly run: CompositionTaskRun;
      readonly changed: boolean;
    }
  | {
      readonly _tag: "Deferred" | "Manual" | "Quarantine";
      readonly code: string;
      readonly detail: string;
    };

export type CompositionRunStartCapabilityRecoveryOptions = {
  readonly taskStore: Pick<
    CompositionTaskStoreShape,
    "withTransaction" | "compareAndSetRunStartResources"
  >;
  readonly grantRegistry?: Pick<
    CapabilityGrantRegistry.CapabilityGrantRegistryShape,
    "issue" | "validateForRecovery"
  >;
};

export type CompositionRunStartCapabilityRecoveryInput = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly purpose: CompositionRunStartCapabilityRecoveryPurpose;
  readonly nowUnixMs: number;
  readonly allowReplayGrantReplacement?: boolean;
};

type NotReadyResult = Exclude<
  CompositionRunStartCapabilityRecoveryResult,
  { readonly _tag: "Ready" }
>;

class CompositionRunStartCapabilityDecision extends Data.TaggedError(
  "CompositionRunStartCapabilityDecision",
)<{
  readonly outcome: NotReadyResult;
}> {}

const outcome = (tag: NotReadyResult["_tag"], code: string, detail: string): NotReadyResult => ({
  _tag: tag,
  code,
  detail,
});

const decide = (
  result: NotReadyResult,
): Effect.Effect<never, CompositionRunStartCapabilityDecision> =>
  Effect.fail(new CompositionRunStartCapabilityDecision({ outcome: result }));

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const validateFailureDecision = (
  error:
    | CapabilityGrantRegistry.CapabilityGrantNotFoundError
    | CapabilityGrantRegistry.CapabilityGrantScopeMismatchError
    | CapabilityGrantRegistry.CapabilityGrantExpiredError
    | CapabilityGrantRegistry.CapabilityGrantRevokedError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
    | CapabilityRegistry.CapabilityNotAvailableError,
  purpose: CompositionRunStartCapabilityRecoveryPurpose,
): "replace" | NotReadyResult => {
  switch (error._tag) {
    case "CapabilityRegistryUnavailableError":
    case "CapabilityGrantPersistenceError":
      return outcome(
        "Deferred",
        "run_start_capability_registry_unavailable",
        "Capability Grant 状态暂时无法读取，Run Start 恢复已延后。",
      );
    case "CapabilityScopeNotFoundError":
      return outcome(
        "Quarantine",
        "run_start_capability_scope_missing",
        "持久 Run Start 对应的 Task capability scope 已不存在，已阻止自动恢复。",
      );
    case "CapabilityNotAvailableError":
      return outcome(
        "Manual",
        "run_start_capability_unavailable",
        "Run Start 所需 capability 已移除或不可用，需要人工核对。",
      );
    case "CapabilityGrantScopeMismatchError":
      return outcome(
        "Quarantine",
        "run_start_capability_grant_scope_mismatch",
        "持久 Capability Grant 与 Task、Agent 或 capability 作用域不一致，已阻止自动恢复。",
      );
    case "CapabilityGrantNotFoundError":
    case "CapabilityGrantExpiredError":
    case "CapabilityGrantRevokedError":
      return purpose === "accepted"
        ? outcome(
            "Manual",
            "run_start_accepted_capability_rebind_required",
            "外部任务已接受，但原 Capability Grant 已缺失、过期或撤销；当前 Driver 不支持安全 rebind。",
          )
        : "replace";
  }
};

const issueFailureDecision = (
  error:
    | CapabilityGrantRegistry.CapabilityGrantInvalidError
    | CapabilityRegistry.CapabilityScopeNotFoundError
    | CapabilityRegistry.CapabilityRegistryUnavailableError
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError,
): NotReadyResult => {
  switch (error._tag) {
    case "CapabilityRegistryUnavailableError":
    case "CapabilityGrantPersistenceError":
      return outcome(
        "Deferred",
        "run_start_capability_registry_unavailable",
        "Capability Registry 暂时不可用，Run Start 恢复已延后。",
      );
    case "CapabilityScopeNotFoundError":
      return outcome(
        "Quarantine",
        "run_start_capability_scope_missing",
        "持久 Run Start 对应的 Task capability scope 已不存在，已阻止自动恢复。",
      );
    case "CapabilityGrantInvalidError":
      return outcome(
        "Manual",
        "run_start_capability_unavailable",
        "Run Start 所需 capability 已移除或不可用，需要人工核对。",
      );
  }
};

const validateIssuedGrants = (input: {
  readonly grants: ReadonlyArray<CompositionCapabilityGrant>;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly taskId: string;
  readonly agentId: string;
  readonly nowUnixMs: number;
}): boolean =>
  input.grants.length === input.capabilityIds.length &&
  input.grants.every(
    (grant, index) =>
      grant.taskId === input.taskId &&
      grant.agentId === input.agentId &&
      grant.capabilityId === input.capabilityIds[index] &&
      grant.revokedAtUnixMs === undefined &&
      grant.expiresAtUnixMs >
        input.nowUnixMs + COMPOSITION_RUN_START_RECOVERY_GRANT_MINIMUM_REMAINING_MS,
  );

export const validateCompositionRunStartAcceptedCapabilities = Effect.fn(
  "validateCompositionRunStartAcceptedCapabilities",
)(function* (input: {
  readonly grantRegistry?: Pick<
    CapabilityGrantRegistry.CapabilityGrantRegistryShape,
    "validateForRecovery"
  >;
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly capabilityIds: ReadonlyArray<string>;
  readonly nowUnixMs: number;
}): Effect.fn.Return<CompositionRunStartCapabilityRecoveryResult> {
  const capabilityIds = input.capabilityIds.map((capabilityId) => capabilityId.trim());
  if (
    capabilityIds.some((capabilityId) => capabilityId.length === 0) ||
    new Set(capabilityIds).size !== capabilityIds.length
  ) {
    return outcome(
      "Quarantine",
      "run_start_capability_identity_invalid",
      "持久 Run Start capabilityIds 包含空值或重复项，已阻止自动恢复。",
    );
  }

  const persistedGrantIds = [...(input.run.capabilityGrantIds ?? [])];
  if (persistedGrantIds.some((grantId) => capabilityIds.includes(grantId))) {
    return outcome(
      "Quarantine",
      "run_start_legacy_capability_grant_unsafe",
      "历史 Run 将 capabilityId 直接保存为 grantId，会绕过 TTL 与撤销校验，已阻止自动恢复。",
    );
  }
  if (persistedGrantIds.length !== capabilityIds.length) {
    return outcome(
      "Manual",
      "run_start_accepted_capability_rebind_required",
      "外部任务已接受，但持久 Capability Grant 数量与恢复输入不一致；当前 Driver 不支持安全 rebind。",
    );
  }
  if (capabilityIds.length === 0) {
    return { _tag: "Ready", run: input.run, changed: false };
  }

  const grantRegistry = input.grantRegistry;
  if (grantRegistry === undefined) {
    return outcome(
      "Deferred",
      "run_start_capability_registry_unavailable",
      "当前 Runtime 未提供 Capability Grant Registry，Run Start 恢复已延后。",
    );
  }

  for (let index = 0; index < capabilityIds.length; index += 1) {
    const capabilityId = capabilityIds[index];
    const grantId = persistedGrantIds[index];
    if (capabilityId === undefined || grantId === undefined) {
      return outcome(
        "Manual",
        "run_start_accepted_capability_rebind_required",
        "外部任务已接受，但持久 Capability Grant 顺序无法稳定解析。",
      );
    }
    const validation = yield* grantRegistry
      .validateForRecovery({
        grantId,
        taskId: input.task.taskId,
        agentId: input.run.agentId,
        capabilityId,
      })
      .pipe(
        Effect.match({
          onFailure: (error) => ({ _tag: "Failure" as const, error }),
          onSuccess: (grant) => ({ _tag: "Success" as const, grant }),
        }),
      );
    if (validation._tag === "Failure") {
      const decision = validateFailureDecision(validation.error, "accepted");
      return decision === "replace"
        ? outcome(
            "Manual",
            "run_start_accepted_capability_rebind_required",
            "外部任务已接受，但 Capability Grant 需要替换；当前 Driver 不支持安全 rebind。",
          )
        : decision;
    }
    if (
      validation.grant.expiresAtUnixMs <=
      input.nowUnixMs + COMPOSITION_RUN_START_RECOVERY_GRANT_MINIMUM_REMAINING_MS
    ) {
      return outcome(
        "Manual",
        "run_start_accepted_capability_rebind_required",
        "外部任务已接受，但原 Capability Grant 剩余有效期不足；当前 Driver 不支持安全 rebind。",
      );
    }
  }

  return { _tag: "Ready", run: input.run, changed: false };
});

export const recoverCompositionRunStartCapabilities = Effect.fn(
  "recoverCompositionRunStartCapabilities",
)(function* (
  options: CompositionRunStartCapabilityRecoveryOptions,
  input: CompositionRunStartCapabilityRecoveryInput,
): Effect.fn.Return<CompositionRunStartCapabilityRecoveryResult> {
  const capabilityIds = input.capabilityIds.map((capabilityId) => capabilityId.trim());
  if (
    capabilityIds.some((capabilityId) => capabilityId.length === 0) ||
    new Set(capabilityIds).size !== capabilityIds.length
  ) {
    return outcome(
      "Quarantine",
      "run_start_capability_identity_invalid",
      "持久 Run Start capabilityIds 包含空值或重复项，已阻止自动恢复。",
    );
  }

  const persistedGrantIds = [...(input.run.capabilityGrantIds ?? [])];
  if (persistedGrantIds.some((grantId) => capabilityIds.includes(grantId))) {
    return outcome(
      "Quarantine",
      "run_start_legacy_capability_grant_unsafe",
      "历史 Run 将 capabilityId 直接保存为 grantId，会绕过 TTL 与撤销校验，已阻止自动恢复。",
    );
  }
  if (persistedGrantIds.length > capabilityIds.length) {
    return outcome(
      "Quarantine",
      "run_start_capability_grant_count_mismatch",
      "持久 Run 包含超出恢复输入的 Capability Grant，已阻止权限扩张。",
    );
  }
  if (capabilityIds.length === 0) {
    return persistedGrantIds.length === 0
      ? { _tag: "Ready", run: input.run, changed: false }
      : outcome(
          "Quarantine",
          "run_start_capability_grant_count_mismatch",
          "无 capability 的 Run 不应持有 Capability Grant，已阻止自动恢复。",
        );
  }

  const grantRegistry = options.grantRegistry;
  if (grantRegistry === undefined) {
    return outcome(
      "Deferred",
      "run_start_capability_registry_unavailable",
      "当前 Runtime 未提供 Capability Grant Registry，Run Start 恢复已延后。",
    );
  }

  if (input.purpose === "accepted") {
    return yield* validateCompositionRunStartAcceptedCapabilities({
      grantRegistry,
      task: input.task,
      run: input.run,
      capabilityIds,
      nowUnixMs: input.nowUnixMs,
    });
  }

  const recovered = options.taskStore.withTransaction(
    Effect.gen(function* () {
      const nextGrantIds = [...persistedGrantIds];
      const replacementIndexes: number[] = [];
      for (let index = 0; index < capabilityIds.length; index += 1) {
        const capabilityId = capabilityIds[index];
        const grantId = persistedGrantIds[index];
        if (capabilityId === undefined) {
          return yield* decide(
            outcome(
              "Quarantine",
              "run_start_capability_identity_invalid",
              "持久 Run Start capability 顺序无法稳定解析。",
            ),
          );
        }
        if (grantId === undefined) {
          replacementIndexes.push(index);
          continue;
        }

        const validation = yield* grantRegistry
          .validateForRecovery({
            grantId,
            taskId: input.task.taskId,
            agentId: input.run.agentId,
            capabilityId,
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Failure" as const, error }),
              onSuccess: (grant) => ({ _tag: "Success" as const, grant }),
            }),
          );
        if (validation._tag === "Failure") {
          const decision = validateFailureDecision(validation.error, input.purpose);
          if (decision !== "replace") return yield* decide(decision);
          replacementIndexes.push(index);
          continue;
        }
        if (
          validation.grant.expiresAtUnixMs <=
          input.nowUnixMs + COMPOSITION_RUN_START_RECOVERY_GRANT_MINIMUM_REMAINING_MS
        ) {
          replacementIndexes.push(index);
        }
      }

      if (replacementIndexes.length === 0) {
        return { _tag: "Ready", run: input.run, changed: false } as const;
      }
      if (input.purpose === "replay" && input.allowReplayGrantReplacement !== true) {
        return yield* decide(
          outcome(
            "Manual",
            "run_start_replay_capability_rebind_required",
            "dispatching Run Start 需要替换 Capability Grant，但 Driver 未声明 verified replay。",
          ),
        );
      }

      const replacementCapabilityIds = replacementIndexes.map((index) => capabilityIds[index]!);
      const issued = yield* grantRegistry
        .issue({
          taskId: input.task.taskId,
          agentId: input.run.agentId,
          capabilityIds: replacementCapabilityIds,
          minimumRemainingMs: COMPOSITION_RUN_START_RECOVERY_GRANT_MINIMUM_REMAINING_MS,
        })
        .pipe(
          Effect.match({
            onFailure: (error) => ({ _tag: "Failure" as const, error }),
            onSuccess: (grants) => ({ _tag: "Success" as const, grants }),
          }),
        );
      if (issued._tag === "Failure") return yield* decide(issueFailureDecision(issued.error));
      if (
        !validateIssuedGrants({
          grants: issued.grants,
          capabilityIds: replacementCapabilityIds,
          taskId: input.task.taskId,
          agentId: input.run.agentId,
          nowUnixMs: input.nowUnixMs,
        })
      ) {
        return yield* decide(
          outcome(
            "Quarantine",
            "run_start_capability_issue_contract_invalid",
            "Capability Registry 返回的替代 grant 与请求作用域不一致。",
          ),
        );
      }
      replacementIndexes.forEach((index, replacementIndex) => {
        nextGrantIds[index] = issued.grants[replacementIndex]!.grantId;
      });

      const updated = yield* options.taskStore.compareAndSetRunStartResources({
        task: input.task,
        run: input.run,
        nextLeaseId: input.run.leaseId ?? null,
        nextCapabilityGrantIds: nextGrantIds,
      });
      if (Option.isNone(updated)) {
        return yield* decide(
          outcome(
            "Quarantine",
            "run_start_capability_projection_conflict",
            "Capability Grant 恢复时 Task/Run 已变化，已阻止旧快照覆盖当前状态。",
          ),
        );
      }
      return {
        _tag: "Ready",
        run: updated.value,
        changed: !sameStrings(persistedGrantIds, nextGrantIds),
      } as const;
    }),
  );

  return yield* recovered.pipe(
    Effect.catchTag("CompositionRunStartCapabilityDecision", (decision) =>
      Effect.succeed(decision.outcome),
    ),
    Effect.catch(() =>
      Effect.succeed(
        outcome(
          "Deferred",
          "run_start_capability_persistence_unavailable",
          "Capability Grant 恢复事务暂时失败，Run Start 恢复已延后。",
        ),
      ),
    ),
  );
});
