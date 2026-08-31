import * as Schema from "effect/Schema";

const ServerSettingsOriginCasFixtureMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    token: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    tag: Schema.Literals(["Committed", "Conflict"]),
    value: Schema.optionalKey(Schema.String),
  }),
]);

export type ServerSettingsOriginCasFixtureMessage =
  typeof ServerSettingsOriginCasFixtureMessage.Type;

export const encodeServerSettingsOriginCasFixtureMessage = Schema.encodeSync(
  Schema.fromJsonString(ServerSettingsOriginCasFixtureMessage),
);

export const decodeServerSettingsOriginCasFixtureMessage = Schema.decodeUnknownSync(
  Schema.fromJsonString(ServerSettingsOriginCasFixtureMessage),
);
