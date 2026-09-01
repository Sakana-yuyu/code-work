import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import {
  agentIdArgument,
  controlAccessTokenFlag,
  controlJsonFlag,
  controlServerFlag,
} from "./agentControlFlags.ts";
import { formatAgentLogs } from "./agentControlOutput.ts";
import { getAgentLogs } from "./agentControlRpc.ts";

export const logsCommand = Command.make("logs", {
  agentId: agentIdArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Read an agent message log snapshot."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logs = yield* getAgentLogs({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
      });
      yield* Console.log(formatAgentLogs(logs, flags.json));
    }),
  ),
);
