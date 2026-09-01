/**
 * Vision delegation core — ported from the original cursor-byok vision proxy.
 *
 * When the target BYOK model likely cannot read images and vision delegation
 * is enabled, every inline image part is forwarded to the configured vision
 * model adapter and replaced with the returned description/OCR text. Like the
 * original, replacement happens on the message itself so later turns reuse the
 * text instead of re-delegating the same image.
 *
 * This module is pure: prompt building, capability heuristics, and message
 * transformation live here; the IO (streaming one vision completion per image)
 * stays in `ByokAdapter`.
 *
 * @module provider/byok/VisionDelegation
 */
import type { ByokVisionDelegationConfig } from "@codework/contracts";

import type { ByokChatMessage, ByokContentPart, ByokImagePart } from "../Layers/byokChatClient.ts";

export type VisionDelegationMode = ByokVisionDelegationConfig["mode"];

/**
 * Result marker prefixed to every injected description, mirroring the original
 * "[图片识图结果（视觉委派）…]" contract so users can tell delegated readings
 * apart from model-native vision.
 */
export const VISION_RESULT_PREFIX = "[图片识图结果（视觉委派）]";
export const VISION_FAILURE_PREFIX = "[图片识图失败（视觉委派）]";

/**
 * Name-based capability heuristic. There is no per-adapter capability flag in
 * BYOK settings, so — like the original capability catalog — a model whose id
 * or display name matches one of these vision-capable families keeps its
 * images untouched.
 */
const VISION_CAPABLE_MODEL_PATTERNS: ReadonlyArray<RegExp> = [
  /gpt-4\.o/iu,
  /gpt-4o/iu,
  /gpt-4\.1/iu,
  /gpt-4-turbo/iu,
  /gpt-5/iu,
  /chatgpt-4o/iu,
  /(^|[^a-z])o[34](-|$|[a-z])/iu,
  /claude-[3-9]/iu,
  /claude-(opus|sonnet|haiku)/iu,
  /gemini/iu,
  /grok-(2|3|4|vision)/iu,
  /qwen[^/]*-v/iu,
  /glm-4v/iu,
  /doubao-.*vision/iu,
  /hunyuan-.*vision/iu,
  /yi-vision/iu,
  /internvl/iu,
  /minicpm-v/iu,
  /pixtral/iu,
  /llava/iu,
  /step-1v/iu,
  /vision/iu,
];

export function modelLikelySupportsVision(modelId: string, displayName: string): boolean {
  const candidates = [modelId, displayName];
  return candidates.some((candidate) =>
    VISION_CAPABLE_MODEL_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

const FOCUS_NOTE = "优先描述图片中的圈画、框选、箭头、高亮等标注区域。";

/** Build the per-image vision prompt; `question` carries the user's need. */
export function buildVisionPrompt(mode: VisionDelegationMode, question: string): string {
  const userNeed = question.trim();
  const needSuffix =
    userNeed.length > 0
      ? `\n用户当前的需求是：「${userNeed}」。请优先回答与该需求相关的图片内容。`
      : "";
  if (mode === "describe") {
    return [
      "请详细描述这张图片的内容，包括主体、场景、文字要点和布局。",
      FOCUS_NOTE,
      `用中文回答。${needSuffix}`,
    ].join("\n");
  }
  if (mode === "ocr") {
    return [
      "请精确抄录这张图片中的全部文字，保持原始阅读顺序；表格请用 Markdown 表格输出。",
      "不要添加解释或总结，只输出图片中的文字。",
      FOCUS_NOTE,
      `用中文回答。${needSuffix}`,
    ].join("\n");
  }
  return [
    "请分两段说明这张图片：",
    "第一段【画面描述】：概述主体、场景与布局；",
    "第二段【文字抄录】：逐条列出图片中出现的文字（OCR），表格用 Markdown 输出。",
    FOCUS_NOTE,
    `用中文回答。${needSuffix}`,
  ].join("\n");
}

export const isImagePart = (part: ByokContentPart): part is ByokImagePart => part.type === "image";

export const messageImageCount = (message: ByokChatMessage): number =>
  typeof message.content === "string"
    ? 0
    : message.content.filter((part) => isImagePart(part)).length;

export const messagesContainImages = (messages: ReadonlyArray<ByokChatMessage>): boolean =>
  messages.some((message) => messageImageCount(message) > 0);

/** The user's own words accompanying the images, used as the vision question. */
export const messageTextContext = (message: ByokChatMessage): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

/**
 * Rewrite one message replacing image parts with per-image texts. When every
 * part is replaced the content collapses to a plain string, matching how
 * text-only turns are stored.
 */
export const replaceMessageImagesWithTexts = (
  message: ByokChatMessage,
  texts: ReadonlyArray<string>,
): ByokChatMessage => {
  if (typeof message.content === "string" || texts.length === 0) return message;
  const parts: Array<ByokContentPart> = [];
  let textIndex = 0;
  for (const part of message.content) {
    if (!isImagePart(part)) {
      parts.push(part);
      continue;
    }
    const replacement = texts[textIndex] ?? "";
    textIndex += 1;
    if (replacement.length > 0) parts.push({ type: "text", text: replacement });
  }
  return parts.every((part) => part.type === "text")
    ? { ...message, content: parts.map((part) => part.text).join("\n") }
    : { ...message, content: parts };
};
