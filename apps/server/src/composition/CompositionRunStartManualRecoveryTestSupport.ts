import type {
  CompositionRuntimeLease,
  CompositionTask,
  CompositionTaskRun,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { CompositionRunStartIntent } from "../persistence/Services/CompositionRunStartStore.ts";
import type { CompositionTaskRecoveryInput } from "../persistence/Services/CompositionTaskInputStore.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import {
  makeCompositionRunStartDigests,
  type CompositionRunStartReconcileDecision,
} from "./CompositionRunStartLifecycle.ts";
import type { CompositionRunStartManualRecoveryOptions } from "./CompositionRunStartManualRecovery.ts";

export const manualRecoveryExternalTargetIdentity = {
  runtimeKind: "provider",
  providerInstanceId: null,
  adapterId: null,
  modelIdentity: "manual-recovery-model",
  configDigest: null,
  sessionMode: "test",
} as const;

export type ManualRecoveryFixture = {
  readonly task: CompositionTask;
  readonly run: CompositionTaskRun;
  readonly intent: CompositionRunStartIntent;
  readonly recoveryInput: CompositionTaskRecoveryInput;
};

export const acceptedManualRecoveryDecision = (
  intent: CompositionRunStartIntent,
): CompositionRunStartReconcileDecision => ({
  action: "accepted",
  ...(intent.runtimeTaskId === null ? {} : { runtimeTaskId: intent.runtimeTaskId }),
  ...(intent.capabilityHandshakeId === null
    ? {}
    : { capabilityHandshakeId: intent.capabilityHandshakeId }),
});

export const makeManualRecoveryFixture = (
  suffix: string,
  input: {
    readonly taskStatus?: CompositionTask["status"];
    readonly runStatus?: CompositionTaskRun["status"];
    readonly lease?: boolean;
  } = {},
): ManualRecoveryFixture => {
  const task: CompositionTask = {
    taskId: `task-manual-${suffix}`,
    projectId: `project-manual-${suffix}`,
    assigneeKind: "agent",
    assigneeId: `agent-manual-${suffix}`,
    mode: "serial",
    status: input.taskStatus ?? "waiting_input",
    promptDigest: `sha256:prompt-manual-${suffix}`,
    dependsOnTaskIds: [],
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  };
  const run: CompositionTaskRun = {
    runId: `run-manual-${suffix}`,
    taskId: task.taskId,
    agentId: task.assigneeId,
    runtimeId: `runtime-manual-${suffix}`,
    runtimeTaskId: `runtime-task-manual-${suffix}`,
    capabilityHandshakeId: `handshake-manual-${suffix}`,
    status: input.runStatus ?? input.taskStatus ?? "waiting_input",
    attempt: 1,
    capabilityGrantIds: [`grant-manual-${suffix}`],
    ...(input.lease === true ? { leaseId: `lease-manual-${suffix}` } : {}),
  };
  const capabilityIds = ["t3.workspace.read_file"];
  const recoveryInput: CompositionTaskRecoveryInput = {
    taskId: task.taskId,
    prompt: `恢复 ${task.taskId}`,
    workspaceRoot: `C:/workspace/${suffix}`,
    workspaceRootDigest: `sha256:workspace-manual-${suffix}`,
    model: manualRecoveryExternalTargetIdentity.modelIdentity,
    capabilityIds,
  };
  const digests = makeCompositionRunStartDigests({
    taskId: task.taskId,
    projectId: task.projectId,
    runId: run.runId,
    previousRunId: null,
    assigneeKind: task.assigneeKind,
    assigneeId: task.assigneeId,
    mode: task.mode,
    dependsOnTaskIds: task.dependsOnTaskIds,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    promptDigest: task.promptDigest,
    ...(recoveryInput.workspaceRootDigest === undefined
      ? {}
      : { workspaceRootDigest: recoveryInput.workspaceRootDigest }),
    ...(recoveryInput.model === undefined ? {} : { model: recoveryInput.model }),
    externalTargetIdentity: manualRecoveryExternalTargetIdentity,
    capabilityIds,
  });
  const intent: CompositionRunStartIntent = {
    taskId: task.taskId,
    runId: run.runId,
    previousRunId: null,
    agentId: run.agentId,
    runtimeId: run.runtimeId,
    attempt: run.attempt,
    ...digests,
    state: "manual_pending",
    revision: 5,
    claimId: null,
    ownerEpoch: 2,
    ownerLeaseExpiresAtUnixMs: null,
    runtimeTaskId: run.runtimeTaskId ?? null,
    capabilityHandshakeId: run.capabilityHandshakeId ?? null,
    outcomeCode: "run_start_manual_pending",
    outcomeDetail: "等待 receipt-bound 对账。",
    createdAtUnixMs: 1,
    updatedAtUnixMs: 2,
  };
  return { task, run, intent, recoveryInput };
};

export type ManualRecoveryHarnessInput = {
  readonly fixtures: ReadonlyArray<ManualRecoveryFixture>;
  readonly decision?: CompositionRunStartReconcileDecision;
  readonly reconcile?: CompositionAgentDriver["reconcileStart"];
  readonly driverAvailable?: boolean;
  readonly recoveryInput?: CompositionTaskRecoveryInput;
  readonly mutateTask?: (task: CompositionTask) => CompositionTask;
  readonly mutateRun?: (run: CompositionTaskRun) => CompositionTaskRun;
  readonly mutateLatestRun?: (run: CompositionTaskRun) => CompositionTaskRun;
  readonly pageSize?: number;
  readonly now?: () => number;
  readonly driverRuntimeId?: string;
  readonly omitPolicy?: boolean;
  readonly omitReconcile?: boolean;
};

export const makeManualRecoveryHarness = (input: ManualRecoveryHarnessInput) => {
  const intents = new Map(input.fixtures.map((fixture) => [fixture.intent.runId, fixture.intent]));
  const tasks = new Map(
    input.fixtures.map((fixture) => [
      fixture.task.taskId,
      input.mutateTask?.(fixture.task) ?? fixture.task,
    ]),
  );
  const runs = new Map(
    input.fixtures.map((fixture) => [
      fixture.run.runId,
      input.mutateRun?.(fixture.run) ?? fixture.run,
    ]),
  );
  const latestRuns = new Map(
    input.fixtures.map((fixture) => [
      fixture.task.taskId,
      input.mutateLatestRun?.(fixture.run) ?? fixture.run,
    ]),
  );
  const leases = new Map<string, CompositionRuntimeLease>();
  for (const fixture of input.fixtures) {
    if (fixture.run.leaseId === undefined) continue;
    leases.set(fixture.run.leaseId, {
      leaseId: fixture.run.leaseId,
      runtimeId: fixture.run.runtimeId,
      taskId: fixture.task.taskId,
      workspaceRootDigest: fixture.recoveryInput.workspaceRootDigest ?? "sha256:workspace",
      heartbeatAtUnixMs: 0,
      expiresAtUnixMs: 60_000,
      state: "active",
    });
  }
  const calls = {
    upperBound: 0,
    pages: [] as Array<{ readonly after?: string; readonly throughRunId?: string }>,
    claim: 0,
    release: 0,
    resume: 0,
    settle: 0,
    ownerRenew: 0,
    workspaceRenew: 0,
    driverGet: 0,
    reconcile: 0,
    start: 0,
    revoke: 0,
  };
  const sameSnapshot = (
    intent: CompositionRunStartIntent,
    snapshot: {
      readonly runtimeTaskId: string | null;
      readonly capabilityHandshakeId: string | null;
      readonly outcomeCode: string;
      readonly outcomeDetail: string | null;
    },
  ) =>
    intent.runtimeTaskId === snapshot.runtimeTaskId &&
    intent.capabilityHandshakeId === snapshot.capabilityHandshakeId &&
    intent.outcomeCode === snapshot.outcomeCode &&
    intent.outcomeDetail === snapshot.outcomeDetail;

  const runStartStore: CompositionRunStartManualRecoveryOptions["runStartStore"] = {
    getManualRecoveryScanUpperBound: Effect.sync(() => {
      calls.upperBound += 1;
      return Option.fromNullishOr([...intents.keys()].toSorted().at(-1));
    }),
    listManualRecoveries: ({ limit, after, throughRunId }) =>
      Effect.sync(() => {
        calls.pages.push({
          ...(after === undefined ? {} : { after: after.runId }),
          ...(throughRunId === undefined ? {} : { throughRunId }),
        });
        return [...intents.values()]
          .filter(
            (intent) =>
              intent.state === "manual_pending" &&
              (after === undefined || intent.runId > after.runId) &&
              (throughRunId === undefined || intent.runId <= throughRunId),
          )
          .toSorted((left, right) => left.runId.localeCompare(right.runId))
          .slice(0, limit);
      }),
    claimManualRecovery: (claim) =>
      Effect.sync(() => {
        calls.claim += 1;
        const current = intents.get(claim.runId)!;
        const claimable =
          current.state === "manual_pending" &&
          current.revision === claim.expectedRevision &&
          current.ownerEpoch === claim.expectedOwnerEpoch &&
          sameSnapshot(current, claim) &&
          (current.claimId === null ||
            (current.ownerLeaseExpiresAtUnixMs !== null &&
              current.ownerLeaseExpiresAtUnixMs <= claim.claimedAtUnixMs));
        if (!claimable) return { intent: current, claimed: false };
        const claimed: CompositionRunStartIntent = {
          ...current,
          revision: current.revision + 1,
          claimId: claim.claimId,
          ownerEpoch: current.ownerEpoch + 1,
          ownerLeaseExpiresAtUnixMs: claim.leaseExpiresAtUnixMs ?? claim.claimedAtUnixMs + 60_000,
          updatedAtUnixMs: Math.max(current.updatedAtUnixMs, claim.claimedAtUnixMs),
        };
        intents.set(claim.runId, claimed);
        return { intent: claimed, claimed: true };
      }),
    releaseManualRecovery: (release) =>
      Effect.sync(() => {
        calls.release += 1;
        const current = intents.get(release.runId)!;
        if (
          current.state !== "manual_pending" ||
          current.revision !== release.expectedRevision ||
          current.claimId !== release.claimId ||
          current.ownerEpoch !== release.ownerEpoch ||
          current.ownerLeaseExpiresAtUnixMs === null ||
          current.ownerLeaseExpiresAtUnixMs <= release.releasedAtUnixMs ||
          !sameSnapshot(current, release)
        ) {
          throw new Error("manual release owner fence mismatch");
        }
        const released: CompositionRunStartIntent = {
          ...current,
          revision: current.revision + 1,
          claimId: null,
          ownerLeaseExpiresAtUnixMs: null,
          updatedAtUnixMs: Math.max(current.updatedAtUnixMs, release.releasedAtUnixMs),
        };
        intents.set(release.runId, released);
        return released;
      }),
    resumeManualRecoveryToAccepted: (resume) =>
      Effect.sync(() => {
        calls.resume += 1;
        const current = intents.get(resume.runId)!;
        if (
          current.state !== "manual_pending" ||
          current.revision !== resume.expectedRevision ||
          current.claimId !== resume.claimId ||
          current.ownerEpoch !== resume.ownerEpoch ||
          !sameSnapshot(current, resume)
        ) {
          throw new Error("manual resume owner fence mismatch");
        }
        const resumed: CompositionRunStartIntent = {
          ...current,
          state: "accepted",
          revision: current.revision + 1,
          claimId: null,
          ownerLeaseExpiresAtUnixMs: null,
          outcomeCode: null,
          outcomeDetail: null,
          updatedAtUnixMs: Math.max(current.updatedAtUnixMs, resume.resumedAtUnixMs),
        };
        intents.set(resume.runId, resumed);
        return resumed;
      }),
    settleManualRecovery: (settle) =>
      Effect.sync(() => {
        calls.settle += 1;
        const current = intents.get(settle.runId)!;
        if (
          current.state !== "manual_pending" ||
          current.revision !== settle.expectedRevision ||
          current.claimId !== settle.claimId ||
          current.ownerEpoch !== settle.ownerEpoch ||
          !sameSnapshot(current, settle)
        ) {
          throw new Error("manual settle owner fence mismatch");
        }
        const settled: CompositionRunStartIntent = {
          ...current,
          state: "settled",
          revision: current.revision + 1,
          ownerLeaseExpiresAtUnixMs: null,
          updatedAtUnixMs: Math.max(current.updatedAtUnixMs, settle.settledAtUnixMs),
        };
        intents.set(settle.runId, settled);
        return settled;
      }),
    renewOwnerLease: (renew) =>
      Effect.sync(() => {
        calls.ownerRenew += 1;
        const current = intents.get(renew.runId)!;
        if (
          current.revision !== renew.expectedRevision ||
          current.claimId !== renew.claimId ||
          current.ownerEpoch !== renew.ownerEpoch ||
          current.ownerLeaseExpiresAtUnixMs === null ||
          current.ownerLeaseExpiresAtUnixMs <= renew.renewedAtUnixMs
        ) {
          throw new Error("manual owner lease fence mismatch");
        }
        const renewed = {
          ...current,
          ownerLeaseExpiresAtUnixMs: renew.leaseExpiresAtUnixMs,
          updatedAtUnixMs: Math.max(current.updatedAtUnixMs, renew.renewedAtUnixMs),
        };
        intents.set(renew.runId, renewed);
        return renewed;
      }),
  };

  const taskStore: CompositionRunStartManualRecoveryOptions["taskStore"] = {
    getTask: (taskId) => Effect.succeed(Option.fromNullishOr(tasks.get(taskId))),
    getRun: (runId) => Effect.succeed(Option.fromNullishOr(runs.get(runId))),
    getLatestRun: (taskId) => Effect.succeed(Option.fromNullishOr(latestRuns.get(taskId))),
    renewLease: (renew) =>
      Effect.sync(() => {
        calls.workspaceRenew += 1;
        const current = leases.get(renew.leaseId);
        if (
          current === undefined ||
          current.runtimeId !== renew.runtimeId ||
          current.state !== "active" ||
          current.expiresAtUnixMs <= renew.nowUnixMs
        ) {
          return Option.none<CompositionRuntimeLease>();
        }
        const renewed: CompositionRuntimeLease = {
          ...current,
          heartbeatAtUnixMs: renew.heartbeatAtUnixMs,
          expiresAtUnixMs: renew.expiresAtUnixMs,
        };
        leases.set(renew.leaseId, renewed);
        return Option.some(renewed);
      }),
  };

  const driver: CompositionAgentDriver = {
    agentId: input.fixtures[0]!.intent.agentId,
    runtimeId: input.driverRuntimeId ?? input.fixtures[0]!.intent.runtimeId,
    ...(input.omitPolicy
      ? {}
      : {
          startRecoveryPolicy: {
            mode: "reconcile-only" as const,
            requiredReceipt: "runtime-task" as const,
          },
        }),
    getStartIdentity: () => manualRecoveryExternalTargetIdentity,
    ...(input.omitReconcile
      ? {}
      : {
          reconcileStart:
            input.reconcile ??
            (() => {
              calls.reconcile += 1;
              return Effect.succeed(
                input.decision ?? acceptedManualRecoveryDecision(input.fixtures[0]!.intent),
              );
            }),
        }),
    startTask: () =>
      Effect.sync(() => {
        calls.start += 1;
        return {};
      }),
    revokeCapabilityHandshake: () =>
      Effect.sync(() => {
        calls.revoke += 1;
      }),
    cancelTask: () => Effect.succeed({ status: "cancelled" as const }),
  };

  const options: CompositionRunStartManualRecoveryOptions = {
    runStartStore,
    taskStore,
    inputStore: {
      get: (taskId) =>
        Effect.succeed(
          Option.fromNullishOr(
            input.recoveryInput ??
              input.fixtures.find((fixture) => fixture.task.taskId === taskId)?.recoveryInput,
          ),
        ),
    },
    driverRegistry: {
      get: () =>
        Effect.sync(() => {
          calls.driverGet += 1;
          return input.driverAvailable === false ? undefined : driver;
        }),
    },
    reconciled: new Set(["provider-sessions"]),
    makeClaimId: (intent) => `manual-worker:${intent.runId}`,
    ...(input.now === undefined ? { now: Effect.succeed(100) } : { now: Effect.sync(input.now) }),
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
  };
  return { options, calls, intents, leases, driver };
};
