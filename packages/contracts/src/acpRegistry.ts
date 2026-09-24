import * as Schema from "effect/Schema";

export const AcpRegistryCatalogEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  version: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  availability: Schema.Literals(["installable", "manual", "unsupported-platform"]),
});
export type AcpRegistryCatalogEntry = typeof AcpRegistryCatalogEntry.Type;

export const AcpRegistryCatalogResult = Schema.Struct({
  entries: Schema.Array(AcpRegistryCatalogEntry),
  error: Schema.NullOr(Schema.String),
});
export type AcpRegistryCatalogResult = typeof AcpRegistryCatalogResult.Type;
