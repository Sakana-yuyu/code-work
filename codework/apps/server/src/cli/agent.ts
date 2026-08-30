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
import { formatAgentStatus } from "./agentControlOutput.ts";
import { getAgentStatus } from "./agentControlRpc.ts";

const agentStatusCommand = Command.make("status", {
  agentId: agentIdArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Read one agent's authoritative orchestration status."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const status = yield* getAgentStatus({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
      });
      yield* Console.log(formatAgentStatus(status, flags.json));
    }),
  ),
);

export const agentCommand = Command.make("agent").pipe(
  Command.withDescription("Inspect and control coding agents."),
  Command.withSubcommands([agentStatusCommand]),
);
