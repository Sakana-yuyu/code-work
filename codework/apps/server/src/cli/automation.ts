import {
  type CompositionAutomation,
  CompositionAutomationCreateRequest as CompositionAutomationCreateRequestSchema,
  type CompositionAutomationCreateRequest,
  type CompositionAutomationListResult,
  type CompositionAutomationResult,
  CompositionAutomationStatus,
  type CompositionAutomationStatus as CompositionAutomationStatusType,
  CompositionAutomationUpdateRequest as CompositionAutomationUpdateRequestSchema,
  type CompositionAutomationUpdateRequest,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "@codework/contracts";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";

export interface ListAutomationsOptions extends ControlConnectionOptions {
  readonly projectId?: string;
  readonly statuses?: ReadonlyArray<CompositionAutomationStatusType>;
}

export interface GetAutomationOptions extends ControlConnectionOptions {
  readonly automationId: string;
}

export interface CreateAutomationOptions extends ControlConnectionOptions {
  readonly input: CompositionAutomationCreateRequest;
}

export interface UpdateAutomationOptions extends ControlConnectionOptions {
  readonly input: CompositionAutomationUpdateRequest;
}

export class AutomationStatusInputError extends Data.TaggedError("AutomationStatusInputError")<{
  readonly message: string;
}> {}

export class AutomationConfigInputError extends Data.TaggedError("AutomationConfigInputError")<{
  readonly message: string;
}> {}

export const listAutomations = (
  options: ListAutomationsOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverListCompositionAutomations]({
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
      }),
  );

export const getAutomation = (
  options: GetAutomationOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverGetCompositionAutomation]({ automationId: options.automationId }),
  );

export const createAutomation = (
  options: CreateAutomationOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverCreateCompositionAutomation](options.input),
  );

export const updateAutomation = (
  options: UpdateAutomationOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverUpdateCompositionAutomation](options.input),
  );

const AutomationStatuses = Schema.Array(CompositionAutomationStatus);
const decodeAutomationStatusesArray = Schema.decodeUnknownEffect(AutomationStatuses);
const AutomationCreateConfigDocument = Schema.fromJsonString(
  CompositionAutomationCreateRequestSchema,
);
const AutomationUpdateConfigDocument = Schema.fromJsonString(
  CompositionAutomationUpdateRequestSchema,
);
const decodeAutomationCreateConfigDocument = Schema.decodeUnknownEffect(
  AutomationCreateConfigDocument,
);
const decodeAutomationUpdateConfigDocument = Schema.decodeUnknownEffect(
  AutomationUpdateConfigDocument,
);

export const decodeAutomationStatuses = (raw: string) =>
  decodeAutomationStatusesArray(
    raw
      .split(",")
      .map((status) => status.trim())
      .filter((status) => status.length > 0),
  ).pipe(
    Effect.mapError(
      () =>
        new AutomationStatusInputError({
          message: "Automation statuses must be active, paused, or completed.",
        }),
    ),
  );

export const decodeAutomationCreateConfigText = (raw: string) =>
  decodeAutomationCreateConfigDocument(raw).pipe(
    Effect.mapError(
      () =>
        new AutomationConfigInputError({
          message: "Automation create config does not match the Code Work contract.",
        }),
    ),
  );

export const decodeAutomationUpdateConfigText = (raw: string) =>
  decodeAutomationUpdateConfigDocument(raw).pipe(
    Effect.mapError(
      () =>
        new AutomationConfigInputError({
          message: "Automation update config does not match the Code Work contract.",
        }),
    ),
  );

const readAutomationConfigText = Effect.fn("cli.automation.readConfigFile")(function* (
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      () =>
        new AutomationConfigInputError({
          message: `Could not read Automation config file: ${path}`,
        }),
    ),
  );
});

const formatUnixMs = (unixMs: number): string => {
  const dateTime = DateTime.make(unixMs);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : String(unixMs);
};

const formatOptionalUnixMs = (unixMs: number | null): string =>
  unixMs === null ? "none" : formatUnixMs(unixMs);

const formatCadence = (automation: CompositionAutomation): string =>
  automation.cadence.type === "every"
    ? `every ${String(automation.cadence.intervalMs)}ms`
    : `cron ${automation.cadence.expression} @ ${automation.cadence.timezone}`;

const formatTarget = (automation: CompositionAutomation): string => {
  const target = automation.target;
  switch (target.type) {
    case "agent":
      return `agent ${target.agentId}${target.model === undefined ? "" : ` model=${target.model}`}`;
    case "squad":
      return `squad ${target.squadId} r${String(target.squadRevision)}`;
    case "goal_loop":
      return `goal_loop ${target.agentId}${
        target.reviewerAgentId === undefined ? "" : ` reviewer=${target.reviewerAgentId}`
      }`;
  }
};

const formatExecutionContext = (automation: CompositionAutomation): string => {
  const executionContext = automation.target.executionContext;
  return executionContext.mode === "existing_thread"
    ? `existing_thread ${executionContext.threadId}`
    : [
        "isolated",
        executionContext.workspaceRoot,
        executionContext.archiveOnFinish ? "archive-on-finish" : "keep-after-finish",
      ].join(" ");
};

export function formatAutomationList(
  result: CompositionAutomationListResult,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(result.automations, null, 2);
  }
  if (result.automations.length === 0) {
    return "No automations found.";
  }
  return result.automations
    .map((automation) =>
      [
        automation.name,
        automation.automationId,
        `r${String(automation.revision)}`,
        automation.status,
        automation.target.type,
        formatCadence(automation),
        `next=${formatOptionalUnixMs(automation.nextRunAtUnixMs)}`,
        `runs=${String(automation.runCount)}/${
          automation.maxRuns === null ? "unlimited" : String(automation.maxRuns)
        }`,
      ].join("  "),
    )
    .join("\n");
}

export function formatAutomationDetails(
  result: CompositionAutomationResult,
  json: boolean,
): string {
  const { automation } = result;
  if (json) {
    return JSON.stringify(automation, null, 2);
  }
  return [
    `${automation.name} (${automation.automationId})`,
    `Project: ${automation.projectId}`,
    `Revision: ${String(automation.revision)}`,
    `Status: ${automation.status}`,
    `Cadence: ${formatCadence(automation)}`,
    `Target: ${formatTarget(automation)}`,
    `Execution context: ${formatExecutionContext(automation)}`,
    `Runs: ${String(automation.runCount)}/${
      automation.maxRuns === null ? "unlimited" : String(automation.maxRuns)
    }`,
    `Next run: ${formatOptionalUnixMs(automation.nextRunAtUnixMs)}`,
    `Last run: ${formatOptionalUnixMs(automation.lastRunAtUnixMs)}`,
    `Expires: ${formatOptionalUnixMs(automation.expiresAtUnixMs)}`,
    `Prompt: ${automation.prompt}`,
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
  Flag.withDescription("Only list automations owned by this project id."),
  Flag.optional,
);

const statusFlag = Flag.string("status").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Comma-separated statuses: active, paused, completed."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const automationIdArgument = Argument.string("automation-id").pipe(
  Argument.withDescription("Composition automation id."),
);

const configFileFlag = Flag.string("config").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("JSON file validated against the Code Work Automation contract."),
);

const automationListCommand = Command.make("list", {
  server: serverFlag,
  accessToken: accessTokenFlag,
  project: projectFlag,
  status: statusFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List composition automations."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const statuses = Option.isSome(flags.status)
        ? yield* decodeAutomationStatuses(flags.status.value)
        : undefined;
      const result = yield* listAutomations({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        ...(Option.isSome(flags.project) ? { projectId: flags.project.value } : {}),
        ...(statuses === undefined ? {} : { statuses }),
      });
      yield* Console.log(formatAutomationList(result, flags.json));
    }),
  ),
);

const automationGetCommand = Command.make("get", {
  automationId: automationIdArgument,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get one composition automation."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* getAutomation({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        automationId: flags.automationId,
      });
      yield* Console.log(formatAutomationDetails(result, flags.json));
    }),
  ),
);

const automationCreateCommand = Command.make("create", {
  config: configFileFlag,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a composition automation from a validated JSON config."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* readAutomationConfigText(flags.config).pipe(
        Effect.flatMap(decodeAutomationCreateConfigText),
      );
      const result = yield* createAutomation({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        input,
      });
      yield* Console.log(formatAutomationDetails(result, flags.json));
    }),
  ),
);

const automationUpdateCommand = Command.make("update", {
  config: configFileFlag,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a composition automation from a validated JSON config."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* readAutomationConfigText(flags.config).pipe(
        Effect.flatMap(decodeAutomationUpdateConfigText),
      );
      const result = yield* updateAutomation({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        input,
      });
      yield* Console.log(formatAutomationDetails(result, flags.json));
    }),
  ),
);

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription("Manage composition automations."),
  Command.withSubcommands([
    automationListCommand,
    automationGetCommand,
    automationCreateCommand,
    automationUpdateCommand,
  ]),
);
