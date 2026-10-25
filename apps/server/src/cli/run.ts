import { ProviderInstanceId, TrimmedNonEmptyString } from "@codework/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { controlAccessTokenFlag, controlJsonFlag, controlServerFlag } from "./agentControlFlags.ts";
import { formatAgentRunResult } from "./agentControlRunOutput.ts";
import { runAgent } from "./agentControlRunRpc.ts";

const promptArgument = Argument.String("prompt").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Prompt text for the new agent's first turn."),
);

const projectFlag = Flag.String("project").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Project id that owns the new agent thread."),
);

const providerFlag = Flag.String("provider").pipe(
  Flag.withSchema(ProviderInstanceId),
  Flag.withDescription("Provider instance id; requires --model."),
  Flag.optional,
);

const modelFlag = Flag.String("model").pipe(
  Flag.withSchema(TrimmedNonEmptyString),
  Flag.withDescription("Model name; requires --provider."),
  Flag.optional,
);

export const runCommand = Command.make("run", {
  prompt: promptArgument,
  project: projectFlag,
  provider: providerFlag,
  model: modelFlag,
  server: controlServerFlag,
  accessToken: controlAccessTokenFlag,
  json: controlJsonFlag,
}).pipe(
  Command.withDescription("Create an agent thread and start its first turn."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const result = yield* runAgent({
        serverUrl: flags.server,
        ...(Option.isSome(flags.accessToken) ? { accessToken: flags.accessToken.value } : {}),
        projectId: flags.project,
        prompt: flags.prompt,
        ...(Option.isSome(flags.provider) ? { providerInstanceId: flags.provider.value } : {}),
        ...(Option.isSome(flags.model) ? { model: flags.model.value } : {}),
      });
      yield* Console.log(formatAgentRunResult(result, flags.json));
    }),
  ),
);
