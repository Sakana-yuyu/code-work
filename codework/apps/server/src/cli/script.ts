import {
  TrimmedNonEmptyString,
  type WorkspaceScriptRun,
  type WorkspaceScriptRunListResult,
  type WorkspaceScriptRunResult,
  WorkspaceScriptRunStatus,
  type WorkspaceScriptRunStatus as WorkspaceScriptRunStatusType,
  WS_METHODS,
} from "@codework/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";

export interface ListWorkspaceScriptRunsOptions extends ControlConnectionOptions {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly statuses?: ReadonlyArray<WorkspaceScriptRunStatusType>;
}

export interface GetWorkspaceScriptRunOptions extends ControlConnectionOptions {
  readonly workspaceScriptRunId: string;
}

export class WorkspaceScriptStatusInputError extends Data.TaggedError(
  "WorkspaceScriptStatusInputError",
)<{
  readonly message: string;
}> {}

export const listWorkspaceScriptRuns = (
  options: ListWorkspaceScriptRunsOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverListWorkspaceScriptRuns]({
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
        ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
      }),
  );

export const getWorkspaceScriptRun = (
  options: GetWorkspaceScriptRunOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverGetWorkspaceScriptRun]({
        workspaceScriptRunId: options.workspaceScriptRunId,
      }),
  );

const WorkspaceScriptStatuses = Schema.Array(WorkspaceScriptRunStatus).check(Schema.isMinLength(1));
const decodeWorkspaceScriptStatusesArray = Schema.decodeUnknownEffect(WorkspaceScriptStatuses);

export const decodeWorkspaceScriptStatuses = (raw: string) =>
  decodeWorkspaceScriptStatusesArray(
    raw
      .split(",")
      .map((status) => status.trim())
      .filter((status) => status.length > 0),
  ).pipe(
    Effect.mapError(
      () =>
        new WorkspaceScriptStatusInputError({
          message:
            "Workspace script statuses must be starting, running, stopping, stopped, exited, or failed.",
        }),
    ),
  );

const formatUnixMs = (unixMs: number): string => {
  const dateTime = DateTime.make(unixMs);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : String(unixMs);
};

const formatOptionalUnixMs = (unixMs: number | null): string =>
  unixMs === null ? "none" : formatUnixMs(unixMs);

const formatPorts = (run: WorkspaceScriptRun): string =>
  run.ports.length === 0
    ? "none"
    : run.ports
        .map(
          (port) => `${port.protocol}:${String(port.port)} ${port.source} ${port.url ?? "no-url"}`,
        )
        .join(", ");

const formatExit = (run: WorkspaceScriptRun): string => {
  const parts = [
    run.exitCode === null ? undefined : `code=${String(run.exitCode)}`,
    run.exitSignal === null ? undefined : `signal=${String(run.exitSignal)}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "none" : parts.join(" ");
};

const formatError = (run: WorkspaceScriptRun): string => {
  const parts = [run.errorCode, run.errorDetail].filter((part) => part !== null);
  return parts.length === 0 ? "none" : parts.join(": ");
};

const formatComposition = (run: WorkspaceScriptRun): string =>
  run.compositionTaskId === null || run.compositionRunId === null
    ? "none"
    : `task=${run.compositionTaskId} run=${run.compositionRunId}`;

export function formatWorkspaceScriptRunList(
  result: WorkspaceScriptRunListResult,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(result.runs, null, 2);
  }
  if (result.runs.length === 0) {
    return "No workspace script runs found.";
  }
  return result.runs
    .map((run) =>
      [
        run.scriptName,
        run.workspaceScriptRunId,
        `r${String(run.revision)}`,
        run.status,
        run.healthStatus,
        `project=${run.projectId}`,
        `thread=${run.threadId}`,
        `updated=${formatUnixMs(run.updatedAtUnixMs)}`,
      ].join("  "),
    )
    .join("\n");
}

export function formatWorkspaceScriptRunDetails(
  result: WorkspaceScriptRunResult,
  json: boolean,
): string {
  const { run } = result;
  if (json) {
    return JSON.stringify(run, null, 2);
  }
  const healthCheckedAt =
    run.healthCheckedAtUnixMs === null ? "" : ` at ${formatUnixMs(run.healthCheckedAtUnixMs)}`;
  const healthDetail = run.healthDetail === null ? "" : ` (${run.healthDetail})`;
  return [
    `${run.scriptName} (${run.workspaceScriptRunId})`,
    `Project: ${run.projectId}`,
    `Thread: ${run.threadId}`,
    `Script: ${run.scriptId}`,
    `Revision: ${String(run.revision)}`,
    `Status: ${run.status}`,
    `Health: ${run.healthStatus}${healthCheckedAt}${healthDetail}`,
    `Terminal: ${run.terminalId}`,
    `CWD: ${run.cwd}`,
    `Worktree: ${run.worktreePath ?? "none"}`,
    `Ports: ${formatPorts(run)}`,
    `Requested: ${formatUnixMs(run.requestedAtUnixMs)}`,
    `Started: ${formatOptionalUnixMs(run.startedAtUnixMs)}`,
    `Finished: ${formatOptionalUnixMs(run.finishedAtUnixMs)}`,
    `Updated: ${formatUnixMs(run.updatedAtUnixMs)}`,
    `Exit: ${formatExit(run)}`,
    `Error: ${formatError(run)}`,
    `Composition: ${formatComposition(run)}`,
  ].join("\n");
}

const serverFlag = Flag.string("server").pipe(
  Flag.withDescription("Code Work server URL or pairing link."),
  Flag.withDefault("http://127.0.0.1:3773"),
);

const accessTokenFlag = Flag.string("access-token").pipe(
  Flag.withDescription("Scoped bearer access token. Prefer a short-lived token."),
  Flag.optional,
);

const projectFlag = Flag.string("project").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Only list workspace script runs owned by this project id."),
  Flag.optional,
);

const threadFlag = Flag.string("thread").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Only list workspace script runs for this thread id."),
  Flag.optional,
);

const statusFlag = Flag.string("status").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription(
    "Comma-separated statuses: starting, running, stopping, stopped, exited, failed.",
  ),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const workspaceScriptRunIdArgument = Argument.string("run-id").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Workspace script run id."),
);

const scriptListCommand = Command.make("list", {
  server: serverFlag,
  accessToken: accessTokenFlag,
  project: projectFlag,
  thread: threadFlag,
  status: statusFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List workspace script runs."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const statuses = Option.isSome(flags.status)
        ? yield* decodeWorkspaceScriptStatuses(flags.status.value)
        : undefined;
      const result = yield* listWorkspaceScriptRuns({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        ...(Option.isSome(flags.project) ? { projectId: flags.project.value } : {}),
        ...(Option.isSome(flags.thread) ? { threadId: flags.thread.value } : {}),
        ...(statuses === undefined ? {} : { statuses }),
      });
      yield* Console.log(formatWorkspaceScriptRunList(result, flags.json));
    }),
  ),
);

const scriptGetCommand = Command.make("get", {
  workspaceScriptRunId: workspaceScriptRunIdArgument,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get one workspace script run."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* getWorkspaceScriptRun({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        workspaceScriptRunId: flags.workspaceScriptRunId,
      });
      yield* Console.log(formatWorkspaceScriptRunDetails(result, flags.json));
    }),
  ),
);

export const scriptCommand = Command.make("script").pipe(
  Command.withDescription("Inspect workspace script runs."),
  Command.withSubcommands([scriptListCommand, scriptGetCommand]),
);
