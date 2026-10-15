import * as Schema from "effect/Schema";

export const DraftComposerImageAttachmentSchema = Schema.Struct({
  id: Schema.String,
  previewUri: Schema.String,
  type: Schema.Literal("image"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});

/**
 * A generic file staged in a draft or queued message. The bytes live in an
 * app-owned copy (`fileUri`) until delivery uploads them; the upload ids are
 * written back so a retried delivery reuses the server copy.
 */
export const DraftComposerFileAttachmentSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("file"),
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  fileUri: Schema.String,
  uploadedAttachmentId: Schema.optionalKey(Schema.String),
  uploadEnvironmentId: Schema.optionalKey(Schema.String),
});

export const DraftComposerAttachmentSchema = Schema.Union([
  DraftComposerImageAttachmentSchema,
  DraftComposerFileAttachmentSchema,
]);
