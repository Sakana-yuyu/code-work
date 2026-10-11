import { useMemo } from "react";
import { inferCheckpointTurnCountByTurnId } from "../session-logic";
import type { Thread, TurnDiffSummary } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: ReadonlyArray<TurnDiffSummary> = [];

export function useTurnDiffSummaries(activeThread: Thread | null | undefined) {
  const turnDiffSummaries = activeThread?.checkpoints ?? EMPTY_TURN_DIFF_SUMMARIES;

  const inferredCheckpointTurnCountByTurnId = useMemo(
    () => inferCheckpointTurnCountByTurnId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByTurnId };
}
