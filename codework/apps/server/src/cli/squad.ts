import {
  type CompositionSquadListResult,
  type CompositionSquadRevisionListResult,
  type CompositionSquadResult,
  WS_METHODS,
} from "@codework/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
  const date = new Date(unixMs);
  return Number.isNaN(date.getTime()) ? String(unixMs) : date.toISOString();
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

export const squadCommand = Command.make("squad").pipe(
  Command.withDescription("Manage composition squads."),
  Command.withSubcommands([squadListCommand, squadGetCommand, squadRevisionsCommand]),
);
