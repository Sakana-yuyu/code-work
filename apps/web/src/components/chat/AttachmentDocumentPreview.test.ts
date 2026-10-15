import { describe, expect, it } from "vite-plus/test";

import { attachmentDocumentKind } from "./AttachmentDocumentPreview";

describe("attachmentDocumentKind", () => {
  it("recognizes HTML and PDF by MIME type or file name", () => {
    expect(attachmentDocumentKind({ name: "a.bin", mimeType: "application/pdf" })).toBe("pdf");
    expect(attachmentDocumentKind({ name: "Report.PDF", mimeType: "" })).toBe("pdf");
    expect(attachmentDocumentKind({ name: "a.bin", mimeType: "text/html; charset=utf-8" })).toBe(
      "html",
    );
    expect(attachmentDocumentKind({ name: "page.htm", mimeType: "text/plain" })).toBe("html");
  });

  it("leaves other files to download", () => {
    expect(attachmentDocumentKind({ name: "data.zip", mimeType: "application/zip" })).toBeNull();
    expect(attachmentDocumentKind({ name: "notes.md", mimeType: "text/markdown" })).toBeNull();
  });
});
