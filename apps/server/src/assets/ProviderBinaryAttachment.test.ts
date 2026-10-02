// @effect-diagnostics nodeBuiltinImport:off - 核对隔离附件目录的实际字节与故障。
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PROVIDER_AGENT_MEDIA_MAX_BYTES, ThreadId } from "@codework/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import {
  storeProviderAudioAttachment,
  storeProviderBlobAttachment,
} from "./ProviderBinaryAttachment.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "codework-provider-binary-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const wav = Buffer.from("RIFF....WAVEfmt ").toString("base64");

it.effect("音频原子保存，事件重试不重复", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const audio = { mimeType: "audio/wav", data: wav };
    const first = yield* storeProviderAudioAttachment(
      ThreadId.make("thread/A"),
      "audio-event",
      audio,
    );
    const repeat = yield* storeProviderAudioAttachment(
      ThreadId.make("thread/A"),
      "audio-event",
      audio,
    );
    expect(repeat).toEqual(first);
    if (!first.attachment) throw new Error("音频未保存");
    expect(first.attachment.type).toBe("audio");
    expect(
      NodeFS.readFileSync(NodePath.join(config.attachmentsDir, `${first.attachment.id}.wav`)),
    ).toEqual(Buffer.from(wav, "base64"));
  }).pipe(Effect.provide(layer)),
);

it.effect("拒绝不安全的 blob MIME", () =>
  Effect.gen(function* () {
    const result = yield* storeProviderBlobAttachment(ThreadId.make("thread-1"), "svg", {
      mimeType: "image/svg+xml",
      data: Buffer.from("<svg></svg>").toString("base64"),
      uri: "file:///workspace/x.svg",
    });
    expect(result.error).toMatch(/不受支持|安全/);
  }).pipe(Effect.provide(layer)),
);

it.effect("保存嵌入 blob 并保留可读文件名", () =>
  Effect.gen(function* () {
    const result = yield* storeProviderBlobAttachment(ThreadId.make("thread-1"), "bin", {
      mimeType: "application/octet-stream",
      data: Buffer.from("blob-bytes").toString("base64"),
      uri: "file:///workspace/report.bin",
    });
    expect(result.attachment).toMatchObject({
      type: "file",
      name: "report.bin",
      mimeType: "application/octet-stream",
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("内联媒体拒绝空值、非规范 base64、过大正文及危险类型", () =>
  Effect.gen(function* () {
    for (const data of [
      "",
      "YQ",
      "!!!!",
      Buffer.alloc(PROVIDER_AGENT_MEDIA_MAX_BYTES + 1).toString("base64"),
    ]) {
      const result = yield* storeProviderAudioAttachment(ThreadId.make("thread-1"), "invalid", {
        mimeType: "audio/wav",
        data,
      });
      expect(result.error).toMatch(/base64|10 MiB/);
    }
    const max = yield* storeProviderAudioAttachment(ThreadId.make("thread-1"), "max", {
      mimeType: "audio/wav",
      data: Buffer.alloc(PROVIDER_AGENT_MEDIA_MAX_BYTES).toString("base64"),
    });
    expect(max.attachment?.sizeBytes).toBe(PROVIDER_AGENT_MEDIA_MAX_BYTES);
    for (const mimeType of [
      "text/html",
      "application/javascript",
      "application/x-executable",
      "bad MIME",
      `text/${"x".repeat(96)}`,
    ]) {
      const result = yield* storeProviderBlobAttachment(ThreadId.make("thread-1"), "unsafe", {
        mimeType,
        data: "YQ==",
      });
      expect(result.error).toMatch(/不受支持|安全/);
    }
    const unsupported = yield* storeProviderAudioAttachment(
      ThreadId.make("thread-1"),
      "unsupported",
      { mimeType: "audio/unknown", data: "YQ==" },
    );
    expect(unsupported.error).toContain("音频格式不支持");
  }).pipe(Effect.provide(layer)),
);

it.effect("音频和 blob 写盘失败有明确错误，不遗留部分文件", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    NodeFS.rmdirSync(config.attachmentsDir);
    NodeFS.writeFileSync(config.attachmentsDir, "阻止创建目录");
    const audio = yield* storeProviderAudioAttachment(ThreadId.make("thread-1"), "failure", {
      mimeType: "audio/wav",
      data: wav,
    });
    const blob = yield* storeProviderBlobAttachment(ThreadId.make("thread-1"), "failure", {
      mimeType: "application/octet-stream",
      data: "YQ==",
    });
    expect(audio.error).toContain("音频保存失败");
    expect(blob.error).toContain("二进制资源保存失败");
    expect(NodeFS.readFileSync(config.attachmentsDir, "utf8")).toBe("阻止创建目录");
  }).pipe(Effect.provide(layer)),
);
