// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@codework/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createAttachmentId,
  createPendingAttachmentId,
  parseAttachmentUuid,
  planAttachmentClaim,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("reserves the pending attachment segment", () => {
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
    expect(parseAttachmentUuid(pendingId)).toMatch(/^[a-f0-9-]{36}$/);
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending")!)).toBe("_pending");
    expect(parseThreadSegmentFromAttachmentId(createAttachmentId("pending_thread")!)).toBe(
      "pending_thread",
    );
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["image", "photo.png", "image/png", ".png"],
    ["image", "photo.jpg", "image/jpeg", ".jpg"],
    ["image", "photo.webp", "image/webp", ".webp"],
    ["audio", "recording.mp3", "audio/mpeg", ".mp3"],
    ["audio", "recording.wav", "audio/wav", ".wav"],
    ["file", "document.pdf", "application/pdf", ".pdf"],
    ["file", "archive.zip", "application/zip", ".zip"],
    ["file", "download", "application/octet-stream", ".bin"],
    ["audio", "recording.MP3", "audio/wav", ".mp3"],
    ["file", "archive.ZIP", "application/pdf", ".zip"],
    ["file", "document.pdf", "image/png", ".pdf"],
    ["audio", "recording", "audio/mpeg", ".mp3"],
    ["audio", "recording.unknown", "audio/x-wav", ".wav"],
    ["file", "document", "application/pdf", ".pdf"],
    ["file", "archive.unknown", "application/zip", ".zip"],
    ["file", "download.exe", "application/x-unknown", ".bin"],
    ["file", "download", "toString", ".bin"],
  ] as const)("resolves %s %s (%s) consistently as %s", (type, name, mimeType, extension) => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-extension-"),
    );
    try {
      const attachment: ChatAttachment = {
        type,
        id: "thread-1-attachment",
        name,
        mimeType,
        sizeBytes: 5,
      };
      const expectedPath = NodePath.join(attachmentsDir, `${attachment.id}${extension}`);
      const resolved = resolveAttachmentPath({ attachmentsDir, attachment });
      expect(resolved).toBe(expectedPath);
      NodeFS.writeFileSync(expectedPath, "hello");
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: attachment.id })).toBe(
        resolved,
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("keeps binary attachments stored with the legacy extension readable", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-legacy-"),
    );
    try {
      const attachment: ChatAttachment = {
        type: "audio",
        id: "thread-legacy",
        name: "recording.mp3",
        mimeType: "audio/mpeg",
        sizeBytes: 5,
      };
      const legacyPath = NodePath.join(attachmentsDir, `${attachment.id}.bin`);
      NodeFS.writeFileSync(legacyPath, "hello");
      expect(resolveAttachmentPath({ attachmentsDir, attachment })).toBe(legacyPath);
      expect(resolveAttachmentPathById({ attachmentsDir, attachmentId: attachment.id })).toBe(
        legacyPath,
      );
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("plans pending attachment claims with direct filename lookups", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-claim-"),
    );
    try {
      const uuid = "00000000-0000-4000-8000-000000000001";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

      const claim = planAttachmentClaim({
        attachmentsDir,
        threadId: "thread-1",
        attachmentId: `pending-${uuid}`,
      });
      expect(claim).toMatchObject({
        ok: true,
        currentPath: pendingPath,
      });
      if (!claim.ok) {
        return;
      }
      expect(parseThreadSegmentFromAttachmentId(claim.finalId)).toBe("thread-1");
      expect(parseAttachmentUuid(claim.finalId)).not.toBe(uuid);
      expect(claim.finalPath).toBe(NodePath.join(attachmentsDir, `${claim.finalId}.png`));
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects thread-owned attachments even when thread segments collide", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-ownership-"),
    );
    try {
      const attachmentId = "a-b-00000000-0000-4000-8000-000000000003";
      NodeFS.writeFileSync(NodePath.join(attachmentsDir, `${attachmentId}.png`), "pixels");

      expect(planAttachmentClaim({ attachmentsDir, threadId: "a b", attachmentId })).toEqual({
        ok: false,
        reason: "attachment must be a pending upload",
      });
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("removes expired pending and partial files without touching thread attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "codework-attachment-sweep-"),
    );
    try {
      const now = 1_800_000_000_000;
      const oldTimeSeconds = (now - 2 * 24 * 60 * 60 * 1000) / 1000;
      const uuid = "00000000-0000-4000-8000-000000000002";
      const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.png`);
      const threadPath = NodePath.join(attachmentsDir, `thread-1-${uuid}.png`);
      const partialPath = NodePath.join(attachmentsDir, `${uuid}.part`);
      for (const filePath of [pendingPath, threadPath, partialPath]) {
        NodeFS.writeFileSync(filePath, Buffer.from("pixels"));
        NodeFS.utimesSync(filePath, oldTimeSeconds, oldTimeSeconds);
      }

      expect(sweepStalePendingAttachments({ attachmentsDir, nowMs: now })).toEqual({ deleted: 2 });
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
      expect(NodeFS.existsSync(partialPath)).toBe(false);
      expect(NodeFS.existsSync(threadPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
