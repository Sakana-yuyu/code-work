import { describe, expect, it } from "vite-plus/test";

import type { ByokChatMessage } from "../Layers/byokChatClient.ts";
import {
  buildVisionPrompt,
  messageImageCount,
  messageTextContext,
  messagesContainImages,
  modelLikelySupportsVision,
  replaceMessageImagesWithTexts,
  VISION_FAILURE_PREFIX,
  VISION_RESULT_PREFIX,
} from "./VisionDelegation.ts";

const imagePart = (dataBase64: string) => ({
  type: "image" as const,
  mimeType: "image/png",
  dataBase64,
});

const textPart = (text: string) => ({ type: "text" as const, text });

describe("vision delegation capability heuristic", () => {
  it("treats known vision-capable model families as vision-capable", () => {
    expect(modelLikelySupportsVision("gpt-4o", "GPT-4o")).toBe(true);
    expect(modelLikelySupportsVision("claude-sonnet-4", "Claude Sonnet")).toBe(true);
    expect(modelLikelySupportsVision("gemini-2.5-pro", "Gemini Pro")).toBe(true);
    expect(modelLikelySupportsVision("qwen2.5-vl-72b", "Qwen VL")).toBe(true);
    expect(modelLikelySupportsVision("custom-id", "DeepSeek Vision")).toBe(true);
  });

  it("treats text-only model ids as not vision-capable", () => {
    expect(modelLikelySupportsVision("deepseek-chat", "DeepSeek Chat")).toBe(false);
    expect(modelLikelySupportsVision("qwen-max", "Qwen Max")).toBe(false);
    expect(modelLikelySupportsVision("kimi-k2", "Kimi K2")).toBe(false);
    expect(modelLikelySupportsVision("", "")).toBe(false);
  });
});

describe("buildVisionPrompt", () => {
  it("asks for description and OCR sections in auto mode", () => {
    const prompt = buildVisionPrompt("auto", "");
    expect(prompt).toContain("画面描述");
    expect(prompt).toContain("文字抄录");
  });

  it("asks for verbatim transcription in ocr mode", () => {
    const prompt = buildVisionPrompt("ocr", "发票金额是多少");
    expect(prompt).toContain("抄录");
    expect(prompt).toContain("发票金额是多少");
  });

  it("focuses on scene description in describe mode and appends the user need", () => {
    const prompt = buildVisionPrompt("describe", "截图里的报错是什么");
    expect(prompt).toContain("描述这张图片");
    expect(prompt).not.toContain("抄录");
    expect(prompt).toContain("截图里的报错是什么");
  });
});

describe("image detection helpers", () => {
  it("counts image parts only in multipart content", () => {
    const textOnly: ByokChatMessage = { role: "user", content: "plain" };
    expect(messageImageCount(textOnly)).toBe(0);

    const mixed: ByokChatMessage = {
      role: "user",
      content: [textPart("look"), imagePart("abc"), imagePart("def")],
    };
    expect(messageImageCount(mixed)).toBe(2);
    expect(messagesContainImages([{ role: "assistant", content: "hi" }, mixed])).toBe(true);
    expect(messagesContainImages([{ role: "assistant", content: "hi" }])).toBe(false);
  });

  it("extracts the user text accompanying the images", () => {
    const message: ByokChatMessage = {
      role: "user",
      content: [textPart("第一段"), imagePart("abc"), textPart("第二段")],
    };
    expect(messageTextContext(message)).toBe("第一段\n第二段");
  });
});

describe("replaceMessageImagesWithTexts", () => {
  it("replaces image parts with prefixed vision texts and collapses to a string", () => {
    const message: ByokChatMessage = {
      role: "user",
      content: [textPart("look"), imagePart("abc"), imagePart("def")],
    };
    const replaced = replaceMessageImagesWithTexts(message, [
      `${VISION_RESULT_PREFIX} 一只猫`,
      `${VISION_RESULT_PREFIX} 一只狗`,
    ]);
    expect(replaced.content).toBe(
      `look\n${VISION_RESULT_PREFIX} 一只猫\n${VISION_RESULT_PREFIX} 一只狗`,
    );
  });

  it("keeps the message untouched when no replacement texts are given", () => {
    const message: ByokChatMessage = { role: "user", content: [imagePart("abc")] };
    expect(replaceMessageImagesWithTexts(message, [])).toBe(message);
  });

  it("keeps multipart shape when a replacement is empty (failure placeholder case handled by caller)", () => {
    const message: ByokChatMessage = {
      role: "user",
      content: [textPart("look"), imagePart("abc")],
    };
    const replaced = replaceMessageImagesWithTexts(message, [VISION_FAILURE_PREFIX]);
    expect(replaced.content).toContain(VISION_FAILURE_PREFIX);
  });
});
