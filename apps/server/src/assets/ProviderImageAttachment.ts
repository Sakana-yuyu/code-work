import * as NodeCrypto from "node:crypto";
import {
  type ChatAttachment,
  type ThreadId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
} from "@codework/contracts";
import * as Effect from "effect/Effect";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { inferImageExtension, parseBase64DataUrl } from "../imageMime.ts";
import { storeAttachmentUpload } from "./AttachmentUpload.ts";

/** 只接收上游内联图片；不下载 URI，也不把正文写入工作区或事件日志。 */
export const storeProviderImageAttachment = Effect.fn("storeProviderImageAttachment")(function* (
  threadId: ThreadId,
  eventKey: string,
  image: { readonly mimeType: string; readonly data: string },
) {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!isProviderSendTurnSupportedImageMimeType(mimeType))
    return { error: "图片格式不支持，请使用 PNG、JPEG、GIF 或 WebP。" };
  if (image.data.length > Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4)
    return { error: "图片超过 10 MiB 限制。" };
  const parsed = parseBase64DataUrl(`data:${mimeType};base64,${image.data}`);
  if (!parsed) return { error: "图片 base64 数据无效。" };
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== parsed.base64)
    return { error: "图片 base64 数据无效。" };
  if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return { error: "图片超过 10 MiB 限制。" };
  // 仅校验格式签名，不冒充完整图像解码；客户端负责解码显示。
  const signatureMatches =
    mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : mimeType === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))
          : bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
            bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (!signatureMatches) return { error: "图片内容与声明格式不一致。" };
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment) return { error: "无法确定图片所属对话。" };
  // 事件重试复用同一文件；完整线程 ID 参与摘要，避免规范化后的前缀碰撞。
  const digest = NodeCrypto.createHash("sha256")
    .update(threadId)
    .update("\0")
    .update(eventKey)
    .digest("hex")
    .slice(0, 32);
  const id = `${segment}-${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  const attachment: ChatAttachment = {
    type: "image",
    id,
    name: `agent-image${inferImageExtension({ mimeType })}`,
    mimeType,
    sizeBytes: bytes.length,
  };
  const stored = yield* storeAttachmentUpload(
    { attachmentId: id, name: attachment.name, mimeType, sizeBytes: bytes.length },
    bytes,
  );
  return stored.ok ? { attachment } : { error: "图片保存失败，请检查环境的附件存储后重试。" };
});
