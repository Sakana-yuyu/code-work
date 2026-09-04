import { ImageGenerateError, ImageGenerateInput, ImageGenerateResult } from "@codework/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as ServerSettings from "../../../serverSettings.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";

export const ImageGenerateTool = Tool.make("image_generate", {
  description:
    "Generate a raster image from a text prompt and save it into the caller's workspace under generated-images/. Use it whenever the user asks for a photo, illustration, mockup, texture, or any AI-created bitmap. Requires a Custom model service (BYOK) adapter with an OpenAI-compatible key configured in Code Work settings; pass `model` matching the adapter's vendor (e.g. gpt-image-2 for OpenAI-compatible gateways, grok-imagine-image-2.0 for xAI) or omit it to use the vendor default. The result carries imagePath (absolute) and relativePath — reference the file from there and tell the user where it was saved.",
  parameters: ImageGenerateInput,
  success: ImageGenerateResult,
  failure: Schema.Union([ImageGenerateError]),
  dependencies: [
    HttpClient.HttpClient,
    ServerSettings.ServerSettingsService,
    WorkspacePaths.WorkspacePaths,
  ],
})
  .annotate(Tool.Title, "Generate an image")
  .annotate(Tool.Destructive, false);

export const ImagegenToolkit = Toolkit.make(ImageGenerateTool);
