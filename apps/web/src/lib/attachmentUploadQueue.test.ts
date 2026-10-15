import { setCurrentLanguage } from "~/i18n/runtime";

setCurrentLanguage("en");

import { EnvironmentId } from "@codework/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";

const mocks = vi.hoisted(() => ({
  createUploadUrl: Symbol("create-upload-url"),
  removeUpload: Symbol("remove-upload"),
  createAssetUrl: Symbol("create-asset-url"),
  runAtomCommand: vi.fn(),
  readPreparedConnection: vi.fn(),
  readEnvironmentScope: vi.fn(),
  verifyPersistedAttachmentUpload: vi.fn(),
}));

vi.mock("@codework/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codework/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.runAtomCommand,
}));

vi.mock("@codework/client-runtime/state/attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codework/client-runtime/state/attachments")>()),
  verifyPersistedAttachmentUpload: mocks.verifyPersistedAttachmentUpload,
}));

vi.mock("../rpc/atomRegistry", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  return {
    appAtomRegistry: {
      get: () => AsyncResult.success({ phase: "connected" }),
      subscribe: () => () => {},
    },
  };
});

// Only background completions with a draft target touch the draft store.
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (key: string) => key },
  useComposerDraftStore: {
    getState: () => ({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} }),
  },
}));

vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => Symbol("connection-state") },
}));

vi.mock("../state/assets", () => ({
  assetEnvironment: { createUrl: mocks.createAssetUrl },
}));

vi.mock("../state/attachments", () => ({
  attachmentEnvironment: {
    createUploadUrl: mocks.createUploadUrl,
    remove: mocks.removeUpload,
  },
}));

vi.mock("../state/session", () => ({
  readPreparedConnection: mocks.readPreparedConnection,
  readEnvironmentScope: mocks.readEnvironmentScope,
}));

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "./attachmentUploadQueue";

type ProgressListener = (event: {
  readonly lengthComputable: boolean;
  readonly loaded: number;
  readonly total: number;
}) => void;

class TestXmlHttpRequest {
  static requests: TestXmlHttpRequest[] = [];

  status = 0;
  timeout = 0;
  method: string | null = null;
  url: string | null = null;
  readonly headers = new Map<string, string>();
  readonly listeners = new Map<string, () => void>();
  progressListener: ProgressListener | null = null;

  readonly upload = {
    addEventListener: (_event: string, listener: ProgressListener) => {
      this.progressListener = listener;
    },
  };

  constructor() {
    TestXmlHttpRequest.requests.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  addEventListener(event: string, listener: () => void): void {
    this.listeners.set(event, listener);
  }

  send(): void {}

  abort(): void {
    this.listeners.get("abort")?.();
  }

  progress(loaded: number, total: number): void {
    this.progressListener?.({ lengthComputable: true, loaded, total });
  }

  complete(status = 204): void {
    this.status = status;
    this.listeners.get("load")?.();
  }
}

const firstEnvironment = EnvironmentId.make("environment-1");
const secondEnvironment = EnvironmentId.make("environment-2");

function makeFile(id: string, extra: Partial<ComposerFileAttachment> = {}): ComposerFileAttachment {
  const file = new File([new Uint8Array([1, 2, 3, 4])], `${id}.pdf`, { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    ...extra,
  };
}

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array([1, 2, 3])], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

describe("attachmentUploadQueue", () => {
  beforeEach(() => {
    TestXmlHttpRequest.requests = [];
    mocks.runAtomCommand.mockReset();
    mocks.readPreparedConnection.mockReset();
    mocks.readPreparedConnection.mockReturnValue({ httpBaseUrl: "https://environment.test/" });
    mocks.readEnvironmentScope.mockReset();
    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.verifyPersistedAttachmentUpload.mockReset();
    mocks.runAtomCommand.mockImplementation(
      async (
        _registry: unknown,
        command: unknown,
        target: {
          readonly environmentId: EnvironmentId;
          readonly input: { readonly name?: string };
        },
      ) => {
        if (command === mocks.createUploadUrl) {
          const attachmentId = `pending-${target.environmentId}-${target.input.name}`;
          return {
            _tag: "Success",
            value: {
              attachmentId,
              relativeUrl: `/api/attachments/upload/${attachmentId}`,
              expiresAt: 1,
            },
          };
        }
        return { _tag: "Success", value: undefined };
      },
    );
    vi.stubGlobal("XMLHttpRequest", TestXmlHttpRequest);
  });

  afterEach(() => {
    for (const imageId of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
      releaseAttachmentUpload(imageId);
    }
    vi.unstubAllGlobals();
  });

  it("uploads images immediately and sends attachment references", async () => {
    const image = makeImage("image-1");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();

    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe(
      "https://environment.test/api/attachments/upload/pending-environment-1-image-1.png",
    );
    request.progress(1, 3);
    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "uploading", progress: 1 / 3 });

    const settled = awaitAttachmentUploads([image.id]);
    request.complete();
    await settled;

    expect(getUploadedAttachments({ environmentId: firstEnvironment, images: [image] })).toEqual([
      {
        type: "image",
        id: "pending-environment-1-image-1.png",
        name: "image-1.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
    ]);

    releaseDraftAttachments([image]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: "pending-environment-1-image-1.png" },
      },
      expect.anything(),
    );
  });

  it("retries rejected uploads", async () => {
    const image = makeImage("image-retry");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();

    let settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete(500);
    await settled;
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "failed",
      reason: "Upload rejected (500)",
    });

    retryAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();
    settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[1]!.complete();
    await settled;

    expect(readAttachmentUpload(image.id)).toMatchObject({ status: "ready" });
  });

  it("releases an upload URL that resolves after its image was removed", async () => {
    const image = makeImage("image-cancelled");
    const minted = {
      _tag: "Success" as const,
      value: {
        attachmentId: "pending-environment-1-image-cancelled.png",
        relativeUrl: "/api/attachments/upload/cancelled",
        expiresAt: 1,
      },
    };
    let resolveMint: (result: typeof minted) => void = () => {};
    const pendingMint = new Promise<typeof minted>((resolve) => {
      resolveMint = resolve;
    });
    let resolveDelete: () => void = () => {};
    const deleted = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    mocks.runAtomCommand.mockImplementation((_registry: unknown, command: unknown) => {
      if (command === mocks.createUploadUrl) {
        return pendingMint;
      }
      resolveDelete();
      return Promise.resolve({ _tag: "Success", value: undefined });
    });

    startAttachmentUpload({ environmentId: firstEnvironment, image });
    releaseAttachmentUpload(image.id);
    resolveMint(minted);
    await deleted;

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(image.id)).toBeUndefined();
    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      {
        environmentId: firstEnvironment,
        input: { attachmentId: minted.value.attachmentId },
      },
      expect.anything(),
    );
  });

  it("restores the previous environment after a replacement upload fails", async () => {
    const image = makeImage("image-move");
    startAttachmentUpload({ environmentId: firstEnvironment, image });
    await Promise.resolve();
    let settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[0]!.complete();
    await settled;

    startAttachmentUpload({ environmentId: secondEnvironment, image });
    await Promise.resolve();
    settled = awaitAttachmentUploads([image.id]);
    TestXmlHttpRequest.requests[1]!.complete(500);
    await settled;

    startAttachmentUpload({ environmentId: firstEnvironment, image });
    expect(readAttachmentUpload(image.id)).toMatchObject({
      status: "ready",
      environmentId: firstEnvironment,
      attachmentId: "pending-environment-1-image-move.png",
    });
  });

  it("does not let stalled uploads block another environment", async () => {
    const images = ["image-a", "image-b", "image-c", "image-d"].map(makeImage);
    for (const image of images) {
      startAttachmentUpload({ environmentId: firstEnvironment, image });
    }
    const otherEnvironmentImage = makeImage("image-other");
    startAttachmentUpload({ environmentId: secondEnvironment, image: otherEnvironmentImage });
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toHaveLength(4);
    const otherRequest = TestXmlHttpRequest.requests.find((request) =>
      request.url?.includes("environment-2"),
    );
    expect(otherRequest).toBeDefined();

    for (const request of TestXmlHttpRequest.requests) {
      request.complete();
    }
    await Promise.all([
      ...images.slice(0, 3).map((image) => awaitAttachmentUploads([image.id])),
      awaitAttachmentUploads([otherEnvironmentImage.id]),
    ]);
    await Promise.resolve();
    TestXmlHttpRequest.requests[4]!.complete();
    await awaitAttachmentUploads([images[3]!.id]);
  });

  it("uploads generic files as file attachments and keeps the pasted-text source", async () => {
    const file = makeFile("notes", { source: { _tag: "pasted-text" } });
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await Promise.resolve();

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.createUploadUrl,
      {
        environmentId: firstEnvironment,
        input: { type: "file", name: "notes.pdf", mimeType: "application/pdf", sizeBytes: 4 },
      },
      expect.anything(),
    );
    const request = TestXmlHttpRequest.requests[0]!;
    expect(request.headers.get("Content-Type")).toBe("application/pdf");
    const settled = awaitAttachmentUploads([file.id]);
    request.complete();
    await settled;

    expect(getUploadedAttachments({ environmentId: firstEnvironment, images: [file] })).toEqual([
      {
        type: "file",
        id: "pending-environment-1-notes.pdf",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
        source: { _tag: "pasted-text" },
      },
    ]);
  });

  it("verifies a persisted draft upload instead of uploading the bytes again", async () => {
    mocks.verifyPersistedAttachmentUpload.mockResolvedValue({ status: "verified" });
    const file = makeFile("hydrated", {
      file: null,
      uploadedAttachmentId: "pending-persisted",
      uploadEnvironmentId: firstEnvironment,
    });
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await awaitAttachmentUploads([file.id]);

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(file.id)).toEqual({
      status: "ready",
      environmentId: firstEnvironment,
      attachmentId: "pending-persisted",
    });
  });

  it("asks for the file again when a persisted upload expired and no bytes remain", async () => {
    mocks.verifyPersistedAttachmentUpload.mockResolvedValue({ status: "missing" });
    const file = makeFile("expired", {
      file: null,
      uploadedAttachmentId: "pending-expired",
      uploadEnvironmentId: firstEnvironment,
    });
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await awaitAttachmentUploads([file.id]);

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(file.id)).toMatchObject({
      status: "failed",
      reason: "Upload expired. Attach the file again.",
    });
    // The failed state must not claim the persisted id; retry and release
    // only delete ids the queue minted itself.
    expect(readAttachmentUpload(file.id)).not.toHaveProperty("attachmentId");
  });

  it("deletes a persisted draft upload when the draft file is discarded", () => {
    const file = makeFile("discarded", {
      file: null,
      uploadedAttachmentId: "pending-discarded",
      uploadEnvironmentId: secondEnvironment,
    });
    releaseDraftAttachment(file);

    expect(mocks.runAtomCommand).toHaveBeenCalledWith(
      expect.anything(),
      mocks.removeUpload,
      { environmentId: secondEnvironment, input: { attachmentId: "pending-discarded" } },
      expect.anything(),
    );
  });

  it("does not upload over a connection without the operate scope", async () => {
    mocks.readEnvironmentScope.mockReturnValue(false);
    const file = makeFile("read-only");
    startAttachmentUpload({ environmentId: firstEnvironment, image: file });
    await Promise.resolve();

    expect(TestXmlHttpRequest.requests).toEqual([]);
    expect(readAttachmentUpload(file.id)).toBeUndefined();
  });
});
