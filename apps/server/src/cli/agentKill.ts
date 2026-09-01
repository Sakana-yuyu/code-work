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
import { formatAgentKillResult } from "./agentControlKillOutput.ts";
import { killAgent } from "./agentControlKillRpc.ts";

export const agentKillCommand = Command.make("kill", {
  agentId: agentIdArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Interrupt an agent's active orchestration turn."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* killAgent({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
      });
      yield* Console.log(formatAgentKillResult(result, flags.json));
    }),
  ),
);
