import * as Console from "effect/Console";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";

import {
  agentIdArgument,
  controlAccessTokenFlag,
  controlJsonFlag,
  controlServerFlag,
} from "./agentControlFlags.ts";
import { formatAgentAttachFrame } from "./agentControlAttachOutput.ts";
import { attachToAgent } from "./agentControlAttachRpc.ts";

export const attachCommand = Command.make("attach", {
  agentId: agentIdArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Attach to an agent and stream message updates until terminal state."),
  Command.withHandler((flags) =>
    attachToAgent(
      {
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
      },
      (frame) => Console.log(formatAgentAttachFrame(frame, flags.json)),
    ),
  ),
);
