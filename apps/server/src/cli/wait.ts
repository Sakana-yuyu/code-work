import { PositiveInt } from "@codework/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";

import {
  agentIdArgument,
  controlAccessTokenFlag,
  controlJsonFlag,
  controlServerFlag,
} from "./agentControlFlags.ts";
import { formatAgentStatus } from "./agentControlOutput.ts";
import { waitForAgent } from "./agentControlRpc.ts";

const timeoutSecondsFlag = Flag.integer("timeout-seconds").pipe(
  Flag.withSchema(PositiveInt),
  Flag.withDescription("Maximum seconds to wait before returning an error."),
  Flag.optional,
);

export const waitCommand = Command.make("wait", {
  agentId: agentIdArgument,
  timeoutSeconds: timeoutSecondsFlag,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Wait for an agent's latest turn to reach a terminal state."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const status = yield* waitForAgent({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        ...(Option.isSome(flags.timeoutSeconds)
          ? { timeoutSeconds: flags.timeoutSeconds.value }
          : {}),
        agentId: flags.agentId,
      });
      yield* Console.log(formatAgentStatus(status, flags.json));
    }),
  ),
);
