// @effect-diagnostics nodeBuiltinImport:off
import type { ImageGenerateInput, ImageGenerateResult } from "@codework/contracts";
import { ImageGenerateError } from "@codework/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSettings from "../../../serverSettings.ts";
import { gatewayAdapterRoutes } from "../../../provider/byok/modelGateway.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import { collectUint8StreamText } from "../../../stream/collectUint8StreamText.ts";

import { ImagegenToolkit } from "./tools.ts";

/** Default image model for OpenAI-compatible images endpoints. */
export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
/** xAI's image line differs from OpenAI's; this model accepts the size parameter. */
export const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image-2.0";
const GENERATED_IMAGES_DIRECTORY = "generated-images";
/** b64 of a 1024x1024 PNG can reach several MB; cap generously but bounded. */
const IMAGE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

export interface ImagegenAdapterRoute {
  readonly id: string;
  readonly baseURL: string;
  readonly apiKey: string;
}

/**
 * xAI's images endpoint is OpenAI-shaped but rejects `size` on every model
 * except Imagine Image 2.0, so those requests need a per-vendor plan.
 */
export const isXaiImagesHost = (baseURL: string): boolean =>
  /\/\/api\.x\.ai(?:\/|:|$)/u.test(baseURL.trim().toLowerCase());

/**
 * Resolve the effective image model and request body for a BYOK route:
 * vendor-appropriate model default, and `size` only where it is supported.
 */
export function planImageRequest(
  input: Pick<ImageGenerateInput, "model" | "prompt" | "size">,
  baseURL: string,
): { readonly model: string; readonly body: Record<string, unknown> } {
  const xai = isXaiImagesHost(baseURL);
  const model = input.model?.trim() || (xai ? XAI_DEFAULT_IMAGE_MODEL : DEFAULT_IMAGE_MODEL);
  const size = input.size !== undefined && input.size !== "auto" ? input.size : undefined;
  return {
    model,
    body: {
      model,
      prompt: input.prompt,
      n: 1,
      ...(size !== undefined && (!xai || model === XAI_DEFAULT_IMAGE_MODEL) ? { size } : {}),
    },
  };
}

/**
 * First usable OpenAI-compatible adapter route (images endpoints are
 * OpenAI-shaped), or the one matching `preferredId`. Anthropic/Gemini routes
 * cannot serve image generation.
 */
export function pickImageAdapter(
  routes: ReadonlyArray<{ id: string; protocol: string; baseURL: string; apiKey: string }>,
  preferredId: string | undefined,
): ImagegenAdapterRoute | null {
  const usable = routes.filter(
    (route) => route.protocol === "openai" && route.apiKey.trim().length > 0,
  );
  if (preferredId !== undefined && preferredId.length > 0) {
    return usable.find((route) => route.id === preferredId) ?? null;
  }
  return usable[0] ?? null;
}

/** Safe file stem for the saved bitmap: explicit name or prompt slug. */
export function imageFileStem(prompt: string, fileName: string | undefined, nowMs: number): string {
  const source = (fileName ?? prompt).trim();
  const slug =
    source
      .replace(/[^\p{Letter}\p{Number}_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 60) || "image";
  // @effect-diagnostics-next-line globalDate:off - pure formatter over the injected timestamp.
  return `${new Date(nowMs).toISOString().replace(/[-:]/g, "").slice(0, 15)}-${slug}`;
}

/** Pull base64 bytes (or a hosted URL) plus the revised prompt out of an images-API response body. */
export function parseImageGenerationResponse(body: unknown): {
  readonly base64: string | null;
  readonly url: string | null;
  readonly revisedPrompt: string | null;
} {
  if (body === null || typeof body !== "object") {
    return { base64: null, url: null, revisedPrompt: null };
  }
  const data = (body as { data?: unknown }).data;
  const first = Array.isArray(data) ? data[0] : undefined;
  if (first === null || typeof first !== "object") {
    return { base64: null, url: null, revisedPrompt: null };
  }
  const entry = first as { b64_json?: unknown; url?: unknown; revised_prompt?: unknown };
  return {
    base64: typeof entry.b64_json === "string" && entry.b64_json.length > 0 ? entry.b64_json : null,
    url: typeof entry.url === "string" && entry.url.length > 0 ? entry.url : null,
    revisedPrompt:
      typeof entry.revised_prompt === "string" && entry.revised_prompt.length > 0
        ? entry.revised_prompt
        : null,
  };
}

const imagesUrl = (baseURL: string): string =>
  `${baseURL
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\/chat\/completions$/u, "")}/images/generations`;

const noAdapterError = (): ImageGenerateError =>
  new ImageGenerateError({
    reason: "no_adapter",
    message:
      "No Custom model service (BYOK) adapter with an OpenAI-compatible API key is configured. Add one in Settings > Custom model services first.",
  });

const handlers = {
  image_generate: (input: ImageGenerateInput) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
      if (settings === null) {
        return yield* noAdapterError();
      }
      const route = pickImageAdapter(gatewayAdapterRoutes(settings), input.adapterId);
      if (route === null) {
        return yield* noAdapterError();
      }
      const client = yield* HttpClient.HttpClient;
      const plan = planImageRequest(input, route.baseURL);
      const request = yield* HttpClientRequest.post(imagesUrl(route.baseURL)).pipe(
        HttpClientRequest.setHeader("authorization", `Bearer ${route.apiKey}`),
        HttpClientRequest.setHeader("content-type", "application/json"),
        HttpClientRequest.bodyJson(plan.body),
        Effect.orElseSucceed(() => null),
      );
      if (request === null) {
        return yield* new ImageGenerateError({
          reason: "request_failed",
          message: "The image request could not be built.",
        });
      }
      const response = yield* client.execute(request).pipe(
        Effect.orElseSucceed(() => null),
        Effect.timeoutOption(IMAGE_REQUEST_TIMEOUT_MS),
      );
      const httpResponse =
        Option.isNone(response) || response.value === null ? null : response.value;
      if (httpResponse === null) {
        return yield* new ImageGenerateError({
          reason: "request_failed",
          message: `The image request to ${route.baseURL} failed or timed out.`,
        });
      }
      if (httpResponse.status < 200 || httpResponse.status >= 300) {
        const failure = yield* collectUint8StreamText({
          stream: httpResponse.stream,
          maxBytes: 64 * 1024,
        }).pipe(Effect.orElseSucceed(() => null));
        return yield* new ImageGenerateError({
          reason: "request_failed",
          message: `The image endpoint returned HTTP ${httpResponse.status}${
            failure && failure.text.length > 0 ? `: ${failure.text.slice(0, 400)}` : ""
          }`,
        });
      }
      const bodyText = yield* collectUint8StreamText({
        stream: httpResponse.stream,
        maxBytes: IMAGE_RESPONSE_MAX_BYTES,
      }).pipe(Effect.orElseSucceed(() => null));
      if (bodyText === null) {
        return yield* new ImageGenerateError({
          reason: "empty_response",
          message: "The image response could not be read.",
        });
      }
      const parsedBody = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        bodyText.text,
      ).pipe(Effect.orElseSucceed(() => null));
      if (parsedBody === null) {
        return yield* new ImageGenerateError({
          reason: "empty_response",
          message: "The image endpoint returned a non-JSON response.",
        });
      }
      const parsed = parseImageGenerationResponse(parsedBody);
      if (parsed.base64 === null) {
        // URL-only responses would need a second authenticated fetch against an
        // arbitrary host; refuse rather than leak the key or skip the file.
        return yield* new ImageGenerateError({
          reason: "empty_response",
          message:
            parsed.url !== null
              ? "The image endpoint returned a hosted URL instead of image bytes; configure it to return b64_json."
              : "The image endpoint returned no image data.",
        });
      }

      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const nowMs = yield* Clock.currentTimeMillis;
      const relativePath = `${GENERATED_IMAGES_DIRECTORY}/${imageFileStem(
        input.prompt,
        input.fileName,
        nowMs,
      )}.png`;
      const resolved = yield* workspacePaths
        .resolveRelativePathWithinRoot({ workspaceRoot: input.cwd, relativePath })
        .pipe(Effect.orElseSucceed(() => null));
      if (resolved === null) {
        return yield* new ImageGenerateError({
          reason: "write_failed",
          message: "The image save path escapes the workspace.",
        });
      }
      const bytes = Buffer.from(parsed.base64, "base64");
      yield* Effect.tryPromise({
        try: () =>
          NodeFSP.mkdir(NodePath.dirname(resolved.absolutePath), { recursive: true }).then(() =>
            NodeFSP.writeFile(resolved.absolutePath, bytes),
          ),
        catch: () =>
          new ImageGenerateError({
            reason: "write_failed",
            message: `Saving the generated image to ${resolved.relativePath} failed.`,
          }),
      });

      const result: ImageGenerateResult = {
        imagePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
        model: plan.model,
        ...(parsed.revisedPrompt !== null ? { revisedPrompt: parsed.revisedPrompt } : {}),
      };
      return result;
    }).pipe(Effect.annotateLogs({ tool: "image_generate" })),
} satisfies Parameters<typeof ImagegenToolkit.toLayer>[0];

export const ImagegenToolkitHandlersLive = ImagegenToolkit.toLayer(handlers);
