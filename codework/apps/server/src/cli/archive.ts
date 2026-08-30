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
import { formatAgentArchiveResult } from "./agentControlArchiveOutput.ts";
import { archiveAgent } from "./agentControlArchiveRpc.ts";

export const archiveCommand = Command.make("archive", {
  agentId: agentIdArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Archive an agent thread through orchestration."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* archiveAgent({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
      });
      yield* Console.log(formatAgentArchiveResult(result, flags.json));
    }),
  ),
);
