import type { CompositionTaskStatus } from "@codework/contracts";

const startedProjectionStatuses: ReadonlySet<CompositionTaskStatus> = new Set([
  "running",
  "waiting_approval",
  "waiting_input",
  "in_review",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const isCompositionRunStartedProjectionStatus = (status: CompositionTaskStatus): boolean =>
  startedProjectionStatuses.has(status);
