import { TrimmedNonEmptyString } from "@codework/contracts";
import { Argument, Flag } from "effect/unstable/cli";

export const controlServerFlag = Flag.string("server").pipe(
  Flag.withDescription("Code Work server URL or pairing link."),
  Flag.withDefault("http://127.0.0.1:3773"),
);

export const controlAccessTokenFlag = Flag.string("access-token").pipe(
  Flag.withDescription("Scoped bearer access token. Prefer a short-lived token."),
  Flag.optional,
);

export const controlJsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

export const agentIdArgument = Argument.string("agent-id").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Agent id backed by an orchestration thread id."),
);
