import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const IMAGE_GENERATE_PROMPT_MAX_LENGTH = 4_000;
export const IMAGE_GENERATE_FILE_NAME_MAX_LENGTH = 80;

export const ImageGenerateSize = Schema.Literals(["1024x1024", "1024x1536", "1536x1024", "auto"]);
export type ImageGenerateSize = typeof ImageGenerateSize.Type;

/**
 * Universal image generation for every provider session: the Code Work MCP
 * server exposes this tool to all agents (Codex, Claude, Cursor, Grok,
 * OpenCode). Generation runs through a Custom model service (BYOK) adapter's
 * OpenAI-compatible key and the bitmap lands inside the caller's workspace so
 * the timeline can render it inline.
 */
export const ImageGenerateInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  prompt: TrimmedString.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(IMAGE_GENERATE_PROMPT_MAX_LENGTH),
  ),
  size: Schema.optional(ImageGenerateSize),
  /** Image model for vendors with more than one; defaults to gpt-image-2. */
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  /** File name (without extension); defaults to a slug of the prompt. */
  fileName: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(IMAGE_GENERATE_FILE_NAME_MAX_LENGTH)),
  ),
  /** BYOK adapter whose key/endpoint to use; default: first usable OpenAI-compatible adapter. */
  adapterId: Schema.optional(TrimmedNonEmptyString),
});
export type ImageGenerateInput = typeof ImageGenerateInput.Type;

export const ImageGenerateResult = Schema.Struct({
  /** Absolute save path inside the caller's workspace. */
  imagePath: TrimmedNonEmptyString,
  /** Same file relative to the workspace root. */
  relativePath: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  revisedPrompt: Schema.optional(TrimmedString),
});
export type ImageGenerateResult = typeof ImageGenerateResult.Type;

export const IMAGE_GENERATE_FAILURE_REASONS = [
  "no_adapter",
  "request_failed",
  "empty_response",
  "write_failed",
] as const;

export class ImageGenerateError extends Schema.TaggedErrorClass<ImageGenerateError>()(
  "ImageGenerateError",
  {
    reason: Schema.Literals(IMAGE_GENERATE_FAILURE_REASONS),
    message: TrimmedNonEmptyString,
  },
) {}
