// @effect-diagnostics nodeBuiltinImport:off - 核对隔离附件目录的实际字节与故障。
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { storeProviderImageAttachment } from "./ProviderImageAttachment.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "codework-provider-image-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
const image = { mimeType: "image/png", data: png };

it.effect("图片原子保存，事件重试不重复，规范化相似线程仍隔离", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const first = yield* storeProviderImageAttachment(ThreadId.make("thread/A"), "event", image);
    const repeat = yield* storeProviderImageAttachment(ThreadId.make("thread/A"), "event", image);
    const other = yield* storeProviderImageAttachment(ThreadId.make("thread-A"), "event", image);
    expect(repeat).toEqual(first);
    if (!first.attachment || !other.attachment) throw new Error("图片未保存");
    expect(first.attachment.id).not.toEqual(other.attachment.id);
    expect(NodeFS.readdirSync(config.attachmentsDir)).toHaveLength(2);
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${first.attachment.id}.png`)),
    ).toEqual(Buffer.from(png, "base64"));
  }).pipe(Effect.provide(layer)),
);

it.effect("拒绝不支持类型、非法编码、伪造签名和过大图片，边界不截断", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    for (const invalid of [
      { mimeType: "image/svg+xml", data: png },
      { mimeType: "image/jpeg", data: png },
      { mimeType: "image/png", data: "" },
      { mimeType: "image/png", data: "!!!!" },
      { mimeType: "image/png", data: "AA=A" },
      { mimeType: "image/png", data: "AB==" },
      {
        mimeType: "image/png",
        data: "A".repeat(Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4 + 1),
      },
    ])
      expect(
        yield* storeProviderImageAttachment(ThreadId.make("thread-1"), "invalid", invalid),
      ).toHaveProperty("error");
    expect(NodeFS.readdirSync(config.attachmentsDir)).toEqual([]);
    const boundary = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    Buffer.from(png, "base64").copy(boundary);
    const result = yield* storeProviderImageAttachment(ThreadId.make("thread-1"), "boundary", {
      mimeType: "image/png",
      data: boundary.toString("base64"),
    });
    expect(result.attachment?.sizeBytes).toBe(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    const tooLarge = Buffer.concat([boundary, Buffer.from([0])]);
    expect(
      yield* storeProviderImageAttachment(ThreadId.make("thread-1"), "large", {
        mimeType: "image/png",
        data: tooLarge.toString("base64"),
      }),
    ).toHaveProperty("error");
  }).pipe(Effect.provide(layer)),
);

it.effect("写盘失败返回可显示的错误且不遗留部分文件", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    NodeFS.rmdirSync(config.attachmentsDir);
    NodeFS.writeFileSync(config.attachmentsDir, "阻止创建目录");
    const result = yield* storeProviderImageAttachment(ThreadId.make("thread-1"), "failure", image);
    expect(result.error).toContain("图片保存失败");
  }).pipe(Effect.provide(layer)),
);
