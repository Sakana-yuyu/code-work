import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const ExternalSessionScanRequest = Schema.Struct({ projectId: ProjectId });
export const ExternalSessionImportRequest = Schema.Struct({
  projectId: ProjectId,
  sessionId: Schema.String,
});
export const ExternalSessionCandidate = Schema.Struct({
  id: Schema.String,
  provider: Schema.Literals(["codex", "claudeAgent"]),
  title: Schema.String,
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  canResume: Schema.Boolean,
  imported: Schema.Boolean,
});
export const ExternalSessionScanResult = Schema.Struct({
  sessions: Schema.Array(ExternalSessionCandidate),
  error: Schema.NullOr(Schema.String),
});
export const ExternalSessionImportResult = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  imported: Schema.Boolean,
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
