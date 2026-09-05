import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  SpecWorkflowCapability,
  SpecWorkflowEvent,
  SpecWorkflowIntentName,
  SpecWorkflowState,
  SpecWorkflowStateEvent,
} from "@codework/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { createEnvironmentSpecWorkflowAtoms } from "@codework/client-runtime/state/spec-workflow";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

export const specWorkflowEnvironment = createEnvironmentSpecWorkflowAtoms(connectionAtomRuntime);

const EMPTY_CAPABILITY_RESULT_ATOM = Atom.make(
  AsyncResult.initial<SpecWorkflowCapability, never>(false),
).pipe(Atom.withLabel("web-spec-workflow:empty"));
const EMPTY_CAPABILITY_EVENT_ATOM = Atom.make(
  AsyncResult.initial<SpecWorkflowEvent, never>(false),
).pipe(Atom.withLabel("web-spec-workflow-events:empty"));
const EMPTY_STATE_RESULT_ATOM = Atom.make(
  AsyncResult.success<SpecWorkflowState | null, never>(null),
).pipe(Atom.withLabel("web-spec-workflow-state:empty"));
const EMPTY_STATE_EVENT_ATOM = Atom.make(
  AsyncResult.initial<SpecWorkflowStateEvent, never>(false),
).pipe(Atom.withLabel("web-spec-workflow-state-events:empty"));

function resolveCapabilitySnapshot(
  queryCapability: SpecWorkflowCapability | null,
  eventCapability: SpecWorkflowCapability | null,
): SpecWorkflowCapability | null {
  return eventCapability !== null && eventCapability.revision >= (queryCapability?.revision ?? 0)
    ? eventCapability
    : queryCapability;
}

function resolveStateSnapshot(
  queryState: SpecWorkflowState | null,
  event: SpecWorkflowStateEvent | null,
): SpecWorkflowState | null {
  return event === null ? queryState : event.state;
}

export interface SpecWorkflowCapabilityState {
  readonly capability: SpecWorkflowCapability | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly refresh: () => void;
}

export function useSpecWorkflowCapability(
  threadRef: ScopedThreadRef | null,
): SpecWorkflowCapabilityState {
  const target =
    threadRef === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        };
  const capabilityAtom =
    target === null ? EMPTY_CAPABILITY_RESULT_ATOM : specWorkflowEnvironment.get(target);
  const eventAtom =
    target === null ? EMPTY_CAPABILITY_EVENT_ATOM : specWorkflowEnvironment.events(target);
  const capabilityResult = useAtomValue(capabilityAtom);
  const eventResult = useAtomValue(eventAtom);
  const refresh = useAtomRefresh(capabilityAtom);
  const queryCapability = Option.getOrNull(AsyncResult.value(capabilityResult));
  const event = Option.getOrNull(AsyncResult.value(eventResult));
  const eventCapability = event?.type === "updated" ? event.capability : null;

  return {
    capability: resolveCapabilitySnapshot(queryCapability, eventCapability),
    isPending: target !== null && capabilityResult.waiting,
    hasError: capabilityResult._tag === "Failure",
    refresh,
  };
}

export interface SpecWorkflowStateView {
  readonly state: SpecWorkflowState | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly refresh: () => void;
}

export function useSpecWorkflowState(threadRef: ScopedThreadRef | null): SpecWorkflowStateView {
  const target =
    threadRef === null
      ? null
      : {
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        };
  const stateAtom =
    target === null ? EMPTY_STATE_RESULT_ATOM : specWorkflowEnvironment.state(target);
  const eventAtom =
    target === null ? EMPTY_STATE_EVENT_ATOM : specWorkflowEnvironment.stateEvents(target);
  const stateResult = useAtomValue(stateAtom);
  const eventResult = useAtomValue(eventAtom);
  const refresh = useAtomRefresh(stateAtom);
  const queryState = Option.getOrNull(AsyncResult.value(stateResult));
  const event = Option.getOrNull(AsyncResult.value(eventResult));

  return {
    state: resolveStateSnapshot(queryState, event),
    isPending: target !== null && stateResult.waiting,
    hasError: stateResult._tag === "Failure",
    refresh,
  };
}

export interface SpecWorkflowCapabilityController extends SpecWorkflowCapabilityState {
  readonly enabled: boolean;
  readonly toggle: () => Promise<boolean>;
  readonly selectIntent: (intent: SpecWorkflowIntentName) => Promise<boolean>;
  readonly workflowState: SpecWorkflowState | null;
  readonly workflowStateIsPending: boolean;
  readonly workflowStateHasError: boolean;
  readonly approveProposal: () => Promise<boolean>;
  readonly rejectProposal: () => Promise<boolean>;
  readonly completeAcceptance: () => Promise<boolean>;
  readonly pause: () => Promise<boolean>;
  readonly resume: () => Promise<boolean>;
}

/** 只在 Composer 明确点击开关后写入 capability；普通消息不会触发该命令。 */
export function useSpecWorkflowController(
  threadRef: ScopedThreadRef | null,
): SpecWorkflowCapabilityController {
  const state = useSpecWorkflowCapability(threadRef);
  const workflowState = useSpecWorkflowState(state.capability?.enabled === true ? threadRef : null);
  const setCommand = useAtomCommand(specWorkflowEnvironment.set, { reportFailure: false });
  const reviewProposalCommand = useAtomCommand(specWorkflowEnvironment.reviewProposal, {
    reportFailure: false,
  });
  const completeAcceptanceCommand = useAtomCommand(specWorkflowEnvironment.completeAcceptance, {
    reportFailure: false,
  });
  const pauseCommand = useAtomCommand(specWorkflowEnvironment.pause, { reportFailure: false });
  const resumeCommand = useAtomCommand(specWorkflowEnvironment.resume, { reportFailure: false });
  const [isMutating, setIsMutating] = useState(false);
  const threadId = threadRef?.threadId ?? null;
  const environmentId = threadRef?.environmentId ?? null;
  const capability = state.capability;
  const refresh = state.refresh;
  const currentWorkflowState = workflowState.state;
  const refreshWorkflowState = workflowState.refresh;

  const updateCapability = useCallback(
    async (enabled: boolean, selectedIntent?: SpecWorkflowIntentName) => {
      if (threadId === null || environmentId === null || capability === null || isMutating) {
        return false;
      }
      setIsMutating(true);
      try {
        const result = await setCommand({
          environmentId,
          input: {
            threadId,
            enabled,
            ...(selectedIntent === undefined ? {} : { selectedIntent }),
            expectedRevision: capability.revision,
          },
        });
        if (result._tag !== "Success") return false;
        refresh();
        return true;
      } finally {
        setIsMutating(false);
      }
    },
    [capability, environmentId, isMutating, refresh, setCommand, threadId],
  );

  const toggle = useCallback(
    () => updateCapability(!(capability?.enabled ?? false)),
    [capability?.enabled, updateCapability],
  );
  const selectIntent = useCallback(
    (intent: SpecWorkflowIntentName) => updateCapability(true, intent),
    [updateCapability],
  );

  const runWorkflowCommand = useCallback(
    async (action: "approve" | "reject" | "completeAcceptance" | "pause" | "resume") => {
      if (
        threadId === null ||
        environmentId === null ||
        capability?.enabled !== true ||
        currentWorkflowState === null ||
        isMutating
      ) {
        return false;
      }
      if (
        (action === "approve" || action === "reject") &&
        (currentWorkflowState.stage !== "awaitingApproval" ||
          currentWorkflowState.proposalStatus !== "pending")
      ) {
        return false;
      }
      if (
        action === "completeAcceptance" &&
        (currentWorkflowState.status !== "active" ||
          currentWorkflowState.stage !== "acceptance" ||
          currentWorkflowState.acceptanceStatus !== "pending")
      ) {
        return false;
      }
      if (action === "pause" && currentWorkflowState.status !== "active") return false;
      if (action === "resume" && currentWorkflowState.status !== "paused") return false;

      setIsMutating(true);
      try {
        const input = {
          environmentId,
          input: { threadId, expectedRevision: currentWorkflowState.revision },
        };
        const result =
          action === "approve" || action === "reject"
            ? await reviewProposalCommand({
                ...input,
                input: { ...input.input, decision: action === "approve" ? "approve" : "reject" },
              })
            : action === "completeAcceptance"
              ? await completeAcceptanceCommand(input)
              : action === "pause"
                ? await pauseCommand(input)
                : await resumeCommand(input);
        if (result._tag !== "Success") return false;
        refreshWorkflowState();
        return true;
      } finally {
        setIsMutating(false);
      }
    },
    [
      capability?.enabled,
      completeAcceptanceCommand,
      currentWorkflowState,
      environmentId,
      isMutating,
      pauseCommand,
      refreshWorkflowState,
      reviewProposalCommand,
      resumeCommand,
      threadId,
    ],
  );

  const approveProposal = useCallback(() => runWorkflowCommand("approve"), [runWorkflowCommand]);
  const rejectProposal = useCallback(() => runWorkflowCommand("reject"), [runWorkflowCommand]);
  const completeAcceptance = useCallback(
    () => runWorkflowCommand("completeAcceptance"),
    [runWorkflowCommand],
  );
  const pause = useCallback(() => runWorkflowCommand("pause"), [runWorkflowCommand]);
  const resume = useCallback(() => runWorkflowCommand("resume"), [runWorkflowCommand]);

  return {
    ...state,
    enabled: capability?.enabled ?? false,
    isPending: state.isPending || isMutating,
    toggle,
    selectIntent,
    workflowState: workflowState.state,
    workflowStateIsPending: workflowState.isPending,
    workflowStateHasError: workflowState.hasError,
    approveProposal,
    rejectProposal,
    completeAcceptance,
    pause,
    resume,
  };
}
