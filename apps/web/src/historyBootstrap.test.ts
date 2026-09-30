import { MessageId } from "@codework/contracts";
import { expect, it } from "vite-plus/test";
import { buildBootstrapInput } from "./historyBootstrap";

it.each(["image", "audio", "file"] as const)(
  "纯 %s 历史只摘要附件名称，不泄露签名 URL 或冒称图片",
  (type) => {
    const result = buildBootstrapInput(
      [
        {
          id: MessageId.make("message-1"),
          role: "assistant",
          text: "",
          turnId: null,
          createdAt: "2026-09-30T00:00:00.000Z",
          updatedAt: "2026-09-30T00:00:00.000Z",
          streaming: false,
          attachments: [
            {
              type,
              id: "attachment-1",
              name: "report.bin",
              mimeType: type === "image" ? "image/png" : "audio/wav",
              sizeBytes: 10,
              previewUrl: "https://example.test/asset?token=secret",
            },
          ],
        },
      ],
      "继续",
      10_000,
    );
    expect(result.includedCount).toBe(1);
    expect(result.text).toContain(
      `[Attached ${type === "image" ? "image" : "attachment"}: report.bin]`,
    );
    expect(result.text).not.toContain("token=secret");
    expect(result.text).not.toContain("(empty message)");
  },
);
