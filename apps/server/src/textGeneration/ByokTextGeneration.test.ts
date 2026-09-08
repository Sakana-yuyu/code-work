import { expect, it } from "@effect/vitest";
import { ByokSettings, ProviderInstanceId } from "@codework/contracts";
import { createModelSelection } from "@codework/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeByokTextGeneration } from "./ByokTextGeneration.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeUnknownSync(ByokSettings);

it.effect.each(["openai", "anthropic", "gemini"] as const)(
  "BYOK 标题生成使用文字和附件名称，不因附图而拒绝请求：%s",
  (protocol) =>
    Effect.gen(function* () {
      const output = encodeJson({ title: "鹈鹕骑行二维动画" });
      const events =
        protocol === "openai"
          ? [{ choices: [{ delta: { content: output }, finish_reason: "stop" }] }]
          : protocol === "anthropic"
            ? [
                { type: "content_block_delta", delta: { type: "text_delta", text: output } },
                { type: "message_delta", delta: { stop_reason: "end_turn" } },
                { type: "message_stop" },
              ]
            : [{ candidates: [{ content: { parts: [{ text: output }] }, finishReason: "STOP" }] }];
      const bodies: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body instanceof HttpBody.Uint8Array) {
            bodies.push(new TextDecoder().decode(request.body.body));
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(events.map((event) => `data: ${encodeJson(event)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            }),
          );
        }),
      );
      const settings = decodeSettings({
        enabled: true,
        adapters: [
          {
            id: "route",
            displayName: "测试模型",
            modelId: "test-model",
            protocol,
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
          },
        ],
      });
      const generation = yield* makeByokTextGeneration(settings).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const result = yield* generation.generateThreadTitle({
        cwd: process.cwd(),
        message: "创建鹈鹕骑自行车的二维动画",
        attachments: [
          {
            type: "image",
            id: "preview",
            name: "pelican-preview.png",
            mimeType: "image/png",
            sizeBytes: 10,
          },
        ],
        modelSelection: createModelSelection(ProviderInstanceId.make("byok"), "route"),
      });
      expect(result.title).toBe("鹈鹕骑行二维动画");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain("pelican-preview.png");
      expect(bodies[0]).toContain("创建鹈鹕骑自行车的二维动画");
    }),
);
