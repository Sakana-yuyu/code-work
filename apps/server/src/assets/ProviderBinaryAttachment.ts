import * as NodeCrypto from "node:crypto";
import {
  type ChatAttachment,
  type ThreadId,
  PROVIDER_AGENT_MEDIA_MAX_BYTES,
  isProviderAgentSupportedAudioMimeType,
  isProviderAgentSupportedBlobMimeType,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { storeAttachmentUpload } from "./AttachmentUpload.ts";

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "audio/mpeg":
      return ".mp3";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav";
    case "audio/ogg":
      return ".ogg";
    case "audio/webm":
      return ".webm";
    case "audio/mp4":
      return ".m4a";
    case "audio/aac":
      return ".aac";
    case "audio/flac":
      return ".flac";
    case "application/pdf":
      return ".pdf";
    case "application/json":
      return ".json";
    case "text/plain":
      return ".txt";
    default:
      return "";
  }
}

function fileNameFromUri(uri: string | undefined, fallback: string): string {
  if (!uri) return fallback;
  try {
    const pathname = new URL(uri).pathname;
    const base = pathname.split("/").findLast(Boolean);
    if (base && base.length > 0 && base.length <= 200) return base;
  } catch {
    const base = uri.replaceAll("\\", "/").split("/").findLast(Boolean);
    if (base && base.length > 0 && base.length <= 200) return base;
  }
  return fallback;
}

function decodeInlineBase64(
  mimeType: string,
  data: string,
):
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly error: string } {
  if (data.length > Math.ceil(PROVIDER_AGENT_MEDIA_MAX_BYTES / 3) * 4) {
    return { ok: false, error: "媒体超过 10 MiB 限制。" };
  }
  const parsed = parseBase64DataUrl(`data:${mimeType};base64,${data}`);
  if (!parsed) return { ok: false, error: "媒体 base64 数据无效。" };
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== parsed.base64) {
    return { ok: false, error: "媒体 base64 数据无效。" };
  }
  if (bytes.length > PROVIDER_AGENT_MEDIA_MAX_BYTES) {
    return { ok: false, error: "媒体超过 10 MiB 限制。" };
  }
  return { ok: true, bytes };
}

function resolveAttachmentId(
  threadId: ThreadId,
  eventKey: string,
): { readonly ok: true; readonly id: string } | { readonly ok: false; readonly error: string } {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment) return { ok: false, error: "无法确定媒体所属对话。" };
  const digest = NodeCrypto.createHash("sha256")
    .update(threadId)
    .update("\0")
    .update(eventKey)
    .digest("hex")
    .slice(0, 32);
  return {
    ok: true,
    id: `${segment}-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`,
  };
}

/** 只接收上游内联音频；不下载 URI，也不把正文写入工作区或事件日志。 */
export const storeProviderAudioAttachment = Effect.fn("storeProviderAudioAttachment")(function* (
  threadId: ThreadId,
  eventKey: string,
  audio: { readonly mimeType: string; readonly data: string },
) {
  const mimeType = audio.mimeType.trim().toLowerCase();
  if (!isProviderAgentSupportedAudioMimeType(mimeType))
    return { error: "音频格式不支持，请使用常见的 WAV、MP3、OGG、WebM、AAC 或 FLAC。" };
  const decoded = decodeInlineBase64(mimeType, audio.data);
  if (!decoded.ok) return { error: decoded.error };
  const idResult = resolveAttachmentId(threadId, eventKey);
  if (!idResult.ok) return { error: idResult.error };
  const attachment: ChatAttachment = {
    type: "audio",
    id: idResult.id,
    name: `agent-audio${extensionForMime(mimeType)}`,
    mimeType,
    sizeBytes: decoded.bytes.length,
  };
  const stored = yield* storeAttachmentUpload(
    {
      attachmentId: idResult.id,
      name: attachment.name,
      mimeType,
      sizeBytes: decoded.bytes.length,
    },
    decoded.bytes,
    attachment.type,
  );
  return stored.ok ? { attachment } : { error: "音频保存失败，请检查环境的附件存储后重试。" };
});

/** 只接收上游嵌入 blob；不根据 uri 回源下载。 */
export const storeProviderBlobAttachment = Effect.fn("storeProviderBlobAttachment")(function* (
  threadId: ThreadId,
  eventKey: string,
  blob: {
    readonly mimeType: string;
    readonly data: string;
    readonly uri?: string | undefined;
    readonly name?: string | undefined;
  },
) {
  const mimeType = (blob.mimeType.trim() || "application/octet-stream").toLowerCase();
  if (!isProviderAgentSupportedBlobMimeType(mimeType))
    return { error: "二进制资源类型不受支持或存在安全风险。" };
  const decoded = decodeInlineBase64(mimeType, blob.data);
  if (!decoded.ok) return { error: decoded.error };
  const idResult = resolveAttachmentId(threadId, eventKey);
  if (!idResult.ok) return { error: idResult.error };
  const name =
    blob.name?.trim() ||
    fileNameFromUri(blob.uri, `agent-file${extensionForMime(mimeType) || ".bin"}`);
  const attachment: ChatAttachment = {
    type: "file",
    id: idResult.id,
    name: name.slice(0, 255),
    mimeType,
    sizeBytes: decoded.bytes.length,
  };
  const stored = yield* storeAttachmentUpload(
    {
      attachmentId: idResult.id,
      name: attachment.name,
      mimeType,
      sizeBytes: decoded.bytes.length,
    },
    decoded.bytes,
    attachment.type,
  );
  return stored.ok ? { attachment } : { error: "二进制资源保存失败，请检查环境的附件存储后重试。" };
});
