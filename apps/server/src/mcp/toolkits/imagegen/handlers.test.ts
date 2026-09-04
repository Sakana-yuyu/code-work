import { describe, expect, it } from "vite-plus/test";

import {
  imageFileStem,
  isXaiImagesHost,
  parseImageGenerationResponse,
  pickImageAdapter,
  planImageRequest,
  type ImagegenAdapterRoute,
} from "./handlers.ts";

const route = (id: string, protocol: string, apiKey = "sk-test"): ImagegenAdapterRoute => ({
  id,
  protocol,
  baseURL: `https://${id}.example.com/v1`,
  apiKey,
});

describe("pickImageAdapter", () => {
  it("requires an OpenAI protocol and a non-empty key", () => {
    const routes = [
      route("anthropic", "anthropic"),
      route("nokey", "openai", "   "),
      route("good", "openai"),
    ];
    expect(pickImageAdapter(routes, undefined)?.id).toBe("good");
    expect(pickImageAdapter([], undefined)).toBeNull();
    expect(pickImageAdapter([route("anthropic", "anthropic")], undefined)).toBeNull();
  });

  it("honors the preferred adapter only when it is usable", () => {
    const routes = [route("first", "openai"), route("second", "openai")];
    expect(pickImageAdapter(routes, "second")?.id).toBe("second");
    expect(pickImageAdapter(routes, "missing")).toBeNull();
  });
});

describe("imageFileStem", () => {
  it("prefers the explicit file name and slugs unsafe characters", () => {
    expect(imageFileStem("ignored prompt", "My Logo v2!.png", 0)).toMatch(
      /^19700101T000000-My-Logo-v2-png$/u,
    );
  });

  it("falls back to a bounded prompt slug and to the bare stem when nothing survives", () => {
    const stem = imageFileStem("画 一张 封面!!!", undefined, Date.UTC(2026, 8, 3, 1, 2, 3));
    expect(stem.startsWith("20260903T010203-")).toBe(true);
    expect(stem.endsWith("画-一张-封面")).toBe(true);
    expect(imageFileStem("!!!", undefined, 0)).toBe("19700101T000000-image");
  });

  it("bounds the slug length", () => {
    const stem = imageFileStem("x".repeat(300), undefined, 0);
    expect(stem.length).toBeLessThanOrEqual("19700101T000000-".length + 60);
  });
});

describe("planImageRequest", () => {
  it("defaults to gpt-image-2 and passes size through on generic hosts", () => {
    const plan = planImageRequest(
      { prompt: "a cat", size: "1024x1536" },
      "https://api.openai.com/v1",
    );
    expect(plan.model).toBe("gpt-image-2");
    expect(plan.body).toEqual({ model: "gpt-image-2", prompt: "a cat", n: 1, size: "1024x1536" });
  });

  it("omits size when the caller leaves it on auto", () => {
    expect(
      planImageRequest({ prompt: "a cat", size: "auto" }, "https://gw.example.com/v1").body,
    ).toEqual({
      model: "gpt-image-2",
      prompt: "a cat",
      n: 1,
    });
  });

  it("defaults xAI hosts to the Grok image model", () => {
    const plan = planImageRequest({ prompt: "a cat" }, "https://api.x.ai/v1");
    expect(plan.model).toBe("grok-imagine-image-2.0");
    expect(plan.body.model).toBe("grok-imagine-image-2.0");
  });

  it("strips size for xAI models that reject it but keeps it for Imagine Image 2.0", () => {
    const legacy = planImageRequest(
      { prompt: "a cat", size: "1024x1024", model: "grok-2-image" },
      "https://api.x.ai/v1",
    );
    expect(legacy.body).toEqual({ model: "grok-2-image", prompt: "a cat", n: 1 });
    const modern = planImageRequest(
      { prompt: "a cat", size: "1024x1024", model: "grok-imagine-image-2.0" },
      "https://api.x.ai/v1",
    );
    expect(modern.body).toEqual({
      model: "grok-imagine-image-2.0",
      prompt: "a cat",
      n: 1,
      size: "1024x1024",
    });
  });

  it("only treats the xAI API origin as xAI", () => {
    expect(isXaiImagesHost("https://api.x.ai/v1")).toBe(true);
    expect(isXaiImagesHost("https://api.x.ai:8443/v1")).toBe(true);
    expect(isXaiImagesHost("https://xai.example.com/v1")).toBe(false);
    expect(isXaiImagesHost("https://api.openai.com/v1")).toBe(false);
  });
});

describe("parseImageGenerationResponse", () => {
  it("extracts b64 bytes and the revised prompt", () => {
    expect(
      parseImageGenerationResponse({
        data: [{ b64_json: "aGVsbG8=", revised_prompt: "a better prompt" }],
      }),
    ).toEqual({ base64: "aGVsbG8=", url: null, revisedPrompt: "a better prompt" });
  });

  it("surfaces hosted-URL-only responses so the caller can refuse them", () => {
    expect(
      parseImageGenerationResponse({ data: [{ url: "https://cdn.example.com/x.png" }] }),
    ).toEqual({
      base64: null,
      url: "https://cdn.example.com/x.png",
      revisedPrompt: null,
    });
  });

  it("returns nulls for malformed bodies instead of throwing", () => {
    expect(parseImageGenerationResponse("nope")).toEqual({
      base64: null,
      url: null,
      revisedPrompt: null,
    });
    expect(parseImageGenerationResponse({ data: [] })).toEqual({
      base64: null,
      url: null,
      revisedPrompt: null,
    });
    expect(parseImageGenerationResponse(null)).toEqual({
      base64: null,
      url: null,
      revisedPrompt: null,
    });
  });
});
