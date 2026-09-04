import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  ScopedThreadRef,
  SpecWorkflowCapability,
  SpecWorkflowEvent,
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
).pipe(Atom.withLabel("mobile-spec-workflow:empty"));
const EMPTY_CAPABILITY_EVENT_ATOM = Atom.make(
  AsyncResult.initial<SpecWorkflowEvent, never>(false),
).pipe(Atom.withLabel("mobile-spec-workflow-events:empty"));
const EMPTY_STATE_RESULT_ATOM = Atom.make(
  AsyncResult.success<SpecWorkflowState | null, never>(null),
).pipe(Atom.withLabel("mobile-spec-workflow-state:empty"));
const EMPTY_STATE_EVENT_ATOM = Atom.make(
  AsyncResult.initial<SpecWorkflowStateEvent, never>(false),
).pipe(Atom.withLabel("mobile-spec-workflow-state-events:empty"));

function resolveCapabilitySnapshot(
  queryCapability: SpecWorkflowCapability | null,
  eventCapability: SpecWorkflowCapability | null,
): SpecWorkflowCapability | null {
  return eventCapability ?? queryCapability;
}

function resolveStateSnapshot(
  queryState: SpecWorkflowState | null,
  event: SpecWorkflowStateEvent | null,
): SpecWorkflowState | null {
  return event === null ? queryState : event.state;
}

export interface SpecWorkflowCapabilityView {
  readonly capability: SpecWorkflowCapability | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly refresh: () => void;
}

function useSpecWorkflowCapability(threadRef: ScopedThreadRef | null): SpecWorkflowCapabilityView {
  const target =
    threadRef === null
      ? null
      : { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } };
  const capabilityAtom =
    target === null ? EMPTY_CAPABILITY_RESULT_ATOM : specWorkflowEnvironment.get(target);
  const eventAtom =
    target === null ? EMPTY_CAPABILITY_EVENT_ATOM : specWorkflowEnvironment.events(target);
  const capabilityResult = useAtomValue(capabilityAtom);
  const eventResult = useAtomValue(eventAtom);
  const refresh = useAtomRefresh(capabilityAtom);
  const queryCapability = Option.getOrNull(AsyncResult.value(capabilityResult));
  const event = Option.getOrNull(AsyncResult.value(eventResult));

  return {
    capability: resolveCapabilitySnapshot(
      queryCapability,
      event?.type === "updated" ? event.capability : null,
    ),
    isPending: target !== null && capabilityResult.waiting,
    hasError: capabilityResult._tag === "Failure",
    refresh,
  };
}

interface SpecWorkflowStateView {
  readonly state: SpecWorkflowState | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
  readonly refresh: () => void;
}

function useSpecWorkflowState(threadRef: ScopedThreadRef | null): SpecWorkflowStateView {
  const target =
    threadRef === null
      ? null
      : { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } };
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

export interface SpecWorkflowMobileController extends SpecWorkflowCapabilityView {
  readonly enabled: boolean;
  readonly toggle: () => Promise<boolean>;
  readonly workflowState: SpecWorkflowState | null;
  readonly workflowStateIsPending: boolean;
  readonly workflowStateHasError: boolean;
  readonly approveProposal: () => Promise<boolean>;
  readonly rejectProposal: () => Promise<boolean>;
  readonly completeAcceptance: () => Promise<boolean>;
  readonly pause: () => Promise<boolean>;
  readonly resume: () => Promise<boolean>;
}

/** 只允许线程内控件显式启用或控制，不会因普通消息自动开启工作流。 */
export function useSpecWorkflowController(
  threadRef: ScopedThreadRef | null,
): SpecWorkflowMobileController {
  const capability = useSpecWorkflowCapability(threadRef);
  const workflow = useSpecWorkflowState(capability.capability?.enabled === true ? threadRef : null);
  const setCommand = useAtomCommand(specWorkflowEnvironment.set, { reportFailure: false });
  const reviewCommand = useAtomCommand(specWorkflowEnvironment.reviewProposal, {
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
  const currentState = workflow.state;

  const toggle = useCallback(async () => {
    if (
      threadId === null ||
      environmentId === null ||
      capability.capability === null ||
      isMutating
    ) {
      return false;
    }
    setIsMutating(true);
    try {
      const result = await setCommand({
        environmentId,
        input: {
          threadId,
          enabled: !capability.capability.enabled,
          expectedRevision: capability.capability.revision,
        },
      });
      if (result._tag !== "Success") return false;
      capability.refresh();
      return true;
    } finally {
      setIsMutating(false);
    }
  }, [capability, environmentId, isMutating, setCommand, threadId]);

  const runCommand = useCallback(
    async (action: "approve" | "reject" | "completeAcceptance" | "pause" | "resume") => {
      if (
        threadId === null ||
        environmentId === null ||
        capability.capability?.enabled !== true ||
        currentState === null ||
        isMutating
      ) {
        return false;
      }
      if (
        (action === "approve" || action === "reject") &&
        (currentState.stage !== "awaitingApproval" || currentState.proposalStatus !== "pending")
      ) {
        return false;
      }
      if (
        action === "completeAcceptance" &&
        (currentState.status !== "active" ||
          currentState.stage !== "acceptance" ||
          currentState.acceptanceStatus !== "pending")
      ) {
        return false;
      }
      if (action === "pause" && currentState.status !== "active") return false;
      if (action === "resume" && currentState.status !== "paused") return false;

      setIsMutating(true);
      try {
        const input = {
          environmentId,
          input: { threadId, expectedRevision: currentState.revision },
        };
        const result =
          action === "approve" || action === "reject"
            ? await reviewCommand({
                ...input,
                input: { ...input.input, decision: action },
              })
            : action === "completeAcceptance"
              ? await completeAcceptanceCommand(input)
              : action === "pause"
                ? await pauseCommand(input)
                : await resumeCommand(input);
        if (result._tag !== "Success") return false;
        workflow.refresh();
        return true;
      } finally {
        setIsMutating(false);
      }
    },
    [
      capability.capability?.enabled,
      completeAcceptanceCommand,
      currentState,
      environmentId,
      isMutating,
      pauseCommand,
      reviewCommand,
      resumeCommand,
      threadId,
      workflow,
    ],
  );

  return {
    ...capability,
    enabled: capability.capability?.enabled ?? false,
    isPending: capability.isPending || isMutating,
    toggle,
    workflowState: workflow.state,
    workflowStateIsPending: workflow.isPending,
    workflowStateHasError: workflow.hasError,
    approveProposal: useCallback(() => runCommand("approve"), [runCommand]),
    rejectProposal: useCallback(() => runCommand("reject"), [runCommand]),
    completeAcceptance: useCallback(() => runCommand("completeAcceptance"), [runCommand]),
    pause: useCallback(() => runCommand("pause"), [runCommand]),
    resume: useCallback(() => runCommand("resume"), [runCommand]),
  };
}
