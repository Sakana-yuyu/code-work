import { EnvironmentId } from "@codework/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  files: new Map<string, { size: number; type: string; name: string }>(),
  copies: [] as Array<{ from: string; to: string }>,
  deleted: [] as string[],
  uploads: [] as Array<{ uri: string; url: string; headers: unknown }>,
  pickResult: null as unknown,
  configs: new Map<string, unknown>(),
  scope: true,
  cycle: vi.fn(),
  removePending: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return true;
    }
    create() {}
  }
  class File {
    readonly uri: string;
    constructor(...parts: Array<string | { uri: string }>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    static async pickFileAsync() {
      return harness.pickResult;
    }
    get exists() {
      return harness.files.has(this.uri);
    }
    copy(destination: { uri: string }) {
      harness.copies.push({ from: this.uri, to: destination.uri });
    }
    delete() {
      harness.deleted.push(this.uri);
    }
    async upload(url: string, options: { headers: unknown }) {
      harness.uploads.push({ uri: this.uri, url, headers: options.headers });
      return { status: 204, body: "" };
    }
  }
  return {
    Directory,
    File,
    Paths: { document: { uri: "file:///documents" } },
    UploadType: { BINARY_CONTENT: 0 },
  };
});
vi.mock("@codework/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codework/client-runtime/state/attachments")>()),
  runAttachmentUploadCycle: (...args: unknown[]) => harness.cycle(...args),
  deletePendingAttachmentUpload: (...args: unknown[]) => harness.removePending(...args),
}));
vi.mock("../i18n/runtime", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));
vi.mock("../state/atom-registry", () => ({
  appAtomRegistry: { get: () => harness.configs },
}));
vi.mock("../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: "create-upload-url", remove: "remove" },
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../state/session", () => ({
  readEnvironmentScope: () => harness.scope,
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.test/" }),
}));
vi.mock("./foreground-handoff", () => ({ beginForegroundHandoff: () => () => {} }));
vi.mock("./uuid", () => ({ uuidv4: () => "uuid" }));

import {
  composerFileUploadLimit,
  deleteOwnedComposerFiles,
  pickComposerFiles,
  prepareComposerFileUploads,
} from "./composerFiles";

const environmentId = EnvironmentId.make("environment-1");

function pickedFile(name: string, size: number, type = "application/pdf") {
  return {
    uri: `file:///picker/${name}`,
    name,
    size,
    type,
    copy: (destination: { uri: string }) =>
      harness.copies.push({ from: `file:///picker/${name}`, to: destination.uri }),
  };
}

const ownedFile = {
  id: "file-1",
  type: "file" as const,
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 4,
  fileUri: "file:///documents/codework-composer-files/file-1-report.pdf",
};

beforeEach(() => {
  harness.files.clear();
  harness.copies = [];
  harness.deleted = [];
  harness.uploads = [];
  harness.pickResult = null;
  harness.configs = new Map([
    [
      environmentId,
      { environment: { capabilities: { fileAttachments: { maxUploadBytes: 1024 } } } },
    ],
  ]);
  harness.scope = true;
  harness.cycle.mockReset();
  harness.removePending.mockReset();
});

describe("composerFileUploadLimit", () => {
  it("follows the environment advertisement and refuses servers without file uploads", () => {
    expect(composerFileUploadLimit(environmentId)).toBe(1024);
    harness.configs.set(environmentId, { environment: { capabilities: {} } });
    expect(composerFileUploadLimit(environmentId)).toBeNull();
    expect(composerFileUploadLimit(EnvironmentId.make("unknown"))).toBe(50 * 1024 * 1024);
  });
});

describe("pickComposerFiles", () => {
  it("copies picks into the app-owned directory and reports skipped files", async () => {
    harness.pickResult = {
      canceled: false,
      result: [
        pickedFile("report.pdf", 4),
        pickedFile("empty.txt", 0),
        pickedFile("big.zip", 2048),
      ],
    };
    const result = await pickComposerFiles({ existingCount: 0, maxBytes: 1024 });

    expect(result.files).toEqual([
      {
        id: "uuid",
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        fileUri: "file:///documents/codework-composer-files/uuid-report.pdf",
      },
    ]);
    expect(harness.copies).toEqual([
      {
        from: "file:///picker/report.pdf",
        to: "file:///documents/codework-composer-files/uuid-report.pdf",
      },
    ]);
    expect(result.error).toContain("composer.fileTooLarge");
  });

  it("does not open the picker for a server that takes no files or a full draft", async () => {
    expect(await pickComposerFiles({ existingCount: 0, maxBytes: null })).toEqual({
      files: [],
      error: "composer.serverRejectsFiles",
    });
    expect((await pickComposerFiles({ existingCount: 8, maxBytes: 1024 })).error).toContain(
      "composer.attachmentLimit",
    );
  });
});

describe("prepareComposerFileUploads", () => {
  it("uploads the owned copy and records the upload id for the environment", async () => {
    harness.files.set(ownedFile.fileUri, { size: 4, type: "application/pdf", name: "report.pdf" });
    harness.cycle.mockImplementation(
      async (input: {
        upload: unknown;
        resolveUploadUrl: (relative: string) => string | null;
        transport: (url: string) => { done: Promise<void> };
      }) => {
        const url = input.resolveUploadUrl("/api/attachments/upload/pending-1-pdf");
        await input.transport(url!).done;
        return { status: "uploaded", attachmentId: "pending-1-pdf" };
      },
    );

    const image = {
      id: "image-1",
      type: "image" as const,
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      dataUrl: "data:image/png;base64,AA==",
      previewUri: "file:///a.png",
    };
    const prepared = await prepareComposerFileUploads({
      environmentId,
      attachments: [image, ownedFile],
    });

    expect(harness.cycle.mock.calls[0]![0]).toMatchObject({
      environmentId,
      upload: { type: "file", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 4 },
    });
    expect(harness.uploads).toEqual([
      {
        uri: ownedFile.fileUri,
        url: "https://environment.test/api/attachments/upload/pending-1-pdf",
        headers: { "Content-Type": "application/pdf" },
      },
    ]);
    expect(prepared).toEqual([
      image,
      { ...ownedFile, uploadedAttachmentId: "pending-1-pdf", uploadEnvironmentId: environmentId },
    ]);
  });

  it("reuses an upload already made for the same environment", async () => {
    const uploaded = {
      ...ownedFile,
      uploadedAttachmentId: "pending-1-pdf",
      uploadEnvironmentId: environmentId,
    };
    const attachments = [uploaded];
    expect(await prepareComposerFileUploads({ environmentId, attachments })).toBe(attachments);
    expect(harness.cycle).not.toHaveBeenCalled();
  });

  it("fails without uploading when the connection, server or file cannot take it", async () => {
    harness.scope = false;
    await expect(
      prepareComposerFileUploads({ environmentId, attachments: [ownedFile] }),
    ).rejects.toThrow("upload.connectionCannotUpload");

    harness.scope = true;
    harness.configs.set(environmentId, { environment: { capabilities: {} } });
    await expect(
      prepareComposerFileUploads({ environmentId, attachments: [ownedFile] }),
    ).rejects.toThrow("composer.serverRejectsFiles");

    harness.configs.set(environmentId, {
      environment: { capabilities: { fileAttachments: { maxUploadBytes: 1024 } } },
    });
    await expect(
      prepareComposerFileUploads({ environmentId, attachments: [ownedFile] }),
    ).rejects.toThrow("composer.fileNoLongerAvailable");
    expect(harness.cycle).not.toHaveBeenCalled();
  });

  it("deletes a pending upload whose transfer failed", async () => {
    harness.files.set(ownedFile.fileUri, { size: 4, type: "application/pdf", name: "report.pdf" });
    harness.cycle.mockResolvedValue({
      status: "failed",
      step: "transfer",
      attachmentId: "pending-2-pdf",
      error: new Error("offline"),
    });

    await expect(
      prepareComposerFileUploads({ environmentId, attachments: [ownedFile] }),
    ).rejects.toThrow("composer.fileUploadFailed");
    expect(harness.removePending).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId, attachmentId: "pending-2-pdf" }),
    );
  });
});

describe("deleteOwnedComposerFiles", () => {
  it("deletes only app-owned copies", async () => {
    harness.files.set(ownedFile.fileUri, { size: 4, type: "application/pdf", name: "report.pdf" });
    await deleteOwnedComposerFiles([
      ownedFile,
      { ...ownedFile, id: "foreign", fileUri: "file:///elsewhere/report.pdf" },
    ]);
    expect(harness.deleted).toEqual([ownedFile.fileUri]);
  });
});
