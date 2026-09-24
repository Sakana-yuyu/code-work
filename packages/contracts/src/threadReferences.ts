import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const ThreadReferenceRequest = Schema.Struct({ threadId: ThreadId });
export const ThreadReferenceResult = Schema.Struct({
  threadId: ThreadId,
  projectId: Schema.NullOr(ProjectId),
  title: Schema.NullOr(Schema.String),
  excerpt: Schema.String,
  truncated: Schema.Boolean,
  error: Schema.NullOr(Schema.Literals(["thread-not-found", "thread-empty"])),
});
