import { TrimmedNonEmptyString } from "@codework/contracts";
import { Argument, Flag } from "effect/cli";

export const controlServerFlag = Flag.String("server").pipe(
  Flag.withDescription("Code Work server URL or pairing link."),
  Flag.withDefault("http://127.0.0.1:3773"),
);

export const controlAccessTokenFlag = Flag.String("access-token").pipe(
  Flag.withDescription("Scoped bearer access token. Prefer a short-lived token."),
  Flag.optional,
);

export const controlJsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

export const agentIdArgument = Argument.String("agent-id").pipe(
  Argument.withSchema(TrimmedNonEmptyString),
  Argument.withDescription("Agent id backed by an orchestration thread id."),
);
