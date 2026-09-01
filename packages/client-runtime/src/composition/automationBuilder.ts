import {
  validateCompositionAutomationTarget,
  type CompositionAutomation,
  type CompositionAutomationCadence,
  type CompositionAutomationCreateRequest,
  type CompositionAutomationExecutionContext,
  type CompositionAutomationTarget,
  type CompositionAutomationTargetValidationIssueCode,
  type CompositionAutomationUpdateRequest,
} from "@codework/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type CompositionAutomationIntervalUnit =
  | "millisecond"
  | "second"
  | "minute"
  | "hour"
  | "day";

export interface CompositionAutomationDraft {
  automationId: string;
  projectId: string;
  name: string;
  prompt: string;
  cadenceType: "every" | "cron";
  intervalValueText: string;
  intervalUnit: CompositionAutomationIntervalUnit;
  cronExpression: string;
  timezone: string;
  targetType: "agent" | "squad" | "goal_loop";
  agentId: string;
  model: string;
  capabilityIdsText: string;
  squadId: string;
  squadRevisionText: string;
  reviewerAgentId: string;
  maxAttemptsText: string;
  maxCostUnitsText: string;
  stalePivotRoundsText: string;
  deadlineMinutesText: string;
  executionMode: "existing_thread" | "isolated";
  threadId: string;
  workspaceRoot: string;
  archiveOnFinish: boolean;
  maxRunsText: string;
  expiresAtText: string;
  runOnCreate: boolean;
}

export type CompositionAutomationDraftIssueCode =
  | CompositionAutomationTargetValidationIssueCode
  | "automation_id_required"
  | "project_id_required"
  | "name_required"
  | "prompt_required"
  | "interval_required"
  | "cron_expression_required"
  | "timezone_required"
  | "timezone_invalid"
  | "agent_id_required"
  | "squad_id_required"
  | "thread_id_required"
  | "workspace_root_required"
  | "positive_integer_required"
  | "expiration_invalid"
  | "expiration_must_be_future";

export interface CompositionAutomationDraftIssue {
  readonly code: CompositionAutomationDraftIssueCode;
  readonly path: string;
}

export interface CompositionAutomationCreateBuildResult {
  readonly request: CompositionAutomationCreateRequest | null;
  readonly issues: ReadonlyArray<CompositionAutomationDraftIssue>;
}

export interface CompositionAutomationUpdateBuildResult {
  readonly request: CompositionAutomationUpdateRequest | null;
  readonly issues: ReadonlyArray<CompositionAutomationDraftIssue>;
}

export type CompositionAutomationAction = "pause" | "resume" | "run_once" | "delete";

const INTERVAL_UNIT_MS: Readonly<Record<CompositionAutomationIntervalUnit, number>> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

const addIssue = (
  issues: CompositionAutomationDraftIssue[],
  code: CompositionAutomationDraftIssueCode,
  path: string,
): void => {
  issues.push({ code, path });
};

const requiredText = (
  value: string,
  code: CompositionAutomationDraftIssueCode,
  path: string,
  issues: CompositionAutomationDraftIssue[],
): string => {
  const normalized = value.trim();
  if (normalized === "") addIssue(issues, code, path);
  return normalized;
};

const optionalText = (value: string): string | undefined => {
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
};

const positiveInteger = (
  value: string,
  path: string,
  issues: CompositionAutomationDraftIssue[],
): number => {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    addIssue(issues, "positive_integer_required", path);
    return 1;
  }
  return parsed;
};

const optionalPositiveInteger = (
  value: string,
  path: string,
  issues: CompositionAutomationDraftIssue[],
): number | null => {
  if (value.trim() === "") return null;
  return positiveInteger(value, path, issues);
};

const durationMs = (
  value: string,
  unitMs: number,
  code: "interval_required" | "positive_integer_required",
  path: string,
  issues: CompositionAutomationDraftIssue[],
): number => {
  const parsed = Number(value.trim());
  const result = Math.round(parsed * unitMs);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isSafeInteger(result) || result <= 0) {
    addIssue(issues, code, path);
    return 1;
  }
  return result;
};

const capabilityIds = (value: string): string[] =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");

const systemTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const validTimezone = (timezone: string): boolean =>
  Option.isSome(DateTime.zoneMakeNamed(timezone));

const parseCadence = (
  draft: CompositionAutomationDraft,
  issues: CompositionAutomationDraftIssue[],
): CompositionAutomationCadence => {
  if (draft.cadenceType === "every") {
    return {
      type: "every",
      intervalMs: durationMs(
        draft.intervalValueText,
        INTERVAL_UNIT_MS[draft.intervalUnit],
        "interval_required",
        "intervalValueText",
        issues,
      ),
    };
  }

  const expression = requiredText(
    draft.cronExpression,
    "cron_expression_required",
    "cronExpression",
    issues,
  );
  const timezone = requiredText(draft.timezone, "timezone_required", "timezone", issues);
  if (timezone !== "" && !validTimezone(timezone)) {
    addIssue(issues, "timezone_invalid", "timezone");
  }
  return { type: "cron", expression, timezone };
};

const parseExecutionContext = (
  draft: CompositionAutomationDraft,
  issues: CompositionAutomationDraftIssue[],
): CompositionAutomationExecutionContext =>
  draft.executionMode === "existing_thread"
    ? {
        mode: "existing_thread",
        threadId: requiredText(draft.threadId, "thread_id_required", "threadId", issues),
      }
    : {
        mode: "isolated",
        workspaceRoot: requiredText(
          draft.workspaceRoot,
          "workspace_root_required",
          "workspaceRoot",
          issues,
        ),
        archiveOnFinish: draft.archiveOnFinish,
      };

const parseTarget = (
  draft: CompositionAutomationDraft,
  issues: CompositionAutomationDraftIssue[],
): CompositionAutomationTarget => {
  const executionContext = parseExecutionContext(draft, issues);
  let target: CompositionAutomationTarget;

  if (draft.targetType === "squad") {
    target = {
      type: "squad",
      squadId: requiredText(draft.squadId, "squad_id_required", "squadId", issues),
      squadRevision: positiveInteger(draft.squadRevisionText, "squadRevisionText", issues),
      executionContext,
    };
  } else if (draft.targetType === "goal_loop") {
    const maxCostUnits = optionalPositiveInteger(
      draft.maxCostUnitsText,
      "maxCostUnitsText",
      issues,
    );
    const stalePivotRounds = optionalPositiveInteger(
      draft.stalePivotRoundsText,
      "stalePivotRoundsText",
      issues,
    );
    const deadlineDurationMs =
      draft.deadlineMinutesText.trim() === ""
        ? null
        : durationMs(
            draft.deadlineMinutesText,
            INTERVAL_UNIT_MS.minute,
            "positive_integer_required",
            "deadlineMinutesText",
            issues,
          );
    target = {
      type: "goal_loop",
      agentId: requiredText(draft.agentId, "agent_id_required", "agentId", issues),
      ...(optionalText(draft.reviewerAgentId) === undefined
        ? {}
        : { reviewerAgentId: optionalText(draft.reviewerAgentId) }),
      ...(optionalText(draft.model) === undefined ? {} : { model: optionalText(draft.model) }),
      capabilityIds: capabilityIds(draft.capabilityIdsText),
      maxAttempts: positiveInteger(draft.maxAttemptsText, "maxAttemptsText", issues),
      ...(maxCostUnits === null ? {} : { maxCostUnits }),
      ...(stalePivotRounds === null ? {} : { stalePivotRounds }),
      ...(deadlineDurationMs === null ? {} : { deadlineDurationMs }),
      executionContext,
    };
  } else {
    target = {
      type: "agent",
      agentId: requiredText(draft.agentId, "agent_id_required", "agentId", issues),
      ...(optionalText(draft.model) === undefined ? {} : { model: optionalText(draft.model) }),
      capabilityIds: capabilityIds(draft.capabilityIdsText),
      executionContext,
    };
  }

  for (const issue of validateCompositionAutomationTarget(target)) {
    addIssue(issues, issue.code, issue.path);
  }
  return target;
};

const parseExpiration = (
  value: string,
  nowUnixMs: number,
  issues: CompositionAutomationDraftIssue[],
): number | null => {
  if (value.trim() === "") return null;
  const parsed = DateTime.makeZoned(value, {
    timeZone: systemTimezone(),
    adjustForTimeZone: true,
  });
  if (Option.isNone(parsed)) {
    addIssue(issues, "expiration_invalid", "expiresAtText");
    return null;
  }
  const parsedUnixMs = DateTime.toEpochMillis(parsed.value);
  if (parsedUnixMs <= nowUnixMs) {
    addIssue(issues, "expiration_must_be_future", "expiresAtText");
  }
  return parsedUnixMs;
};

const parseMutableFields = (
  draft: CompositionAutomationDraft,
  nowUnixMs: number,
  issues: CompositionAutomationDraftIssue[],
) => ({
  name: requiredText(draft.name, "name_required", "name", issues),
  prompt: requiredText(draft.prompt, "prompt_required", "prompt", issues),
  cadence: parseCadence(draft, issues),
  target: parseTarget(draft, issues),
  maxRuns: optionalPositiveInteger(draft.maxRunsText, "maxRunsText", issues),
  expiresAtUnixMs: parseExpiration(draft.expiresAtText, nowUnixMs, issues),
});

export const createEmptyCompositionAutomationDraft = (
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
): CompositionAutomationDraft => ({
  automationId: "",
  projectId: "",
  name: "",
  prompt: "",
  cadenceType: "every",
  intervalValueText: "30",
  intervalUnit: "minute",
  cronExpression: "0 9 * * 1-5",
  timezone,
  targetType: "agent",
  agentId: "",
  model: "",
  capabilityIdsText: "",
  squadId: "",
  squadRevisionText: "1",
  reviewerAgentId: "",
  maxAttemptsText: "3",
  maxCostUnitsText: "",
  stalePivotRoundsText: "",
  deadlineMinutesText: "",
  executionMode: "isolated",
  threadId: "",
  workspaceRoot: "",
  archiveOnFinish: true,
  maxRunsText: "",
  expiresAtText: "",
  runOnCreate: false,
});

export function buildCompositionAutomationCreateRequest(
  draft: CompositionAutomationDraft,
  nowUnixMs = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): CompositionAutomationCreateBuildResult {
  const issues: CompositionAutomationDraftIssue[] = [];
  const automationId = requiredText(
    draft.automationId,
    "automation_id_required",
    "automationId",
    issues,
  );
  const projectId = requiredText(draft.projectId, "project_id_required", "projectId", issues);
  const mutable = parseMutableFields(draft, nowUnixMs, issues);
  const request: CompositionAutomationCreateRequest = {
    automationId,
    projectId,
    ...mutable,
    runOnCreate: draft.runOnCreate,
  };
  return { request: issues.length === 0 ? request : null, issues };
}

export function buildCompositionAutomationUpdateRequest(
  draft: CompositionAutomationDraft,
  automation: CompositionAutomation,
  nowUnixMs = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): CompositionAutomationUpdateBuildResult {
  const issues: CompositionAutomationDraftIssue[] = [];
  const mutable = parseMutableFields(draft, nowUnixMs, issues);
  const request: CompositionAutomationUpdateRequest = {
    automationId: automation.automationId,
    expectedRevision: automation.revision,
    ...mutable,
  };
  return { request: issues.length === 0 ? request : null, issues };
}

const intervalDraft = (
  intervalMs: number,
): Pick<CompositionAutomationDraft, "intervalValueText" | "intervalUnit"> => {
  for (const unit of ["day", "hour", "minute", "second"] as const) {
    const multiplier = INTERVAL_UNIT_MS[unit];
    if (intervalMs % multiplier === 0) {
      return { intervalValueText: String(intervalMs / multiplier), intervalUnit: unit };
    }
  }
  return { intervalValueText: String(intervalMs), intervalUnit: "millisecond" };
};

const dateTimeLocal = (unixMs: number | null): string => {
  if (unixMs === null) return "";
  const parts = DateTime.toParts(DateTime.makeZonedUnsafe(unixMs, { timeZone: systemTimezone() }));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
};

export function draftFromCompositionAutomation(
  automation: CompositionAutomation,
): CompositionAutomationDraft {
  const draft = createEmptyCompositionAutomationDraft(
    automation.cadence.type === "cron" ? automation.cadence.timezone : undefined,
  );
  const executionContext = automation.target.executionContext;
  const cadence =
    automation.cadence.type === "every"
      ? intervalDraft(automation.cadence.intervalMs)
      : {
          intervalValueText: draft.intervalValueText,
          intervalUnit: draft.intervalUnit,
        };

  return {
    ...draft,
    automationId: automation.automationId,
    projectId: automation.projectId,
    name: automation.name,
    prompt: automation.prompt,
    cadenceType: automation.cadence.type,
    ...cadence,
    cronExpression:
      automation.cadence.type === "cron" ? automation.cadence.expression : draft.cronExpression,
    timezone: automation.cadence.type === "cron" ? automation.cadence.timezone : draft.timezone,
    targetType: automation.target.type,
    agentId: automation.target.type === "squad" ? "" : automation.target.agentId,
    model: automation.target.type === "squad" ? "" : (automation.target.model ?? ""),
    capabilityIdsText:
      automation.target.type === "squad" ? "" : automation.target.capabilityIds.join(", "),
    squadId: automation.target.type === "squad" ? automation.target.squadId : "",
    squadRevisionText:
      automation.target.type === "squad" ? String(automation.target.squadRevision) : "1",
    reviewerAgentId:
      automation.target.type === "goal_loop" ? (automation.target.reviewerAgentId ?? "") : "",
    maxAttemptsText:
      automation.target.type === "goal_loop" ? String(automation.target.maxAttempts) : "3",
    maxCostUnitsText:
      automation.target.type === "goal_loop" && automation.target.maxCostUnits !== undefined
        ? String(automation.target.maxCostUnits)
        : "",
    stalePivotRoundsText:
      automation.target.type === "goal_loop" && automation.target.stalePivotRounds !== undefined
        ? String(automation.target.stalePivotRounds)
        : "",
    deadlineMinutesText:
      automation.target.type === "goal_loop" && automation.target.deadlineDurationMs !== undefined
        ? String(automation.target.deadlineDurationMs / INTERVAL_UNIT_MS.minute)
        : "",
    executionMode: executionContext.mode,
    threadId: executionContext.mode === "existing_thread" ? executionContext.threadId : "",
    workspaceRoot: executionContext.mode === "isolated" ? executionContext.workspaceRoot : "",
    archiveOnFinish: executionContext.mode === "isolated" ? executionContext.archiveOnFinish : true,
    maxRunsText: automation.maxRuns === null ? "" : String(automation.maxRuns),
    expiresAtText: dateTimeLocal(automation.expiresAtUnixMs),
    runOnCreate: false,
  };
}

export const getCompositionAutomationActions = (
  automation: CompositionAutomation,
): ReadonlyArray<CompositionAutomationAction> => {
  if (automation.status === "active") return ["pause", "run_once", "delete"];
  if (automation.status === "paused") return ["resume", "run_once", "delete"];
  return ["delete"];
};
