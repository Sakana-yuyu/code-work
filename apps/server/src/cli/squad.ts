import * as NodeCrypto from "node:crypto";

import {
  CompositionSquadCreateRequest as CompositionSquadCreateRequestSchema,
  type CompositionSquadCreateRequest,
  type CompositionSquadExecutionResult,
  type CompositionSquadListResult,
  CompositionSquadPlanNode,
  type CompositionSquadPlanNode as CompositionSquadPlanNodeType,
  type CompositionSquadRevisionListResult,
  type CompositionSquadResult,
  CompositionSquadUpdateRequest as CompositionSquadUpdateRequestSchema,
  type CompositionSquadUpdateRequest,
  PositiveInt,
  ThreadId,
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

export interface ListSquadsOptions extends ControlConnectionOptions {
  readonly includeArchived: boolean;
}

export interface GetSquadOptions extends ControlConnectionOptions {
  readonly squadId: string;
}

export interface RunSquadOptions extends ControlConnectionOptions {
  readonly executionId: string;
  readonly squadId: string;
  readonly squadRevision: number;
  readonly projectId: string;
  readonly threadId?: string;
  readonly goal: string;
  readonly workspaceRoot: string;
  readonly workspaceRootDigest?: string;
  readonly plan?: ReadonlyArray<CompositionSquadPlanNodeType>;
}

export interface DuplicateSquadOptions extends ControlConnectionOptions {
  readonly sourceSquadId: string;
  readonly squadId: string;
  readonly name: string;
}

export interface MutateSquadRevisionOptions extends ControlConnectionOptions {
  readonly squadId: string;
  readonly expectedRevision: number;
}

export interface CreateSquadOptions extends ControlConnectionOptions {
  readonly input: CompositionSquadCreateRequest;
}

export interface UpdateSquadOptions extends ControlConnectionOptions {
  readonly input: CompositionSquadUpdateRequest;
}

export class SquadPlanInputError extends Data.TaggedError("SquadPlanInputError")<{
  readonly message: string;
}> {}

export class SquadConfigInputError extends Data.TaggedError("SquadConfigInputError")<{
  readonly message: string;
}> {}

export const listSquads = (
  options: ListSquadsOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverListCompositionSquads]({
        includeArchived: options.includeArchived,
      }),
  );

export const getSquad = (options: GetSquadOptions, open: ControlClientOpen = openControlClient) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverGetCompositionSquad]({ squadId: options.squadId }),
  );

export const listSquadRevisions = (
  options: GetSquadOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverListCompositionSquadRevisions]({ squadId: options.squadId }),
  );

export const runSquad = (options: RunSquadOptions, open: ControlClientOpen = openControlClient) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverRunCompositionSquad]({
        executionId: options.executionId,
        squadId: options.squadId,
        squadRevision: options.squadRevision,
        projectId: options.projectId,
        ...(options.threadId === undefined ? {} : { threadId: ThreadId.make(options.threadId) }),
        goal: options.goal,
        workspaceRoot: options.workspaceRoot,
        ...(options.workspaceRootDigest === undefined
          ? {}
          : { workspaceRootDigest: options.workspaceRootDigest }),
        ...(options.plan === undefined ? {} : { plan: options.plan }),
      }),
  );

export const duplicateSquad = (
  options: DuplicateSquadOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverDuplicateCompositionSquad]({
        sourceSquadId: options.sourceSquadId,
        squadId: options.squadId,
        name: options.name,
      }),
  );

export const archiveSquad = (
  options: MutateSquadRevisionOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverArchiveCompositionSquad]({
        squadId: options.squadId,
        expectedRevision: options.expectedRevision,
      }),
  );

export const restoreSquad = (
  options: MutateSquadRevisionOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) =>
      rpc[WS_METHODS.serverRestoreCompositionSquad]({
        squadId: options.squadId,
        expectedRevision: options.expectedRevision,
      }),
  );

export const createSquad = (
  options: CreateSquadOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverCreateCompositionSquad](options.input),
  );

export const updateSquad = (
  options: UpdateSquadOptions,
  open: ControlClientOpen = openControlClient,
) =>
  open(
    {
      serverUrl: options.serverUrl,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
    },
    (rpc) => rpc[WS_METHODS.serverUpdateCompositionSquad](options.input),
  );

const SquadPlanDocument = Schema.fromJsonString(Schema.Array(CompositionSquadPlanNode));
const decodeSquadPlanDocument = Schema.decodeUnknownEffect(SquadPlanDocument);
const SquadCreateConfigDocument = Schema.fromJsonString(CompositionSquadCreateRequestSchema);
const SquadUpdateConfigDocument = Schema.fromJsonString(CompositionSquadUpdateRequestSchema);
const decodeSquadCreateConfigDocument = Schema.decodeUnknownEffect(SquadCreateConfigDocument);
const decodeSquadUpdateConfigDocument = Schema.decodeUnknownEffect(SquadUpdateConfigDocument);

export const decodeSquadPlanText = (raw: string) =>
  decodeSquadPlanDocument(raw).pipe(
    Effect.mapError(
      () =>
        new SquadPlanInputError({
          message: "Squad plan file must contain a JSON array of valid plan nodes.",
        }),
    ),
  );

export const decodeSquadCreateConfigText = (raw: string) =>
  decodeSquadCreateConfigDocument(raw).pipe(
    Effect.mapError(
      () =>
        new SquadConfigInputError({
          message: "Squad create config does not match the Code Work contract.",
        }),
    ),
  );

export const decodeSquadUpdateConfigText = (raw: string) =>
  decodeSquadUpdateConfigDocument(raw).pipe(
    Effect.mapError(
      () =>
        new SquadConfigInputError({
          message: "Squad update config does not match the Code Work contract.",
        }),
    ),
  );

const readSquadPlanFile = Effect.fn("cli.squad.readPlanFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      () =>
        new SquadPlanInputError({
          message: `Could not read Squad plan file: ${path}`,
        }),
    ),
  );
  return yield* decodeSquadPlanText(raw);
});

const readSquadConfigText = Effect.fn("cli.squad.readConfigFile")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.mapError(
      () =>
        new SquadConfigInputError({
          message: `Could not read Squad config file: ${path}`,
        }),
    ),
  );
});

export function formatSquadList(result: CompositionSquadListResult, json: boolean): string {
  if (json) {
    return JSON.stringify(result.squads, null, 2);
  }
  if (result.squads.length === 0) {
    return "No squads found.";
  }
  return result.squads
    .map((squad) =>
      [
        squad.name,
        squad.squadId,
        `r${String(squad.revision)}`,
        squad.collaborationMode,
        `${String(squad.members?.length ?? squad.memberAgentIds.length)} members`,
        squad.archivedAtUnixMs === undefined ? "active" : "archived",
      ].join("  "),
    )
    .join("\n");
}

export function formatSquadDetails(result: CompositionSquadResult, json: boolean): string {
  const { squad } = result;
  if (json) {
    return JSON.stringify(squad, null, 2);
  }
  return [
    `${squad.name} (${squad.squadId})`,
    `Revision: ${String(squad.revision ?? 1)}`,
    `Status: ${squad.archivedAtUnixMs === undefined ? "active" : "archived"}`,
    `Mode: ${squad.collaborationMode ?? "legacy"}`,
    `Leader: ${squad.leaderAgentId}`,
    `Members: ${String(squad.members?.length ?? squad.memberAgentIds.length)}`,
    `Concurrency: ${squad.maxConcurrency === undefined ? "not configured" : String(squad.maxConcurrency)}`,
    `Failure policy: ${squad.failurePolicy ?? "not configured"}`,
    `Partial success: ${squad.partialSuccessPolicy ?? "not configured"}`,
    `Approvals: ${squad.approvalStages?.join(", ") || "none"}`,
    `Instructions: ${squad.instructions ?? "none"}`,
  ].join("\n");
}

const formatUnixMs = (unixMs: number): string => {
  const dateTime = DateTime.make(unixMs);
  return Option.isSome(dateTime) ? DateTime.formatIso(dateTime.value) : String(unixMs);
};

export function formatSquadRevisions(
  result: CompositionSquadRevisionListResult,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(result.revisions, null, 2);
  }
  if (result.revisions.length === 0) {
    return "No squad revisions found.";
  }
  return result.revisions
    .map((revision) => {
      const configuration = revision.configuration;
      return configuration === null
        ? `r${String(revision.revision)}  ${formatUnixMs(revision.createdAtUnixMs)}  configuration unavailable`
        : [
            `r${String(revision.revision)}`,
            formatUnixMs(revision.createdAtUnixMs),
            configuration.name,
            configuration.collaborationMode ?? "legacy",
          ].join("  ");
    })
    .join("\n");
}

export function formatSquadExecutionResult(
  result: CompositionSquadExecutionResult,
  json: boolean,
): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  const children = result.graph.children.map((child) =>
    [
      `${child.nodeId}: ${child.run.status}`,
      child.run.agentId,
      `attempts ${String(child.attempts)}`,
      child.run.resultSummary,
    ]
      .filter((part) => part !== undefined)
      .join("  "),
  );
  const failures = (result.graph.failures ?? []).map((failure) =>
    [`${failure.nodeId}: ${failure.kind}`, failure.failureCode, failure.detail].join("  "),
  );
  const childCount = result.graph.children.length;
  const failureCount = result.graph.failures?.length ?? 0;
  return [
    `Execution: ${result.executionId}`,
    `Squad: ${result.squadId} r${String(result.squadRevision)}`,
    `Leader: ${result.graph.leader.run.status}  ${result.graph.leader.run.agentId}  attempt ${String(result.graph.leader.run.attempt)}`,
    ...children,
    ...failures,
    `Summary: ${String(childCount)} child ${childCount === 1 ? "result" : "results"}, ${String(failureCount)} ${failureCount === 1 ? "failure" : "failures"}`,
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

const includeArchivedFlag = Flag.boolean("include-archived").pipe(
  Flag.withDescription("Include archived squads."),
  Flag.withDefault(false),
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const squadIdArgument = Argument.string("squad-id").pipe(
  Argument.withDescription("Composition squad id."),
);

const executionIdFlag = Flag.string("execution-id").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription(
    "Stable idempotency key. Generated and printed before dispatch when omitted.",
  ),
  Flag.optional,
);

const revisionFlag = Flag.integer("revision").pipe(
  Flag.withSchema(PositiveInt),
  Flag.withDescription("Immutable Squad revision to execute."),
);

const projectFlag = Flag.string("project").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Project id that owns the execution."),
);

const threadIdFlag = Flag.string("thread-id").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Optional thread id associated with the execution."),
  Flag.optional,
);

const goalFlag = Flag.string("goal").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Goal for the Squad leader and members."),
);

const workspaceRootFlag = Flag.string("workspace-root").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Workspace root available to the Squad."),
  Flag.withDefault(process.cwd()),
);

const workspaceRootDigestFlag = Flag.string("workspace-root-digest").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Optional stable workspace identity digest."),
  Flag.optional,
);

const planFileFlag = Flag.string("plan-file").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Optional JSON file containing explicit Squad plan nodes."),
  Flag.optional,
);

const newSquadIdFlag = Flag.string("id").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("New composition squad id."),
);

const squadNameFlag = Flag.string("name").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("New composition squad name."),
);

const expectedRevisionFlag = Flag.integer("expected-revision").pipe(
  Flag.withSchema(PositiveInt),
  Flag.withDescription("Current revision required for optimistic concurrency."),
);

const configFileFlag = Flag.string("config").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("JSON file validated against the Code Work Squad contract."),
);

const squadListCommand = Command.make("list", {
  server: serverFlag,
  accessToken: accessTokenFlag,
  includeArchived: includeArchivedFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List composition squads."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* listSquads({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        includeArchived: flags.includeArchived,
      });
      yield* Console.log(formatSquadList(result, flags.json));
    }),
  ),
);

const squadGetCommand = Command.make("get", {
  squadId: squadIdArgument,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Get one composition squad."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* getSquad({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        squadId: flags.squadId,
      });
      yield* Console.log(formatSquadDetails(result, flags.json));
    }),
  ),
);

const squadRevisionsCommand = Command.make("revisions", {
  squadId: squadIdArgument,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List immutable composition squad revisions."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* listSquadRevisions({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        squadId: flags.squadId,
      });
      yield* Console.log(formatSquadRevisions(result, flags.json));
    }),
  ),
);

const squadRunCommand = Command.make("run", {
  squadId: squadIdArgument,
  server: serverFlag,
  accessToken: accessTokenFlag,
  executionId: executionIdFlag,
  revision: revisionFlag,
  project: projectFlag,
  threadId: threadIdFlag,
  goal: goalFlag,
  workspaceRoot: workspaceRootFlag,
  workspaceRootDigest: workspaceRootDigestFlag,
  planFile: planFileFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Run a composition squad with a stable execution id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const executionId = Option.getOrElse(flags.executionId, NodeCrypto.randomUUID);
      const plan = Option.isSome(flags.planFile)
        ? yield* readSquadPlanFile(flags.planFile.value)
        : undefined;
      yield* Console.error(`Execution ID: ${executionId}`);
      const result = yield* runSquad({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        executionId,
        squadId: flags.squadId,
        squadRevision: flags.revision,
        projectId: flags.project,
        ...(Option.isSome(flags.threadId) ? { threadId: flags.threadId.value } : {}),
        goal: flags.goal,
        workspaceRoot: flags.workspaceRoot,
        ...(Option.isSome(flags.workspaceRootDigest)
          ? { workspaceRootDigest: flags.workspaceRootDigest.value }
          : {}),
        ...(plan === undefined ? {} : { plan }),
      });
      yield* Console.log(formatSquadExecutionResult(result, flags.json));
    }),
  ),
);

const squadDuplicateCommand = Command.make("duplicate", {
  sourceSquadId: squadIdArgument,
  squadId: newSquadIdFlag,
  name: squadNameFlag,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Duplicate a composition squad into a new id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* duplicateSquad({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        sourceSquadId: flags.sourceSquadId,
        squadId: flags.squadId,
        name: flags.name,
      });
      yield* Console.log(formatSquadDetails(result, flags.json));
    }),
  ),
);

const makeSquadRevisionCommand = (
  name: "archive" | "restore",
  description: string,
  mutate: typeof archiveSquad,
) =>
  Command.make(name, {
    squadId: squadIdArgument,
    expectedRevision: expectedRevisionFlag,
    server: serverFlag,
    accessToken: accessTokenFlag,
    json: jsonFlag,
  }).pipe(
    Command.withDescription(description),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const result = yield* mutate({
          serverUrl: flags.server,
          ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
          squadId: flags.squadId,
          expectedRevision: flags.expectedRevision,
        });
        yield* Console.log(formatSquadDetails(result, flags.json));
      }),
    ),
  );

const squadArchiveCommand = makeSquadRevisionCommand(
  "archive",
  "Archive a composition squad at an expected revision.",
  archiveSquad,
);

const squadRestoreCommand = makeSquadRevisionCommand(
  "restore",
  "Restore a composition squad at an expected revision.",
  restoreSquad,
);

const squadCreateCommand = Command.make("create", {
  config: configFileFlag,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a composition squad from a validated JSON config."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* readSquadConfigText(flags.config).pipe(
        Effect.flatMap(decodeSquadCreateConfigText),
      );
      const result = yield* createSquad({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        input,
      });
      yield* Console.log(formatSquadDetails(result, flags.json));
    }),
  ),
);

const squadUpdateCommand = Command.make("update", {
  config: configFileFlag,
  server: serverFlag,
  accessToken: accessTokenFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Update a composition squad from a validated JSON config."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const input = yield* readSquadConfigText(flags.config).pipe(
        Effect.flatMap(decodeSquadUpdateConfigText),
      );
      const result = yield* updateSquad({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        input,
      });
      yield* Console.log(formatSquadDetails(result, flags.json));
    }),
  ),
);

export const squadCommand = Command.make("squad").pipe(
  Command.withDescription("Manage composition squads."),
  Command.withSubcommands([
    squadListCommand,
    squadGetCommand,
    squadRevisionsCommand,
    squadRunCommand,
    squadDuplicateCommand,
    squadArchiveCommand,
    squadRestoreCommand,
    squadCreateCommand,
    squadUpdateCommand,
  ]),
);
