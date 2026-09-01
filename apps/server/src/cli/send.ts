import { TrimmedNonEmptyString } from "@codework/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command } from "effect/unstable/cli";

import {
  agentIdArgument,
  controlAccessTokenFlag,
  controlJsonFlag,
  controlServerFlag,
} from "./agentControlFlags.ts";
import { formatAgentSendResult } from "./agentControlSendOutput.ts";
import { sendToAgent } from "./agentControlSendRpc.ts";

const promptArgument = Argument.string("prompt").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Prompt text to send to the idle agent."),
);

export const sendCommand = Command.make("send", {
  agentId: agentIdArgument,
  prompt: promptArgument,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Send a new prompt to an idle agent thread."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* sendToAgent({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        agentId: flags.agentId,
        prompt: flags.prompt,
      });
      yield* Console.log(formatAgentSendResult(result, flags.json));
    }),
  ),
);
