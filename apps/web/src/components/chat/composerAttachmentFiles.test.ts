import { setCurrentLanguage } from "~/i18n/runtime";

setCurrentLanguage("en");

import { EnvironmentId, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  attachmentsToReleaseOnUploadCapabilityLoss,
  classifyComposerAttachmentFile,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  shouldHandleComposerAttachmentPaste,
} from "./composerAttachmentFiles";

const capable = {
  attachmentUploadsCapabilityKnown: true,
  supportsAttachmentUploads: true,
  maxFileAttachmentBytes: 1024,
};

function file(name: string, type: string): File {
  return new File([new Uint8Array([1])], name, { type });
}

describe("classifyComposerAttachmentFile", () => {
  it("routes supported images to the image path and everything else to files", () => {
    expect(classifyComposerAttachmentFile(file("a.png", "image/png"))).toBe("image");
    expect(classifyComposerAttachmentFile(file("a.pdf", "application/pdf"))).toBe("file");
    expect(classifyComposerAttachmentFile(file("a.bmp", "image/bmp"))).toBe("unsupported-image");
  });

  it("recognizes images whose source handed over no MIME type", () => {
    expect(classifyComposerAttachmentFile(file("photo.JPG", ""))).toBe("image");
    expect(classifyComposerAttachmentFile(file("data.bin", "application/octet-stream"))).toBe(
      "file",
    );
  });
});

describe("fileAttachmentStagingLimit", () => {
  it("stages up to the contract cap before the server is known", () => {
    expect(
      fileAttachmentStagingLimit({
        attachmentUploadsCapabilityKnown: false,
        supportsAttachmentUploads: false,
        maxFileAttachmentBytes: null,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  });

  it("refuses files on servers without file uploads and clamps larger advertisements", () => {
    expect(fileAttachmentStagingLimit({ ...capable, maxFileAttachmentBytes: null })).toBeNull();
    expect(fileAttachmentStagingLimit({ ...capable, supportsAttachmentUploads: false })).toBeNull();
    expect(
      fileAttachmentStagingLimit({
        ...capable,
        maxFileAttachmentBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES * 2,
      }),
    ).toBe(PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  });
});

describe("fileAttachmentCapabilityBlockReason", () => {
  const files = [{ name: "big.zip", sizeBytes: 2048 }];

  it("does not block a draft without generic files", () => {
    expect(fileAttachmentCapabilityBlockReason({ ...capable, files: [] })).toBeNull();
  });

  it("explains each way retained files cannot send", () => {
    expect(
      fileAttachmentCapabilityBlockReason({
        ...capable,
        attachmentUploadsCapabilityKnown: false,
        files,
      }),
    ).toBe("Waiting for the server before file attachments can send");
    expect(
      fileAttachmentCapabilityBlockReason({ ...capable, maxFileAttachmentBytes: null, files }),
    ).toBe("This server does not accept file attachments right now. Remove the files to send.");
    expect(fileAttachmentCapabilityBlockReason({ ...capable, files })).toBe(
      "'big.zip' exceeds the 1 KB attachment limit.",
    );
    expect(
      fileAttachmentCapabilityBlockReason({
        ...capable,
        files: [{ name: "ok.txt", sizeBytes: 1024 }],
      }),
    ).toBeNull();
  });
});

describe("attachmentsToReleaseOnUploadCapabilityLoss", () => {
  it("keeps uploads a draft file already persisted", () => {
    const image: ComposerImageAttachment = {
      type: "image",
      id: "image",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:a",
      file: file("a.png", "image/png"),
    };
    const fresh: ComposerFileAttachment = {
      type: "file",
      id: "fresh",
      name: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      file: file("a.pdf", "application/pdf"),
    };
    const persisted: ComposerFileAttachment = {
      ...fresh,
      id: "persisted",
      uploadedAttachmentId: "pending-1",
      uploadEnvironmentId: EnvironmentId.make("environment-1"),
    };

    expect(attachmentsToReleaseOnUploadCapabilityLoss([image, fresh, persisted])).toEqual([
      image,
      fresh,
    ]);
  });
});

describe("shouldHandleComposerAttachmentPaste", () => {
  it("claims pasted images even when the clipboard also carries text", () => {
    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file("shot.png", "image/png")],
        plainText: "shot.png",
      }),
    ).toBe(true);
  });

  it("leaves text pastes alone when the files are only a rich-text side channel", () => {
    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file("cell.csv", "text/csv")],
        plainText: "a,b",
      }),
    ).toBe(false);
    expect(
      shouldHandleComposerAttachmentPaste({
        files: [file("cell.csv", "text/csv")],
        plainText: "",
      }),
    ).toBe(true);
  });
});
