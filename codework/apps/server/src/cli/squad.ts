import { type CompositionSquadListResult, WS_METHODS } from "@codework/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  type ControlClientOpen,
  type ControlConnectionOptions,
  openControlClient,
} from "./controlClient.ts";

export interface ListSquadsOptions extends ControlConnectionOptions {
  readonly includeArchived: boolean;
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

export const squadCommand = Command.make("squad").pipe(
  Command.withDescription("Manage composition squads."),
  Command.withSubcommands([squadListCommand]),
);
